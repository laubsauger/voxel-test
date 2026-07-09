/**
 * T15/T62 v3 — COLUMN-HEIGHTFIELD water sim (replaces the 3D per-voxel CA;
 * design rationale + rules in ./rules.ts). Authoritative sim state (V2, V9*).
 *
 * Storage: sparse COLUMN PAGES aligned to the 32×32 chunk-column grid
 * (key = ccx + ccz·WORLD_CX — a 3D chunk index with cy = 0). A page holds,
 * per (x,z) column: `m` (Int32, water mass in 1/255-voxel units) and
 * `bottom` (Int16, lowest water voxel). One contiguous span per column:
 * cells below the surface are full, the surface cell holds the remainder —
 * levelAt() is bit-compatible with the old CA for settled water. Dry columns
 * are canonically (m=0, bottom=0); pages with no wet columns are freed.
 *
 * Activity: `wake` maps chunk-column key → remaining awake steps. A step
 * processes a budgeted, deterministically rotated window of the wake set
 * (T92); settled water costs NOTHING (step() early-returns, stepCount does
 * not advance, hash stays frozen). Pairs are processed from the awake side
 * in BOTH directions, so an asleep neighbor page participates the moment an
 * awake column borders it — and is woken when it changes.
 *
 * V9*: transfers move integer amounts between exactly two columns — total
 * mass is exactly constant across steps. Explicit, REPORTED exceptions:
 * addWater/removeWater ops, and placing a solid into water (displaces the
 * cell's water; a block placed mid-span also releases the water beneath it —
 * the single-span representation cannot hold water under a new ceiling; the
 * full displaced amount is returned so callers can account for it). Mass
 * never increases outside addWater.
 *
 * Contract with the rest of the sim (V1): unchanged — every voxel edit that
 * can affect water must call notifyVoxelChanged(x,y,z) (game.ts wires
 * ChunkStore.onVoxelChanged). Determinism (V2): sorted iteration, fixed
 * neighbor order (parity-flipped per step), integer state, no wall clock.
 */

import {
  CHUNK_VOL,
  ChunkStore,
  WORLD_CX,
  WORLD_CY,
  WORLD_CZ,
  WORLD_VX,
  WORLD_VY,
  WORLD_VZ,
} from '../../world/chunks'
import { Fnv } from '../hash'
import type { Sim } from '../loop'
import { FLOW_CAP, MAX_LEVEL, SURFACE_DEADBAND, columnFlow } from './rules'

const CY_STRIDE = WORLD_CX * WORLD_CZ
/** columns per chunk-column page (32×32), index = lx + lz*32 */
const COLS = 1024

/** steps a chunk-column stays awake after its last change. 2, not 1: a pair
 *  whose flow is enabled by a neighbor processed later in the same step gets
 *  a second look before sleeping. */
const WAKE_TTL = 2
/** T92 — max wake chunk-columns processed per step. A page is ≤1024 column
 *  updates (~an order of magnitude cheaper than the old CA's per-voxel
 *  chunk pass); small disturbances fit entirely, mega-wakes (boot fill,
 *  breach floods) rotate through a deterministic window. */
export const WAKE_BUDGET = 16

function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_VX && y < WORLD_VY && z < WORLD_VZ
}

/** highest voxel of a span (m > 0) */
function topVoxel(bottom: number, m: number): number {
  return bottom + (((m - 1) / 255) | 0)
}

/** neighbor visit order, parity-flipped per step to cancel directional bias */
const ORDER_EVEN = [1, 0, -1, 0, 0, 1, 0, -1] as const
const ORDER_ODD = [0, -1, 0, 1, -1, 0, 1, 0] as const

class ColumnPage {
  /** water mass per column, 1/255-voxel units (0 = dry) */
  readonly m = new Int32Array(COLS)
  /** lowest water voxel per column (canonically 0 while dry) */
  readonly bottom = new Int16Array(COLS)
  /** number of wet columns — page is freed at 0 */
  wet = 0
}

