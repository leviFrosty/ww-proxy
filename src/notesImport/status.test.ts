import { describe, expect, it, vi } from 'vitest'
import {
  anyAllowlistedProviderHealthy,
  getNotesImportStatus,
  type OpenRouterEndpointsResponse,
  type StatusKv,
} from './status'
import type { NotesImportConfig } from './config'
import { makeMemoryKv } from '../test/memoryKv'

const CONFIG: NotesImportConfig = {
  model: 'deepseek/deepseek-v4-flash',
  providers: ['fireworks', 'digitalocean'],
  maxChars: 100_000,
  maxOutputTokens: 16_000,
  freeCredits: 5,
  maxRefinements: 5,
  entitlementId: 'Supporter',
  devBypassToken: null,
  activeImportCap: 2,
  activeImportCapSupporter: 5,
  resultRetentionSeconds: 3_600,
  subscribeTokenTtlSeconds: 3_600,
  reasoningEffort: 'low',
}

const endpointsBody = (
  endpoints: { provider_name: string; status: number }[]
): OpenRouterEndpointsResponse => ({ data: { endpoints } })

const okFetch = (body: OpenRouterEndpointsResponse): typeof fetch =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200 })
  ) as unknown as typeof fetch

describe('anyAllowlistedProviderHealthy', () => {
  it('true when an allowlisted provider is healthy (status 0)', () => {
    const body = endpointsBody([{ provider_name: 'Fireworks', status: 0 }])
    expect(anyAllowlistedProviderHealthy(body, CONFIG.providers)).toBe(true)
  })

  it('false when the only allowlisted provider is degraded (negative status)', () => {
    const body = endpointsBody([{ provider_name: 'DeepInfra', status: -1 }])
    expect(anyAllowlistedProviderHealthy(body, CONFIG.providers)).toBe(false)
  })

  it('ignores healthy providers that are NOT on the allowlist', () => {
    // DeepInfra is deliberately off the allowlist (mislabels reasoning), so a
    // healthy DeepInfra endpoint must NOT count toward provider health.
    const body = endpointsBody([{ provider_name: 'DeepInfra', status: 0 }])
    expect(anyAllowlistedProviderHealthy(body, CONFIG.providers)).toBe(false)
  })

  it('matches provider names loosely (case/spacing insensitive)', () => {
    const body = endpointsBody([{ provider_name: 'Digital Ocean', status: 0 }])
    expect(anyAllowlistedProviderHealthy(body, CONFIG.providers)).toBe(true)
  })

  it('false for an empty endpoint list', () => {
    expect(anyAllowlistedProviderHealthy(endpointsBody([]), CONFIG.providers)).toBe(
      false
    )
  })
})

describe('getNotesImportStatus — kill-switch', () => {
  it('reports disabled when the KV flag is off, without probing providers', async () => {
    const kv = makeMemoryKv()
    await kv.put('notes-import:enabled', 'false')
    const fetchFn = vi.fn() as unknown as typeof fetch

    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })

    expect(res).toEqual({ available: false, reason: 'disabled' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('reports disabled with operator reason from a JSON record, without probing', async () => {
    const kv = makeMemoryKv()
    await kv.put(
      'notes-import:enabled',
      JSON.stringify({ available: false, reason: 'down for maintenance' })
    )
    const fetchFn = vi.fn() as unknown as typeof fetch

    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })

    expect(res).toEqual({ available: false, reason: 'down for maintenance' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('falls through to the provider check when the JSON record is available:true', async () => {
    const kv = makeMemoryKv()
    await kv.put(
      'notes-import:enabled',
      JSON.stringify({ available: true, reason: '' })
    )
    const fetchFn = okFetch(
      endpointsBody([{ provider_name: 'Fireworks', status: 0 }])
    )
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })
    expect(res).toEqual({ available: true })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('treats an absent flag as enabled', async () => {
    const kv = makeMemoryKv()
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn: okFetch(endpointsBody([{ provider_name: 'Fireworks', status: 0 }])),
    })
    expect(res.available).toBe(true)
  })
})

describe('getNotesImportStatus — provider health + caching', () => {
  it('available when a provider is healthy, and caches "up"', async () => {
    const kv = makeMemoryKv()
    const fetchFn = okFetch(
      endpointsBody([{ provider_name: 'Fireworks', status: 0 }])
    )
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })
    expect(res).toEqual({ available: true })
    expect(kv.store.get('notes-import:provider-health')).toBe('up')
  })

  it('no_provider when all allowlisted providers are down, and caches "down"', async () => {
    const kv = makeMemoryKv()
    const fetchFn = okFetch(
      endpointsBody([{ provider_name: 'Fireworks', status: -1 }])
    )
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })
    expect(res).toEqual({ available: false, reason: 'no_provider' })
    expect(kv.store.get('notes-import:provider-health')).toBe('down')
  })

  it('serves a cached result without re-probing', async () => {
    const kv = makeMemoryKv()
    await kv.put('notes-import:provider-health', 'down')
    const fetchFn = vi.fn() as unknown as typeof fetch
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })
    expect(res).toEqual({ available: false, reason: 'no_provider' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails open when the upstream probe errors, and does not cache', async () => {
    const kv = makeMemoryKv()
    const fetchFn = vi.fn(async () =>
      new Response('nope', { status: 500 })
    ) as unknown as typeof fetch
    const res = await getNotesImportStatus({
      kv: kv as unknown as StatusKv,
      apiKey: 'k',
      config: CONFIG,
      fetchFn,
    })
    expect(res).toEqual({ available: true })
    expect(kv.store.has('notes-import:provider-health')).toBe(false)
  })
})
