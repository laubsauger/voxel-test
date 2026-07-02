import { describe, expect, it } from 'vitest'
import { Prng } from '../src/sim/prng'

// V2: seeded PRNG is the only randomness source — must be reproducible,
// serializable, and seed-sensitive, or lockstep clients diverge.
describe('Prng (V2)', () => {
  it('same seed → identical sequence', () => {
    const a = new Prng(1234)
    const b = new Prng(1234)
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32())
  })

  it('different seed → different sequence', () => {
    const a = new Prng(1)
    const b = new Prng(2)
    const seqA = Array.from({ length: 8 }, () => a.nextU32())
    const seqB = Array.from({ length: 8 }, () => b.nextU32())
    expect(seqA).not.toEqual(seqB)
  })

  it('state round-trips (snapshot/restore for late join)', () => {
    const a = new Prng(42)
    a.nextU32()
    a.nextU32()
    const b = new Prng(0)
    b.state = a.state
    expect(b.nextU32()).toBe(a.nextU32())
  })

  it('next() stays in [0,1)', () => {
    const p = new Prng(7)
    for (let i = 0; i < 1000; i++) {
      const v = p.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
