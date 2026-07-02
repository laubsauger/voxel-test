import { describe, expect, it } from 'vitest'
import { busVolume, wireAudioSettings } from '../src/ui/audio-wiring'
import { SettingsStore } from '../src/ui/settings-store'
import type { BusName } from '../src/audio/engine'

// T52 — mute/volume interplay contract: SettingsStore persists 0..100 ints
// (+ audio.muted flag); the engine takes linear 0..1. WHY these tests exist:
// mute must gate ONLY the master bus and must never destroy the user's
// volume settings — unmuting has to restore the exact previous mix. The
// quick-access buttons and the Audio settings tab share the same flag, so
// this logic is the single point keeping them consistent.

class FakeStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

class FakeEngine {
  readonly volumes: Partial<Record<BusName, number>> = {}
  calls = 0
  setVolume(bus: BusName, v: number): void {
    this.volumes[bus] = v
    this.calls++
  }
}

describe('busVolume (T52 mute interplay)', () => {
  const base = { master: 80, music: 60, sfx: 100, muted: false }

  it('converts the 0..100 settings contract to linear 0..1', () => {
    expect(busVolume('master', base)).toBeCloseTo(0.8)
    expect(busVolume('music', base)).toBeCloseTo(0.6)
    expect(busVolume('sfx', base)).toBeCloseTo(1)
  })

  it('mute zeroes ONLY the master bus — music/sfx keep their mix', () => {
    const muted = { ...base, muted: true }
    expect(busVolume('master', muted)).toBe(0)
    expect(busVolume('music', muted)).toBeCloseTo(0.6)
    expect(busVolume('sfx', muted)).toBeCloseTo(1)
  })

  it('unmute restores the exact previous master volume (setting untouched by mute)', () => {
    const muted = { ...base, muted: true }
    const unmuted = { ...muted, muted: false }
    expect(busVolume('master', unmuted)).toBe(busVolume('master', base))
  })

  it('clamps out-of-range persisted values (migration safety)', () => {
    expect(busVolume('master', { ...base, master: 250 })).toBe(1)
    expect(busVolume('music', { ...base, music: -20 })).toBe(0)
  })
})

describe('wireAudioSettings (sliders + mute drive gains live)', () => {
  function setup() {
    const store = new SettingsStore(new FakeStorage())
    const engine = new FakeEngine()
    const off = wireAudioSettings(store, engine)
    return { store, engine, off }
  }

  it('applies current settings to the engine immediately', () => {
    const { engine } = setup()
    // defaults: master 80, music 60, sfx 80, muted false
    expect(engine.volumes.master).toBeCloseTo(0.8)
    expect(engine.volumes.music).toBeCloseTo(0.6)
    expect(engine.volumes.sfx).toBeCloseTo(0.8)
  })

  it('slider changes reach the engine live (the B9 symptom was dead gains)', () => {
    const { store, engine } = setup()
    store.set('audio.sfx', 25)
    expect(engine.volumes.sfx).toBeCloseTo(0.25)
    store.set('audio.master', 0)
    expect(engine.volumes.master).toBe(0)
  })

  it('mute round-trip via the store flag restores the previous master gain', () => {
    const { store, engine } = setup()
    store.set('audio.master', 40)
    expect(engine.volumes.master).toBeCloseTo(0.4)
    store.set('audio.muted', true)
    expect(engine.volumes.master).toBe(0)
    expect(engine.volumes.music).toBeCloseTo(0.6) // untouched by mute
    store.set('audio.muted', false)
    expect(engine.volumes.master).toBeCloseTo(0.4) // exact restore
    // and the persisted master setting never changed while muted
    expect(store.get('audio.master')).toBe(40)
  })

  it('unsubscribe stops live application', () => {
    const { store, engine, off } = setup()
    off()
    store.set('audio.master', 10)
    expect(engine.volumes.master).toBeCloseTo(0.8) // still the initial apply
  })
})
