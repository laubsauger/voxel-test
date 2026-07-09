import { describe, expect, it } from 'vitest'
import {
  GameAudio,
  RUN_SPEED_THRESHOLD,
  WALK_STRIDE,
  explosionGroup,
  footstepSurface,
  impactGroup,
  type PlayerAudioState,
} from '../src/audio/game-audio'
import { MATERIALS } from '../src/sim/materials'
import { VOXEL_SIZE } from '../src/world/chunks'

// ---------------------------------------------------------------------------
// surface / impact maps — exhaustive over the I.mat authority table (V13):
// every material id a voxel can hold must map somewhere deliberate, so a new
// material can never silently produce wrong-footed audio.
// ---------------------------------------------------------------------------
describe('material id → footstep surface', () => {
  const expected: Record<string, ReturnType<typeof footstepSurface>> = {
    air: null,
    dirt: 'dirt',
    grass: 'grass',
    asphalt: 'asphalt',
    concrete: 'concrete',
    brick: 'concrete',
    wood: 'wood',
    plaster: 'concrete',
    glass: 'concrete',
    metal: 'concrete',
    'water-solid': 'water',
    leaves: 'grass',
    rooftile: 'concrete',
    lamp: 'concrete',
    flesh: 'dirt',
    paint: 'asphalt',
    sand: 'dirt',
    // T99 bombay set
    'salt-crust': 'dirt',
    'playa-mud': 'dirt',
    rust: 'concrete',
    char: 'wood',
    'bone-shell': 'dirt',
    'cracked-asphalt': 'asphalt',
    'galv-metal': 'concrete',
    'opera-blue': 'wood',
    'art-red': 'wood',
    'art-yellow': 'wood',
    'art-teal': 'wood',
    'art-pink': 'wood',
  }

  it('maps every material in the sim table (exhaustive, keyed by name not index)', () => {
    for (const m of MATERIALS) {
      if (!m) continue
      expect(footstepSurface(m.id), `surface for '${m.name}' (id ${m.id})`).toBe(expected[m.name])
    }
    // and the expectation table covers everything — no silent gaps
    expect(Object.keys(expected)).toHaveLength(MATERIALS.filter(Boolean).length)
  })

  it('unknown/reserved ids fall back to a soft surface instead of crashing the render layer', () => {
    expect(footstepSurface(99)).toBe('dirt')
    expect(footstepSurface(200)).toBe('dirt')
  })
})

describe('material id → impact group', () => {
  const expected: Record<string, string | null> = {
    air: null,
    dirt: 'impact-dirt',
    grass: 'impact-grass',
    asphalt: 'impact-concrete',
    concrete: 'impact-concrete',
    brick: 'impact-brick',
    wood: 'impact-wood',
    plaster: 'impact-concrete',
    glass: 'impact-glass',
    metal: 'impact-metal',
    'water-solid': 'impact-water',
    leaves: 'impact-grass',
    rooftile: 'impact-concrete',
    lamp: 'impact-metal',
    flesh: 'impact-dirt',
    paint: 'impact-concrete',
    sand: 'impact-dirt',
    // T99 bombay set
    'salt-crust': 'impact-dirt',
    'playa-mud': 'impact-dirt',
    rust: 'impact-metal',
    char: 'impact-wood',
    'bone-shell': 'impact-dirt',
    'cracked-asphalt': 'impact-concrete',
    'galv-metal': 'impact-metal',
    'opera-blue': 'impact-wood',
    'art-red': 'impact-wood',
    'art-yellow': 'impact-wood',
    'art-teal': 'impact-wood',
    'art-pink': 'impact-wood',
  }

  it('maps every material in the sim table (exhaustive)', () => {
    for (const m of MATERIALS) {
      if (!m) continue
      expect(impactGroup(m.id), `impact for '${m.name}' (id ${m.id})`).toBe(expected[m.name])
    }
    expect(Object.keys(expected)).toHaveLength(MATERIALS.filter(Boolean).length)
  })
})

describe('explosion power → asset size', () => {
  it('scales with op power so small tool blasts and house-levelers sound different', () => {
    expect(explosionGroup(1)).toBe('explosion-small')
    expect(explosionGroup(3.9)).toBe('explosion-small')
    expect(explosionGroup(4)).toBe('explosion-medium')
    expect(explosionGroup(7.9)).toBe('explosion-medium')
    expect(explosionGroup(8)).toBe('explosion-large')
    expect(explosionGroup(20)).toBe('explosion-large')
  })
})

// ---------------------------------------------------------------------------
// footstep poller
// ---------------------------------------------------------------------------
class FakePlayer {
  calls: Array<{ name: string; opts?: unknown }> = []
  play(name: string, opts?: unknown) {
    this.calls.push({ name, opts })
    return Promise.resolve(null)
  }
  names() {
    return this.calls.map((c) => c.name)
  }
}

/** flat world: solid `mat` at vy < groundVy, air above */
function flatWorld(mat: number, groundVy = 10) {
  return { getVoxel: (_x: number, y: number, _z: number) => (y < groundVy ? mat : 0) }
}

function walker(overrides: Partial<PlayerAudioState> = {}): PlayerAudioState {
  return { px: 5, py: 1, pz: 5, vx: 2, vy: 0, vz: 0, grounded: true, ...overrides }
}

