/**
 * I.chunk — sparse voxel chunk store. Part of authoritative sim state.
 * Voxel = 1 byte material id, 0 = air (V5). Chunk 32³.
 * Chunk states: empty | uniform(mat) | dense(Uint8Array 32768).
 *
 * Voxel coords: integer, x∈[0,4096) y∈[0,768) z∈[0,4096). World meters = voxel * 0.1.
 * (B32: expanded to 4096² = ~410×410 m — 4× the T50 area. Memory scales with
 *  surface footprint, not volume: solid/air fills collapse to uniform chunks,
 *  so the cost is the ground band + structures, ~4× the old world.)
 */

export const VOXEL_SIZE = 0.1
export const CHUNK = 32
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK
// B35 — 160 (5120² = ~512 m). Physics colliders + render meshes both STREAM to
// the sim anchors / camera (bounded cost), so the size ceiling is now the
// uncompressed dense-chunk store memory (~1.2 GB here); bigger needs palette compression.
export const WORLD_CX = 160
export const WORLD_CY = 24
export const WORLD_CZ = 160
export const WORLD_VX = WORLD_CX * CHUNK
export const WORLD_VY = WORLD_CY * CHUNK
export const WORLD_VZ = WORLD_CZ * CHUNK
export const CHUNK_COUNT = WORLD_CX * WORLD_CY * WORLD_CZ

export const enum ChunkKind {
  Empty = 0,
  Uniform = 1,
  Dense = 2,
  /**
   * P18 — memory-compressed form of a Dense chunk: a small material palette +
   * bit-packed indices. LOGICALLY still a Dense chunk (it decompresses to the
   * exact same 32768 bytes); the kind exists only so the store knows to inflate
   * on access. Never observed outside ChunkStore — chunkAt() inflates it away,
   * and hash/snapshot read the logical Dense bytes via denseView().
   */
  Palette = 3,
}

export interface Chunk {
  kind: ChunkKind
  /** material for Uniform chunks */
  mat: number
  /** voxel data for Dense chunks, index = x + z*32 + y*1024 */
  data: Uint8Array | null
  /** P18 — Palette chunks: material table (palette index → material id) */
  palette: Uint8Array | null
  /** P18 — Palette chunks: bit-packed palette indices (bits each, dense order) */
  packed: Uint8Array | null
  /** P18 — Palette chunks: bits per packed index (1..7) */
  bits: number
}

/** P18 — max distinct materials we palette-compress; above this the packed
 *  indices (>7 bits) save too little to bother, so the chunk stays Dense. */
const PALETTE_MAX = 128

/** ceil(log2(n)) clamped to a 1-bit minimum */
function bitsFor(n: number): number {
  let b = 1
  while (1 << b < n) b++
  return b
}

/** material id → palette index scratch, reused across compress() calls (-1 = unseen) */
const paletteSlot = new Int16Array(256).fill(-1)

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return cx + cz * WORLD_CX + cy * WORLD_CX * WORLD_CZ
}

export function voxelInChunk(x: number, y: number, z: number): number {
  return (x & 31) + (z & 31) * CHUNK + (y & 31) * CHUNK * CHUNK
}

function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < WORLD_VX && y < WORLD_VY && z < WORLD_VZ
}

export class ChunkStore {
  private readonly chunks: Chunk[] = new Array(CHUNK_COUNT)
  /** chunk indices touched since last drain — consumed by mesher/mirror */
  readonly dirty = new Set<number>()
  /** fine voxel-space AABB of edits since last drainDirty (null = none). Lets a
   *  consumer act on the ACTUAL edited voxels, not the coarse 32³ chunk union. */
  private dLo: [number, number, number] | null = null
  private readonly dHi: [number, number, number] = [0, 0, 0]
  /** P18 — persistent cursor for compactStep's background sweep */
  private compactCursor = 0
  /**
   * Per-voxel mutation hook (set in main.ts wiring): water CA subscribes so
   * settled pools wake when a wall is breached. Runs in-tick — must stay
   * deterministic (V2). Not called by fillBox's uniform-chunk path (scene
   * gen runs before subscribers attach).
   */
  onVoxelChanged: ((x: number, y: number, z: number) => void) | null = null

