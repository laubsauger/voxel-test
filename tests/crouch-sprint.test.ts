import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import {
  CROUCH_HEIGHT,
  INPUT_CROUCH,
  INPUT_FWD,
  INPUT_SPRINT,
  PLAYER_HEIGHT,
} from '../src/sim/player'
import type { Command } from '../src/sim/commands'
import { WORLD_VX, VOXEL_SIZE } from '../src/world/chunks'

// B32 — geometry is built around the world-center spawn column. Derived from
// world size so a future resize never breaks the re-basing.
const CVX = WORLD_VX >> 1 // voxel center
const CM = (WORLD_VX >> 1) * VOXEL_SIZE // metre center = spawn z

// T44 — sprint + functional crouch. Sprint must actually be faster (or the
// bit is dead weight in every replay), crouch must physically shrink the
// capsule (1.2m body under 1.4m gaps) and standing up must be impossible
// without headroom — all through move commands only (V1), hash-visible (V3).

beforeAll(async () => {
  await loadJolt()
}, 30000)

async function makeSim(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(9)
  registerEditOps(sim)
  sim.world.fillBox(CVX - 112, 0, CVX - 112, CVX + 128, 7, CVX + 128, 3) // ground, top at y=0.8m (B32: world center)
  const phys = await createPhysics(sim)
  return { sim, phys }
}

function pushMoves(sim: Sim, from: number, count: number, input: number): number {
  for (let t = from; t < from + count; t++) {
    sim.queue.push({ tick: t, playerId: 1, seq: t, op: { kind: 'move', input, yaw: 0, pitch: 0 } })
  }
  return from + count
}

const SPAWN: Command = { tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } }

/** distance walked in -z over `ticks` ticks of the given input */
async function walkDistance(input: number, ticks: number): Promise<number> {
  const { sim, phys } = await makeSim()
  sim.queue.push(SPAWN)
  pushMoves(sim, 1, ticks, input)
  for (let t = 0; t <= ticks; t++) sim.step()
  const d = CM - phys.players.get(1)!.pz // B32 — spawn z = world center
  phys.dispose()
  return d
}

describe('sprint + crouch speeds (T44)', () => {
  it('sprint covers ~1.6× the walking distance; crouch ~0.5×', async () => {
    const walk = await walkDistance(INPUT_FWD, 60)
    const sprint = await walkDistance(INPUT_FWD | INPUT_SPRINT, 60)
    const crouch = await walkDistance(INPUT_FWD | INPUT_CROUCH, 60)
    expect(walk).toBeGreaterThan(2) // sanity: ~4 m/s minus spin-up
    expect(sprint / walk).toBeGreaterThan(1.4)
    expect(sprint / walk).toBeLessThan(1.8)
    expect(crouch / walk).toBeGreaterThan(0.35)
    expect(crouch / walk).toBeLessThan(0.65)
  }, 30000)
})

/**
 * Low corridor: ceiling slab at y 22..24 (2.2..2.5m) over z 100.7..101.7m — a
 * 1.4m gap above the 0.8m floor. Side walls carry the slab so the
 * connectivity pass keeps it static (an unsupported slab would fall as an
 * island). The player (x=103.4m, voxel 1034) walks between the walls.
 */
function buildTunnel(sim: Sim): void {
  // B32 — walls straddle the world-center spawn column (player x = CM+1m = CVX+10 vox)
  sim.world.fillBox(CVX - 7, 8, CVX - 17, CVX - 5, 21, CVX - 7, 4) // west wall
  sim.world.fillBox(CVX + 21, 8, CVX - 17, CVX + 23, 21, CVX - 7, 4) // east wall
  sim.world.fillBox(CVX - 7, 22, CVX - 17, CVX + 23, 24, CVX - 7, 4) // ceiling
}

describe('functional crouch (T44)', () => {
  it('crouched (1.2m) walks under a 1.4m gap; standing is blocked by it', async () => {
    expect(CROUCH_HEIGHT).toBeCloseTo(1.2, 6)
    expect(PLAYER_HEIGHT).toBeCloseTo(1.65, 6) // B31 — dropped from 1.8m

    const through = async (input: number) => {
      const { sim, phys } = await makeSim()
      buildTunnel(sim)
      sim.queue.push(SPAWN)
      pushMoves(sim, 1, 300, input)
      for (let t = 0; t <= 300; t++) sim.step()
      const pz = phys.players.get(1)!.pz
      const crouching = phys.players.get(1)!.crouching
      phys.dispose()
      return { pz, crouching }
    }

    const standing = await through(INPUT_FWD)
    expect(standing.pz).toBeGreaterThan(CM - 1.0) // stopped at the tunnel mouth
    expect(standing.crouching).toBe(false)

    const crouched = await through(INPUT_FWD | INPUT_CROUCH)
    expect(crouched.pz).toBeLessThan(CM - 2.2) // came out the far side
    expect(crouched.crouching).toBe(true)
  }, 30000)

  it('un-crouch is blocked without headroom, succeeds in the open', async () => {
    const { sim, phys } = await makeSim()
    buildTunnel(sim)
    sim.queue.push(SPAWN)
    // crouch-walk to the middle of the tunnel: 2 m/s → 36 ticks ≈ 1.2m → z≈101.2
    let t = pushMoves(sim, 1, 36, INPUT_FWD | INPUT_CROUCH)
    // stop, release crouch under the ceiling
    t = pushMoves(sim, t, 30, 0)
    while (sim.tick < t) sim.step()
    const p = phys.players.get(1)!
    expect(p.pz).toBeGreaterThan(CM - 1.6) // still inside the tunnel
    expect(p.pz).toBeLessThan(CM - 0.8) // we ARE under the slab
    expect(p.crouching).toBe(true) // no headroom → still crouched
    // crouch-walk out the far side, then release
    t = pushMoves(sim, sim.tick, 60, INPUT_FWD | INPUT_CROUCH)
    t = pushMoves(sim, t, 10, 0)
    while (sim.tick < t) sim.step()
    expect(p.pz).toBeLessThan(CM - 1.8)
    expect(p.crouching).toBe(false) // open sky → stood back up
    phys.dispose()
  }, 30000)

  it('capsule state is hashed (V3) and runs are deterministic (V2)', async () => {
    const run = async () => {
      const { sim, phys } = await makeSim()
      sim.queue.push(SPAWN)
      let t = pushMoves(sim, 1, 20, INPUT_FWD | INPUT_CROUCH)
      t = pushMoves(sim, t, 20, INPUT_FWD | INPUT_SPRINT)
      const hashes: number[] = []
      while (sim.tick < t + 5) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      // white-box: flipping ONLY the crouch flag must change the hash
      const p = phys.players.get(1)!
      const h0 = hashPhysics(phys)
      p.crouching = !p.crouching
      const h1 = hashPhysics(phys)
      p.crouching = !p.crouching
      expect(h1).not.toBe(h0)
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 30000)
})
