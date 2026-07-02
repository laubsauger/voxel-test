/**
 * T6 — pure greedy chunk mesher. Render-layer code (V6: read-only view of
 * voxel data, never mutates sim state).
 *
 * No three.js, no Worker, no DOM — unit-testable in vitest; production runs
 * it inside mesh-worker.ts so main-thread frames never stall on meshing (V7).
 *
 * Input: a padded (32+2)³ voxel grid — the chunk plus a 1-voxel shell copied
 * from neighbor chunks — so boundary faces (and later AO) resolve without
 * touching the ChunkStore from the worker.
 *
 * Output: indexed quads. Positions in voxel units, [0..32] per axis; the
 * mesh manager scales by VOXEL_SIZE and offsets by the chunk origin.
 * Greedy rule: coplanar faces merge into maximal rectangles only when their
 * merge key (material id) matches.
 */
import { CHUNK } from '../world/chunks'

export const PAD = CHUNK + 2
const PAD2 = PAD * PAD

/** index into the padded grid; x/y/z ∈ [-1, 32] */
export function paddedIndex(x: number, y: number, z: number): number {
  return x + 1 + (z + 1) * PAD + (y + 1) * PAD2
}

/** padded-index stride for +1 step along axis 0=x, 1=y, 2=z */
const STRIDE = [1, PAD2, PAD] as const

export type VoxelSampler = (x: number, y: number, z: number) => number

/**
 * Gather chunk (cx,cy,cz) plus 1-voxel neighbor shell into a padded grid.
 * `sample` takes world voxel coords (ChunkStore.getVoxel returns 0 out of
 * bounds, which is exactly what boundary faces need).
 */
export function buildPaddedChunk(sample: VoxelSampler, cx: number, cy: number, cz: number): Uint8Array {
  const out = new Uint8Array(PAD * PAD * PAD)
  const bx = cx * CHUNK
  const by = cy * CHUNK
  const bz = cz * CHUNK
  let i = 0
  for (let y = -1; y <= CHUNK; y++) {
    for (let z = -1; z <= CHUNK; z++) {
      for (let x = -1; x <= CHUNK; x++) {
        out[i++] = sample(bx + x, by + y, bz + z)
      }
    }
  }
  return out
}

export interface ChunkMesh {
  /** vec3 per vertex, voxel units [0..32] */
  positions: Float32Array
  /** vec3 per vertex, axis-aligned unit normals */
  normals: Float32Array
  /** vec2 per vertex, quad-local, scaled by quad size (tiles textures) */
  uvs: Float32Array
  /** float per vertex, material id */
  materials: Float32Array
  /** float per vertex, AO level 0 (dark) .. 3 (open) */
  ao: Float32Array
  indices: Uint32Array
  quadCount: number
}

/**
 * Greedy-mesh one padded chunk. Faces are emitted where a solid voxel meets
 * air (material 0); same-material coplanar faces merge into maximal rects.
 */
export function meshChunk(padded: Uint8Array): ChunkMesh {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const materials: number[] = []
  const ao: number[] = []
  const indices: number[] = []
  let quadCount = 0

  const mask = new Int32Array(CHUNK * CHUNK)
  const pos = [0, 0, 0]
  const scratch = [0, 0, 0]

  const emitQuad = (
    axis: number,
    u: number,
    v: number,
    sign: number,
    plane: number,
    a: number,
    b: number,
    w: number,
    h: number,
    key: number,
  ): void => {
    const mat = key & 0xff
    const base = quadCount * 4
    // corners in (u,v): c00=(a,b) c10=(a+w,b) c11=(a+w,b+h) c01=(a,b+h)
    for (const [ua, vb] of [[a, b], [a + w, b], [a + w, b + h], [a, b + h]]) {
      scratch[axis] = plane
      scratch[u] = ua
      scratch[v] = vb
      positions.push(scratch[0], scratch[1], scratch[2])
      scratch[0] = scratch[1] = scratch[2] = 0
      scratch[axis] = sign
      normals.push(scratch[0], scratch[1], scratch[2])
      materials.push(mat)
      ao.push(3)
    }
    uvs.push(0, 0, w, 0, w, h, 0, h)
    // e_u × e_v = e_axis (cyclic axes) ⇒ c00→c10→c11 is CCW around +axis
    if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    quadCount++
  }

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    const sa = STRIDE[axis]
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1
      for (let s = 0; s < CHUNK; s++) {
        // build the face mask for this slice
        let hasFaces = false
        for (let b = 0; b < CHUNK; b++) {
          for (let a = 0; a < CHUNK; a++) {
            pos[axis] = s
            pos[u] = a
            pos[v] = b
            const pi = paddedIndex(pos[0], pos[1], pos[2])
            const m = padded[pi]
            let key = 0
            if (m !== 0 && padded[pi + sign * sa] === 0) {
              key = m
              hasFaces = true
            }
            mask[a + b * CHUNK] = key
          }
        }
        if (!hasFaces) continue

        // greedy rectangle merge over the mask
        const plane = sign > 0 ? s + 1 : s
        for (let b = 0; b < CHUNK; b++) {
          for (let a = 0; a < CHUNK; ) {
            const key = mask[a + b * CHUNK]
            if (key === 0) {
              a++
              continue
            }
            let w = 1
            while (a + w < CHUNK && mask[a + w + b * CHUNK] === key) w++
            let h = 1
            scan: while (b + h < CHUNK) {
              for (let i = 0; i < w; i++) {
                if (mask[a + i + (b + h) * CHUNK] !== key) break scan
              }
              h++
            }
            emitQuad(axis, u, v, sign, plane, a, b, w, h, key)
            for (let j = 0; j < h; j++) {
              for (let i = 0; i < w; i++) mask[a + i + (b + j) * CHUNK] = 0
            }
            a += w
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    materials: new Float32Array(materials),
    ao: new Float32Array(ao),
    indices: new Uint32Array(indices),
    quadCount,
  }
}
