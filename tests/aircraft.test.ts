import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt } from '../src/sim/physics'
import { INPUT_CROUCH, INPUT_FWD, INPUT_JUMP, INPUT_LEFT, INPUT_RIGHT } from '../src/sim/player'
import type { Command, Op } from '../src/sim/commands'
import { WORLD_VX, VOXEL_SIZE } from '../src/world/chunks'

// P17 — flyable plane: aircraft are lockstep sim entities exactly like the
// drivable cars. WHY these tests: the flight physics run inside the fixed sim
// tick and are folded into the physics hash, so ANY nondeterminism here desyncs
// multiplayer (V10). The determinism test is the non-negotiable gate; the
// takeoff + crash tests pin the arcade fantasy the task ships (throttle →
// takeoff → climb, and a hard impact tears world voxels + dents the plane).

const CVX = WORLD_VX >> 1 // voxel center
const CM = (WORLD_VX >> 1) * VOXEL_SIZE // metre center = spawn x/z
const GROUND_Y = 0.8 // ground surface (m) for the slab below

beforeAll(async () => {
  await loadJolt()
}, 30000)

/** big flat runway slab around the spawn column (world center) */
function makeSim(seed: number): Sim {
  const sim = new Sim(seed)
  registerEditOps(sim)
  sim.world.fillBox(CVX - 192, 0, CVX - 640, CVX + 191, 7, CVX + 95, 3)
  return sim
}

const cmd = (tick: number, op: Op, playerId = 1, seq = 0): Command => ({ tick, playerId, seq, op })

describe('aircraft spawn + board (P17)', () => {
  it('spawns a flyable plane that rests on its gear; player boards as pilot', async () => {
    const sim = makeSim(11)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'aircraft_spawn', x: CM, y: GROUND_Y, z: CM + 2.5, yaw: 0 }, 1, 1))
    for (let i = 0; i < 60; i++) sim.step()

    expect(phys.aircraft.size).toBe(1)
    const a = [...phys.aircraft.values()][0]
    // settled on the runway, upright, not launched
    expect(a.py).toBeGreaterThan(GROUND_Y - 0.3)
    expect(a.py).toBeLessThan(GROUND_Y + 1.5)
    expect(1 - 2 * (a.qx * a.qx + a.qz * a.qz)).toBeGreaterThan(0.9) // local up ≈ up
    expect(Math.hypot(a.vx, a.vy, a.vz)).toBeLessThan(1.5) // parked, engine off

    // board
    sim.queue.push(cmd(sim.tick, { kind: 'aircraft_enter' }))
    sim.step()
    const p = phys.players.get(1)!
    expect(p.seatedAircraft).toBe(a.id)
    expect(a.occupants[0]).toBe(1)
    phys.dispose()
  }, 30000)
})

describe('flight: throttle → takeoff → climb (P17)', () => {
  it('builds airspeed under throttle and leaves the ground when the nose is up', async () => {
    const sim = makeSim(21)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'aircraft_spawn', x: CM, y: GROUND_Y, z: CM + 2.5, yaw: 0 }, 1, 1))
    for (let i = 0; i < 40; i++) sim.step()
    const a = [...phys.aircraft.values()][0]
    sim.queue.push(cmd(sim.tick, { kind: 'aircraft_enter' }))
    sim.step()
    expect(phys.players.get(1)!.seatedAircraft).toBe(a.id)

    const startY = a.py
    let maxSpeed = 0
    let maxY = a.py
    // full throttle throughout; a nose-up pitch pulse to rotate off the runway
    for (let i = 0; i < 180; i++) {
      const pitchUp = i >= 40 && i < 110 ? INPUT_JUMP : 0
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD | pitchUp, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
      maxSpeed = Math.max(maxSpeed, Math.hypot(a.vx, a.vy, a.vz))
      maxY = Math.max(maxY, a.py)
    }
    // reached flight speed and got airborne (climbed clear of the runway)
    expect(maxSpeed).toBeGreaterThan(18)
    expect(maxSpeed).toBeLessThan(70)
    expect(maxY - startY).toBeGreaterThan(3)
    phys.dispose()
  }, 60000)
})

describe('crash: flying into a building tears world voxels + dents the plane (P17)', () => {
  it('a hard impact chews the wall and damages the chassis', async () => {
    const sim = makeSim(31)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'aircraft_spawn', x: CM, y: GROUND_Y, z: CM + 2.5, yaw: 0 }, 1, 1))
    // tall brick wall across the flight path (plane flies toward -z at yaw 0)
    sim.world.fillBox(CVX - 30, 8, CVX - 42, CVX + 30, 80, CVX - 40, 5)
    const wallVoxels = (): number => {
      let n = 0
      for (let y = 8; y <= 80; y++)
        for (let z = CVX - 42; z <= CVX - 40; z++)
          for (let x = CVX - 30; x <= CVX + 30; x++) if (sim.world.getVoxel(x, y, z) !== 0) n++
      return n
    }
    for (let i = 0; i < 40; i++) sim.step()
    const a = [...phys.aircraft.values()][0]
    const wall0 = wallVoxels()
    const count0 = a.count

    sim.queue.push(cmd(sim.tick, { kind: 'aircraft_enter' }))
    sim.step()
    let crashed = false
    for (let i = 0; i < 240; i++) {
      // throttle + a touch of nose-up so it flies into the wall at altitude
      const pitchUp = i >= 30 && i < 80 ? INPUT_JUMP : 0
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD | pitchUp, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
      for (const e of sim.drainEvents()) {
        if ((e as { kind: string }).kind === 'vehicle_crash') crashed = true
      }
      if (crashed && a.count < count0) break
    }
    expect(crashed).toBe(true)
    expect(wallVoxels()).toBeLessThan(wall0) // world voxels torn out
    expect(a.count).toBeLessThan(count0) // chassis dented
    phys.dispose()
  }, 90000)
})

describe('determinism (V2/V3): identical inputs ⇒ identical hash sequence (P17)', () => {
  async function run(seed: number, ticks: number): Promise<number[]> {
    const sim = makeSim(seed)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'aircraft_spawn', x: CM, y: GROUND_Y, z: CM + 2.5, yaw: 0.2 }, 1, 1))
    sim.queue.push(cmd(30, { kind: 'aircraft_enter' }, 1, 2))
    // scripted flight: throttle + a pitch wiggle + a turn wiggle (exercise every
    // control branch), then throttle down (brake) at the end
    for (let t = 31; t < 160; t++) {
      const pitch = t % 60 < 30 ? INPUT_JUMP : INPUT_CROUCH
      const turn = t % 40 < 20 ? INPUT_LEFT : INPUT_RIGHT
      const throttle = t < 130 ? INPUT_FWD : 0
      sim.queue.push(cmd(t, { kind: 'move', input: throttle | pitch | turn, yaw: 0, pitch: 0 }, 1, 100 + t))
    }
    const hashes: number[] = []
    for (let i = 0; i < ticks; i++) {
      sim.step()
      hashes.push(hashSim(sim) ^ hashPhysics(phys))
    }
    phys.dispose()
    return hashes
  }

  it('same command log ⇒ same hash sequence across runs', async () => {
    const a = await run(77, 180)
    const b = await run(77, 180)
    expect(b).toEqual(a)
  }, 120000)
})
