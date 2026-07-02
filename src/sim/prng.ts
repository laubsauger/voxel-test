/**
 * Deterministic PRNG (mulberry32). Only randomness source allowed in sim (V2).
 * State is a single u32 — serializable, hashable.
 */
export class Prng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  get state(): number {
    return this.s
  }

  set state(v: number) {
    this.s = v >>> 0
  }

  nextU32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  /** [0, 1) */
  next(): number {
    return this.nextU32() / 4294967296
  }

  /** integer in [0, n) */
  nextInt(n: number): number {
    return this.nextU32() % n
  }
}
