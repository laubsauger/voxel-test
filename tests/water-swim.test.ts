import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt } from '../src/sim/physics'
import { attachWaterSim } from '../src/sim/water/water-sim'
import { attachBuoyancy } from '../src/sim/buoyancy-coupling'
import { MAX_LEVEL } from '../src/sim/water/rules'
import { FLOAT_DEPTH, INPUT_CROUCH, INPUT_FWD } from '../src/sim/player'
import type { Command } from '../src/sim/commands'
import type { SplashEvent } from '../src/sim/player'

// T60 — player swimming. The character must FLOAT in deep water (capsule
// buoyancy holds the head above the waterline), sink when crouching, and
// stay bit-deterministic — swimming is sim state feeding lockstep (V2/V3).

beforeAll(async () => {
  await loadJolt()
}, 30000)

/**
 * Deep pool directly under the spawn column (B32 spawn 205.8m → voxel 2058).
 * Without the pillar the player spawns at the pool FLOOR (inside the water);
 * with it they spawn on a diving post above the surface (splash test).
 */
async function makeSwimSim(divingPillar = false) {
  const sim = new Sim(9)
  registerEditOps(sim)
  // ground shell around the pool, floor for the neighborhood — B32 +1024 vox
  sim.world.fillBox(2016, 0, 2016, 2096, 7, 2096, 3)
  // pool basin: interior x/z 2036..2076, water y 8..37 (3m deep — deep water) — B32 +1024 vox
  sim.world.fillBox(2032, 8, 2032, 2080, 38, 2080, 3)
  sim.world.fillBox(2036, 8, 2036, 2076, 38, 2076, 0)
  if (divingPillar) {
    // 3×3 post under the spawn column, top above the waterline — B32 +1024 vox
    sim.world.fillBox(2057, 8, 2047, 2059, 45, 2049, 3)
  }
  const water = attachWaterSim(sim)
  sim.world.onVoxelChanged = (x, y, z) => water.notifyVoxelChanged(x, y, z)
  for (let y = 8; y <= 37; y++) // B32 +1024 vox
    for (let z = 2036; z <= 2076; z++)
      for (let x = 2036; x <= 2076; x++) water.addWater(x, y, z, MAX_LEVEL)
  const phys = await createPhysics(sim)
  attachBuoyancy(sim, phys, water)
  return { sim, phys, water }
}

function cmds(ticks: number, input: number): Command[] {
  const out: Command[] = [{ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } }]
  for (let t = 1; t <= ticks; t++) {
    out.push({ tick: t, playerId: 1, seq: t, op: { kind: 'move', input, yaw: 0, pitch: 0 } })
  }
  return out
}

/** waterline of the test pool in meters (full cells up to y=37 → top at 38) */
const SURFACE_Y = 38 * 0.1

describe('player swimming (T60, V1, V2)', () => {
  it('floats in deep water: py stabilizes near the surface, head out', { timeout: 30000 }, async () => {
    const { sim, phys } = await makeSwimSim()
    for (const c of cmds(600, 0)) sim.queue.push(c)
    for (let t = 0; t <= 600; t++) sim.step()
    const p = phys.players.get(1)!
    expect(p.swimming).toBe(true)
    // spawn drops the capsule into the pool; buoyancy must hold it at the
    // float depth instead of letting it sink 3m to the floor
    expect(p.py).toBeGreaterThan(SURFACE_Y - FLOAT_DEPTH - 0.35)
    expect(p.py).toBeLessThan(SURFACE_Y) // not levitating out of the pool
    expect(Math.abs(p.vy)).toBeLessThan(0.5) // settled, not oscillating
    phys.dispose()
  })

  it('crouch sinks, releasing crouch floats back up', { timeout: 30000 }, async () => {
    const { sim, phys } = await makeSwimSim()
    for (const c of cmds(300, INPUT_CROUCH)) sim.queue.push(c)
    for (let t = 0; t <= 300; t++) sim.step()
    const p = phys.players.get(1)!
    const sunkY = p.py
    expect(p.swimming).toBe(true)
    expect(sunkY).toBeLessThan(SURFACE_Y - FLOAT_DEPTH - 0.5) // clearly below float depth
    // release crouch → buoyancy brings the player back toward the surface
    for (let t = 301; t <= 600; t++) {
      sim.queue.push({ tick: t, playerId: 1, seq: t, op: { kind: 'move', input: 0, yaw: 0, pitch: 0 } })
    }
    for (let t = 301; t <= 600; t++) sim.step()
    expect(p.py).toBeGreaterThan(sunkY + 0.5)
    expect(p.py).toBeGreaterThan(SURFACE_Y - FLOAT_DEPTH - 0.35)
    phys.dispose()
  })

  it('swimming forward moves slower than walking and stays deterministic', { timeout: 60000 }, async () => {
    const run = async () => {
      const { sim, phys } = await makeSwimSim()
      for (const c of cmds(240, INPUT_FWD)) sim.queue.push(c)
      const hashes: number[] = []
      for (let t = 0; t <= 240; t++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      const p = phys.players.get(1)!
      const out = { pos: [p.px, p.py, p.pz], hashes }
      phys.dispose()
      return out
    }
    const a = await run()
    const b = await run()
    expect(Object.is(a.pos[0], b.pos[0])).toBe(true) // exact f64 bits (V2/V3)
    expect(Object.is(a.pos[1], b.pos[1])).toBe(true)
    expect(Object.is(a.pos[2], b.pos[2])).toBe(true)
    expect(b.hashes).toEqual(a.hashes)
  })

  it('emits a splash event on plunging in (audio/particles hook)', { timeout: 30000 }, async () => {
    // spawn on a diving post above the surface, step off, drop straight in
    const { sim, phys } = await makeSwimSim(true)
    const splashes: SplashEvent[] = []
    phys.onSplash = (e) => splashes.push(e)
    sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
    for (let t = 1; t <= 240; t++) {
      const input = t <= 12 ? INPUT_FWD : 0 // walk off the edge, then free-fall
      sim.queue.push({ tick: t, playerId: 1, seq: t, op: { kind: 'move', input, yaw: 0, pitch: 0 } })
    }
    for (let t = 0; t <= 240; t++) sim.step()
    expect(splashes.length).toBeGreaterThan(0)
    expect(splashes[0].entering).toBe(true)
    expect(splashes[0].speed).toBeGreaterThan(1)
    expect(splashes[0].playerId).toBe(1)
    phys.dispose()
  })
})
