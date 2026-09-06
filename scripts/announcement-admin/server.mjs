import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  LOCALES,
  translateDraft,
  translationNeeded,
  validateDraft,
} from './translation.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const MAX_JSON = 256 * 1024
const MAX_IMAGE = 5 * 1024 * 1024
const imagePath = /^\/announcements\/images\/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$/
const releasePath = /^\/announcements\/releases\/[a-f0-9-]{36}\.json$/

export function resolveConfig(args, env) {
  if (args.some((arg) => arg !== '--dev'))
    throw new Error('Usage: pnpm admin:announcements [--dev]')
  const development = args.includes('--dev')
  const token = development ? env.ADMIN_API_TOKEN_DEV : env.ADMIN_API_TOKEN
  if (!token)
    throw new Error(
      `Set ${development ? 'ADMIN_API_TOKEN_DEV' : 'ADMIN_API_TOKEN'} in the gitignored .env file.`,
    )
  const raw = development
    ? env.WW_API_DEV_URL
    : env.WW_API_PROD_URL || 'https://ww-proxy.leviwilkerson.com'
  if (!raw) throw new Error('Set WW_API_DEV_URL in .env.')
  const url = new URL(raw)
  const local =
    development &&
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname)
  if (
    (!local && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Worker URL must be an HTTPS origin (local HTTP is allowed only with --dev).',
    )
  const port = Number(env.ANNOUNCEMENT_ADMIN_PORT || 4317)
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('ANNOUNCEMENT_ADMIN_PORT must be between 1024 and 65535.')
  return {
    token,
    baseUrl: url.origin,
    environment: development ? 'development' : 'production',
    port,
  }
}

