/**
 * T16 — water surface extraction + renderable mesh. Render layer only (V6):
 * reads WaterSim/ChunkStore, never writes them.
 *
 * Extraction walks the sparse water pages and emits quads for every water
 * face adjacent to air: column tops sit at the partial fill height
 * (level/255 of a voxel), sides/bottoms close the volume so falling and
 * flowing water reads as a body, not a film. Faces against solids or other
 * water cells are skipped. A per-vertex `waterDepth` attribute (meters of
 * contiguous water beneath the surface) drives absorption tint in the
 * material (material.ts).
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
  indices: Uint32Array
}

const CY_STRIDE = WORLD_CX * WORLD_CZ
/** columns deeper than this all render as "deep" — bounds the depth walk */
const MAX_DEPTH_WALK = 64

export function extractWaterSurface(water: WaterSim, world: ChunkStore): WaterSurfaceData {
  const positions: number[] = []
  const normals: number[] = []
  const depths: number[] = []
  const indices: number[] = []

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
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  water.forEachPage((ci, data) => {
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

      const open = (ox: number, oy: number, oz: number): boolean =>
        water.levelAt(ox, oy, oz) === 0 && world.getVoxel(ox, oy, oz) === 0

      // top: exposed unless a full cell sits directly under more water/solid ceiling
      if (water.levelAt(x, y + 1, z) === 0 && !(level === MAX_LEVEL && world.getVoxel(x, y + 1, z) !== 0)) {
        quad(0, 1, 0, depth, [[x, yTop, z], [x, yTop, z + 1], [x + 1, yTop, z + 1], [x + 1, yTop, z]])
      }
      if (open(x, y - 1, z)) {
        quad(0, -1, 0, depth, [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]])
      }
      if (open(x + 1, y, z)) {
        quad(1, 0, 0, depth, [[x + 1, y, z + 1], [x + 1, y, z], [x + 1, yTop, z], [x + 1, yTop, z + 1]])
      }
      if (open(x - 1, y, z)) {
        quad(-1, 0, 0, depth, [[x, y, z], [x, y, z + 1], [x, yTop, z + 1], [x, yTop, z]])
      }
      if (open(x, y, z + 1)) {
        quad(0, 0, 1, depth, [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, yTop, z + 1], [x, yTop, z + 1]])
      }
      if (open(x, y, z - 1)) {
        quad(0, 0, -1, depth, [[x + 1, y, z], [x, y, z], [x, yTop, z], [x + 1, yTop, z]])
      }
    }
  })

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    depths: new Float32Array(depths),
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
    this.geometry.setIndex(new BufferAttribute(data.indices, 1))
    this.geometry.computeBoundingSphere()
    this.mesh.visible = data.indices.length > 0
    return true
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
