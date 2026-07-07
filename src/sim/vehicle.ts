/**
 * T64 [V] — drivable vehicles (GTA-like): sim entities with a voxel-grid
 * chassis and Jolt VehicleConstraint (WheeledVehicleController) physics.
 *
 * - Chassis = the car archetype voxel grid from gen/props (read-only import)
 *   minus the wheel voxel blocks; collision = greedy-box compound, exactly
 *   the DynamicBody convention (body local origin = grid corner (0,0,0)).
 *   VehicleEntity extends DynamicBody so a destroyed vehicle converts to a
 *   plain body wreck by moving the SAME entity into phys.bodies (V8 id kept).
 * - Wheels = 4 round physics wheels (cast-cylinder tester, suspension,
 *   engine/brake/steer via WheeledVehicleController). Wheel VOXELS are
 *   stripped from the grid; render draws spinning cylinders instead.
 * - Local frame: +x = car left→right width, +y up, forward = -z (archetype
 *   grille sits at z=0).
 * - All mutations via ops (V1): 'vehicle_spawn' / 'vehicle_enter' /
 *   'vehicle_exit'; drive input rides the existing 'move' op of the seated
 *   driver (fwd/back = throttle/reverse, left/right = steer, jump = handbrake).
 * - Deterministic (V2): fixed iteration order (ascending entity id), no
 *   ambient randomness, all state hashed via hashVehicles (physics.ts).
 *
 * Jolt vehicle findings (this build: jolt-physics 1.0.0 wasm-compat):
 * VehicleConstraint / WheeledVehicleController / VehicleConstraintStepListener
 * / VehicleCollisionTesterCastCylinder are all exported and functional.
 * Same wrapper pitfalls as the rest of I.jolt apply (transient wrappers,
 * settings destroyed after use — see INTEGRATION-physics.md).
 */
import type Jolt from 'jolt-physics'
import { DT, type Sim } from './loop'
import type { SimEvent } from './events'
import { VOXEL_SIZE, type ChunkStore } from '../world/chunks'
import { MAT_AIR, MAT_ASPHALT, MAT_DIRT, MAT_GRASS, MAT_METAL, MAT_WATER_SOLID, material } from './materials'
import { greedyBoxes } from './greedy-boxes'
import { destroySphere, runExplosion } from './destruction'
import { placeholderProps } from './gen/props'
import type { VoxelGrid } from './vox/remap'
import type { DynamicBody, PhysicsWorld } from './physics'
import { INPUT_BACK, INPUT_FWD, INPUT_JUMP, INPUT_LEFT, INPUT_RIGHT, PLAYER_HEIGHT, PLAYER_RADIUS, type PlayerEntity } from './player'

// ---------------------------------------------------------------------------
// tuning — arcade-fun: quick steering, handbrake-y rear, top speed ~20 m/s
// ---------------------------------------------------------------------------

/** hard cap on chassis speed (m/s) — the arcade top speed (~72 km/h) */
export const VEHICLE_MAX_SPEED = 21
export const VEHICLE_MAX_ANGULAR = 12
/** target curb masses per archetype base (kg) — voxel-density mass would make
 *  metal cars 15 t tanks; cars are hollow sheet metal, so mass is authored */
// B31 — masses trimmed ~20% so the chassis actually rotates into a corner
// (was understeering against the heavier authored curb weights).
const VEHICLE_MASS: Record<string, number> = { sedan: 1150, pickup: 1450, van: 1800 }
const DEFAULT_VEHICLE_MASS = 1300
const ENGINE_TORQUE = 600
const ENGINE_MAX_RPM = 7000
/** quick arcade steering */
const MAX_STEER_ANGLE = 0.66 // ~38°, tighter turn-in
const BRAKE_TORQUE = 7000 // B31 — firm foot brake (was 4000, wouldn't stop)
const HANDBRAKE_TORQUE = 10000
/** wheel geometry from the archetype wheel blocks (5 voxels tall, 3 wide) */
const WHEEL_RADIUS = 0.25
const WHEEL_WIDTH = 0.3
/** suspension attach height above the local grid floor (chassis bottom = 0.4 m) */
const WHEEL_ATTACH_Y = 0.5
const SUSPENSION_MIN = 0.1
const SUSPENSION_MAX = 0.35
/** stiff arcade suspension — the Jolt default 1.5 Hz bottoms out under the
 *  authored curb masses (rear sat on its bump stop, permanent nose-up pitch) */
const SUSPENSION_FREQUENCY = 3.0
const SUSPENSION_DAMPING = 0.7
/** COM lowered for arcade stability (flip-resistant, still flippable) */
const COM_DROP = 0.3
const MAX_PITCH_ROLL = 1.2 // rad — beyond this the constraint rights the car

// --- crash damage (T64.3) ----------------------------------------------------
/** one-tick velocity change (m/s, gravity-corrected) that counts as a crash */
export const CRASH_DV_SMALL = 4
/** dv at/above which the crash reads as LARGE (audio + heavier voxel damage) */
export const CRASH_DV_LARGE = 8
/** dv at/above which a crash is CATASTROPHIC — the vehicle explodes like a bomb,
 *  engine dies (wreck), occupants ejected (a full-speed slam into a wall) */
export const CRASH_EXPLODE_DV = 20
const VEHICLE_EXPLODE_RADIUS = 13
const VEHICLE_EXPLODE_POWER = 9
/** minimum pre-impact speed for any crash response (parking taps are free) */
const CRASH_MIN_SPEED = 3
/** ticks between crash responses per vehicle (hashed) */
const CRASH_COOLDOWN_TICKS = 10
/** vehicles dent as sheet metal: uniform strength for chassis voxel removal */
const DENT_STRENGTH = 2.5
/** crash hits on a wheel before it breaks off */
export const WHEEL_BREAK_HITS = 2
/** single-crash dv that snaps the nearest wheel off outright */
export const WHEEL_BREAK_DV = 10
/** live-voxel fraction under which the vehicle becomes a plain wreck body */
export const WRECK_FRACTION = 0.4
/** max distance (m) from player center to a seat for vehicle_enter (GTA-generous) */
export const ENTER_RANGE = 4.0

// --- momentum-scaled mutual crash damage: "through fences, stopped by walls" -
/**
 * PLOW pass (pre-Jolt-step): a moving vehicle carves weak BUILT materials in
 * its sweep path before the solver sees them — so a picket fence never
 * hard-stops the car; brick/concrete are never plowed, Jolt stops the car and
 * the post-step crash response takes the momentum-scaled wall bite instead.
 * Only materials with strength ≤ PLOW_MAX_STRENGTH and not natural ground
 * (dirt/grass/water) are plowable: wood fences, glass, plaster walls,
 * rooftile, hedges, lamps, paint.
 */
export const PLOW_MAX_STRENGTH = 2
/** minimum speed (m/s) for the plow pass */
export const PLOW_MIN_SPEED = 2.5
/** J per (voxel · strength) — energy price of removing a voxel. Calibrated so
 *  a full picket-fence section (~240 wood voxels) costs a 5 m/s sedan about a
 *  quarter of its speed — through with a shudder, not a stop. */
export const PLOW_COST_PER_STRENGTH = 15
/** per-tick energy budget = this fraction of ½mv² (slow cars stall, fast cars plow) */
export const PLOW_BUDGET_FRACTION = 0.25
/** hard per-tick cap on plowed voxels per vehicle (perf guard) */
export const MAX_PLOW_VOXELS = 200

/** can the plow remove this material? */
function plowable(mat: number): boolean {
  if (mat === MAT_AIR || mat === MAT_DIRT || mat === MAT_GRASS || mat === MAT_WATER_SOLID) return false
  return material(mat).strength <= PLOW_MAX_STRENGTH
}

// ---------------------------------------------------------------------------
// T64 sim → render events. NOTE for the coordinator: these belong in
// src/sim/events.ts (not editable on this track) — fold VehicleEvent into the
// SimEvent union at merge; until then vehicle.ts casts through `asSimEvent`.
// ---------------------------------------------------------------------------

export interface VehicleCrashEvent {
  kind: 'vehicle_crash'
  vehicleId: number
  /** contact point, world meters */
  x: number
  y: number
  z: number
  /** gravity-corrected one-tick speed change, m/s */
  dv: number
  /** 1 = large crash (dv ≥ CRASH_DV_LARGE) */
  large: number
}

