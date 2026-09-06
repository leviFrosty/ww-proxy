import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAnnouncementRequest } from './route'
import { MAX_IMAGE_BYTES, MAX_JSON_BYTES } from './schema'
import { createHash } from 'node:crypto'

class MemoryBucket {
  values = new Map<
    string,
    { body: Uint8Array; etag: string; httpMetadata?: R2HTTPMetadata }
  >()
  get = vi.fn(async (key: string) => this.object(key))
  head = vi.fn(async (key: string) => this.object(key))
  put = vi.fn(
    async (key: string, body: string | Uint8Array, options?: R2PutOptions) => {
      const previous = this.values.get(key)
      const condition = options?.onlyIf as R2Conditional | undefined
      if (condition?.etagMatches && previous?.etag !== condition.etagMatches)
        return null
      if (condition?.etagDoesNotMatch === '*' && previous) return null
      const bytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : body
      this.values.set(key, {
        body: bytes,
        etag: createHash('md5').update(bytes).digest('hex'),
        httpMetadata: options?.httpMetadata as R2HTTPMetadata,
      })
      return this.object(key)
    },
  )
  object(key: string) {
    const value = this.values.get(key)
    if (!value) return null
    return {
      key,
      etag: value.etag,
      httpEtag: `"${value.etag}"`,
      size: value.body.length,
      httpMetadata: value.httpMetadata,
      body: new Blob([value.body]).stream(),
      json: async () => JSON.parse(new TextDecoder().decode(value.body)),
    }
  }
}
class MemoryCache {
  values = new Map<string, Response>()
  match = vi.fn(async (request: Request) =>
    this.values.get(request.url)?.clone(),
  )
  put = vi.fn(async (request: Request, response: Response) => {
    this.values.set(request.url, response.clone())
  })
  delete = vi.fn(async (request: Request) => this.values.delete(request.url))
}
const originalDraft = () => ({
  schemaVersion: 1,
  announcement: {
    id: 'welcome',
    dismissible: true,
    signature: false,
    locales: {
      'en-us': {
        bannerText: 'News',
        title: 'Hello',
        markdown: 'Hello **everyone**. [Read more](https://example.com)',
      },
    },
  },
})
let bucket: MemoryBucket
let cache: MemoryCache
const call = (
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  handleAnnouncementRequest(
    new Request(`https://example.com${path}`, {
      method,
      headers: { Authorization: 'Bearer test-secret', ...headers },
      ...(body === undefined
        ? {}
        : {
            body:
              typeof body === 'string' || body instanceof Uint8Array
                ? body
                : JSON.stringify(body),
          }),
    }),
    {
      bucket: bucket as unknown as R2Bucket,
      cache: cache as unknown as Cache,
      adminToken: 'test-secret',
    },
  )
const status = async () =>
  (await call('/admin/announcements/status')).json() as Promise<{
    current: unknown
    currentEtag: string
    draftEtag: string | null
  }>
const save = async (draft = originalDraft()) =>
  call('/admin/announcements/draft', 'PUT', draft, { 'If-None-Match': '*' })
beforeEach(() => {
  bucket = new MemoryBucket()
  cache = new MemoryCache()
})

describe('announcement management', () => {
  it('fails closed before reading storage for missing/wrong auth', async () => {
    for (const Authorization of [
      '',
      'Bearer wrong',
      'test-secret',
      'Basic test-secret',
    ]) {
      const response = await call(
        '/admin/announcements/status',
        'GET',
        undefined,
        { Authorization },
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    expect(bucket.get).not.toHaveBeenCalled()
  })
  it('conditionally saves drafts and never exposes them through public object paths', async () => {
    expect(
      (await call('/admin/announcements/draft', 'PUT', originalDraft())).status,
    ).toBe(428)
    const saved = await save()
    expect(saved.status).toBe(200)
    expect((await save()).status).toBe(412)
    expect(
      (
        await call('/admin/announcements/draft', 'PUT', originalDraft(), {
          'If-Match': '"stale"',
        })
      ).status,
    ).toBe(412)
    expect(
      (
        await call('/admin/announcements/draft', 'PUT', originalDraft(), {
          'If-Match': saved.headers.get('ETag')!,
        })
      ).status,
    ).toBe(200)
    expect((await call('/announcements/private/draft.json')).status).toBe(404)
    expect((await call('/announcements/draft.json')).status).toBe(404)
    expect(
      (await call('/announcements/current.json', 'PUT', originalDraft()))
        .status,
    ).toBe(404)
  })
  it('publishes the saved snapshot with a server revision and strips private provenance', async () => {
    const draft = {
      ...originalDraft(),
      translationSourceHash: 'a'.repeat(64),
      translationStatus: { 'en-us': 'reviewed' },
    }
    const saved = await save(draft)
    const state = await status()
    const response = await call(
      '/admin/announcements/publish',
      'POST',
      { draftEtag: saved.headers.get('ETag') },
      { 'If-Match': state.currentEtag },
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as any
    expect(result.current.announcement.revision).toMatch(/^[a-f0-9-]{36}$/)
    expect(result.current.translationStatus).toBeUndefined()
    expect(result.current.announcement.id).toBe('welcome')
    const publicResponse = await call('/announcements/current.json')
    expect(await publicResponse.json()).toEqual(result.current)
    const history = (await (
      await call('/admin/announcements/history')
    ).json()) as any
    expect(history.items).toHaveLength(1)
    const release = await call(history.items[0].url)
    expect(release.headers.get('Cache-Control')).toContain(
      '31536000, immutable',
    )
    expect(await release.json()).toEqual(result.current)
  })
  it('rejects publishing a draft that changed after review', async () => {
    const first = await save()
    const state = await status()
    const changed = originalDraft()
    changed.announcement.locales['en-us'].title = 'Changed'
    await call('/admin/announcements/draft', 'PUT', changed, {
      'If-Match': first.headers.get('ETag')!,
    })
    expect(
      (
        await call(
          '/admin/announcements/publish',
          'POST',
          { draftEtag: first.headers.get('ETag') },
          { 'If-Match': state.currentEtag },
        )
      ).status,
    ).toBe(412)
    expect((await status()).current).toEqual({
      schemaVersion: 1,
      announcement: null,
    })
  })
  it('rejects missing or stale translation provenance without changing publication history', async () => {
    const draft: any = originalDraft()
    draft.announcement.locales['de-de'] = {
      ...draft.announcement.locales['en-us'],
      title: 'Hallo',
    }
    let saved = await save(draft)
    const state = await status()
    const publish = () =>
      call(
        '/admin/announcements/publish',
        'POST',
        { draftEtag: saved.headers.get('ETag') },
        { 'If-Match': state.currentEtag },
      )
    expect((await publish()).status).toBe(400)
    draft.translationSourceHash = 'a'.repeat(64)
    saved = await call('/admin/announcements/draft', 'PUT', draft, {
      'If-Match': saved.headers.get('ETag')!,
    })
    expect((await publish()).status).toBe(400)
    expect(
      ((await (await call('/admin/announcements/history')).json()) as any)
        .items,
    ).toHaveLength(0)
    expect((await status()).currentEtag).toBe(state.currentEtag)
    const english = draft.announcement.locales['en-us']
    draft.translationSourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          bannerText: english.bannerText,
          title: english.title,
          markdown: english.markdown,
        }),
      )
      .digest('hex')
    saved = await call('/admin/announcements/draft', 'PUT', draft, {
      'If-Match': saved.headers.get('ETag')!,
    })
    expect((await publish()).status).toBe(200)
  })
  it('preserves copy whitespace and Markdown indentation through saving and publishing', async () => {
    const draft: any = originalDraft()
    draft.announcement.locales['en-us'].markdown =
      '    A code block\n\nA paragraph.\n'
    draft.announcement.locales['en-us'].title = ' Title '
    draft.announcement.locales['de-de'] = {
      ...draft.announcement.locales['en-us'],
    }
    const english = draft.announcement.locales['en-us']
    draft.translationSourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          bannerText: english.bannerText,
          title: english.title,
          markdown: english.markdown,
        }),
      )
      .digest('hex')
    const saved = await save(draft)
    const state = await status()
    expect(await saved.clone().json()).toEqual(draft)
    const published = await call(
      '/admin/announcements/publish',
      'POST',
      { draftEtag: saved.headers.get('ETag') },
      { 'If-Match': state.currentEtag },
    )
    expect(published.status).toBe(200)
    expect(
      ((await published.json()) as any).current.announcement.locales['en-us'],
    ).toEqual(english)
  })
  it('only lets one simultaneous publication win the R2 conditional swap', async () => {
    const saved = await save()
    const state = await status()
    const publish = () =>
      call(
        '/admin/announcements/publish',
        'POST',
        { draftEtag: saved.headers.get('ETag') },
        { 'If-Match': state.currentEtag },
      )
    const results = await Promise.all([publish(), publish()])
    expect(results.map((result) => result.status).sort()).toEqual([200, 412])
    expect(
      ((await (await call('/admin/announcements/history')).json()) as any)
        .items,
    ).toHaveLength(1)
  })
  it('keeps a unique unpublished tombstone so old ETags cannot regain validity', async () => {
    const first = await status()
    const response = await call(
      '/admin/announcements/unpublish',
      'POST',
      undefined,
      { 'If-Match': first.currentEtag },
    )
    expect(response.status).toBe(200)
    const second = await status()
    expect(second.currentEtag).not.toBe(first.currentEtag)
    expect(
      (
        await call('/admin/announcements/unpublish', 'POST', undefined, {
          'If-Match': first.currentEtag,
        })
      ).status,
    ).toBe(412)
  })
})

