import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt } from '../src/sim/physics'
import { INPUT_FWD, INPUT_JUMP, INPUT_LEFT } from '../src/sim/player'
import { breakWheel, vehicleSpawnClear, WHEEL_BREAK_HITS, WRECK_FRACTION } from '../src/sim/vehicle'
import type { Command, Op } from '../src/sim/commands'

// T64 — drivable vehicles: spawn/enter/drive/exit determinism (V1/V2/V3/V8),
// crash voxel damage (world + chassis), wheel loss, wreck conversion, seat
// exit clearance. WHY these tests: vehicles are lockstep sim entities — any
// nondeterminism here desyncs multiplayer (V10), and crash damage is the
// core GTA fantasy the task ships.

beforeAll(async () => {
  await loadJolt()
}, 30000)

/** ground slab around the player spawn column (world center, T50) */
function makeSim(seed: number): Sim {
  const sim = new Sim(seed)
  registerEditOps(sim)
  // 12.8 m tall ground top at y=0.8 m under the spawn area (voxel 992..1119)
  sim.world.fillBox(832, 0, 384, 1215, 7, 1119, 3)
  return sim
}

const cmd = (tick: number, op: Op, playerId = 1, seq = 0): Command => ({ tick, playerId, seq, op })

/** ground surface height in meters for the slab above */
const GROUND_Y = 0.8

describe('vehicle spawn (T64.1, V8)', () => {
  it('spawns a sedan that settles on its wheels and stays upright', async () => {
    const sim = makeSim(11)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 105, yaw: 0 }))
    for (let i = 0; i < 90; i++) sim.step()

    expect(phys.vehicles.size).toBe(1)
    const v = [...phys.vehicles.values()][0]
    // wheel voxels stripped from the chassis grid, 4 physics wheels instead
    expect(v.wheels).toHaveLength(4)
    expect(v.count).toBeLessThan(v.initialCount + 1)
    expect(v.count).toBeGreaterThan(200)
    // settled: resting near the ground, not sunk, not launched
    expect(v.py).toBeGreaterThan(GROUND_Y - 0.2)
    expect(v.py).toBeLessThan(GROUND_Y + 1)
    // upright: local up stays up (quat rotates (0,1,0) to y ≈ 1)
    const upY = 1 - 2 * (v.qx * v.qx + v.qz * v.qz)
    expect(upY).toBeGreaterThan(0.95)
    phys.dispose()
  }, 30000)

  it('vehicleSpawnClear rejects footprints intersecting walls (B24)', async () => {
    const sim = makeSim(12)
    // wall crossing the candidate footprint
    sim.world.fillBox(1015, 8, 1040, 1035, 20, 1042, 5)
    expect(vehicleSpawnClear(sim.world, 'sedan0', 102.4, GROUND_Y, 104.1, 0)).toBe(false)
    // open ground is fine
    expect(vehicleSpawnClear(sim.world, 'sedan0', 102.4, GROUND_Y, 110, 0)).toBe(true)
    // mid-air (no ground under the wheels) is not a valid spawn
    expect(vehicleSpawnClear(sim.world, 'sedan0', 102.4, GROUND_Y + 5, 110, 0)).toBe(false)
  })
})