export interface VehicleDoorEvent {
  kind: 'vehicle_door'
  vehicleId: number
  /** 1 = enter (door open+close), 0 = exit */
  enter: number
  x: number
  y: number
  z: number
}

export interface VehicleWheelLossEvent {
  kind: 'vehicle_wheel_loss'
  vehicleId: number
  x: number
  y: number
  z: number
}

/** emitted when the plow pass removed world voxels (fence smash, glass, …) */
export interface VehiclePlowEvent {
  kind: 'vehicle_plow'
  vehicleId: number
  /** flat [matId, count, ...] of voxels plowed this tick */
  removedByMat: number[]
  /** capped sample of removed voxels, flat [vx, vy, vz, mat, ...] (FX/debris) */
  sample: number[]
}

export type VehicleEvent = VehicleCrashEvent | VehicleDoorEvent | VehicleWheelLossEvent | VehiclePlowEvent

const asSimEvent = (ev: VehicleEvent): SimEvent => ev as unknown as SimEvent

// ---------------------------------------------------------------------------
// entity
// ---------------------------------------------------------------------------

export interface VehicleWheel {
  /** suspension attach point, local meters (corner-origin frame) */
  x: number
  y: number
  z: number
  radius: number
  width: number
  /** crash hits taken (hashed); wheel breaks at WHEEL_BREAK_HITS */
  hits: number
  broken: boolean
  // Jolt wheel state mirrored post-step — hashed (deterministic Jolt state)
  // and read by the render layer for spinning/steering wheel meshes.
  rotation: number
  steer: number
  suspension: number
  angularVelocity: number
  /** max |slip| across long/lat this tick — render/audio skid hook (hashed) */
  slip: number
}

export interface Seat {
  /** seat position, local meters (corner-origin frame) */
  x: number
  y: number
  z: number
}

/**
 * VehicleEntity IS a DynamicBody (same local-frame convention) plus the
 * vehicle constraint state — wreck conversion moves it into phys.bodies as-is.
 */
export interface VehicleEntity extends DynamicBody {
  archetype: string
  /** live voxel count at spawn — wreck threshold base */
  initialCount: number
  seats: Seat[]
  /** playerId per seat (0 = empty), index-aligned with seats */
  occupants: number[]
  wheels: VehicleWheel[]
  /** chassis velocity mirrored post-step (hashed; crash detection + audio) */
  vx: number
  vy: number
  vz: number
  /** engine RPM mirrored post-step (hashed; audio pitch hook) */
  rpm: number
  /** ticks until the next crash response is allowed (hashed) */
  crashCooldown: number
  constraint: Jolt.VehicleConstraint
  controller: Jolt.WheeledVehicleController
  stepListener: Jolt.VehicleConstraintStepListener
  tester: Jolt.VehicleCollisionTester
}

/** seat layout per archetype base (local meters): driver left, passenger right */
const SEAT_DEFS: Record<string, Seat[]> = {
  sedan: [
    { x: 0.55, y: 0.9, z: 2.0 },
    { x: 1.25, y: 0.9, z: 2.0 },
  ],
  pickup: [
    { x: 0.55, y: 0.9, z: 1.6 },
    { x: 1.25, y: 0.9, z: 1.6 },
  ],
  van: [
    { x: 0.55, y: 0.9, z: 1.5 },
    { x: 1.25, y: 0.9, z: 1.5 },
  ],
}

/** archetype key ('sedan1') → base ('sedan') */
const archetypeBase = (archetype: string): string => archetype.replace(/\d+$/, '')

let propCache: Record<string, VoxelGrid> | undefined

interface WheelPos {
  x: number
  y: number
  z: number
}

/** per-wheel physical spec (meters, corner-origin local frame) */
export interface WheelDef extends WheelPos {
  radius: number
  width: number
  steerable: boolean
  handbrake: boolean
}

/**
 * Resolved archetype: chassis grid (NO wheel voxels), physics wheels, seats
 * and drivetrain tuning. Cars derive from the gen/props grids; two-wheelers
 * (T76: bicycle, scooter) are authored here — gen/** stays untouched.
 */
export interface VehicleArchetype {
  grid: VoxelGrid
  wheels: WheelDef[]
  seats: Seat[]
  mass: number
  engineTorque: number
  maxRpm: number
  /** body linear velocity clamp = arcade top speed */
  maxSpeed: number
  /** MotorcycleController + lean assist instead of the 4-wheel controller */
  twoWheel: boolean
  suspMin: number
  suspMax: number
}

// ---- T76/P14 two-wheelers: voxel frames now live in gen/props (buildBicycle /
// buildScooter) so the parked prop and the ridable chassis are ONE model.
// resolveArchetype reads them from placeholderProps; wheels are physics-only. --

/** resolve an archetype name to its full spec (cached grids, pure data — V2) */
export function resolveArchetype(archetype: string): VehicleArchetype {
  const base = archetypeBase(archetype)
  if (base === 'bicycle' || base === 'scooter') {
    propCache ??= placeholderProps()
    if (base === 'bicycle') {
      return {
        grid: propCache.bicycle,
        wheels: [
          { x: 0.2, y: 0.45, z: 0.3, radius: 0.22, width: 0.1, steerable: true, handbrake: false },
          { x: 0.2, y: 0.45, z: 1.5, radius: 0.22, width: 0.1, steerable: false, handbrake: true },
        ],
        seats: [{ x: 0.2, y: 1.0, z: 1.3 }],
        mass: 140, // frame + rider — keeps the lean controller planted
        engineTorque: 70, // pedal power (arcade-generous)
        maxRpm: 6000,
        maxSpeed: 7,
        twoWheel: true,
        suspMin: 0.06,
        suspMax: 0.2,
      }
    }
    return {
      grid: propCache.scooter,
      wheels: [
        { x: 0.3, y: 0.45, z: 0.35, radius: 0.22, width: 0.12, steerable: true, handbrake: false },
        { x: 0.3, y: 0.45, z: 1.65, radius: 0.22, width: 0.12, steerable: false, handbrake: true },
      ],
      seats: [{ x: 0.3, y: 0.95, z: 1.2 }],
      mass: 180,
      engineTorque: 140,
      maxRpm: 9000,
      maxSpeed: 13,
      twoWheel: true,
      suspMin: 0.06,
      suspMax: 0.22,
    }
  }
  // cars: grid from gen/props (read-only import), wheels derived
  propCache ??= placeholderProps()
  const src = propCache[archetype]
  const seats = SEAT_DEFS[base]
  if (!src || !seats) throw new Error(`vehicle_spawn: unknown archetype '${archetype}'`)
  const { grid, wheels } = stripWheels(src)
  return {
    grid: { sx: src.sx, sy: src.sy, sz: src.sz, mats: grid },
    wheels: wheels.map((w, i) => ({
      ...w,
      radius: WHEEL_RADIUS,
      width: WHEEL_WIDTH,
      steerable: i < 2,
      handbrake: i >= 2, // rear handbrake = drifty
    })),
    seats,
    mass: VEHICLE_MASS[base] ?? DEFAULT_VEHICLE_MASS,
    engineTorque: ENGINE_TORQUE,
    maxRpm: ENGINE_MAX_RPM,
    maxSpeed: VEHICLE_MAX_SPEED,
    twoWheel: false,
    suspMin: SUSPENSION_MIN,
    suspMax: SUSPENSION_MAX,
  }
}

/**
 * Strip the archetype's wheel voxel blocks (dark cylinders at y ≤ 4 in the
 * outer x columns) from a copy of the grid and derive the 4 wheel attach
 * points from the stripped clusters. Deterministic scan (y→z→x).
 * Wheel order: FL, FR, RL, RR (front = -z end, left = -x side).
 */