export class WaterSim {
  /** column pages by chunk-column key — allocated only where water exists */
  private readonly colPages = new Map<number, ColumnPage>()
  /** chunk-column key → remaining awake steps */
  private readonly wake = new Map<number, number>()
  /** 3D chunk indices with changed water since last drainRenderDirty() — render-only (B26) */
  private readonly renderDirty = new Set<number>()
  /** steps actually executed (does not advance while settled) — part of hashed state */
  stepCount = 0
  /** bumped on any observable change; render-layer change detection only, not hashed */
  version = 0
  /** wet columns processed across all steps — cost diagnostics/tests ONLY
   *  (settled water must not grow this). Never hashed, never read by rules. */
  workCount = 0

  constructor(private readonly world: ChunkStore) {}

  /** number of awake chunk-columns — 0 means fully settled (perf invariant) */
  get activeChunkCount(): number {
    return this.wake.size
  }

  /**
   * True while the 3D chunk's column stack changed within the last WAKE_TTL
   * steps. Render-side disturbance hook (T61) — read-only, not hashed.
   */
  isChunkAwake(ci: number): boolean {
    return this.wake.has(ci % CY_STRIDE)
  }

  /**
   * Render-side 3D page view (surface extraction): synthesizes the chunk's
   * 32³ level field from the column spans — full cells below each surface,
   * partial at it, bit-compatible with the old CA pages. Null if the chunk
   * holds no water. Fresh buffer per call (render-only path, B26-budgeted).
   */
  pageAt(ci: number): Uint8Array | null {
    const page = this.colPages.get(ci % CY_STRIDE)
    if (!page || page.wet === 0) return null
    const y0 = ((ci / CY_STRIDE) | 0) << 5
    const y1 = y0 + 31
    let out: Uint8Array | null = null
    for (let i = 0; i < COLS; i++) {
      const m = page.m[i]
      if (m === 0) continue
      const bot = page.bottom[i]
      const top = topVoxel(bot, m)
      if (top < y0 || bot > y1) continue
      if (!out) out = new Uint8Array(CHUNK_VOL)
      const lo = bot > y0 ? bot : y0
      const hi = top < y1 ? top : y1
      for (let y = lo; y <= hi; y++) {
        const u = m - (y - bot) * 255
        out[i + ((y - y0) << 10)] = u >= 255 ? 255 : u
      }
    }
    return out
  }

  /**
   * Chunks whose water content changed since the last drain — consumed by the
   * render layer for incremental surface rebuilds (B26). Never hashed.
   */
  drainRenderDirty(): number[] {
    if (this.renderDirty.size === 0) return []
    const out = [...this.renderDirty].sort((a, b) => a - b)
    this.renderDirty.clear()
    return out
  }

  levelAt(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    const page = this.colPages.get((x >> 5) + (z >> 5) * WORLD_CX)
    if (!page) return 0
    const i = (x & 31) + ((z & 31) << 5)
    const m = page.m[i]
    if (m === 0) return 0
    const rel = y - page.bottom[i]
    if (rel < 0) return 0
    const u = m - rel * 255
    if (u <= 0) return 0
    return u >= 255 ? 255 : u
  }

  /**
   * Source op (V9 exception): add up to `amount` (≤ one cell's worth) of
   * water, poured at cell (x,y,z). Returns the amount actually added (0 if
   * solid, OOB, or the column is already full up to that cell). Poured water
   * comes to rest on the column's surface/floor immediately (no airborne
   * blobs — rules.ts fidelity note); bottom-up basin fills are exact.
   */
  addWater(x: number, y: number, z: number, amount: number): number {
    amount = amount | 0
    if (amount <= 0 || !inBounds(x, y, z) || this.world.getVoxel(x, y, z) !== 0) return 0
    const key = (x >> 5) + (z >> 5) * WORLD_CX
    const i = (x & 31) + ((z & 31) << 5)
    let page = this.colPages.get(key)
    const m = page ? page.m[i] : 0
    let add: number
    if (m > 0) {
      const bot = page!.bottom[i]
      const surf = bot * 255 + m
      add = (y + 1) * 255 - surf // capacity up to the top of cell y (old per-cell clamp)
      if (add <= 0) return 0
      if (add > amount) add = amount
      // ceiling: the rising surface may not cross a solid in this column
      const top0 = topVoxel(bot, m)
      let newTop = topVoxel(bot, m + add)
      if (newTop >= WORLD_VY) {
        add = WORLD_VY * 255 - surf
        newTop = WORLD_VY - 1
      }
      for (let yy = top0 + 1; yy <= newTop; yy++) {
        if (this.world.getVoxel(x, yy, z) !== 0) {
          add = yy * 255 - surf
          break
        }
      }
      if (add <= 0) return 0
      page!.m[i] = m + add
      this.touch(x, z, top0, topVoxel(bot, m + add))
    } else {
      // dry column: water lands on the floor below the poured cell
      let f = y
      while (f > 0 && this.world.getVoxel(x, f - 1, z) === 0) f--
      add = amount < MAX_LEVEL ? amount : MAX_LEVEL
      if (!page) {
        page = new ColumnPage()
        this.colPages.set(key, page)
      }
      page.wet++
      page.bottom[i] = f
      page.m[i] = add
      this.touch(x, z, f, f)
    }
    this.wake.set(key, WAKE_TTL)
    this.version++
    return add
  }

