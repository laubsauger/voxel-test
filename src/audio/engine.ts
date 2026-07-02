/**
 * T37 [A] — runtime audio engine (I.audio). Render layer (V6): reads sim
 * state through hooks, never writes it. Wall-clock/randomness are fine here —
 * this is presentation, not sim.
 *
 * Bus graph: source → [panner?] → itemGain → (sfxGain | musicGain) → masterGain → destination.
 * Volumes are linear 0..1 in the API/storage; the applied gain is v² (perceptual).
 * Persisted under localStorage keys 'settings.audio.{master,music,sfx}' —
 * the future I.settings store owns the same keys (see INTEGRATION-audio.md).
 *
 * The WebAudio surface is injected behind minimal structural types so unit
 * tests run in node with mocks — no real AudioContext in tests.
 */
import { validateManifest, type AudioManifest, type SoundDef } from './manifest-types'

// --- minimal structural WebAudio types (satisfied by the real API + mocks) ---
export interface AudioParamLike {
  value: number
  setValueAtTime(value: number, time: number): unknown
  linearRampToValueAtTime(value: number, time: number): unknown
  cancelScheduledValues(time: number): unknown
}

export interface AudioNodeLike {
  connect(destination: unknown): unknown
  disconnect(): void
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: unknown
  loop: boolean
  onended: (() => void) | null
  playbackRate?: AudioParamLike
  start(when?: number): void
  stop(when?: number): void
}

export interface PannerNodeLike extends AudioNodeLike {
  panningModel: string
  distanceModel: string
  refDistance: number
  maxDistance: number
  rolloffFactor: number
  positionX: AudioParamLike
  positionY: AudioParamLike
  positionZ: AudioParamLike
}

export interface ListenerLike {
  positionX?: AudioParamLike
  positionY?: AudioParamLike
  positionZ?: AudioParamLike
  forwardX?: AudioParamLike
  forwardY?: AudioParamLike
  forwardZ?: AudioParamLike
  upX?: AudioParamLike
  upY?: AudioParamLike
  upZ?: AudioParamLike
}

export interface AudioContextLike {
  currentTime: number
  destination: unknown
  listener: ListenerLike
  resume(): Promise<void>
  createGain(): GainNodeLike
  createBufferSource(): BufferSourceLike
  createPanner(): PannerNodeLike
  decodeAudioData(data: ArrayBuffer): Promise<unknown>
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

function publicAssetPath(path: string): string {
  if (!path.startsWith('/')) return path
  return `${import.meta.env.BASE_URL}${path.slice(1)}`
}

// --- volume contract ----------------------------------------------------------
export type BusName = 'master' | 'music' | 'sfx'

/** I.settings contract: the settings store reads/writes these same keys (0..1 as string) */
export const VOLUME_STORAGE_KEYS: Record<BusName, string> = {
  master: 'settings.audio.master',
  music: 'settings.audio.music',
  sfx: 'settings.audio.sfx',
}

export const VOLUME_DEFAULTS: Record<BusName, number> = { master: 1, music: 0.8, sfx: 1 }

/** perceptual curve applied to the linear 0..1 setting */
export function volumeToGain(v: number): number {
  return v * v
}

export interface PlayOptions {
  /** world position, meters — requires a positional manifest entry */
  position?: { x: number; y: number; z: number }
  /** extra gain 0..1 on top of the manifest trim (e.g. distance-derived) */
  volume?: number
  /** playback rate multiplier (pitch jitter), default 1 */
  playbackRate?: number
  /** panner tuning (positional only) */
  refDistance?: number
  maxDistance?: number
  rolloffFactor?: number
}

export interface PlayHandle {
  readonly def: SoundDef
  /** per-instance gain (crossfades, ducking) */
  readonly gain: GainNodeLike
  readonly source: BufferSourceLike
  stop(fadeSeconds?: number): void
}

export interface EngineOptions {
  storage?: StorageLike
  createContext?: () => AudioContextLike
  fetchFn?: FetchLike
}

const noopStorage: StorageLike = { getItem: () => null, setItem: () => {} }

export class AudioEngine {
  private readonly storage: StorageLike
  private readonly createContext: () => AudioContextLike
  private readonly fetchFn: FetchLike

  private ctx: AudioContextLike | null = null
  private masterGain: GainNodeLike | null = null
  private musicGain: GainNodeLike | null = null
  private sfxGain: GainNodeLike | null = null

