import { describe, expect, it } from 'vitest'
import { bootUrl, DEFAULT_SEED, parseBootParams } from '../src/ui/boot-params'

// T31 — I.boot routing is a pure function of the URL search string.

describe('parseBootParams (I.boot)', () => {
  it('defaults to menu mode with the fixed smoke seed', () => {
    expect(parseBootParams('')).toEqual({ mode: 'menu', seed: DEFAULT_SEED, dev: false })
  })

  it('?boot=game&seed=N routes straight into gameplay (CDP smoke path)', () => {
    expect(parseBootParams('?boot=game&seed=1337')).toEqual({ mode: 'game', seed: 1337, dev: false })
  })

  it('?dev=1 enables the profiling overlay flag', () => {
    expect(parseBootParams('?dev=1').dev).toBe(true)
    expect(parseBootParams('?dev=0').dev).toBe(false)
  })

  it('coerces seed to uint32 and survives garbage', () => {
    expect(parseBootParams('?seed=abc').seed).toBe(DEFAULT_SEED)
    expect(parseBootParams('?seed=-1').seed).toBe(0xffffffff)
    expect(parseBootParams('?boot=nonsense').mode).toBe('menu')
  })

  it('bootUrl round-trips through parseBootParams', () => {
    const cfg = { mode: 'game' as const, seed: 42, dev: true }
    const url = bootUrl('http://localhost:5173', cfg)
    expect(parseBootParams(new URL(url).search)).toEqual(cfg)
  })
})
