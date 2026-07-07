import { beforeAll, describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { registerEditOps } from '../src/sim/edit-ops'
import { createPhysics, hashPhysics, loadJolt, type PhysicsWorld } from '../src/sim/physics'
import { registerShootOp, SHOOT_DMG_MG } from '../src/sim/shoot-op'
import {
  EXPLOSION_HP_PER_POWER,
  INPUT_FWD,
  MAX_HP,
  RESPAWN_DELAY_TICKS,
  type PlayerEntity,
} from '../src/sim/player'
import type { PlayerDeathEvent, PlayerHitEvent, PlayerRespawnEvent, SimEvent } from '../src/sim/events'
import { WORLD_VX, VOXEL_SIZE } from '../src/world/chunks'

// Player combat — hp, damage attribution, death, K/D, respawn. Why these
// tests exist: lockstep MP (V2/V3) only stays in sync if every combat
// decision (who got hit, who died, who gets the kill) is a pure function of
// sim state — and the render layer builds ALL hit feedback on the events
// asserted here. A regression in any of them silently breaks MP kill
// attribution or the HUD contract.

beforeAll(async () => {
  await loadJolt()
}, 30000)

const DIRT = 1

// B32 — spawn column is the world center; playerId N spawns at x = CM + N (m)
const CVX = WORLD_VX >> 1
const CM = CVX * VOXEL_SIZE

async function setup(): Promise<{ sim: Sim; phys: PhysicsWorld }> {
  const sim = new Sim(7)
  registerEditOps(sim)
  // ground slab around the spawn columns (same shape as player.test.ts)
  sim.world.fillBox(CVX - 112, 0, CVX - 112, CVX + 128, 7, CVX + 128, 3)
  const phys = await createPhysics(sim)
  registerShootOp(sim, phys)
  return { sim, phys }
}

/** spawn players 1 + 2 and settle them onto the ground */
async function setupDuel(): Promise<{ sim: Sim; phys: PhysicsWorld; p1: PlayerEntity; p2: PlayerEntity }> {
  const { sim, phys } = await setup()
  sim.queue.push({ tick: 0, playerId: 1, seq: 0, op: { kind: 'spawn' } })
  sim.queue.push({ tick: 0, playerId: 2, seq: 0, op: { kind: 'spawn' } })
  for (let t = 0; t < 20; t++) sim.step()
  sim.drainEvents()
  return { sim, phys, p1: phys.players.get(1)!, p2: phys.players.get(2)! }
}

/** shoot from p1 straight +x at chest height (p2 stands 1 m away in +x) */
function shootAt(sim: Sim, from: PlayerEntity, seq: number): void {
  sim.queue.push({
    tick: sim.tick,
    playerId: from.playerId,
    seq,
    op: { kind: 'shoot', ox: from.px, oy: from.py + 1.2, oz: from.pz, dx: 1, dy: 0, dz: 0 },
  })
}

function killP2(sim: Sim, p1: PlayerEntity, p2: PlayerEntity): SimEvent[] {
  const events: SimEvent[] = []
  let seq = 100
  while (p2.alive) {
    shootAt(sim, p1, seq++)
    sim.step()
    events.push(...sim.drainEvents())
    if (seq > 120) throw new Error('victim never died — damage path broken')
  }
  return events
}

describe('shooting players (player combat, V2)', () => {
  it('direct hit: weapon dmg off hp, player-hit event with attacker/victim/direction, no world edit behind', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    // wall BEHIND the victim — the bullet must stop in the player, not mark it
    const wallVx = Math.floor(p2.px / VOXEL_SIZE) + 20
    sim.world.fillBox(wallVx, 8, CVX - 10, wallVx, 40, CVX + 10, DIRT)
    const segBefore = p2.segments.reduce((n, s) => n + s.count, 0)

    shootAt(sim, p1, 0)
    sim.step()

    expect(p2.hp).toBe(MAX_HP - SHOOT_DMG_MG)
    expect(p2.alive).toBe(true)
    const events = sim.drainEvents()
    const hit = events.find((e) => e.kind === 'player-hit') as PlayerHitEvent
    expect(hit).toBeDefined()
    expect(hit.victim).toBe(2)
    expect(hit.attacker).toBe(1)
    expect(hit.dmg).toBe(SHOOT_DMG_MG)
    expect(hit.hpAfter).toBe(MAX_HP - SHOOT_DMG_MG)
    // p2 stands +x of p1 on the same z → direction from attacker to victim = (1, 0)
    expect(hit.dx).toBeCloseTo(1, 5)
    expect(hit.dz).toBeCloseTo(0, 5)
    // T22 — the entry point carved the victim's voxel body (render damage)
    expect(p2.segments.reduce((n, s) => n + s.count, 0)).toBeLessThan(segBefore)
    // the world edit was ABSORBED by the player: wall voxel on the ray intact
    expect(sim.world.getVoxel(wallVx, Math.floor((p1.py + 1.2) / VOXEL_SIZE), CVX)).toBe(DIRT)
    // shooter untouched (excluded from his own ray)
    expect(p1.hp).toBe(MAX_HP)
    phys.dispose()
  }, 30000)

  it('optional ShootOp.dmg overrides the default weapon damage (pistol-class)', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 0,
      op: { kind: 'shoot', ox: p1.px, oy: p1.py + 1.2, oz: p1.pz, dx: 1, dy: 0, dz: 0, dmg: 20 },
    })
    sim.step()
    expect(p2.hp).toBe(MAX_HP - 20)
    phys.dispose()
  }, 30000)

  it('world geometry between shooter and target blocks player damage', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    // dig p2 a trench? No — raise a wall BETWEEN them (they are 1 m apart, so
    // move p2's column: build the wall 0.5 m in front of p2, 1 voxel thick)
    const wallVx = Math.floor((p1.px + 0.5) / VOXEL_SIZE)
    sim.world.fillBox(wallVx, 8, CVX - 10, wallVx, 40, CVX + 10, DIRT)

    shootAt(sim, p1, 0)
    sim.step()

    expect(p2.hp).toBe(MAX_HP) // wall absorbed the shot
    expect(sim.drainEvents().some((e) => e.kind === 'player-hit')).toBe(false)
    phys.dispose()
  }, 30000)

  it('hp to 0: death event, killer +1 kill, victim +1 death, corpse inert and transparent to shots', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    const events = killP2(sim, p1, p2)
    const deathTick = sim.tick - 1 // death happened in the last step

    const death = events.find((e) => e.kind === 'player-death') as PlayerDeathEvent
    expect(death).toBeDefined()
    expect(death.victim).toBe(2)
    expect(death.attacker).toBe(1)
    expect(p2.alive).toBe(false)
    expect(p2.hp).toBe(0)
    expect(p2.deaths).toBe(1)
    expect(p2.respawnAtTick).toBe(deathTick + RESPAWN_DELAY_TICKS)
    expect(p1.kills).toBe(1)
    expect(p1.deaths).toBe(0)

    // inert: move ops are ignored, physics skips the corpse
    const deadPos = [p2.px, p2.py, p2.pz]
    for (let i = 0; i < 30; i++) {
      sim.queue.push({ tick: sim.tick, playerId: 2, seq: 500 + i, op: { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 } })
      sim.step()
    }
    expect([p2.px, p2.py, p2.pz]).toEqual(deadPos)
    expect(p2.input).toBe(0)

    // dead players neither take damage nor block shots: shooting the corpse
    // line hits the world behind it instead (no player-hit, hp stays 0)
    sim.drainEvents()
    const wallVx = Math.floor(p2.px / VOXEL_SIZE) + 20
    sim.world.fillBox(wallVx, 8, CVX - 10, wallVx, 40, CVX + 10, DIRT)
    shootAt(sim, p1, 900)
    sim.step()
    expect(sim.drainEvents().some((e) => e.kind === 'player-hit')).toBe(false)
    expect(p2.hp).toBe(0)
    expect(p2.deaths).toBe(1) // no double death
    expect(sim.world.getVoxel(wallVx, Math.floor((p1.py + 1.2) / VOXEL_SIZE), CVX)).toBe(0) // wall took the hit
    expect(phys.players.size).toBe(2) // corpse entity persists until respawn
    phys.dispose()
  }, 30000)

  it('suicide (self-inflicted explosion): +1 death, NO kill for anyone', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    // player 2 detonates a bomb-grade blast at his own feet
    sim.queue.push({
      tick: sim.tick,
      playerId: 2,
      seq: 0,
      op: {
        kind: 'explode',
        x: p2.px / VOXEL_SIZE,
        y: (p2.py + 0.8) / VOXEL_SIZE,
        z: p2.pz / VOXEL_SIZE,
        r: 15,
        power: 9,
      },
    })
    sim.step()
    const events = sim.drainEvents()
    const death = events.find((e) => e.kind === 'player-death') as PlayerDeathEvent
    expect(death).toBeDefined()
    expect(death.victim).toBe(2)
    expect(death.attacker).toBe(2)
    expect(p2.alive).toBe(false)
    expect(p2.deaths).toBe(1)
    expect(p2.kills).toBe(0) // no credit for killing yourself
    expect(p1.kills).toBe(0) // and none for bystanders
    phys.dispose()
  }, 30000)
})

