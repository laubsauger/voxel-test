/**
 * T13/T55 [P] — explode op handler (I.cmd). This IS the command path (V1).
 *
 * T55 (B14/B16): graduated falloff zones by q = falloff·power/strength,
 * falloff = 1 − dist/r:
 *   CORE   q ≥ VAPORIZE_RATIO — voxel vaporizes (dust only). Kept MINIMAL
 *          (B16): crumble is the default, vaporization reads as cheap.
 *   MID    1 ≤ q < VAPORIZE_RATIO — voxel is removed and becomes EJECTA:
 *          deterministic clumps (sim.prng) spawned as dynamic bodies with
 *          radial velocity FROM the blast center (+ upward bias), capped at
 *          MAX_EJECTA_BODIES per explosion; the rest are reported in the
 *          explosion event so render spawns matching ballistic particles.
 *   OUTER  LOOSEN_RATIO ≤ q < 1 — probabilistic (sim.prng) single-voxel
 *          knockouts on air-exposed voxels, tapering with distance
 *          (cracked-edge look). These join the ejecta report.
 * Then the existing radial shockwave impulse hits all dynamic bodies —
 * including the fresh ejecta (they are in phys.bodies before the impulse).
 * Impulse response is mass-divided by Jolt (AddImpulse), so heavy materials
 * budge less by construction (T40).
 *
 * Deterministic (V2): all randomness via sim.prng, iteration order fixed
 * (y→z→x scan, ordered clump selection). Emits an ExplosionEvent into the
 * sim → render outbox (see events.ts).
 */
import type { Sim } from './loop'
import { VOXEL_SIZE, WORLD_VX, WORLD_VY, WORLD_VZ } from '../world/chunks'
import { material } from './materials'
import { snapshotRegion } from './connectivity'
import { damagePlayersSphere } from './player'
import type { IPhysicsWorld } from './iphysics'

/** impulse (kg·m/s) applied per unit of explode power at the blast center */
export const IMPULSE_PER_POWER = 50
/** impulse reach relative to the destruction radius */
export const IMPULSE_RADIUS_SCALE = 2

// --- T55 falloff zone tuning (B14/B16) ---------------------------------------
/** q at/above which a voxel vaporizes outright. High on purpose (B16): for a
 *  bomb (power 5) into brick (strength 3) q peaks at 1.67 → NOTHING vaporizes,
 *  everything removed survives as ejecta/particles. Only soft materials
 *  (dirt/plaster, strength 1) near the core vaporize. */
export const VAPORIZE_RATIO = 3
/** q at which loosening starts; knockout probability ramps 0 → LOOSEN_MAX_P
 *  between LOOSEN_RATIO and 1 */
export const LOOSEN_RATIO = 0.55
export const LOOSEN_MAX_P = 0.5
/** ejecta body cap per explosion (B16: rubble piles are the fantasy) */
export const MAX_EJECTA_BODIES = 40
/** clump size range (voxels) for ejecta bodies */
export const EJECTA_CLUMP_MIN = 2
export const EJECTA_CLUMP_MAX = 16
/** max removed-voxel positions sampled into the explosion event */
export const EXPLOSION_SAMPLE_CAP = 128

/** bomb detonation parameters (T54) — shared by the projectile fuse */
export const BOMB_RADIUS = 15
// P25 — was 5: bombs barely dented hard surfaces (concrete str 5 broke only at
// the exact core, metal str 8 never, asphalt roads shrugged). At 9 the core
// craters concrete/asphalt properly and dents metal, while VAPORIZE_RATIO (3)
// still keeps most of it as satisfying debris rather than dust.
export const BOMB_POWER = 9

export interface ExplosionStats {
  /** total voxels removed from the world */
  removed: number
  /** voxels vaporized in the core (no debris) */
  vaporized: number
  /** ejecta bodies spawned */
  ejectaBodies: number
  /** voxels living on in ejecta bodies */
  ejectaVoxels: number
}

interface RemovedVoxel {
  x: number
  y: number
  z: number
  mat: number
}

const voxKey = (x: number, y: number, z: number): number => x + WORLD_VX * (z + WORLD_VZ * y)

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * T13-era simple destruction (kept for the gun's small impact craters,
 * src/sim/shoot-op.ts): voxel dies when falloff·power ≥ strength.
 * Deterministic iteration order (y→z→x), integer voxel coords (V2).
 */