export function stripWheels(g: VoxelGrid): { grid: Uint8Array; wheels: WheelPos[] } {
  const { sx, sy, sz } = g
  const grid = g.mats.slice()
  // z-extents of wheel voxels per side
  const zsLeft: number[] = []
  const zsRight: number[] = []
  // wheel voxels in the outer columns: asphalt rubber (y ≤ 4) + the metal
  // hub band (y ≤ 2). Chassis body voxels sharing y = 4 in those columns
  // (body mats: metal/rooftile/plaster, never asphalt) stay in the grid.
  for (let y = 0; y < Math.min(5, sy); y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (x >= 3 && x < sx - 3) continue
        const i = x + z * sx + y * sx * sz
        const m = grid[i]
        if (m === 0) continue
        if (m !== MAT_ASPHALT && y > 2) continue
        grid[i] = 0
        // rubber defines the wheel's z-span (hubs sit inside it anyway)
        if (m === MAT_ASPHALT) (x < sx / 2 ? zsLeft : zsRight).push(z)
      }
    }
  }
  // split each side's z set into two clusters at the largest gap
  const clusters = (zs: number[]): [number, number] => {
    const uniq = [...new Set(zs)].sort((a, b) => a - b)
    if (uniq.length < 2) throw new Error('stripWheels: missing wheel cluster')
    let split = 1
    let gap = 0
    for (let i = 1; i < uniq.length; i++) {
      if (uniq[i] - uniq[i - 1] > gap) {
        gap = uniq[i] - uniq[i - 1]
        split = i
      }
    }
    const a = uniq.slice(0, split)
    const b = uniq.slice(split)
    return [(a[0] + a[a.length - 1] + 1) / 2, (b[0] + b[b.length - 1] + 1) / 2]
  }
  const [lFront, lRear] = clusters(zsLeft)
  const [rFront, rRear] = clusters(zsRight)
  const leftX = 1.5 * VOXEL_SIZE
  const rightX = (sx - 1.5) * VOXEL_SIZE
  const wheels: WheelPos[] = [
    { x: leftX, y: WHEEL_ATTACH_Y, z: lFront * VOXEL_SIZE },
    { x: rightX, y: WHEEL_ATTACH_Y, z: rFront * VOXEL_SIZE },
    { x: leftX, y: WHEEL_ATTACH_Y, z: lRear * VOXEL_SIZE },
    { x: rightX, y: WHEEL_ATTACH_Y, z: rRear * VOXEL_SIZE },
  ]
  return { grid, wheels }
}

/** rotate local vector by quaternion (qx,qy,qz,qw): v' = v + 2 q×(q×v + w v) */
function quatRotate(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
): [number, number, number] {
  const cx = qy * vz - qz * vy + qw * vx
  const cy = qz * vx - qx * vz + qw * vy
  const cz = qx * vy - qy * vx + qw * vz
  return [vx + 2 * (qy * cz - qz * cy), vy + 2 * (qz * cx - qx * cz), vz + 2 * (qx * cy - qy * cx)]
}

/** seat position in world meters */
export function seatWorldPos(v: VehicleEntity, seatIndex: number): [number, number, number] {
  const s = v.seats[seatIndex]
  const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, s.x, s.y, s.z)
  return [v.px + rx, v.py + ry, v.pz + rz]
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

/**
 * B24 — spawn clearance validation: the car's rotated volume (chassis band
 * above the wheels) must be air and the ground under each wheel solid within
 * 3 voxels down. For gen: emit car ENTITY spawns only where this passes.
 * (cx, cy, cz) = footprint center in world meters, cy = ground surface.
 */
export function vehicleSpawnClear(
  world: ChunkStore,
  archetype: string,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
): boolean {
  const spec = resolveArchetype(archetype)
  const { sx, sy, sz } = spec.grid
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  // sample the chassis band (above wheel height) every 2 voxels, rotated
  for (let y = 5; y < sy; y += 2) {
    for (let z = 0; z < sz; z += 2) {
      for (let x = 0; x < sx; x += 2) {
        const lx = (x + 0.5 - sx / 2) * VOXEL_SIZE
        const lz = (z + 0.5 - sz / 2) * VOXEL_SIZE
        const wx = cx + lx * cos + lz * sin
        const wz = cz - lx * sin + lz * cos
        const wy = cy + (y + 0.5) * VOXEL_SIZE
        if (world.getVoxel(Math.floor(wx / VOXEL_SIZE), Math.floor(wy / VOXEL_SIZE), Math.floor(wz / VOXEL_SIZE)) !== 0) {
          return false
        }
      }
    }
  }
  // ground under each wheel footprint corner
  for (const w of spec.wheels) {
    const lx = w.x - (sx * VOXEL_SIZE) / 2
    const lz = w.z - (sz * VOXEL_SIZE) / 2
    const wx = cx + lx * cos + lz * sin
    const wz = cz - lx * sin + lz * cos
    const vx = Math.floor(wx / VOXEL_SIZE)
    const vz = Math.floor(wz / VOXEL_SIZE)
    const vy = Math.floor(cy / VOXEL_SIZE)
    let solid = false
    for (let dy = 1; dy <= 3; dy++) {
      if (world.getVoxel(vx, vy - dy, vz) !== 0) {
        solid = true
        break
      }
    }
    if (!solid) return false
  }
  return true
}

/**
 * Spawn a vehicle entity. (cx, cy, cz) = footprint center, world meters,
 * cy = ground surface under the wheels; yaw about +Y. Deterministic (V8 id).
 */
