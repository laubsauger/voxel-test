import { describe, expect, it } from 'vitest'
import { FixedStepDriver, Sim, TICK_MS } from '../src/sim/loop'

// V11: sim advances in fixed ticks driven by an accumulator; render time
// never leaks into sim state.
describe('FixedStepDriver (V11)', () => {
  it('steps floor(elapsed/TICK_MS) ticks and keeps remainder as alpha', () => {
    const sim = new Sim(1)
    const driver = new FixedStepDriver()
    const steps = driver.advance(TICK_MS * 3.5, sim)
    expect(steps).toBe(3)
    expect(sim.tick).toBe(3)
    expect(driver.alpha).toBeCloseTo(0.5)
  })

  it('caps steps per advance to avoid death spiral', () => {
    const sim = new Sim(1)
    const driver = new FixedStepDriver()
    const steps = driver.advance(TICK_MS * 1000, sim)
    expect(steps).toBe(driver.maxStepsPerAdvance)
  })
})

// V1: mutations only via commands. V10: unknown op fails loud.
describe('Sim command dispatch (V1, V10)', () => {
  it('applies queued commands on their tick via registered handler', () => {
    const sim = new Sim(1)
    const applied: number[] = []
    sim.onOp('dig', (s) => applied.push(s.tick))
    sim.queue.push({ tick: 2, playerId: 1, seq: 0, op: { kind: 'dig', x: 0, y: 0, z: 0, r: 1 } })
    sim.step() // tick 0
    sim.step() // tick 1
    expect(applied).toEqual([])
    sim.step() // tick 2
    expect(applied).toEqual([2])
  })

  it('throws loud on op with no handler (V10)', () => {
    const sim = new Sim(1)
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'dig', x: 0, y: 0, z: 0, r: 1 } })
    expect(() => sim.step()).toThrow(/no handler/)
  })

  it('rejects duplicate op handlers', () => {
    const sim = new Sim(1)
    sim.onOp('dig', () => {})
    expect(() => sim.onOp('dig', () => {})).toThrow(/duplicate/)
  })

  it('entity ids allocate deterministically (V8)', () => {
    const a = new Sim(1)
    const b = new Sim(99) // different seed must not affect id sequence
    expect([a.allocEntityId(), a.allocEntityId()]).toEqual([b.allocEntityId(), b.allocEntityId()])
  })
})
