/**
 * Pure per-user concurrency-cap decision, split out from `indexDO.ts` so it can
 * be unit-tested without importing the `cloudflare:workers` runtime (which the
 * plain-node test pool cannot resolve).
 *
 * A slot is grantable when the importId is already held (idempotent re-kick /
 * reconnect) or the active count is below the cap. The index DO is
 * single-threaded, so the count-then-insert it guards never interleaves — this
 * check is race-free without locks.
 */
import type { ImportStatus } from './events'

export const decideAcquire = (
  activeCount: number,
  alreadyHeld: boolean,
  cap: number
): boolean => alreadyHeld || activeCount < cap

/**
 * What a re-kick of an existing run DO resolves to, from its persisted status.
 * Split out (like {@link decideAcquire}) so the leak-relevant decision is pure
 * and unit-testable without the `cloudflare:workers` runtime.
 */
export type StartOutcome =
  | 'started' // fresh, or restart after a failure — run scheduled, slot in use
  | 'running' // live re-kick — index row still held, acquire was a no-op
  | 'terminal' // re-kick of a settled run — acquire re-inserted an ORPHAN row

/**
 * Decide how `start()` treats a re-kick, and — critically — whether the slot the
 * kickoff just acquired is legitimately held or must be released. The index DO
 * has NO TTL, so any slot not released is leaked forever; once `cap` leak, the
 * user is locked out permanently (429 `active_cap`). Mapping:
 *
 *  - null / 'error'  → 'started': fresh run or restart-after-failure. The run is
 *    (re)scheduled and legitimately consumes the acquired slot. KEEP it.
 *  - live statuses (queued/starting/thinking/structuring) → 'running': the run's
 *    index row still exists, so `acquire` was idempotent and added nothing — the
 *    slot is already in use. No-op. KEEP it.
 *  - 'done' / 'cancelled' → 'terminal': `start()` no-ops (reconnect to the cached
 *    result), but that run released its slot when it first settled, so `acquire`
 *    just re-INSERTED an orphan row. The caller MUST release it.
 */
export const decideStartOutcome = (
  status: ImportStatus | null
): StartOutcome => {
  if (status === 'done' || status === 'cancelled') return 'terminal'
  if (status === null || status === 'error') return 'started'
  return 'running'
}
