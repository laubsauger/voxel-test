/**
 * P17 [V] — flyable plane: arcade aircraft as a deterministic sim entity.
 *
 * Mirrors src/sim/vehicle.ts (the drivable-vehicle template) but for flight.
 * Design differences from wheeled vehicles:
 *   - No Jolt VehicleConstraint / wheels. The plane is a plain dynamic body
 *     with mGravityFactor = 0; the arcade flight model sets its linear +
 *     angular velocity every tick INSIDE the sim step (fixed DT). Jolt still
 *     resolves collisions, so ramming a building slashes the velocity and the
 *     post-step crash detector fires — the same "big physical impact" the
 *     cars get (damageAircraftSphere on the chassis + destroySphere on the
 *     world, momentum-scaled).
 *   - AircraftEntity extends DynamicBody (same local corner-origin frame), so
 *     a wrecked plane converts to a plain body wreck by moving the SAME entity
 *     into phys.bodies (V8 id kept) and re-enabling gravity — and the render
 *     layer draws it with BodyMeshes for free (phys.aircraft is a
 *     Map<number, DynamicBody> structurally).
 *
 * Determinism (V2/V3): every flight law is a pure function of hashed sim state
 * (mirrored quaternion/velocity from last tick, the pilot's move-op input bits,
 * a hashed throttle scalar, DT and constants) — no wall clock, no ambient RNG,
 * no dates. Jolt runs single-threaded + mDeterministicSimulation. All aircraft
 * state is folded into the physics hash via hashAircraft (physics.ts). Fixed
 * iteration order everywhere: ascending entity id.
 *
 * Controls (arcade, forgiving — mapped from the existing move-op bitfield):
 *   W / S  (FWD / BACK)   — throttle up / down
 *   A / D  (LEFT / RIGHT) — turn (yaw + a cosmetic bank), wings auto-level
 *   Space  (JUMP)         — pitch nose up (climb)
 *   Ctrl   (CROUCH)       — pitch nose down (dive)
 * Above takeoff speed the plane generates lift and climbs; below stall speed
 * lift bleeds out and it sinks (glide/stall) — so a runway roll is needed to
 * get airborne.
 */
