import { describe, expect, it } from 'vitest'
import { CommandQueue, type Command } from '../src/sim/commands'

const cmd = (tick: number, playerId: number, seq: number): Command => ({
  tick,
  playerId,
  seq,
  op: { kind: 'dig', x: 0, y: 0, z: 0, r: 1 },
})

// V2: drain order must be deterministic regardless of arrival order —
// lockstep peers receive commands in different network order but must
// apply them identically.
describe('CommandQueue (I.cmd, V2)', () => {
  it('drains sorted by (playerId, seq) regardless of push order', () => {
    const q = new CommandQueue()
    q.push(cmd(5, 2, 1))
    q.push(cmd(5, 1, 2))
    q.push(cmd(5, 1, 1))
    q.push(cmd(5, 2, 0))
    const order = q.drain(5).map((c) => `${c.playerId}:${c.seq}`)
    expect(order).toEqual(['1:1', '1:2', '2:0', '2:1'])
  })

  it('drain only returns commands for requested tick, and empties it', () => {
    const q = new CommandQueue()
    q.push(cmd(1, 1, 0))
    q.push(cmd(2, 1, 1))
    expect(q.drain(1)).toHaveLength(1)
    expect(q.drain(1)).toHaveLength(0)
    expect(q.drain(2)).toHaveLength(1)
  })

  it('commands are JSON-serializable (network transport)', () => {
    const c = cmd(1, 1, 0)
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)
  })
})