describe('GameAudio footsteps', () => {
  it('emits distance-based steps: cadence tracks speed × time (why: steps must match motion)', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2)) // grass
    // 2 m/s for 2s = 4m travelled → floor(4 / WALK_STRIDE) steps
    const frames = 120
    const p = walker({ vx: 2 })
    for (let i = 0; i < frames; i++) {
      ga.update(1 / 60, { ...p, px: p.px + (i * 2) / 60 })
    }
    const stepCount = fake.names().filter((n) => n.startsWith('footstep-')).length
    expect(stepCount).toBe(Math.floor(4 / WALK_STRIDE))
    expect(fake.names()[0]).toBe('footstep-walk-grass')
  })

  it('switches to the run set above the speed threshold', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(4)) // concrete
    const p = walker({ vx: RUN_SPEED_THRESHOLD + 1 })
    for (let i = 0; i < 60; i++) ga.update(1 / 60, p)
    const steps = fake.names().filter((n) => n.startsWith('footstep-'))
    expect(steps.length).toBeGreaterThan(0)
    for (const s of steps) expect(s).toBe('footstep-run-concrete')
  })

  it('surface comes from the voxel under the feet — crossing grass→asphalt changes the set', () => {
    const fake = new FakePlayer()
    // x < 100 voxels: grass; beyond: asphalt
    const world = { getVoxel: (x: number, y: number) => (y < 10 ? (x < 100 ? 2 : 3) : 0) }
    const ga = new GameAudio(fake, world)
    let px = 5
    for (let i = 0; i < 240; i++) {
      px += 2 / 60
      ga.update(1 / 60, walker({ px, vx: 2 }))
    }
    const steps = fake.names().filter((n) => n.startsWith('footstep-'))
    expect(steps).toContain('footstep-walk-grass')
    expect(steps).toContain('footstep-walk-asphalt')
    // grass steps strictly before asphalt steps (player walked one way)
    expect(steps.lastIndexOf('footstep-walk-grass')).toBeLessThan(steps.indexOf('footstep-walk-asphalt'))
    expect(px / VOXEL_SIZE).toBeGreaterThan(100) // sanity: we actually crossed
  })

  it('goes silent when airborne or standing still — footsteps imply ground contact', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2))
    for (let i = 0; i < 120; i++) ga.update(1 / 60, walker({ grounded: false, vy: -3 }))
    for (let i = 0; i < 120; i++) ga.update(1 / 60, walker({ vx: 0 }))
    expect(fake.names().filter((n) => n.startsWith('footstep-'))).toHaveLength(0)
  })

  it('plays a surface push-off scuff on takeoff and a landing thud on touchdown', () => {
    // takeoff reuses the clean surface footstep (the jump-takeoff samples carried
    // a tonal artifact that dinged on every jump); landing keeps its own thud.
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(4)) // concrete = hard
    ga.update(1 / 60, walker({ vx: 0 })) // grounded baseline
    ga.update(1 / 60, walker({ vx: 0, grounded: false, vy: 6 })) // jump!
    for (let i = 0; i < 30; i++) ga.update(1 / 60, walker({ vx: 0, grounded: false, vy: -2 }))
    ga.update(1 / 60, walker({ vx: 0, grounded: true })) // land
    expect(fake.names()).toEqual(['footstep-run-concrete', 'jump-land-hard'])
  })

  it('falling off a ledge (no upward velocity) plays no takeoff but still lands', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2)) // grass = soft
    ga.update(1 / 60, walker({ vx: 0 }))
    for (let i = 0; i < 30; i++) ga.update(1 / 60, walker({ vx: 0, grounded: false, vy: -4 }))
    ga.update(1 / 60, walker({ vx: 0, grounded: true }))
    expect(fake.names()).toEqual(['jump-land-soft'])
  })
})

describe('GameAudio event hooks', () => {
  it('onImpact picks the material group at the hit position, air stays silent', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2))
    ga.onImpact(3, 4, 5, 6) // wood
    ga.onImpact(3, 4, 5, 0) // air
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].name).toBe('impact-wood')
    expect((fake.calls[0].opts as { position: { x: number } }).position.x).toBe(3)
  })

  it('onExplosion layers by power: small alone, large adds debris rain + distant rumble', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2))
    ga.onExplosion(1, 2, 3, 2)
    expect(fake.names()).toEqual(['explosion-small'])
    fake.calls.length = 0
    ga.onExplosion(1, 2, 3, 10)
    expect(fake.names()).toEqual(['explosion-large', 'explosion-debris-rain', 'explosion-distant-rumble'])
  })

  it('onShoot plays shot + echo tail; onWaterSplash sizes; collapse scales by voxel count', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2))
    ga.onShoot()
    expect(fake.names()).toEqual(['shot-pistol', 'shot-echo-tail'])
    fake.calls.length = 0
    ga.onWaterSplash(0, 0, 0, 'large')
    ga.onCollapse(0, 0, 0, 1000)
    ga.onCollapse(0, 0, 0, 50)
    expect(fake.names()).toEqual(['splash-large', 'collapse-structure', 'chunk-crumble'])
  })

  it('low-health heartbeat toggles once per state change (loop, not retriggered per frame)', () => {
    const fake = new FakePlayer()
    const ga = new GameAudio(fake, flatWorld(2))
    ga.setLowHealth(true)
    ga.setLowHealth(true)
    ga.setLowHealth(true)
    expect(fake.names()).toEqual(['heartbeat-low-health-loop'])
  })
})
