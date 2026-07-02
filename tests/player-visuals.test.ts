import { describe, expect, it } from 'vitest'
import { InstancedMesh } from 'three/webgpu'
import { MAT_FLESH } from '../src/sim/materials'
import { SEGMENT_DEFS, type PlayerEntity, type PlayerSegment } from '../src/sim/player'
import {
  COLOR_BELT,
  COLOR_EYE,
  COLOR_HAIR,
  COLOR_PANTS,
  COLOR_SHIRT,
  COLOR_SHOES,
  COLOR_SKIN,
  PlayerMesh,
  segmentVoxelColor,
} from '../src/render/player-mesh'

// T46/T49 — render-side visuals over the sim damage authority (V6).
// Color zones are render constants; sim grids stay MAT_FLESH. Damage must
// stay visible: an instance exists iff the sim grid voxel is alive.

function makeSegments(): PlayerSegment[] {
  return SEGMENT_DEFS.map((def) => {
    const vol = def.sx * def.sy * def.sz
    return { def, grid: new Uint8Array(vol).fill(MAT_FLESH), count: vol, initial: vol, version: 0 }
  })
}

/** minimal fake entity — PlayerMesh only reads the fields below (V6) */
function fakePlayer(): PlayerEntity {
  return {
    id: 1,
    playerId: 1,
    px: 10,
    py: 5,
    pz: 10,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    input: 0,
    segments: makeSegments(),
    flags: 0,
    crouching: false,
    noclip: false,
  } as unknown as PlayerEntity
}

function instanceCount(mesh: PlayerMesh): number {
  let n = 0
  mesh.group.traverse((o) => {
    if (o instanceof InstancedMesh) n += o.count
  })
  return n
}

describe('damage-visibility mapping (T46, V6)', () => {
  it('renders exactly one instance per live sim voxel', () => {
    const p = fakePlayer()
    const mesh = new PlayerMesh(p)
    mesh.update(p, 1 / 60)
    const total = p.segments.reduce((s, seg) => s + seg.count, 0)
    expect(instanceCount(mesh)).toBe(total)
  })

  it('voxels destroyed in the sim disappear from the render body', () => {
    const p = fakePlayer()
    const mesh = new PlayerMesh(p)
    mesh.update(p, 1 / 60)
    const before = instanceCount(mesh)
    // sim-side damage: zero 5 head voxels, bump version (the render trigger)
    const head = p.segments[0]
    for (let i = 0; i < 5; i++) head.grid[i] = 0
    head.count -= 5
    head.version++
    mesh.update(p, 1 / 60)
    expect(instanceCount(mesh)).toBe(before - 5)
  })

  it('does not rebuild when versions are unchanged (render reads only versions)', () => {
    const p = fakePlayer()
    const mesh = new PlayerMesh(p)
    mesh.update(p, 1 / 60)
    // tamper with the grid WITHOUT bumping version: count must not change,
    // proving rebuilds are version-driven (cheap per-frame path)
    p.segments[0].grid[0] = 0
    mesh.update(p, 1 / 60)
    const total = p.segments.reduce((s, seg) => s + seg.initial, 0)
    expect(instanceCount(mesh)).toBe(total)
  })
})

describe('color zones (T46 — render-side constants, sim stays MAT_FLESH)', () => {
  const def = (name: string) => SEGMENT_DEFS.find((d) => d.name === name)!

  it('head: hair crown, exactly two eyes on the front face, skin elsewhere', () => {
    const d = def('head')
    expect(segmentVoxelColor('head', 1, d.sy - 1, 0, d)).toBe(COLOR_HAIR)
    expect(segmentVoxelColor('head', 1, d.sy - 1, d.sz - 1, d)).toBe(COLOR_HAIR)
    let eyes = 0
    for (let y = 0; y < d.sy; y++)
      for (let z = 0; z < d.sz; z++)
        for (let x = 0; x < d.sx; x++) {
          if (segmentVoxelColor('head', x, y, z, d) === COLOR_EYE) {
            eyes++
            expect(z).toBe(0) // eyes only on the front face (-z)
          }
        }
    expect(eyes).toBe(2)
    expect(segmentVoxelColor('head', 1, 1, 0, d)).toBe(COLOR_SKIN)
  })

  it('torso: shirt with a belt row at the hips', () => {
    const d = def('torso')
    expect(segmentVoxelColor('torso', 2, 0, 1, d)).toBe(COLOR_BELT)
    expect(segmentVoxelColor('torso', 2, 4, 1, d)).toBe(COLOR_SHIRT)
  })

  it('arms: short sleeves — shirt above, skin hands/forearms below', () => {
    const d = def('armL')
    expect(segmentVoxelColor('armL', 0, d.sy - 1, 0, d)).toBe(COLOR_SHIRT)
    expect(segmentVoxelColor('armL', 0, 0, 0, d)).toBe(COLOR_SKIN)
    expect(segmentVoxelColor('armR', 1, 1, 1, d)).toBe(COLOR_SKIN)
  })

  it('legs: pants with shoes at the feet', () => {
    const d = def('legL')
    expect(segmentVoxelColor('legL', 0, 0, 0, d)).toBe(COLOR_SHOES)
    expect(segmentVoxelColor('legL', 0, 1, 0, d)).toBe(COLOR_SHOES)
    expect(segmentVoxelColor('legR', 0, 3, 0, d)).toBe(COLOR_PANTS)
  })
})
