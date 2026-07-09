/**
 * T77 [PL] — death ragdolls: when a player dies the corpse becomes 6 dynamic
 * Jolt bodies (head, torso, arms, legs — the player's SEGMENT_DEFS boxes,
 * scaled the same way PlayerMesh scales the visual body) linked by
 * SwingTwistConstraints at neck/shoulders/hips, seeded with the victim's
 * velocity plus the killing impulse — a rocket kill flings the body, a gun
 * kill mostly crumples (see RAGDOLL_* launch constants in player.ts).
 *
 * V1 SCOPE: trigger is DEATH only. The spec's other triggers (hard falls,
 * vehicle hits, explosion impulse over threshold) and "blends back to
 * animated on recovery" are v2 — a death ragdoll never recovers; it despawns
 * on the tick the victim respawns (despawnAtTick = victim.respawnAtTick,
 * deterministic).
 *
 * DETERMINISM (V2/V3/V8): ragdolls live in the SHARED deterministic Jolt
 * world (same precedent as vehicles/aircraft — single-threaded,
 * mDeterministicSimulation), keyed by sim.allocEntityId in phys.ragdolls.
 * Part transforms are mirrored after each step (tickRagdolls) and folded
 * into hashPhysics via hashRagdolls.
 *
 * COLLISION: parts are ordinary LAYER_MOVING dynamic bodies — they collide
 * with the static world and other moving bodies. This codebase has no
 * per-body-type collision filtering beyond the STATIC/MOVING layers, so a
 * live player's CharacterVirtual DOES see corpse parts as obstacles and can
 * nudge them (kick a corpse, stand on it). That is deterministic either way
 * (character + ragdoll state are both hashed sim state), so we keep it and
 * document it here rather than adding a third object layer for one feature.
 */