export function spawnVehicle(
  sim: Sim,
  phys: PhysicsWorld,
  archetype: string,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
): VehicleEntity {
  const api = phys.api
  const spec = resolveArchetype(archetype)
  const { sx, sy, sz } = spec.grid
  const grid = spec.grid.mats.slice() // entity owns (and dents) its grid
  const wheels = spec.wheels

  let count = 0
  const matCounts = new Uint32Array(256)
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 0) {
      count++
      matCounts[grid[i]]++
    }
  }
  let mat = MAT_METAL
  let best = 0
  for (let m = 1; m < 256; m++) {
    if (matCounts[m] > best) {
      best = matCounts[m]
      mat = m
    }
  }
  const mass = spec.mass

  // chassis shape: greedy-box compound (corner-origin), COM lowered for feel
  const boxes = greedyBoxes(grid, sx, sy, sz)
  const inner = phys.buildBoxesShape(boxes)
  const comOffset = new api.Vec3(0, -COM_DROP, 0)
  const shape = new api.OffsetCenterOfMassShape(inner, comOffset)
  api.destroy(comOffset)

  // body position: rotate the corner-origin offset by yaw around the center.
  // Spawn lifted by the suspension travel so the wheels settle onto cy.
  const hx = (sx * VOXEL_SIZE) / 2
  const hz = (sz * VOXEL_SIZE) / 2
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const px = cx + -hx * cos + -hz * sin
  const py = cy + 0.05
  const pz = cz - -hx * sin + -hz * cos
  const qy = Math.sin(yaw / 2)
  const qw = Math.cos(yaw / 2)

  const pos = new api.RVec3(px, py, pz)
  const rot = new api.Quat(0, qy, 0, qw)
  const bcs = new api.BodyCreationSettings(shape, pos, rot, api.EMotionType_Dynamic, 1 /* LAYER_MOVING */)
  bcs.mOverrideMassProperties = api.EOverrideMassProperties_CalculateInertia
  bcs.mMassPropertiesOverride.mMass = mass
  bcs.mFriction = 0.3
  bcs.mRestitution = 0.05
  bcs.mAngularDamping = spec.twoWheel ? 1.5 : 0.3 // bikes: damp the lean wobble
  bcs.mMaxLinearVelocity = spec.maxSpeed
  bcs.mMaxAngularVelocity = VEHICLE_MAX_ANGULAR
  const body = phys.bodyInterface.CreateBody(bcs)
  phys.bodyInterface.AddBody(body.GetID(), api.EActivation_Activate)
  api.destroy(bcs)
  api.destroy(pos)
  api.destroy(rot)

  // --- vehicle constraint: cast-cylinder wheels; 4-wheel (4WD, auto box) or
  // --- two-wheel MotorcycleController with lean assist (T76) ---------------
  const settings = new api.VehicleConstraintSettings()
  const up = new api.Vec3(0, 1, 0)
  const fwd = new api.Vec3(0, 0, -1) // archetype grille at local z = 0
  settings.mUp = up
  settings.mForward = fwd
  // two-wheelers keep a VERY tight clamp: the constraint IS the
  // kickstand/balance. A freely-leaning voxel bike falls at rest and then
  // 'skates' on the clamp torque; at ~7° the residual lateral force is below
  // tire friction, so it stands still and corners flat (arcade tradeoff).
  settings.mMaxPitchRollAngle = spec.twoWheel ? 0.12 : MAX_PITCH_ROLL

  const suspDir = new api.Vec3(0, -1, 0)
  const steerAxis = new api.Vec3(0, 1, 0)
  const wheelUp = new api.Vec3(0, 1, 0)
  for (const w of wheels) {
    const ws = new api.WheelSettingsWV()
    const wpos = new api.Vec3(w.x, w.y, w.z)
    ws.mPosition = wpos
    ws.mSuspensionDirection = suspDir
    ws.mSteeringAxis = steerAxis
    ws.mWheelUp = wheelUp
    ws.mWheelForward = fwd
    ws.mSuspensionMinLength = spec.suspMin
    ws.mSuspensionMaxLength = spec.suspMax
    ws.mSuspensionSpring.mFrequency = SUSPENSION_FREQUENCY
    ws.mSuspensionSpring.mDamping = SUSPENSION_DAMPING
    ws.mRadius = w.radius
    ws.mWidth = w.width
    ws.mMaxSteerAngle = w.steerable ? MAX_STEER_ANGLE : 0
    ws.mMaxBrakeTorque = spec.twoWheel ? BRAKE_TORQUE * 0.2 : BRAKE_TORQUE
    ws.mMaxHandBrakeTorque = w.handbrake ? HANDBRAKE_TORQUE * (spec.twoWheel ? 0.15 : 1) : 0
    settings.mWheels.push_back(ws)
    api.destroy(wpos)
  }
  if (!spec.twoWheel) {
    // anti-roll bars front + rear
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ]) {
      const bar = new api.VehicleAntiRollBar()
      bar.mLeftWheel = l
      bar.mRightWheel = r
      bar.mStiffness = 600 // B31 — softer: let the car lean/rotate into corners
      settings.mAntiRollBars.push_back(bar) // copied by value
      api.destroy(bar)
    }
  }

  const controllerSettings = spec.twoWheel
    ? new api.MotorcycleControllerSettings()
    : new api.WheeledVehicleControllerSettings()
  controllerSettings.mEngine.mMaxTorque = spec.engineTorque
  controllerSettings.mEngine.mMinRPM = 1000
  controllerSettings.mEngine.mMaxRPM = spec.maxRpm
  if (spec.twoWheel) {
    // rear-wheel drive (wheel 1); -1 = unconnected side
    const diff = new api.VehicleDifferentialSettings()
    diff.mLeftWheel = -1
    diff.mRightWheel = 1
    diff.mDifferentialRatio = 6
    controllerSettings.mDifferentials.push_back(diff)
    api.destroy(diff)
  } else {
    // 4WD: two differentials, half the torque each — foolproof on voxel curbs
    for (const [l, r] of [
      [0, 1],
      [2, 3],
    ]) {
      const diff = new api.VehicleDifferentialSettings()
      diff.mLeftWheel = l
      diff.mRightWheel = r
      diff.mEngineTorqueRatio = 0.5
      controllerSettings.mDifferentials.push_back(diff) // copied by value
      api.destroy(diff)
    }
  }
  settings.mController = controllerSettings

  const constraint = new api.VehicleConstraint(body, settings)
  const tester = new api.VehicleCollisionTesterCastCylinder(1 /* LAYER_MOVING */, 0.05)
  constraint.SetVehicleCollisionTester(tester)
  phys.physicsSystem.AddConstraint(constraint)
  const stepListener = new api.VehicleConstraintStepListener(constraint)
  phys.physicsSystem.AddStepListener(stepListener)
  const controller = api.castObject(constraint.GetController(), api.WheeledVehicleController)
  if (spec.twoWheel) {
    // balance assist: the lean controller keeps the bike upright while driven
    api.castObject(constraint.GetController(), api.MotorcycleController).EnableLeanController(true)
  }

  api.destroy(settings)
  api.destroy(up)
  api.destroy(fwd)
  api.destroy(suspDir)
  api.destroy(steerAxis)
  api.destroy(wheelUp)

  const id = sim.allocEntityId()
  body.SetUserData(id)
  const entity: VehicleEntity = {
    id,
    sx,
    sy,
    sz,
    grid,
    count,
    mass,
    mat,
    px,
    py,
    pz,
    qx: 0,
    qy,
    qz: 0,
    qw,
    body,
    version: 0,
    restTicks: 0, // DynamicBody field (unused: vehicles don't re-weld)
    archetype,
    initialCount: count,
    seats: spec.seats,
    occupants: spec.seats.map(() => 0),
    wheels: wheels.map((w) => ({
      x: w.x,
      y: w.y,
      z: w.z,
      radius: w.radius,
      width: w.width,
      hits: 0,
      broken: false,
      rotation: 0,
      steer: 0,
      suspension: spec.suspMax,
      angularVelocity: 0,
      slip: 0,
    })),
    vx: 0,
    vy: 0,
    vz: 0,
    rpm: 0,
    crashCooldown: 0,
    constraint,
    controller,
    stepListener,
    tester,
  }
  phys.vehicles.set(id, entity)
  return entity
}

// ---------------------------------------------------------------------------
// enter / exit
// ---------------------------------------------------------------------------

function enterVehicle(sim: Sim, phys: PhysicsWorld, p: PlayerEntity): void {
  if (p.seatedVehicle !== 0) return // already seated — idempotent no-op
  // nearest vehicle (by center distance) that has a free in-range seat;
  // WITHIN a vehicle the driver seat always wins if free (GTA rule).
  // Deterministic: ascending id iteration, strict < comparison.
  let bestV: VehicleEntity | undefined
  let bestSeat = -1
  let bestD = Infinity
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  const pcx = p.px
  const pcy = p.py + 0.9
  const pcz = p.pz
  for (const id of ids) {
    const v = phys.vehicles.get(id)!
    let seat = -1
    for (let si = 0; si < v.seats.length; si++) {
      if (v.occupants[si] !== 0) continue
      const [sx, sy, sz] = seatWorldPos(v, si)
      const d = Math.sqrt((sx - pcx) ** 2 + (sy - pcy) ** 2 + (sz - pcz) ** 2)
      if (d <= ENTER_RANGE) {
        seat = si // lowest free in-range seat = driver first
        break
      }
    }
    if (seat < 0) continue
    const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, (v.sx * VOXEL_SIZE) / 2, (v.sy * VOXEL_SIZE) / 2, (v.sz * VOXEL_SIZE) / 2)
    const d = Math.sqrt((v.px + rx - pcx) ** 2 + (v.py + ry - pcy) ** 2 + (v.pz + rz - pcz) ** 2)
    if (d < bestD) {
      bestD = d
      bestV = v
      bestSeat = seat
    }
  }
  if (!bestV) return
  bestV.occupants[bestSeat] = p.playerId
  p.seatedVehicle = bestV.id
  p.seat = bestSeat
  syncSeatedPlayer(phys, bestV, p)
  sim.emit(asSimEvent({ kind: 'vehicle_door', vehicleId: bestV.id, enter: 1, x: p.px, y: p.py, z: p.pz }))
}

/** capsule-sized voxel AABB probe at a candidate exit spot (feet position) */
function exitSpotClear(world: ChunkStore, x: number, y: number, z: number): boolean {
  const x0 = Math.floor((x - PLAYER_RADIUS) / VOXEL_SIZE)
  const x1 = Math.floor((x + PLAYER_RADIUS) / VOXEL_SIZE)
  const z0 = Math.floor((z - PLAYER_RADIUS) / VOXEL_SIZE)
  const z1 = Math.floor((z + PLAYER_RADIUS) / VOXEL_SIZE)
  const y0 = Math.floor((y + 0.05) / VOXEL_SIZE)
  const y1 = Math.floor((y + PLAYER_HEIGHT) / VOXEL_SIZE)
  for (let vy = y0; vy <= y1; vy++)
    for (let vz = z0; vz <= z1; vz++)
      for (let vx = x0; vx <= x1; vx++) {
        if (world.getVoxel(vx, vy, vz) !== 0) return false
      }
  return true
}

/**
 * Place an exiting player beside their door: candidate offsets in the
 * vehicle's local frame (door side first, then the other side, rear, front,
 * roof), first voxel-clear spot wins. Deterministic.
 */
