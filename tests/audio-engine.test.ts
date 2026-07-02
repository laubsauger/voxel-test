import { describe, expect, it } from 'vitest'
import {
  AudioEngine,
  VOLUME_STORAGE_KEYS,
  volumeToGain,
  type AudioContextLike,
  type BufferSourceLike,
  type GainNodeLike,
  type PannerNodeLike,
  type StorageLike,
} from '../src/audio/engine'
import type { AudioManifest } from '../src/audio/manifest-types'

// ---------------------------------------------------------------------------
// mocks — no real AudioContext in tests (I.audio test requirement)
// ---------------------------------------------------------------------------
class MockParam {
  value = 1
  events: Array<[string, number, number]> = []
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t])
    this.value = v
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['ramp', v, t])
    this.value = v
  }
  cancelScheduledValues(t: number) {
    this.events.push(['cancel', 0, t])
  }
}

class MockGain implements GainNodeLike {
  gain = new MockParam()
  connectedTo: unknown[] = []
  connect(d: unknown) {
    this.connectedTo.push(d)
  }
  disconnect() {}
}

class MockSource implements BufferSourceLike {
  buffer: unknown = null
  loop = false
  onended: (() => void) | null = null
  started = false
  stoppedAt: number | null = null
  connectedTo: unknown[] = []
  connect(d: unknown) {
    this.connectedTo.push(d)
  }
  disconnect() {}
  start() {
    this.started = true
  }
  stop(when = 0) {
    this.stoppedAt = when
  }
}

class MockPanner implements PannerNodeLike {
  panningModel = ''
  distanceModel = ''
  refDistance = 1
  maxDistance = 10000
  rolloffFactor = 1
  positionX = new MockParam()
  positionY = new MockParam()
  positionZ = new MockParam()
  connectedTo: unknown[] = []
  connect(d: unknown) {
    this.connectedTo.push(d)
  }
  disconnect() {}
}

class MockContext implements AudioContextLike {
  currentTime = 0
  destination = { isDestination: true }
  listener = {
    positionX: new MockParam(),
    positionY: new MockParam(),
    positionZ: new MockParam(),
    forwardX: new MockParam(),
    forwardY: new MockParam(),
    forwardZ: new MockParam(),
    upX: new MockParam(),
    upY: new MockParam(),
    upZ: new MockParam(),
  }
  resumed = false
  gains: MockGain[] = []
  sources: MockSource[] = []
  panners: MockPanner[] = []
  async resume() {
    this.resumed = true
  }
  createGain() {
    const g = new MockGain()
    this.gains.push(g)
    return g
  }
  createBufferSource() {
    const s = new MockSource()
    this.sources.push(s)
    return s
  }
  createPanner() {
    const p = new MockPanner()
    this.panners.push(p)
    return p
  }
  async decodeAudioData(data: ArrayBuffer) {
    return { decoded: true, bytes: data.byteLength }
  }
}

class MockStorage implements StorageLike {
  map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
}

const mockFetch = async (_url: string) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(16),
})

function sound(id: string, group: string, extra: Partial<AudioManifest['sounds'][0]> = {}) {
  return {
    id,
    path: `/audio/sfx/test/${id}.mp3`,
    category: 'impact' as const,
    loop: false,
    volume: 0.8,
    positional: true,
    roundRobin: group,
    ...extra,
  }
}

const MANIFEST: AudioManifest = {
  version: 1,
  sounds: [
    sound('impact-wood-1', 'impact-wood'),
    sound('impact-wood-2', 'impact-wood'),
    sound('impact-wood-3', 'impact-wood'),
    sound('ui-click-1', 'ui-click-1', { category: 'ui', positional: false, volume: 0.5 }),
    sound('music-menu', 'music-menu', { category: 'music', loop: true, positional: false, volume: 0.6, path: '/audio/music/music-menu.mp3' }),
    sound('music-game-ambient', 'music-game-ambient', { category: 'music', loop: true, positional: false, volume: 0.5, path: '/audio/music/music-game-ambient.mp3' }),
  ],
}

function makeEngine() {
  const ctx = new MockContext()
  const storage = new MockStorage()
  const engine = new AudioEngine({ storage, createContext: () => ctx, fetchFn: mockFetch })
  return { ctx, storage, engine }
}

