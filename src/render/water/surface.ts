/**
 * T16 — water surface extraction + renderable mesh. Render layer only (V6):
 * reads WaterSim/ChunkStore, never writes them.
 *
 * Extraction walks the sparse water pages and emits quads for every exposed
 * water face: column tops sit at the partial fill height (level/255 of a
 * voxel), sides/bottoms close the volume so falling and flowing water reads
 * as a body, not a film. Faces against solids are skipped; faces against
 * water neighbors are skipped only where the neighbor actually covers them —
 * a shorter neighbor column exposes a side strip from its fill height up to
 * ours (B20: skipping whole faces whenever the neighbor held ANY water left
 * see-through seams on disturbed water viewed from the side). A per-vertex
 * `waterDepth` attribute (meters of contiguous water beneath the surface)
 * drives absorption tint in the material (material.ts).
 */

import { BufferAttribute, BufferGeometry, Group, Mesh, type Material } from 'three/webgpu'
import { VOXEL_SIZE } from '../../world/chunks'
import type { ChunkStore } from '../../world/chunks'
import { WORLD_CX, WORLD_CY, WORLD_CZ } from '../../world/chunks'
import type { WaterSim } from '../../sim/water/water-sim'
import { MAX_LEVEL } from '../../sim/water/rules'
import { createWaterMaterial } from './material'

export interface WaterSurfaceData {
  positions: Float32Array
  normals: Float32Array
  /** contiguous water thickness (meters) below each vertex — absorption input */
  depths: Float32Array
  /** 1 where the cell is actively flowing (awake + partial/receiving) —
   *  drives the disturbance chop band + roughness in material.ts (T61) */
  flows: Float32Array
  indices: Uint32Array
}

const CY_STRIDE = WORLD_CX * WORLD_CZ
/** columns deeper than this all render as "deep" — bounds the depth walk */
const MAX_DEPTH_WALK = 64

interface Acc {
  positions: number[]
  normals: number[]
  depths: number[]
  flows: number[]
  indices: number[]
}

