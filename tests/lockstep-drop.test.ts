import { describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import type { Op } from '../src/sim/commands'
import { MockChannel } from '../src/net/channel'
import { LockstepClient, LockstepHost, LockstepNode } from '../src/net/lockstep'

// T71 — peer-drop with empty-input substitution. WHY: a disconnected peer
// stalls the tick barrier forever (correct lockstep, terrible UX). The host
// may drop them — but ONLY in a way every surviving peer applies identically,
// or the fix for a stall becomes a desync. These tests encode that contract:
// after dropPlayer, the released stream continues, contains no commands from
// the dropped player, announces the drop, and surviving sims stay hash-equal.

const SEED = 4242

function makeSim(): Sim {
  const sim = new Sim(SEED)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 255, 63, 255, 2)
  return sim
}

function makeSession(clientCount: number, inputDelay = 3) {
  const hostSim = makeSim()
  const host = new LockstepHost(hostSim, 1, inputDelay)
  const clients: LockstepClient[] = []
  const sims = [hostSim]
  const channels: { hostSide: MockChannel; clientSide: MockChannel }[] = []
  for (let i = 0; i < clientCount; i++) {
    const [hostSide, clientSide] = MockChannel.pair()
    const clientSim = makeSim()
    host.addPeer(2 + i, hostSide)
    clients.push(new LockstepClient(clientSim, 2 + i, clientSide, inputDelay))
    sims.push(clientSim)
    channels.push({ hostSide, clientSide })
  }
  const nodes = [host.node, ...clients.map((c) => c.node)]
  const hashes: number[][] = nodes.map(() => [])
  nodes.forEach((n, i) => n.onStep((s) => hashes[i].push(hashSim(s))))
  host.start()
  return { host, clients, nodes, sims, hashes, channels }
}

const dig = (x: number): Op => ({ kind: 'dig', x, y: 60, z: 100, r: 4 })