import { DT, type Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { MAT_GLASS, MAT_METAL, MAT_PLASTER, material } from './materials'
import { greedyBoxes } from './greedy-boxes'
import { destroySphere } from './destruction'
import type { VoxelGrid } from './vox/remap'
import type { DynamicBody, PhysicsWorld } from './physics'
import {
  INPUT_BACK,
  INPUT_CROUCH,
  INPUT_FWD,
  INPUT_JUMP,
  INPUT_LEFT,
  INPUT_RIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  type PlayerEntity,
} from './player'

// ---------------------------------------------------------------------------
// tuning — arcade flight, forgiving and fun (not aerodynamics)
// ---------------------------------------------------------------------------

/** top forward airspeed (m/s ≈ 160 km/h) */
export const AIRCRAFT_MAX_SPEED = 45
/** throttle change per second (W/S) — ~1.8 s from idle to full */
const THROTTLE_RATE = 0.55
/** below this forward speed lift is fully gone (the plane sinks / stalls) */
const STALL_SPEED = 12
/** at/above this forward speed lift is full (nose fully controls climb/dive) */
const TAKEOFF_SPEED = 22
/** gentle automatic climb once airborne so a level nose still lifts off */
const AUTO_CLIMB = 2.0
/** body-frame angular rates (rad/s) */
const PITCH_RATE = 0.9
const YAW_RATE = 0.55
/** auto-leveling gain that rolls the wings back to horizontal */
const ROLL_LEVEL_GAIN = 2.2
/** cosmetic bank rate coupled into a turn */
const BANK_RATE = 0.5
/** authored mass (kg) — a small Cessna-class plane */
const AIRCRAFT_MASS = 1000
const GRAVITY_Y = -9.81

/** max distance (m) from the player to a seat for aircraft_enter */
export const ENTER_RANGE_AIR = 5.5

// --- crash (mirrors the vehicle crash contract) ------------------------------
/** one-tick velocity change (m/s) that reads as a crash impact */
const CRASH_DV = 6
/** minimum pre-impact speed for any crash response (soft touchdowns are free) */
const CRASH_MIN_SPEED = 5
/** ticks between crash responses per aircraft (hashed) */
const CRASH_COOLDOWN_TICKS = 10
/** planes are thin sheet metal/plaster: uniform strength for chassis removal */
const AIRCRAFT_DENT_STRENGTH = 2.5
/** live-voxel fraction under which the plane becomes a plain wreck body */
export const AIRCRAFT_WRECK_FRACTION = 0.4
/** kill-plane (matches the T40 body rule) */
const KILL_PLANE_Y = -10

// --- authored voxel model (local corner-origin, forward = -z, up = +y) -------
/** half wingspan in voxels (full span = 2*HALFSPAN+1) */
const HALFSPAN = 40
/** fuselage length in voxels (nose at local z=0, tail at z=LEN-1) */
export const AIRCRAFT_LEN = 70
/** fuselage bottom height above the gear (local voxels) */
const BASE = 3

// ---------------------------------------------------------------------------
// entity
// ---------------------------------------------------------------------------

export interface Seat {
  x: number
  y: number
  z: number
}

/**
 * AircraftEntity IS a DynamicBody (same corner-origin frame) plus the flight
 * state — wreck conversion moves it into phys.bodies as-is.
 */
export interface AircraftEntity extends DynamicBody {
  /** live voxel count at spawn — wreck threshold base */
  initialCount: number
  seats: Seat[]
  /** playerId per seat (0 = empty), index-aligned with seats */
  occupants: number[]
  /** chassis velocity mirrored post-step (hashed; crash detection + audio) */
  vx: number
  vy: number
  vz: number
  /** throttle 0..1 (hashed) — engine power; drives target airspeed */
  throttle: number
  /** ticks until the next crash response is allowed (hashed) */
  crashCooldown: number
}

// ---------------------------------------------------------------------------
// voxel model
// ---------------------------------------------------------------------------

function planeIndex(g: VoxelGrid, x: number, z: number, y: number): number {
  return x + z * g.sx + y * g.sx * g.sz
}

/** fill a local box (inclusive), clipped to the grid */
function gfill(g: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
  const cx0 = Math.max(0, x0)
  const cy0 = Math.max(0, y0)
  const cz0 = Math.max(0, z0)
  const cx1 = Math.min(g.sx - 1, x1)
  const cy1 = Math.min(g.sy - 1, y1)
  const cz1 = Math.min(g.sz - 1, z1)
  for (let y = cy0; y <= cy1; y++)
    for (let z = cz0; z <= cz1; z++)
      for (let x = cx0; x <= cx1; x++) g.mats[planeIndex(g, x, z, y)] = m
}

/** cross-section at fuselage station i (z=i), half-width w about the center x */
function along(g: VoxelGrid, cx: number, i: number, w: number, y0: number, y1: number, m: number): void {
  gfill(g, cx - w, y0, i, cx + w, y1, i, m)
}

let planeGridCache: VoxelGrid | undefined

/**
 * Small high-wing Cessna-style plane — the same silhouette as the stamped
 * airport prop (stamper.stampPlane) but authored in local corner-origin space
 * with forward = -z, plus a tricycle landing gear so it rests upright.
 * Cached (pure data, V2). ~7 m fuselage, ~8 m wingspan.
 */
export function buildPlaneGrid(): VoxelGrid {
  if (planeGridCache) return planeGridCache
  const sx = 2 * HALFSPAN + 1
  const sz = AIRCRAFT_LEN
  const sy = BASE + 16
  const g: VoxelGrid = { sx, sy, sz, mats: new Uint8Array(sx * sy * sz) }
  const cx = HALFSPAN
  const b = BASE

  // fuselage tube (tapered nose + tail)
  for (let i = 0; i < 70; i++) {
    const taper = i < 8 ? 2 + Math.floor(i / 2) : i > 58 ? 2 + Math.floor((70 - i) / 4) : 5
    along(g, cx, i, taper, b, b + taper * 2, MAT_PLASTER)
  }
  // high wing across the top of the cabin (full span)
  for (let i = 18; i <= 26; i++) along(g, cx, i, HALFSPAN, b + 9, b + 10, MAT_METAL)
  // vertical tail fin + horizontal stabiliser
  for (let i = 61; i <= 68; i++) along(g, cx, i, 1, b + 5, b + 15, MAT_METAL)
  for (let i = 62; i <= 67; i++) along(g, cx, i, 12, b + 4, b + 5, MAT_METAL)
  // spinner/prop at the nose + cockpit greenhouse
  along(g, cx, 0, 2, b + 2, b + 6, MAT_METAL)
  along(g, cx, 13, 3, b + 5, b + 8, MAT_GLASS)
  // tricycle landing gear (two mains under the wing + a nose leg) — rests upright
  gfill(g, cx - 8, 0, 20, cx - 6, b - 1, 22, MAT_METAL)
  gfill(g, cx + 6, 0, 20, cx + 8, b - 1, 22, MAT_METAL)
  gfill(g, cx - 1, 0, 6, cx + 1, b - 1, 8, MAT_METAL)

  planeGridCache = g
  return g
}

/** pilot seat in the cockpit (local meters, corner-origin frame) */
function pilotSeat(): Seat {
  return { x: HALFSPAN * VOXEL_SIZE, y: (BASE + 4) * VOXEL_SIZE, z: 13 * VOXEL_SIZE }
}

// ---------------------------------------------------------------------------
// math helpers (local — mirror vehicle.ts conventions)
// ---------------------------------------------------------------------------

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

/** world meters → aircraft-local meters (corner-origin frame) */
function worldToLocal(a: AircraftEntity, wx: number, wy: number, wz: number): [number, number, number] {
  return quatRotate(-a.qx, -a.qy, -a.qz, a.qw, wx - a.px, wy - a.py, wz - a.pz)
}

/** seat position in world meters */
export function seatWorldPos(a: AircraftEntity, seatIndex: number): [number, number, number] {
  const s = a.seats[seatIndex]
  const [rx, ry, rz] = quatRotate(a.qx, a.qy, a.qz, a.qw, s.x, s.y, s.z)
  return [a.px + rx, a.py + ry, a.pz + rz]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a flyable aircraft. (cx, cy, cz) = footprint center in world meters,
 * cy = ground surface under the gear; yaw about +Y (0 = nose faces -z, the
 * three.js YXZ convention shared with vehicles). Deterministic (V8 id).
 */
export function spawnAircraft(
  sim: Sim,
  phys: PhysicsWorld,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
): AircraftEntity {
  const api = phys.api
  const src = buildPlaneGrid()
  const { sx, sy, sz } = src
  const grid = src.mats.slice() // entity owns (and dents) its grid

  let count = 0
  const matCounts = new Uint32Array(256)
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== 0) {
      count++
      matCounts[grid[i]]++
    }
  }
  let mat = MAT_PLASTER
  let best = 0
  for (let m = 1; m < 256; m++) {
    if (matCounts[m] > best) {
      best = matCounts[m]
      mat = m
    }
  }

  const shape = phys.buildBoxesShape(greedyBoxes(grid, sx, sy, sz))

  // body position: rotate the corner-origin offset by yaw around the center
  // (identical convention to spawnVehicle so gen mapping is shared)
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
  bcs.mMassPropertiesOverride.mMass = AIRCRAFT_MASS
  bcs.mFriction = 0.4
  bcs.mRestitution = 0.05
  bcs.mAngularDamping = 0.4
  bcs.mGravityFactor = 0 // arcade flight controls the vertical explicitly (V2)
  bcs.mMaxLinearVelocity = AIRCRAFT_MAX_SPEED + 20
  bcs.mMaxAngularVelocity = 6
  const body = phys.bodyInterface.CreateBody(bcs)
  phys.bodyInterface.AddBody(body.GetID(), api.EActivation_Activate)
  api.destroy(bcs)
  api.destroy(pos)
  api.destroy(rot)

  const id = sim.allocEntityId()
  body.SetUserData(id)
  const entity: AircraftEntity = {
    id,
    sx,
    sy,
    sz,
    grid,
    count,
    mass: AIRCRAFT_MASS,
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
    initialCount: count,
    seats: [pilotSeat()],
    occupants: [0],
    vx: 0,
    vy: 0,
    vz: 0,
    throttle: 0,
    crashCooldown: 0,
  }
  phys.aircraft.set(id, entity)
  return entity
}

