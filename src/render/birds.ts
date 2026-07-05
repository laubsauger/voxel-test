/**
 * T74 — bird flocks (render-only cosmetic, V6: the sim never sees these;
 * local PRNG is render salt only).
 *
 * A couple of small dark birds circle lazily over the town at 40–70 m. Bodies
 * and wings are compact instanced boxes; wings flap by matrix rotation, not
 * shader stretching, so distant birds keep a readable silhouette instead of
 * turning into noisy sky streaks.
 *
 * Paths: each flock orbits a center near the town at its own angular speed,
 * and the orbit RADIUS itself drifts slowly in and out. Per-bird offsets form
 * a compact shallow V in flock-local space, with tiny boid-ish wander around
 * each slot.
 *
 * Day-only: update() takes the cycle day factor (CycleState.dayF from
 * WorldRenderer's cycle — see src/render/INTEGRATION-polish.md); birds fade
 * out through dusk and the mesh is hidden entirely at night (draw skipped).
 *
 * game.ts wiring (2 lines — documented, NOT applied here; see
 * src/render/INTEGRATION-polish.md):
 *   const birds = new Birds(); this.scene.add(birds.group)          // construct
 *   birds.update(dt, __bbCycle?.state.dayF ?? 1)                    // per frame
 * (__bbCycle.state is WorldRenderer's live CycleState for this frame.)
 */
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import { uniform, vec3 } from 'three/tsl'
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ } from '../world/chunks'

/** town center (m) — flock orbits are centered near here */
const CENTER_X = (WORLD_VX / 2) * VOXEL_SIZE
const CENTER_Z = (WORLD_VZ / 2) * VOXEL_SIZE

const FLOCK_COUNT = 2
const WING_X = 0.2
const WING_Y = 0.015
const WING_Z = -0.04
const WING_SWEEP = 0.36
/** altitude band (m) the whole system must stay inside (T74: 40–70 m) */
export const ALT_MIN = 40
export const ALT_MAX = 70
/** day factor below which the mesh is hidden (draw skipped entirely) */
const HIDE_BELOW = 0.02

// ---------------------------------------------------------------------------
// pure path math — exported for unit tests (tests/birds.test.ts)
// ---------------------------------------------------------------------------

export interface FlockDef {
  centerX: number
  centerZ: number
  /** mean orbit radius (m) */
  baseRadius: number
  /** slow in/out drift amplitude (m) — the "occasional" wide-orbit breathing */
  radiusSwing: number
  /** radius drift angular speed (rad/s, very slow) */
  driftSpeed: number
  driftPhase: number
  /** orbit angular speed (rad/s, signed — some flocks circle the other way) */
  angSpeed: number
  angPhase: number
  /** altitude: base + gentle bob, tuned to stay inside ALT_MIN..ALT_MAX */
  altBase: number
  altSwing: number
  altSpeed: number
  altPhase: number
}

export interface BirdDef {
  /** static slot offset inside the flock (m) */
  ox: number
  oy: number
  oz: number
  /** wander amplitudes (m) + speeds (rad/s) + phases — three loose sines */
  wx: number
  wy: number
  wz: number
  sx: number
  sy: number
  sz: number
  px: number
  py: number
  pz: number
  /** wing animation phase/speed (rad, rad/s) */
  flapPhase?: number
  flapSpeed?: number
  /** per-bird visual scale */
  scale: number
}

/** flock orbit center at time t (pure, deterministic, writes into out) */
export function flockCenter(t: number, f: FlockDef, out: Vector3): Vector3 {
  const ang = f.angPhase + t * f.angSpeed
  const r = f.baseRadius + f.radiusSwing * Math.sin(f.driftPhase + t * f.driftSpeed)
  return out.set(
    f.centerX + Math.cos(ang) * r,
    f.altBase + f.altSwing * Math.sin(f.altPhase + t * f.altSpeed),
    f.centerZ + Math.sin(ang) * r,
  )
}

/** flock heading (yaw, rad) at time t — tangent to the orbit circle */
export function flockYaw(t: number, f: FlockDef): number {
  const ang = f.angPhase + t * f.angSpeed
  const s = Math.sign(f.angSpeed) || 1
  // velocity of (cos,sin)·r is tangent (-sin, cos)·s; geometry nose = +z,
  // so yaw = atan2(dirX, dirZ)
  return Math.atan2(-Math.sin(ang) * s, Math.cos(ang) * s)
}

