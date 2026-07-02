import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/ui/settings-store'

// T34 — I.settings: typed store, localStorage persistence under 'settings.*'
// keys (the cross-track contract — audio reads settings.audio.* directly),
// subscribers for live apply, migration-safe loading.

class FakeStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

describe('SettingsStore (I.settings)', () => {
  it('serves defaults when nothing is persisted', () => {
    const s = new SettingsStore(new FakeStorage())
    expect(s.get('graphics.quality')).toBe(DEFAULT_SETTINGS.graphics.quality)
    expect(s.get('audio.master')).toBe(DEFAULT_SETTINGS.audio.master)
    expect(s.get('controls.invertY')).toBe(DEFAULT_SETTINGS.controls.invertY)
  })

  it('persists under the settings.* key contract (audio track reads these)', () => {
    const storage = new FakeStorage()
    const s = new SettingsStore(storage)
    s.set('audio.master', 55)
    s.set('audio.music', 10)
    s.set('audio.sfx', 100)
    // plain JSON numbers — exactly what the audio engine will JSON.parse
    expect(storage.map.get('settings.audio.master')).toBe('55')
    expect(storage.map.get('settings.audio.music')).toBe('10')
    expect(storage.map.get('settings.audio.sfx')).toBe('100')
  })

  it('loads persisted values on construction', () => {
    const storage = new FakeStorage()
    storage.setItem('settings.graphics.quality', '"low"')
    storage.setItem('settings.controls.sensitivity', '2.5')
    const s = new SettingsStore(storage)
    expect(s.get('graphics.quality')).toBe('low')
    expect(s.get('controls.sensitivity')).toBe(2.5)
  })

  it('notifies path subscribers and wildcard subscribers on set', () => {
    const s = new SettingsStore(new FakeStorage())
    const seen: [string, unknown][] = []
    s.subscribe('graphics.fov', (p, v) => seen.push([p, v]))
    s.subscribe('*', (p, v) => seen.push([`*:${p}`, v]))
    s.set('graphics.fov', 90)
    s.set('audio.sfx', 12)
    expect(seen).toEqual([
      ['graphics.fov', 90],
      ['*:graphics.fov', 90],
      ['*:audio.sfx', 12],
    ])
  })

  it('does not notify when the value is unchanged', () => {
    const s = new SettingsStore(new FakeStorage())
    let calls = 0
    s.subscribe('audio.master', () => calls++)
    s.set('audio.master', DEFAULT_SETTINGS.audio.master)
    expect(calls).toBe(0)
  })

  it('unsubscribe stops notifications', () => {
    const s = new SettingsStore(new FakeStorage())
    let calls = 0
    const off = s.subscribe('audio.master', () => calls++)
    s.set('audio.master', 1)
    off()
    s.set('audio.master', 2)
    expect(calls).toBe(1)
  })

  it('is migration-safe: unknown keys ignored, bad values fall back to defaults', () => {
    const storage = new FakeStorage()
    storage.setItem('settings.future.someKnob', '42') // unknown group — ignored
    storage.setItem('settings.graphics.quality', 'not json {')
    storage.setItem('settings.audio.master', '"eighty"') // wrong type
    const s = new SettingsStore(storage)
    expect(s.get('graphics.quality')).toBe(DEFAULT_SETTINGS.graphics.quality)
    expect(s.get('audio.master')).toBe(DEFAULT_SETTINGS.audio.master)
  })

  it('works without any storage (SSR/tests)', () => {
    const s = new SettingsStore(null)
    s.set('graphics.fov', 100)
    expect(s.get('graphics.fov')).toBe(100)
  })
})