// ---------------------------------------------------------------------------
// enter / exit (mirror the vehicle path)
// ---------------------------------------------------------------------------

/** true if any aircraft has a free seat within ENTER_RANGE_AIR of the player */
export function nearestAircraftInRange(phys: PhysicsWorld, p: PlayerEntity): boolean {
  if (phys.aircraft.size === 0) return false
  const pcx = p.px
  const pcy = p.py + 0.9
  const pcz = p.pz
  for (const id of [...phys.aircraft.keys()].sort((a, b) => a - b)) {
    const a = phys.aircraft.get(id)!
    for (let si = 0; si < a.seats.length; si++) {
      if (a.occupants[si] !== 0) continue
      const [sx, sy, sz] = seatWorldPos(a, si)
      if (Math.sqrt((sx - pcx) ** 2 + (sy - pcy) ** 2 + (sz - pcz) ** 2) <= ENTER_RANGE_AIR) return true
    }
  }
  return false
}

function enterAircraft(sim: Sim, phys: PhysicsWorld, p: PlayerEntity): void {
  if (p.seatedAircraft !== 0 || p.seatedVehicle !== 0) return // already riding — no-op
  // nearest aircraft (by center distance) with a free in-range seat; ascending
  // id iteration + strict comparison for determinism (V2).
  let bestA: AircraftEntity | undefined
  let bestSeat = -1
  let bestD = Infinity
  const pcx = p.px
  const pcy = p.py + 0.9
  const pcz = p.pz
  for (const id of [...phys.aircraft.keys()].sort((a, b) => a - b)) {
    const a = phys.aircraft.get(id)!
    let seat = -1
    for (let si = 0; si < a.seats.length; si++) {
      if (a.occupants[si] !== 0) continue
      const [sx, sy, sz] = seatWorldPos(a, si)
      if (Math.sqrt((sx - pcx) ** 2 + (sy - pcy) ** 2 + (sz - pcz) ** 2) <= ENTER_RANGE_AIR) {
        seat = si
        break
      }
    }
    if (seat < 0) continue
    const [rx, ry, rz] = quatRotate(a.qx, a.qy, a.qz, a.qw, (a.sx * VOXEL_SIZE) / 2, (a.sy * VOXEL_SIZE) / 2, (a.sz * VOXEL_SIZE) / 2)
    const d = Math.sqrt((a.px + rx - pcx) ** 2 + (a.py + ry - pcy) ** 2 + (a.pz + rz - pcz) ** 2)
    if (d < bestD) {
      bestD = d
      bestA = a
      bestSeat = seat
    }
  }
  if (!bestA) return
  bestA.occupants[bestSeat] = p.playerId
  p.seatedAircraft = bestA.id
  p.aircraftSeat = bestSeat
  syncSeatedPilot(phys, bestA, p)
  sim.emit({ kind: 'vehicle_door', vehicleId: bestA.id, enter: 1, x: p.px, y: p.py, z: p.pz })
}

