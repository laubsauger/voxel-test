import { describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import type { Command } from '../src/sim/commands'
import { MockChannel } from '../src/net/channel'
import { DesyncDetectorHost, DesyncReporter, type DesyncEvent } from '../src/net/desync'

// T27 (V10): divergence must surface loud with the exact checkpoint tick;
// identical sims must stay green indefinitely (no false positives).

const INTERVAL = 30

function makeSim(): Sim {
  const sim = new Sim(555)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 255, 63, 255, 2)
  return sim
}

interface Rig {
  hostSim: Sim
  clientSim: Sim
  detector: DesyncDetectorHost
  reporter: DesyncReporter
  hostEvents: DesyncEvent[]
  clientEvents: DesyncEvent[]
  /** steps both sims once with identical commands + reports hashes */
  stepBoth: (cmds?: Command[]) => void
}

function makeRig(): Rig {
  const hostSim = makeSim()
  const clientSim = makeSim()
  const [hostSide, clientSide] = MockChannel.pair()
  const detector = new DesyncDetectorHost(hostSim, 1, INTERVAL)
  detector.addPeer(2, hostSide)
  const reporter = new DesyncReporter(clientSim, 2, clientSide, INTERVAL)
  const hostEvents: DesyncEvent[] = []
  const clientEvents: DesyncEvent[] = []
  detector.onDesync((e) => hostEvents.push(e))
  reporter.onDesync((e) => clientEvents.push(e))
  const stepBoth = (cmds: Command[] = []) => {
    for (const c of cmds) {
      hostSim.queue.push(structuredClone(c))
      clientSim.queue.push(structuredClone(c))
    }
    hostSim.step()
    clientSim.step()
    detector.afterStep()
    reporter.afterStep()
  }
  return { hostSim, clientSim, detector, reporter, hostEvents, clientEvents, stepBoth }
}

describe('desync detector (T27, V10)', () => {
  it('stays green over many checkpoint rounds on identical sims', () => {
    const rig = makeRig()
    for (let i = 0; i < INTERVAL * 10; i++) {
      const cmds: Command[] =
        rig.hostSim.tick % 17 === 0
          ? [{ tick: rig.hostSim.tick, playerId: 1, seq: rig.hostSim.tick, op: { kind: 'dig', x: 40 + rig.hostSim.tick, y: 60, z: 40, r: 3 } }]
          : []
      rig.stepBoth(cmds)
    }
    expect(rig.hostEvents).toHaveLength(0)
    expect(rig.clientEvents).toHaveLength(0)
    expect(rig.detector.lastVerifiedTick).toBe(INTERVAL * 10)
  })

  it('fires on BOTH host and client with the correct checkpoint tick after forced divergence', () => {
    const rig = makeRig()
    for (let i = 0; i < 45; i++) rig.stepBoth() // green through checkpoint 30
    expect(rig.hostEvents).toHaveLength(0)

    // force-diverge: poke the client world directly, bypassing commands —
    // exactly the class of bug (V1 violation) the detector exists to catch
    rig.clientSim.world.setVoxel(10, 10, 10, 9)

    for (let i = 0; i < 20; i++) rig.stepBoth() // crosses checkpoint 60
    expect(rig.hostEvents).toHaveLength(1)
    expect(rig.clientEvents).toHaveLength(1)
    expect(rig.hostEvents[0].tick).toBe(60) // first checkpoint ≥ divergence tick 45
    const [a, b] = rig.hostEvents[0].hashes
    expect(a.playerId).toBe(1)
    expect(b.playerId).toBe(2)
    expect(a.hash).not.toBe(b.hash)
    expect(rig.clientEvents[0]).toEqual(rig.hostEvents[0])
    expect(rig.detector.lastVerifiedTick).toBe(30)
  })

  it('diverged prng state (not just voxels) is caught too', () => {
    const rig = makeRig()
    rig.clientSim.prng.nextU32() // consume randomness on one side only
    for (let i = 0; i < INTERVAL; i++) rig.stepBoth()
    expect(rig.hostEvents).toHaveLength(1)
    expect(rig.hostEvents[0].tick).toBe(INTERVAL)
  })

  it('throws if a desync fires with no handler wired — never silent (V10)', () => {
    const hostSim = makeSim()
    const clientSim = makeSim()
    const [hostSide, clientSide] = MockChannel.pair()
    const detector = new DesyncDetectorHost(hostSim, 1, INTERVAL)
    detector.addPeer(2, hostSide)
    const reporter = new DesyncReporter(clientSim, 2, clientSide, INTERVAL)
    clientSim.world.setVoxel(1, 1, 1, 4)
    expect(() => {
      for (let i = 0; i < INTERVAL; i++) {
        hostSim.step()
        clientSim.step()
        detector.afterStep()
        reporter.afterStep()
      }
    }).toThrow(/DESYNC at tick 30/)
    void reporter
  })

  it('desync and lockstep traffic share a channel without cross-talk', () => {
    const rig = makeRig()
    // unrelated protocol messages on the same channel must be ignored by dd/*
    const [hostSide, clientSide] = MockChannel.pair()
    const det = new DesyncDetectorHost(rig.hostSim, 1, INTERVAL)
    det.addPeer(3, hostSide)
    expect(() => clientSide.send(JSON.stringify({ t: 'ls/bundle', tick: 0, cmds: [] }))).not.toThrow()
    expect(() => clientSide.send(new ArrayBuffer(16))).not.toThrow()
    expect(() => clientSide.send(JSON.stringify({ t: 'dd/bogus' }))).toThrow(/unknown/)
  })
})