export function destroySphere(sim: Sim, cx: number, cy: number, cz: number, r: number, power: number): void {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r)
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r)
  const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r)
  const r2 = r * r
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const mat = sim.world.getVoxel(x, y, z)
        if (mat === 0) continue
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > r2) continue
        const falloff = 1 - Math.sqrt(d2) / r
        if (falloff * power >= material(mat).strength) sim.world.setVoxel(x, y, z, 0)
      }
    }
  }
}

/**
 * T55 — zoned explosion. Removes voxels per the zone rules above, spawns
 * ejecta bodies, emits the ExplosionEvent. Does NOT run connectivity or the
 * shockwave impulse — callers use runExplosion() for the full pipeline.
 */
export function explodeSphere(
  sim: Sim,
  phys: IPhysicsWorld,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  power: number,
): ExplosionStats {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r)
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r)
  const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r)
  const r2 = r * r
  const removedByMat = new Uint32Array(256)
  const mid: RemovedVoxel[] = []
  const loose: RemovedVoxel[] = []
  let vaporized = 0

  // B23/T89 — the scan reads a LOCAL chunk-aware snapshot (one bulk copy) instead
  // of ~30k per-voxel getVoxel calls (each a chunk lookup, with first-touch P18
  // palette inflation and 6-way exposure probes at the rim — the scan dominated
  // the bomb tick). Removals are mirrored into the snapshot, so the mid-scan
  // exposure semantics ("earlier removals expose deeper voxels") stay
  // bit-identical to the per-voxel version (V2/V3). Snapshot spans the box ±1
  // for the rim's exposure probes; out-of-snapshot reads are world-bounds air.
  const sx0 = Math.max(0, x0 - 1), sy0 = Math.max(0, y0 - 1), sz0 = Math.max(0, z0 - 1)
  const snx = Math.min(WORLD_VX - 1, x1 + 1) - sx0 + 1
  const sny = Math.min(WORLD_VY - 1, y1 + 1) - sy0 + 1
  const snz = Math.min(WORLD_VZ - 1, z1 + 1) - sz0 + 1
  if (snx <= 0 || sny <= 0 || snz <= 0) {
    // blast box entirely outside the world (e.g. bomb fell past the kill plane
    // and detonated below y=0) — nothing to remove, zero PRNG draws (matches
    // the old per-voxel path: every getVoxel would have been out-of-bounds air)
    sim.emit({
      kind: 'explosion',
      x: cx * VOXEL_SIZE,
      y: cy * VOXEL_SIZE,
      z: cz * VOXEL_SIZE,
      r: r * VOXEL_SIZE,
      power,
      removedByMat: [],
      sample: [],
    })
    return { removed: 0, vaporized: 0, ejectaBodies: 0, ejectaVoxels: 0 }
  }
  const snap = snapshotRegion(sim.world, sx0, sy0, sz0, snx, sny, snz)
  const at = (x: number, y: number, z: number): number => {
    const lx = x - sx0, ly = y - sy0, lz = z - sz0
    if (lx < 0 || ly < 0 || lz < 0 || lx >= snx || ly >= sny || lz >= snz) return 0
    return snap[lx + lz * snx + ly * snx * snz]
  }
  const clear = (x: number, y: number, z: number): void => {
    snap[(x - sx0) + (z - sz0) * snx + (y - sy0) * snx * snz] = 0
    sim.world.setVoxel(x, y, z, 0)
  }

  // fixed scan order y→z→x (V2). Exposure checks read the snapshot mid-scan:
  // earlier removals expose deeper voxels — deterministic, and exactly the
  // crumble-inward look we want at the crater rim.
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const mat = at(x, y, z)
        if (mat === 0) continue
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > r2) continue
        const q = ((1 - Math.sqrt(d2) / r) * power) / material(mat).strength
        if (q >= VAPORIZE_RATIO) {
          clear(x, y, z)
          removedByMat[mat]++
          vaporized++
        } else if (q >= 1) {
          clear(x, y, z)
          removedByMat[mat]++
          mid.push({ x, y, z, mat })
        } else if (q >= LOOSEN_RATIO) {
          // OUTER: knock exposed voxels loose with distance-tapered probability
          const exposed =
            at(x - 1, y, z) === 0 ||
            at(x + 1, y, z) === 0 ||
            at(x, y - 1, z) === 0 ||
            at(x, y + 1, z) === 0 ||
            at(x, y, z - 1) === 0 ||
            at(x, y, z + 1) === 0
          if (!exposed) continue
          const p = (LOOSEN_MAX_P * (q - LOOSEN_RATIO)) / (1 - LOOSEN_RATIO)
          if (sim.prng.next() < p) {
            clear(x, y, z)
            removedByMat[mat]++
            loose.push({ x, y, z, mat })
          }
        }
      }
    }
  }

  // MID → ejecta clumps (deterministic prng selection, capped)
  const used = spawnEjecta(sim, phys, mid, cx, cy, cz, r, power)

  // explosion event: non-body removed voxels, evenly sampled up to the cap
  const nonBody: RemovedVoxel[] = []
  for (let i = 0; i < mid.length; i++) if (!used.flags[i]) nonBody.push(mid[i])
  for (const v of loose) nonBody.push(v)
  const sample: number[] = []
  const stride = Math.max(1, Math.ceil(nonBody.length / EXPLOSION_SAMPLE_CAP))
  for (let i = 0; i < nonBody.length; i += stride) {
    const v = nonBody[i]
    sample.push(v.x, v.y, v.z, v.mat)
  }
  const rbm: number[] = []
  let removed = 0
  for (let m = 1; m < 256; m++) {
    if (removedByMat[m] > 0) {
      rbm.push(m, removedByMat[m])
      removed += removedByMat[m]
    }
  }
  sim.emit({
    kind: 'explosion',
    x: cx * VOXEL_SIZE,
    y: cy * VOXEL_SIZE,
    z: cz * VOXEL_SIZE,
    r: r * VOXEL_SIZE,
    power,
    removedByMat: rbm,
    sample,
  })

  return { removed, vaporized, ejectaBodies: used.bodies, ejectaVoxels: used.voxels }
}