/** capsule-sized voxel AABB probe at a candidate exit spot (feet position) */
function exitSpotClear(sim: Sim, x: number, y: number, z: number): boolean {
  const x0 = Math.floor((x - PLAYER_RADIUS) / VOXEL_SIZE)
  const x1 = Math.floor((x + PLAYER_RADIUS) / VOXEL_SIZE)
  const z0 = Math.floor((z - PLAYER_RADIUS) / VOXEL_SIZE)
  const z1 = Math.floor((z + PLAYER_RADIUS) / VOXEL_SIZE)
  const y0 = Math.floor((y + 0.05) / VOXEL_SIZE)
  const y1 = Math.floor((y + PLAYER_HEIGHT) / VOXEL_SIZE)
  for (let vy = y0; vy <= y1; vy++)
    for (let vz = z0; vz <= z1; vz++)
      for (let vx = x0; vx <= x1; vx++) if (sim.world.getVoxel(vx, vy, vz) !== 0) return false
  return true
}

function exitAircraft(sim: Sim, phys: PhysicsWorld, p: PlayerEntity): void {
  const a = phys.aircraft.get(p.seatedAircraft)
  if (!a) {
    unseatPlayer(phys, p, p.px, p.py, p.pz)
    return
  }
  const si = p.aircraftSeat
  a.occupants[si] = 0
  const seat = a.seats[si]
  const width = a.sx * VOXEL_SIZE
  const out = width / 2 + PLAYER_RADIUS + 0.4
  const half = width / 2
  // door-side first, then the other side, behind, in front, then on top
  const candidates: [number, number, number][] = [
    [half - out, 0, seat.z],
    [half + out, 0, seat.z],
    [half, 0, a.sz * VOXEL_SIZE + 1.0],
    [half, 0, -1.0],
    [half, a.sy * VOXEL_SIZE + 0.2, seat.z],
  ]
  let placed = false
  for (const [lx, ly, lz] of candidates) {
    const [rx, ry, rz] = quatRotate(a.qx, a.qy, a.qz, a.qw, lx, ly, lz)
    const wx = a.px + rx
    const wy = a.py + ry
    const wz = a.pz + rz
    if (exitSpotClear(sim, wx, wy, wz)) {
      unseatPlayer(phys, p, wx, wy, wz)
      placed = true
      break
    }
  }
  if (!placed) unseatPlayer(phys, p, a.px, a.py + a.sy * VOXEL_SIZE + 0.2, a.pz)
  sim.emit({ kind: 'vehicle_door', vehicleId: a.id, enter: 0, x: p.px, y: p.py, z: p.pz })
}