  /** Sink op (V9 exception): remove up to `amount` water read at cell (x,y,z);
   *  the column surface drops accordingly. Returns the amount removed. */
  removeWater(x: number, y: number, z: number, amount: number): number {
    amount = amount | 0
    if (amount <= 0 || !inBounds(x, y, z)) return 0
    const key = (x >> 5) + (z >> 5) * WORLD_CX
    const page = this.colPages.get(key)
    if (!page) return 0
    const i = (x & 31) + ((z & 31) << 5)
    const m = page.m[i]
    if (m === 0) return 0
    const bot = page.bottom[i]
    const rel = y - bot
    if (rel < 0) return 0
    const u = m - rel * 255
    if (u <= 0) return 0
    const cell = u >= 255 ? 255 : u
    const take = amount < cell ? amount : cell
    const top0 = topVoxel(bot, m)
    page.m[i] = m - take
    if (page.m[i] === 0) {
      page.bottom[i] = 0
      if (--page.wet === 0) this.colPages.delete(key)
      this.touch(x, z, bot, top0)
    } else {
      this.touch(x, z, topVoxel(bot, page.m[i]), top0)
    }
    this.wake.set(key, WAKE_TTL)
    this.version++
    return take
  }

  /**
   * MUST be called for every voxel edit that could touch water (contract with
   * edit ops). Wakes the region ONLY when water is actually nearby (B26): the
   * edited column or a 4-neighbor column holding water within y±1 — the only
   * cells whose flow terms read this voxel. If the cell became solid inside a
   * span, the displaced water is removed and returned (explicit sink; a block
   * placed mid-span also releases the water beneath it — see header).
   */
  notifyVoxelChanged(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    let woke = false
    for (let k = 0; k < 5; k++) {
      const xx = k === 1 ? x + 1 : k === 2 ? x - 1 : x
      const zz = k === 3 ? z + 1 : k === 4 ? z - 1 : z
      if (xx < 0 || zz < 0 || xx >= WORLD_VX || zz >= WORLD_VZ) continue
      const key = (xx >> 5) + (zz >> 5) * WORLD_CX
      const page = this.colPages.get(key)
      if (!page) continue
      const i = (xx & 31) + ((zz & 31) << 5)
      const m = page.m[i]
      if (m === 0) continue
      const bot = page.bottom[i]
      if (y + 1 >= bot && y - 1 <= topVoxel(bot, m)) {
        this.wake.set(key, WAKE_TTL)
        woke = true
      }
    }
    if (!woke) return 0
    const ownKey = (x >> 5) + (z >> 5) * WORLD_CX
    this.wake.set(ownKey, WAKE_TTL) // the edited (possibly dry) column re-flows too
    this.touch(x, z, y > 0 ? y - 1 : 0, y + 1 < WORLD_VY ? y + 1 : WORLD_VY - 1)
    this.version++
    if (this.world.getVoxel(x, y, z) === 0) return 0
    // became solid — displace the span water at/below the placed cell
    const page = this.colPages.get(ownKey)
    if (!page) return 0
    const i = (x & 31) + ((z & 31) << 5)
    const m = page.m[i]
    if (m === 0) return 0
    const bot = page.bottom[i]
    const top = topVoxel(bot, m)
    if (y < bot || y > top) return 0
    let displaced: number
    if (y === top) {
      displaced = m - (top - bot) * 255 // the partial/top cell only
      page.m[i] = m - displaced
    } else {
      // keep the UPPER part (surface level holds; water under the new solid
      // is released — single-span representation, documented sink)
      const kept = bot * 255 + m - (y + 1) * 255
      displaced = m - kept
      page.m[i] = kept
      page.bottom[i] = y + 1
    }
    if (page.m[i] === 0) {
      page.bottom[i] = 0
      if (--page.wet === 0) this.colPages.delete(ownKey)
    }
    this.touch(x, z, bot, top)
    return displaced
  }

