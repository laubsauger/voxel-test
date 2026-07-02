/**
 * T48 [PL] — procedural animation math for the segmented voxel player.
 *
 * Pure module: no three.js scene objects, no sim writes (V6). Everything here
 * is a function of (previous anim state, sim-entity snapshot, dt) → new anim
 * state + a Pose of joint angles that the render rig applies.
 *
 * Core rules (threejs-procedural-animation skill):
 * - stride phase advances by DISTANCE TRAVELED / stride length, never by
 *   time — foot plant matches ground speed exactly (no skating).
 * - all smoothing is frame-rate independent: alpha = 1 - exp(-lambda * dt).
 * - body yaw follows movement direction through a semi-implicit spring with
 *   clamped integration steps; view yaw drives head/torso aim with clamps.
 * - velocity+flag-driven blending, no animation state machine.
 */

// ---------------------------------------------------------------------------
// tuning constants
// ---------------------------------------------------------------------------

/** stride length model: meters covered by one full L+R cycle at a speed */
export const STRIDE_BASE = 1.1
export const STRIDE_PER_SPEED = 0.28
export const STRIDE_MIN = 1.2
export const STRIDE_MAX = 3.2

/** speed band over which the walk cycle fades in (m/s) */
export const MOVE_W_LO = 0.15
export const MOVE_W_HI = 0.9

/** blend response rates (1/s) */
const LAMBDA_MOVE = 10
const LAMBDA_CROUCH = 10
const LAMBDA_FLY = 6
const LAMBDA_AIR = 12
const LAMBDA_SPEED = 8
const LAMBDA_LAND = 5.5

/** body yaw spring (rad/s² per rad error, damping) */
const YAW_STIFFNESS = 70
const YAW_DAMPING = 13
/** max integration step for the semi-implicit yaw spring */
const YAW_MAX_STEP = 1 / 60

/** aim clamps (rad) */
export const HEAD_YAW_CLAMP = 0.9
export const HEAD_PITCH_CLAMP = 1.05
const TORSO_PITCH_AIM = 0.28
const TORSO_PITCH_AIM_CLAMP = 0.4

/** walk/sprint pose scaling */
const LEG_SWING_BASE = 0.32
const LEG_SWING_PER_SPEED = 0.055
const LEG_SWING_MAX = 0.85
const ARM_COUNTER = 0.75
const BOB_AMP = 0.038
const LEAN_PER_SPEED = 0.022
const LEAN_MAX = 0.16

/** landing: vy at/above this (downward) reaches full compression */
export const LAND_FULL_VY = 9
export const LAND_MIN_VY = 2.5

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** frame-rate independent exponential approach */
export function expSmooth(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt))
}