function unseatPlayer(phys: PhysicsWorld, p: PlayerEntity, x: number, y: number, z: number): void {
  p.seatedAircraft = 0
  p.aircraftSeat = 0
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

/** seated pilot parks at the seat; velocity mirrors the plane (audio/anim) */
function syncSeatedPilot(phys: PhysicsWorld, a: AircraftEntity, p: PlayerEntity): void {
  const [sx, sy, sz] = seatWorldPos(a, p.aircraftSeat)
  p.px = sx
  p.py = sy - 0.9 // seat is at torso height; capsule origin is the feet
  p.pz = sz
  p.vx = a.vx
  p.vy = a.vy
  p.vz = a.vz
  const pos = new phys.api.RVec3(p.px, p.py, p.pz)
  p.char.SetPosition(pos)
  phys.api.destroy(pos)
}

// ---------------------------------------------------------------------------
// per-tick systems (called from PhysicsWorld.tick, fixed order)
// ---------------------------------------------------------------------------

/**
 * BEFORE the Jolt step: map the pilot's move-op bits to the arcade flight
 * model and set the body's linear + angular velocity. Pure function of hashed
 * sim state + DT (V2). Ascending id order.
 */
export function tickAircraftPreStep(phys: PhysicsWorld): void {
  if (phys.aircraft.size === 0) return
  const api = phys.api
  for (const id of [...phys.aircraft.keys()].sort((a, b) => a - b)) {
    const a = phys.aircraft.get(id)!
    const pilot = a.occupants[0] !== 0 ? phys.players.get(a.occupants[0]) : undefined

    let throttleInput = 0
    let pitchInput = 0
    let turnInput = 0
    if (pilot) {
      const bits = pilot.input
      if (bits & INPUT_FWD) throttleInput += 1
      if (bits & INPUT_BACK) throttleInput -= 1
      if (bits & INPUT_JUMP) pitchInput += 1 // nose up
      if (bits & INPUT_CROUCH) pitchInput -= 1 // nose down
      if (bits & INPUT_RIGHT) turnInput += 1
      if (bits & INPUT_LEFT) turnInput -= 1
      phys.bodyInterface.ActivateBody(a.body.GetID())
      a.throttle = clamp01(a.throttle + throttleInput * THROTTLE_RATE * DT)
    } else {
      // no pilot: engine spools down, plane coasts to a stop / rests on gear
      a.throttle = Math.max(0, a.throttle - THROTTLE_RATE * DT)
    }

    // orientation basis from the mirrored quaternion (last tick's readback)
    const [fx, fy, fz] = quatRotate(a.qx, a.qy, a.qz, a.qw, 0, 0, -1) // nose (forward)
    const [, ry] = quatRotate(a.qx, a.qy, a.qz, a.qw, 1, 0, 0) // right wing (only y needed)

    // commanded airspeed = the (already smoothly-ramped) throttle. We drive
    // velocity directly rather than off the measured speed: on the runway the
    // gear contact would otherwise keep bleeding the measured velocity and
    // stall the takeoff roll. This is the arcade/forgiving choice — collisions
    // still slash the real velocity (Jolt), which the post-step crash detector
    // reads as an impact.
    const newFwd = a.throttle * AIRCRAFT_MAX_SPEED
    const liftFrac = clamp01((newFwd - STALL_SPEED) / (TAKEOFF_SPEED - STALL_SPEED))
    const gravFall = a.vy + GRAVITY_Y * DT
    const nvx = fx * newFwd
    const nvz = fz * newFwd
    // vertical: nose-controlled lift when fast, gravity when slow (glide/stall)
    const nvy = fy * newFwd * liftFrac + gravFall * (1 - liftFrac) + AUTO_CLIMB * liftFrac

    // body-frame angular rates: pitch about right, yaw about up, roll about back
    const wPitch = pitchInput * PITCH_RATE
    const wYaw = -turnInput * YAW_RATE
    // B37 — bank sign flipped: a coordinated LEFT turn banks LEFT (left wing
    // down). The old `+turnInput` rolled the plane the wrong way (into an
    // uncoordinated outward bank) — read as inverted steering.
    const wRoll = -ry * ROLL_LEVEL_GAIN - turnInput * BANK_RATE
    const [awx, awy, awz] = quatRotate(a.qx, a.qy, a.qz, a.qw, wPitch, wYaw, wRoll)

    const nv = new api.Vec3(nvx, nvy, nvz)
    const nw = new api.Vec3(awx, awy, awz)
    phys.bodyInterface.SetLinearAndAngularVelocity(a.body.GetID(), nv, nw)
    api.destroy(nv)
    api.destroy(nw)
  }
}

/**
 * AFTER the Jolt step: mirror transforms/velocity, run crash detection (world
 * + chassis voxel damage), kill-plane, wreck conversion, seat sync. Fixed
 * order: ascending entity id (V2).
 */
export function tickAircraftPostStep(sim: Sim, phys: PhysicsWorld): void {
  if (phys.aircraft.size === 0) return
  for (const id of [...phys.aircraft.keys()].sort((a, b) => a - b)) {
    const a = phys.aircraft.get(id)!
    const pvx = a.vx
    const pvy = a.vy
    const pvz = a.vz

    const pos = a.body.GetPosition()
    a.px = pos.GetX()
    a.py = pos.GetY()
    a.pz = pos.GetZ()
    const rot = a.body.GetRotation()
    a.qx = rot.GetX()
    a.qy = rot.GetY()
    a.qz = rot.GetZ()
    a.qw = rot.GetW()
    const vel = a.body.GetLinearVelocity()
    a.vx = vel.GetX()
    a.vy = vel.GetY()
    a.vz = vel.GetZ()

    if (a.crashCooldown > 0) a.crashCooldown--

    // crash detection: a big one-tick velocity slash = a solid impact. No
    // gravity correction needed (gravityFactor 0 → we own the vertical, so a
    // glide/stall changes velocity only gently, well under the threshold).
    const prevSpeed = Math.sqrt(pvx * pvx + pvy * pvy + pvz * pvz)
    const dvx = a.vx - pvx
    const dvy = a.vy - pvy
    const dvz = a.vz - pvz
    const dv = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz)
    if (dv >= CRASH_DV && prevSpeed >= CRASH_MIN_SPEED && a.crashCooldown === 0) {
      a.crashCooldown = CRASH_COOLDOWN_TICKS
      handleCrash(sim, phys, a, pvx, pvy, pvz, prevSpeed, dv)
      if (!phys.aircraft.has(id)) continue // crash wrecked it
    }

    if (a.py < KILL_PLANE_Y) {
      despawnAircraft(sim, phys, a)
      continue
    }

    if (a.count < a.initialCount * AIRCRAFT_WRECK_FRACTION) {
      convertToWreck(sim, phys, a)
      continue
    }

    for (const pid of a.occupants) {
      if (pid === 0) continue
      const p = phys.players.get(pid)
      if (p) syncSeatedPilot(phys, a, p)
    }
  }
}

