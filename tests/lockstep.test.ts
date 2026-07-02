import { describe, expect, it } from 'vitest'
import { Sim, TICK_MS } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import type { Op } from '../src/sim/commands'
import { MockChannel } from '../src/net/channel'
import { LockstepClient, LockstepDriver, LockstepHost, LockstepNode } from '../src/net/lockstep'

// T25 (V2, V3): lockstep peers must apply IDENTICAL command streams at
// IDENTICAL ticks — the whole co-op model rides on this. These tests run two
// (or three) real Sims over in-memory channels; no WebRTC in the loop.

const SEED = 4242

function makeSim(): Sim {
  const sim = new Sim(SEED)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 255, 63, 255, 2)
  return sim
}

interface Session {
  host: LockstepHost
  clients: LockstepClient[]
  nodes: LockstepNode[]
  sims: Sim[]
  hashes: number[][]
  channels: { hostSide: MockChannel; clientSide: MockChannel }[]
}

function makeSession(clientCount = 1, inputDelay = 3): Session {
  const hostSim = makeSim()
  const host = new LockstepHost(hostSim, 1, inputDelay)
  const clients: LockstepClient[] = []
  const sims = [hostSim]
  const channels: Session['channels'] = []
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

/** attempt one step on every node, round-robin, `rounds` times */
function pump(nodes: LockstepNode[], rounds: number): void {
  for (let r = 0; r < rounds; r++) for (const n of nodes) n.tryStep()
}

const dig = (x: number): Op => ({ kind: 'dig', x, y: 60, z: 100, r: 4 })

describe('lockstep convergence (T25, V2, V3)', () => {
  it('two sims with inputs on both sides stay tick-locked with identical hash sequences', () => {
    const s = makeSession(1)
    const [hostNode, clientNode] = s.nodes
    for (let r = 0; r < 60; r++) {
      if (hostNode.sim.tick === 4) hostNode.submitLocal(dig(50))
      if (clientNode.sim.tick === 4) clientNode.submitLocal(dig(150))
      if (clientNode.sim.tick === 20) clientNode.submitLocal(dig(80))
      pump(s.nodes, 1)
    }
    expect(s.sims[0].tick).toBe(s.sims[1].tick)
    expect(s.sims[0].tick).toBeGreaterThan(50)
    expect(s.hashes[0]).toEqual(s.hashes[1])
    // the digs actually landed (streams weren't just empty on both sides)
    expect(s.sims[0].world.getVoxel(50, 60, 100)).toBe(0)
    expect(s.sims[1].world.getVoxel(150, 60, 100)).toBe(0)
  })

  it('three peers (host + 2 clients) converge identically', () => {
    const s = makeSession(2)
    for (let r = 0; r < 40; r++) {
      if (s.nodes[1].sim.tick === 3) s.nodes[1].submitLocal(dig(30))
      if (s.nodes[2].sim.tick === 7) s.nodes[2].submitLocal(dig(90))
      pump(s.nodes, 1)
    }
    expect(s.sims.map((x) => x.tick)).toEqual([s.sims[0].tick, s.sims[0].tick, s.sims[0].tick])
    expect(s.hashes[1]).toEqual(s.hashes[0])
    expect(s.hashes[2]).toEqual(s.hashes[0])
  })

  it('every tick is explicitly released: sims advance with zero inputs', () => {
    const s = makeSession(1)
    pump(s.nodes, 30)
    expect(s.sims[0].tick).toBe(30)
    expect(s.sims[1].tick).toBe(30)
  })
})

describe('input delay (T25)', () => {
  it('op submitted at tick T applies at exactly T+delay on ALL peers', () => {
    const delay = 3
    const hostSim = makeSim()
    const clientSim = makeSim()
    const appliedHost: number[] = []
    const appliedClient: number[] = []
    hostSim.onOp('spawn', (sm) => appliedHost.push(sm.tick))
    clientSim.onOp('spawn', (sm) => appliedClient.push(sm.tick))

    const host = new LockstepHost(hostSim, 1, delay)
    const [hostSide, clientSide] = MockChannel.pair()
    host.addPeer(2, hostSide)
    const client = new LockstepClient(clientSim, 2, clientSide, delay)
    host.start()

    const nodes = [host.node, client.node]
    for (let r = 0; r < 20; r++) {
      if (client.node.sim.tick === 5) client.node.submitLocal({ kind: 'spawn' })
      if (host.node.sim.tick === 9) host.node.submitLocal({ kind: 'spawn' })
      pump(nodes, 1)
    }
    expect(appliedHost).toEqual([5 + delay, 9 + delay])
    expect(appliedClient).toEqual([5 + delay, 9 + delay])
  })

  it('respects a non-default delay', () => {
    const delay = 5
    const s = makeSession(1, delay)
    const applied: number[] = []
    s.sims[1].onOp('spawn', (sm) => applied.push(sm.tick))
    s.sims[0].onOp('spawn', () => {})
    for (let r = 0; r < 15; r++) {
      if (s.nodes[0].sim.tick === 2) s.nodes[0].submitLocal({ kind: 'spawn' })
      pump(s.nodes, 1)
    }
    expect(applied).toEqual([2 + delay])
  })
})

describe('tick barrier stall (T25, V10-adjacent: waiting, never drifting)', () => {
  it('missing bundles freeze the sim — no free-running, no drift after resume', () => {
    const s = makeSession(1)
    const { hostSide, clientSide } = s.channels[0]

    pump(s.nodes, 10)
    expect(s.sims[1].tick).toBe(10)

    // stall the link in both directions: bundles stop reaching the client,
    // inputs stop reaching the host
    clientSide.pause()
    hostSide.pause()
    s.nodes[1].submitLocal(dig(70)) // input submitted during the stall

    pump(s.nodes, 50)
    const hostTickStalled = s.sims[0].tick
    const clientTickStalled = s.sims[1].tick
    // client consumed at most what was already released; host stalls once it
    // needs the client's inputs — neither free-runs 50 ticks
    expect(clientTickStalled).toBeLessThan(20)
    expect(hostTickStalled).toBeLessThan(20)

    pump(s.nodes, 25)
    expect(s.sims[0].tick).toBe(hostTickStalled) // fully stalled, not creeping
    expect(s.sims[1].tick).toBe(clientTickStalled)

    // resume: queued messages flush, both catch up, histories identical
    clientSide.resume()
    hostSide.resume()
    pump(s.nodes, 60)
    expect(s.sims[0].tick).toBe(s.sims[1].tick)
    expect(s.sims[0].tick).toBeGreaterThan(hostTickStalled)
    expect(s.hashes[0]).toEqual(s.hashes[1])
    expect(s.sims[0].world.getVoxel(70, 60, 100)).toBe(0) // stalled input landed
  })

  it('LockstepDriver holds time at the barrier instead of stepping', () => {
    const sim = makeSim()
    // node with no bundles at all: barrier is permanently closed
    const node = new LockstepNode(sim, 1, () => {})
    const driver = new LockstepDriver()
    expect(driver.advance(TICK_MS * 5, node)).toBe(0)
    expect(sim.tick).toBe(0)
    // once bundles exist, held time is consumed (capped, no burst spiral)
    for (let t = 0; t < 20; t++) node.receiveBundle({ t: 'ls/bundle', tick: t, cmds: [] })
    const steps = driver.advance(0, node)
    expect(steps).toBeGreaterThan(0)
    expect(steps).toBeLessThanOrEqual(driver.maxStepsPerAdvance)
  })
})

describe('lockstep loud failures (V10)', () => {
  it('duplicate bundle for a tick throws', () => {
    const sim = makeSim()
    const node = new LockstepNode(sim, 1, () => {})
    node.receiveBundle({ t: 'ls/bundle', tick: 0, cmds: [] })
    expect(() => node.receiveBundle({ t: 'ls/bundle', tick: 0, cmds: [] })).toThrow(/duplicate/)
  })

  it('host rejects input impersonating another player', () => {
    const s = makeSession(1)
    const forged = JSON.stringify({ t: 'ls/input', playerId: 1, tick: 99, cmds: [] })
    expect(() => s.channels[0].clientSide.send(forged)).toThrow(/claiming/)
  })

  it('host rejects unknown lockstep message types', () => {
    const s = makeSession(1)
    expect(() => s.channels[0].clientSide.send(JSON.stringify({ t: 'ls/wat' }))).toThrow(/unknown/)
  })

  it('adding a peer after start throws (late join goes through snapshot)', () => {
    const s = makeSession(1)
    const [extra] = MockChannel.pair()
    expect(() => s.host.addPeer(9, extra)).toThrow(/snapshot/)
  })
})
