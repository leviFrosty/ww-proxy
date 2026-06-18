/**
 * Import-credit metering, backed by Cloudflare KV. Stores ONLY counters — never
 * notes text or model output (ADR 0008, decision 7):
 *
 *   credits:<uuid>        → string integer: charged distinct-content imports
 *   hash:<uuid>:<hash>    → JSON { charged, refinements }
 *
 * Metering unit is 1 credit per distinct content hash. Replays of a known hash
 * and stateless follow-up refinements are free (the latter capped). Supporters
 * are unlimited but their hashes are still recorded so the refinement cap and
 * replay-recognition work uniformly.
 */

/** The subset of KV we use — keeps the module trivially mockable in tests. */
export type KvLike = Pick<KVNamespace, 'get' | 'put'>

interface HashRecord {
  charged: boolean
  refinements: number
}

export type CreditDenyReason = 'limit_reached' | 'refinement_limit'

export interface CreditDecision {
  allowed: boolean
  reason?: CreditDenyReason
  /** True when this content hash has not been charged/recorded before. */
  isNewHash: boolean
  isRefinement: boolean
  /** Credits left after this import would commit; `null` for Supporters. */
  remaining: number | null
}

const creditsKey = (uuid: string) => `credits:${uuid}`
const hashKey = (uuid: string, hash: string) => `hash:${uuid}:${hash}`

const readCount = async (kv: KvLike, uuid: string): Promise<number> => {
  const raw = await kv.get(creditsKey(uuid))
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const readHash = async (
  kv: KvLike,
  uuid: string,
  hash: string
): Promise<HashRecord | null> => {
  const raw = await kv.get(hashKey(uuid, hash))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<HashRecord>
    return {
      charged: parsed.charged === true,
      refinements:
        typeof parsed.refinements === 'number' && parsed.refinements >= 0
          ? parsed.refinements
          : 0,
    }
  } catch {
    return null
  }
}

export interface CheckCreditArgs {
  kv: KvLike
  uuid: string
  hash: string
  isSupporter: boolean
  isRefinement: boolean
  freeCredits: number
  maxRefinements: number
}

/**
 * Pre-flight gate (no writes). Decides whether this import may call the model.
 * Persist the outcome with {@link recordUsage} only after a successful call so a
 * model failure never costs the user a credit.
 */
export const checkCredit = async ({
  kv,
  uuid,
  hash,
  isSupporter,
  isRefinement,
  freeCredits,
  maxRefinements,
}: CheckCreditArgs): Promise<CreditDecision> => {
  const record = await readHash(kv, uuid, hash)

  if (record) {
    // Known hash → replay or refinement, always free of a new credit.
    if (isRefinement && record.refinements + 1 > maxRefinements) {
      return {
        allowed: false,
        reason: 'refinement_limit',
        isNewHash: false,
        isRefinement: true,
        remaining: isSupporter ? null : await remainingFor(kv, uuid, freeCredits),
      }
    }
    return {
      allowed: true,
      isNewHash: false,
      isRefinement,
      remaining: isSupporter ? null : await remainingFor(kv, uuid, freeCredits),
    }
  }

  // Brand-new content. Refinement flag is irrelevant without a prior record.
  if (isSupporter) {
    return { allowed: true, isNewHash: true, isRefinement: false, remaining: null }
  }
  const count = await readCount(kv, uuid)
  if (count >= freeCredits) {
    return {
      allowed: false,
      reason: 'limit_reached',
      isNewHash: true,
      isRefinement: false,
      remaining: 0,
    }
  }
  return {
    allowed: true,
    isNewHash: true,
    isRefinement: false,
    remaining: freeCredits - count - 1,
  }
}

const remainingFor = async (
  kv: KvLike,
  uuid: string,
  freeCredits: number
): Promise<number> => Math.max(0, freeCredits - (await readCount(kv, uuid)))

export interface RecordUsageArgs {
  kv: KvLike
  uuid: string
  hash: string
  isSupporter: boolean
  decision: CreditDecision
  freeCredits: number
}

/**
 * Commits the usage after a successful model call. Returns credits remaining
 * (`null` for Supporters) for the response body.
 */
export const recordUsage = async ({
  kv,
  uuid,
  hash,
  isSupporter,
  decision,
  freeCredits,
}: RecordUsageArgs): Promise<number | null> => {
  if (decision.isNewHash) {
    await kv.put(
      hashKey(uuid, hash),
      JSON.stringify({ charged: !isSupporter, refinements: 0 } satisfies HashRecord)
    )
    if (isSupporter) return null
    const count = await readCount(kv, uuid)
    const next = count + 1
    await kv.put(creditsKey(uuid), String(next))
    return Math.max(0, freeCredits - next)
  }

  if (decision.isRefinement) {
    const record = (await readHash(kv, uuid, hash)) ?? {
      charged: !isSupporter,
      refinements: 0,
    }
    await kv.put(
      hashKey(uuid, hash),
      JSON.stringify({
        charged: record.charged,
        refinements: record.refinements + 1,
      } satisfies HashRecord)
    )
  }

  return isSupporter ? null : remainingFor(kv, uuid, freeCredits)
}
