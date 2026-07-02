/**
 * T74 — bird flocks (render-only cosmetic, V6: the sim never sees these;
 * local PRNG is render salt only).
 *
 * A few small flocks of dark voxel-ish birds circle lazily over the town at
 * 40–70 m. Each bird is 3 boxes (body + two wings) merged into ONE shared
 * geometry drawn as ONE InstancedMesh (1 draw call for every bird in the
 * sky). Wing flap runs entirely in the vertex shader (TSL: per-instance
 * phase/speed hashed off instanceIndex), so the CPU only refreshes instance
 * matrices — no per-frame allocation.
 *
 * Paths: each flock orbits a center near the town at its own angular speed,
 * and the orbit RADIUS itself drifts slowly in and out (a wide breathing
 * orbit) so flocks wander overhead for a while, then recede into the distance
 * — occasional, not constant. Per-bird offsets add gentle boid-ish wander
 * (three incommensurate sines) around the flock slot.
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
import { abs, float, hash, instanceIndex, positionLocal, sin, time, uniform, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ } from '../world/chunks'

/** town center (m) — flock orbits are centered near here */
const CENTER_X = (WORLD_VX / 2) * VOXEL_SIZE
const CENTER_Z = (WORLD_VZ / 2) * VOXEL_SIZE

const FLOCK_COUNT = 3
/** altitude band (m) the whole system must stay inside (T74: 40–70 m) */
export const ALT_MIN = 40
export const ALT_MAX = 70
/** wing geometry: flap bends everything outboard of this |x| (m) */
const WING_ROOT_X = 0.1
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
      centerX: CENTER_X + (rand() * 2 - 1) * 30,
      centerZ: CENTER_Z + (rand() * 2 - 1) * 30,
      baseRadius: 55 + rand() * 30,
      radiusSwing: 30 + rand() * 15,
      driftSpeed: 0.045 + rand() * 0.025, // full in/out breath ~2–3 min
      driftPhase: rand() * Math.PI * 2,
      angSpeed: (0.06 + rand() * 0.06) * (rand() < 0.5 ? -1 : 1),
      angPhase: rand() * Math.PI * 2,
      altBase,
      altSwing: 2 + rand() * 2,
      altSpeed: 0.05 + rand() * 0.08,
      altPhase: rand() * Math.PI * 2,
    })
    const n = 5 + Math.floor(rand() * 5) // 5..9
    const flock: BirdDef[] = []
    for (let j = 0; j < n; j++) {
      flock.push({
        // loose V-ish scatter: birds trail behind/beside the flock center
        ox: (rand() * 2 - 1) * 7,
        oy: (rand() * 2 - 1) * 2,
        oz: (rand() * 2 - 1) * 7,
        wx: 1 + rand() * 2,
        wy: 0.4 + rand() * 0.6,
        wz: 1 + rand() * 2,
        sx: 0.25 + rand() * 0.35,
        sy: 0.35 + rand() * 0.45,
        sz: 0.25 + rand() * 0.35,
        px: rand() * Math.PI * 2,
        py: rand() * Math.PI * 2,
        pz: rand() * Math.PI * 2,
        scale: 0.85 + rand() * 0.5,
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
  private readonly mesh: InstancedMesh
  private readonly flocks: FlockDef[]
  private readonly birds: BirdDef[][]
  /** fades the whole layer with the cycle day factor (0 night → 1 day) */
  private readonly fade = uniform(1)
  private t: number
  // per-frame scratch — zero allocation in update()
  private readonly _center = new Vector3()
  private readonly _off = new Vector3()
  private readonly _pos = new Vector3()
  private readonly _quat = new Quaternion()
  private readonly _scale = new Vector3()
  private readonly _mat = new Matrix4()
  private static readonly UP = new Vector3(0, 1, 0)

  constructor(seed = 74) {
    const layout = createFlocks(seed)
    this.flocks = layout.flocks
    this.birds = layout.birds
    // desynchronize flock breathing from t=0 so boots don't always start
    // with every flock at the same drift point (phases already differ, this
    // just avoids the t=0 special feel in long sessions)
    this.t = 0

    const count = this.birds.reduce((n, f) => n + f.length, 0)

    // one merged bird: body + two wing slabs; nose points +z
    const parts = [
      new BoxGeometry(0.16, 0.12, 0.52),
      new BoxGeometry(0.72, 0.03, 0.26).translate(-0.44, 0.03, -0.04),
      new BoxGeometry(0.72, 0.03, 0.26).translate(0.44, 0.03, -0.04),
    ]
    const geometry = mergeGeometries(parts)
    for (const p of parts) p.dispose()

    // dark silhouette material; wing flap in the vertex stage — hashed
    // per-instance phase + speed so the flock never flaps in lockstep
    const material = new MeshBasicNodeMaterial()
    material.colorNode = vec3(0.055, 0.06, 0.07)
    material.transparent = true
    material.opacityNode = this.fade
    const idx = instanceIndex.toFloat()
    const phase = hash(idx).mul(Math.PI * 2)
    const omega = hash(idx.add(17.7)).mul(8).add(18) // flap 18..26 rad/s
    const flap = sin(time.mul(omega).add(phase))
    const wingLift = abs(positionLocal.x).sub(WING_ROOT_X).max(0)
    material.positionNode = positionLocal.add(vec3(0, flap.mul(wingLift).mul(float(0.85)), 0))

    this.mesh = new InstancedMesh(geometry, material, count)
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = false // instances spread wide; skip stale-bounds pops
    this.group.add(this.mesh)
    this.writeMatrices()
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
    this.mesh.visible = visible
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
        this._pos.copy(this._center).add(this._off)
        this._scale.setScalar(bird.scale)
        this._mat.compose(this._pos, this._quat, this._scale)
        this.mesh.setMatrixAt(i++, this._mat)
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshBasicNodeMaterial).dispose()
    this.mesh.dispose()
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
