/**
 * T34 — I.settings: typed settings store, localStorage-persisted.
 *
 * Contract (read by other tracks, e.g. audio):
 *   each leaf persists under localStorage key `settings.<group>.<field>`
 *   as JSON — numbers are plain (`"80"`), booleans `"true"`, strings quoted.
 *   Audio volumes: settings.audio.master | settings.audio.music |
 *   settings.audio.sfx — integers 0..100.
 *
 * Render/UI layer only (V6): settings never touch sim state.
 * Migration-safe: unknown persisted keys are ignored; unparseable or
 * wrong-typed values fall back to defaults.
 */

export interface Settings {
  graphics: {
    /** quality preset → pixelRatio cap / bloom / shadow map size */
    quality: 'low' | 'medium' | 'high'
    /** vertical fov, degrees */
    fov: number
  }
  /**
   * Advanced per-pass graphics dials (pipeline isolation/debugging).
   * Defaults reproduce the quality-preset visuals EXACTLY. Booleans AND with
   * the preset: they can disable a pass the preset enables, never force one
   * on. Live-applied by WorldRenderer via its window.__bbGfx handle (the
   * panel forwards gfx.* writes there); `textures` applies on next boot.
   */
  gfx: {
    /** sun/moon CSM shadows */
    shadows: boolean
    /** CSM shadow map resolution; 'auto' = leave the preset's map alone */
    shadowMapSize: 'auto' | '1024' | '2048' | '4096'
    /** CSM cascade count (current default 1, see T94) */
    cascades: '1' | '2' | '3'
    /** GTAO pass */
    ao: boolean
    /** GTAO blend strength, % of the stock 0.85 blend (0..200, ≥118 = full) */
    aoIntensity: number
    /** GTAO sample radius, % of the stock 0.55 m (25..200) */
    aoRadius: number
    bloom: boolean
    /** P27 final FXAA pass */
    fxaa: boolean
    clouds: boolean
    /** render resolution, % of the preset pixel-ratio cap (50..200) */
    renderScale: number
    /** T29 PBR texture arrays — material is baked, applies on next boot */
    textures: boolean
  }
  audio: {
    master: number
    music: number
    sfx: number
    /** T52 — mute gates the master bus; master keeps its value for restore */
    muted: boolean
  }
  controls: {
    /** mouse sensitivity multiplier */
    sensitivity: number
    invertY: boolean
  }
  gameplay: {
    /** default camera on spawn */
    camera: 'fp' | 'tp'
  }
  dev: {
    /** profiling overlay (stats-gl + renderer.info) */
    profiling: boolean
    /** T65 — fixed time of day 0-24h; -1 = live tick-driven cycle */
    timeOfDay: number
    /** T65 — day-cycle speed multiplier (1 = 20min/day) */
    cycleSpeed: number
  }
}

export const DEFAULT_SETTINGS: Settings = {
  graphics: { quality: 'high', fov: 75 },
  gfx: {
    shadows: true,
    shadowMapSize: 'auto',
    cascades: '1',
    ao: true,
    aoIntensity: 100,
    aoRadius: 100,
    bloom: true,
    fxaa: true,
    clouds: true,
    renderScale: 100,
    textures: true,
  },
  audio: { master: 80, music: 60, sfx: 80, muted: false },
  controls: { sensitivity: 1.0, invertY: false },
  gameplay: { camera: 'fp' },
  dev: { profiling: false, timeOfDay: -1, cycleSpeed: 1 },
}

export type SettingsPath = {
  [G in keyof Settings]: `${G & string}.${keyof Settings[G] & string}`
}[keyof Settings]

type PathValue<P extends SettingsPath> = P extends `${infer G}.${infer F}`
  ? G extends keyof Settings
    ? F extends keyof Settings[G]
      ? Settings[G][F]
      : never
    : never
  : never

const PREFIX = 'settings.'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function allPaths(): SettingsPath[] {
  const out: string[] = []
  for (const g of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    for (const f of Object.keys(DEFAULT_SETTINGS[g])) out.push(`${g}.${f}`)
  }
  return out as SettingsPath[]
}

export class SettingsStore {
  private readonly values = new Map<SettingsPath, unknown>()
  private readonly subs = new Map<SettingsPath | '*', Set<(path: SettingsPath, value: unknown) => void>>()
  private readonly storage: StorageLike | null

  constructor(storage?: StorageLike | null) {
    this.storage =
      storage !== undefined
        ? storage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null
    for (const path of allPaths()) {
      this.values.set(path, this.load(path))
    }
  }

  /** default + persisted-value load; bad/missing data → default (migration-safe) */
  private load(path: SettingsPath): unknown {
    const def = this.defaultOf(path)
    if (!this.storage) return def
    const raw = this.storage.getItem(PREFIX + path)
    if (raw === null) return def
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== typeof def) return def
      return parsed
    } catch {
      return def
    }
  }

  private defaultOf(path: SettingsPath): unknown {
    const [g, f] = path.split('.') as [keyof Settings, string]
    return (DEFAULT_SETTINGS[g] as Record<string, unknown>)[f]
  }

  get<P extends SettingsPath>(path: P): PathValue<P> {
    return this.values.get(path) as PathValue<P>
  }

  set<P extends SettingsPath>(path: P, value: PathValue<P>): void {
    if (this.values.get(path) === value) return
    this.values.set(path, value)
    this.storage?.setItem(PREFIX + path, JSON.stringify(value))
    for (const fn of this.subs.get(path) ?? []) fn(path, value)
    for (const fn of this.subs.get('*') ?? []) fn(path, value)
  }

  /** subscribe to one path or '*' for all; returns unsubscribe */
  subscribe(path: SettingsPath | '*', fn: (path: SettingsPath, value: unknown) => void): () => void {
    let set = this.subs.get(path)
    if (!set) {
      set = new Set()
      this.subs.set(path, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }
}
