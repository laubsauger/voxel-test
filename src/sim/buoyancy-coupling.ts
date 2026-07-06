/**
 * T17/T40.6 — buoyancy coupling: water field → forces on floating island
 * bodies. Implements the FloatingBodyAdapter contract from
 * src/sim/water/INTEGRATION-water.md §4 as a Sim system.
 *
 * System order (registration order = execution order, decided in main.ts):
 *
 *     createPhysics(sim)        // physics system
 *     attachWaterSim(sim)       // water CA system
 *     attachBuoyancy(sim, phys, water)   // THIS — must be registered last
 *
 * i.e. per tick: physics step → water step → buoyancy. Buoyancy samples the
 * freshly stepped body transforms and water field, then accumulates
 * AddForce/AddTorque on the Jolt bodies; Jolt consumes accumulated forces in
 * the NEXT tick's step. That one-tick force latency is deliberate:
 *  - deterministic: forces are a pure function of tick-N state, applied at a
 *    fixed point in tick N+1 — identical on every peer (V2/V3).
 *  - stable: 16.7ms lag ≪ the bob period (~1s for chunk-scale debris) and the
 *    drag coefficient is far below critical damping, so the delay cannot
 *    drive oscillation.
 * (Registering water/buoyancy BEFORE physics would apply forces in the same
 * tick — also deterministic — but it would sample body transforms from the
 * previous tick anyway, and the current main.ts wiring awaits createPhysics
 * first. Same latency either way; this order needs no main.ts restructuring.)
 *
 * Only bodies whose DOMINANT material carries the Floats flag (I.mat) get
 * buoyancy — wood/leaves debris floats and bobs, concrete just sinks (no
 * reduced-weight simulation for sinkers, v1 feel tradeoff).
 *
 * Sleeping floaters are skipped (not re-activated): a settled floating body
 * freezes at the waterline exactly like a slept island on land (V12). Known
 * v1 limitation: draining the pool under a sleeping floater will not wake it
 * — the next nearby impulse/edit will.
 */
import type { Sim } from './loop'
import type Jolt from 'jolt-physics'
import { VOXEL_SIZE } from '../world/chunks'
import { MAT_FLAG_FLOATS, VOXEL_VOLUME, material } from './materials'
import type { PhysicsWorld } from './physics'
import { computeBuoyancy, type Vec3 } from './water/buoyancy'
import type { WaterSim } from './water/water-sim'

/**
 * Linear drag (N·s/m per m³ submerged). Chunk-scale wood debris: mass ≈ 0.6
 * kg/voxel, waterline stiffness ρ·g·A ⇒ ζ ≈ 0.07 — a few visible bobs, then
 * settled within ~5s. Well below critical damping (stable with the one-tick
 * force latency), well above the solver's default 0.05 body damping.
 */
export const BUOYANCY_LINEAR_DRAG = 900
/** extra per-tick angular velocity damping at full submersion (bob, don't spin) */
export const BUOYANCY_ANGULAR_DAMP = 0.08
/** bodies above this voxel count are sampled at stride 2 (8 voxels/sample) */
export const BUOYANCY_STRIDE_THRESHOLD = 512

/**
 * Apply buoyancy to all floats-flagged dynamic bodies. Deterministic:
 * ascending entity id, fixed per-body sample order (y→z→x), pure solver.
 */
export function applyBuoyancy(phys: PhysicsWorld, water: WaterSim): void {
  if (phys.bodies.size === 0) return
  const api = phys.api
  const ids = [...phys.bodies.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const b = phys.bodies.get(id)!
    if ((material(b.mat).flags & MAT_FLAG_FLOATS) === 0) continue
    if (!(b.body as Jolt.Body).IsActive()) continue // sleeping floater stays frozen (see header)

    // FloatingBodyAdapter: world-space sample points = occupied voxel centers
    // (stride 2 for big bodies), rotated by the body transform each tick.
    const stride = b.count > BUOYANCY_STRIDE_THRESHOLD ? 2 : 1
    const sampleVolume = VOXEL_VOLUME * stride * stride * stride
    const { qx, qy, qz, qw, px, py, pz } = b
    const samples: Vec3[] = []
    for (let y = 0; y < b.sy; y += stride) {
      for (let z = 0; z < b.sz; z += stride) {
        for (let x = 0; x < b.sx; x += stride) {
          if (b.grid[x + z * b.sx + y * b.sx * b.sz] === 0) continue
          const lx = (x + 0.5) * VOXEL_SIZE
          const ly = (y + 0.5) * VOXEL_SIZE
          const lz = (z + 0.5) * VOXEL_SIZE
          // p' = p + 2·qv×(qv×p + w·p)  (quaternion rotate, no allocs beyond the point)
          const cx1 = qy * lz - qz * ly + qw * lx
          const cy1 = qz * lx - qx * lz + qw * ly
          const cz1 = qx * ly - qy * lx + qw * lz
          samples.push({
            x: px + lx + 2 * (qy * cz1 - qz * cy1),
            y: py + ly + 2 * (qz * cx1 - qx * cz1),
            z: pz + lz + 2 * (qx * cy1 - qy * cx1),
          })
        }
      }
    }
    if (samples.length === 0) continue

    const com = (b.body as Jolt.Body).GetCenterOfMassPosition() // transient wrapper — read now
    const centerOfMass = { x: com.GetX(), y: com.GetY(), z: com.GetZ() }
    const vel = (b.body as Jolt.Body).GetLinearVelocity()
    const velocity = { x: vel.GetX(), y: vel.GetY(), z: vel.GetZ() }

    const r = computeBuoyancy((x, y, z) => water.levelAt(x, y, z), {
      samples,
      sampleVolume,
      centerOfMass,
      velocity,
    }, { linearDrag: BUOYANCY_LINEAR_DRAG })
    if (r.submergedFraction === 0) continue

    const f = new api.Vec3(r.force.x, r.force.y, r.force.z)
    ;(b.body as Jolt.Body).AddForce(f) // at COM — consumed by the next tick's Jolt step
    api.destroy(f)
    const t = new api.Vec3(r.torque.x, r.torque.y, r.torque.z)
    ;(b.body as Jolt.Body).AddTorque(t)
    api.destroy(t)

    // extra angular damping by submersion — bodies bob, they don't pirouette
    const k = 1 - BUOYANCY_ANGULAR_DAMP * r.submergedFraction
    const av = (b.body as Jolt.Body).GetAngularVelocity()
    const nav = new api.Vec3(av.GetX() * k, av.GetY() * k, av.GetZ() * k)
    ;(b.body as Jolt.Body).SetAngularVelocity(nav)
    api.destroy(nav)
  }
}

/**
 * Register buoyancy as a Sim system. Call AFTER createPhysics() and
 * attachWaterSim() — execution slot must follow both (see header).
 *
 * Also hands the water field to the physics world (T60 player swimming):
 * this is the one existing wiring point that sees both physics and water,
 * so game.ts needs no change. Water steps before physics each tick, so the
 * character update reads the current tick's field — deterministic (V2).
 */
export function attachBuoyancy(sim: Sim, phys: PhysicsWorld, water: WaterSim): void {
  phys.water = water
  sim.addSystem(() => applyBuoyancy(phys, water))
}
