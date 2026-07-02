/**
 * I.vox — MagicaVoxel .vox binary parser. Pure functions over ArrayBuffer,
 * no DOM, no I/O (V2-safe: no randomness, no clocks).
 *
 * Supported: VOX header (version 150/200), MAIN with PACK/SIZE/XYZI/RGBA
 * children, multi-model files, and the nTRN/nGRP/nSHP scene graph with
 * TRANSLATION only. Rotations (_r) and per-frame animation are NOT applied —
 * rotated instances are placed with identity rotation (documented limitation;
 * bake rotations in MagicaVoxel or place props via layout rotation instead).
 * Unknown chunks (MATL, LAYR, rOBJ, ...) are skipped by size.
 *
 * Coordinates: .vox is z-up; consumers convert to our y-up world (see remap.ts).
 */

export interface VoxModel {
  /** model dimensions in .vox axes (z up) */
  sx: number
  sy: number
  sz: number
  /** flat palette-index grid, 0 = empty, index = x + y*sx + z*sx*sy */
  voxels: Uint8Array
  /** number of non-empty voxels */
  count: number
}

export interface VoxInstance {
  modelId: number
  /** accumulated scene-graph translation, .vox axes */
  tx: number
  ty: number
  tz: number
}

export interface VoxFile {
  models: VoxModel[]
  /**
   * palette[colorIndex] = 0xAABBGGRR (as stored: r,g,b,a bytes). Index 0
   * unused (empty voxel). Default MagicaVoxel palette applied when the file
   * has no RGBA chunk is NOT bundled — such files get a flat gray palette.
   */
  palette: Uint32Array
  /** flattened scene-graph placements; one identity instance per model if no graph */
  instances: VoxInstance[]
}

const VOX_MAGIC = 0x20584f56 // 'VOX '

class Reader {
  readonly view: DataView
  pos = 0
  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf)
  }
  u8(): number {
    return this.view.getUint8(this.pos++)
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  str4(): string {
    let s = ''
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8())
    return s
  }
  string(): string {
    const n = this.i32()
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8())
    return s
  }
  dict(): Record<string, string> {
    const n = this.i32()
    const out: Record<string, string> = {}
    for (let i = 0; i < n; i++) {
      const k = this.string()
      out[k] = this.string()
    }
    return out
  }
}

interface TrnNode {
  kind: 'trn'
  child: number
  tx: number
  ty: number
  tz: number
}
interface GrpNode {
  kind: 'grp'
  children: number[]
}
interface ShpNode {
  kind: 'shp'
  modelIds: number[]
}
type SceneNode = TrnNode | GrpNode | ShpNode

export function parseVox(buf: ArrayBuffer): VoxFile {
  const r = new Reader(buf)
  if (buf.byteLength < 8 || r.u32() !== VOX_MAGIC) throw new Error('not a .vox file (bad magic)')
  r.i32() // version (150/200) — layout identical for what we read

  const models: VoxModel[] = []
  let palette: Uint32Array | null = null
  const nodes = new Map<number, SceneNode>()
  let rootTrn: number | null = null
  let pendingSize: { sx: number; sy: number; sz: number } | null = null

  const readChunk = (): void => {
    const id = r.str4()
    const contentBytes = r.i32()
    const childrenBytes = r.i32()
    const contentEnd = r.pos + contentBytes
    const childrenEnd = contentEnd + childrenBytes

    switch (id) {
      case 'MAIN':
        break // content empty; children follow
      case 'PACK':
        r.i32() // numModels — we just collect SIZE/XYZI pairs as they come
        break
      case 'SIZE': {
        pendingSize = { sx: r.i32(), sy: r.i32(), sz: r.i32() }
        break
      }
      case 'XYZI': {
        if (!pendingSize) throw new Error('XYZI without preceding SIZE')
        const { sx, sy, sz } = pendingSize
        pendingSize = null
        const count = r.i32()
        const voxels = new Uint8Array(sx * sy * sz)
        for (let i = 0; i < count; i++) {
          const x = r.u8(), y = r.u8(), z = r.u8(), ci = r.u8()
          if (x < sx && y < sy && z < sz) voxels[x + y * sx + z * sx * sy] = ci
        }
        models.push({ sx, sy, sz, voxels, count })
        break
      }
      case 'RGBA': {
        // file stores colors for palette indices 1..255 in slots 0..254
        palette = new Uint32Array(256)
        for (let i = 0; i < 256; i++) {
          const rgba = r.u32()
          if (i < 255) palette[i + 1] = rgba
        }
        break
      }
      case 'nTRN': {
        const nodeId = r.i32()
        r.dict() // node attributes
        const child = r.i32()
        r.i32() // reserved (-1)
        r.i32() // layer id
        const numFrames = r.i32()
        let tx = 0, ty = 0, tz = 0
        for (let f = 0; f < numFrames; f++) {
          const frame = r.dict()
          if (f === 0 && frame._t) {
            const parts = frame._t.split(' ').map((v) => parseInt(v, 10))
            tx = parts[0] | 0
            ty = parts[1] | 0
            tz = parts[2] | 0
          }
          // frame._r (rotation) intentionally ignored — see module doc
        }
        nodes.set(nodeId, { kind: 'trn', child, tx, ty, tz })
        if (rootTrn === null) rootTrn = nodeId
        break
      }
      case 'nGRP': {
        const nodeId = r.i32()
        r.dict()
        const n = r.i32()
        const children: number[] = []
        for (let i = 0; i < n; i++) children.push(r.i32())
        nodes.set(nodeId, { kind: 'grp', children })
        break
      }
      case 'nSHP': {
        const nodeId = r.i32()
        r.dict()
        const n = r.i32()
        const modelIds: number[] = []
        for (let i = 0; i < n; i++) {
          modelIds.push(r.i32())
          r.dict() // model attributes
        }
        nodes.set(nodeId, { kind: 'shp', modelIds })
        break
      }
      default:
        // unknown chunk — skip content
        break
    }

    r.pos = contentEnd
    while (r.pos < childrenEnd) readChunk()
    r.pos = childrenEnd
  }

  readChunk() // MAIN
  if (models.length === 0) throw new Error('.vox contains no models')

  const pal = palette ?? defaultGrayPalette()

  // flatten scene graph → instances; fall back to identity per model
  const instances: VoxInstance[] = []
  if (rootTrn !== null) {
    const walk = (nodeId: number, tx: number, ty: number, tz: number): void => {
      const node = nodes.get(nodeId)
      if (!node) throw new Error(`.vox scene graph references missing node ${nodeId}`)
      if (node.kind === 'trn') walk(node.child, tx + node.tx, ty + node.ty, tz + node.tz)
      else if (node.kind === 'grp') for (const c of node.children) walk(c, tx, ty, tz)
      else for (const m of node.modelIds) instances.push({ modelId: m, tx, ty, tz })
    }
    walk(rootTrn, 0, 0, 0)
  } else {
    for (let i = 0; i < models.length; i++) instances.push({ modelId: i, tx: 0, ty: 0, tz: 0 })
  }

  return { models, palette: pal, instances }
}

function defaultGrayPalette(): Uint32Array {
  const p = new Uint32Array(256)
  for (let i = 1; i < 256; i++) {
    const v = 0x80
    p[i] = (0xff << 24) | (v << 16) | (v << 8) | v
  }
  return p
}

/** unpack 0xAABBGGRR palette entry → [r, g, b] */
export function paletteRgb(entry: number): [number, number, number] {
  return [entry & 0xff, (entry >>> 8) & 0xff, (entry >>> 16) & 0xff]
}