function exitVehicle(sim: Sim, phys: PhysicsWorld, p: PlayerEntity): void {
  const v = phys.vehicles.get(p.seatedVehicle)
  if (!v) {
    // vehicle became a wreck/despawned this tick — unseat in place
    unseatPlayer(phys, p, p.px, p.py, p.pz)
    return
  }
  const si = p.seat
  v.occupants[si] = 0
  const seat = v.seats[si]
  const doorSign = seat.x < (v.sx * VOXEL_SIZE) / 2 ? -1 : 1
  const width = v.sx * VOXEL_SIZE
  const out = width / 2 + PLAYER_RADIUS + 0.35
  const half = width / 2
  // local candidates relative to the seat (x from vehicle center line)
  const candidates: [number, number, number][] = [
    [half + doorSign * out, 0, seat.z], // door side
    [half - doorSign * out, 0, seat.z], // opposite side
    [half, 0, v.sz * VOXEL_SIZE + 1.0], // behind
    [half, 0, -1.0], // in front
    [half, v.sy * VOXEL_SIZE + 0.2, seat.z], // roof — always succeeds
  ]
  let placed = false
  for (const [lx, ly, lz] of candidates) {
    const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, lx, ly, lz)
    const wx = v.px + rx
    const wy = v.py + ry
    const wz = v.pz + rz
    if (exitSpotClear(sim.world, wx, wy, wz)) {
      unseatPlayer(phys, p, wx, wy, wz)
      placed = true
      break
    }
  }
  if (!placed) {
    // every spot blocked (car wedged in a building): top-of-car fallback
    unseatPlayer(phys, p, v.px, v.py + v.sy * VOXEL_SIZE + 0.2, v.pz)
  }
  sim.emit(asSimEvent({ kind: 'vehicle_door', vehicleId: v.id, enter: 0, x: p.px, y: p.py, z: p.pz }))
}

function unseatPlayer(phys: PhysicsWorld, p: PlayerEntity, x: number, y: number, z: number): void {
  p.seatedVehicle = 0
  p.seat = 0
  p.px = x
  p.py = y
  p.pz = z
  p.vx = 0
  p.vy = 0
  p.vz = 0
  const pos = new phys.api.RVec3(x, y, z)
  p.char.SetPosition(pos)
  phys.api.destroy(pos)
}

/** seated capsule parks at the seat; velocity mirrors the vehicle (audio/anim) */
function syncSeatedPlayer(phys: PhysicsWorld, v: VehicleEntity, p: PlayerEntity): void {
  const [sx, sy, sz] = seatWorldPos(v, p.seat)
  p.px = sx
  p.py = sy - 0.9 // seat is at torso height; capsule origin is the feet
  p.pz = sz
  p.vx = v.vx
  p.vy = v.vy
  p.vz = v.vz
  const pos = new phys.api.RVec3(p.px, p.py, p.pz)
  p.char.SetPosition(pos)
  phys.api.destroy(pos)
}

// ---------------------------------------------------------------------------
// per-tick systems (called from PhysicsWorld.tick, fixed order)
// ---------------------------------------------------------------------------

/**
 * PLOW: sweep the vehicle's leading face along its velocity for this tick's
 * travel and remove plowable voxels, paying PLOW_COST_PER_STRENGTH·strength
 * per voxel from a ½mv²-derived budget; the spent energy comes back out of
 * the chassis velocity (√(v² − 2E/m)). Whatever is not plowable or not
 * affordable stays solid — Jolt resolves the collision (hard stop) and the
 * post-step crash response handles dents + the momentum-scaled wall bite.
 * Deterministic: fixed sample order, budget draw in scan order (V2).
 */
function plowPass(sim: Sim, phys: PhysicsWorld, v: VehicleEntity): void {
  const speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy + v.vz * v.vz)
  if (speed < PLOW_MIN_SPEED) return
  const dx = v.vx / speed
  const dy = v.vy / speed
  const dz = v.vz / speed
  // leading face by dominant local-velocity axis
  const [lvx, lvy, lvz] = quatRotate(-v.qx, -v.qy, -v.qz, v.qw, v.vx, v.vy, v.vz)
  const ax = Math.abs(lvx)
  const ay = Math.abs(lvy)
  const az = Math.abs(lvz)
  const { sx, sy, sz } = v
  // sample the face at 1-voxel pitch. Side/front bands reach DOWN to wheel
  // level (local y = 1): a fence must be carved to the ground or the car
  // beaches on the stub. Natural ground (dirt/grass) is never plowable, so
  // the low rays cannot tunnel terrain.
  let su: number, sv: number
  let toLocal: (u: number, w: number) => [number, number, number]
  if (ay >= ax && ay >= az) {
    // vertical impact (falling onto a roof): bottom or top face
    su = sx
    sv = sz
    const fy = lvy < 0 ? 3.5 : sy + 0.5
    toLocal = (u, w) => [u + 0.5, fy, w + 0.5]
  } else if (ax >= az) {
    su = sz
    sv = sy - 1
    const fx = lvx < 0 ? -0.5 : sx + 0.5
    toLocal = (u, w) => [fx, w + 1.5, u + 0.5]
  } else {
    su = sx
    sv = sy - 1
    const fz = lvz < 0 ? -0.5 : sz + 0.5
    toLocal = (u, w) => [u + 0.5, w + 1.5, fz]
  }

  const sweep = speed * DT + 0.2
  const step = VOXEL_SIZE * 0.5
  let budget = PLOW_BUDGET_FRACTION * 0.5 * v.mass * speed * speed
  let spent = 0
  let removed = 0
  const removedByMat = new Uint32Array(256)
  const sample: number[] = []
  const seen = new Set<number>()
  // 1-voxel margin each side so the cleared corridor is a shade wider than
  // the hull (no snagging the fence edge with a fender)
  for (let w = 0; w < sv && removed < MAX_PLOW_VOXELS; w++) {
    for (let u = -1; u <= su && removed < MAX_PLOW_VOXELS; u++) {
      const [lx, ly, lz] = toLocal(u, w)
      const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, lx * VOXEL_SIZE, ly * VOXEL_SIZE, lz * VOXEL_SIZE)
      const ox = v.px + rx
      const oy = v.py + ry
      const oz = v.pz + rz
      for (let d = 0; d <= sweep; d += step) {
        const wx = Math.floor((ox + dx * d) / VOXEL_SIZE)
        const wy = Math.floor((oy + dy * d) / VOXEL_SIZE)
        const wz = Math.floor((oz + dz * d) / VOXEL_SIZE)
        const key = wx + 4096 * (wz + 4096 * wy)
        if (seen.has(key)) continue
        const mat = sim.world.getVoxel(wx, wy, wz)
        if (mat === 0) continue
        seen.add(key)
        // first solid along this ray: plow it or leave it for Jolt
        if (plowable(mat)) {
          const cost = PLOW_COST_PER_STRENGTH * material(mat).strength
          if (budget >= cost) {
            sim.world.setVoxel(wx, wy, wz, 0)
            budget -= cost
            spent += cost
            removedByMat[mat]++
            removed++
            if (sample.length < 64) sample.push(wx, wy, wz, mat)
          }
        }
        break // ray stops at the first solid voxel either way
      }
    }
  }
  if (removed === 0) return

  // energy accounting: the plowed material bleeds speed out of the chassis
  const v2 = Math.max(0, speed * speed - (2 * spent) / v.mass)
  const scale = Math.sqrt(v2) / speed
  const api = phys.api
  const nv = new api.Vec3(v.vx * scale, v.vy * scale, v.vz * scale)
  ;(v.body as Jolt.Body).SetLinearVelocity(nv)
  api.destroy(nv)
  v.vx *= scale
  v.vy *= scale
  v.vz *= scale

  const rbm: number[] = []
  for (let m = 1; m < 256; m++) if (removedByMat[m] > 0) rbm.push(m, removedByMat[m])
  sim.emit(asSimEvent({ kind: 'vehicle_plow', vehicleId: v.id, removedByMat: rbm, sample }))
}

/**
 * BEFORE structuralPass: plow pass for every vehicle. Runs first inside the
 * tick so the chunks it dirties get their static colliders rebuilt (and
 * connectivity-checked — fence remainders drop as debris) in the SAME tick's
 * structuralPass, before the Jolt step ever sees the obstacle.
 */
