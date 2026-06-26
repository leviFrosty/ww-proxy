import { describe, expect, it } from 'vitest'
import {
  checkCredit,
  recordUsage,
  refinementUsageFor,
  type KvLike,
} from './credits'
import { makeMemoryKv } from './test/memoryKv'

const FREE = 5
const MAXREF = 5

/** Gate + (on success) record, mirroring the route's order. */
const consume = async (
  kv: KvLike,
  uuid: string,
  hash: string,
  opts: { isSupporter?: boolean; isRefinement?: boolean } = {}
) => {
  const isSupporter = opts.isSupporter ?? false
  const isRefinement = opts.isRefinement ?? false
  const decision = await checkCredit({
    kv,
    uuid,
    hash,
    isSupporter,
    isRefinement,
    freeCredits: FREE,
    maxRefinements: MAXREF,
  })
  if (!decision.allowed) return decision
  const remaining = await recordUsage({
    kv,
    uuid,
    hash,
    isSupporter,
    decision,
    freeCredits: FREE,
  })
  return { ...decision, remaining }
}

describe('credit metering — non-supporter', () => {
  it('allows exactly 5 distinct imports then blocks the 6th', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    const remainings: (number | null)[] = []
    for (let i = 0; i < 5; i++) {
      const r = await consume(kv, 'u1', `hash-${i}`)
      expect(r.allowed).toBe(true)
      remainings.push(r.remaining ?? null)
    }
    expect(remainings).toEqual([4, 3, 2, 1, 0])

    const sixth = await consume(kv, 'u1', 'hash-5')
    expect(sixth.allowed).toBe(false)
    expect(sixth.reason).toBe('limit_reached')
  })

  it('replays a charged hash for free even after the limit is hit', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    for (let i = 0; i < 5; i++) await consume(kv, 'u1', `hash-${i}`)
    // Already at the cap; replaying an existing hash is still allowed + free.
    const replay = await consume(kv, 'u1', 'hash-0')
    expect(replay.allowed).toBe(true)
    expect(replay.isNewHash).toBe(false)
  })

  it('isolates counts per identity', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    for (let i = 0; i < 5; i++) await consume(kv, 'u1', `h-${i}`)
    const other = await consume(kv, 'u2', 'h-0')
    expect(other.allowed).toBe(true)
  })
})

describe('credit metering — refinements', () => {
  it('treats follow-up refinements as free but caps them', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    await consume(kv, 'u1', 'hash-x') // original import, costs 1 credit
    for (let i = 0; i < MAXREF; i++) {
      const r = await consume(kv, 'u1', 'hash-x', { isRefinement: true })
      expect(r.allowed).toBe(true)
      expect(r.isRefinement).toBe(true)
    }
    const overflow = await consume(kv, 'u1', 'hash-x', { isRefinement: true })
    expect(overflow.allowed).toBe(false)
    expect(overflow.reason).toBe('refinement_limit')
  })

  it('does not spend a credit on any refinement', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    await consume(kv, 'u1', 'hash-x')
    await consume(kv, 'u1', 'hash-x', { isRefinement: true })
    // Four more distinct originals should still be allowed (only 1 spent).
    for (let i = 0; i < 4; i++) {
      expect((await consume(kv, 'u1', `other-${i}`)).allowed).toBe(true)
    }
    expect((await consume(kv, 'u1', 'one-too-many')).allowed).toBe(false)
  })

  it('reports the authoritative refinement allowance for a source hash', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    await consume(kv, 'u1', 'hash-x')
    expect(await refinementUsageFor(kv, 'u1', 'hash-x', MAXREF)).toEqual({
      remaining: 5,
      limit: 5,
    })

    await consume(kv, 'u1', 'hash-x', { isRefinement: true })
    await consume(kv, 'u1', 'hash-x', { isRefinement: true })
    expect(await refinementUsageFor(kv, 'u1', 'hash-x', MAXREF)).toEqual({
      remaining: 3,
      limit: 5,
    })
  })
})

describe('credit metering — supporter', () => {
  it('never blocks and reports unlimited (null) remaining', async () => {
    const kv = makeMemoryKv() as unknown as KvLike
    for (let i = 0; i < 12; i++) {
      const r = await consume(kv, 'sup', `hash-${i}`, { isSupporter: true })
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBeNull()
    }
  })
})
