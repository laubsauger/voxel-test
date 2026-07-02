import { describe, expect, it } from 'vitest'
import {
  advanceStride,
  angleDelta,
  computePose,
  createAnimState,
  expSmooth,
  HEAD_PITCH_CLAMP,
  HEAD_YAW_CLAMP,
  moveWeight,
  MOVE_W_HI,
  MOVE_W_LO,
  stepAnim,
  strideLength,
  type AnimInputs,
} from '../src/render/player-anim'

// T48 — the rig is pure math over sim reads (V6). These tests encode the
// invariants that make the animation correct, not just its current numbers:
// feet must not skate (phase is distance-driven), blending must be
// frame-rate independent, and aim must stay within human-plausible clamps.

const inputs = (over: Partial<AnimInputs> = {}): AnimInputs => ({
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  crouching: false,
  noclip: false,
  ...over,
})

describe('stride phase (T48 — no foot skating)', () => {
  it('phase delta times stride length equals distance traveled exactly', () => {
    // the no-skate property: a foot plants every strideLength/2 meters of
    // actual travel, regardless of frame timing
    let phase = 0.2
    const speeds = [0.5, 1.2, 4, 6.4, 2, 4]
    const dts = [1 / 60, 1 / 30, 1 / 144, 0.05, 1 / 60, 1 / 90]
    for (let i = 0; i < speeds.length; i++) {
      const next = advanceStride(phase, speeds[i], dts[i])
      let delta = next - phase
      if (delta < 0) delta += 1 // unwrap
      expect(delta * strideLength(speeds[i])).toBeCloseTo(speeds[i] * dts[i], 10)
      phase = next
    }
  })

  it('phase never advances while standing still', () => {
    expect(advanceStride(0.37, 0, 1 / 60)).toBe(0.37)
  })

  it('phase stays in [0,1) across wraps', () => {
    let phase = 0.9
    for (let i = 0; i < 200; i++) {
      phase = advanceStride(phase, 6.4, 1 / 30)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
  })

  it('stepAnim accumulates phase from distance: same ground covered ⇒ same plant count', () => {
    // walk 4 m/s for 1 s at two different frame rates → identical cycle count
    const run = (dt: number) => {
      const s = createAnimState()
      const steps = Math.round(1 / dt)
      for (let i = 0; i < steps; i++) stepAnim(s, inputs({ vz: -4 }), dt)
      return s.phase
    }
    const expected = 4 / strideLength(4) // cycles in 1 s
    expect(run(1 / 60)).toBeCloseTo(expected - Math.floor(expected), 5)
    expect(run(1 / 120)).toBeCloseTo(expected - Math.floor(expected), 5)
  })

  it('walking backward runs the cycle in reverse (feet still plant)', () => {
    const s = createAnimState()
    // view yaw 0, moving +z = backward
    for (let i = 0; i < 30; i++) stepAnim(s, inputs({ vz: 4 }), 1 / 60)
    expect(s.strideDir).toBe(-1)
  })
})

describe('blend weights (T48)', () => {
  it('moveWeight is 0 at rest, 1 at walk speed, monotonic between', () => {
    expect(moveWeight(0)).toBe(0)
    expect(moveWeight(MOVE_W_LO)).toBe(0)
    expect(moveWeight(MOVE_W_HI)).toBe(1)
    expect(moveWeight(4)).toBe(1)
    let prev = -1
    for (let v = 0; v <= 1; v += 0.05) {
      const w = moveWeight(v)
      expect(w).toBeGreaterThanOrEqual(prev)
      prev = w
    }
  })

  it('expSmooth is frame-rate independent (same elapsed time ⇒ same value)', () => {
    // 2 steps of 1/30 must land exactly where 4 steps of 1/60 do
    let a = 0
    for (let i = 0; i < 2; i++) a = expSmooth(a, 1, 8, 1 / 30)
    let b = 0
    for (let i = 0; i < 4; i++) b = expSmooth(b, 1, 8, 1 / 60)
    expect(a).toBeCloseTo(b, 9)
  })

  it('crouch flag drives crouch weight toward 1 and back', () => {
    const s = createAnimState()
    for (let i = 0; i < 120; i++) stepAnim(s, inputs({ crouching: true }), 1 / 60)
    expect(s.crouchW).toBeGreaterThan(0.95)
    for (let i = 0; i < 120; i++) stepAnim(s, inputs(), 1 / 60)
    expect(s.crouchW).toBeLessThan(0.05)
  })

  it('noclip flag drives the fly pose weight', () => {
    const s = createAnimState()
    for (let i = 0; i < 180; i++) stepAnim(s, inputs({ noclip: true }), 1 / 60)
    expect(s.flyW).toBeGreaterThan(0.9)
  })
})

describe('pose blending (T48)', () => {
  it('crouching lowers the pelvis and pitches the torso forward', () => {
    const stand = createAnimState()
    const crouch = createAnimState()
    crouch.crouchW = 1
    const pStand = computePose(stand, inputs())
    const pCrouch = computePose(crouch, inputs({ crouching: true }))
    expect(pCrouch.pelvisY).toBeLessThan(pStand.pelvisY - 0.2)
    expect(pCrouch.torsoPitch).toBeGreaterThan(pStand.torsoPitch + 0.2)
  })

  it('sprint leans the torso further than walking', () => {
    const walk = createAnimState()
    walk.moveW = 1
    walk.speedSm = 4
    const sprint = createAnimState()
    sprint.moveW = 1
    sprint.speedSm = 6.4
    const pWalk = computePose(walk, inputs({ vz: -4 }))
    const pSprint = computePose(sprint, inputs({ vz: -6.4 }))
    expect(pSprint.torsoPitch).toBeGreaterThan(pWalk.torsoPitch)
  })

  it('airborne pose splits the legs and raises the arms', () => {
    const air = createAnimState()
    air.airW = 1
    const p = computePose(air, inputs({ vy: -4 }))
    expect(p.legLPitch - p.legRPitch).toBeGreaterThan(0.3) // split
    expect(p.armLRoll).toBeLessThan(-0.3) // arms out
    expect(p.armRRoll).toBeGreaterThan(0.3)
  })

  it('landing hard produces compression that decays', () => {
    const s = createAnimState()
    s.prevGrounded = false
    s.prevVy = -8
    stepAnim(s, inputs({ vy: 0 }), 1 / 60) // touchdown
    expect(s.landK).toBeGreaterThan(0.5)
    const dip = computePose(s, inputs()).pelvisY
    expect(dip).toBeLessThan(-0.04)
    for (let i = 0; i < 180; i++) stepAnim(s, inputs(), 1 / 60)
    expect(s.landK).toBeLessThan(0.02)
  })

  it('legs counter the arms in the walk cycle', () => {
    const s = createAnimState()
    s.moveW = 1
    s.speedSm = 4
    s.phase = 0.25 // peak swing
    const p = computePose(s, inputs({ vz: -4 }))
    expect(Math.sign(p.legLPitch)).not.toBe(0)
    expect(Math.sign(p.armLPitch)).toBe(-Math.sign(p.legLPitch)) // counter-swing
    expect(Math.sign(p.legRPitch)).toBe(-Math.sign(p.legLPitch)) // opposite legs
  })
})

describe('aim (T48)', () => {
  it('head yaw follows the view but never exceeds the clamp', () => {
    const s = createAnimState()
    s.bodyYaw = 0
    const p = computePose(s, inputs({ yaw: 2.5 }))
    expect(Math.abs(p.headYaw)).toBeLessThanOrEqual(HEAD_YAW_CLAMP)
    expect(p.headYaw).toBeGreaterThan(0)
  })

  it('head pitch is clamped', () => {
    const s = createAnimState()
    const up = computePose(s, inputs({ pitch: 1.55 }))
    const down = computePose(s, inputs({ pitch: -1.55 }))
    expect(Math.abs(up.headPitch)).toBeLessThanOrEqual(HEAD_PITCH_CLAMP)
    expect(Math.abs(down.headPitch)).toBeLessThanOrEqual(HEAD_PITCH_CLAMP)
  })

  it('body yaw springs toward the view yaw when idle', () => {
    const s = createAnimState()
    for (let i = 0; i < 120; i++) stepAnim(s, inputs({ yaw: 1.2 }), 1 / 60)
    expect(Math.abs(angleDelta(s.bodyYaw, 1.2))).toBeLessThan(0.05)
  })

  it('angleDelta wraps across the seam', () => {
    expect(angleDelta(0.1, Math.PI * 2 + 0.2)).toBeCloseTo(0.1, 9)
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 9)
  })
})
