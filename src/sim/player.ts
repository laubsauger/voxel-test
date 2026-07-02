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
import { VOXEL_SIZE, WORLD_VY } from '../world/chunks'
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
/** capsule cylinder half-height; total height = 2*(HALF_CYL + RADIUS) = 1.8m */
export const PLAYER_HALF_CYL = 0.6
export const PLAYER_HEIGHT = 2 * (PLAYER_HALF_CYL + PLAYER_RADIUS)
export const EYE_HEIGHT = 1.6
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
  /** T47 — noclip fly mode (dev): no collision, direct integration; hashed */
  noclip: boolean
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

/** deterministic spawn column per player — world-center road crossing (T50) */
function spawnPoint(sim: Sim, playerId: number): { x: number; y: number; z: number } {
  const x = 102.4 + playerId * 1.0
  const z = 102.4
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
    noclip: false,
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

    const grounded = p.char.GetGroundState() === api.EGroundState_OnGround

    // T44 — crouch transitions: shrink is unconditional, standing back up
    // needs headroom (voxel probe) AND a penetration-free shape swap (both
    // deterministic). Shape swap keeps the feet-origin convention.
    const wantCrouch = (p.input & INPUT_CROUCH) !== 0
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
      // T44 — crouch halves speed; sprint (ground only) multiplies it
      const speed = p.crouching
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
    if (grounded) {
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