  private manifest: AudioManifest | null = null
  private readonly byId = new Map<string, SoundDef>()
  private readonly groups = new Map<string, SoundDef[]>()
  /** plain counters — render-side round-robin, no sim state involved (V6) */
  private readonly rrCounters = new Map<string, number>()
  private readonly buffers = new Map<string, Promise<unknown>>()

  private readonly volumes: Record<BusName, number> = { ...VOLUME_DEFAULTS }
  private currentMusic: PlayHandle | null = null

  constructor(opts: EngineOptions = {}) {
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : noopStorage)
    this.createContext = opts.createContext ?? (() => new AudioContext() as unknown as AudioContextLike)
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url))
    for (const bus of ['master', 'music', 'sfx'] as const) {
      const raw = this.storage.getItem(VOLUME_STORAGE_KEYS[bus])
      if (raw !== null) {
        const v = Number(raw)
        if (Number.isFinite(v)) this.volumes[bus] = Math.min(1, Math.max(0, v))
      }
    }
  }

  // --- manifest ---------------------------------------------------------------
  async loadManifest(source: string | AudioManifest = '/audio/manifest.json'): Promise<void> {
    let data: unknown
    if (typeof source === 'string') {
      const res = await this.fetchFn(publicAssetPath(source))
      if (!res.ok) throw new Error(`audio manifest fetch failed: ${res.status} ${source}`)
      data = JSON.parse(new TextDecoder().decode(await res.arrayBuffer()))
    } else {
      data = source
    }
    const manifest = validateManifest(data)
    this.manifest = manifest
    this.byId.clear()
    this.groups.clear()
    for (const s of manifest.sounds) {
      this.byId.set(s.id, s)
      let g = this.groups.get(s.roundRobin)
      if (!g) this.groups.set(s.roundRobin, (g = []))
      g.push(s)
    }
    for (const g of this.groups.values()) g.sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  get loaded(): boolean {
    return this.manifest !== null
  }

  /**
   * id or round-robin group name → concrete SoundDef. Groups cycle through
   * their variants with a plain counter. Unknown name = loud error (V10).
   */
  resolve(name: string): SoundDef {
    const group = this.groups.get(name)
    if (group && group.length > 0) {
      const n = this.rrCounters.get(name) ?? 0
      this.rrCounters.set(name, n + 1)
      return group[n % group.length]
    }
    const def = this.byId.get(name)
    if (!def) throw new Error(`unknown sound '${name}' — not in audio manifest`)
    return def
  }

  // --- lifecycle ----------------------------------------------------------------
  /** call from a user-gesture handler; idempotent */
  unlock(): void {
    if (this.ctx) return
    const ctx = this.createContext()
    this.ctx = ctx
    this.masterGain = ctx.createGain()
    this.masterGain.connect(ctx.destination)
    this.musicGain = ctx.createGain()
    this.musicGain.connect(this.masterGain)
    this.sfxGain = ctx.createGain()
    this.sfxGain.connect(this.masterGain)
    this.applyVolume('master')
    this.applyVolume('music')
    this.applyVolume('sfx')
    void ctx.resume()
  }

  get unlocked(): boolean {
    return this.ctx !== null
  }

  // --- volume buses ----------------------------------------------------------------
  setVolume(bus: BusName, v: number): void {
    const clamped = Math.min(1, Math.max(0, v))
    this.volumes[bus] = clamped
    this.storage.setItem(VOLUME_STORAGE_KEYS[bus], String(clamped))
    this.applyVolume(bus)
  }

  getVolume(bus: BusName): number {
    return this.volumes[bus]
  }

  private busNode(bus: BusName): GainNodeLike | null {
    return bus === 'master' ? this.masterGain : bus === 'music' ? this.musicGain : this.sfxGain
  }

  private applyVolume(bus: BusName): void {
    const node = this.busNode(bus)
    if (node) node.gain.value = volumeToGain(this.volumes[bus])
  }

  // --- listener --------------------------------------------------------------------
  /** sync from the render camera each frame (world meters) */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    const l = this.ctx?.listener
    if (!l) return
    if (l.positionX) {
      l.positionX.value = px
      l.positionY!.value = py
      l.positionZ!.value = pz
      l.forwardX!.value = fx
      l.forwardY!.value = fy
      l.forwardZ!.value = fz
      l.upX!.value = ux
      l.upY!.value = uy
      l.upZ!.value = uz
    }
  }

  // --- playback --------------------------------------------------------------------
  private loadBuffer(def: SoundDef): Promise<unknown> {
    let p = this.buffers.get(def.path)
    if (!p) {
      p = (async () => {
        const res = await this.fetchFn(publicAssetPath(def.path))
        if (!res.ok) throw new Error(`audio fetch failed: ${res.status} ${def.path}`)
        const decoded = await this.ctx!.decodeAudioData(await res.arrayBuffer())
        // UI one-shots: downmix to mono — some generated assets ship with
        // skewed stereo (heard right-ear-only in menus). Center them.
        if (def.category === 'ui') return downmixToMono(decoded)
        return decoded
      })()
      // evict failed loads so a transient error can retry (still loud: play() rejects)
      p.catch(() => this.buffers.delete(def.path))
      this.buffers.set(def.path, p)
    }
    return p
  }

  /**
   * Play a sound by id or round-robin group. Returns null before unlock()
   * (audio is a nicety — gameplay never blocks on it).
   */
  async play(name: string, opts: PlayOptions = {}): Promise<PlayHandle | null> {
    const def = this.resolve(name) // throws on unknown name even when locked (catch bugs early)
    const ctx = this.ctx
    if (!ctx) return null
    const buffer = await this.loadBuffer(def)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = def.loop
    if (opts.playbackRate && source.playbackRate) source.playbackRate.value = opts.playbackRate

    const gain = ctx.createGain()
    gain.gain.value = def.volume * (opts.volume ?? 1)

    let head: AudioNodeLike = source
    if (def.positional && opts.position) {
      const panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = opts.refDistance ?? 2
      panner.maxDistance = opts.maxDistance ?? 80
      panner.rolloffFactor = opts.rolloffFactor ?? 1
      panner.positionX.value = opts.position.x
      panner.positionY.value = opts.position.y
      panner.positionZ.value = opts.position.z
      head.connect(panner)
      head = panner
    }
    head.connect(gain)
    const bus = def.category === 'music' ? this.musicGain! : this.sfxGain!
    gain.connect(bus)

    const handle: PlayHandle = {
      def,
      gain,
      source,
      stop: (fadeSeconds = 0) => {
        if (fadeSeconds > 0) {
          const t = ctx.currentTime
          gain.gain.cancelScheduledValues(t)
          gain.gain.setValueAtTime(gain.gain.value, t)
          gain.gain.linearRampToValueAtTime(0, t + fadeSeconds)
          source.stop(t + fadeSeconds)
        } else {
          source.stop()
        }
      },
    }
    source.onended = () => {
      gain.disconnect()
      source.disconnect()
    }
    source.start()
    return handle
  }

  /**
   * Music with crossfade: fades out the current track (if any) and fades the
   * new one in over `fadeSeconds`. Used for menu↔game transitions.
   */
  async playMusic(name: string, fadeSeconds = 1.5): Promise<PlayHandle | null> {
    const ctx = this.ctx
    if (!ctx) return null
    const previous = this.currentMusic
    const handle = await this.play(name)
    if (!handle) return null
    const t = ctx.currentTime
    const target = handle.gain.gain.value
    handle.gain.gain.setValueAtTime(0, t)
    handle.gain.gain.linearRampToValueAtTime(target, t + fadeSeconds)
    if (previous) previous.stop(fadeSeconds)
    this.currentMusic = handle
    return handle
  }

  stopMusic(fadeSeconds = 1.5): void {
    this.currentMusic?.stop(fadeSeconds)
    this.currentMusic = null
  }
}

/**
 * Downmix a decoded AudioBuffer to mono (average of channels). Used for UI
 * one-shots whose source assets ship with skewed stereo. Works on real
 * AudioBuffers; passes mock/mono buffers through untouched.
 */
function downmixToMono(buffer: unknown): unknown {
  const b = buffer as {
    numberOfChannels?: number
    length?: number
    sampleRate?: number
    getChannelData?: (c: number) => Float32Array
    copyToChannel?: (src: Float32Array, c: number) => void
  }
  if (!b || typeof b.getChannelData !== 'function' || (b.numberOfChannels ?? 1) < 2) return buffer
  const len = b.length!
  const mixed = new Float32Array(len)
  for (let c = 0; c < b.numberOfChannels!; c++) {
    const data = b.getChannelData(c)
    for (let i = 0; i < len; i++) mixed[i] += data[i]
  }
  const inv = 1 / b.numberOfChannels!
  for (let i = 0; i < len; i++) mixed[i] *= inv
  for (let c = 0; c < b.numberOfChannels!; c++) b.copyToChannel!(mixed, c)
  return buffer
}