import type Jolt from 'jolt-physics'
import type { Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { PLAYER_HEIGHT, SEGMENT_DEFS, type PlayerEntity } from './player'
import type { PhysicsWorld } from './physics'

/** total corpse mass (kg) — matches CharacterVirtualSettings.mMass; spread
 *  over the 6 parts proportional to segment voxel volume */
const RAGDOLL_MASS = 70

/** the voxel body is authored at 18 vox = 1.8 m; scale to the capsule height
 *  exactly like PlayerMesh does so the corpse matches the visible character */
const RAGDOLL_SCALE = PLAYER_HEIGHT / 1.8

/** velocity caps — same values as island debris (T40, physics.ts). Literal
 *  copies to avoid a runtime physics.ts ⇄ ragdoll.ts cycle (vehicle.ts
 *  precedent: literal layer id + type-only physics import). */
const MAX_LIN_VEL = 60
const MAX_ANG_VEL = 25

/** parts below this despawn the whole ragdoll (mirrors physics.KILL_PLANE_Y) */
const KILL_PLANE_Y = -10

/** joint friction torque (N·m) — joints resist free spinning so the corpse
 *  settles into a pose instead of flailing forever */
const JOINT_FRICTION = 3

/** box collider convex radius (m) — must stay below the smallest half extent
 *  (arm/leg: 1 voxel ≈ 0.092 m) */
const CONVEX_RADIUS = 0.02

/**
 * Joint table: every limb hangs off the torso (SEGMENT_DEFS index 1).
 * Positions in voxel units relative to the feet center — the SAME pivot
 * numbers as the render rig (player-mesh PIVOTS), mirrored here because sim
 * must not import render (V6). `down` = twist axis points down the limb.
 */
interface JointDef {
  a: number // torso part index
  b: number // limb part index
  x: number
  y: number
  z: number
  /** swing half-cone angle (rad) */
  cone: number
  /** twist limit ± (rad) */
  twist: number
  down: boolean
}

const JOINTS: readonly JointDef[] = [
  { a: 1, b: 0, x: 0, y: 14, z: 0, cone: 0.35, twist: 0.35, down: false }, // neck
  { a: 1, b: 2, x: -4, y: 13, z: 0, cone: 1.1, twist: 0.4, down: true }, // shoulder L
  { a: 1, b: 3, x: 4, y: 13, z: 0, cone: 1.1, twist: 0.4, down: true }, // shoulder R
  { a: 1, b: 4, x: -2, y: 6, z: 0, cone: 0.7, twist: 0.25, down: true }, // hip L
  { a: 1, b: 5, x: 2, y: 6, z: 0, cone: 0.7, twist: 0.25, down: true }, // hip R
]

/** one ragdoll body part — index-aligned with SEGMENT_DEFS; transforms are
 *  mirrored Jolt state after each step, hashed (V3) */
export interface RagdollPart {
  body: Jolt.Body
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export interface RagdollEntity {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  /** the dead player this corpse belongs to */
  playerId: number
  /** tick the ragdoll despawns — the victim's respawn tick (deterministic) */
  despawnAtTick: number
  /** 6 parts, index-aligned with SEGMENT_DEFS (head, torso, armL/R, legL/R) */
  parts: RagdollPart[]
  /** 5 SwingTwist joints (neck, shoulders, hips) — removed at despawn */
  constraints: Jolt.Constraint[]
}

/**
 * Spawn a death ragdoll at the victim's position/yaw. (vx,vy,vz) is the full
 * launch velocity in m/s: victim momentum + killing impulse, threaded from
 * damagePlayerHp (player.ts). Deterministic: pure function of sim state.
 */
export function spawnRagdoll(
  phys: PhysicsWorld,
  sim: Sim,
  victim: PlayerEntity,
  vx: number,
  vy: number,
  vz: number,
): void {
  const api = phys.api
  const vs = VOXEL_SIZE * RAGDOLL_SCALE
  const cos = Math.cos(victim.yaw)
  const sin = Math.sin(victim.yaw)

  // clamp the launch to the debris velocity cap (T40 — nothing flies to infinity)
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
  if (speed > MAX_LIN_VEL) {
    const k = MAX_LIN_VEL / speed
    vx *= k
    vy *= k
    vz *= k
  }

  let totalVol = 0
  for (const d of SEGMENT_DEFS) totalVol += d.sx * d.sy * d.sz

  // face the victim's yaw (visual nicety; yaw is hashed sim state — deterministic)
  const qy = Math.sin(victim.yaw / 2)
  const qw = Math.cos(victim.yaw / 2)

  const parts: RagdollPart[] = []
  const halfExtent = new api.Vec3(0, 0, 0)
  const vel = new api.Vec3(vx, vy, vz)
  const rot = new api.Quat(0, qy, 0, qw)
  for (const def of SEGMENT_DEFS) {
    halfExtent.Set((def.sx * vs) / 2, (def.sy * vs) / 2, (def.sz * vs) / 2)
    const ss = new api.BoxShapeSettings(halfExtent, CONVEX_RADIUS)
    const result = ss.Create()
    if (result.HasError()) throw new Error(`ragdoll part: ${result.GetError().c_str()}`)
    const shape = result.Get()
    api.destroy(ss)

    // segment center (feet-relative meters), yaw-rotated around the feet
    const lx = (def.ox + def.sx / 2) * vs
    const ly = (def.oy + def.sy / 2) * vs
    const lz = (def.oz + def.sz / 2) * vs
    const px = victim.px + lx * cos + lz * sin
    const py = victim.py + ly
    const pz = victim.pz - lx * sin + lz * cos

    const pos = new api.RVec3(px, py, pz)
    const bcs = new api.BodyCreationSettings(shape, pos, rot, api.EMotionType_Dynamic, 1 /* LAYER_MOVING */)
    bcs.mOverrideMassProperties = api.EOverrideMassProperties_CalculateInertia
    bcs.mMassPropertiesOverride.mMass = (RAGDOLL_MASS * def.sx * def.sy * def.sz) / totalVol
    bcs.mFriction = 0.7
    bcs.mRestitution = 0.05
    // heavy damping: a corpse settles and stays down, no endless flailing
    bcs.mAngularDamping = 0.9
    bcs.mLinearDamping = 0.1
    bcs.mMaxLinearVelocity = MAX_LIN_VEL
    bcs.mMaxAngularVelocity = MAX_ANG_VEL
    const body = phys.bodyInterface.CreateBody(bcs)
    phys.bodyInterface.AddBody(body.GetID(), api.EActivation_Activate)
    api.destroy(bcs)
    api.destroy(pos)
    phys.bodyInterface.SetLinearVelocity(body.GetID(), vel)
    parts.push({ body, px, py, pz, qx: 0, qy, qz: 0, qw })
  }
  api.destroy(vel)
  api.destroy(rot)
  api.destroy(halfExtent)

  // joints — SwingTwist cones anchored in world space at spawn (bodies are at
  // their authored pose, so world anchors == the shared joint points)
  const constraints: Jolt.Constraint[] = []
  const jpos = new api.RVec3(0, 0, 0)
  const twist = new api.Vec3(0, 0, 0)
  const plane = new api.Vec3(cos, 0, -sin) // ⊥ the vertical twist axes, yaw-rotated
  for (const j of JOINTS) {
    const st = new api.SwingTwistConstraintSettings()
    st.mSpace = api.EConstraintSpace_WorldSpace
    jpos.Set(
      victim.px + j.x * vs * cos + j.z * vs * sin,
      victim.py + j.y * vs,
      victim.pz - j.x * vs * sin + j.z * vs * cos,
    )
    st.mPosition1 = jpos
    st.mPosition2 = jpos
    twist.Set(0, j.down ? -1 : 1, 0)
    st.mTwistAxis1 = twist
    st.mTwistAxis2 = twist
    st.mPlaneAxis1 = plane
    st.mPlaneAxis2 = plane
    st.mNormalHalfConeAngle = j.cone
    st.mPlaneHalfConeAngle = j.cone
    st.mTwistMinAngle = -j.twist
    st.mTwistMaxAngle = j.twist
    st.mMaxFrictionTorque = JOINT_FRICTION
    const c = st.Create(parts[j.a].body, parts[j.b].body)
    phys.physicsSystem.AddConstraint(c)
    constraints.push(c)
    api.destroy(st)
  }
  api.destroy(jpos)
  api.destroy(twist)
  api.destroy(plane)

  const id = sim.allocEntityId()
  phys.ragdolls.set(id, {
    id,
    playerId: victim.playerId,
    despawnAtTick: victim.respawnAtTick,
    parts,
    constraints,
  })
}

/**
 * Per-tick ragdoll pass (called from PhysicsWorld.tick after the Jolt step):
 * mirror part transforms into hashable fields, despawn ragdolls whose victim
 * respawns this tick, kill-plane ragdolls that fell out of the world.
 * Deterministic: ascending id order, tick-driven lifetime.
 */
export function tickRagdolls(sim: Sim, phys: PhysicsWorld): void {
  if (phys.ragdolls.size === 0) return
  let doomed: number[] | undefined
  let killPlaned: number[] | undefined
  for (const [id, r] of phys.ragdolls) {
    let below = false
    for (const p of r.parts) {
      const pos = p.body.GetPosition()
      p.px = pos.GetX()
      p.py = pos.GetY()
      p.pz = pos.GetZ()
      const q = p.body.GetRotation()
      p.qx = q.GetX()
      p.qy = q.GetY()
      p.qz = q.GetZ()
      p.qw = q.GetW()
      if (p.py < KILL_PLANE_Y) below = true
    }
    if (below) (killPlaned ??= []).push(id)
    else if (sim.tick >= r.despawnAtTick) (doomed ??= []).push(id)
  }
  if (killPlaned) {
    killPlaned.sort((a, b) => a - b)
    for (const id of killPlaned) {
      despawnRagdoll(phys, phys.ragdolls.get(id)!)
      phys.removedRagdolls++
    }
  }
  if (doomed) {
    doomed.sort((a, b) => a - b)
    for (const id of doomed) despawnRagdoll(phys, phys.ragdolls.get(id)!)
  }
}

/** remove constraints + bodies from Jolt and the registry (no leaks —
 *  RemoveConstraint releases the system's ref, vehicle.ts precedent) */
export function despawnRagdoll(phys: PhysicsWorld, r: RagdollEntity): void {
  for (const c of r.constraints) phys.physicsSystem.RemoveConstraint(c)
  for (const p of r.parts) {
    phys.bodyInterface.RemoveBody(p.body.GetID())
    phys.bodyInterface.DestroyBody(p.body.GetID())
  }
  phys.ragdolls.delete(r.id)
}

/** I.hash extension — called from hashPhysics (physics.ts). Ids ascending;
 *  part transforms hashed exactly like vehicle/aircraft body transforms. */
export function hashRagdolls(
  h: { u32(v: number): unknown; f64(v: number): unknown },
  phys: { ragdolls: ReadonlyMap<number, RagdollEntity>; removedRagdolls: number },
): void {
  h.u32(phys.ragdolls.size)
  h.u32(phys.removedRagdolls)
  const ids = [...phys.ragdolls.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const r = phys.ragdolls.get(id)!
    h.u32(id)
    h.u32(r.playerId)
    h.u32(r.despawnAtTick)
    for (const p of r.parts) {
      h.f64(p.px)
      h.f64(p.py)
      h.f64(p.pz)
      h.f64(p.qx)
      h.f64(p.qy)
      h.f64(p.qz)
      h.f64(p.qw)
    }
  }
}

/** test/dispose helper — tears down all ragdolls without hash side effects */
export function disposeRagdolls(phys: PhysicsWorld): void {
  for (const r of [...phys.ragdolls.values()]) despawnRagdoll(phys, r)
}