/** shortest signed angle from a to b, in (-PI, PI] */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp((v - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/** meters per full stride cycle at a given horizontal speed */
export function strideLength(speed: number): number {
  return clamp(STRIDE_BASE + STRIDE_PER_SPEED * speed, STRIDE_MIN, STRIDE_MAX)
}

/**
 * Advance the stride phase by distance traveled (NOT time): the no-skate
 * property is `deltaPhase * strideLength(speed) === speed * dt` exactly.
 * Returns the new phase in [0, 1).
 */
export function advanceStride(phase: number, horizSpeed: number, dt: number): number {
  const next = phase + (horizSpeed * dt) / strideLength(horizSpeed)
  return next - Math.floor(next)
}

/** walk-cycle weight from horizontal speed (0 = idle, 1 = full cycle) */
export function moveWeight(horizSpeed: number): number {
  return smoothstep(MOVE_W_LO, MOVE_W_HI, horizSpeed)
}

// ---------------------------------------------------------------------------
// anim state
// ---------------------------------------------------------------------------

export interface AnimState {
  /** stride cycles, [0,1). One cycle = left step + right step. */
  phase: number
  /** +1 walking forward, -1 walking backward (cycle runs in reverse) */
  strideDir: number
  /** spring-lagged body yaw (rad, render-side) */
  bodyYaw: number
  bodyYawVel: number
  /** smoothed blend weights */
  moveW: number
  crouchW: number
  flyW: number
  airW: number
  speedSm: number
  vySm: number
  /** landing compression impulse, decays exponentially */
  landK: number
  /** takeoff impulse (jump anticipation → reach), decays exponentially */
  jumpK: number
  /** wall-clock accumulator for idle motion (render-side only) */
  time: number
  prevGrounded: boolean
  prevVy: number
}

export function createAnimState(yaw = 0): AnimState {
  return {
    phase: 0,
    strideDir: 1,
    bodyYaw: yaw,
    bodyYawVel: 0,
    moveW: 0,
    crouchW: 0,
    flyW: 0,
    airW: 0,
    speedSm: 0,
    vySm: 0,
    landK: 0,
    jumpK: 0,
    time: 0,
    prevGrounded: true,
    prevVy: 0,
  }
}

/** snapshot of the sim entity fields the rig reads (V6: read-only) */
export interface AnimInputs {
  vx: number
  vy: number
  vz: number
  /** view yaw/pitch from the sim entity */
  yaw: number
  pitch: number
  crouching: boolean
  noclip: boolean
  /** body is rendered under the FP camera: suppress aim-driven torso pitch
   * so the chest never sweeps into the near plane */
  fpBody?: boolean
}

// ---------------------------------------------------------------------------
// pose
// ---------------------------------------------------------------------------

/** joint angles in radians + pelvis offset in meters; applied by PlayerMesh */
export interface Pose {
  /** body facing (world yaw, rad) */
  rootYaw: number
  /** vertical offset of the whole body from the entity feet position */
  pelvisY: number
  torsoPitch: number
  torsoYaw: number
  torsoRoll: number
  headPitch: number
  headYaw: number
  armLPitch: number
  armRPitch: number
  armLRoll: number
  armRRoll: number
  legLPitch: number
  legRPitch: number
  /** stride phase echoed for consumers that sync to it (T49 viewmodel bob) */
  phase: number
  moveW: number
  landK: number
}

/**
 * Step the animation state and compute the frame's pose.
 * `dt` is clamped internally; safe across tab suspensions.
 */
export function stepAnim(s: AnimState, inp: AnimInputs, dtIn: number): Pose {
  const dt = clamp(dtIn, 0, 0.1)
  s.time += dt

  const speed = Math.hypot(inp.vx, inp.vz)
  s.speedSm = expSmooth(s.speedSm, speed, LAMBDA_SPEED, dt)
  s.vySm = expSmooth(s.vySm, inp.vy, LAMBDA_SPEED, dt)

  // --- grounded heuristic (render-side; sim exposes velocity, not ground) ---
  // airborne when vertical speed is significant; noclip is never "airborne"
  const grounded = inp.noclip || Math.abs(inp.vy) < 0.7
  if (!s.prevGrounded && grounded && s.prevVy < -LAND_MIN_VY) {
    // landing compression scaled by impact speed
    s.landK = Math.max(s.landK, clamp(-s.prevVy / LAND_FULL_VY, 0, 1))
  }
  if (s.prevGrounded && !grounded && inp.vy > 2) {
    s.jumpK = 1 // takeoff: arms reach, brief anticipation crouch release
  }
  s.prevGrounded = grounded
  s.prevVy = inp.vy
  s.landK *= Math.exp(-LAMBDA_LAND * dt)
  s.jumpK *= Math.exp(-7 * dt)

  // --- blend weights (velocity+flag driven, no state machine) --------------
  s.moveW = expSmooth(s.moveW, moveWeight(speed), LAMBDA_MOVE, dt)
  s.crouchW = expSmooth(s.crouchW, inp.crouching ? 1 : 0, LAMBDA_CROUCH, dt)
  s.flyW = expSmooth(s.flyW, inp.noclip ? 1 : 0, LAMBDA_FLY, dt)
  s.airW = expSmooth(s.airW, grounded ? 0 : 1, LAMBDA_AIR, dt)

  // --- stride: distance-driven phase (no skating) ---------------------------
  // walking backward runs the cycle in reverse so feet still plant correctly
  let dir = s.strideDir
  if (speed > MOVE_W_LO) {
    const moveYaw = Math.atan2(-inp.vx, -inp.vz) // forward = -z at yaw 0
    dir = Math.abs(angleDelta(inp.yaw, moveYaw)) > Math.PI * 0.55 ? -1 : 1
    s.strideDir = dir
  }
  const before = s.phase
  s.phase = advanceStride(s.phase, speed * dir, dt)
  if (speed < 0.02 && s.moveW < 0.03) {
    // fully idle: relax the cycle to the neutral plant so limbs return home
    s.phase = expSmooth(before, Math.round(before), 8, dt)
    s.phase -= Math.floor(s.phase)
  }

  // --- body yaw: spring toward movement dir when moving, view yaw otherwise -
  let targetYaw = inp.yaw
  if (speed > MOVE_W_HI && dir > 0 && !inp.noclip) {
    targetYaw = Math.atan2(-inp.vx, -inp.vz)
  }
  // hard clamp: never let the head-body twist exceed the aim clamp by much
  const viewErr = angleDelta(s.bodyYaw, inp.yaw)
  if (Math.abs(viewErr) > HEAD_YAW_CLAMP * 1.35) targetYaw = inp.yaw
  // semi-implicit spring, clamped substeps (skill: clamped dt after suspension)
  let remaining = dt
  while (remaining > 1e-6) {
    const h = Math.min(remaining, YAW_MAX_STEP)
    const err = angleDelta(s.bodyYaw, targetYaw)
    s.bodyYawVel += (err * YAW_STIFFNESS - s.bodyYawVel * YAW_DAMPING) * h
    s.bodyYaw += s.bodyYawVel * h
    remaining -= h
  }

  return computePose(s, inp)
}

/**
 * Pure pose blend from anim state + inputs. Exported separately so tests can
 * assert blending without stepping time.
 */
export function computePose(s: AnimState, inp: AnimInputs): Pose {
  const twoPi = Math.PI * 2
  const cyc = Math.sin(s.phase * twoPi)
  const groundW = (1 - s.airW) * (1 - s.flyW)
  const walkW = s.moveW * groundW

  // walk/run cycle -----------------------------------------------------------
  const swingAmp = clamp(LEG_SWING_BASE + s.speedSm * LEG_SWING_PER_SPEED, 0, LEG_SWING_MAX)
  const legSwing = cyc * swingAmp * walkW
  const armSwing = -legSwing * ARM_COUNTER
  // pelvis bobs twice per cycle, lowest at the pass-through
  const bob = -BOB_AMP * (0.5 - 0.5 * Math.cos(s.phase * twoPi * 2)) * walkW

  // idle breathing/sway ------------------------------------------------------
  const idleW = (1 - s.moveW) * groundW
  const breath = Math.sin(s.time * twoPi * 0.22)
  const sway = Math.sin(s.time * twoPi * 0.13 + 1.3)

  // sprint lean --------------------------------------------------------------
  const lean = clamp(s.speedSm * LEAN_PER_SPEED, 0, LEAN_MAX) * walkW * s.strideDir

  // jump / fall / land -------------------------------------------------------
  const airPose = s.airW * (1 - s.flyW)
  const rising = clamp(s.vySm / 6, -1, 1)
  const land = s.landK * groundW

  // crouch -------------------------------------------------------------------
  const cw = s.crouchW

  // fly / noclip float -------------------------------------------------------
  const fw = s.flyW
  const drift = Math.sin(s.time * 1.7)
  const drift2 = Math.sin(s.time * 1.1 + 0.8)

  // aim ----------------------------------------------------------------------
  const headYaw = clamp(angleDelta(s.bodyYaw, inp.yaw), -HEAD_YAW_CLAMP, HEAD_YAW_CLAMP)
  const headPitch = clamp(inp.pitch * 0.85, -HEAD_PITCH_CLAMP, HEAD_PITCH_CLAMP)
  const aimTorsoPitch = inp.fpBody
    ? 0
    : clamp(inp.pitch * TORSO_PITCH_AIM, -TORSO_PITCH_AIM_CLAMP, TORSO_PITCH_AIM_CLAMP)

  return {
    rootYaw: s.bodyYaw,
    pelvisY:
      bob -
      0.3 * cw - // crouch drop (legs kneel fore/aft to keep feet grounded)
      0.13 * land + // landing compression
      fw * (0.05 + drift * 0.03), // fly float
    torsoPitch:
      lean +
      aimTorsoPitch +
      breath * 0.016 * idleW +
      cw * 0.38 +
      airPose * clamp(-rising * 0.18, -0.18, 0.22) +
      land * 0.3 -
      fw * 0.12,
    torsoYaw: headYaw * 0.25,
    torsoRoll: sway * 0.012 * idleW + cyc * 0.02 * walkW,
    headPitch: headPitch - cw * 0.2 - land * 0.15,
    headYaw,
    armLPitch:
      armSwing +
      breath * 0.03 * idleW +
      airPose * (-0.5 - rising * 0.25) +
      s.jumpK * -0.6 +
      fw * -0.25 +
      fw * drift2 * 0.06 +
      cw * 0.25,
    armRPitch:
      -armSwing +
      breath * 0.03 * idleW +
      airPose * (-0.5 - rising * 0.25) +
      s.jumpK * -0.6 +
      fw * -0.25 +
      fw * drift * 0.06 +
      cw * 0.25,
    armLRoll: -(0.06 + airPose * 0.45 + fw * 0.3 + sway * 0.02 * idleW),
    armRRoll: 0.06 + airPose * 0.45 + fw * 0.3 + sway * 0.02 * idleW,
    // crouch: fore/aft kneel — ±~60° keeps 0.6m legs reaching the ground
    // after the 0.3m pelvis drop (cos(1.05)·0.6 ≈ 0.3)
    legLPitch:
      legSwing * (1 - cw * 0.5) +
      airPose * (0.32 + rising * 0.1) +
      cw * 1.05 +
      fw * (0.18 + drift * 0.05),
    legRPitch:
      -legSwing * (1 - cw * 0.5) +
      airPose * (-0.22 + rising * 0.06) +
      cw * -1.0 +
      fw * (0.1 + drift2 * 0.05),
    phase: s.phase,
    moveW: s.moveW,
    landK: s.landK,
  }
}