/**
 * Partition MID voxels into small contiguous clumps and spawn them as dynamic
 * bodies flying FROM the blast center. Selection order: prng-picked seed
 * index (linear probe over the fixed mid array), prng clump size, BFS growth
 * over 6-neighbors within the mid pool — fully deterministic (V2).
 */
function spawnEjecta(
  sim: Sim,
  phys: IPhysicsWorld,
  mid: RemovedVoxel[],
  cx: number,
  cy: number,
  cz: number,
  r: number,
  power: number,
): { flags: Uint8Array; bodies: number; voxels: number } {
  const flags = new Uint8Array(mid.length)
  let bodies = 0
  let voxels = 0
  if (mid.length === 0) return { flags, bodies, voxels }

  const pool = new Map<number, number>()
  for (let i = 0; i < mid.length; i++) pool.set(voxKey(mid[i].x, mid[i].y, mid[i].z), i)

  let remaining = mid.length
  const clump: RemovedVoxel[] = []
  const frontier: number[] = []
  while (bodies < MAX_EJECTA_BODIES && remaining > 0) {
    let i = sim.prng.nextInt(mid.length)
    while (flags[i]) i = (i + 1) % mid.length
    const target = EJECTA_CLUMP_MIN + sim.prng.nextInt(EJECTA_CLUMP_MAX - EJECTA_CLUMP_MIN + 1)
    clump.length = 0
    frontier.length = 0
    clump.push(mid[i])
    frontier.push(i)
    flags[i] = 1
    remaining--
    while (clump.length < target && frontier.length > 0) {
      const c = mid[frontier.pop()!]
      for (let n = 0; n < 6 && clump.length < target; n++) {
        const nx = c.x + ((n === 0 ? -1 : n === 1 ? 1 : 0) as number)
        const ny = c.y + (n === 2 ? -1 : n === 3 ? 1 : 0)
        const nz = c.z + (n === 4 ? -1 : n === 5 ? 1 : 0)
        const j = pool.get(voxKey(nx, ny, nz))
        if (j === undefined || flags[j]) continue
        flags[j] = 1
        remaining--
        clump.push(mid[j])
        frontier.push(j)
      }
    }

    // T89 — DEFERRED spawn with velocity when the backend supports it (no hull
    // creation in the blast tick); legacy backends spawn immediately below.
    const deferred = phys.spawnDebrisWithVelocity !== undefined
    const body = deferred ? null : phys.spawnDebrisBody(sim, clump)
    // radial velocity FROM the blast center at the clump centroid, upward
    // bias, density-scaled (heavy lobs, light flies) — B13's fix for
    // "particles rain up/down instead of radiating from the blast".
    let mx = 0, my = 0, mz = 0
    for (const v of clump) {
      mx += v.x + 0.5
      my += v.y + 0.5
      mz += v.z + 0.5
    }
    mx /= clump.length
    my /= clump.length
    mz /= clump.length
    let dx = mx - cx, dy = my - cy, dz = mz - cz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-4) {
      dx = 0; dy = 1; dz = 0
    } else {
      dx /= len; dy /= len; dz /= len
    }
    // dominant clump material from the CLUMP, not the body: the debris layer may
    // decline the spawn under its LOCAL cap (V17a) and every PRNG draw below must
    // still happen identically on all machines.
    let matBest = 0
    {
      const counts = new Map<number, number>()
      for (const v of clump) counts.set(v.mat, (counts.get(v.mat) ?? 0) + 1)
      let best = -1
      for (const [m, n] of counts) if (n > best || (n === best && m < matBest)) { best = n; matBest = m }
    }
    const density = material(matBest).density
    const speed =
      (4 + 4 * sim.prng.next()) *
      clamp(1.7 - len / r, 0.6, 1.7) *
      clamp(Math.sqrt(1200 / density), 0.55, 1.5) *
      clamp(power / 4, 0.6, 2)
    const vy = dy * speed + 1.5 + 2 * sim.prng.next()
    const wvx = (sim.prng.next() - 0.5) * 10
    const wvy = (sim.prng.next() - 0.5) * 10
    const wvz = (sim.prng.next() - 0.5) * 10
    if (deferred) phys.spawnDebrisWithVelocity!(sim, clump, dx * speed, vy, dz * speed, wvx, wvy, wvz)
    else if (body) phys.setBodyVelocity(body, dx * speed, vy, dz * speed, wvx, wvy, wvz)
    bodies++
    voxels += clump.length
  }
  return { flags, bodies, voxels }
}