export function tickVehiclesPlow(sim: Sim, phys: PhysicsWorld): void {
  if (phys.vehicles.size === 0) return
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  for (const id of ids) plowPass(sim, phys, phys.vehicles.get(id)!)
}

/** BEFORE the Jolt step: map the driver's move-op input bits to driver input */
export function tickVehiclesPreStep(phys: PhysicsWorld): void {
  if (phys.vehicles.size === 0) return
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const v = phys.vehicles.get(id)!
    const driver = v.occupants[0] !== 0 ? phys.players.get(v.occupants[0]) : undefined
    let forward = 0
    let right = 0
    let brake = 0
    let handBrake = 0
    if (driver) {
      const bits = driver.input
      if (bits & INPUT_FWD) forward += 1
      if (bits & INPUT_BACK) forward -= 1
      if (bits & INPUT_RIGHT) right += 1
      if (bits & INPUT_LEFT) right -= 1
      if (bits & INPUT_JUMP) handBrake = 1
      // GTA pedal model: 'back' while rolling forward = foot brake; reverse
      // engages only once nearly stopped. Uses last tick's mirrored velocity
      // (deterministic sim state).
      const [fx, fy, fz] = quatRotate(v.qx, v.qy, v.qz, v.qw, 0, 0, -1)
      const fwdSpeed = v.vx * fx + v.vy * fy + v.vz * fz
      // B31 — brake to a near-stop before reverse engages (was cutting out at
      // 1.5 m/s, so S never fully stopped the car); threshold now 0.4 m/s.
      if (forward < 0 && fwdSpeed > 0.4) {
        forward = 0
        brake = 1
      }
      if (forward === 0 && brake === 0) {
        // no throttle: handbrake reads as a hard stop, plain coasting drags
        brake = handBrake ? 0.6 : 0.2
      }
      phys.bodyInterface.ActivateBody((v.body as Jolt.Body).GetID())
    } else {
      handBrake = 1 // parked
    }
    v.controller.SetDriverInput(forward, right, brake, handBrake)
  }
}

/**
 * AFTER the Jolt step: mirror transforms/wheel state, run crash detection
 * (voxel damage both ways + wheel loss + wreck conversion), sync seated
 * players, kill-plane. Fixed order: ascending entity id (V2).
 */
export function tickVehiclesPostStep(sim: Sim, phys: PhysicsWorld): void {
  if (phys.vehicles.size === 0) return
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const v = phys.vehicles.get(id)!
    const prevVx = v.vx
    const prevVy = v.vy
    const prevVz = v.vz

    const pos = (v.body as Jolt.Body).GetPosition()
    v.px = pos.GetX()
    v.py = pos.GetY()
    v.pz = pos.GetZ()
    const rot = (v.body as Jolt.Body).GetRotation()
    v.qx = rot.GetX()
    v.qy = rot.GetY()
    v.qz = rot.GetZ()
    v.qw = rot.GetW()
    const vel = (v.body as Jolt.Body).GetLinearVelocity()
    v.vx = vel.GetX()
    v.vy = vel.GetY()
    v.vz = vel.GetZ()
    v.rpm = v.controller.GetEngine().GetCurrentRPM()

    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i]
      const jw = phys.api.castObject(v.constraint.GetWheel(i), phys.api.WheelWV)
      w.rotation = jw.GetRotationAngle()
      w.steer = jw.GetSteerAngle()
      w.suspension = jw.GetSuspensionLength()
      w.angularVelocity = jw.GetAngularVelocity()
      w.slip = jw.HasContact() ? Math.max(Math.abs(jw.mLongitudinalSlip), Math.abs(jw.mLateralSlip)) : 0
    }

    if (v.crashCooldown > 0) v.crashCooldown--

    // punt light debris out of the way: a plank lodged under the chassis
    // must not beach a moving car — it flies off the bumper instead.
    // Deterministic: ascending body id, pure function of tick state.
    const vSpeed = Math.sqrt(v.vx * v.vx + v.vy * v.vy + v.vz * v.vz)
    if (vSpeed > 3) {
      const bids = [...phys.bodies.keys()].sort((a, b) => a - b)
      for (const bid of bids) {
        const b = phys.bodies.get(bid)
        if (!b || b.mass > 150) continue
        const bcx = b.px + (b.sx * VOXEL_SIZE) / 2
        const bcy = b.py + (b.sy * VOXEL_SIZE) / 2
        const bcz = b.pz + (b.sz * VOXEL_SIZE) / 2
        const [lx, ly, lz] = worldToLocal(v, bcx, bcy, bcz)
        const m = 0.4 // overlap margin, meters
        if (
          lx > -m && lx < v.sx * VOXEL_SIZE + m &&
          ly > -m && ly < v.sy * VOXEL_SIZE + m &&
          lz > -m && lz < v.sz * VOXEL_SIZE + m
        ) {
          phys.setBodyVelocity(b, v.vx * 1.2, Math.max(2.5, v.vy + 2.5), v.vz * 1.2, 4, 1, 4)
        }
      }
    }

    // --- crash detection: gravity-corrected one-tick velocity change --------
    const prevSpeed = Math.sqrt(prevVx * prevVx + prevVy * prevVy + prevVz * prevVz)
    const dvx = v.vx - prevVx
    const dvy = v.vy - (prevVy + -9.81 * DT)
    const dvz = v.vz - prevVz
    const dv = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz)
    if (dv >= CRASH_DV_SMALL && prevSpeed >= CRASH_MIN_SPEED && v.crashCooldown === 0) {
      v.crashCooldown = CRASH_COOLDOWN_TICKS
      handleCrash(sim, phys, v, prevVx, prevVy, prevVz, prevSpeed, dv)
      if (!phys.vehicles.has(id)) continue // crash wrecked it
    }

    // --- kill plane (matches T40 body rule) ---------------------------------
    if (v.py < -10) {
      despawnVehicle(sim, phys, v)
      continue
    }

    // --- wreck threshold ------------------------------------------------------
    if (v.count < v.initialCount * WRECK_FRACTION) {
      convertToWreck(sim, phys, v)
      continue
    }

    // --- seated players follow their seats ----------------------------------
    for (const pid of v.occupants) {
      if (pid === 0) continue
      const p = phys.players.get(pid)
      if (p) syncSeatedPlayer(phys, v, p)
    }
  }
}

/**
 * Crash response: find the world contact along the pre-impact travel
 * direction, damage world voxels (small destroySphere — real crashes chew
 * fences/walls), dent the chassis grid at the contact, damage the nearest
 * wheel. Deterministic: pure function of tick state.
 */
