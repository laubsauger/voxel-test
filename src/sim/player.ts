/**
 * T21 [PL] — Jolt CharacterVirtual capsule driven by 'move' commands (I.cmd).
 *
 * Player entity lives in the sim (position/velocity/yaw hashable, V3);
 * spawned via the 'spawn' op, moved only via 'move' ops (V1). The character
 * update runs inside the physics sim system at fixed DT (V2). Render reads
 * this entity, never writes it (V6).
 *
 * Only type imports from physics.ts here (no runtime cycle — physics.ts
 * imports this module's functions).
 */
import type Jolt from 'jolt-physics'
import { DT, type Sim } from './loop'
import { VOXEL_SIZE, WORLD_VX, WORLD_VY, WORLD_VZ } from '../world/chunks'
import { MAT_FLESH, material } from './materials'
import type { PhysicsWorld } from './physics'

// MoveOp input bitfield (src/sim/commands.ts)
export const INPUT_FWD = 1
export const INPUT_BACK = 2
export const INPUT_LEFT = 4
export const INPUT_RIGHT = 8
export const INPUT_JUMP = 16
export const INPUT_CROUCH = 32
export const INPUT_SPRINT = 64

export const PLAYER_RADIUS = 0.3
/** capsule cylinder half-height; total height = 2*(HALF_CYL + RADIUS) = 1.65m
 * (B31 — dropped from 1.8m: reads better against 2.1m doors and fits the car
 * cabin with headroom to spare). Visual body scales to match, see player-mesh. */
export const PLAYER_HALF_CYL = 0.525
export const PLAYER_HEIGHT = 2 * (PLAYER_HALF_CYL + PLAYER_RADIUS)
export const EYE_HEIGHT = 1.47
/** T44 — crouched capsule: total height 1.2m (< 1.4m gaps passable) */
export const CROUCH_HALF_CYL = 0.3
export const CROUCH_HEIGHT = 2 * (CROUCH_HALF_CYL + PLAYER_RADIUS)

export const WALK_SPEED = 4
export const CROUCH_SPEED = 2
/** T44 — sprint: ground-only speed multiplier */
export const SPRINT_MULT = 1.6
export const JUMP_SPEED = 6
/** T47 — noclip fly speed (m/s); sprint bit applies SPRINT_MULT */
export const NOCLIP_SPEED = 10
const GRAVITY_Y = -9.81

// ---------------------------------------------------------------------------
// T60 — swimming. Active when the capsule CENTER is inside a water cell
// (phys.water set by attachBuoyancy). All constants/laws are pure functions
// of sim state at fixed DT — deterministic (V2).
// ---------------------------------------------------------------------------
/** horizontal swim speed (m/s) — slower than walking, sprint has no effect */
export const SWIM_SPEED = 2.2
/** jump bit = swim up (also how you climb out at a pool edge) */
export const SWIM_UP_SPEED = 2.6
/** crouch bit = sink */
export const SWIM_SINK_SPEED = 2.0
/** passive float: target feet depth below the waterline (head stays out) */
export const FLOAT_DEPTH = 1.3
/** exponential velocity response per tick: 1 - exp(-8·DT) (water drag feel) */
const SWIM_ACCEL_K = 1 - Math.exp(-8 * DT)
/** passive buoyancy controller gain (m/s of correction per m of depth error) */
const FLOAT_GAIN = 2.5
const FLOAT_MAX_SPEED = 1.2
/** |vy| at the water surface above this emits a splash event (T60 hook) */
const SPLASH_MIN_SPEED = 1.0

/** T60 — splash event payload (render/audio hook, see INTEGRATION-water.md §7) */
export interface SplashEvent {
  playerId: number
  /** world meters at the capsule center */
  x: number
  y: number
  z: number
  /** vertical speed magnitude at the transition (m/s) — scale volume/particles */
  speed: number
  /** true = plunged in, false = surfaced/exited */
  entering: boolean
}

