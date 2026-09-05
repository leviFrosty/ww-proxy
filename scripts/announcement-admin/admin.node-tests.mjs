import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { createAdminServer, resolveConfig } from './server.mjs'
import { draftFromFeed } from './draft.mjs'
import {
  acceptTranslations,
  LOCALES,
  runBounded,
  sourceHash,
  translateDraft,
  translationNeeded,
} from './translation.mjs'

const english = {
  bannerText: 'News from WitnessWork',
  title: 'A new chapter',
  markdown:
    '**Thank you.** Read [more](https://example.com/help).\n\n![An image](/announcements/images/' +
    'a'.repeat(64) +
    '.png)',
}
const draft = () => ({
  schemaVersion: 1,
  announcement: {
    id: 'news-1',
    dismissible: true,
    signature: true,
    locales: { 'en-us': structuredClone(english) },
  },
})
const translated = (original) =>
  acceptTranslations(
    original,
    {
      locales: Object.fromEntries(
        LOCALES.slice(1).map((locale) => [locale, structuredClone(english)]),
      ),
    },
    LOCALES.slice(1),
  )

test('environment separation and URL boundaries', () => {
  const env = {
    ADMIN_API_TOKEN: 'prod-secret',
    ADMIN_API_TOKEN_DEV: 'dev-secret',
    WW_API_DEV_URL: 'http://127.0.0.1:8787',
  }
  assert.equal(resolveConfig([], env).token, 'prod-secret')
  assert.equal(resolveConfig(['--dev'], env).token, 'dev-secret')
  assert.throws(() => resolveConfig(['--dev'], { ADMIN_API_TOKEN: 'prod' }))
  for (const bad of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/admin',
    'https://example.com/?token=abc',
  ])
    assert.throws(() => resolveConfig([], { ...env, WW_API_PROD_URL: bad }))
  assert.throws(() => resolveConfig(['--url=https://evil.example'], env))
})

test('translation only merges validated localized copy and preserves draft identity', () => {
  const input = draft()
  const result = translated(input)
  assert.equal(Object.keys(input.announcement.locales).length, 1)
  assert.equal(result.announcement.id, input.announcement.id)
  assert.equal(result.translationSourceHash, sourceHash(english))
  assert.equal(translationNeeded(result).length, 0)
  result.announcement.locales['en-us'].title = 'Changed'
  assert.equal(translationNeeded(result).length, 17)
})

test('partial, URL-changing, product-renaming and injected translations preserve existing copies', () => {
  const input = translated(draft())
  const original = structuredClone(input)
  for (const value of [
    { locales: {} },
    {
      locales: {
        'de-de': { ...english, markdown: '[link](https://evil.example)' },
      },
    },
    { locales: { 'de-de': { ...english, bannerText: 'News from OtherApp' } } },
    {
      locales: {
        'de-de': { ...english, markdown: '<script>alert(1)</script>' },
      },
    },
    { locales: { 'de-de': english }, id: 'changed' },
  ])
    assert.throws(() => acceptTranslations(input, value, ['de-de']))
  assert.deepEqual(input, original)
})

test('translation child failures never alter the original draft', async () => {
  const input = draft(),
    before = structuredClone(input)
  await assert.rejects(
    translateDraft(input, 'claude', async (_command, args, options) => {
      assert.ok(args.includes('--safe-mode'))
      assert.equal(args[args.indexOf('--tools') + 1], '')
      assert.equal(options.env.ADMIN_API_TOKEN, undefined)
      throw new Error('fixture failure')
    }),
    /fixture failure/,
  )
  assert.deepEqual(input, before)
  await assert.rejects(
    translateDraft(input, 'arbitrary-program'),
    /Choose Codex or Claude/,
  )
})

test('translator output preserves UTF-8 characters split across chunks', async () => {
  const result = await runBounded(process.execPath, [
    '-e',
    `
    const bytes = Buffer.from('日本語')
    process.stdout.write(bytes.subarray(0, 1))
    setTimeout(() => process.stdout.write(bytes.subarray(1)), 50)
    `,
  ], { input: '' })
  assert.equal(result, '日本語')
})

test('subprocess timeout and output bounds terminate a child', async () => {
  await assert.rejects(
    runBounded(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      input: '',
      timeoutMs: 30,
    }),
    /timed out/,
  )
  await assert.rejects(
    runBounded(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(10000))'],
      { input: '', maxBytes: 100 },
    ),
    /output limit/,
  )
})