function equalSecret(left, right) {
  if (typeof left !== 'string') return false
  const actual = Buffer.from(left),
    expected = Buffer.from(right)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBounded(stream, max) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > max)
      throw Object.assign(new Error('Request exceeds the size limit.'), {
        status: 413,
      })
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function createAdminServer(
  config,
  { fetchImpl = fetch, translator = translateDraft, assets } = {},
) {
  if (!assets) {
    const bundle = await build({
      entryPoints: [join(directory, 'client.js')],
      bundle: true,
      write: false,
      outfile: 'client.js',
      format: 'esm',
      target: 'es2022',
      minify: true,
      legalComments: 'inline',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    })
    assets = Object.fromEntries(
      bundle.outputFiles.map((file) => [
        `/${file.path.split('/').pop()}`,
        file.contents,
      ]),
    )
  }
  const html = await readFile(join(directory, 'index.html'), 'utf8')
  const cookie = randomBytes(32).toString('hex')
  const csrf = randomBytes(32).toString('hex')
  let working = false
  const worker = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    })
    const bytes = await readBounded(
      response.body,
      imagePath.test(path) ? MAX_IMAGE : MAX_JSON + 64 * 1024,
    )
    if (!response.ok) {
      let reason = ''
      try {
        reason = JSON.parse(bytes.toString()).error || ''
      } catch {}
      // Only pass short validation messages; never reflect credential-bearing URLs/headers.
      const safeReason =
        typeof reason === 'string'
          ? reason.replaceAll(config.token, '[redacted]').slice(0, 300)
          : ''
      throw Object.assign(
        new Error(
          `Worker returned ${response.status}${safeReason ? `: ${safeReason}` : ''}`,
        ),
        { status: response.status },
      )
    }
    return {
      body: bytes,
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
    }
  }
  const workerJson = async (path, options) => {
    const result = await worker(path, options)
    return { data: JSON.parse(result.body.toString()), etag: result.etag }
  }
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`
    const send = (status, value, headers = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        ...headers,
      })
      res.end(
        typeof value === 'string' ||
          Buffer.isBuffer(value) ||
          value instanceof Uint8Array
          ? value
          : JSON.stringify(value),
      )
    }
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return send(403, { error: 'Only the local admin origin is allowed.' })
      if (
        !req.url ||
        req.url.includes('?') ||
        req.url.includes('#') ||
        req.url.includes('%') ||
        req.url.includes('..')
      )
        return send(400, { error: 'Invalid path.' })
      if (
        req.headers['sec-fetch-site'] &&
        !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])
      )
        return send(403, { error: 'Cross-site requests are not allowed.' })
      const path = req.url
      if (req.method === 'GET' && path === '/')
        return send(200, html, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `ww_admin=${cookie}; Path=/; HttpOnly; SameSite=Strict`,
          'content-security-policy':
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
      const sessionCookie = req.headers.cookie
        ?.split('; ')
        .find((part) => part.startsWith('ww_admin='))
        ?.slice(9)
      if (!equalSecret(sessionCookie, cookie))
        return send(403, {
          error: 'Open the local admin page to start a session.',
        })
      if (req.method === 'GET' && assets[path])
        return send(200, assets[path], {
          'content-type': path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript',
        })
      if (req.method === 'GET' && path === '/api/session')
        return send(200, {
          csrf,
          environment: config.environment,
          baseUrl: config.baseUrl,
          locales: LOCALES,
        })
      if (req.method === 'GET' && imagePath.test(path)) {
        const result = await worker(path)
        return send(200, result.body, { 'content-type': result.contentType })
      }
      if (!equalSecret(req.headers['x-ww-csrf'], csrf))
        return send(403, { error: 'Invalid session. Reload the admin page.' })
      if (req.method !== 'GET' && req.headers.origin !== origin)
        return send(403, { error: 'An exact local Origin is required.' })
      if (req.method === 'GET') {
        const routes = {
          '/api/status': '/admin/announcements/status',
          '/api/draft': '/admin/announcements/draft',
          '/api/history': '/admin/announcements/history',
        }
        const target = routes[path] || (releasePath.test(path) ? path : null)
        if (!target) return send(404, { error: 'Unknown endpoint.' })
        const result = await workerJson(target)
        return send(200, result)
      }
      if (
        !['POST', 'PUT'].includes(req.method) ||
        ![
          '/api/draft',
          '/api/translate',
          '/api/publish',
          '/api/unpublish',
          '/api/images',
        ].includes(path)
      )
        return send(404, { error: 'Unknown endpoint.' })
      if (working)
        return send(409, { error: 'Another admin operation is still running.' })
      working = true
      try {
        if (path === '/api/images') {
          if (
            !['image/png', 'image/jpeg', 'image/webp'].includes(
              req.headers['content-type'],
            )
          )
            return send(415, { error: 'Choose a PNG, JPEG, or WebP image.' })
          const result = await workerJson('/admin/announcements/images', {
            method: 'POST',
            body: await readBounded(req, MAX_IMAGE),
            headers: { 'content-type': req.headers['content-type'] },
          })
          return send(200, result.data)
        }
        if (req.headers['content-type'] !== 'application/json')
          return send(415, { error: 'JSON is required.' })
        const body = JSON.parse((await readBounded(req, MAX_JSON)).toString())
        if (path === '/api/unpublish') {
          if (typeof body.currentEtag !== 'string')
            throw new Error('Reload current publication status first.')
          return send(
            200,
            (
              await workerJson('/admin/announcements/unpublish', {
                method: 'POST',
                headers: { 'if-match': body.currentEtag },
              })
            ).data,
          )
        }
        validateDraft(body.draft)
        if (path === '/api/translate')
          return send(200, { draft: await translator(body.draft, body.agent) })
        if (body.draftEtag !== null && typeof body.draftEtag !== 'string')
          throw new Error('Reload the saved draft first.')
        if (path === '/api/publish' && typeof body.currentEtag !== 'string')
          throw new Error('Reload current publication status first.')
        const draft = body.draft
        if (path === '/api/publish' && translationNeeded(draft).length)
          throw new Error(
            'Translate missing or stale languages, then review them before publishing.',
          )
        const saved = await workerJson('/admin/announcements/draft', {
          method: 'PUT',
          body: JSON.stringify(draft),
          headers: {
            'content-type': 'application/json',
            ...(body.draftEtag
              ? { 'if-match': body.draftEtag }
              : { 'if-none-match': '*' }),
          },
        })
        if (path === '/api/draft')
          return send(200, { draft: saved.data, draftEtag: saved.etag })
        const published = await workerJson('/admin/announcements/publish', {
          method: 'POST',
          body: JSON.stringify({ draftEtag: saved.etag }),
          headers: {
            'content-type': 'application/json',
            'if-match': body.currentEtag,
          },
        })
        return send(200, {
          ...published.data,
          draft: saved.data,
          draftEtag: saved.etag,
        })
      } finally {
        working = false
      }
    } catch (error) {
      const status =
        error.status >= 400 && error.status < 600 ? error.status : 400
      send(status, {
        error:
          error instanceof SyntaxError
            ? 'Invalid JSON.'
            : error.message || 'Admin operation failed.',
      })
    }
  })
  return server
}

async function main() {
  const config = resolveConfig(process.argv.slice(2), process.env)
  const server = await createAdminServer(config)
  server.listen(config.port, '127.0.0.1', () =>
    process.stdout.write(
      `Announcement admin (${config.environment}): http://127.0.0.1:${config.port}\nWorker: ${config.baseUrl}\nPress Ctrl+C to stop.\n`,
    ),
  )
  server.on('error', (error) => {
    process.stderr.write(`Cannot start admin: ${error.message}\n`)
    process.exitCode = 1
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
