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
export const decideAcquire = (
  activeCount: number,
  alreadyHeld: boolean,
  cap: number
): boolean => alreadyHeld || activeCount < cap