describe('respawn (player combat, V2)', () => {
  it('respawns exactly RESPAWN_DELAY_TICKS after death: hp 100, alive, at the spawn column, movable', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    killP2(sim, p1, p2)
    const respawnAt = p2.respawnAtTick
    expect(respawnAt).toBeGreaterThan(sim.tick)

    // step up to (not including) the respawn tick — still dead the whole time
    while (sim.tick < respawnAt) {
      expect(p2.alive).toBe(false)
      sim.step()
    }
    // the loop stepped through tick respawnAt-1; the NEXT step runs tick ==
    // respawnAtTick and revives him — not a tick earlier
    expect(p2.alive).toBe(false)
    sim.step()
    expect(p2.alive).toBe(true)
    expect(p2.hp).toBe(MAX_HP)
    expect(p2.respawnAtTick).toBe(0)
    const respawn = sim.drainEvents().find((e) => e.kind === 'player-respawn') as PlayerRespawnEvent
    expect(respawn).toBeDefined()
    expect(respawn.playerId).toBe(2)
    // deterministic per-player spawn column (playerId 2 → x = CM + 2, z = CM)
    expect(p2.px).toBeCloseTo(CM + 2, 1)
    expect(p2.pz).toBeCloseTo(CM, 1)
    // voxel body fully restored
    for (const seg of p2.segments) expect(seg.count).toBe(seg.initial)
    expect(p2.flags).toBe(0)
    // K/D survives the respawn
    expect(p2.deaths).toBe(1)

    // movable again: walk forward
    const z0 = p2.pz
    for (let i = 0; i < 60; i++) {
      sim.queue.push({ tick: sim.tick, playerId: 2, seq: 1000 + i, op: { kind: 'move', input: INPUT_FWD, yaw: 0, pitch: 0 } })
      sim.step()
    }
    expect(p2.pz).toBeLessThan(z0 - 1)
    phys.dispose()
  }, 30000)
})

