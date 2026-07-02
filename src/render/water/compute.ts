/**
 * T15 — GPU water CA (perf path). TSL compute mirror of the CPU reference.
 *
 * Rule spec: src/sim/water/rules.ts — the single source of truth. Every rule
 * expression below cites the matching CPU function. If either side changes,
 * the other MUST change identically; the CPU-vs-GPU hash harness described in
 * src/sim/water/INTEGRATION-water.md is the enforcement mechanism (GPU cannot
 * run under vitest).
 *
 * V4 compliance:
 *   - integer math only: all state and rule arithmetic is u32 (levels 0..255)
 *   - gather-only ping-pong: each kernel reads `src`, writes only its own cell
 *     in `dst`; NO atomics, NO floats in state or rules
 *   - fixed dispatch order per step: vertical (A→B) then lateral (B→A), so
 *     buffer A is always the front buffer between steps
 *
 * The GPU field covers a fixed axis-aligned region of the voxel grid (choose
 * it to enclose all water + margin; region borders behave as solid walls,
 * matching the CPU arena-edge rule as long as water never reaches the region
 * border — harness must assert this).
 *
 * This module lives in src/render/** and never mutates sim state (V6): it
 * only consumes CPU water/solid snapshots via upload*() and produces levels
 * for rendering/validation readback.
 */

import type { ComputeNode, Node, Renderer, StorageBufferNode } from 'three/webgpu'
import { Fn, If, instanceIndex, instancedArray, select, uint, uniform } from 'three/tsl'
import { LATERAL_DEADBAND, MAX_LEVEL } from '../../sim/water/rules'

export interface WaterGpuRegion {
  /** region origin in voxel coords */
  x: number
  y: number
  z: number
  /** region size in cells */
  sx: number
  sy: number
  sz: number
}

/** cell index inside the region: x + z*sx + y*sx*sz (matches kernel addressing) */
export function gpuCellIndex(region: WaterGpuRegion, x: number, y: number, z: number): number {
  return x - region.x + (z - region.z) * region.sx + (y - region.y) * region.sx * region.sz
}

export class WaterGpuCa {
  readonly region: WaterGpuRegion
  readonly cellCount: number
  /** front level buffer (u32 per cell, values 0..255) — valid between steps */
  readonly levelsA: StorageBufferNode<'uint'>
  private readonly levelsB: StorageBufferNode<'uint'>
  /** solid occupancy (u32 0|1 per cell) — snapshot of voxel grid */
  readonly solids: StorageBufferNode<'uint'>
  private readonly phase = uniform(0, 'uint')
  private readonly vertical: ComputeNode
  private readonly lateral: ComputeNode
  stepCount = 0

