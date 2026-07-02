/**
 * T15 — CPU reference water CA. Authoritative sim version (V2, V4-mirrored, V9).
 *
 * Storage: sparse water pages aligned to the 32³ chunk grid. A page is a
 * Uint8Array(32768) of levels 0..255, allocated only where water exists —
 * never a dense world-sized field. Pages holding only zeros are freed.
 *
 * Activity: `wake` maps chunk index → remaining awake steps. A step processes
 * wake ∪ face-neighbors(wake); settled water costs nothing (step()
 * early-returns when wake is empty, and stepCount does not advance — hash
 * stays stable while settled). A changed chunk stays awake for 4 steps
 * because the lateral pass cycles 4 pairing phases — a chunk may only sleep
 * once it is provably stable under every phase (else water could freeze in a
 * state that a not-yet-run pairing would still move).
 *
 * Why skipping settled chunks is exact (not an approximation): flow across a
 * cell pair is a pure function of the pair's previous state + solids. If
 * neither cell changed since the pair was last processed (both chunks
 * settled), the flow is still zero. Any chunk that changes wakes itself, and
 * the processing set expands to its neighbors next step, so every pair that
 * could flow has both sides processed — mass conservation (V9) holds under
 * the active-set optimization.
 *
 * Contract with the rest of the sim (V1): every voxel edit that can affect
 * water (dig/place near water) must call notifyVoxelChanged(x,y,z). Placing a
 * solid voxel into water destroys that cell's water (displacement — an
 * explicit sink; the amount is returned).
 *
 * Determinism (V2): chunk processing order is sorted ascending, cell order is
 * linear vi order, no wall-clock, no ambient randomness, integer state only.
 */

import {
  CHUNK_VOL,
  ChunkKind,
  ChunkStore,
  WORLD_CX,
  WORLD_CY,
  WORLD_CZ,
  WORLD_VX,
  WORLD_VY,
  WORLD_VZ,
  chunkIndex,
  voxelInChunk,
  type Chunk,
} from '../../world/chunks'
import { Fnv } from '../hash'
import type { Sim } from '../loop'
import { DonorMode, MAX_LEVEL, lateralNext, lateralPhase, verticalNext } from './rules'

const CZ_STRIDE = WORLD_CX
const CY_STRIDE = WORLD_CX * WORLD_CZ
/** local index strides inside a 32³ page: +x = 1, +z = 32, +y = 1024 */
const LX = 1
const LZ = 32
const LY = 1024
/** vi delta when crossing a chunk border in y (local y 31 ↔ 0): 31*1024 */
const WRAP_Y = 31 * LY

/** shared all-zero page for gather reads from unallocated chunks */
const ZERO_PAGE = new Uint8Array(CHUNK_VOL)

function solidAt(c: Chunk, vi: number): boolean {
  return c.kind === ChunkKind.Dense ? c.data![vi] !== 0 : c.kind === ChunkKind.Uniform && c.mat !== 0
}

function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_VX && y < WORLD_VY && z < WORLD_VZ
}

interface PassResult {
  ci: number
  out: Uint8Array
  nonzero: boolean
}

/** steps a chunk stays awake after its last change: one per lateral phase */
const WAKE_TTL = 4

export class WaterSim {
  /** water pages by chunk index — allocated only where water exists */
  private readonly pages = new Map<number, Uint8Array>()
  /** chunk index → remaining awake steps */
  private readonly wake = new Map<number, number>()
  /** chunks with changed water since last drainRenderDirty() — render-only (B26) */
  private readonly renderDirty = new Set<number>()
  private readonly pool: Uint8Array[] = []
  /** CA steps actually executed (does not advance while settled) — part of hashed state */
  stepCount = 0
  /** bumped on any observable change; render-layer change detection only, not hashed */
  version = 0

  constructor(private readonly world: ChunkStore) {}

  /** number of awake chunks — 0 means fully settled (perf invariant) */
  get activeChunkCount(): number {
    return this.wake.size
  }

  /**
   * True while a chunk is in the wake set (changed within the last WAKE_TTL
   * steps). Render-side disturbance hook (T61) — read-only, deterministic,
   * not part of the hash.
   */
  isChunkAwake(ci: number): boolean {
    return this.wake.has(ci)
  }