/** water sampler shape (WaterSim.levelAt) — kept structural to avoid a runtime import */
interface WaterField {
  levelAt(vx: number, vy: number, vz: number): number
}

/** water level 0..255 at a world-space point */
function waterLevelAtPoint(water: WaterField, x: number, y: number, z: number): number {
  return water.levelAt(Math.floor(x / VOXEL_SIZE), Math.floor(y / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE))
}

/**
 * Waterline height (meters) above a submerged point: scan the column up to
 * the topmost contiguous water cell and add its fill fraction. Bounded scan,
 * deterministic.
 */
function waterSurfaceY(water: WaterField, x: number, y: number, z: number): number {
  const vx = Math.floor(x / VOXEL_SIZE)
  const vz = Math.floor(z / VOXEL_SIZE)
  let vy = Math.floor(y / VOXEL_SIZE)
  let level = water.levelAt(vx, vy, vz)
  for (let i = 0; i < 32; i++) {
    const above = water.levelAt(vx, vy + 1, vz)
    if (above === 0) break
    vy++
    level = above
  }
  return (vy + level / 255) * VOXEL_SIZE
}

/**
 * T22 [PL] — segmented voxel body: per-bone small voxel grids defined as data.
 * Local voxel space: origin at the player's feet center, axis-aligned
 * (v1 damage model ignores yaw — documented in INTEGRATION-physics.md).
 * Segment destroyed (count below threshold) → status flag on the entity.
 */
export interface SegmentDef {
  name: string
  /** local voxel offset of the grid corner relative to feet center */
  ox: number
  oy: number
  oz: number
  sx: number
  sy: number
  sz: number
}

/** total height 18 voxels = 1.8m: legs 0..5, torso 6..13, head 14..17 */
export const SEGMENT_DEFS: readonly SegmentDef[] = [
  { name: 'head', ox: -2, oy: 14, oz: -2, sx: 4, sy: 4, sz: 4 },
  { name: 'torso', ox: -3, oy: 6, oz: -2, sx: 6, sy: 8, sz: 4 },
  { name: 'armL', ox: -5, oy: 6, oz: -1, sx: 2, sy: 8, sz: 2 },
  { name: 'armR', ox: 3, oy: 6, oz: -1, sx: 2, sy: 8, sz: 2 },
  { name: 'legL', ox: -3, oy: 0, oz: -1, sx: 2, sy: 6, sz: 2 },
  { name: 'legR', ox: 1, oy: 0, oz: -1, sx: 2, sy: 6, sz: 2 },
]

// status flag bits, index-aligned with SEGMENT_DEFS
export const FLAG_LOST_HEAD = 1
export const FLAG_LOST_TORSO = 2
export const FLAG_LOST_ARM_L = 4
export const FLAG_LOST_ARM_R = 8
export const FLAG_LOST_LEG_L = 16
export const FLAG_LOST_LEG_R = 32

/** segment counts as destroyed when live voxels drop below this fraction of initial */
export const SEGMENT_DESTROYED_FRACTION = 0.3

export interface PlayerSegment {
  readonly def: SegmentDef
  /** mini voxel grid, x + z*sx + y*sx*sz, MAT_FLESH or 0 */
  grid: Uint8Array
  count: number
  readonly initial: number
  /** bumped on damage — render rebuild trigger */
  version: number
}

function makeSegments(): PlayerSegment[] {
  return SEGMENT_DEFS.map((def) => {
    const vol = def.sx * def.sy * def.sz
    return {
      def,
      grid: new Uint8Array(vol).fill(MAT_FLESH),
      count: vol,
      initial: vol,
      version: 0,
    }
  })
}

