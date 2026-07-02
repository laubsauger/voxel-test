/**
 * T52 (B9) — glue between the settings store / UI DOM and the audio engine.
 * Render layer only (V6). The engine itself is done (T37); this module owns
 * the live volume application, the mute interplay, and UI sounds.
 *
 * Volume contract note (cross-track): SettingsStore persists
 * `settings.audio.{master,music,sfx}` as integers 0..100. The engine API
 * takes linear 0..1. The store is the SINGLE persistence authority — the
 * engine is constructed with a null storage and fed via this wiring, so the
 * two tracks never fight over the same localStorage keys with different
 * formats. Mute lives in `settings.audio.muted`; the master setting keeps
 * its value while muted, so unmuting restores the previous volume exactly.
 */
import type { BusName } from '../audio/engine'
import type { SettingsStore } from './settings-store'

export interface AudioBusSettings {
  /** 0..100 (settings-store contract) */
  master: number
  music: number
  sfx: number
  muted: boolean
}

/** what wireAudioSettings needs from AudioEngine (unit-test fakes) */
export interface VolumeSink {
  setVolume(bus: BusName, v: number): void
}

/**
 * Settings snapshot → linear 0..1 engine volume for one bus.
 * Mute gates the master bus only — music/sfx keep their values so the
 * mixer relationships survive a mute/unmute round-trip.
 */
export function busVolume(bus: BusName, s: AudioBusSettings): number {
  if (bus === 'master' && s.muted) return 0
  const raw = bus === 'master' ? s.master : bus === 'music' ? s.music : s.sfx
  return Math.min(100, Math.max(0, raw)) / 100
}

function snapshot(store: SettingsStore): AudioBusSettings {
  return {
    master: store.get('audio.master'),
    music: store.get('audio.music'),
    sfx: store.get('audio.sfx'),
    muted: store.get('audio.muted'),
  }
}

/**
 * Apply current audio settings to the engine and keep them applied live
 * (sliders + mute quick-access drive gains immediately). Returns unsubscribe.
 */
export function wireAudioSettings(store: SettingsStore, engine: VolumeSink): () => void {
  const apply = () => {
    const s = snapshot(store)
    engine.setVolume('master', busVolume('master', s))
    engine.setVolume('music', busVolume('music', s))
    engine.setVolume('sfx', busVolume('sfx', s))
  }
  apply()
  const offs = (['audio.master', 'audio.music', 'audio.sfx', 'audio.muted'] as const).map((p) =>
    store.subscribe(p, apply),
  )
  return () => offs.forEach((off) => off())
}

// --- UI sounds -----------------------------------------------------------------

/** interactive UI elements that make sound (menus, settings, quick-access) */
const CLICK_SELECTOR =
  '.bb-menu-item:not(:disabled), .bb-pause-item, .bb-set-tab, .bb-btn, .bb-toggle, .bb-seg button, .bb-icon-btn'
/** back/close-flavored controls get the 'ui-back' sound instead */
const BACK_SELECTOR = '.bb-set-close, [data-act="quit"], [data-act="resume"]'

export interface UiSoundPlayer {
  play(name: string): unknown
}

/**
 * Delegated hover/click sounds for all menu/settings controls. One listener
 * pair on the UI root — new buttons get sounds for free by class.
 */
export function attachUiSounds(root: HTMLElement, player: UiSoundPlayer): void {
  let lastHover: Element | null = null
  root.addEventListener('mouseover', (e) => {
    const el = (e.target as Element | null)?.closest(CLICK_SELECTOR) ?? null
    if (el && el !== lastHover) player.play('ui-hover')
    lastHover = el
  })
  root.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest(CLICK_SELECTOR)
    if (!el) return
    player.play(el.matches(BACK_SELECTOR) ? 'ui-back' : 'ui-click')
  })
}