async function withServer(t, overrides = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options })
    return new Response(
      JSON.stringify(
        url.endsWith('/draft')
          ? JSON.parse(options.body)
          : {
              current: { schemaVersion: 1, announcement: null },
              currentEtag: 'next-current',
            },
      ),
      { headers: { etag: 'saved-draft', 'content-type': 'application/json' } },
    )
  }
  const server = await createAdminServer(
    {
      token: 'worker-secret',
      baseUrl: 'https://worker.example',
      environment: 'development',
    },
    { assets: {}, fetchImpl, ...overrides },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const home = await fetch(origin)
  const cookie = home.headers.get('set-cookie').split(';')[0]
  const session = await (
    await fetch(`${origin}/api/session`, { headers: { cookie } })
  ).json()
  const headers = {
    origin,
    cookie,
    'x-ww-csrf': session.csrf,
    'content-type': 'application/json',
  }
  return { calls, origin, cookie, headers }
}

test('loopback server rejects DNS rebinding, cross-origin, absent session and CSRF, and arbitrary proxy paths', async (t) => {
  const { calls, origin, headers } = await withServer(t)
  const post = (path, options = {}) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers,
      body: '{}',
      ...options,
    })
  const reboundStatus = await new Promise((resolve) =>
    request(origin, { headers: { host: 'evil.example' } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    }).end(),
  )
  assert.equal(reboundStatus, 403)
  assert.equal(
    (
      await post('/api/publish', {
        headers: { ...headers, origin: 'https://evil.example' },
      })
    ).status,
    403,
  )
  assert.equal(
    (await post('/api/publish', { headers: { ...headers, cookie: '' } }))
      .status,
    403,
  )
  assert.equal(
    (await post('/api/publish', { headers: { ...headers, 'x-ww-csrf': '' } }))
      .status,
    403,
  )
  assert.equal(
    (await post('/api/publish', { headers: { ...headers, origin: '' } }))
      .status,
    403,
  )
  assert.equal((await post('/api/admin/notes-import/reset')).status, 404)
  assert.equal(
    (await fetch(`${origin}/api/status?url=https://evil.example`, { headers }))
      .status,
    400,
  )
  assert.equal(calls.length, 0)
})

test('publication preserves reviewed copy without invoking a translator', async (t) => {
  const { calls, origin, headers } = await withServer(t, {
    translator: async () => {
      throw new Error('Publish must not translate')
    },
  })
  const reviewed = translated(draft())
  reviewed.announcement.locales['de-de'].title = 'Reviewed title'
  const response = await fetch(`${origin}/api/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      draft: reviewed,
      draftEtag: null,
      currentEtag: 'old-current',
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://worker.example/admin/announcements/draft')
  assert.equal(calls[0].headers.authorization, 'Bearer worker-secret')
  assert.equal(calls[0].headers['if-none-match'], '*')
  assert.equal(calls[1].headers['if-match'], 'old-current')
  assert.deepEqual(JSON.parse(calls[1].body), { draftEtag: 'saved-draft' })
  assert.equal(
    Object.keys(JSON.parse(calls[0].body).announcement.locales).length,
    18,
  )
  assert.deepEqual(JSON.parse(calls[0].body), reviewed)
  assert.ok(!(await response.text()).includes('worker-secret'))
})

test('missing or stale translations cannot save or publish', async (t) => {
  const stale = translated(draft())
  stale.announcement.locales['en-us'].title = 'Changed source'
  for (const input of [draft(), stale]) {
    const { calls, origin, headers } = await withServer(t, {
      translator: async () => {
        throw new Error('Publish must not translate')
      },
    })
    const response = await fetch(`${origin}/api/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        draft: input,
        draftEtag: null,
        currentEtag: 'old-current',
      }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Translate missing or stale/)
    assert.equal(calls.length, 0)
  }
})

test('stale conditional draft write cannot publish and redirects never receive credentials', async (t) => {
  const { origin, headers } = await withServer(t, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error')
      assert.equal(options.method, 'PUT')
      return new Response('{"error":"Changed elsewhere"}', { status: 412 })
    },
  })
  const response = await fetch(`${origin}/api/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      draft: translated(draft()),
      draftEtag: 'old-draft',
      currentEtag: 'old-current',
    }),
  })
  assert.equal(response.status, 412)
})


test('restoring published copy preserves translations until English changes', async () => {
  const published = translated(draft())
  published.announcement.locales['de-de'].title = 'Manually reviewed title'
  const feed = {
    schemaVersion: 1,
    announcement: {
      ...published.announcement,
      revision: 'published-revision',
      publishedAt: '2026-09-05T12:00:00Z',
    },
  }
  const before = structuredClone(feed)
  const restored = await draftFromFeed(feed)
  assert.deepEqual(restored.announcement, published.announcement)
  assert.equal(restored.translationSourceHash, sourceHash(english))
  assert.deepEqual(translationNeeded(restored), [])
  const result = await translateDraft(restored, 'claude', async () => {
    throw new Error('Unchanged published copy must not be translated again')
  })
  assert.deepEqual(result.announcement.locales, published.announcement.locales)
  restored.announcement.locales['en-us'].title = 'Changed English'
  assert.equal(translationNeeded(restored).length, 17)
  assert.deepEqual(feed, before)
})