  /** total integer water mass — constant across steps absent source/sink (V9) */
  totalMass(): number {
    let sum = 0
    for (const page of this.colPages.values()) {
      for (let i = 0; i < COLS; i++) sum += page.m[i]
    }
    return sum
  }

  /** iterate column pages in ascending key order (hash + tests) — raw state view */
  forEachColumnPage(fn: (key: number, m: Int32Array, bottom: Int16Array) => void): void {
    const keys = [...this.colPages.keys()].sort((a, b) => a - b)
    for (const key of keys) {
      const page = this.colPages.get(key)!
      fn(key, page.m, page.bottom)
    }
  }

  /**
   * Iterate synthesized 3D pages in ascending chunk-index order (render/test
   * compatibility view over the column state — see pageAt).
   */
  forEachPage(fn: (ci: number, data: Uint8Array) => void): void {
    const cis: number[] = []
    const keys = [...this.colPages.keys()].sort((a, b) => a - b)
    for (const key of keys) {
      const page = this.colPages.get(key)!
      let mask = 0 // cy occupancy bitmask (WORLD_CY ≤ 31)
      for (let i = 0; i < COLS; i++) {
        const m = page.m[i]
        if (m === 0) continue
        const bot = page.bottom[i]
        const top = topVoxel(bot, m)
        for (let cy = bot >> 5; cy <= top >> 5; cy++) mask |= 1 << cy
      }
      for (let cy = 0; cy < WORLD_CY; cy++) if (mask & (1 << cy)) cis.push(key + cy * CY_STRIDE)
    }
    cis.sort((a, b) => a - b)
    for (const ci of cis) fn(ci, this.pageAt(ci)!)
  }

  /**
   * Advance one step: per awake chunk-column (budgeted, T92-rotated window),
   * unsupported spans fall 1 voxel, then lateral column flows in fixed order.
   * No-op while settled.
   */
  step(): void {
    if (this.wake.size === 0) return
    const sortedWake = [...this.wake.keys()].sort((a, b) => a - b)
    const throttled = sortedWake.length > WAKE_BUDGET
    const start = throttled ? (this.stepCount * WAKE_BUDGET) % sortedWake.length : 0
    const active = throttled
      ? Array.from({ length: WAKE_BUDGET }, (_, i) => sortedWake[(start + i) % sortedWake.length]).sort(
          (a, b) => a - b,
        )
      : sortedWake
    const changed = new Set<number>()
    for (const key of active) this.stepChunkCol(key, changed)
    // canonical sparse state: pages emptied by outflow are freed before hashing
    for (const key of changed) {
      const p = this.colPages.get(key)
      if (p && p.wet === 0) this.colPages.delete(key)
    }
    // TTL bookkeeping: changed pages get a fresh TTL; stable ones count down.
    // Unprocessed wake entries keep their TTL untouched (T92 fairness).
    for (const key of active) {
      if (changed.has(key)) continue
      const ttl = this.wake.get(key)! - 1
      if (ttl <= 0) {
        this.wake.delete(key)
        // sleep transition is render-observable: rebuild once so the surface
        // bakes the waterFlow (disturbance) attribute off (T61)
        this.markPageDirty(key)
        this.version++
      } else this.wake.set(key, ttl)
    }
    for (const key of changed) this.wake.set(key, WAKE_TTL)
    if (changed.size > 0) this.version++
    this.stepCount = (this.stepCount + 1) >>> 0
  }