  /** render-side page accessor (surface extraction) — read-only, may be null */
  pageAt(ci: number): Uint8Array | null {
    return this.pages.get(ci) ?? null
  }

  /**
   * Chunks whose water content changed since the last drain — consumed by the
   * render layer for incremental surface rebuilds (B26). Render-only
   * bookkeeping (same pattern as PhysicsWorld.drainRemesh); never hashed,
   * never read by rules.
   */
  drainRenderDirty(): number[] {
    if (this.renderDirty.size === 0) return []
    const out = [...this.renderDirty].sort((a, b) => a - b)
    this.renderDirty.clear()
    return out
  }

  levelAt(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    const page = this.pages.get(chunkIndex(x >> 5, y >> 5, z >> 5))
    return page ? page[voxelInChunk(x, y, z)] : 0
  }

  /**
   * Source op (V9 exception): add up to `amount` water to a cell.
   * Returns the amount actually added (0 if solid, OOB, or cell full).
   */
  addWater(x: number, y: number, z: number, amount: number): number {
    amount = amount | 0
    if (amount <= 0 || !inBounds(x, y, z) || this.world.getVoxel(x, y, z) !== 0) return 0
    const ci = chunkIndex(x >> 5, y >> 5, z >> 5)
    const vi = voxelInChunk(x, y, z)
    let page = this.pages.get(ci)
    const cur = page ? page[vi] : 0
    const add = Math.min(amount, MAX_LEVEL - cur)
    if (add <= 0) return 0
    if (!page) {
      page = this.acquire()
      page.fill(0)
      this.pages.set(ci, page)
    }
    page[vi] = cur + add
    this.wake.set(ci, WAKE_TTL)
    this.renderDirty.add(ci)
    this.version++
    return add
  }

  /** Sink op (V9 exception): remove up to `amount` water. Returns amount removed. */
  removeWater(x: number, y: number, z: number, amount: number): number {
    amount = amount | 0
    if (amount <= 0 || !inBounds(x, y, z)) return 0
    const ci = chunkIndex(x >> 5, y >> 5, z >> 5)
    const page = this.pages.get(ci)
    if (!page) return 0
    const vi = voxelInChunk(x, y, z)
    const take = Math.min(amount, page[vi])
    if (take <= 0) return 0
    page[vi] -= take
    this.freeIfEmpty(ci, page)
    this.wake.set(ci, WAKE_TTL)
    this.renderDirty.add(ci)
    this.version++
    return take
  }

  /**
   * MUST be called for every voxel edit that could touch water (contract with
   * edit ops). Wakes the region ONLY when water is actually nearby (B26 —
   * a dig on the far side of the arena must cost nothing here and must not
   * trigger a surface rebuild); if the cell became solid, destroys the
   * displaced water and returns the destroyed amount (explicit sink).
   *
   * "Nearby" = any cell whose CA rule reads this voxel's solidity holds
   * water: self, the 6 face neighbors (vertical flow + lateral pairing),
   * and the 4 lateral neighbors of the cell ABOVE (their donor-support /
   * waterfall-receiver checks read this voxel as a below-cell). If all 11
   * are dry, every flow term involving this voxel stays 0 — skipping the
   * wake is exact, not an approximation.
   */
  notifyVoxelChanged(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    const nearby =
      this.levelAt(x, y, z) > 0 ||
      this.levelAt(x, y + 1, z) > 0 ||
      this.levelAt(x, y - 1, z) > 0 ||
      this.levelAt(x + 1, y, z) > 0 ||
      this.levelAt(x - 1, y, z) > 0 ||
      this.levelAt(x, y, z + 1) > 0 ||
      this.levelAt(x, y, z - 1) > 0 ||
      this.levelAt(x + 1, y + 1, z) > 0 ||
      this.levelAt(x - 1, y + 1, z) > 0 ||
      this.levelAt(x, y + 1, z + 1) > 0 ||
      this.levelAt(x, y + 1, z - 1) > 0
    if (!nearby) return 0
    const ci = chunkIndex(x >> 5, y >> 5, z >> 5)
    this.wake.set(ci, WAKE_TTL)
    this.renderDirty.add(ci)
    this.version++
    if (this.world.getVoxel(x, y, z) === 0) return 0
    const page = this.pages.get(ci)
    if (!page) return 0
    const vi = voxelInChunk(x, y, z)
    const displaced = page[vi]
    if (displaced > 0) {
      page[vi] = 0
      this.freeIfEmpty(ci, page)
    }
    return displaced
  }