describe('explosion hp damage (player combat)', () => {
  it('explosion damages a nearby player with attacker credit and distance falloff', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    // player 1 detonates 6 voxels (+x) from p2's capsule axis, at chest height
    const d = 6
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 0,
      op: {
        kind: 'explode',
        x: p2.px / VOXEL_SIZE + d,
        y: (p2.py + 1.0) / VOXEL_SIZE,
        z: p2.pz / VOXEL_SIZE,
        r: 12,
        power: 4,
      },
    })
    sim.step()
    // nearest capsule-axis point is at the blast's own height → dist = d
    const expected = Math.floor(4 * EXPLOSION_HP_PER_POWER * (1 - d / 12))
    expect(p2.hp).toBe(MAX_HP - expected)
    const hit = sim.drainEvents().find((e) => e.kind === 'player-hit') as PlayerHitEvent
    expect(hit).toBeDefined()
    expect(hit.victim).toBe(2)
    expect(hit.attacker).toBe(1)
    expect(hit.dmg).toBe(expected)
    // p1 stands 16 voxels from the blast center — outside r=12, unhurt
    expect(p1.hp).toBe(MAX_HP)
    phys.dispose()
  }, 30000)

  it('a lethal bomb throw credits the thrower (owner threads through the projectile)', async () => {
    const { sim, phys, p1, p2 } = await setupDuel()
    // p1 lobs a bomb straight down at p2's feet from just above — fuse burns
    // 180 ticks, then the T55 blast (power 9) lands point-blank: 108 hp
    sim.queue.push({
      tick: sim.tick,
      playerId: 1,
      seq: 0,
      op: { kind: 'throw', ox: p2.px, oy: p2.py + 1.5, oz: p2.pz, vx: 0, vy: -2, vz: 0 },
    })
    for (let i = 0; i < 200 && p2.alive; i++) sim.step()
    expect(phys.projectiles.size).toBe(0) // detonated
    expect(p2.alive).toBe(false)
    expect(p1.kills).toBe(1) // attribution survived the 3 s fuse
    const death = sim.drainEvents().find((e) => e.kind === 'player-death') as PlayerDeathEvent
    expect(death.attacker).toBe(1)
    phys.dispose()
  }, 30000)
})

describe('combat state is hashed (V3)', () => {
  it('hp, kills, deaths, alive and respawnAtTick each change hashPhysics', async () => {
    const { phys, p2 } = await setupDuel()
    const h0 = hashPhysics(phys)

    p2.hp = 55
    const h1 = hashPhysics(phys)
    expect(h1).not.toBe(h0)

    p2.kills = 3
    const h2 = hashPhysics(phys)
    expect(h2).not.toBe(h1)

    p2.deaths = 1
    const h3 = hashPhysics(phys)
    expect(h3).not.toBe(h2)

    p2.alive = false
    const h4 = hashPhysics(phys)
    expect(h4).not.toBe(h3)

    p2.respawnAtTick = 777
    expect(hashPhysics(phys)).not.toBe(h4)
    phys.dispose()
  }, 30000)

  it('full combat round (shots, death, respawn) is deterministic: two runs → identical hash sequences', async () => {
    const run = async () => {
      const { sim, phys, p1, p2 } = await setupDuel()
      killP2(sim, p1, p2)
      const hashes: number[] = []
      for (let i = 0; i < 40; i++) {
        sim.step()
        hashes.push(hashPhysics(phys))
      }
      phys.dispose()
      return hashes
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  }, 60000)
})