function handleCrash(
  sim: Sim,
  phys: PhysicsWorld,
  v: VehicleEntity,
  prevVx: number,
  prevVy: number,
  prevVz: number,
  prevSpeed: number,
  dv: number,
): void {
  // travel direction before impact
  const dx = prevVx / prevSpeed
  const dy = prevVy / prevSpeed
  const dz = prevVz / prevSpeed

  // catastrophic hit: the vehicle detonates like a bomb — occupants ejected,
  // engine dies (wreck), a big blast tears the crash site open. Deterministic.
  if (dv >= CRASH_EXPLODE_DV) {
    for (const pid of v.occupants) {
      if (pid === 0) continue
      const p = phys.players.get(pid)
      if (p) unseatPlayer(phys, p, v.px, v.py + v.sy * VOXEL_SIZE + 1.2, v.pz)
    }
    runExplosion(sim, phys, v.px / VOXEL_SIZE, v.py / VOXEL_SIZE, v.pz / VOXEL_SIZE, VEHICLE_EXPLODE_RADIUS, VEHICLE_EXPLODE_POWER)
    sim.emit({ kind: 'vehicle_crash', vehicleId: v.id, x: v.px, y: v.py, z: v.pz, dv, large: 1 })
    convertToWreck(sim, phys, v)
    return
  }

  // chassis center, world
  const [ox, oy, oz] = (() => {
    const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, (v.sx * VOXEL_SIZE) / 2, (v.sy * VOXEL_SIZE) / 2, (v.sz * VOXEL_SIZE) / 2)
    return [v.px + rx, v.py + ry, v.pz + rz]
  })()
  // march for the first solid world voxel along the travel direction
  const halfDiag = (Math.sqrt(v.sx * v.sx + v.sy * v.sy + v.sz * v.sz) * VOXEL_SIZE) / 2
  const maxDist = halfDiag + 0.6
  let hx = ox + dx * halfDiag
  let hy = oy + dy * halfDiag
  let hz = oz + dz * halfDiag
  let hit = false
  for (let d = 0.3; d <= maxDist; d += 0.05) {
    const wx = Math.floor((ox + dx * d) / VOXEL_SIZE)
    const wy = Math.floor((oy + dy * d) / VOXEL_SIZE)
    const wz = Math.floor((oz + dz * d) / VOXEL_SIZE)
    if (sim.world.getVoxel(wx, wy, wz) !== 0) {
      hx = (wx + 0.5) * VOXEL_SIZE
      hy = (wy + 0.5) * VOXEL_SIZE
      hz = (wz + 0.5) * VOXEL_SIZE
      hit = true
      break
    }
  }
  const large = dv >= CRASH_DV_LARGE

  // MUTUAL world damage, momentum-scaled: heavier + faster ⇒ bigger bite.
  // Brick (strength 3) loses its core at a hard hit; concrete (5) mostly
  // shrugs; the dirty set feeds the structural pass next tick, so knocking a
  // pillar out collapses what it carried (same path as explosions).
  if (hit) {
    const massScale = 0.6 + 0.4 * (v.mass / 1800)
    const r = Math.min(5, Math.max(1.5, dv * 0.35 * massScale))
    const power = Math.min(8, dv * 0.55 * massScale)
    destroySphere(sim, hx / VOXEL_SIZE, hy / VOXEL_SIZE, hz / VOXEL_SIZE, r, power)
  }

  // mutual damage vs dynamic bodies at the contact (momentum-scaled)
  {
    const massScale = 0.6 + 0.4 * (v.mass / 1800)
    const rM = Math.min(0.8, Math.max(0.3, dv * 0.05 * massScale))
    const power = Math.min(8, dv * 0.55 * massScale)
    const ids = [...phys.bodies.keys()].sort((a, b) => a - b)
    for (const bid of ids) {
      const b = phys.bodies.get(bid)
      if (!b) continue
      const bx = b.px + (b.sx * VOXEL_SIZE) / 2 - hx
      const by = b.py + (b.sy * VOXEL_SIZE) / 2 - hy
      const bz = b.pz + (b.sz * VOXEL_SIZE) / 2 - hz
      const reach = rM + (Math.sqrt(b.sx * b.sx + b.sy * b.sy + b.sz * b.sz) * VOXEL_SIZE) / 2
      if (bx * bx + by * by + bz * bz > reach * reach) continue
      phys.damageBodySphere(b, hx, hy, hz, rM, power)
    }
  }

  // chassis dent: SNAP the dent center onto the chassis's own solid voxel
  // nearest the world contact, then crumple a sheet-metal sphere there. The
  // marched world contact sits on the WALL at the grid-center height (~sy/2);
  // with the P15-raised cabins the front hood/nose is low and thin, so that
  // wall point can float in the empty air above the low leading edge and a dent
  // sphere placed on it would find no chassis to crush (the "taller front stops
  // crumpling" coupling). Denting the nearest solid voxel instead guarantees
  // the crush lands on the part of the car closest to impact, at any cabin
  // height. Deterministic: fixed y→z→x scan of the entity's own grid (V2).
  const [dlx, dly, dlz] = worldToLocal(v, hx, hy, hz)
  let dentX = hx
  let dentY = hy
  let dentZ = hz
  {
    const { grid, sx, sy, sz } = v
    let bestD2 = Infinity
    let bvx = -1
    let bvy = -1
    let bvz = -1
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          if (grid[x + z * sx + y * sx * sz] === 0) continue
          const ddx = (x + 0.5) * VOXEL_SIZE - dlx
          const ddy = (y + 0.5) * VOXEL_SIZE - dly
          const ddz = (z + 0.5) * VOXEL_SIZE - dlz
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz
          if (d2 < bestD2) {
            bestD2 = d2
            bvx = x
            bvy = y
            bvz = z
          }
        }
    if (bvx >= 0) {
      const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, (bvx + 0.5) * VOXEL_SIZE, (bvy + 0.5) * VOXEL_SIZE, (bvz + 0.5) * VOXEL_SIZE)
      dentX = v.px + rx
      dentY = v.py + ry
      dentZ = v.pz + rz
    }
  }
  const dentR = Math.min(0.9, Math.max(0.35, dv * 0.08))
  damageVehicleSphere(sim, phys, v, dentX, dentY, dentZ, dentR, dv * 0.6, DENT_STRENGTH)

  // wheel damage: nearest wheel to the contact (local frame), if close
  if (phys.vehicles.has(v.id)) {
    const [lx, ly, lz] = worldToLocal(v, hx, hy, hz)
    let nearest = -1
    let nd = 1.4
    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i]
      if (w.broken) continue
      const d = Math.sqrt((w.x - lx) ** 2 + (w.y - ly) ** 2 + (w.z - lz) ** 2)
      if (d < nd) {
        nd = d
        nearest = i
      }
    }
    if (nearest >= 0) {
      const w = v.wheels[nearest]
      w.hits++
      if (w.hits >= WHEEL_BREAK_HITS || dv >= WHEEL_BREAK_DV) breakWheel(sim, phys, v, nearest)
    }
  }

  sim.emit(asSimEvent({ kind: 'vehicle_crash', vehicleId: v.id, x: hx, y: hy, z: hz, dv, large: large ? 1 : 0 }))
}

/** world meters → vehicle-local meters (corner-origin frame) */
function worldToLocal(v: VehicleEntity, wx: number, wy: number, wz: number): [number, number, number] {
  const tx = wx - v.px
  const ty = wy - v.py
  const tz = wz - v.pz
  return quatRotate(-v.qx, -v.qy, -v.qz, v.qw, tx, ty, tz)
}

/**
 * Remove chassis voxels inside a world-space sphere (falloff · power ≥
 * strength; `strengthOverride` ≥ 0 replaces per-material strength — crashes
 * crumple all chassis materials alike). Rebuilds the compound collider.
 * Explosions pass strengthOverride = -1: per-material rule, but capped at
 * DENT_STRENGTH — a car body is sheet metal, not a solid ingot, so a bomb
 * (power 5) still crumples a MAT_METAL (strength 8) chassis.
 */
export function damageVehicleSphere(
  sim: Sim,
  phys: PhysicsWorld,
  v: VehicleEntity,
  wx: number,
  wy: number,
  wz: number,
  rMeters: number,
  power: number,
  strengthOverride = -1,
): number {
  const [lx, ly, lz] = worldToLocal(v, wx, wy, wz)
  const { grid, sx, sy, sz } = v
  let removed = 0
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const m = grid[x + z * sx + y * sx * sz]
        if (m === 0) continue
        const ddx = (x + 0.5) * VOXEL_SIZE - lx
        const ddy = (y + 0.5) * VOXEL_SIZE - ly
        const ddz = (z + 0.5) * VOXEL_SIZE - lz
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        if (d > rMeters) continue
        const falloff = 1 - d / rMeters
        const strength =
          strengthOverride >= 0 ? strengthOverride : Math.min(material(m).strength, DENT_STRENGTH)
        if (falloff * power >= strength) {
          grid[x + z * sx + y * sx * sz] = 0
          removed++
          v.count--
        }
      }
    }
  }
  if (removed === 0) return 0
  v.version++
  if (v.count <= 0 || v.count < v.initialCount * WRECK_FRACTION) {
    convertToWreck(sim, phys, v)
    return removed
  }
  rebuildVehicleShape(phys, v)
  return removed
}

/** rebuild the chassis compound (post-damage), keeping the lowered COM */
function rebuildVehicleShape(phys: PhysicsWorld, v: VehicleEntity): void {
  const api = phys.api
  const boxes = greedyBoxes(v.grid, v.sx, v.sy, v.sz)
  if (boxes.length === 0) return // caller handles empty via wreck/despawn
  const inner = phys.buildBoxesShape(boxes)
  const comOffset = new api.Vec3(0, -COM_DROP, 0)
  const shape = new api.OffsetCenterOfMassShape(inner, comOffset)
  api.destroy(comOffset)
  phys.bodyInterface.SetShape((v.body as Jolt.Body).GetID(), shape, false, api.EActivation_Activate)
  ;(v.body as Jolt.Body).GetMotionProperties().SetInverseMass(1 / Math.max(v.mass, 1))
}