  /** total integer water mass — constant across steps absent source/sink (V9) */
  totalMass(): number {
    let sum = 0
    for (const page of this.pages.values()) {
      for (let i = 0; i < CHUNK_VOL; i++) sum += page[i]
    }
    return sum
  }

  /** iterate allocated pages in ascending chunk-index order (deterministic) */
  forEachPage(fn: (ci: number, data: Uint8Array) => void): void {
    const keys = [...this.pages.keys()].sort((a, b) => a - b)
    for (const ci of keys) fn(ci, this.pages.get(ci)!)
  }

  /**
   * Advance the CA one step: vertical pass then lateral pass (fixed order,
   * mirroring the GPU dispatch order — V4). No-op while settled.
   */
  step(): void {
    if (this.wake.size === 0) return
    const active = [...this.wake.keys()].sort((a, b) => a - b)
    const changed = new Set<number>()
    this.runPass(this.expand(active), 'vertical', 0, 0, changed)
    // lateral must also cover chunks that changed during the vertical pass
    const { axis, offset } = lateralPhase(this.stepCount)
    const lateralActive = [...new Set([...active, ...changed])].sort((a, b) => a - b)
    this.runPass(this.expand(lateralActive), 'lateral', axis, offset, changed)
    // TTL bookkeeping: changed chunks get a fresh TTL; stable ones count down
    for (const ci of active) {
      if (changed.has(ci)) continue
      const ttl = this.wake.get(ci)! - 1
      if (ttl <= 0) {
        this.wake.delete(ci)
        // sleep transition is render-observable: the surface bakes the wake
        // state into the waterFlow (disturbance) attribute — rebuild once so
        // a settled chunk stops shimmering (T61)
        this.renderDirty.add(ci)
        this.version++
      } else this.wake.set(ci, ttl)
    }
    for (const ci of changed) this.wake.set(ci, WAKE_TTL)
    this.stepCount = (this.stepCount + 1) >>> 0
  }

  // ---------------------------------------------------------------- internals

  /** processing set = chunks ∪ their in-bounds face neighbors, sorted */
  private expand(chunks: number[]): number[] {
    const set = new Set<number>()
    for (const ci of chunks) {
      const cx = ci % WORLD_CX
      const cz = ((ci / CZ_STRIDE) | 0) % WORLD_CZ
      const cy = (ci / CY_STRIDE) | 0
      set.add(ci)
      if (cx > 0) set.add(ci - 1)
      if (cx < WORLD_CX - 1) set.add(ci + 1)
      if (cz > 0) set.add(ci - CZ_STRIDE)
      if (cz < WORLD_CZ - 1) set.add(ci + CZ_STRIDE)
      if (cy > 0) set.add(ci - CY_STRIDE)
      if (cy < WORLD_CY - 1) set.add(ci + CY_STRIDE)
    }
    return [...set].sort((a, b) => a - b)
  }

  private runPass(
    processing: number[],
    kind: 'vertical' | 'lateral',
    axis: 0 | 1,
    offset: 0 | 1,
    changedOut: Set<number>,
  ): void {
    const results: PassResult[] = []
    for (const ci of processing) {
      if (!this.mayHoldWater(ci, kind, axis)) continue
      const out = this.acquire()
      const r = kind === 'vertical' ? this.computeVertical(ci, out) : this.computeLateral(ci, out, axis, offset)
      if (r.changed) results.push(r)
      else this.release(out)
    }
    // commit after all gathers — ping-pong semantics
    for (const r of results) {
      const old = this.pages.get(r.ci)
      if (r.nonzero) this.pages.set(r.ci, r.out)
      else {
        this.pages.delete(r.ci)
        this.release(r.out)
      }
      if (old) this.release(old)
      changedOut.add(r.ci)
      this.renderDirty.add(r.ci)
      this.version++
    }
  }