/**
 * Crash response (analogous to the vehicle crash): march along the pre-impact
 * travel direction for the first solid world voxel, tear into it with a
 * momentum-scaled destroySphere (a house hit hard is chewed open — same path
 * as explosions, so unsupported structure collapses next structural pass),
 * dent the chassis grid at the contact, and emit the crash event (reuses the
 * vehicle_crash SFX/FX hook). Deterministic: pure function of tick state.
 */
function handleCrash(
  sim: Sim,
  phys: PhysicsWorld,
  a: AircraftEntity,
  prevVx: number,
  prevVy: number,
  prevVz: number,
  prevSpeed: number,
  dv: number,
): void {
  const dx = prevVx / prevSpeed
  const dy = prevVy / prevSpeed
  const dz = prevVz / prevSpeed
  // chassis center, world
  const [rx, ry, rz] = quatRotate(a.qx, a.qy, a.qz, a.qw, (a.sx * VOXEL_SIZE) / 2, (a.sy * VOXEL_SIZE) / 2, (a.sz * VOXEL_SIZE) / 2)
  const ox = a.px + rx
  const oy = a.py + ry
  const oz = a.pz + rz
  // march for the first solid world voxel along the travel direction
  const halfDiag = (Math.sqrt(a.sx * a.sx + a.sy * a.sy + a.sz * a.sz) * VOXEL_SIZE) / 2
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
  const large = dv >= CRASH_DV * 2

  // momentum-scaled world bite: heavier + faster ⇒ bigger tear
  if (hit) {
    const massScale = 0.6 + 0.4 * (a.mass / 1800)
    const r = Math.min(5, Math.max(1.5, dv * 0.35 * massScale))
    const power = Math.min(8, dv * 0.55 * massScale)
    destroySphere(sim, hx / VOXEL_SIZE, hy / VOXEL_SIZE, hz / VOXEL_SIZE, r, power)
  }

  // chassis dent at the contact: uniform sheet strength
  const dentR = Math.min(1.2, Math.max(0.35, dv * 0.08))
  damageAircraftSphere(sim, phys, a, hx, hy, hz, dentR, dv * 0.6, AIRCRAFT_DENT_STRENGTH)

  sim.emit({ kind: 'vehicle_crash', vehicleId: a.id, x: hx, y: hy, z: hz, dv, large: large ? 1 : 0 })
}

