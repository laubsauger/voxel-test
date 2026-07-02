import { describe, expect, it } from 'vitest'
import { bootUrl, DEFAULT_SEED, DEFAULT_SIGNAL_URL, parseBootParams } from '../src/ui/boot-params'

// T31 — I.boot routing is a pure function of the URL search string.

describe('parseBootParams (I.boot)', () => {
  it('defaults to menu mode with the fixed smoke seed', () => {
    expect(parseBootParams('')).toEqual({
      mode: 'menu',
      seed: DEFAULT_SEED,
      dev: false,
      signalUrl: DEFAULT_SIGNAL_URL,
    })
  })

  it('?boot=game&seed=N routes straight into gameplay (CDP smoke path)', () => {
    const cfg = parseBootParams('?boot=game&seed=1337')
    expect(cfg.mode).toBe('game')
    expect(cfg.seed).toBe(1337)
  })

  it('T71 — ?signal=ws://... overrides the signaling server (mp-e2e per-process ports)', () => {
    expect(parseBootParams('?signal=ws%3A%2F%2Flocalhost%3A9911').signalUrl).toBe('ws://localhost:9911')
    expect(parseBootParams('').signalUrl).toBe('ws://localhost:8081')
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
    const cfg = { mode: 'game' as const, seed: 42, dev: true, signalUrl: DEFAULT_SIGNAL_URL }
    const url = bootUrl('http://localhost:5173', cfg)
    expect(parseBootParams(new URL(url).search)).toEqual(cfg)
  })
})
