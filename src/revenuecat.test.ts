import { describe, expect, it } from 'bun:test'
import { isSupporter, RevenueCatError } from './revenuecat'

const NOW = Date.parse('2026-06-18T00:00:00Z')

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch

const call = (status: number, body: unknown) =>
  isSupporter({
    apiKey: 'sk_test',
    appUserId: 'uuid-123',
    entitlementId: 'Supporter',
    fetchImpl: fakeFetch(status, body),
    nowMs: NOW,
  })

describe('isSupporter', () => {
  it('is true for a lifetime entitlement (null expiry)', async () => {
    expect(
      await call(200, {
        subscriber: { entitlements: { Supporter: { expires_date: null } } },
      })
    ).toBe(true)
  })

  it('is true for a subscription that has not expired', async () => {
    expect(
      await call(200, {
        subscriber: {
          entitlements: { Supporter: { expires_date: '2027-01-01T00:00:00Z' } },
        },
      })
    ).toBe(true)
  })

  it('is false for an expired subscription', async () => {
    expect(
      await call(200, {
        subscriber: {
          entitlements: { Supporter: { expires_date: '2025-01-01T00:00:00Z' } },
        },
      })
    ).toBe(false)
  })

  it('is false when the entitlement is absent', async () => {
    expect(
      await call(200, { subscriber: { entitlements: { Other: {} } } })
    ).toBe(false)
  })

  it('is false for an unknown subscriber (404)', async () => {
    expect(await call(404, { error: 'not found' })).toBe(false)
  })

  it('throws RevenueCatError on an unexpected status', async () => {
    await expect(call(500, { error: 'boom' })).rejects.toBeInstanceOf(
      RevenueCatError
    )
  })
})