  constructor() {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      this.chunks[i] = { kind: ChunkKind.Empty, mat: 0, data: null, palette: null, packed: null, bits: 0 }
    }
  }

  /**
   * Chunk view for consumers that need the Dense byte array (mesher, physics,
   * water, snapshot restore). P18: a Palette chunk is inflated back to Dense
   * here, so callers NEVER observe the compressed form — no consumer changed
   * for compression. Consumers stream near the players, so inflation is bounded
   * to that hot set; the cold bulk stays compressed.
   */
  chunkAt(index: number): Chunk {
    const c = this.chunks[index]
    if (c.kind === ChunkKind.Palette) this.inflate(c)
    return c
  }

  /**
   * P18 — raw chunk view that does NOT inflate a compressed chunk. Only the
   * determinism hash and snapshot serialize use this; they read the logical
   * voxels via denseView() so a Palette chunk is byte-for-byte indistinguishable
   * from its Dense form (V3). Do not read .data directly off the result.
   */
  chunkAtRaw(index: number): Chunk {
    return this.chunks[index]
  }

  getVoxel(x: number, y: number, z: number): number {
    if (!inBounds(x, y, z)) return 0
    const c = this.chunks[chunkIndex(x >> 5, y >> 5, z >> 5)]
    switch (c.kind) {
      case ChunkKind.Empty:
        return 0
      case ChunkKind.Uniform:
        return c.mat
      case ChunkKind.Dense:
        return c.data![voxelInChunk(x, y, z)]
      default: {
        // Palette — direct bit-unpack read (cold chunk stays compressed; a
        // scattered read must not inflate the whole thing).
        const vi = voxelInChunk(x, y, z)
        const bitPos = vi * c.bits
        const byteIdx = bitPos >> 3
        const idx = ((c.packed![byteIdx] | (c.packed![byteIdx + 1] << 8)) >>> (bitPos & 7)) & ((1 << c.bits) - 1)
        return c.palette![idx]
      }
    }
  }

  setVoxel(x: number, y: number, z: number, mat: number): void {
    if (!inBounds(x, y, z)) return
    const ci = chunkIndex(x >> 5, y >> 5, z >> 5)
    const c = this.chunks[ci]
    const vi = voxelInChunk(x, y, z)
    if (c.kind === ChunkKind.Palette) this.inflate(c) // P18 — a write makes the chunk hot; go back to flat Dense
    if (c.kind === ChunkKind.Dense) {
      if (c.data![vi] === mat) return
      c.data![vi] = mat
    } else {
      const current = c.kind === ChunkKind.Uniform ? c.mat : 0
      if (current === mat) return
      this.realize(c)
      c.data![vi] = mat
    }
    this.dirty.add(ci)
    if (this.dLo === null) {
      this.dLo = [x, y, z]
      this.dHi[0] = x; this.dHi[1] = y; this.dHi[2] = z
    } else {
      if (x < this.dLo[0]) this.dLo[0] = x
      if (y < this.dLo[1]) this.dLo[1] = y
      if (z < this.dLo[2]) this.dLo[2] = z
      if (x > this.dHi[0]) this.dHi[0] = x
      if (y > this.dHi[1]) this.dHi[1] = y
      if (z > this.dHi[2]) this.dHi[2] = z
    }
    if (this.onVoxelChanged) this.onVoxelChanged(x, y, z)
  }

  /** fine voxel-space AABB of edits since the last drainDirty, or null. Read-only
   *  (does not reset — call before drainDirty, which clears it). */
  peekDirtyBounds(): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null {
    if (this.dLo === null) return null
    return { x0: this.dLo[0], y0: this.dLo[1], z0: this.dLo[2], x1: this.dHi[0], y1: this.dHi[1], z1: this.dHi[2] }
  }

  /** uniform/empty → dense, preserving contents */
  private realize(c: Chunk): void {
    const data = new Uint8Array(CHUNK_VOL)
    if (c.kind === ChunkKind.Uniform) data.fill(c.mat)
    c.kind = ChunkKind.Dense
    c.data = data
    c.mat = 0
  }

  /**
   * P18 — Palette → Dense, rebuilding the exact original 32768 bytes. Lossless
   * by construction (each voxel = palette[index]). Called on any access that
   * needs the flat array (chunkAt, setVoxel).
   */
  private inflate(c: Chunk): void {
    const pal = c.palette!
    const pk = c.packed!
    const bits = c.bits
    const mask = (1 << bits) - 1
    const data = new Uint8Array(CHUNK_VOL)
    for (let i = 0; i < CHUNK_VOL; i++) {
      const bitPos = i * bits
      const byteIdx = bitPos >> 3
      const idx = ((pk[byteIdx] | (pk[byteIdx + 1] << 8)) >>> (bitPos & 7)) & mask
      data[i] = pal[idx]
    }
    c.kind = ChunkKind.Dense
    c.data = data
    c.palette = null
    c.packed = null
    c.bits = 0
    c.mat = 0
  }

  /**
   * P18 — compress a Dense chunk in place to a Palette (memory only). The chunk
   * stays LOGICALLY Dense: inflate() rebuilds byte-identical data, and hash /
   * snapshot read it as Dense via denseView(). So whether this ran does NOT
   * change the determinism hash or serialized bytes (V3) — peers may compress
   * on different schedules and still agree. No-op unless the chunk is Dense with
   * ≤ PALETTE_MAX distinct materials. Returns true if it compressed.
   */
  compress(index: number): boolean {
    const c = this.chunks[index]
    if (c.kind !== ChunkKind.Dense) return false
    const data = c.data!
    const palette = new Uint8Array(PALETTE_MAX)
    let n = 0
    for (let i = 0; i < CHUNK_VOL; i++) {
      const m = data[i]
      if (paletteSlot[m] < 0) {
        if (n >= PALETTE_MAX) {
          for (let k = 0; k < n; k++) paletteSlot[palette[k]] = -1 // reset scratch on bail
          return false
        }
        paletteSlot[m] = n
        palette[n++] = m
      }
    }
    const bits = bitsFor(n)
    const packed = new Uint8Array(((CHUNK_VOL * bits + 7) >> 3) + 1) // +1 pad: 2-byte reads never OOB
    for (let i = 0; i < CHUNK_VOL; i++) {
      const v = paletteSlot[data[i]]
      const bitPos = i * bits
      const byteIdx = bitPos >> 3
      const bitOff = bitPos & 7
      packed[byteIdx] |= (v << bitOff) & 0xff
      packed[byteIdx + 1] |= v >> (8 - bitOff)
    }
    for (let k = 0; k < n; k++) paletteSlot[palette[k]] = -1 // reset scratch for next call
    c.kind = ChunkKind.Palette
    c.palette = palette.slice(0, n) // exact-size copy; drops the PALETTE_MAX temp
    c.packed = packed
    c.bits = bits
    c.data = null
    c.mat = 0
    return true
  }

  /**
   * P18 — logical Dense voxel bytes WITHOUT inflating storage. Dense returns the
   * live array (no copy); Palette unpacks into `scratch` (length CHUNK_VOL) and
   * returns it. Null for empty/uniform. Lets the hash + snapshot scan every
   * chunk while keeping memory flat, and makes their output identical whether or
   * not a chunk is compressed.
   */
  denseView(index: number, scratch: Uint8Array): Uint8Array | null {
    const c = this.chunks[index]
    if (c.kind === ChunkKind.Dense) return c.data!
    if (c.kind !== ChunkKind.Palette) return null
    const pal = c.palette!
    const pk = c.packed!
    const bits = c.bits
    const mask = (1 << bits) - 1
    for (let i = 0; i < CHUNK_VOL; i++) {
      const bitPos = i * bits
      const byteIdx = bitPos >> 3
      scratch[i] = pal[((pk[byteIdx] | (pk[byteIdx + 1] << 8)) >>> (bitPos & 7)) & mask]
    }
    return scratch
  }

  /**
   * P18 — background memory compaction. Compresses up to `maxCompress` Dense
   * chunks to Palette per call, advancing a persistent cursor over the world so
   * repeated calls sweep everything. Skips chunks pending remesh (this.dirty) so
   * a just-edited chunk isn't compressed only to inflate again next frame.
   * Memory-only: logical voxels/hash are unchanged, so this runs OFF the sim
   * tick and its (non-deterministic) schedule cannot cause desync. Returns the
   * approximate bytes reclaimed this call.
   */
  compactStep(maxCompress: number, maxScan: number): number {
    let reclaimed = 0
    let compressed = 0
    let scanned = 0
    let i = this.compactCursor
    while (compressed < maxCompress && scanned < maxScan) {
      const c = this.chunks[i]
      if (c.kind === ChunkKind.Dense && !this.dirty.has(i) && this.compress(i)) {
        compressed++
        reclaimed += CHUNK_VOL - this.chunks[i].packed!.length - this.chunks[i].palette!.length
      }
      scanned++
      if (++i >= CHUNK_COUNT) i = 0
    }
    this.compactCursor = i
    return reclaimed
  }

  /**
   * Fill axis-aligned box [x0..x1]×[y0..y1]×[z0..z1] inclusive.
   * Fully-covered chunks become Uniform (memory stays sparse).
   */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0)
    x1 = Math.min(WORLD_VX - 1, x1); y1 = Math.min(WORLD_VY - 1, y1); z1 = Math.min(WORLD_VZ - 1, z1)
    if (x0 > x1 || y0 > y1 || z0 > z1) return
    for (let cy = y0 >> 5; cy <= y1 >> 5; cy++) {
      for (let cz = z0 >> 5; cz <= z1 >> 5; cz++) {
        for (let cx = x0 >> 5; cx <= x1 >> 5; cx++) {
          const bx0 = cx << 5, by0 = cy << 5, bz0 = cz << 5
          const covered =
            x0 <= bx0 && x1 >= bx0 + 31 &&
            y0 <= by0 && y1 >= by0 + 31 &&
            z0 <= bz0 && z1 >= bz0 + 31
          const ci = chunkIndex(cx, cy, cz)
          if (covered) {
            const c = this.chunks[ci]
            c.kind = mat === 0 ? ChunkKind.Empty : ChunkKind.Uniform
            c.mat = mat === 0 ? 0 : mat
            c.data = null
            c.palette = null // P18 — drop any prior compressed payload
            c.packed = null
            c.bits = 0
            this.dirty.add(ci)
          } else {
            const lx0 = Math.max(x0, bx0), lx1 = Math.min(x1, bx0 + 31)
            const ly0 = Math.max(y0, by0), ly1 = Math.min(y1, by0 + 31)
            const lz0 = Math.max(z0, bz0), lz1 = Math.min(z1, bz0 + 31)
            for (let y = ly0; y <= ly1; y++)
              for (let z = lz0; z <= lz1; z++)
                for (let x = lx0; x <= lx1; x++) this.setVoxel(x, y, z, mat)
          }
        }
      }
    }
  }

  /**
   * Stamp sphere of material (0 = dig) centered at voxel (cx,cy,cz), radius r voxels.
   * Deterministic iteration order.
   */
  stampSphere(cx: number, cy: number, cz: number, r: number, mat: number): void {
    const r2 = r * r
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r)
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r)
    const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r)
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
          if (dx * dx + dy * dy + dz * dz <= r2) this.setVoxel(x, y, z, mat)
        }
      }
    }
  }

  drainDirty(): number[] {
    const out = [...this.dirty].sort((a, b) => a - b)
    this.dirty.clear()
    this.dLo = null // fine-AABB window aligns with the chunk-dirty window
    return out
  }
}