/**
 * Full explosion pipeline: zoned destruction + ejecta (T55), player segment
 * damage (T22), connectivity/island extraction (T11/T12), then the radial
 * shockwave impulse — which also shoves the fresh ejecta bodies. Shared by
 * the 'explode' op and the bomb projectile fuse (T54).
 * Coordinates in voxels.
 */
export function runExplosion(
  sim: Sim,
  phys: IPhysicsWorld,
  x: number,
  y: number,
  z: number,
  r: number,
  power: number,
): ExplosionStats {
  // B17 — blasts chew voxels off PRE-EXISTING dynamic bodies too, not just
  // impulse them. Snapshot ids first: the ejecta explodeSphere spawns below
  // sit inside the blast radius and must NOT be instantly re-destroyed.
  const preIds = [...phys.bodies.keys()]
  const stats = explodeSphere(sim, phys, x, y, z, r, power)
  damagePlayersSphere(phys, x, y, z, r, power)
  phys.damageBodiesSphere(x * VOXEL_SIZE, y * VOXEL_SIZE, z * VOXEL_SIZE, r * VOXEL_SIZE, power, preIds)
  phys.structuralPass(sim)
  phys.applyRadialImpulse(
    x * VOXEL_SIZE,
    y * VOXEL_SIZE,
    z * VOXEL_SIZE,
    r * VOXEL_SIZE * IMPULSE_RADIUS_SCALE,
    power * IMPULSE_PER_POWER,
  )
  return stats
}

export function registerDestructionOps(sim: Sim, phys: IPhysicsWorld): void {
  sim.onOp('explode', (s, cmd) => {
    const { x, y, z, r, power } = cmd.op
    runExplosion(s, phys, x, y, z, r, power)
  })
}