/**
 * Break a wheel off: physics wheel collapses (tiny radius, no steer, no
 * grip — the corner drags and handling degrades), a small metal debris body
 * flies off at the wheel's world position.
 */
export function breakWheel(sim: Sim, phys: PhysicsWorld, v: VehicleEntity, index: number): void {
  const w = v.wheels[index]
  if (w.broken) return
  w.broken = true
  const ws = phys.api.castObject(v.constraint.GetWheel(index).GetSettings(), phys.api.WheelSettingsWV)
  ws.mRadius = 0.06
  ws.mMaxSteerAngle = 0
  ws.mMaxBrakeTorque = 0
  ws.mMaxHandBrakeTorque = 0
  // kill the tire grip: flat near-zero friction curves
  ws.mLongitudinalFriction.Clear()
  ws.mLongitudinalFriction.AddPoint(0, 0.05)
  ws.mLongitudinalFriction.AddPoint(1, 0.05)
  ws.mLateralFriction.Clear()
  ws.mLateralFriction.AddPoint(0, 0.05)
  ws.mLateralFriction.AddPoint(3, 0.05)

  // debris: a 2×2×2 metal clump at the wheel's world position
  const [rx, ry, rz] = quatRotate(v.qx, v.qy, v.qz, v.qw, w.x, w.y - w.suspension, w.z)
  const cx = Math.floor((v.px + rx) / VOXEL_SIZE)
  const cy = Math.floor((v.py + ry) / VOXEL_SIZE)
  const cz = Math.floor((v.pz + rz) / VOXEL_SIZE)
  const voxels = []
  for (let y = 0; y < 2; y++)
    for (let z = 0; z < 2; z++)
      for (let x = 0; x < 2; x++) voxels.push({ x: cx + x, y: cy + y + 2, z: cz + z, mat: MAT_METAL })
  const debris = phys.spawnDebrisBody(sim, voxels)
  // side fling: outward from the vehicle center line (debris layer may decline
  // the spawn under its local cap, V17a — no PRNG draws depend on this branch)
  const side = w.x < (v.sx * VOXEL_SIZE) / 2 ? -1 : 1
  const [fx, , fz] = quatRotate(v.qx, v.qy, v.qz, v.qw, side, 0, 0)
  if (debris) phys.setBodyVelocity(debris, v.vx + fx * 4, 3, v.vz + fz * 4, 6, 2, 6)

  sim.emit(asSimEvent({ kind: 'vehicle_wheel_loss', vehicleId: v.id, x: v.px + rx, y: v.py + ry, z: v.pz + rz }))
}

/**
 * Vehicle → plain DynamicBody wreck: constraint + controller removed, the
 * SAME entity (same Jolt body, same id) moves into phys.bodies. BodyMeshes
 * picks it up automatically; VehicleMeshes drops it (id gone from vehicles).
 * Occupants are ejected through the normal exit-clearance path.
 */
export function convertToWreck(sim: Sim, phys: PhysicsWorld, v: VehicleEntity): void {
  for (const pid of v.occupants) {
    if (pid === 0) continue
    const p = phys.players.get(pid)
    if (p) exitVehicle(sim, phys, p)
  }
  removeVehicleConstraint(phys, v)
  phys.vehicles.delete(v.id)
  if (v.count <= 0 || greedyBoxes(v.grid, v.sx, v.sy, v.sz).length === 0) {
    // nothing left — despawn the body outright
    phys.bodyInterface.RemoveBody((v.body as Jolt.Body).GetID())
    phys.bodyInterface.DestroyBody((v.body as Jolt.Body).GetID())
    phys.removedVehicles++
    return
  }
  v.version++
  phys.bodies.set(v.id, v) // VehicleEntity IS a DynamicBody
}

/** kill-plane / dispose removal: occupants unseated in place, body destroyed */
export function despawnVehicle(sim: Sim, phys: PhysicsWorld, v: VehicleEntity): void {
  for (const pid of v.occupants) {
    if (pid === 0) continue
    const p = phys.players.get(pid)
    if (p) unseatPlayer(phys, p, v.px, v.py + v.sy * VOXEL_SIZE + 0.2, v.pz)
  }
  removeVehicleConstraint(phys, v)
  phys.vehicles.delete(v.id)
  phys.bodyInterface.RemoveBody((v.body as Jolt.Body).GetID())
  phys.bodyInterface.DestroyBody((v.body as Jolt.Body).GetID())
  phys.removedVehicles++
}

function removeVehicleConstraint(phys: PhysicsWorld, v: VehicleEntity): void {
  phys.physicsSystem.RemoveStepListener(v.stepListener)
  phys.api.destroy(v.stepListener)
  // RemoveConstraint releases the system's ref — the constraint frees itself.
  phys.physicsSystem.RemoveConstraint(v.constraint)
}

/**
 * Explosion damage to vehicles (called from PhysicsWorld.damageBodiesSphere,
 * additive). Per-material strength rule — same as world/bodies. Coordinates
 * in meters. Deterministic id order.
 */
export function damageVehiclesSphere(
  sim: Sim,
  phys: PhysicsWorld,
  wx: number,
  wy: number,
  wz: number,
  rMeters: number,
  power: number,
): void {
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const v = phys.vehicles.get(id)
    if (!v) continue
    const hx = v.px + (v.sx * VOXEL_SIZE) / 2 - wx
    const hy = v.py + (v.sy * VOXEL_SIZE) / 2 - wy
    const hz = v.pz + (v.sz * VOXEL_SIZE) / 2 - wz
    const reach = rMeters + (Math.sqrt(v.sx * v.sx + v.sy * v.sy + v.sz * v.sz) * VOXEL_SIZE) / 2
    if (hx * hx + hy * hy + hz * hz > reach * reach) continue
    damageVehicleSphere(sim, phys, v, wx, wy, wz, rMeters, power)
  }
}

// ---------------------------------------------------------------------------
// ops (V1) + hash
// ---------------------------------------------------------------------------

export function registerVehicleOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('vehicle_spawn', (s, cmd) => {
    const { archetype, x, y, z, yaw } = cmd.op
    spawnVehicle(s, phys, archetype, x, y, z, yaw)
  })
  sim.onOp('vehicle_enter', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    if (!p) throw new Error(`vehicle_enter for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    enterVehicle(s, phys, p)
  })
  sim.onOp('vehicle_exit', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    if (!p) throw new Error(`vehicle_exit for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    if (p.seatedVehicle === 0) return // not seated — idempotent no-op
    exitVehicle(s, phys, p)
  })
}

/** I.hash extension — called from hashPhysics (physics.ts). Ids ascending. */
export function hashVehicles(h: { u8(v: number): unknown; u32(v: number): unknown; f64(v: number): unknown; bytes(b: Uint8Array): unknown }, phys: PhysicsWorld): void {
  h.u32(phys.vehicles.size)
  h.u32(phys.removedVehicles)
  const ids = [...phys.vehicles.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const v = phys.vehicles.get(id)!
    h.u32(id)
    h.f64(v.px)
    h.f64(v.py)
    h.f64(v.pz)
    h.f64(v.qx)
    h.f64(v.qy)
    h.f64(v.qz)
    h.f64(v.qw)
    h.f64(v.vx)
    h.f64(v.vy)
    h.f64(v.vz)
    h.f64(v.rpm)
    h.u32(v.count)
    h.u32(v.crashCooldown)
    h.bytes(v.grid)
    for (const pid of v.occupants) h.u32(pid)
    for (const w of v.wheels) {
      h.u8(w.broken ? 1 : 0)
      h.u8(w.hits)
      h.f64(w.rotation)
      h.f64(w.steer)
      h.f64(w.suspension)
      h.f64(w.angularVelocity)
    }
  }
}

/** test/dispose helper — tears down all vehicles without hash side effects */
export function disposeVehicles(phys: PhysicsWorld): void {
  for (const v of [...phys.vehicles.values()]) {
    removeVehicleConstraint(phys, v)
    phys.vehicles.delete(v.id)
    phys.bodyInterface.RemoveBody((v.body as Jolt.Body).GetID())
    phys.bodyInterface.DestroyBody((v.body as Jolt.Body).GetID())
  }
}
