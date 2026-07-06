/**
 * B37 — coarse LOD mesher. Greedy-meshes an arbitrary sx×sy×sz voxel grid into
 * a single opaque + transparent stream, with NO ambient occlusion and NO
 * neighbour padding (air is assumed outside the grid). Used for distant LOD
 * cells: a large world region is DOWNSAMPLED (one representative voxel per S³
 * block) into a small grid, meshed here, then scaled back up by S·VOXEL_SIZE.
 *
 * The point is OBJECT-COUNT reduction, not just triangles: the game frame is
 * CPU-bound on three.js iterating ~800 near region meshes across the main pass
 * + shadow cascades. Replacing the far field's many full-detail region meshes
 * with a handful of coarse cell meshes cuts the per-frame object work sharply.
 *
 * Output positions are in DOWNSAMPLED-grid units [0..sx]; the caller scales by
 * the downsample stride × VOXEL_SIZE and offsets to the cell's world origin.
 * Reuses the ChunkMesh stream shape (mesher.ts) so region-mesh building and the
 * chunk material's attributes (mat/ao) apply unchanged — ao is filled with 3
 * (fully open) since coarse distant geometry needs no corner darkening.
 */
import { MATERIALS, MAT_FLAG_TRANSPARENT } from '../sim/materials'
import type { ChunkMesh, ChunkMeshStreams } from './mesher'

const TRANSPARENT = new Uint8Array(256)
for (const m of MATERIALS) {
  if (m && (m.flags & MAT_FLAG_TRANSPARENT) !== 0) TRANSPARENT[m.id] = 1
}

class Builder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  materials: number[] = []
  ao: number[] = []
  indices: number[] = []
  quadCount = 0
  build(): ChunkMesh {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      materials: new Float32Array(this.materials),
      ao: new Float32Array(this.ao),
      indices: new Uint32Array(this.indices),
      quadCount: this.quadCount,
    }
  }
}

/** greedy-mesh an sx×sy×sz grid (index = x + z*sx + y*sx*sz), air = 0 outside */
export function meshCoarse(grid: Uint8Array, sx: number, sy: number, sz: number): ChunkMeshStreams {
  const dim = [sx, sy, sz]
  const strideAxis = [1, sx * sz, sx] // +1 step along x / y / z in the grid index
  const streams = [new Builder(), new Builder()] // [opaque, transparent]
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : grid[x + z * sx + y * sx * sz]

  const pos = [0, 0, 0]
  const scratch = [0, 0, 0]
  const emit = (axis: number, u: number, v: number, sign: number, plane: number, a: number, b: number, w: number, h: number, mat: number): void => {
    const s = streams[TRANSPARENT[mat]]
    const base = s.quadCount * 4
    for (const [ua, vb] of [[a, b], [a + w, b], [a + w, b + h], [a, b + h]]) {
      scratch[axis] = plane
      scratch[u] = ua
      scratch[v] = vb
      s.positions.push(scratch[0], scratch[1], scratch[2])
      scratch[0] = scratch[1] = scratch[2] = 0
      scratch[axis] = sign
      s.normals.push(scratch[0], scratch[1], scratch[2])
      s.materials.push(mat)
    }
    s.ao.push(3, 3, 3, 3) // coarse: no occlusion darkening
    s.uvs.push(0, 0, w, 0, w, h, 0, h)
    if (sign > 0) s.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else s.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    s.quadCount++
  }

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    const du = dim[u]
    const dv = dim[v]
    const mask = new Int32Array(du * dv)
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1
      for (let sl = 0; sl < dim[axis]; sl++) {
        let has = false
        for (let b = 0; b < dv; b++) {
          for (let a = 0; a < du; a++) {
            pos[axis] = sl
            pos[u] = a
            pos[v] = b
            const m = at(pos[0], pos[1], pos[2])
            let key = 0
            if (m !== 0) {
              pos[axis] = sl + sign
              const n = at(pos[0], pos[1], pos[2])
              pos[axis] = sl
              const visible = TRANSPARENT[m] === 0 ? n === 0 || TRANSPARENT[n] === 1 : n === 0 || (TRANSPARENT[n] === 1 && n !== m)
              if (visible) { key = m; has = true }
            }
            mask[a + b * du] = key
          }
        }
        if (!has) continue
        const plane = sign > 0 ? sl + 1 : sl
        for (let b = 0; b < dv; b++) {
          for (let a = 0; a < du; ) {
            const key = mask[a + b * du]
            if (key === 0) { a++; continue }
            let w = 1
            while (a + w < du && mask[a + w + b * du] === key) w++
            let h = 1
            scan: while (b + h < dv) {
              for (let i = 0; i < w; i++) if (mask[a + i + (b + h) * du] !== key) break scan
              h++
            }
            emit(axis, u, v, sign, plane, a, b, w, h, key)
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mask[a + i + (b + j) * du] = 0
            a += w
          }
        }
      }
    }
  }
  void strideAxis
  return { opaque: streams[0].build(), transparent: streams[1].build() }
}