/**
 * Remove chassis voxels inside a world-space sphere (falloff·power ≥ strength;
 * strengthOverride replaces per-material strength). Rebuilds the compound
 * collider; converts to a wreck body past the wreck fraction. Deterministic
 * (fixed y→z→x scan).
 */
export function damageAircraftSphere(
  sim: Sim,
  phys: PhysicsWorld,
  a: AircraftEntity,
  wx: number,
  wy: number,
  wz: number,
  rMeters: number,
  power: number,
  strengthOverride = -1,
): number {
  const [lx, ly, lz] = worldToLocal(a, wx, wy, wz)
  const { grid, sx, sy, sz } = a
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
          strengthOverride >= 0 ? strengthOverride : Math.min(material(m).strength, AIRCRAFT_DENT_STRENGTH)
        if (falloff * power >= strength) {
          grid[x + z * sx + y * sx * sz] = 0
          removed++
          a.count--
        }
      }
    }
  }
  if (removed === 0) return 0
  a.version++
  if (a.count <= 0 || a.count < a.initialCount * AIRCRAFT_WRECK_FRACTION) {
    convertToWreck(sim, phys, a)
    return removed
  }
  rebuildAircraftShape(phys, a)
  return removed
}

/** rebuild the chassis compound (post-damage) */
function rebuildAircraftShape(phys: PhysicsWorld, a: AircraftEntity): void {
  const boxes = greedyBoxes(a.grid, a.sx, a.sy, a.sz)
  if (boxes.length === 0) return // caller handles empty via wreck/despawn
  const shape = phys.buildBoxesShape(boxes)
  phys.bodyInterface.SetShape(a.body.GetID(), shape, false, phys.api.EActivation_Activate)
  a.body.GetMotionProperties().SetInverseMass(1 / Math.max(a.mass, 1))
}