  /** cheap guard: chunk can only end up nonzero if it or a flow-source neighbor has a page */
  private mayHoldWater(ci: number, kind: 'vertical' | 'lateral', axis: 0 | 1): boolean {
    if (this.pages.has(ci)) return true
    if (kind === 'vertical') {
      const cy = (ci / CY_STRIDE) | 0
      return cy + 1 < WORLD_CY && this.pages.has(ci + CY_STRIDE)
    }
    const stride = axis === 0 ? 1 : CZ_STRIDE
    const c = axis === 0 ? ci % WORLD_CX : ((ci / CZ_STRIDE) | 0) % WORLD_CZ
    const max = axis === 0 ? WORLD_CX : WORLD_CZ
    return (c > 0 && this.pages.has(ci - stride)) || (c + 1 < max && this.pages.has(ci + stride))
  }

  private computeVertical(ci: number, out: Uint8Array): PassResult & { changed: boolean } {
    const cy = (ci / CY_STRIDE) | 0
    const self = this.pages.get(ci) ?? ZERO_PAGE
    const selfChunk = this.world.chunkAt(ci)
    const hasAbove = cy + 1 < WORLD_CY
    const abovePage = hasAbove ? this.pages.get(ci + CY_STRIDE) ?? ZERO_PAGE : ZERO_PAGE
    const hasBelow = cy > 0
    const belowPage = hasBelow ? this.pages.get(ci - CY_STRIDE) ?? ZERO_PAGE : ZERO_PAGE
    const belowChunk = hasBelow ? this.world.chunkAt(ci - CY_STRIDE) : null

    let changed = false
    let nonzero = false
    for (let vi = 0; vi < CHUNK_VOL; vi++) {
      let next: number
      if (solidAt(selfChunk, vi)) {
        next = 0
      } else {
        const yl = vi >> 10
        const level = self[vi]
        let belowOpen: boolean
        let below: number
        if (yl > 0) {
          const bvi = vi - LY
          belowOpen = !solidAt(selfChunk, bvi)
          below = self[bvi]
        } else if (hasBelow) {
          const bvi = vi + WRAP_Y
          belowOpen = !solidAt(belowChunk!, bvi)
          below = belowPage[bvi]
        } else {
          belowOpen = false // world floor blocks (no leak out of the arena)
          below = 0
        }
        const above = yl < 31 ? self[vi + LY] : abovePage[vi - WRAP_Y]
        next = verticalNext(level, above, below, belowOpen)
      }
      out[vi] = next
      if (next !== self[vi]) changed = true
      if (next !== 0) nonzero = true
    }
    return { ci, out, changed, nonzero }
  }

