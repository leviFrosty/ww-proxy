import { describe, expect, it } from 'vitest'
import {
  decideCredit,
  computeCommit,
  computeKickoffCredits,
  refinementUsage,
  type CreditDecision,
  type CreditState,
  type HashRecord,
} from './credits'

const FREE = 5
const MAXREF = 5

/**
 * A tiny in-memory stand-in for the index DO's per-user credit storage, so the
 * pure functions can be exercised through the same read → decide → commit → write
 * sequence the DO performs. The DO is single-threaded, so applying commits
 * serially (each reading fresh state) is exactly what production does.
 */
class MeterStore {
  count = 0
  records = new Map<string, HashRecord>()
  state(hash: string): CreditState {
    return { count: this.count, record: this.records.get(hash) ?? null }
  }
  apply(hash: string, next: CreditState): void {
    this.count = next.count
    if (next.record) this.records.set(hash, next.record)
  }
}

/** Gate + (on success) commit, mirroring the route/run-DO order. */
const consume = (
  store: MeterStore,
  hash: string,
  opts: { isSupporter?: boolean; isRefinement?: boolean } = {}
): CreditDecision => {
  const isSupporter = opts.isSupporter ?? false
  const isRefinement = opts.isRefinement ?? false
  const decision = decideCredit({
    state: store.state(hash),
    isSupporter,
    isRefinement,
    freeCredits: FREE,
    maxRefinements: MAXREF,
  })
  if (!decision.allowed) return decision
  const { state: next, remaining } = computeCommit({
    decision,
    state: store.state(hash),
    isSupporter,
    freeCredits: FREE,
  })
  store.apply(hash, next)
  return { ...decision, remaining }
}

describe('credit metering — non-supporter', () => {
  it('allows exactly 5 distinct imports then blocks the 6th', () => {
    const store = new MeterStore()
    const remainings: (number | null)[] = []
    for (let i = 0; i < 5; i++) {
      const r = consume(store, `hash-${i}`)
      expect(r.allowed).toBe(true)
      remainings.push(r.remaining ?? null)
    }
    expect(remainings).toEqual([4, 3, 2, 1, 0])

    const sixth = consume(store, 'hash-5')
    expect(sixth.allowed).toBe(false)
    expect(sixth.reason).toBe('limit_reached')
  })

  it('replays a charged hash for free even after the limit is hit', () => {
    const store = new MeterStore()
    for (let i = 0; i < 5; i++) consume(store, `hash-${i}`)
    // Already at the cap; replaying an existing hash is still allowed + free.
    const replay = consume(store, 'hash-0')
    expect(replay.allowed).toBe(true)
    expect(replay.isNewHash).toBe(false)
    expect(store.count).toBe(5) // no extra charge
  })

  it('isolates counts per identity', () => {
    // Distinct users are distinct DO instances → distinct stores.
    const u1 = new MeterStore()
    const u2 = new MeterStore()
    for (let i = 0; i < 5; i++) consume(u1, `h-${i}`)
    expect(consume(u2, 'h-0').allowed).toBe(true)
  })
})

describe('credit metering — refinements', () => {
  it('treats follow-up refinements as free but caps them', () => {
    const store = new MeterStore()
    consume(store, 'hash-x') // original import, costs 1 credit
    for (let i = 0; i < MAXREF; i++) {
      const r = consume(store, 'hash-x', { isRefinement: true })
      expect(r.allowed).toBe(true)
      expect(r.isRefinement).toBe(true)
    }
    const overflow = consume(store, 'hash-x', { isRefinement: true })
    expect(overflow.allowed).toBe(false)
    expect(overflow.reason).toBe('refinement_limit')
  })

  it('does not spend a credit on any refinement', () => {
    const store = new MeterStore()
    consume(store, 'hash-x')
    consume(store, 'hash-x', { isRefinement: true })
    // Four more distinct originals should still be allowed (only 1 spent).
    for (let i = 0; i < 4; i++) {
      expect(consume(store, `other-${i}`).allowed).toBe(true)
    }
    expect(consume(store, 'one-too-many').allowed).toBe(false)
  })

  it('reports the authoritative refinement allowance for a source hash', () => {
    const store = new MeterStore()
    consume(store, 'hash-x')
    expect(refinementUsage(store.state('hash-x').record, MAXREF)).toEqual({
      remaining: 5,
      limit: 5,
    })

    consume(store, 'hash-x', { isRefinement: true })
    consume(store, 'hash-x', { isRefinement: true })
    expect(refinementUsage(store.state('hash-x').record, MAXREF)).toEqual({
      remaining: 3,
      limit: 5,
    })
  })
})

describe('credit metering — supporter', () => {
  it('never blocks and reports unlimited (null) remaining', () => {
    const store = new MeterStore()
    for (let i = 0; i < 12; i++) {
      const r = consume(store, `hash-${i}`, { isSupporter: true })
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBeNull()
    }
    expect(store.count).toBe(0) // supporters never charge
  })
})