  constructor(region: WaterGpuRegion) {
    this.region = region
    const count = region.sx * region.sy * region.sz
    this.cellCount = count
    this.levelsA = instancedArray(count, 'uint')
    this.levelsB = instancedArray(count, 'uint')
    this.solids = instancedArray(count, 'uint')

    const SX = uint(region.sx)
    const SZ = uint(region.sz)
    const SY = uint(region.sy)
    const SLICE = uint(region.sx * region.sz) // +1 in y
    const MAX = uint(MAX_LEVEL)
    const last = uint(count - 1)
    const solids = this.solids
    const phase = this.phase

    /** integer min via select — the tsl min() helper is float-typed */
    type UintNode = Node<'uint'>
    const uMin = (a: UintNode, b: UintNode): UintNode => select(a.lessThan(b), a, b)

    /**
     * VERTICAL kernel — mirrors rules.verticalNext():
     *   out = belowOpen ? min(L, MAX - L_below) : 0
     *   in  = min(L_above, MAX - L)
     *   next = L - out + in
     * Region floor/ceiling behave as solid (belowOpen=false, L_above=0).
     */
    const makeVertical = (src: StorageBufferNode<'uint'>, dst: StorageBufferNode<'uint'>) =>
      Fn(() => {
        const i = instanceIndex
        const y = i.div(SLICE)
        const level = src.element(i).toVar()

        // below (guard index: clamped read, masked by belowOpen)
        const belowIdx = select(y.greaterThan(uint(0)), i.sub(SLICE), i)
        const belowOpen = y.greaterThan(uint(0)).and(solids.element(belowIdx).equal(uint(0)))
        const belowLevel = src.element(belowIdx)
        const out = select(belowOpen, uMin(level, MAX.sub(belowLevel)), uint(0))

        // above (solid cells always hold 0, so no solidity test needed on the source)
        const aboveIdx = uMin(i.add(SLICE), last)
        const aboveLevel = select(y.add(uint(1)).lessThan(SY), src.element(aboveIdx), uint(0))
        const inn = uMin(aboveLevel, MAX.sub(level))

        const next = level.sub(out).add(inn).toVar()
        If(solids.element(i).notEqual(uint(0)), () => {
          next.assign(uint(0))
        })
        dst.element(i).assign(next)
      })().compute(count)

    /**
     * LATERAL kernel — mirrors rules.lateralNext() + lateralPhase():
     *   phase&1 selects axis (0=x, 1=z), phase>>1 the pairing offset.
     *   Donor = fuller cell; donor mode from its below-cell (rules.DonorMode):
     *     SUPPORTED (floor/solid/full water below):
     *       waterfall leg — empty receiver that is itself unsupported gets
     *       EVERYTHING (donor → 0); else deadbanded equalization —
     *       diff <= LATERAL_DEADBAND ⇒ no flow, else half = (L+Ln)>>1 with the
     *       remainder to the fuller cell (B21 settle deadband).
     *     SPLASHING (unsupported, 0 < below < MAX): quarter-diff spill (T62).
     *     FALLING (below open+empty): no lateral flow.
     * NOTE: CPU pairing parity uses WORLD coords; region origin is baked in
     * below so both sides pair identically (region.x/z added to local coords).
     */
    const makeLateral = (src: StorageBufferNode<'uint'>, dst: StorageBufferNode<'uint'>) =>
      Fn(() => {
        const i = instanceIndex
        const x = i.mod(SX)
        const z = i.div(SX).mod(SZ)
        const y = i.div(SLICE)
        const level = src.element(i).toVar()
        const next = level.toVar()

        const axisZ = phase.bitAnd(uint(1)).equal(uint(1))
        const offset = phase.shiftRight(uint(1))
        const coord = select(axisZ, z, x)
        const extent = select(axisZ, SZ, SX)
        const stride = select(axisZ, SX, uint(1))
        // world-coord pairing parity (region origin baked in)
        const worldCoord = coord.add(select(axisZ, uint(this.region.z), uint(this.region.x)))
        const isLeft = worldCoord.add(offset).bitAnd(uint(1)).equal(uint(0))
        const partnerValid = select(isLeft, coord.add(uint(1)).lessThan(extent), coord.greaterThan(uint(0)))
        // u32 wrap on the unused branch is fine — index is clamped, result masked
        const partnerIdx = uMin(select(isLeft, i.add(stride), i.sub(stride)), last)

        If(
          solids
            .element(i)
            .equal(uint(0))
            .and(partnerValid)
            .and(solids.element(partnerIdx).equal(uint(0))),
          () => {
            const partner = src.element(partnerIdx)
            If(partner.notEqual(level), () => {
              // donor = fuller cell; mode from the donor's below-cell (same snapshot)
              const donorIdx = select(level.greaterThan(partner), i, partnerIdx)
              const donorBelowIdx = select(y.greaterThan(uint(0)), donorIdx.sub(SLICE), donorIdx)
              const belowLevel = src.element(donorBelowIdx)
              const supported = y
                .equal(uint(0))
                .or(solids.element(donorBelowIdx).notEqual(uint(0)))
                .or(belowLevel.equal(MAX))
              const diff = select(level.greaterThan(partner), level.sub(partner), partner.sub(level))
              If(supported, () => {
                // waterfall leg: empty receiver about to fall gets everything
                const receiverIdx = select(level.greaterThan(partner), partnerIdx, i)
                const receiverBelowIdx = select(y.greaterThan(uint(0)), receiverIdx.sub(SLICE), receiverIdx)
                const receiverUnsupported = y
                  .greaterThan(uint(0))
                  .and(solids.element(receiverBelowIdx).equal(uint(0)))
                  .and(src.element(receiverBelowIdx).notEqual(MAX))
                const receiverEmpty = uMin(level, partner).equal(uint(0))
                If(receiverEmpty.and(receiverUnsupported), () => {
                  next.assign(select(level.greaterThan(partner), uint(0), level.add(partner)))
                }).Else(() => {
                  // deadbanded equalization (rules.lateralNext, Supported leg)
                  If(diff.greaterThan(uint(LATERAL_DEADBAND)), () => {
                    const total = level.add(partner)
                    const half = total.shiftRight(uint(1))
                    const extra = select(
                      total.bitAnd(uint(1)).equal(uint(1)).and(level.greaterThan(partner)),
                      uint(1),
                      uint(0),
                    )
                    next.assign(half.add(extra))
                  })
                })
              }).Else(() => {
                // splashing: unsupported donor landing on partial water — quarter-diff spill
                If(y.greaterThan(uint(0)).and(belowLevel.greaterThan(uint(0))), () => {
                  const t = diff.shiftRight(uint(2))
                  If(t.greaterThan(uint(0)), () => {
                    next.assign(select(level.greaterThan(partner), level.sub(t), level.add(t)))
                  })
                })
              })
            })
          },
        )
        If(solids.element(i).notEqual(uint(0)), () => {
          next.assign(uint(0))
        })
        dst.element(i).assign(next)
      })().compute(count)

    // fixed dispatch order (V4): vertical A→B, lateral B→A; A is front between steps
    this.vertical = makeVertical(this.levelsA, this.levelsB)
    this.lateral = makeLateral(this.levelsB, this.levelsA)
  }