describe('lockstep peer drop (T71, V2, V3, V10)', () => {
  it('barrier stalls on a dead peer; dropPlayer resumes the stream deterministically', () => {
    const s = makeSession(2)
    const [hostNode, aliveNode, deadNode] = s.nodes
    // run normally for a while, with edits from everyone
    for (let r = 0; r < 10; r++) {
      if (r === 2) {
        hostNode.submitLocal(dig(40))
        aliveNode.submitLocal(dig(80))
        deadNode.submitLocal(dig(120))
      }
      for (const n of s.nodes) n.tryStep()
    }
    expect(s.sims[2].tick).toBeGreaterThan(5)

    // peer 3 dies: its link stalls (nothing it sends arrives at the host)
    s.channels[1].hostSide.pause()
    for (let r = 0; r < 20; r++) {
      hostNode.tryStep()
      aliveNode.tryStep()
    }
    const stalledTick = s.sims[0].tick
    // survivors run out of released ticks: stalled within inputDelay of the barrier
    expect(hostNode.tryStep()).toBe(false)
    expect(s.host.waitingOn()).toContain(3)

    // host drops the dead player → stream resumes without their input
    const drops: { pid: number; tick: number }[] = []
    aliveNode.onPlayerDropped((pid, tick) => drops.push({ pid, tick }))
    s.host.dropPlayer(3)
    for (let r = 0; r < 30; r++) {
      if (r === 5) aliveNode.submitLocal(dig(160)) // survivors keep playing
      hostNode.tryStep()
      aliveNode.tryStep()
    }
    expect(s.sims[0].tick).toBeGreaterThan(stalledTick + 20)
    expect(s.sims[0].tick).toBe(s.sims[1].tick)
    // survivors stayed hash-identical THROUGH the drop (the whole point)
    expect(s.hashes[0]).toEqual(s.hashes[1])
    // the drop was announced in the bundle stream
    expect(drops).toEqual([{ pid: 3, tick: expect.any(Number) }])
    // survivor edits still land
    expect(s.sims[1].world.getVoxel(160, 60, 100)).toBe(0)
  })

  it('discards the dropped player\'s buffered future inputs (bundles never contain them)', () => {
    const s = makeSession(2)
    const [hostNode, aliveNode, deadNode] = s.nodes
    // dead peer submits an op and steps once (its input for tick 3 reaches the
    // host) — but the alive peer hasn't stepped yet, so tick 3 is NOT released
    // when the host drops the dead player: its buffered dig must be scrubbed.
    deadNode.submitLocal(dig(200))
    hostNode.tryStep()
    deadNode.tryStep()
    s.channels[1].hostSide.pause()
    s.host.dropPlayer(3)
    for (let r = 0; r < 12; r++) {
      hostNode.tryStep()
      aliveNode.tryStep()
    }
    aliveNode.tryStep() // host stepped once before the loop — let alive catch up
    // the buffered dig from the dropped player was scrubbed — never applied
    expect(s.sims[0].world.getVoxel(200, 60, 100)).not.toBe(0)
    expect(s.sims[0].tick).toBe(s.sims[1].tick)
    expect(s.hashes[0]).toEqual(s.hashes[1])
  })

  it('late traffic from a dropped peer is ignored, not a protocol error', () => {
    const s = makeSession(1)
    const [hostNode] = s.nodes
    for (const n of s.nodes) n.tryStep()
    s.channels[0].hostSide.pause()
    s.host.dropPlayer(2)
    // the dead peer's queued messages flush AFTER the drop — must be void
    expect(() => s.channels[0].hostSide.resume()).not.toThrow()
    for (let r = 0; r < 10; r++) hostNode.tryStep()
    expect(s.sims[0].tick).toBeGreaterThan(8)
  })

  it('cannot drop the host; dropping an unknown player is a no-op', () => {
    const s = makeSession(1)
    expect(() => s.host.dropPlayer(1)).toThrow(/cannot drop the host/)
    expect(() => s.host.dropPlayer(9)).not.toThrow()
  })

  it('waitingOn() reports stalled players and clears when input flows', () => {
    const s = makeSession(1)
    const [hostNode, clientNode] = s.nodes
    s.channels[0].hostSide.pause()
    for (let r = 0; r < 10; r++) {
      hostNode.tryStep()
      clientNode.tryStep()
    }
    expect(s.host.waitingOn()).toEqual([2])
    // link recovers: queued inputs flush, the barrier opens, ticks flow again
    s.channels[0].hostSide.resume()
    for (let r = 0; r < 10; r++) {
      hostNode.tryStep()
      clientNode.tryStep()
    }
    expect(s.sims[0].tick).toBeGreaterThan(5)
    expect(s.sims[0].tick).toBe(s.sims[1].tick)
  })
})

describe('empty-input substitution determinism (T71, V3)', () => {
  it('a fresh replay of the surviving players\' inputs matches the dropped-session hashes', () => {
    // session A: three players, player 3 drops mid-run
    const a = makeSession(2)
    a.nodes[0].submitLocal(dig(40))
    a.nodes[1].submitLocal(dig(80))
    for (let r = 0; r < 8; r++) for (const n of a.nodes) n.tryStep()
    a.channels[1].hostSide.pause()
    a.host.dropPlayer(3)
    for (let r = 0; r < 20; r++) {
      a.nodes[0].tryStep()
      a.nodes[1].tryStep()
    }

    // session B: player 3 NEVER existed; players 1+2 submit the same ops at
    // the same local ticks. After the ticks where p3's (empty) inputs applied,
    // the surviving state evolution must be identical — that is what
    // "empty-input substitution" means.
    const b = makeSession(1)
    b.nodes[0].submitLocal(dig(40))
    b.nodes[1].submitLocal(dig(80))
    for (let r = 0; r < 28; r++) for (const n of b.nodes) n.tryStep()

    const len = Math.min(a.hashes[0].length, b.hashes[0].length)
    expect(len).toBeGreaterThan(20)
    expect(a.hashes[0].slice(0, len)).toEqual(b.hashes[0].slice(0, len))
  })
})
