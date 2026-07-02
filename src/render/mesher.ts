/**
 * T6/T7 — pure greedy chunk mesher with per-vertex voxel AO. Render-layer
 * code (V6: read-only view of voxel data, never mutates sim state).
 *
 * No three.js, no Worker, no DOM — unit-testable in vitest; production runs
 * it inside mesh-worker.ts so main-thread frames never stall on meshing (V7).
 *
 * Input: a padded (32+2)³ voxel grid — the chunk plus a 1-voxel shell copied
 * from neighbor chunks — so boundary faces and boundary AO resolve without
 * touching the ChunkStore from the worker.
 *
 * Output (T39): TWO indexed quad streams — opaque and transparent (glass,
 * water-solid marker; I.mat Transparent flag, derived from the canonical
 * sim table per V13). Face rules at a voxel boundary:
 *   opaque      vs air/transparent → opaque face emitted (no cull — B5)
 *   transparent vs air             → transparent face emitted
 *   transparent vs SAME material   → culled (interior of a glass pane)
 *   transparent vs OTHER transparent → both sides emit (glass|water seam)
 *   transparent vs opaque          → nothing (the opaque side owns the face)
 * Positions in voxel units, [0..32] per axis; the mesh manager scales by
 * VOXEL_SIZE and offsets by the chunk origin.
 *
 * AO (T7): classic corner trick — per quad vertex, the 2 side + 1 corner
 * neighbors in the face's air layer give 4 levels, 0 (dark) .. 3 (open),
 * baked into a vertex attribute. Transparent voxels count as occluders
 * (cheap, and glass against a wall does read slightly seated).
 *
 * Greedy rule: coplanar faces merge into maximal rectangles only when their
 * merge key (material id AND the 4 packed AO levels) matches — merging
 * across differing AO would smear the corner darkening. Material id in the
 * key also keeps opaque/transparent quads in their own streams.
 */
import { CHUNK } from '../world/chunks'
import { MATERIALS, MAT_FLAG_TRANSPARENT } from '../sim/materials'

/** voxel id → 1 if I.mat Transparent flag set (V13: derived, never redefined) */
const TRANSPARENT = new Uint8Array(256)
for (const m of MATERIALS) {
  if (m && (m.flags & MAT_FLAG_TRANSPARENT) !== 0) TRANSPARENT[m.id] = 1
}

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

/**
 * AO level for one quad corner (T7). `nb` is the padded index of the air
 * voxel the face looks into; du/dv are padded-index strides toward the
 * corner along the face's two tangent axes.
 * Both sides solid ⇒ fully pinched corner ⇒ 0, else 3 − occupied neighbors.
 */
function aoCorner(padded: Uint8Array, nb: number, du: number, dv: number): number {
  const s1 = padded[nb + du] !== 0 ? 1 : 0
  const s2 = padded[nb + dv] !== 0 ? 1 : 0
  if (s1 !== 0 && s2 !== 0) return 0
  const c = padded[nb + du + dv] !== 0 ? 1 : 0
  return 3 - (s1 + s2 + c)
}

/** one geometry stream (opaque or transparent) of a meshed chunk */
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

/** T39 — meshChunk output: separate opaque + transparent geometry streams */
export interface ChunkMeshStreams {
  opaque: ChunkMesh
  transparent: ChunkMesh
}

/** growable quad-soup accumulator for one stream */
class StreamBuilder {
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

/**
 * Greedy-mesh one padded chunk into opaque + transparent streams (T39).
 * Same-material coplanar faces merge into maximal rects per stream.
 */
export function meshChunk(padded: Uint8Array): ChunkMeshStreams {
  const streams = [new StreamBuilder(), new StreamBuilder()] // [opaque, transparent]

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
    const aoPack = key >>> 8
    const ao00 = aoPack & 3
    const ao10 = (aoPack >>> 2) & 3
    const ao11 = (aoPack >>> 4) & 3
    const ao01 = (aoPack >>> 6) & 3
    const s = streams[TRANSPARENT[mat]]
    const base = s.quadCount * 4
    // corners in (u,v): c00=(a,b) c10=(a+w,b) c11=(a+w,b+h) c01=(a,b+h)
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
    s.ao.push(ao00, ao10, ao11, ao01)
    s.uvs.push(0, 0, w, 0, w, h, 0, h)
    // e_u × e_v = e_axis (cyclic axes) ⇒ c00→c10→c11 is CCW around +axis.
    // Flip the diagonal when AO would interpolate across the wrong pair
    // (standard anisotropy fix for the corner trick).
    const flip = ao00 + ao11 > ao10 + ao01
    if (sign > 0) {
      if (flip) s.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base)
      else s.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    } else {
      if (flip) s.indices.push(base + 1, base + 3, base + 2, base + 1, base, base + 3)
      else s.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
    s.quadCount++
  }

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    const sa = STRIDE[axis]
    const su = STRIDE[u]
    const sv = STRIDE[v]
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
            if (m !== 0) {
              const nb = pi + sign * sa
              const n = padded[nb]
              // T39 visibility rules (see header): opaque shows against air
              // or any transparent neighbor; transparent shows against air
              // or a DIFFERENT transparent material, never against opaque
              // (the opaque side owns that face) or itself (interior cull).
              const visible =
                TRANSPARENT[m] === 0
                  ? n === 0 || TRANSPARENT[n] === 1
                  : n === 0 || (TRANSPARENT[n] === 1 && n !== m)
              if (visible) {
                // 4 corner AO levels packed 2 bits each (T7); part of the
                // merge key so differing AO never merges (no smearing)
                const aoPack =
                  aoCorner(padded, nb, -su, -sv) |
                  (aoCorner(padded, nb, su, -sv) << 2) |
                  (aoCorner(padded, nb, su, sv) << 4) |
                  (aoCorner(padded, nb, -su, sv) << 6)
                key = m | (aoPack << 8)
                hasFaces = true
              }
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

  return { opaque: streams[0].build(), transparent: streams[1].build() }
}
