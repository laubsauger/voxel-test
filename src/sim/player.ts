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
import type { PhysicsWorld } from './physics'

// MoveOp input bitfield (src/sim/commands.ts)
export const INPUT_FWD = 1
export const INPUT_BACK = 2
export const INPUT_LEFT = 4
export const INPUT_RIGHT = 8
export const INPUT_JUMP = 16
export const INPUT_CROUCH = 32

export const PLAYER_RADIUS = 0.3
/** capsule cylinder half-height; total height = 2*(HALF_CYL + RADIUS) = 1.8m */
export const PLAYER_HALF_CYL = 0.6
export const PLAYER_HEIGHT = 2 * (PLAYER_HALF_CYL + PLAYER_RADIUS)
export const EYE_HEIGHT = 1.6

export const WALK_SPEED = 4
export const CROUCH_SPEED = 2
export const JUMP_SPEED = 6
const GRAVITY_Y = -9.81

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
  char: Jolt.CharacterVirtual
}

/** deterministic spawn column per player */
function spawnPoint(sim: Sim, playerId: number): { x: number; y: number; z: number } {
  const x = 51.2 + playerId * 1.0
  const z = 51.2
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

  // capsule with origin at the feet
  const offset = new api.Vec3(0, PLAYER_HALF_CYL + PLAYER_RADIUS, 0)
  const rot = new api.Quat(0, 0, 0, 1)
  const shapeSettings = new api.RotatedTranslatedShapeSettings(
    offset,
    rot,
    new api.CapsuleShapeSettings(PLAYER_HALF_CYL, PLAYER_RADIUS),
  )
  const shapeResult = shapeSettings.Create()
  if (shapeResult.HasError()) throw new Error(`player capsule: ${shapeResult.GetError().c_str()}`)
  const shape = shapeResult.Get()

  const settings = new api.CharacterVirtualSettings()
  settings.mShape = shape
  settings.mMass = 70
  const up = new api.Vec3(0, 1, 0)
  settings.mSupportingVolume = new api.Plane(up, -PLAYER_RADIUS)
  settings.mMaxSlopeAngle = (50 * Math.PI) / 180

  const pos = new api.RVec3(p.x, p.y, p.z)
  const charRot = new api.Quat(0, 0, 0, 1)
  const char = new api.CharacterVirtual(settings, pos, charRot, phys.physicsSystem)

  api.destroy(shapeSettings)
  api.destroy(offset)
  api.destroy(rot)
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
    char,
  }
  phys.players.set(playerId, entity)
  return entity
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
}

/**
 * Character update, called from the physics sim system every tick.
 * Fixed player order (ascending playerId) and fixed DT — deterministic (V2).
 */
export function updatePlayers(phys: PhysicsWorld): void {
  if (phys.players.size === 0) return
  const api = phys.api
  const pids = [...phys.players.keys()].sort((a, b) => a - b)
  for (const pid of pids) {
    const p = phys.players.get(pid)!

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
      const speed = p.input & INPUT_CROUCH ? CROUCH_SPEED : WALK_SPEED
      const c = Math.cos(p.yaw)
      const s = Math.sin(p.yaw)
      // rotate local (lx, lz) by yaw about Y (three.js YXZ convention)
      wx = (lx * c + lz * s) * inv * speed
      wz = (-lx * s + lz * c) * inv * speed
    }

    const grounded = p.char.GetGroundState() === api.EGroundState_OnGround
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