  private computeLateral(ci: number, out: Uint8Array, axis: 0 | 1, offset: 0 | 1): PassResult & { changed: boolean } {
    const cx = ci % WORLD_CX
    const cz = ((ci / CZ_STRIDE) | 0) % WORLD_CZ
    const cy = (ci / CY_STRIDE) | 0
    const bx = cx << 5
    const by = cy << 5
    const bz = cz << 5
    const self = this.pages.get(ci) ?? ZERO_PAGE
    const selfChunk = this.world.chunkAt(ci)
    const hasBelow = cy > 0
    const belowPage = hasBelow ? this.pages.get(ci - CY_STRIDE) ?? ZERO_PAGE : ZERO_PAGE
    const belowChunk = hasBelow ? this.world.chunkAt(ci - CY_STRIDE) : null

    const localStride = axis === 0 ? LX : LZ
    const chunkStride = axis === 0 ? 1 : CZ_STRIDE
    const cChunk = axis === 0 ? cx : cz
    const cMaxChunk = axis === 0 ? WORLD_CX : WORLD_CZ
    const base = axis === 0 ? bx : bz
    const wrap = 31 * localStride

    /** donor mode from a below-cell (solidity + previous-state water level) — rules.ts DonorMode */
    const modeFromBelow = (belowSolid: boolean, belowLevel: number): DonorMode => {
      if (belowSolid || belowLevel === MAX_LEVEL) return DonorMode.Supported
      return belowLevel > 0 ? DonorMode.Splashing : DonorMode.Falling
    }

    /** donor mode using self-chunk fast paths; donor is at local (vi, yl) of this chunk */
    const donorModeLocal = (vi: number, yl: number): DonorMode => {
      if (yl > 0) {
        const bvi = vi - LY
        return modeFromBelow(solidAt(selfChunk, bvi), self[bvi])
      }
      if (!hasBelow) return DonorMode.Supported // world floor
      const bvi = vi + WRAP_Y
      return modeFromBelow(solidAt(belowChunk!, bvi), belowPage[bvi])
    }

    /** generic (cross-chunk) donor mode at world coords */
    const donorModeWorld = (x: number, y: number, z: number): DonorMode => {
      if (y === 0) return DonorMode.Supported
      return modeFromBelow(this.world.getVoxel(x, y - 1, z) !== 0, this.levelAt(x, y - 1, z))
    }

    let changed = false
    let nonzero = false
    for (let vi = 0; vi < CHUNK_VOL; vi++) {
      let next: number
      if (solidAt(selfChunk, vi)) {
        next = 0
      } else {
        const level = self[vi]
        const yl = vi >> 10
        const cl = axis === 0 ? vi & 31 : (vi >> 5) & 31 // local coord along axis
        const isLeft = ((base + cl + offset) & 1) === 0
        next = level
        if (isLeft ? cl < 31 : cl > 0) {
          // partner inside this chunk — fast path
          const pvi = isLeft ? vi + localStride : vi - localStride
          if (!solidAt(selfChunk, pvi)) {
            const partner = self[pvi]
            if (partner !== level) {
              const donorVi = level > partner ? vi : pvi
              const receiverVi = level > partner ? pvi : vi
              const receiverUnsupported =
                (level === 0 || partner === 0) && donorModeLocal(receiverVi, yl) !== DonorMode.Supported
              next = lateralNext(level, partner, donorModeLocal(donorVi, yl), receiverUnsupported)
            }
          }
        } else if (isLeft ? cChunk + 1 < cMaxChunk : cChunk > 0) {
          // partner across the chunk border — generic path
          const nci = isLeft ? ci + chunkStride : ci - chunkStride
          const pvi = isLeft ? vi - wrap : vi + wrap
          const nChunk = this.world.chunkAt(nci)
          if (!solidAt(nChunk, pvi)) {
            const nPage = this.pages.get(nci) ?? ZERO_PAGE
            const partner = nPage[pvi]
            if (partner !== level) {
              const xl = vi & 31
              const zl = (vi >> 5) & 31
              const px = axis === 0 ? (isLeft ? bx + 32 : bx - 1) : bx + xl
              const pz = axis === 1 ? (isLeft ? bz + 32 : bz - 1) : bz + zl
              let donorMode: DonorMode
              let receiverUnsupported = false
              if (level > partner) {
                donorMode = donorModeLocal(vi, yl)
                receiverUnsupported =
                  partner === 0 && donorModeWorld(px, by + yl, pz) !== DonorMode.Supported
              } else {
                donorMode = donorModeWorld(px, by + yl, pz)
                receiverUnsupported = level === 0 && donorModeLocal(vi, yl) !== DonorMode.Supported
              }
              next = lateralNext(level, partner, donorMode, receiverUnsupported)
            }
          }
        }
        // else: partner is outside the world — arena wall, no exchange
      }
      out[vi] = next
      if (next !== self[vi]) changed = true
      if (next !== 0) nonzero = true
    }
    return { ci, out, changed, nonzero }
  }

  private freeIfEmpty(ci: number, page: Uint8Array): void {
    for (let i = 0; i < CHUNK_VOL; i++) if (page[i] !== 0) return
    this.pages.delete(ci)
    this.release(page)
  }

  private acquire(): Uint8Array {
    return this.pool.pop() ?? new Uint8Array(CHUNK_VOL)
  }

  private release(buf: Uint8Array): void {
    if (this.pool.length < 64) this.pool.push(buf)
  }
}

/**
 * I.hash integration — FNV-1a over the water field, deterministic order.
 * Feed into an existing Fnv (to combine with hashSim) or standalone.
 */
export function hashWaterInto(h: Fnv, water: WaterSim): Fnv {
  h.u32(water.stepCount)
  water.forEachPage((ci, data) => {
    h.u32(ci).bytes(data)
  })
  return h
}

export function hashWater(water: WaterSim): number {
  return hashWaterInto(new Fnv(), water).value
}

/**
 * CA steps per sim tick (T62). Two: one lateral phase advances per CA step,
 * so a single step/tick moves mass across N cells in O(N²·4) ticks —
 * pool-scale draining read as static (B21). Two steps double fall speed to
 * 12 m/s (reads right for water) and double lateral transport. Settled water
 * still costs nothing (step() early-returns on an empty active set).
 */
export const WATER_STEPS_PER_TICK = 2

/**
 * Wire the water CA into the sim loop as a system (runs once per tick after
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