export interface PlayerEntity {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  playerId: number
  /** feet position, meters (character origin) */
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  /** latest MoveOp bitfield — persists until the next move command */
  input: number
  /** segmented voxel body (T22) */
  segments: PlayerSegment[]
  /** FLAG_LOST_* bits — set when a segment drops below the destroyed threshold */
  flags: number
  /** T44 — capsule currently crouched (1.2m); hashed sim state */
  crouching: boolean
  /** T60 — capsule center is in water this tick (derived each tick from
   *  position + water field — not hashed; render/audio read it for feel) */
  swimming: boolean
  /** T47 — noclip fly mode (dev): no collision, direct integration; hashed */
  noclip: boolean
  /**
   * T64 — vehicle entity id the player is seated in (0 = on foot). While
   * seated the capsule is parked: updatePlayers skips it entirely and the
   * vehicle system (src/sim/vehicle.ts) drives px/py/pz from the seat.
   * Hashed sim state (V3). NOTE for the water/swim track: this is the only
   * player.ts overlap from T64 — seated players must also skip swim logic.
   */
  seatedVehicle: number
  /** T64 — seat index in the vehicle's seat list (0 = driver); hashed */
  seat: number
  char: Jolt.CharacterVirtual
  /** standing capsule shape — retained for crouch↔stand swaps (T44) */
  standShape: Jolt.Shape
  /** crouched capsule shape (T44) */
  crouchShape: Jolt.Shape
}

/** capsule with origin at the feet (shared by spawn + crouch swap) */
function makeCapsule(api: PhysicsWorld['api'], halfCyl: number): Jolt.Shape {
  const offset = new api.Vec3(0, halfCyl + PLAYER_RADIUS, 0)
  const rot = new api.Quat(0, 0, 0, 1)
  const settings = new api.RotatedTranslatedShapeSettings(
    offset,
    rot,
    new api.CapsuleShapeSettings(halfCyl, PLAYER_RADIUS),
  )
  const result = settings.Create()
  if (result.HasError()) throw new Error(`player capsule: ${result.GetError().c_str()}`)
  const shape = result.Get()
  // pin the shape: the settings' cached result holds the only Ref until a
  // character references it. Never released — same (negligible, test-only)
  // leak class as CharacterVirtual, see INTEGRATION-physics.md.
  shape.AddRef()
  api.destroy(settings)
  api.destroy(offset)
  api.destroy(rot)
  return shape
}

/** deterministic spawn column per player — world-center arterial crossing.
 * B32 — derived from world size (was hardcoded 102.4 m = the old center). */
function spawnPoint(sim: Sim, playerId: number): { x: number; y: number; z: number } {
  const x = (WORLD_VX >> 1) * VOXEL_SIZE + playerId * 1.0
  const z = (WORLD_VZ >> 1) * VOXEL_SIZE
  // scan down for the highest solid voxel in the spawn column (deterministic)
  const vx = Math.floor(x / VOXEL_SIZE)
  const vz = Math.floor(z / VOXEL_SIZE)
  for (let vy = WORLD_VY - 1; vy >= 0; vy--) {
    if (sim.world.getVoxel(vx, vy, vz) !== 0) {
      return { x, y: (vy + 1) * VOXEL_SIZE + 0.01, z }
    }
  }
  return { x, y: 0.01, z }
}

export function spawnPlayer(sim: Sim, phys: PhysicsWorld, playerId: number): PlayerEntity {
  const api = phys.api
  const p = spawnPoint(sim, playerId)

  const standShape = makeCapsule(api, PLAYER_HALF_CYL)
  const crouchShape = makeCapsule(api, CROUCH_HALF_CYL)

  const settings = new api.CharacterVirtualSettings()
  settings.mShape = standShape
  settings.mMass = 70
  const up = new api.Vec3(0, 1, 0)
  settings.mSupportingVolume = new api.Plane(up, -PLAYER_RADIUS)
  settings.mMaxSlopeAngle = (50 * Math.PI) / 180

  const pos = new api.RVec3(p.x, p.y, p.z)
  const charRot = new api.Quat(0, 0, 0, 1)
  const char = new api.CharacterVirtual(settings, pos, charRot, phys.physicsSystem)

  api.destroy(settings)
  api.destroy(up)
  api.destroy(pos)
  api.destroy(charRot)

  const entity: PlayerEntity = {
    id: sim.allocEntityId(),
    playerId,
    px: p.x,
    py: p.y,
    pz: p.z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    input: 0,
    segments: makeSegments(),
    flags: 0,
    crouching: false,
    swimming: false,
    noclip: false,
    seatedVehicle: 0,
    seat: 0,
    char,
    standShape,
    crouchShape,
  }
  phys.players.set(playerId, entity)
  return entity
}