describe('enter / drive / exit (T64.2, V1)', () => {
  it('player enters as driver, drives forward, exits beside the door', async () => {
    const sim = makeSim(21)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 105, yaw: 0 }, 1, 1))
    for (let i = 0; i < 30; i++) sim.step() // let both settle

    const p = phys.players.get(1)!
    const v = [...phys.vehicles.values()][0]
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    expect(p.seatedVehicle).toBe(v.id)
    expect(p.seat).toBe(0) // driver seat
    expect(v.occupants[0]).toBe(1)

    // seated: capsule parks at the seat and follows the vehicle
    const seatDist = Math.hypot(p.px - v.px, p.pz - v.pz)
    expect(seatDist).toBeLessThan(4)

    // drive forward (yaw 0 → car forward = world -z)
    const z0 = v.pz
    for (let i = 0; i < 150; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
    }
    expect(z0 - v.pz).toBeGreaterThan(3) // actually drove somewhere
    const speed = Math.hypot(v.vx, v.vy, v.vz)
    expect(speed).toBeGreaterThan(3)
    expect(speed).toBeLessThan(21.5) // arcade top-speed clamp

    // steering: hold left → yaw changes
    const qy0 = v.qy
    for (let i = 0; i < 60; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD | INPUT_LEFT, yaw: 0, pitch: 0 }, 1, 300 + i))
      sim.step()
    }
    expect(Math.abs(v.qy - qy0)).toBeGreaterThan(0.02)

    // handbrake stops it (jump bit)
    for (let i = 0; i < 180; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_JUMP, yaw: 0, pitch: 0 }, 1, 500 + i))
      sim.step()
    }
    expect(Math.hypot(v.vx, v.vy, v.vz)).toBeLessThan(1.5)

    // exit: player unseats to a voxel-clear spot beside the car
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_exit' }, 1, 900))
    sim.step()
    expect(p.seatedVehicle).toBe(0)
    expect(v.occupants[0]).toBe(0)
    const exitDist = Math.hypot(p.px - v.px - (v.sx * 0.1) / 2, p.pz - v.pz - (v.sz * 0.1) / 2)
    expect(exitDist).toBeGreaterThan(0.8) // outside the hull
    expect(exitDist).toBeLessThan(6)
    phys.dispose()
  }, 60000)

  it('exit picks the clear side when the door side is walled off', async () => {
    const sim = makeSim(22)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    // car with its LEFT (driver, -x) side hugging a wall
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 105, yaw: 0 }, 1, 1))
    for (let i = 0; i < 20; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    // wall along the driver side, meters x ≈ 100.4..100.9 (voxels 1004..1009)
    sim.world.fillBox(1004, 8, 1020, 1009, 30, 1120, 4)
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    const p = phys.players.get(1)!
    expect(p.seatedVehicle).toBe(v.id)
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_exit' }, 1, 10))
    sim.step()
    expect(p.seatedVehicle).toBe(0)
    // placed on the passenger (+x) side, NOT inside the wall band
    expect(p.px).toBeGreaterThan(101.0)
    phys.dispose()
  }, 30000)
})

describe('crash damage (T64.3)', () => {
  it('driving into a wall dents the chassis and chews world voxels', async () => {
    const sim = makeSim(31)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan1', x: 102.4, y: GROUND_Y, z: 106, yaw: 0 }, 1, 1))
    // brick wall across the car's path at z voxels 980..982
    sim.world.fillBox(1000, 8, 980, 1048, 24, 982, 5)
    for (let i = 0; i < 20; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    const wallVoxels = () => {
      let n = 0
      for (let y = 8; y <= 24; y++)
        for (let z = 980; z <= 982; z++)
          for (let x = 1000; x <= 1048; x++) if (sim.world.getVoxel(x, y, z) !== 0) n++
      return n
    }
    const wall0 = wallVoxels()
    const count0 = v.count

    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    let crashed = false
    for (let i = 0; i < 300; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
      for (const e of sim.drainEvents()) {
        if ((e as { kind: string }).kind === 'vehicle_crash') crashed = true
      }
      if (crashed) break
    }
    expect(crashed).toBe(true)
    // crash chews the wall AND dents the car (grid version bump = render rebuild)
    expect(wallVoxels()).toBeLessThan(wall0)
    expect(v.count).toBeLessThan(count0)
    expect(v.version).toBeGreaterThan(0)
    phys.dispose()
  }, 60000)

  it('wheel loss degrades handling and spawns debris', async () => {
    const sim = makeSim(32)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 105, yaw: 0 }))
    for (let i = 0; i < 30; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    const bodies0 = phys.bodies.size

    expect(WHEEL_BREAK_HITS).toBeGreaterThan(1) // one tap must not cost a wheel
    breakWheel(sim, phys, v, 0) // front-left
    expect(v.wheels[0].broken).toBe(true)
    expect(phys.bodies.size).toBe(bodies0 + 1) // the wheel flew off as debris

    // broken wheel is dead physics-wise: no steering on that corner
    for (let i = 0; i < 30; i++) sim.step()
    expect(Math.abs(v.wheels[0].steer)).toBe(0)
    phys.dispose()
  }, 30000)

  it('a bombed-out vehicle becomes a plain DynamicBody wreck (same id)', async () => {
    const sim = makeSim(33)
    const phys = await createPhysics(sim)
    // plaster-bodied sedan: soft chassis, one bomb guts it
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan2', x: 102.4, y: GROUND_Y, z: 105, yaw: 0 }))
    for (let i = 0; i < 30; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    const id = v.id
    // bomb right at the cabin (voxel coords)
    sim.queue.push(cmd(sim.tick, { kind: 'explode', x: 1024, y: 14, z: 1050, r: 14, power: 5 }))
    sim.step()
    for (let i = 0; i < 20; i++) sim.step()

    // vehicle left the vehicles map…
    expect(phys.vehicles.has(id)).toBe(false)
    // …and lives on as a wreck body with the SAME entity id (V8), or was
    // fully vaporized (removedVehicles counted) — either way, never both.
    const wrecked = phys.bodies.has(id)
    expect(wrecked || phys.removedVehicles > 0).toBe(true)
    if (wrecked) {
      const wreck = phys.bodies.get(id)!
      expect(wreck.count).toBeLessThan(v.initialCount * WRECK_FRACTION)
    }
    phys.dispose()
  }, 30000)
})