describe('computeCommit — idempotency + atomicity', () => {
  it('charges a new hash at most once (re-commit is a no-op)', () => {
    const store = new MeterStore()
    const decision = decideCredit({
      state: store.state('h'),
      isSupporter: false,
      isRefinement: false,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    // First commit charges.
    const first = computeCommit({
      decision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
    })
    store.apply('h', first.state)
    expect(store.count).toBe(1)
    // Replaying the SAME frozen decision must not double-charge (charged flag).
    const second = computeCommit({
      decision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
    })
    store.apply('h', second.state)
    expect(store.count).toBe(1)
    expect(second.remaining).toBe(4)
  })

  it('never loses an increment when commits are serialized (bounded overage)', () => {
    // Simulate a concurrent burst: 4 credits already spent, cap allows 2 more
    // distinct-hash imports in flight. BOTH pass the pre-flight gate on the same
    // stale count (4 < 5). With the atomic DO, their commits run serialized —
    // each reads fresh state — so BOTH increments land (5 then 6): no lost write
    // (the old KV read-modify-write would have dropped one). The residual is a
    // BOUNDED overage of at most cap-1 past the free limit, by design.
    const store = new MeterStore()
    for (let i = 0; i < 4; i++) consume(store, `seed-${i}`)
    expect(store.count).toBe(4)

    const dA = decideCredit({
      state: { count: 4, record: null },
      isSupporter: false,
      isRefinement: false,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    const dB = decideCredit({
      state: { count: 4, record: null },
      isSupporter: false,
      isRefinement: false,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    expect(dA.allowed && dB.allowed).toBe(true)

    // Serialized commits (the DO's single thread), each reading fresh state.
    const a = computeCommit({
      decision: dA,
      state: store.state('a'),
      isSupporter: false,
      freeCredits: FREE,
    })
    store.apply('a', a.state)
    const b = computeCommit({
      decision: dB,
      state: store.state('b'),
      isSupporter: false,
      freeCredits: FREE,
    })
    store.apply('b', b.state)

    expect(store.count).toBe(6) // both landed — no lost increment
    // The next NEW hash is now correctly denied.
    expect(consume(store, 'c').allowed).toBe(false)
  })
})

describe('empty-import grace (ADR 0012)', () => {
  const newHashDecision = (store: MeterStore, hash: string): CreditDecision =>
    decideCredit({
      state: store.state(hash),
      isSupporter: false,
      isRefinement: false,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })

  it('does not charge a within-window empty, but flags it to be logged', () => {
    const store = new MeterStore()
    const decision = newHashDecision(store, 'h')
    const commit = computeCommit({
      decision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
      empty: { isEmpty: true, countInWindow: 0, limit: 5 },
    })
    expect(commit.emptyCharged).toBe(false)
    expect(commit.recordsEmptyRun).toBe(true)
    expect(commit.remaining).toBe(5) // untouched — no credit spent
    store.apply('h', commit.state)
    expect(store.count).toBe(0)
    expect(store.records.size).toBe(0) // the empty hash is NOT recorded
  })

  it('charges an empty once the window is exhausted (soft degrade)', () => {
    const store = new MeterStore()
    const decision = newHashDecision(store, 'h')
    const commit = computeCommit({
      decision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
      empty: { isEmpty: true, countInWindow: 5, limit: 5 },
    })
    expect(commit.emptyCharged).toBe(true)
    expect(commit.recordsEmptyRun).toBe(true)
    expect(commit.remaining).toBe(4) // charged like a normal new hash
    store.apply('h', commit.state)
    expect(store.count).toBe(1)
  })

  it('gives 5 free empties then charges the 6th, keeping the hashes unrecorded', () => {
    // Mirror the DO's recordUsage loop over a stream of DISTINCT empty pastes.
    const store = new MeterStore()
    let windowRuns = 0
    const runEmpty = (hash: string) => {
      const decision = newHashDecision(store, hash)
      expect(decision.allowed).toBe(true) // empties never deplete credits → never gate
      const commit = computeCommit({
        decision,
        state: store.state(hash),
        isSupporter: false,
        freeCredits: FREE,
        empty: { isEmpty: true, countInWindow: windowRuns, limit: 5 },
      })
      if (commit.recordsEmptyRun) windowRuns++
      store.apply(hash, commit.state)
      return commit
    }
    for (let i = 0; i < 5; i++) expect(runEmpty(`empty-${i}`).emptyCharged).toBe(false)
    expect(store.count).toBe(0) // nothing charged across 5 free empties
    expect(store.records.size).toBe(0) // and none recorded → a re-paste flows fresh

    const sixth = runEmpty('empty-5')
    expect(sixth.emptyCharged).toBe(true)
    expect(store.count).toBe(1)
  })

  it('never applies the grace to a supporter (nothing to save)', () => {
    const store = new MeterStore()
    const decision = decideCredit({
      state: store.state('h'),
      isSupporter: true,
      isRefinement: false,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    const commit = computeCommit({
      decision,
      state: store.state('h'),
      isSupporter: true,
      freeCredits: FREE,
      empty: { isEmpty: true, countInWindow: 0, limit: 5 },
    })
    expect(commit.recordsEmptyRun).toBe(false)
    expect(commit.emptyCharged).toBe(false)
    expect(commit.remaining).toBeNull()
  })

  it('never applies the grace to a refinement or a replay', () => {
    const store = new MeterStore()
    consume(store, 'h') // charge the original
    const refDecision = decideCredit({
      state: store.state('h'),
      isSupporter: false,
      isRefinement: true,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    const refCommit = computeCommit({
      decision: refDecision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
      empty: { isEmpty: true, countInWindow: 0, limit: 5 },
    })
    expect(refCommit.recordsEmptyRun).toBe(false) // refinements never charge anyway

    // A replay of the already-charged hash must not be double-charged nor logged.
    const replayDecision = newHashDecision(store, 'h') // record exists but isNewHash=false
    const replayCommit = computeCommit({
      decision: replayDecision,
      state: store.state('h'),
      isSupporter: false,
      freeCredits: FREE,
      empty: { isEmpty: true, countInWindow: 0, limit: 5 },
    })
    expect(replayCommit.recordsEmptyRun).toBe(false)
    expect(replayCommit.emptyCharged).toBe(false)
  })
})

describe('kickoff credits snapshot', () => {
  /**
   * Gate, snapshot the credits as the kickoff returns them (read-only,
   * pre-charge), THEN commit + build the snapshot as the `done` event does.
   * The two must be identical — that's the whole contract: showing the meter at
   * kickoff must not flicker when `done` lands.
   */
  const gateThenSettle = (
    store: MeterStore,
    hash: string,
    opts: { supporter?: boolean; unmetered?: boolean; isRefinement?: boolean } = {}
  ) => {
    const supporter = opts.supporter ?? false
    // Route passes `unmetered` (supporter OR dev bypass) to the gate + recorder.
    const unmetered = opts.unmetered ?? supporter
    const isRefinement = opts.isRefinement ?? false
    const decision = decideCredit({
      state: store.state(hash),
      isSupporter: unmetered,
      isRefinement,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    expect(decision.allowed).toBe(true)
    const atKickoff = computeKickoffCredits({
      decision,
      record: store.state(hash).record,
      isSupporter: supporter,
      unmetered,
      freeCredits: FREE,
      maxRefinements: MAXREF,
    })
    const { state: next, remaining } = computeCommit({
      decision,
      state: store.state(hash),
      isSupporter: unmetered,
      freeCredits: FREE,
    })
    store.apply(hash, next)
    const refinements = refinementUsage(store.state(hash).record, MAXREF)
    const atDone = {
      remaining,
      limit: unmetered ? null : FREE,
      isSupporter: supporter,
      refinements,
    }
    return { atKickoff, atDone }
  }

  it('matches the done snapshot for a new import', () => {
    const store = new MeterStore()
    const { atKickoff, atDone } = gateThenSettle(store, 'hash-new')
    expect(atKickoff).toEqual({
      remaining: 4,
      limit: 5,
      isSupporter: false,
      refinements: { remaining: 5, limit: 5 },
    })
    expect(atKickoff).toEqual(atDone)
  })

  it('folds in the pending refinement so it matches the done snapshot', () => {
    const store = new MeterStore()
    consume(store, 'hash-x') // original import
    const { atKickoff, atDone } = gateThenSettle(store, 'hash-x', {
      isRefinement: true,
    })
    // The credit isn't re-spent (4 left), and the refinement allowance already
    // reflects this in-flight one (4 left, not the pre-charge 5).
    expect(atKickoff).toEqual({
      remaining: 4,
      limit: 5,
      isSupporter: false,
      refinements: { remaining: 4, limit: 5 },
    })
    expect(atKickoff).toEqual(atDone)
  })

  it('leaves the refinement count untouched for a free replay', () => {
    const store = new MeterStore()
    consume(store, 'hash-x')
    const { atKickoff, atDone } = gateThenSettle(store, 'hash-x')
    expect(atKickoff.refinements).toEqual({ remaining: 5, limit: 5 })
    expect(atKickoff).toEqual(atDone)
  })

  it('reports unlimited for a real supporter', () => {
    const store = new MeterStore()
    const { atKickoff, atDone } = gateThenSettle(store, 'hash-s', {
      supporter: true,
    })
    expect(atKickoff).toEqual({
      remaining: null,
      limit: null,
      isSupporter: true,
      refinements: { remaining: 5, limit: 5 },
    })
    expect(atKickoff).toEqual(atDone)
  })

  it('keeps isSupporter false for an unmetered dev bypass', () => {
    const store = new MeterStore()
    const { atKickoff, atDone } = gateThenSettle(store, 'hash-d', {
      supporter: false,
      unmetered: true,
    })
    expect(atKickoff).toEqual({
      remaining: null,
      limit: null,
      isSupporter: false,
      refinements: { remaining: 5, limit: 5 },
    })
    expect(atKickoff).toEqual(atDone)
  })
})