/** emit all exposed faces of one water page into the accumulator */
function extractChunkInto(water: WaterSim, world: ChunkStore, ci: number, data: Uint8Array, acc: Acc): void {
  const { positions, normals, depths, flows, indices } = acc

  let flow = 0
  const quad = (
    nx: number, ny: number, nz: number,
    depth: number,
    corners: readonly (readonly [number, number, number])[],
  ): void => {
    const base = positions.length / 3
    for (const [px, py, pz] of corners) {
      positions.push(px * VOXEL_SIZE, py * VOXEL_SIZE, pz * VOXEL_SIZE)
      normals.push(nx, ny, nz)
      depths.push(depth)
      flows.push(flow)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  // disturbance hook (T61): the sim's wake set says which chunks are still
  // moving — cheap render-side read, no extra sim state
  const chunkAwake = water.isChunkAwake(ci)
  const cx = ci % WORLD_CX
  const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
  const cy = (ci / CY_STRIDE) | 0
  const bx = cx << 5
  const by = cy << 5
  const bz = cz << 5

  // hot loop perf (B26): neighbor water reads hit the local page directly
  // where possible; world/solid lookups and the depth walk only run for
  // cells that actually expose a face. A fully interior cell costs six
  // local u8 reads and emits nothing.
  const readWater = (x: number, y: number, z: number, lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < 32 && ly >= 0 && ly < 32 && lz >= 0 && lz < 32) {
      return data[lx + lz * 32 + ly * 1024]
    }
    return water.levelAt(x, y, z)
  }

  for (let vi = 0; vi < data.length; vi++) {
    const level = data[vi]
    if (level === 0) continue
    const lx = vi & 31
    const lz = (vi >> 5) & 31
    const ly = vi >> 10
    const x = bx + lx
    const z = bz + lz
    const y = by + ly
    const fill = level / MAX_LEVEL
    const yTop = y + fill

    // contiguous water thickness below the surface — lazy: only faces need it
    let depth = -1
    const ensureDepth = (): number => {
      if (depth >= 0) return depth
      let below = 0
      while (below < MAX_DEPTH_WALK && water.levelAt(x, y - 1 - below, z) > 0) below++
      depth = (below + fill) * VOXEL_SIZE
      return depth
    }

    const aboveWater = readWater(x, y + 1, z, lx, ly + 1, lz)
    // disturbed = the chunk is awake AND this cell is mid-flow (partially
    // filled or being rained into) — settled pools keep flow 0
    flow = chunkAwake && (level < MAX_LEVEL || aboveWater > 0) ? 1 : 0

    // top: exposed unless a full cell sits directly under more water/solid
    // ceiling. A PARTIAL cell always has a free surface — even with water
    // falling in from above (pre-B20 the top was skipped whenever any water
    // sat above, leaving an open band between fill height and cell ceiling).
    if (level < MAX_LEVEL || (aboveWater === 0 && world.getVoxel(x, y + 1, z) === 0)) {
      quad(0, 1, 0, ensureDepth(), [[x, yTop, z], [x, yTop, z + 1], [x + 1, yTop, z + 1], [x + 1, yTop, z]])
    }
    // bottom: exposed while the cell below is not water-full (falling blobs
    // over partial cells left an open underside pre-B20)
    if (readWater(x, y - 1, z, lx, ly - 1, lz) < MAX_LEVEL && world.getVoxel(x, y - 1, z) === 0) {
      quad(0, -1, 0, ensureDepth(), [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]])
    }

    // sides (B20): a neighbor water cell only covers this face up to ITS
    // OWN fill height — the strip between the neighbor's surface and ours
    // must be skinned or flowing water is see-through from the side.
    // Returns the y where the exposed strip starts, or -1 if fully covered.
    const sideBase = (ox: number, oz: number, nlx: number, nlz: number): number => {
      const nl = readWater(ox, y, oz, nlx, ly, nlz)
      if (nl >= level) return -1 // neighbor water at least as tall — interior face
      if (world.getVoxel(ox, y, oz) !== 0) return -1 // solid neighbor covers the face
      return y + nl / MAX_LEVEL
    }

    let sb = sideBase(x + 1, z, lx + 1, lz)
    if (sb >= 0) {
      quad(1, 0, 0, ensureDepth(), [[x + 1, sb, z + 1], [x + 1, sb, z], [x + 1, yTop, z], [x + 1, yTop, z + 1]])
    }
    sb = sideBase(x - 1, z, lx - 1, lz)
    if (sb >= 0) {
      quad(-1, 0, 0, ensureDepth(), [[x, sb, z], [x, sb, z + 1], [x, yTop, z + 1], [x, yTop, z]])
    }
    sb = sideBase(x, z + 1, lx, lz + 1)
    if (sb >= 0) {
      quad(0, 0, 1, ensureDepth(), [[x, sb, z + 1], [x + 1, sb, z + 1], [x + 1, yTop, z + 1], [x, yTop, z + 1]])
    }
    sb = sideBase(x, z - 1, lx, lz - 1)
    if (sb >= 0) {
      quad(0, 0, -1, ensureDepth(), [[x + 1, sb, z], [x, sb, z], [x, yTop, z], [x + 1, yTop, z]])
    }
  }
}

function accToData(acc: Acc): WaterSurfaceData {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    depths: new Float32Array(acc.depths),
    flows: new Float32Array(acc.flows),
    indices: new Uint32Array(acc.indices),
  }
}

/** full-world extraction (tests, one-shot uses) — walks every allocated page */
export function extractWaterSurface(water: WaterSim, world: ChunkStore): WaterSurfaceData {
  const acc: Acc = { positions: [], normals: [], depths: [], flows: [], indices: [] }
  water.forEachPage((ci, data) => extractChunkInto(water, world, ci, data, acc))
  return accToData(acc)
}

/** single-chunk extraction (incremental path, B26) — null if the chunk holds no water */
export function extractWaterChunk(water: WaterSim, world: ChunkStore, ci: number): WaterSurfaceData | null {
  const page = water.pageAt(ci)
  if (!page) return null
  const acc: Acc = { positions: [], normals: [], depths: [], flows: [], indices: [] }
  extractChunkInto(water, world, ci, page, acc)
  return acc.indices.length > 0 ? accToData(acc) : null
}