  // ---------------------------------------------------------------- internals

  private stepChunkCol(key: number, changed: Set<number>): void {
    const page = this.colPages.get(key)
    if (!page || page.wet === 0) return
    const bx = (key % WORLD_CX) << 5
    const bz = ((key / WORLD_CX) | 0) << 5
    // vertical: a span with an open voxel under its bottom falls 1 voxel/step
    for (let i = 0; i < COLS; i++) {
      const m = page.m[i]
      if (m === 0) continue
      this.workCount++
      const bot = page.bottom[i]
      if (bot > 0) {
        const x = bx + (i & 31)
        const z = bz + (i >> 5)
        if (this.world.getVoxel(x, bot - 1, z) === 0) {
          page.bottom[i] = bot - 1
          this.touch(x, z, bot - 1, topVoxel(bot, m))
          changed.add(key)
        }
      }
    }
    // lateral: sequential integer transfers, fixed order (V2); pairs are
    // evaluated in BOTH directions so higher water in an asleep neighbor
    // page flows into this one (and wakes it via `changed`)
    const order = (this.stepCount & 1) === 0 ? ORDER_EVEN : ORDER_ODD
    for (let i = 0; i < COLS; i++) {
      if (page.m[i] === 0) continue
      const x = bx + (i & 31)
      const z = bz + (i >> 5)
      for (let k = 0; k < 8; k += 2) {
        this.flowPair(page, i, x, z, x + order[k], z + order[k + 1], key, changed)
        if (page.m[i] === 0) break // column drained mid-visit
      }
    }
  }

  /** evaluate the (c, n) column pair — the higher surface donates */
  private flowPair(
    pc: ColumnPage,
    ic: number,
    xc: number,
    zc: number,
    xn: number,
    zn: number,
    keyC: number,
    changed: Set<number>,
  ): void {
    if (xn < 0 || zn < 0 || xn >= WORLD_VX || zn >= WORLD_VZ) return // arena wall
    const keyN = (xn >> 5) + (zn >> 5) * WORLD_CX
    const pn = keyN === keyC ? pc : this.colPages.get(keyN) ?? null
    const iN = (xn & 31) + ((zn & 31) << 5)
    const mN = pn ? pn.m[iN] : 0
    if (mN > 0) {
      const surfN = pn!.bottom[iN] * 255 + mN
      const surfC = pc.bottom[ic] * 255 + pc.m[ic]
      if (surfN > surfC) {
        this.transfer(pn!, iN, xn, zn, keyN, pc, ic, xc, zc, keyC, changed)
        return
      }
    }
    this.transfer(pc, ic, xc, zc, keyC, pn, iN, xn, zn, keyN, changed)
  }