  /**
   * Upload CPU snapshots into the GPU buffers. `levels` are u8 water levels
   * and `solidMask` 0|1 occupancy, both in region-local gpuCellIndex order.
   */
  uploadLevels(levels: Uint8Array | Uint32Array): void {
    this.writeBuffer(this.levelsA, levels)
  }

  uploadSolids(solidMask: Uint8Array | Uint32Array): void {
    this.writeBuffer(this.solids, solidMask)
  }

  private writeBuffer(node: StorageBufferNode<'uint'>, src: Uint8Array | Uint32Array): void {
    if (src.length !== this.cellCount) {
      throw new Error(`water gpu upload: expected ${this.cellCount} cells, got ${src.length}`)
    }
    const attr = node.value as unknown as { array: Uint32Array; needsUpdate: boolean }
    attr.array.set(src)
    attr.needsUpdate = true
  }

  /** advance one CA step: same phase schedule as the CPU reference */
  step(renderer: Renderer): void {
    this.phase.value = this.stepCount & 3
    renderer.compute(this.vertical)
    renderer.compute(this.lateral)
    this.stepCount = (this.stepCount + 1) >>> 0
  }

  /**
   * Read the front level buffer back to the CPU (validation harness /
   * buoyancy sampling). One-tick-delayed readback of deterministic state is
   * still deterministic (DESIGN 2.5).
   */
  async readLevels(renderer: Renderer): Promise<Uint32Array> {
    const buf = await (
      renderer as unknown as { getArrayBufferAsync(attr: unknown): Promise<ArrayBuffer> }
    ).getArrayBufferAsync(this.levelsA.value)
    return new Uint32Array(buf)
  }
}
