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

import { BufferAttribute, BufferGeometry, Mesh, type Material } from 'three/webgpu'
import { VOXEL_SIZE } from '../../world/chunks'
import type { ChunkStore } from '../../world/chunks'
import { WORLD_CX, WORLD_CZ } from '../../world/chunks'
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

export function extractWaterSurface(water: WaterSim, world: ChunkStore): WaterSurfaceData {
  const positions: number[] = []
  const normals: number[] = []
  const depths: number[] = []
  const flows: number[] = []
  const indices: number[] = []

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

  water.forEachPage((ci, data) => {
    // disturbance hook (T61): the sim's wake set says which chunks are still
    // moving — cheap render-side read, no extra sim state
    const chunkAwake = water.isChunkAwake(ci)
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / CY_STRIDE) | 0
    const bx = cx << 5
    const by = cy << 5
    const bz = cz << 5
    for (let vi = 0; vi < data.length; vi++) {
      const level = data[vi]
      if (level === 0) continue
      const x = bx + (vi & 31)
      const z = bz + ((vi >> 5) & 31)
      const y = by + (vi >> 10)
      const fill = level / MAX_LEVEL
      const yTop = y + fill

      // contiguous water thickness below the surface of this column
      let below = 0
      while (below < MAX_DEPTH_WALK && water.levelAt(x, y - 1 - below, z) > 0) below++
      const depth = (below + fill) * VOXEL_SIZE

      // top: exposed unless a full cell sits directly under more water/solid ceiling.
      // A PARTIAL cell always has a free surface — even with water falling in
      // from above (pre-B20 the top was skipped whenever any water sat above,
      // leaving an open band between this fill height and the cell ceiling).
      const aboveWater = water.levelAt(x, y + 1, z)
      // disturbed = the chunk is awake AND this cell is mid-flow (partially
      // filled or being rained into) — settled pools keep flow 0
      flow = chunkAwake && (level < MAX_LEVEL || aboveWater > 0) ? 1 : 0
      if (level < MAX_LEVEL || (aboveWater === 0 && world.getVoxel(x, y + 1, z) === 0)) {
        quad(0, 1, 0, depth, [[x, yTop, z], [x, yTop, z + 1], [x + 1, yTop, z + 1], [x + 1, yTop, z]])
      }
      // bottom: exposed while the cell below is not water-full (falling blobs
      // over partial cells left an open underside pre-B20)
      if (world.getVoxel(x, y - 1, z) === 0 && water.levelAt(x, y - 1, z) < MAX_LEVEL) {
        quad(0, -1, 0, depth, [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]])
      }

      // sides (B20): a neighbor water cell only covers this face up to ITS
      // OWN fill height — the strip between the neighbor's surface and ours
      // must be skinned or flowing water is see-through from the side.
      // Returns the y where the exposed strip starts, or -1 if fully covered.
      const sideBase = (ox: number, oz: number): number => {
        if (world.getVoxel(ox, y, oz) !== 0) return -1 // solid neighbor covers the face
        const nl = water.levelAt(ox, y, oz)
        if (nl >= level) return -1 // neighbor water is at least as tall — interior face
        return y + nl / MAX_LEVEL
      }

      let sb = sideBase(x + 1, z)
      if (sb >= 0) {
        quad(1, 0, 0, depth, [[x + 1, sb, z + 1], [x + 1, sb, z], [x + 1, yTop, z], [x + 1, yTop, z + 1]])
      }
      sb = sideBase(x - 1, z)
      if (sb >= 0) {
        quad(-1, 0, 0, depth, [[x, sb, z], [x, sb, z + 1], [x, yTop, z + 1], [x, yTop, z]])
      }
      sb = sideBase(x, z + 1)
      if (sb >= 0) {
        quad(0, 0, 1, depth, [[x, sb, z + 1], [x + 1, sb, z + 1], [x + 1, yTop, z + 1], [x, yTop, z + 1]])
      }
      sb = sideBase(x, z - 1)
      if (sb >= 0) {
        quad(0, 0, -1, depth, [[x + 1, sb, z], [x, sb, z], [x, yTop, z], [x + 1, yTop, z]])
      }
    }
  })

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    depths: new Float32Array(depths),
    flows: new Float32Array(flows),
    indices: new Uint32Array(indices),
  }
}

/**
 * Owns the water surface mesh; call update(water, world) once per rendered
 * frame — it rebuilds geometry only when the water field actually changed
 * (WaterSim.version). Rebuild cost is proportional to allocated water pages.
 */
export class WaterSurface {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private lastVersion = -1

  constructor(material: Material = createWaterMaterial()) {
    this.mesh = new Mesh(this.geometry, material)
    this.mesh.name = 'water-surface'
    this.mesh.renderOrder = 1 // draw after opaque world geometry (transparency)
  }

  /** returns true if geometry was rebuilt */
  update(water: WaterSim, world: ChunkStore): boolean {
    if (water.version === this.lastVersion) return false
    this.lastVersion = water.version
    const data = extractWaterSurface(water, world)
    this.geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
    this.geometry.setAttribute('normal', new BufferAttribute(data.normals, 3))
    this.geometry.setAttribute('waterDepth', new BufferAttribute(data.depths, 1))
    this.geometry.setAttribute('waterFlow', new BufferAttribute(data.flows, 1))
    this.geometry.setIndex(new BufferAttribute(data.indices, 1))
    this.geometry.computeBoundingSphere()
    this.mesh.visible = data.indices.length > 0
    return true
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
