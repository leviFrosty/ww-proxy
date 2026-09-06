import type { AppContext } from '../types'
import { sha256Bytes, sha256Hex, timingSafeEqual } from '../crypto'
import {
  DraftSchema,
  FeedSchema,
  IMAGE_PATH,
  MAX_IMAGE_BYTES,
  MAX_JSON_BYTES,
  REVISION,
  imageType,
  type Feed,
} from './schema'

const CURRENT = 'private/current.json'
const DRAFT = 'private/draft.json'
const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}
interface HistoryItem {
  revision: string
  id: string
  publishedAt: string
  url: string
}
interface Current {
  generation: string
  feed: Feed
  history: HistoryItem[]
}
interface Dependencies {
  bucket: R2Bucket
  adminToken?: string
  cache?: Cache
  waitUntil?: (promise: Promise<unknown>) => void
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
const etagValue = (value: string) => value.slice(1, -1)
function requiredMatch(request: Request): string {
  const value = request.headers.get('If-Match')
  if (!value)
    throw new HttpError(428, 'Reload status before changing publication')
  if (!/^"[^"\r\n]{1,128}"$/.test(value))
    throw new HttpError(400, 'A single strong ETag is required')
  return value
}
async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  const length = request.headers.get('Content-Length')
  if (length && Number(length) > max)
    throw new HttpError(413, 'Payload too large')
  if (!request.body) throw new HttpError(400, 'Body required')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel()
        throw new HttpError(413, 'Payload too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
async function readJson(request: Request): Promise<unknown> {
  const bytes = await readBytes(request, MAX_JSON_BYTES)
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    )
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}
function encodeFeed(feed: Feed): string {
  const body = JSON.stringify(FeedSchema.parse(feed))
  if (new TextEncoder().encode(body).length > MAX_JSON_BYTES)
    throw new HttpError(413, 'Published feed exceeds 256 KiB')
  return body
}
async function readCurrent(
  bucket: R2Bucket,
): Promise<{ value: Current; etag: string; encodedFeed: string }> {
  let object = await bucket.get(CURRENT)
  if (!object) {
    await bucket.put(
      CURRENT,
      JSON.stringify({
        generation: crypto.randomUUID(),
        feed: { schemaVersion: 1, announcement: null },
        history: [],
      }),
      { onlyIf: { etagDoesNotMatch: '*' } },
    )
    object = await bucket.get(CURRENT)
  }
  if (!object || object.size > MAX_JSON_BYTES + 64 * 1024)
    throw new Error('Invalid announcement state')
  const value = await object.json<Current>()
  const encodedFeed = encodeFeed(value.feed)
  if (typeof value.generation !== 'string' || !Array.isArray(value.history))
    throw new Error('Invalid announcement state')
  return { value, etag: object.httpEtag, encodedFeed }
}
function conditionalResponse(request: Request, response: Response): Response {
  const etag = response.headers.get('ETag')
  const matches = (request.headers.get('If-None-Match') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
  if (etag && (matches.includes(etag) || matches.includes('*')))
    return new Response(null, { status: 304, headers: response.headers })
  return response
}
function defer(deps: Dependencies, promise: Promise<unknown>) {
  // A cache outage must never turn a successful publication into a failed save.
  const safe = promise.catch(() => undefined)
  if (deps.waitUntil) deps.waitUntil(safe)
}
async function publicRead(
  request: Request,
  deps: Dependencies,
): Promise<Response> {
  const url = new URL(request.url)
  const current = url.pathname === '/announcements/current.json'
  const image = IMAGE_PATH.test(url.pathname)
  const release = /^\/announcements\/releases\/([^/]+)\.json$/.exec(
    url.pathname,
  )
  if (!current && !image && !(release && REVISION.test(release[1])))
    return json({ error: 'Not found' }, 404)
  const cacheKey = new Request(`${url.origin}${url.pathname}`)
  let hit: Response | undefined
  try {
    hit = await deps.cache?.match(cacheKey)
  } catch {
    /* R2 remains authoritative. */
  }
  if (hit) return conditionalResponse(request, hit)
  let body: BodyInit
  let etag: string
  let type = 'application/json; charset=utf-8'
  if (current) {
    const state = await readCurrent(deps.bucket)
    body = state.encodedFeed
    etag = state.etag
  } else {
    const key = url.pathname.slice('/announcements/'.length)
    const object = await deps.bucket.get(key)
    if (!object) return json({ error: 'Not found' }, 404)
    if (image) {
      if (
        object.size > MAX_IMAGE_BYTES ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(
          object.httpMetadata?.contentType ?? '',
        )
      )
        throw new Error('Invalid stored image')
      body = object.body
      type = object.httpMetadata!.contentType!
    } else {
      if (object.size > MAX_JSON_BYTES)
        throw new Error('Invalid stored release')
      body = encodeFeed(await object.json<Feed>())
    }
    etag = object.httpEtag
  }
  const response = new Response(body, {
    headers: {
      'Content-Type': type,
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': current
        ? 'public, max-age=3600, s-maxage=3600'
        : 'public, max-age=31536000, immutable',
      ...(image
        ? { 'Content-Security-Policy': "default-src 'none'; sandbox" }
        : {}),
    },
  })
  if (deps.cache) defer(deps, deps.cache.put(cacheKey, response.clone()))
  return conditionalResponse(request, response)
}
async function admin(request: Request, deps: Dependencies): Promise<Response> {
  const supplied =
    request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
  if (
    !deps.adminToken ||
    !timingSafeEqual(supplied, deps.adminToken) ||
    !request.headers.get('Authorization')?.startsWith('Bearer ')
  )
    return json({ error: 'Not found' }, 404)
  const url = new URL(request.url)
  const action = url.pathname.slice('/admin/announcements/'.length)
  if (request.method === 'GET' && action === 'status') {
    const [current, draft] = await Promise.all([
      readCurrent(deps.bucket),
      deps.bucket.head(DRAFT),
    ])
    return json({
      current: current.value.feed,
      currentEtag: current.etag,
      draftEtag: draft?.httpEtag ?? null,
    })
  }
  if (request.method === 'GET' && action === 'draft') {
    const draft = await deps.bucket.get(DRAFT)
    if (!draft) return json({ error: 'No saved draft' }, 404)
    if (draft.size > MAX_JSON_BYTES) throw new Error('Invalid saved draft')
    return json(DraftSchema.parse(await draft.json()), 200, {
      ETag: draft.httpEtag,
    })
  }
  if (request.method === 'PUT' && action === 'draft') {
    const initial =
      request.headers.get('If-None-Match') === '*' &&
      !request.headers.has('If-Match')
    const etag = initial ? null : requiredMatch(request)
    const result = DraftSchema.safeParse(await readJson(request))
    if (!result.success)
      throw new HttpError(
        400,
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      )
    const object = await deps.bucket.put(DRAFT, JSON.stringify(result.data), {
      onlyIf: initial
        ? { etagDoesNotMatch: '*' }
        : { etagMatches: etagValue(etag!) },
    })
    if (!object) throw new HttpError(412, 'Draft changed; reload before saving')
    return json(result.data, 200, { ETag: object.httpEtag })
  }
  if (request.method === 'GET' && action === 'history') {
    const state = await readCurrent(deps.bucket)
    return json({ items: state.value.history })
  }
  if (request.method === 'POST' && action === 'images') {
    const bytes = await readBytes(request, MAX_IMAGE_BYTES)
    const type = imageType(bytes)
    if (
      !type ||
      request.headers.get('Content-Type')?.split(';')[0] !== type.contentType
    )
      throw new HttpError(
        415,
        'Upload a PNG, JPEG, or WebP with matching Content-Type',
      )
    const digest = Array.from(await sha256Bytes(bytes), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const key = `images/${digest}.${type.extension}`
    await deps.bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: type.contentType },
    })
    return json({ url: `/announcements/${key}` }, 201)
  }
  if (
    request.method === 'POST' &&
    (action === 'publish' || action === 'unpublish')
  ) {
    const expected = requiredMatch(request)
    const state = await readCurrent(deps.bucket)
    if (state.etag !== expected)
      throw new HttpError(412, 'Publication changed; reload before publishing')
    let feed: Feed = { schemaVersion: 1, announcement: null }
    let history = state.value.history
    if (action === 'publish') {
      const body = (await readJson(request)) as { draftEtag?: unknown }
      if (!body || typeof body.draftEtag !== 'string')
        throw new HttpError(400, 'draftEtag is required')
      const draftObject = await deps.bucket.get(DRAFT)
      if (!draftObject || draftObject.httpEtag !== body.draftEtag)
        throw new HttpError(412, 'Draft changed; reload before publishing')
      if (draftObject.size > MAX_JSON_BYTES)
        throw new Error('Invalid saved draft')
      const draft = DraftSchema.parse(await draftObject.json())
      if (
        Object.keys(draft.announcement.locales).some(
          (locale) => locale !== 'en-us',
        )
      ) {
        const english = draft.announcement.locales['en-us']!
        // This exact field order is shared with the local translation tool.
        const sourceHash = await sha256Hex(
          JSON.stringify({
            bannerText: english.bannerText,
            title: english.title,
            markdown: english.markdown,
          }),
        )
        if (draft.translationSourceHash !== sourceHash)
          throw new HttpError(
            400,
            'Translations must match the current English source before publishing',
          )
      }
      const revision = crypto.randomUUID()
      const publishedAt = new Date().toISOString()
      feed = {
        schemaVersion: 1,
        announcement: { ...draft.announcement, revision, publishedAt },
      }
      const encoded = encodeFeed(feed)
      const key = `releases/${revision}.json`
      await deps.bucket.put(key, encoded, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      })
      history = [
        {
          revision,
          id: draft.announcement.id,
          publishedAt,
          url: `/announcements/${key}`,
        },
        ...history,
      ].slice(0, 100)
    }
    const updated: Current = { generation: crypto.randomUUID(), feed, history }
    const saved = await deps.bucket.put(CURRENT, JSON.stringify(updated), {
      onlyIf: { etagMatches: etagValue(expected) },
    })
    if (!saved)
      throw new HttpError(412, 'Publication changed; reload before publishing')
    if (deps.cache)
      defer(
        deps,
        deps.cache.delete(
          new Request(`${url.origin}/announcements/current.json`),
        ),
      )
    return json({ current: feed, currentEtag: saved.httpEtag })
  }
  return json({ error: 'Not found' }, 404)
}

/** All public failures are non-cacheable; clients retain their bounded stale copy. */
export async function handleAnnouncementRequest(
  request: Request,
  deps: Dependencies,
): Promise<Response> {
  const isAdmin = new URL(request.url).pathname.startsWith('/admin/')
  try {
    if (isAdmin) return await admin(request, deps)
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return json({ error: 'Not found' }, 404)
    const response = await publicRead(request, deps)
    return request.method === 'HEAD' ? new Response(null, response) : response
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status)
    console.error('Announcement storage unavailable')
    return json({ error: 'Announcements unavailable' }, 503)
  }
}
export function announcementRoute(ctx: AppContext): Promise<Response> {
  return handleAnnouncementRequest(ctx.req.raw, {
    bucket: ctx.env.ANNOUNCEMENTS_BUCKET,
    adminToken: ctx.env.ADMIN_API_TOKEN,
    cache: caches.default,
    waitUntil: (promise) => ctx.executionCtx.waitUntil(promise),
  })
}