/**
 * T22 — sphere damage vs player segments (shoot/explode overlap).
 * Same strength rule as world destruction: voxel dies when
 * falloff·power ≥ strength. Sphere center/radius in world voxel coords.
 * Deterministic: ascending playerId, fixed grid scan order (V2).
 */
export function damagePlayersSphere(
  phys: PhysicsWorld,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  power: number,
): void {
  const r2 = r * r
  const pids = [...phys.players.keys()].sort((a, b) => a - b)
  for (const pid of pids) {
    const p = phys.players.get(pid)!
    // player-local grids are axis-aligned at the feet voxel (yaw ignored, v1)
    const bx = Math.floor(p.px / VOXEL_SIZE)
    const by = Math.floor(p.py / VOXEL_SIZE)
    const bz = Math.floor(p.pz / VOXEL_SIZE)
    for (let si = 0; si < p.segments.length; si++) {
      const seg = p.segments[si]
      const { ox, oy, oz, sx, sy, sz } = seg.def
      let changed = false
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const gi = x + z * sx + y * sx * sz
            const mat = seg.grid[gi]
            if (mat === 0) continue
            const dx = bx + ox + x + 0.5 - cx
            const dy = by + oy + y + 0.5 - cy
            const dz = bz + oz + z + 0.5 - cz
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 > r2) continue
            const falloff = 1 - Math.sqrt(d2) / r
            if (falloff * power >= material(mat).strength) {
              seg.grid[gi] = 0
              seg.count--
              changed = true
            }
          }
        }
      }
      if (changed) {
        seg.version++
        if (seg.count < seg.initial * SEGMENT_DESTROYED_FRACTION) {
          p.flags |= 1 << si
        }
      }
    }
  }
}