const CZ_STRIDE_C = WORLD_CX

/** dirty chunks + face neighbors: a border cell's faces depend on the
 *  neighbor chunk's levels, so both sides rebuild when either changes */
function expandDirty(dirty: number[]): Set<number> {
  const set = new Set<number>()
  for (const ci of dirty) {
    const cx = ci % WORLD_CX
    const cz = ((ci / CZ_STRIDE_C) | 0) % WORLD_CZ
    const cy = (ci / CY_STRIDE) | 0
    set.add(ci)
    if (cx > 0) set.add(ci - 1)
    if (cx < WORLD_CX - 1) set.add(ci + 1)
    if (cz > 0) set.add(ci - CZ_STRIDE_C)
    if (cz < WORLD_CZ - 1) set.add(ci + CZ_STRIDE_C)
    if (cy > 0) set.add(ci - CY_STRIDE)
    if (cy < WORLD_CY - 1) set.add(ci + CY_STRIDE)
  }
  return set
}

/**
 * Owns the water surface meshes (one per water chunk, shared material); call
 * update(water, world) once per rendered frame. Incremental (B26): only
 * chunks the sim reports dirty (plus face neighbors) re-extract — a dig far
 * from any water costs nothing here, and a splash in the pool rebuilds just
 * the pool's chunks.
 *
 * Known micro-approximation: the per-vertex depth attribute walks contiguous
 * water columns, which can span >1 chunk below the rebuilt one; a level
 * change deeper than the neighbor ring can leave a slightly stale absorption
 * tint until the surface chunk itself changes. Sub-tint-level, render-only.
 */
export class WaterSurface {
  /** parent of all per-chunk water meshes — add THIS to the scene */
  readonly mesh = new Group()
  private readonly material: Material
  private readonly chunks = new Map<number, Mesh>()
  private lastVersion = -1

  constructor(material: Material = createWaterMaterial()) {
    this.material = material
    this.mesh.name = 'water-surface'
    this.mesh.renderOrder = 1 // draw after opaque world geometry (transparency)
  }

  /** number of live per-chunk meshes (tests/diagnostics) */
  get chunkMeshCount(): number {
    return this.chunks.size
  }

  /** returns true if any geometry was rebuilt */
  update(water: WaterSim, world: ChunkStore): boolean {
    if (water.version === this.lastVersion) return false
    this.lastVersion = water.version
    const dirty = water.drainRenderDirty()
    if (dirty.length === 0) return false
    let rebuilt = false
    for (const ci of expandDirty(dirty)) {
      rebuilt = this.rebuildChunk(water, world, ci) || rebuilt
    }
    return rebuilt
  }

  private rebuildChunk(water: WaterSim, world: ChunkStore, ci: number): boolean {
    const data = extractWaterChunk(water, world, ci)
    const existing = this.chunks.get(ci)
    if (!data) {
      if (existing) {
        this.mesh.remove(existing)
        existing.geometry.dispose()
        this.chunks.delete(ci)
        return true
      }
      return false
    }
    let mesh = existing
    if (!mesh) {
      mesh = new Mesh(new BufferGeometry(), this.material)
      mesh.name = `water-chunk-${ci}`
      mesh.renderOrder = 1
      this.chunks.set(ci, mesh)
      this.mesh.add(mesh)
    }
    const g = mesh.geometry
    g.setAttribute('position', new BufferAttribute(data.positions, 3))
    g.setAttribute('normal', new BufferAttribute(data.normals, 3))
    g.setAttribute('waterDepth', new BufferAttribute(data.depths, 1))
    g.setAttribute('waterFlow', new BufferAttribute(data.flows, 1))
    g.setIndex(new BufferAttribute(data.indices, 1))
    g.computeBoundingSphere()
    return true
  }

  dispose(): void {
    for (const mesh of this.chunks.values()) {
      this.mesh.remove(mesh)
      mesh.geometry.dispose()
    }
    this.chunks.clear()
  }
}