// ---------------------------------------------------------------------------
describe('AudioEngine volume buses (I.settings contract)', () => {
  it('persists volumes to settings.audio.* keys so the settings store and reloads see them', () => {
    const { engine, storage } = makeEngine()
    engine.setVolume('master', 0.5)
    engine.setVolume('music', 0.25)
    engine.setVolume('sfx', 1)
    expect(storage.getItem(VOLUME_STORAGE_KEYS.master)).toBe('0.5')
    expect(storage.getItem(VOLUME_STORAGE_KEYS.music)).toBe('0.25')
    expect(storage.getItem(VOLUME_STORAGE_KEYS.sfx)).toBe('1')
    expect(engine.getVolume('master')).toBe(0.5)
  })

  it('restores persisted volumes on construction (settings survive a reload)', () => {
    const storage = new MockStorage()
    storage.setItem(VOLUME_STORAGE_KEYS.master, '0.3')
    const engine = new AudioEngine({ storage, createContext: () => new MockContext(), fetchFn: mockFetch })
    expect(engine.getVolume('master')).toBe(0.3)
  })

  it('clamps out-of-range values — a corrupt slider can never blow out ears or go negative', () => {
    const { engine } = makeEngine()
    engine.setVolume('master', 2)
    expect(engine.getVolume('master')).toBe(1)
    engine.setVolume('master', -0.5)
    expect(engine.getVolume('master')).toBe(0)
  })

  it('applies the perceptual v² curve to the gain nodes after unlock', () => {
    const { engine, ctx } = makeEngine()
    engine.setVolume('master', 0.5)
    engine.unlock()
    // graph: masterGain is the first created gain, connected to destination
    const master = ctx.gains[0]
    expect(master.connectedTo).toContain(ctx.destination)
    expect(master.gain.value).toBeCloseTo(volumeToGain(0.5))
    // live change after unlock also applies
    engine.setVolume('master', 1)
    expect(master.gain.value).toBe(1)
  })

  it('builds master→{music,sfx} bus graph and resumes the context on unlock (gesture)', () => {
    const { engine, ctx } = makeEngine()
    engine.unlock()
    const [master, music, sfx] = ctx.gains
    expect(music.connectedTo).toContain(master)
    expect(sfx.connectedTo).toContain(master)
    expect(ctx.resumed).toBe(true)
    engine.unlock() // idempotent — second gesture must not rebuild the graph
    expect(ctx.gains).toHaveLength(3)
  })
})

describe('AudioEngine round-robin (variation cycling)', () => {
  it('cycles group members in order so repeated events never sound machine-gun identical', async () => {
    const { engine } = makeEngine()
    await engine.loadManifest(MANIFEST)
    const picks = [1, 2, 3, 4].map(() => engine.resolve('impact-wood').id)
    expect(picks).toEqual(['impact-wood-1', 'impact-wood-2', 'impact-wood-3', 'impact-wood-1'])
  })

  it('resolves singleton ids directly and fails loud on unknown names (V10)', async () => {
    const { engine } = makeEngine()
    await engine.loadManifest(MANIFEST)
    expect(engine.resolve('ui-click-1').id).toBe('ui-click-1')
    expect(() => engine.resolve('no-such-sound')).toThrow(/unknown sound/)
  })
})

describe('AudioEngine playback', () => {
  it('returns null before unlock — audio must never block or crash gameplay', async () => {
    const { engine } = makeEngine()
    await engine.loadManifest(MANIFEST)
    expect(await engine.play('ui-click-1')).toBeNull()
  })

  it('positional play routes through a panner at the world position, non-positional does not', async () => {
    const { engine, ctx } = makeEngine()
    await engine.loadManifest(MANIFEST)
    engine.unlock()
    await engine.play('impact-wood', { position: { x: 3, y: 4, z: 5 }, refDistance: 2, maxDistance: 60 })
    expect(ctx.panners).toHaveLength(1)
    expect(ctx.panners[0].positionX.value).toBe(3)
    expect(ctx.panners[0].positionY.value).toBe(4)
    expect(ctx.panners[0].positionZ.value).toBe(5)
    expect(ctx.panners[0].maxDistance).toBe(60)
    await engine.play('ui-click-1')
    expect(ctx.panners).toHaveLength(1) // ui stays 2D
  })

  it('applies manifest volume trim × play volume to the per-instance gain', async () => {
    const { engine, ctx } = makeEngine()
    await engine.loadManifest(MANIFEST)
    engine.unlock()
    const handle = await engine.play('ui-click-1', { volume: 0.5 })
    expect(handle).not.toBeNull()
    expect(handle!.gain.gain.value).toBeCloseTo(0.5 * 0.5) // trim 0.5 × opt 0.5
    expect((handle!.source as MockSource).started).toBe(true)
  })

  it('music crossfade: new track ramps in on the music bus, old track fades out and stops', async () => {
    const { engine, ctx } = makeEngine()
    await engine.loadManifest(MANIFEST)
    engine.unlock()
    const musicBus = ctx.gains[1]
    const a = await engine.playMusic('music-menu', 2)
    expect(a).not.toBeNull()
    expect((a!.gain as MockGain).connectedTo).toContain(musicBus)
    expect((a!.source as MockSource).loop).toBe(true)
    const b = await engine.playMusic('music-game-ambient', 2)
    // old track: gain ramped to 0 and source stop scheduled at +fade
    const aGain = a!.gain.gain as MockParam
    expect(aGain.events.some(([kind, v]) => kind === 'ramp' && v === 0)).toBe(true)
    expect((a!.source as MockSource).stoppedAt).toBe(2)
    // new track ramps from 0 up to its trim
    const bGain = b!.gain.gain as MockParam
    expect(bGain.events[0]).toEqual(['set', 0, 0])
    expect(bGain.events.some(([kind, v]) => kind === 'ramp' && v === 0.5)).toBe(true)
  })

  it('syncs the listener from camera pose', async () => {
    const { engine, ctx } = makeEngine()
    engine.unlock()
    engine.setListener(1, 2, 3, 0, 0, -1, 0, 1, 0)
    expect(ctx.listener.positionX.value).toBe(1)
    expect(ctx.listener.positionZ.value).toBe(3)
    expect(ctx.listener.forwardZ.value).toBe(-1)
    expect(ctx.listener.upY.value).toBe(1)
  })
})