describe('public cache behavior', () => {
  it('caches full feeds by path for one hour and honors weak/list conditional GETs without R2 reads', async () => {
    const response = await call('/announcements/current.json?cachebust=1')
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=3600, s-maxage=3600',
    )
    const reads = bucket.get.mock.calls.length
    const conditional = await call(
      '/announcements/current.json?cachebust=2',
      'GET',
      undefined,
      { 'If-None-Match': `"other", W/${response.headers.get('ETag')}` },
    )
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe('')
    expect(bucket.get.mock.calls.length).toBe(reads)
    expect(cache.values.size).toBe(1)
  })
  it('evicts the local feed cache on publication change', async () => {
    await call('/announcements/current.json')
    const state = await status()
    await call('/admin/announcements/unpublish', 'POST', undefined, {
      'If-Match': state.currentEtag,
    })
    expect(cache.delete).toHaveBeenCalled()
    expect(cache.values.size).toBe(0)
  })
  it('returns 503 no-store on R2 failures and never caches failures', async () => {
    bucket.get.mockRejectedValue(new Error('offline'))
    const response = await call('/announcements/current.json')
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(cache.put).not.toHaveBeenCalled()
  })
  it('serves HEAD without a body and keeps admin state uncached', async () => {
    const response = await call('/announcements/current.json', 'HEAD')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(
      (await call('/admin/announcements/status')).headers.get('Cache-Control'),
    ).toBe('no-store')
  })
})