/** per-bird wander offset around its flock slot (pure, writes into out) */
export function birdOffset(t: number, b: BirdDef, out: Vector3): Vector3 {
  return out.set(
    b.ox + b.wx * Math.sin(b.px + t * b.sx),
    b.oy + b.wy * Math.sin(b.py + t * b.sy),
    b.oz + b.wz * Math.sin(b.pz + t * b.sz),
  )
}

/** deterministic flock/bird layout for a seed (5–9 birds per flock) */
export function createFlocks(seed: number): { flocks: FlockDef[]; birds: BirdDef[][] } {
  const rand = mulberry(seed)
  const flocks: FlockDef[] = []
  const birds: BirdDef[][] = []
  for (let i = 0; i < FLOCK_COUNT; i++) {
    // altitude budget: base 48..62, bob ≤ 4, bird wander y ≤ 3 → 41..69,
    // always inside the 40..70 band (asserted by tests)
    const altBase = 48 + rand() * 14
    flocks.push({
      centerX: CENTER_X + (rand() * 2 - 1) * 18,
      centerZ: CENTER_Z + (rand() * 2 - 1) * 18,
      baseRadius: 46 + rand() * 18,
      radiusSwing: 12 + rand() * 8,
      driftSpeed: 0.035 + rand() * 0.02,
      driftPhase: rand() * Math.PI * 2,
      angSpeed: (0.045 + rand() * 0.035) * (rand() < 0.5 ? -1 : 1),
      angPhase: rand() * Math.PI * 2,
      altBase,
      altSwing: 2 + rand() * 2,
      altSpeed: 0.05 + rand() * 0.08,
      altPhase: rand() * Math.PI * 2,
    })
    const n = 5 + Math.floor(rand() * 3) // 5..7
    const flock: BirdDef[] = []
    for (let j = 0; j < n; j++) {
      const row = Math.ceil(j / 2)
      const side = j === 0 ? 0 : j % 2 === 0 ? 1 : -1
      flock.push({
        // compact shallow V, in flock-local space: x = wing, z = trail.
        ox: side * (1.3 + row * 1.25) + (rand() * 2 - 1) * 0.35,
        oy: (rand() * 2 - 1) * 0.7,
        oz: -row * (2.2 + rand() * 0.55) + (rand() * 2 - 1) * 0.35,
        wx: 0.35 + rand() * 0.55,
        wy: 0.2 + rand() * 0.3,
        wz: 0.35 + rand() * 0.55,
        sx: 0.18 + rand() * 0.22,
        sy: 0.25 + rand() * 0.28,
        sz: 0.18 + rand() * 0.22,
        px: rand() * Math.PI * 2,
        py: rand() * Math.PI * 2,
        pz: rand() * Math.PI * 2,
        flapPhase: rand() * Math.PI * 2,
        flapSpeed: 5.2 + rand() * 1.8,
        scale: 0.55 + rand() * 0.25,
      })
    }
    birds.push(flock)
  }
  return { flocks, birds }
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

export class Birds {
  readonly group = new Group()
  private readonly bodyMesh: InstancedMesh
  private readonly leftWingMesh: InstancedMesh
  private readonly rightWingMesh: InstancedMesh
  private readonly flocks: FlockDef[]
  private readonly birds: BirdDef[][]
  /** fades the whole layer with the cycle day factor (0 night → 1 day) */
  private readonly fade = uniform(1)
  private t: number
  // per-frame scratch — zero allocation in update()
  private readonly _center = new Vector3()
  private readonly _off = new Vector3()
  private readonly _pos = new Vector3()
  private readonly _wingPos = new Vector3()
  private readonly _wingLocal = new Vector3()
  private readonly _quat = new Quaternion()
  private readonly _partQuat = new Quaternion()
  private readonly _sweepQuat = new Quaternion()
  private readonly _flapQuat = new Quaternion()
  private readonly _scale = new Vector3()
  private readonly _mat = new Matrix4()
  private static readonly UP = new Vector3(0, 1, 0)
  private static readonly FORWARD = new Vector3(0, 0, 1)

  constructor(seed = 74) {
    const layout = createFlocks(seed)
    this.flocks = layout.flocks
    this.birds = layout.birds
    // desynchronize flock breathing from t=0 so boots don't always start
    // with every flock at the same drift point (phases already differ, this
    // just avoids the t=0 special feel in long sessions)
    this.t = 0

    const count = this.birds.reduce((n, f) => n + f.length, 0)

    const bodyGeometry = new BoxGeometry(0.1, 0.08, 0.34)
    const wingGeometry = new BoxGeometry(0.32, 0.025, 0.16)
    const material = new MeshBasicNodeMaterial()
    material.colorNode = vec3(0.055, 0.06, 0.07)
    material.transparent = true
    material.opacityNode = this.fade

    this.bodyMesh = this.makeMesh(bodyGeometry, material, count)
    this.leftWingMesh = this.makeMesh(wingGeometry, material, count)
    this.rightWingMesh = this.makeMesh(wingGeometry, material, count)
    this.group.add(this.bodyMesh, this.leftWingMesh, this.rightWingMesh)
    this.writeMatrices()
  }

  private makeMesh(geometry: BoxGeometry, material: MeshBasicNodeMaterial, count: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, count)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.frustumCulled = false // instances spread wide; skip stale-bounds pops
    return mesh
  }

  /**
   * Per-frame. `dt` = render delta seconds; `dayFactor` = CycleState.dayF
   * (0 night → 1 day). Birds fade with the day and are hidden (no draw) at
   * night.
   */
  update(dt: number, dayFactor: number): void {
    const f = Math.min(1, Math.max(0, dayFactor))
    this.fade.value = f
    const visible = f > HIDE_BELOW
    this.bodyMesh.visible = visible
    this.leftWingMesh.visible = visible
    this.rightWingMesh.visible = visible
    if (!visible) return
    this.t += dt
    this.writeMatrices()
  }

  private writeMatrices(): void {
    const t = this.t
    let i = 0
    for (let fi = 0; fi < this.flocks.length; fi++) {
      const flock = this.flocks[fi]
      flockCenter(t, flock, this._center)
      this._quat.setFromAxisAngle(Birds.UP, flockYaw(t, flock))
      for (const bird of this.birds[fi]) {
        birdOffset(t, bird, this._off)
        this._pos.copy(this._off).applyQuaternion(this._quat).add(this._center)
        this._scale.setScalar(bird.scale)
        this._mat.compose(this._pos, this._quat, this._scale)
        this.bodyMesh.setMatrixAt(i, this._mat)
        this.writeWingMatrix(this.leftWingMesh, i, bird, -1, t)
        this.writeWingMatrix(this.rightWingMesh, i, bird, 1, t)
        i++
      }
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.leftWingMesh.instanceMatrix.needsUpdate = true
    this.rightWingMesh.instanceMatrix.needsUpdate = true
  }

  private writeWingMatrix(mesh: InstancedMesh, index: number, bird: BirdDef, side: -1 | 1, t: number): void {
    const flap = Math.sin((bird.flapPhase ?? bird.px) + t * (bird.flapSpeed ?? 5.8)) * 0.24
    this._wingLocal.set(side * WING_X * bird.scale, WING_Y * bird.scale, WING_Z * bird.scale)
    this._wingPos.copy(this._wingLocal).applyQuaternion(this._quat).add(this._pos)
    this._sweepQuat.setFromAxisAngle(Birds.UP, -side * WING_SWEEP)
    this._flapQuat.setFromAxisAngle(Birds.FORWARD, -side * flap)
    this._partQuat.copy(this._quat).multiply(this._sweepQuat).multiply(this._flapQuat)
    this._mat.compose(this._wingPos, this._partQuat, this._scale)
    mesh.setMatrixAt(index, this._mat)
  }

  dispose(): void {
    this.bodyMesh.geometry.dispose()
    this.leftWingMesh.geometry.dispose()
    ;(this.bodyMesh.material as MeshBasicNodeMaterial).dispose()
    this.bodyMesh.dispose()
    this.leftWingMesh.dispose()
    this.rightWingMesh.dispose()
    this.group.clear()
  }
}

/** tiny deterministic PRNG (render-side visual salt only, never sim — V2) */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
