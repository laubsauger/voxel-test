import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManifest, type AudioManifest } from '../src/audio/manifest-types'

// Validates the GENERATED manifest + assets on disk — this is the contract
// between the offline pipeline (scripts/audio/generate-sfx.mjs) and the
// runtime engine. If generation is incomplete or drifted, fail loud here
// rather than 404 at runtime.
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const raw = JSON.parse(readFileSync(path.join(PUBLIC, 'audio/manifest.json'), 'utf8')) as unknown

describe('generated audio manifest (I.audio)', () => {
  const manifest: AudioManifest = validateManifest(raw)
  const byGroup = new Map<string, string[]>()
  for (const s of manifest.sounds) {
    byGroup.set(s.roundRobin, [...(byGroup.get(s.roundRobin) ?? []), s.id])
  }

  it('passes schema validation (validateManifest is what the engine runs at load)', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.sounds.length).toBeGreaterThan(0)
  })

  it('every manifest path exists on disk under public/ — no runtime 404s', () => {
    for (const s of manifest.sounds) {
      const abs = path.join(PUBLIC, s.path)
      expect(existsSync(abs), `${s.id}: missing file ${s.path}`).toBe(true)
    }
  })

  it('contains the full T36 sound set (counts per category)', () => {
    const count = (cat: string) => manifest.sounds.filter((s) => s.category === cat).length
    expect(count('footsteps')).toBe(36) // walk+run × 6 surfaces × 3 variants
    expect(count('jump')).toBe(8) // takeoff/land × hard/soft × 2
    expect(count('shoot')).toBe(3)
    expect(count('impact')).toBe(16) // 8 materials × 2
    expect(count('explosion')).toBe(5)
    expect(count('destruction')).toBe(6)
    expect(count('water')).toBe(6)
    expect(count('ambience')).toBe(3)
    expect(count('ui')).toBe(5)
    expect(count('player')).toBe(4)
    expect(count('vehicle')).toBe(13) // T64 cars + T76 bicycle/scooter loops
    expect(count('music')).toBe(2) // T38: menu + in-game bed
  })

  it('every footstep surface × gait group has 3 round-robin variants', () => {
    for (const gait of ['walk', 'run']) {
      for (const surface of ['grass', 'concrete', 'asphalt', 'wood', 'dirt', 'water']) {
        const group = `footstep-${gait}-${surface}`
        expect(byGroup.get(group), group).toHaveLength(3)
      }
    }
  })

  it('groups the engine plays by name actually exist (event-map → manifest contract)', () => {
    const need = [
      'shot-pistol',
      'shot-echo-tail',
      'impact-dirt',
      'impact-grass',
      'impact-concrete',
      'impact-brick',
      'impact-wood',
      'impact-glass',
      'impact-metal',
      'impact-water',
      'explosion-small',
      'explosion-medium',
      'explosion-large',
      'explosion-debris-rain',
      'explosion-distant-rumble',
      'collapse-structure',
      'chunk-crumble',
      'glass-pane-shatter',
      'splash-small',
      'splash-large',
      'jump-takeoff-hard',
      'jump-takeoff-soft',
      'jump-land-hard',
      'jump-land-soft',
      'player-hurt',
      'player-death',
      'heartbeat-low-health-loop',
      'ambience-suburb-day',
      'ui-hover-1',
      'ui-click-1',
      'ui-back-1',
      'ui-error-1',
      'ui-hotbar-1',
      'music-menu',
      'music-game-ambient',
    ]
    for (const g of need) {
      expect(byGroup.has(g) || manifest.sounds.some((s) => s.id === g), `missing sound/group '${g}'`).toBe(true)
    }
  })

  it('loops are flagged: music, ambience bed and *-loop-* assets; one-shots are not', () => {
    for (const s of manifest.sounds) {
      const shouldLoop = s.category === 'music' || /-loop-\d+$/.test(s.id) || s.id.startsWith('ambience-suburb-day')
      expect(s.loop, `${s.id} loop flag`).toBe(shouldLoop)
    }
  })

  it('spatial sanity: world foley is positional, ui/music/player-voice is not', () => {
    for (const s of manifest.sounds) {
      if (s.category === 'ui' || s.category === 'music' || s.category === 'player') {
        expect(s.positional, `${s.id} should be 2D`).toBe(false)
      }
      if (s.category === 'footsteps' || s.category === 'impact' || s.category === 'destruction') {
        expect(s.positional, `${s.id} should be positional`).toBe(true)
      }
    }
  })

  it('assets are real audio files, not error payloads (mp3 magic, sane size)', () => {
    for (const s of manifest.sounds) {
      const buf = readFileSync(path.join(PUBLIC, s.path))
      expect(buf.length, `${s.id} too small`).toBeGreaterThan(2000)
      // mp3: ID3 tag or MPEG frame sync
      const isMp3 = buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
      expect(isMp3, `${s.id} is not an mp3`).toBe(true)
    }
  })
})
