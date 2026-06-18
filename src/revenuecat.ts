/**
 * Server-side Supporter verification via the RevenueCat REST v1 API. The app
 * sets the Keychain UUID as its RevenueCat App User ID (ADR 0007), so we look
 * the subscriber up by that same id and check the configured entitlement.
 *
 * The secret key never ships in the app — only the proxy holds it.
 */

export interface SupporterCheckArgs {
  apiKey: string
  appUserId: string
  entitlementId: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock for tests (epoch ms). Defaults to Date.now(). */
  nowMs?: number
}

interface RcEntitlement {
  expires_date?: string | null
}

interface RcSubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, RcEntitlement>
  }
}

/**
 * Returns true iff the subscriber currently holds the Supporter entitlement
 * (lifetime → `expires_date` null, or a subscription whose expiry is in the
 * future). Fails CLOSED: an unknown subscriber (404) or any error resolves to
 * `false`, so the caller falls back to the free-credit meter rather than
 * granting unlimited access on a fluke. The caller is responsible for reporting
 * unexpected (non-404) failures.
 */
export const isSupporter = async ({
  apiKey,
  appUserId,
  entitlementId,
  fetchImpl = fetch,
  nowMs = Date.now(),
}: SupporterCheckArgs): Promise<boolean> => {
  const res = await fetchImpl(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    }
  )

  if (!res.ok) {
    // 404 = RevenueCat has never seen this id → definitively not a Supporter.
    // Anything else is unexpected; the caller logs it. Either way: not a
    // Supporter, so the free meter applies.
    if (res.status !== 404) {
      throw new RevenueCatError(`RevenueCat ${res.status}`)
    }
    return false
  }

  const body = (await res.json()) as RcSubscriberResponse
  const ent = body.subscriber?.entitlements?.[entitlementId]
  if (!ent) return false

  // Lifetime entitlements carry a null expiry; subscriptions carry a date.
  if (ent.expires_date == null) return true
  const expiresMs = Date.parse(ent.expires_date)
  return Number.isFinite(expiresMs) && expiresMs > nowMs
}

/** Distinguishes an unexpected RevenueCat failure (report it) from a 404. */
export class RevenueCatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevenueCatError'
  }
}