export function registerPlayerOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('spawn', (s, cmd) => {
    // idempotent: respawn requests for a live player are ignored
    if (phys.players.has(cmd.playerId)) return
    spawnPlayer(s, phys, cmd.playerId)
  })
  sim.onOp('move', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    // V10: move for a non-spawned player = command-stream bug, fail loud
    if (!p) throw new Error(`move for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    p.input = cmd.op.input
    p.yaw = cmd.op.yaw
    p.pitch = cmd.op.pitch
  })
  // T47 — noclip toggle (dev). Hashable entity flag; mechanics in updatePlayers.
  sim.onOp('noclip', (s, cmd) => {
    const p = phys.players.get(cmd.playerId)
    if (!p) throw new Error(`noclip for unspawned player ${cmd.playerId} at tick ${s.tick}`)
    p.noclip = !p.noclip
    if (!p.noclip) {
      // resuming collision: CharacterVirtual already tracks the flown position
      // (synced every noclip tick); Jolt resolves any overlap on next update.
      p.vx = 0
      p.vy = 0
      p.vz = 0
    }
  })
}

/**
 * T44 — headroom probe for un-crouching: conservative voxel AABB around the
 * standing capsule's extra extent (crouched top → standing top). Solid voxel
 * anywhere in the band = stay crouched. Deterministic, world-state only.
 */
function standingHeadroomClear(sim: Sim, p: PlayerEntity): boolean {
  const x0 = Math.floor((p.px - PLAYER_RADIUS + 0.02) / VOXEL_SIZE)
  const x1 = Math.floor((p.px + PLAYER_RADIUS - 0.02) / VOXEL_SIZE)
  const z0 = Math.floor((p.pz - PLAYER_RADIUS + 0.02) / VOXEL_SIZE)
  const z1 = Math.floor((p.pz + PLAYER_RADIUS - 0.02) / VOXEL_SIZE)
  const y0 = Math.floor((p.py + CROUCH_HEIGHT) / VOXEL_SIZE)
  const y1 = Math.floor((p.py + PLAYER_HEIGHT - 1e-4) / VOXEL_SIZE)
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (sim.world.getVoxel(x, y, z) !== 0) return false
      }
  return true
}

/** T47 — noclip fly integration: pure function of input/yaw/pitch, no collision */
function updateNoclip(phys: PhysicsWorld, p: PlayerEntity): void {
  const api = phys.api
  let lx = 0
  let lz = 0
  if (p.input & INPUT_FWD) lz -= 1
  if (p.input & INPUT_BACK) lz += 1
  if (p.input & INPUT_LEFT) lx -= 1
  if (p.input & INPUT_RIGHT) lx += 1
  const cy = Math.cos(p.yaw)
  const sy = Math.sin(p.yaw)
  const cp = Math.cos(p.pitch)
  const sp = Math.sin(p.pitch)
  // forward = look direction (yaw+pitch), right = horizontal (matches walk math)
  let dx = -lz * -sy * cp + lx * cy
  let dy = -lz * sp
  let dz = -lz * -cy * cp + lx * -sy
  if (p.input & INPUT_JUMP) dy += 1
  if (p.input & INPUT_CROUCH) dy -= 1
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  let vx = 0
  let vy = 0
  let vz = 0
  if (len > 1e-9) {
    const speed = (NOCLIP_SPEED * (p.input & INPUT_SPRINT ? SPRINT_MULT : 1)) / len
    vx = dx * speed
    vy = dy * speed
    vz = dz * speed
  }
  p.px += vx * DT
  p.py += vy * DT
  p.pz += vz * DT
  p.vx = vx
  p.vy = vy
  p.vz = vz
  // keep the character in sync so toggling noclip off resumes right here
  const pos = new api.RVec3(p.px, p.py, p.pz)
  p.char.SetPosition(pos)
  api.destroy(pos)
}

/**
 * Character update, called from the physics sim system every tick.
 * Fixed player order (ascending playerId) and fixed DT — deterministic (V2).
 */
export function updatePlayers(phys: PhysicsWorld, sim: Sim): void {
  if (phys.players.size === 0) return
  const api = phys.api
  const pids = [...phys.players.keys()].sort((a, b) => a - b)
  for (const pid of pids) {
    const p = phys.players.get(pid)!

    // T47 — noclip: direct command-driven integration, skip the character update
    if (p.noclip) {
      updateNoclip(phys, p)
      continue
    }

    // T64 — seated in a vehicle: capsule parked, the vehicle system owns
    // position (seat-follow) and input (drive mapping). Deterministic skip.
    if (p.seatedVehicle !== 0) continue

    const grounded = p.char.GetGroundState() === api.EGroundState_OnGround

    // T60 — in-water detection: capsule center inside a water cell = swim.
    // (Feet-only contact = wading; normal locomotion applies.)
    const water = phys.water
    const capsuleHeight = p.crouching ? CROUCH_HEIGHT : PLAYER_HEIGHT
    const centerY = p.py + capsuleHeight * 0.5
    const wasSwimming = p.swimming
    const swimming = water !== null && waterLevelAtPoint(water, p.px, centerY, p.pz) > 0
    p.swimming = swimming
    if (swimming !== wasSwimming) {
      const speed = Math.abs(p.vy)
      if (speed >= SPLASH_MIN_SPEED && phys.onSplash) {
        phys.onSplash({ playerId: pid, x: p.px, y: centerY, z: p.pz, speed, entering: swimming })
      }
    }

    // T44 — crouch transitions: shrink is unconditional, standing back up
    // needs headroom (voxel probe) AND a penetration-free shape swap (both
    // deterministic). Shape swap keeps the feet-origin convention.
    // While swimming the crouch bit means "sink", not "shrink" (T60).
    const wantCrouch = (p.input & INPUT_CROUCH) !== 0 && !swimming
    if (wantCrouch !== p.crouching) {
      const target = wantCrouch ? p.crouchShape : p.standShape
      if (wantCrouch || standingHeadroomClear(sim, p)) {
        const ok = p.char.SetShape(
          target,
          0.01,
          phys.movingBPFilter,
          phys.movingLayerFilter,
          phys.bodyFilter,
          phys.shapeFilter,
          phys.tempAllocator,
        )
        if (ok) p.crouching = wantCrouch
      }
    }

    // desired horizontal velocity from input bitfield + yaw
    let lx = 0
    let lz = 0
    if (p.input & INPUT_FWD) lz -= 1
    if (p.input & INPUT_BACK) lz += 1
    if (p.input & INPUT_LEFT) lx -= 1
    if (p.input & INPUT_RIGHT) lx += 1
    let wx = 0
    let wz = 0
    if (lx !== 0 || lz !== 0) {
      const inv = 1 / Math.sqrt(lx * lx + lz * lz)
      // T44 — crouch halves speed; sprint (ground only) multiplies it.
      // T60 — swimming caps horizontal speed at SWIM_SPEED (no sprint).
      const speed = swimming
        ? SWIM_SPEED
        : p.crouching
          ? CROUCH_SPEED
          : p.input & INPUT_SPRINT && grounded
            ? WALK_SPEED * SPRINT_MULT
            : WALK_SPEED
      const c = Math.cos(p.yaw)
      const s = Math.sin(p.yaw)
      // rotate local (lx, lz) by yaw about Y (three.js YXZ convention)
      wx = (lx * c + lz * s) * inv * speed
      wz = (-lx * s + lz * c) * inv * speed
    }

    let vy: number
    if (swimming) {
      // T60 — buoyancy + drag as an exponential velocity controller:
      // jump = swim up, crouch = sink, otherwise float toward the waterline
      // (feet held FLOAT_DEPTH under the surface → eyes stay dry).
      let targetVy: number
      if (p.input & INPUT_JUMP) {
        targetVy = SWIM_UP_SPEED
      } else if (p.input & INPUT_CROUCH) {
        targetVy = -SWIM_SINK_SPEED
      } else {
        const surface = waterSurfaceY(water!, p.px, centerY, p.pz)
        const err = surface - FLOAT_DEPTH - p.py
        targetVy = Math.max(-FLOAT_MAX_SPEED, Math.min(FLOAT_MAX_SPEED, err * FLOAT_GAIN))
      }
      const cur = p.char.GetLinearVelocity().GetY()
      vy = cur + (targetVy - cur) * SWIM_ACCEL_K
      // water drag also softens horizontal changes
      wx = p.vx + (wx - p.vx) * SWIM_ACCEL_K
      wz = p.vz + (wz - p.vz) * SWIM_ACCEL_K
    } else if (grounded) {
      vy = p.input & INPUT_JUMP ? JUMP_SPEED : 0
    } else {
      vy = p.char.GetLinearVelocity().GetY() + GRAVITY_Y * DT
    }

    const vel = new api.Vec3(wx, vy, wz)
    p.char.SetLinearVelocity(vel)
    api.destroy(vel)

    p.char.ExtendedUpdate(
      DT,
      phys.gravity,
      phys.updateSettings,
      phys.movingBPFilter,
      phys.movingLayerFilter,
      phys.bodyFilter,
      phys.shapeFilter,
      phys.tempAllocator,
    )

    const pos = p.char.GetPosition()
    p.px = pos.GetX()
    p.py = pos.GetY()
    p.pz = pos.GetZ()
    const v = p.char.GetLinearVelocity()
    p.vx = v.GetX()
    p.vy = v.GetY()
    p.vz = v.GetZ()
  }
}
