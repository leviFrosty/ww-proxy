import type { NotesImportConfig } from './config'

/** The KV subset this module uses — keeps it trivially mockable in tests. */
export type StatusKv = Pick<KVNamespace, 'get' | 'put'>

/**
 * Notes Import availability probe. Backs `GET /notes-import/status` so the app
 * can disable the import entry points BEFORE a user spends an attestation
 * round-trip (and before we'd spend any inference) when the feature can't
 * actually run. Two independent gates, cheapest first:
 *
 *   1. Manual KV kill-switch (`notes-import:enabled`) — flip the feature off (or
 *      back on) instantly with no redeploy:
 *         wrangler kv key put --binding NOTES_KV notes-import:enabled false
 *      Absent or anything other than a falsy string = enabled (default on).
 *
 *   2. Provider health — OpenRouter's endpoints metadata API reports a per-host
 *      `status`. We check whether ANY provider on our ZDR allowlist is currently
 *      healthy for the configured model. This is a metadata call: it consumes NO
 *      tokens / inference credits. Result is cached in KV (short TTL) so the
 *      probe stays fast and we don't hammer the upstream.
 *
 * Fail-open by design: if the upstream check itself errors, we report available.
 * A flaky probe must never block a feature that would actually work — the real
 * import path still enforces attestation, credits, and ZDR routing server-side.
 */

export type NotesImportUnavailableReason = 'disabled' | 'no_provider'

export interface NotesImportStatusResponse {
  available: boolean
  reason?: NotesImportUnavailableReason
}

const ENABLED_KEY = 'notes-import:enabled'
const PROVIDER_CACHE_KEY = 'notes-import:provider-health'
const PROVIDER_CACHE_TTL_SECONDS = 60

/** OpenRouter per-endpoint `status`: 0 = normal, negatives = degraded/disabled. */
const isHealthyStatus = (status: unknown): boolean => {
  if (status == null) return true // no signal → don't treat as down
  const n = typeof status === 'number' ? status : Number(status)
  return Number.isFinite(n) ? n >= 0 : true
}

/** Loose match of an OpenRouter `provider_name` to one of our allowlist slugs. */
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const matchesAllowlist = (
  providerName: string,
  allowlist: readonly string[]
): boolean => {
  const p = normalize(providerName)
  if (!p) return false
  return allowlist.some((slug) => {
    const s = normalize(slug)
    return s.length > 0 && (p === s || p.includes(s) || s.includes(p))
  })
}

interface OpenRouterEndpoint {
  provider_name?: string
  status?: number | string
}

export interface OpenRouterEndpointsResponse {
  data?: { endpoints?: OpenRouterEndpoint[] }
}

/**
 * Pure decision: does the OpenRouter endpoints payload show at least one
 * allowlisted provider in a healthy state for the model? Exported for tests.
 */
export const anyAllowlistedProviderHealthy = (
  body: OpenRouterEndpointsResponse,
  allowlist: readonly string[]
): boolean => {
  const endpoints = body.data?.endpoints ?? []
  return endpoints.some(
    (e) =>
      typeof e.provider_name === 'string' &&
      matchesAllowlist(e.provider_name, allowlist) &&
      isHealthyStatus(e.status)
  )
}

/**
 * Returns true if at least one allowlisted provider is healthy for the model,
 * per OpenRouter's free endpoints metadata API. Throws on a failed/garbled
 * upstream response so the caller can fail open.
 */
const probeProviderHealth = async (
  apiKey: string,
  config: NotesImportConfig,
  fetchFn: typeof fetch
): Promise<boolean> => {
  // Model slug is `<author>/<slug>` (e.g. `deepseek/deepseek-v4-flash`).
  const slash = config.model.indexOf('/')
  if (slash <= 0) return true // unrecognized slug shape → don't block
  const author = config.model.slice(0, slash)
  const slug = config.model.slice(slash + 1)
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(
    author
  )}/${encodeURIComponent(slug)}/endpoints`

  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    throw new Error(`OpenRouter endpoints API returned ${res.status}`)
  }
  const body = (await res.json()) as OpenRouterEndpointsResponse
  return anyAllowlistedProviderHealthy(body, config.providers)
}

const KILL_SWITCH_OFF = new Set(['false', 'off', '0', 'no', 'disabled'])

export interface NotesImportStatusDeps {
  kv: StatusKv
  apiKey: string
  config: NotesImportConfig
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch
}

/**
 * Resolves whether Notes Import is currently usable. Cheap KV kill-switch first,
 * then a cached provider-health probe. Never throws — fails open.
 */
export const getNotesImportStatus = async ({
  kv,
  apiKey,
  config,
  fetchFn = fetch,
}: NotesImportStatusDeps): Promise<NotesImportStatusResponse> => {
  // 1. Manual kill-switch.
  const flag = (await kv.get(ENABLED_KEY))?.trim().toLowerCase()
  if (flag != null && KILL_SWITCH_OFF.has(flag)) {
    return { available: false, reason: 'disabled' }
  }

  // 2. Provider health (cached).
  const cached = await kv.get(PROVIDER_CACHE_KEY)
  if (cached === 'up') return { available: true }
  if (cached === 'down') return { available: false, reason: 'no_provider' }

  try {
    const healthy = await probeProviderHealth(apiKey, config, fetchFn)
    await kv.put(PROVIDER_CACHE_KEY, healthy ? 'up' : 'down', {
      expirationTtl: PROVIDER_CACHE_TTL_SECONDS,
    })
    return healthy
      ? { available: true }
      : { available: false, reason: 'no_provider' }
  } catch {
    // Fail open — don't cache a transient failure.
    return { available: true }
  }
}