/**
 * Aircraft → plain DynamicBody wreck: gravity re-enabled (flight control
 * stops), the SAME entity (same Jolt body, same id) moves into phys.bodies.
 * BodyMeshes picks it up automatically. Occupants are ejected.
 */
export function convertToWreck(sim: Sim, phys: PhysicsWorld, a: AircraftEntity): void {
  for (const pid of a.occupants) {
    if (pid === 0) continue
    const p = phys.players.get(pid)
    if (p) exitAircraft(sim, phys, p)
  }
  phys.aircraft.delete(a.id)
  if (a.count <= 0 || greedyBoxes(a.grid, a.sx, a.sy, a.sz).length === 0) {
    phys.bodyInterface.RemoveBody(a.body.GetID())
    phys.bodyInterface.DestroyBody(a.body.GetID())
    phys.removedAircraft++
    return
  }
  phys.bodyInterface.SetGravityFactor(a.body.GetID(), 1) // wreck falls again
  a.version++
  phys.bodies.set(a.id, a) // AircraftEntity IS a DynamicBody
}

/** kill-plane / dispose removal: occupants unseated in place, body destroyed */
export function despawnAircraft(sim: Sim, phys: PhysicsWorld, a: AircraftEntity): void {
  for (const pid of a.occupants) {
    if (pid === 0) continue
    const p = phys.players.get(pid)
    if (p) unseatPlayer(phys, p, a.px, a.py + a.sy * VOXEL_SIZE + 0.2, a.pz)
  }
  phys.aircraft.delete(a.id)
  phys.bodyInterface.RemoveBody(a.body.GetID())
  phys.bodyInterface.DestroyBody(a.body.GetID())
  phys.removedAircraft++
}

// ---------------------------------------------------------------------------
// ops (V1) + hash
// ---------------------------------------------------------------------------

export function registerAircraftOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('aircraft_spawn', (s, cmd) => {
    const { x, y, z, yaw } = cmd.op
    spawnAircraft(s, phys, x, y, z, yaw)
  })
  sim.onOp('aircraft_enter', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    if (!p) throw new Error(`aircraft_enter for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    enterAircraft(s, phys, p)
  })
  sim.onOp('aircraft_exit', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    if (!p) throw new Error(`aircraft_exit for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    if (p.seatedAircraft === 0) return // not seated — idempotent no-op
    exitAircraft(s, phys, p)
  })
}

/** I.hash extension — called from hashPhysics (physics.ts). Ids ascending. */
export function hashAircraft(
  h: { u8(v: number): unknown; u32(v: number): unknown; f64(v: number): unknown; bytes(b: Uint8Array): unknown },
  phys: PhysicsWorld,
): void {
  h.u32(phys.aircraft.size)
  h.u32(phys.removedAircraft)
  for (const id of [...phys.aircraft.keys()].sort((a, b) => a - b)) {
    const a = phys.aircraft.get(id)!
    h.u32(id)
    h.f64(a.px)
    h.f64(a.py)
    h.f64(a.pz)
    h.f64(a.qx)
    h.f64(a.qy)
    h.f64(a.qz)
    h.f64(a.qw)
    h.f64(a.vx)
    h.f64(a.vy)
    h.f64(a.vz)
    h.f64(a.throttle)
    h.u32(a.count)
    h.u32(a.crashCooldown)
    h.bytes(a.grid)
    for (const pid of a.occupants) h.u32(pid)
  }
}

/** test/dispose helper — tears down all aircraft without hash side effects */
export function disposeAircraft(phys: PhysicsWorld): void {
  for (const a of [...phys.aircraft.values()]) {
    phys.aircraft.delete(a.id)
    phys.bodyInterface.RemoveBody(a.body.GetID())
    phys.bodyInterface.DestroyBody(a.body.GetID())
  }
}
