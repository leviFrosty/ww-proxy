/**
 * Import-credit metering — PURE decision + arithmetic, no storage. The
 * authoritative counters live in the per-user `NotesImportIndex` Durable Object
 * (see `notesImport/indexDO.ts`), which is ONE single-threaded instance per
 * install uuid: its SQLite storage is strongly consistent and its RPC calls are
 * serialized, so the check-and-commit that used to race over eventually-
 * consistent KV is now atomic. This module holds only the pure math the DO wraps
 * (mirrors how `cap.ts` extracts `decideAcquire` out of the index DO), so it
 * unit-tests without importing the `cloudflare:workers` runtime.
 *
 * Metering unit is 1 credit per distinct content hash. Replays of a known hash
 * and stateless follow-up refinements are free (the latter capped). Supporters
 * are unlimited but their hashes are still recorded so the refinement cap and
 * replay-recognition work uniformly. Credit is charged AFTER a successful model
 * run (a failure/cancel must never cost a credit); the residual overage from a
 * concurrent burst is bounded by the per-user concurrency cap — see
 * {@link computeCommit}.
 *
 * The old KV keys `credits:<uuid>` and `hash:<uuid>:<hash>` are ABANDONED; the
 * counters moved into the index DO (ADR 0008, decision 7 — the "counters" the
 * KV note refers to now live in the DO).
 */

/** A per-content-hash usage record. */
export interface HashRecord {
  charged: boolean
  refinements: number
}

/** The per-user credit state a decision/commit reads. `record` null = new hash. */
export interface CreditState {
  count: number
  record: HashRecord | null
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

export interface RefinementUsage {
  remaining: number
  limit: number
}

/** The usage snapshot the client renders in its meter (kickoff + `done`). */
export interface CreditsSnapshot {
  remaining: number | null
  limit: number | null
  isSupporter: boolean
  refinements: RefinementUsage
}

const clampRemaining = (count: number, freeCredits: number): number =>
  Math.max(0, freeCredits - count)

export interface DecideCreditArgs {
  state: CreditState
  isSupporter: boolean
  isRefinement: boolean
  freeCredits: number
  maxRefinements: number
}

/**
 * Pre-flight gate (no writes). Decides whether this import may call the model.
 * Persist the outcome with {@link computeCommit} only after a successful call so
 * a model failure never costs the user a credit.
 */
export const decideCredit = ({
  state,
  isSupporter,
  isRefinement,
  freeCredits,
  maxRefinements,
}: DecideCreditArgs): CreditDecision => {
  const { count, record } = state

  if (record) {
    // Known hash → replay or refinement, always free of a new credit.
    if (isRefinement && record.refinements + 1 > maxRefinements) {
      return {
        allowed: false,
        reason: 'refinement_limit',
        isNewHash: false,
        isRefinement: true,
        remaining: isSupporter ? null : clampRemaining(count, freeCredits),
      }
    }
    return {
      allowed: true,
      isNewHash: false,
      isRefinement,
      remaining: isSupporter ? null : clampRemaining(count, freeCredits),
    }
  }

  // Brand-new content. Refinement flag is irrelevant without a prior record.
  if (isSupporter) {
    return { allowed: true, isNewHash: true, isRefinement: false, remaining: null }
  }
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

/** Reads the authoritative per-source refinement allowance from a record. */
export const refinementUsage = (
  record: HashRecord | null,
  maxRefinements: number
): RefinementUsage => {
  const used = Math.min(maxRefinements, record?.refinements ?? 0)
  return { remaining: maxRefinements - used, limit: maxRefinements }
}

export interface KickoffCreditsArgs {
  decision: CreditDecision
  /** Current record for the hash (pre-commit); drives the refinement allowance. */
  record: HashRecord | null
  /** The real Supporter entitlement (drives the snapshot's `isSupporter`). */
  isSupporter: boolean
  /** Supporter OR dev bypass — both suppress the import limit (`limit: null`). */
  unmetered: boolean
  freeCredits: number
  maxRefinements: number
}

/**
 * Builds the usage snapshot to return at KICKOFF — before the model runs — so
 * the client shows the meter the moment a run starts instead of waiting for the
 * `done` event. Writes nothing: `decision.remaining` is the read-only
 * post-settlement credit count the gate already computed, so it equals what
 * `done` reports. A refinement is charged only on success, so fold this pending
 * one in here too — otherwise the meter would tick down by one when `done`
 * lands. (For a new hash or a free replay, `decision.isRefinement` is false and
 * the refinement count is unchanged.)
 */
export const computeKickoffCredits = ({
  decision,
  record,
  isSupporter,
  unmetered,
  freeCredits,
  maxRefinements,
}: KickoffCreditsArgs): CreditsSnapshot => {
  const usage = refinementUsage(record, maxRefinements)
  const refinements = decision.isRefinement
    ? { ...usage, remaining: Math.max(0, usage.remaining - 1) }
    : usage
  return {
    remaining: decision.remaining,
    limit: unmetered ? null : freeCredits,
    isSupporter,
    refinements,
  }
}

export interface CommitCreditArgs {
  decision: CreditDecision
  state: CreditState
  isSupporter: boolean
  freeCredits: number
}

export interface CommitCreditResult {
  /** The next state to persist. */
  state: CreditState
  /** Credits remaining after the commit (`null` for Supporters). */
  remaining: number | null
}

/**
 * Computes the post-success commit from the CURRENT state (read atomically by
 * the index DO immediately before this call). Charge-after-success is race-free
 * because both the read and the write happen inside the single-threaded DO, so
 * concurrent commits are serialized — no lost increment (the old KV read-modify-
 * write dropped writes; this cannot). The one residual is bounded overage: up to
 * `cap` new-hash imports can pass the pre-flight gate while `count` sits just
 * under `freeCredits`, then each commit atomically increments, so a user may end
 * up at most `cap - 1` over the free limit. That's intentional — reserve-then-
 * refund's failure mode (silently losing a user's credits on a missed refund) is
 * worse than a tiny bounded overage — and the concurrency cap on BOTH import
 * paths keeps it small.
 *
 * Idempotent per hash: a new-hash charge only increments when the hash isn't
 * already `charged`, so a re-kick/replay of an already-charged hash never
 * double-charges (the `charged` flag is the idempotency key).
 */
export const computeCommit = ({
  decision,
  state,
  isSupporter,
  freeCredits,
}: CommitCreditArgs): CommitCreditResult => {
  const { count, record } = state

  if (decision.isNewHash) {
    if (isSupporter) {
      // Record the hash (for the refinement cap + replay recognition) but never
      // charge. Keep any existing record so this is idempotent.
      return {
        state: { count, record: record ?? { charged: false, refinements: 0 } },
        remaining: null,
      }
    }
    // Idempotency guard: charge a given hash at most once. If it's already
    // charged (a re-commit / replay), leave the count untouched.
    if (record?.charged) {
      return { state, remaining: clampRemaining(count, freeCredits) }
    }
    const nextCount = count + 1
    return {
      state: {
        count: nextCount,
        record: { charged: true, refinements: record?.refinements ?? 0 },
      },
      remaining: clampRemaining(nextCount, freeCredits),
    }
  }

  if (decision.isRefinement) {
    const base = record ?? { charged: !isSupporter, refinements: 0 }
    return {
      state: {
        count,
        record: { charged: base.charged, refinements: base.refinements + 1 },
      },
      remaining: isSupporter ? null : clampRemaining(count, freeCredits),
    }
  }

  // Free replay of a known hash — no state change.
  return { state, remaining: isSupporter ? null : clampRemaining(count, freeCredits) }
}