describe('momentum-scaled mutual damage: through fences, stopped by walls (T64.3)', () => {
  // WHY: this is the acceptance sentence of the crash contract — weak built
  // materials must yield to a moving car (plow pass), strong masonry must
  // stop it (Jolt) while taking a momentum-scaled bite (crash response).

  it('crashes THROUGH a wood picket fence: fence section gone, car ≥95% intact', async () => {
    const sim = makeSim(41)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 106, yaw: 0 }, 1, 1))
    // picket fence across the path: 1 voxel thick, 1.2 m tall, wood
    sim.world.fillBox(1000, 8, 1000, 1048, 19, 1000, 6)
    for (let i = 0; i < 20; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    for (let i = 0; i < 240; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
    }
    // car came out the OTHER side of the fence (fence plane z = 100.0 m)
    expect(v.pz + (v.sz * 0.1) / 2).toBeLessThan(99.5)
    // car barely dented
    expect(v.count).toBeGreaterThanOrEqual(v.initialCount * 0.95)
    // the fence section in the car's corridor is gone
    let corridor = 0
    for (let y = 8; y <= 19; y++)
      for (let x = 1014; x <= 1033; x++) if (sim.world.getVoxel(x, y, 1000) !== 0) corridor++
    // was 20 wide × 12 tall = 240 voxels; the ground-level base row (20) may
    // survive (below the lowest plow ray — the car hops it like a curb)
    expect(corridor).toBeLessThan(240 * 0.25)
    phys.dispose()
  }, 60000)

  it('is STOPPED by a brick wall: hard stop, partial breach, crumpled front', async () => {
    const sim = makeSim(42)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 106, yaw: 0 }, 1, 1))
    // thick brick wall (5 voxels) across the path at z = 99.0..99.4 m
    sim.world.fillBox(1000, 8, 990, 1048, 26, 994, 5)
    const wallVoxels = () => {
      let n = 0
      for (let y = 8; y <= 26; y++)
        for (let z = 990; z <= 994; z++)
          for (let x = 1000; x <= 1048; x++) if (sim.world.getVoxel(x, y, z) !== 0) n++
      return n
    }
    const wall0 = wallVoxels()
    for (let i = 0; i < 20; i++) sim.step()
    const v = [...phys.vehicles.values()][0]
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    for (let i = 0; i < 300; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
    }
    // the car did NOT punch through (wall back face at z = 99.0 m)
    expect(v.pz).toBeGreaterThan(98.8)
    // hard stop (throttle still pinned, wall wins)
    expect(Math.hypot(v.vx, v.vy, v.vz)).toBeLessThan(2)
    // wall took a bite but stands: partial breach only
    const lost = wall0 - wallVoxels()
    expect(lost).toBeGreaterThan(0)
    expect(lost).toBeLessThan(wall0 * 0.4)
    // car front crumpled — real chassis damage, but not a wreck
    expect(v.count).toBeLessThan(v.initialCount)
    expect(v.count).toBeGreaterThan(v.initialCount * WRECK_FRACTION)
    phys.dispose()
  }, 60000)

  it('vehicle-caused damage feeds the structural pass: plowed pillar drops its slab', async () => {
    const sim = makeSim(43)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: GROUND_Y, z: 106, yaw: 0 }, 1, 1))
    // wooden pillar in the car's path carrying a brick slab overhead (2.0 m up
    // — the car passes under the slab, plows the pillar, the slab must fall)
    sim.world.fillBox(1022, 8, 998, 1025, 27, 1000, 6) // pillar (wood)
    sim.world.fillBox(1014, 28, 994, 1033, 30, 1004, 5) // slab (brick), pillar-only support
    for (let i = 0; i < 20; i++) sim.step()
    const bodies0 = phys.bodies.size
    sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
    sim.step()
    for (let i = 0; i < 240; i++) {
      sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
      sim.step()
    }
    // the unsupported slab became dynamic debris (same path as explosions)
    expect(phys.bodies.size).toBeGreaterThan(bodies0)
    phys.dispose()
  }, 60000)
})