  /** move water donor → receiver per rules.ts columnFlow; exact-integer */
  private transfer(
    dp: ColumnPage,
    di: number,
    dx: number,
    dz: number,
    dKey: number,
    rp: ColumnPage | null,
    ri: number,
    rx: number,
    rz: number,
    rKey: number,
    changed: Set<number>,
  ): void {
    const mD = dp.m[di]
    if (mD === 0) return
    const botD = dp.bottom[di]
    const surfD = botD * 255 + mD
    const topD = topVoxel(botD, mD)
    const mR = rp ? rp.m[ri] : 0
    if (mR > 0 && surfD - (rp!.bottom[ri] * 255 + mR) <= SURFACE_DEADBAND) return // settled pair, no sill scan
    // sill: lowest open receiver voxel inside the donor span (walls hold here)
    const w = this.world
    let sill = -1
    for (let y = botD; y <= topD; y++) {
      if (w.getVoxel(rx, y, rz) === 0) {
        sill = y
        break
      }
    }
    if (sill < 0) return
    // receiver landing surface (dry column: water falls to its floor)
    let botR: number
    let surfR: number
    if (mR > 0) {
      botR = rp!.bottom[ri]
      surfR = botR * 255 + mR
    } else {
      let f = sill
      while (f > 0 && w.getVoxel(rx, f - 1, rz) === 0) f--
      botR = f
      surfR = f * 255
    }
    let t = columnFlow(surfD, surfR, sill * 255, mR > 0)
    if (t <= 0) return
    // ceiling: the receiver surface may not rise through a solid
    if (surfR + t > WORLD_VY * 255) t = WORLD_VY * 255 - surfR
    const topR0 = mR > 0 ? topVoxel(botR, mR) : botR
    const newTopR = topVoxel(botR, mR + t)
    for (let y = topR0 + 1; y <= newTopR; y++) {
      if (w.getVoxel(rx, y, rz) !== 0) {
        t = y * 255 - surfR
        break
      }
    }
    if (t <= 0) return
    // apply — exact integer move
    dp.m[di] = mD - t
    if (dp.m[di] === 0) dp.bottom[di] = 0
    if (dp.m[di] === 0) dp.wet--
    let rpp = rp
    if (!rpp) {
      rpp = new ColumnPage()
      this.colPages.set(rKey, rpp)
    }
    if (mR === 0) {
      rpp.wet++
      rpp.bottom[ri] = botR
    }
    rpp.m[ri] = mR + t
    this.touch(dx, dz, dp.m[di] > 0 ? topVoxel(botD, dp.m[di]) : botD, topD)
    this.touch(rx, rz, mR > 0 ? topR0 : botR, topVoxel(botR, mR + t))
    changed.add(dKey)
    changed.add(rKey)
  }

  /** mark the 3D chunks covering cells (x,z,yLo..yHi) render-dirty */
  private touch(x: number, z: number, yLo: number, yHi: number): void {
    const base = (x >> 5) + (z >> 5) * WORLD_CX
    const c1 = yHi >> 5
    for (let cy = yLo >> 5; cy <= c1; cy++) this.renderDirty.add(base + cy * CY_STRIDE)
  }

  /** render-dirty every water-holding chunk of a page (sleep transition, T61) */
  private markPageDirty(key: number): void {
    const page = this.colPages.get(key)
    if (!page || page.wet === 0) return
    let lo = WORLD_VY
    let hi = 0
    for (let i = 0; i < COLS; i++) {
      const m = page.m[i]
      if (m === 0) continue
      const bot = page.bottom[i]
      if (bot < lo) lo = bot
      const top = topVoxel(bot, m)
      if (top > hi) hi = top
    }
    if (lo > hi) return
    const c1 = hi >> 5
    for (let cy = lo >> 5; cy <= c1; cy++) this.renderDirty.add(key + cy * CY_STRIDE)
  }
}

/**
 * I.hash integration — FNV-1a over the column state, deterministic order:
 * stepCount, then per page (ascending key): key + raw m/bottom bytes.
 * Typed-array byte views are little-endian on every supported target (WebGPU
 * hosts are LE; same assumption as the rest of the hash code). ~6KB per
 * chunk-column page vs 32KB per 3D chunk before — desync checks got cheaper.
 */
export function hashWaterInto(h: Fnv, water: WaterSim): Fnv {
  h.u32(water.stepCount)
  water.forEachColumnPage((key, m, bottom) => {
    h.u32(key)
    h.bytes(new Uint8Array(m.buffer, m.byteOffset, m.byteLength))
    h.bytes(new Uint8Array(bottom.buffer, bottom.byteOffset, bottom.byteLength))
  })
  return h
}

export function hashWater(water: WaterSim): number {
  return hashWaterInto(new Fnv(), water).value
}

/**
 * Sim steps per tick (T62): two — fall speed 12 m/s, lateral transport up to
 * 4 voxels/pair/tick (FLOW_CAP×2). Settled water still costs nothing.
 */
export const WATER_STEPS_PER_TICK = 2

/**
 * Wire the water sim into the sim loop as a system (runs once per tick after
 * command handlers). The returned WaterSim is the sim-side API for source/
 * sink ops (pool filling, future water commands).
 */
export function attachWaterSim(sim: Sim): WaterSim {
  const water = new WaterSim(sim.world)
  sim.addSystem(() => {
    for (let i = 0; i < WATER_STEPS_PER_TICK; i++) water.step()
  })
  return water
}