describe('content safety', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src="https://bad.test/x">',
    '[go](javascript:alert%281%29)',
    '[go](data:text/html,test)',
    '[go][x]\n\n[x]: javascript:alert%281%29',
    '![x](https://tracker.test/x.png)',
    '![x](/announcements/images/evil.svg)',
    '[x](https://username:password@example.com)',
  ])('rejects unsafe Markdown: %s', async (markdown) => {
    const draft = originalDraft()
    draft.announcement.locales['en-us'].markdown = markdown
    expect((await save(draft)).status).toBe(400)
  })
  it('accepts safe reference links and uploaded image paths', async () => {
    const draft = originalDraft()
    draft.announcement.locales['en-us'].markdown =
      `[go][x]\n\n[x]: https://example.com\n\n![Photo](/announcements/images/${'a'.repeat(64)}.png)\n\n[Email](mailto:help@example.com)`
    expect((await save(draft)).status).toBe(200)
  })
  it('requires English and canonical locales with bounded strings and dates', async () => {
    for (const change of [
      (d: any) =>
        (d.announcement.locales = { 'en-US': d.announcement.locales['en-us'] }),
      (d: any) =>
        (d.announcement.locales['en-us'].markdown = 'a'.repeat(12_001)),
      (d: any) => {
        d.announcement.startsAt = '2026-09-05T00:00:00Z'
        d.announcement.expiresAt = '2026-09-04T00:00:00Z'
      },
      (d: any) => (d.extra = true),
    ]) {
      const draft = originalDraft()
      change(draft)
      expect((await save(draft)).status).toBe(400)
    }
  })
  it.each([
    ['2026-09-05T00:00:00Z', '2026-09-05T00:00:00.100Z', 200],
    ['2026-09-05T00:00:00.100Z', '2026-09-05T00:00:00Z', 400],
    ['2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00Z', 400],
  ])(
    'compares schedule instants with mixed precision: %s to %s',
    async (startsAt, expiresAt, expected) => {
      const draft = originalDraft()
      Object.assign(draft.announcement, { startsAt, expiresAt })
      expect((await save(draft)).status).toBe(expected)
    },
  )
  it('bounds streamed JSON even without Content-Length', async () => {
    expect(
      (
        await call(
          '/admin/announcements/draft',
          'PUT',
          ' '.repeat(MAX_JSON_BYTES + 1),
          { 'If-None-Match': '*' },
        )
      ).status,
    ).toBe(413)
  })
  it('validates image bytes, MIME and size before immutable content-addressed storage', async () => {
    const png = new Uint8Array(24)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    png.set([73, 72, 68, 82], 12)
    expect(
      (
        await call('/admin/announcements/images', 'POST', '<svg/>', {
          'Content-Type': 'image/png',
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await call('/admin/announcements/images', 'POST', png, {
          'Content-Type': 'image/jpeg',
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await call(
          '/admin/announcements/images',
          'POST',
          new Uint8Array(MAX_IMAGE_BYTES + 1),
          { 'Content-Type': 'image/png' },
        )
      ).status,
    ).toBe(413)
    const response = await call('/admin/announcements/images', 'POST', png, {
      'Content-Type': 'image/png',
    })
    expect(response.status).toBe(201)
    const { url } = (await response.json()) as any
    const image = await call(url)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(image.headers.get('Cache-Control')).toContain('immutable')
    expect(await image.arrayBuffer()).toEqual(png.buffer)
  })
})