describe('T76 two-wheelers: bicycle + delivery scooter (MotorcycleController)', () => {
  // WHY: two-wheel vehicles use a different Jolt controller (lean-assisted
  // MotorcycleController) — they must stand upright unattended (no phantom
  // 'kickstand skating'), ride at their archetype speeds, and share the
  // enter/drive/exit + hash machinery with cars.

  for (const [arch, minSpeed, maxSpeed] of [
    ['bicycle', 2.5, 7.5],
    ['scooter', 5, 13.5],
  ] as const) {
    it(`${arch}: stands unattended, rides upright at archetype speed`, async () => {
      const sim = makeSim(51)
      const phys = await createPhysics(sim)
      sim.queue.push(cmd(0, { kind: 'spawn' }))
      sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: arch, x: 102.4, y: GROUND_Y, z: 104, yaw: 0 }, 1, 1))
      for (let i = 0; i < 60; i++) sim.step()
      const v = [...phys.vehicles.values()][0]
      expect(v.wheels).toHaveLength(2)
      // unattended: upright and NOT moving (phantom-thrust regression gate)
      expect(1 - 2 * (v.qx * v.qx + v.qz * v.qz)).toBeGreaterThan(0.95)
      expect(Math.hypot(v.vx, v.vy, v.vz)).toBeLessThan(0.3)

      sim.queue.push(cmd(sim.tick, { kind: 'vehicle_enter' }))
      sim.step()
      expect(phys.players.get(1)!.seatedVehicle).toBe(v.id)
      for (let i = 0; i < 360; i++) {
        sim.queue.push(cmd(sim.tick, { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 }, 1, 100 + i))
        sim.step()
      }
      const speed = Math.hypot(v.vx, v.vy, v.vz)
      expect(speed).toBeGreaterThan(minSpeed)
      expect(speed).toBeLessThan(maxSpeed) // archetype top-speed clamp
      expect(1 - 2 * (v.qx * v.qx + v.qz * v.qz)).toBeGreaterThan(0.9) // still upright
      phys.dispose()
    }, 60000)
  }

  it('scooter two-run hash determinism (drive + steer)', async () => {
    async function run() {
      const sim = makeSim(52)
      const phys = await createPhysics(sim)
      sim.queue.push(cmd(0, { kind: 'spawn' }))
      sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'scooter', x: 102.4, y: GROUND_Y, z: 104, yaw: 0.2 }, 1, 1))
      sim.queue.push(cmd(15, { kind: 'vehicle_enter' }, 1, 2))
      for (let t = 16; t < 150; t++) {
        const steer = t % 50 < 25 ? INPUT_LEFT : 0
        sim.queue.push(cmd(t, { kind: 'move', input: INPUT_FWD | steer, yaw: 0, pitch: 0 }, 1, 100 + t))
      }
      const hashes: number[] = []
      for (let i = 0; i < 170; i++) {
        sim.step()
        hashes.push(hashSim(sim) ^ hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 120000)
})

describe('determinism (V2/V3): full vehicle lifecycle, two-run hash equality', () => {
  async function run(seed: number, ticks: number) {
    const sim = makeSim(seed)
    // fence (plowed through) then wall (hard crash) for the damage legs
    sim.world.fillBox(1000, 8, 1000, 1048, 18, 1000, 6)
    sim.world.fillBox(1000, 8, 984, 1048, 20, 986, 5)
    const phys = await createPhysics(sim)
    sim.queue.push(cmd(0, { kind: 'spawn' }))
    sim.queue.push(cmd(0, { kind: 'vehicle_spawn', archetype: 'pickup1', x: 102.4, y: GROUND_Y, z: 106, yaw: 0.3 }, 1, 1))
    sim.queue.push(cmd(20, { kind: 'vehicle_enter' }, 1, 2))
    // scripted drive: forward + a steering wiggle + handbrake, then a bomb, exit
    for (let t = 21; t < 160; t++) {
      const steer = t % 40 < 20 ? INPUT_LEFT : 0
      const hb = t > 140 ? INPUT_JUMP : 0
      sim.queue.push(cmd(t, { kind: 'move', input: INPUT_FWD | steer | hb, yaw: 0, pitch: 0 }, 1, 100 + t))
    }
    sim.queue.push(cmd(170, { kind: 'explode', x: 1024, y: 12, z: 1030, r: 10, power: 4 }, 1, 400))
    sim.queue.push(cmd(190, { kind: 'vehicle_exit' }, 1, 401))
    const hashes: number[] = []
    for (let i = 0; i < ticks; i++) {
      sim.step()
      hashes.push(hashSim(sim) ^ hashPhysics(phys))
    }
    phys.dispose()
    return hashes
  }

  it('same command log ⇒ same hash sequence across runs', async () => {
    const a = await run(77, 220)
    const b = await run(77, 220)
    expect(b).toEqual(a)
  }, 120000)
})
