import { describe, expect, it } from 'vitest'
import { decideAcquire } from './cap'

describe('decideAcquire', () => {
  it('grants a new import while under the cap', () => {
    expect(decideAcquire(0, false, 2)).toBe(true)
    expect(decideAcquire(1, false, 2)).toBe(true)
  })

  it('denies a new import at or over the cap', () => {
    expect(decideAcquire(2, false, 2)).toBe(false)
    expect(decideAcquire(5, false, 2)).toBe(false)
  })

  it('is idempotent: an already-held id is always granted, even at cap', () => {
    expect(decideAcquire(2, true, 2)).toBe(true)
    expect(decideAcquire(5, true, 2)).toBe(true)
  })
})
