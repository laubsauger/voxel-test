import { describe, expect, it } from 'vitest'
import { parseVox, paletteRgb } from '../src/sim/vox/vox'
import { buildRemap, nearestMaterial, toGrid } from '../src/sim/vox/remap'
import { MAT_AIR, MAT_BRICK, MAT_GLASS, MAT_GRASS, MAT_METAL, MAT_WOOD } from '../src/sim/materials'

// ---- fixture builder: write the .vox binary ourselves (no real files) ----

class VoxWriter {
  private bytes: number[] = []
  u8(v: number): this {
    this.bytes.push(v & 0xff)
    return this
  }
  i32(v: number): this {
    return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >> 24)
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    return this
  }
  string(s: string): this {
    this.i32(s.length)
    return this.ascii(s)
  }
  dict(pairs: Record<string, string>): this {
    const keys = Object.keys(pairs)
    this.i32(keys.length)
    for (const k of keys) this.string(k).string(pairs[k])
    return this
  }
  get data(): number[] {
    return this.bytes
  }
}

function chunk(id: string, content: number[], children: number[] = []): number[] {
  const w = new VoxWriter()
  w.ascii(id).i32(content.length).i32(children.length)
  return [...w.data, ...content, ...children]
}

interface FixtureVoxel {
  x: number
  y: number
  z: number
  ci: number
}

function sizeXyzi(sx: number, sy: number, sz: number, voxels: FixtureVoxel[]): number[] {
  const size = new VoxWriter().i32(sx).i32(sy).i32(sz).data
  const xw = new VoxWriter()
  xw.i32(voxels.length)
  for (const v of voxels) xw.u8(v.x).u8(v.y).u8(v.z).u8(v.ci)
  return [...chunk('SIZE', size), ...chunk('XYZI', xw.data)]
}

/** palette chunk: colors[i] is the color for palette index i+1, as [r,g,b,a] */
function rgbaChunk(colors: [number, number, number, number][]): number[] {
  const w = new VoxWriter()
  for (let i = 0; i < 256; i++) {
    const [r, g, b, a] = colors[i] ?? [0, 0, 0, 255]
    w.u8(r).u8(g).u8(b).u8(a)
  }
  return chunk('RGBA', w.data)
}

function voxFile(mainChildren: number[]): ArrayBuffer {
  const w = new VoxWriter()
  w.ascii('VOX ').i32(150)
  const all = [...w.data, ...chunk('MAIN', [], mainChildren)]
  return new Uint8Array(all).buffer
}

// ---- tests ----

describe('.vox parser (I.vox, T18)', () => {
  it('round-trips voxels and palette of a single-model file', () => {
    const voxels: FixtureVoxel[] = [
      { x: 0, y: 0, z: 0, ci: 1 },
      { x: 2, y: 1, z: 0, ci: 2 },
      { x: 3, y: 2, z: 4, ci: 7 },
    ]
    const colors: [number, number, number, number][] = []
    colors[0] = [255, 0, 0, 255] // palette index 1 = red
    colors[1] = [0, 255, 0, 255] // palette index 2 = green
    colors[6] = [10, 20, 30, 255] // palette index 7
    const buf = voxFile([...sizeXyzi(4, 3, 5, voxels), ...rgbaChunk(colors)])

    const f = parseVox(buf)
    expect(f.models).toHaveLength(1)
    const m = f.models[0]
    expect([m.sx, m.sy, m.sz]).toEqual([4, 3, 5])
    expect(m.count).toBe(3)
    for (const v of voxels) {
      expect(m.voxels[v.x + v.y * m.sx + v.z * m.sx * m.sy]).toBe(v.ci)
    }
    // all other cells empty
    expect(m.voxels.reduce((n, c) => n + (c !== 0 ? 1 : 0), 0)).toBe(3)
    expect(paletteRgb(f.palette[1])).toEqual([255, 0, 0])
    expect(paletteRgb(f.palette[2])).toEqual([0, 255, 0])
    expect(paletteRgb(f.palette[7])).toEqual([10, 20, 30])
  })

  it('parses multi-model files with PACK, identity instances without scene graph', () => {
    const buf = voxFile([
      ...chunk('PACK', new VoxWriter().i32(2).data),
      ...sizeXyzi(2, 2, 2, [{ x: 0, y: 0, z: 0, ci: 1 }]),
      ...sizeXyzi(3, 1, 1, [{ x: 2, y: 0, z: 0, ci: 2 }]),
      ...rgbaChunk([]),
    ])
    const f = parseVox(buf)
    expect(f.models).toHaveLength(2)
    expect(f.models[1].voxels[2]).toBe(2)
    expect(f.instances).toEqual([
      { modelId: 0, tx: 0, ty: 0, tz: 0 },
      { modelId: 1, tx: 0, ty: 0, tz: 0 },
    ])
  })

  it('flattens nTRN/nGRP/nSHP scene graph translations', () => {
    // root nTRN(0) → nGRP(1) → [nTRN(2)→nSHP(3, model 0), nTRN(4)→nSHP(5, model 1)]
    const graph = [
      ...chunk('nTRN', new VoxWriter().i32(0).dict({}).i32(1).i32(-1).i32(0).i32(1).dict({}).data),
      ...chunk('nGRP', new VoxWriter().i32(1).dict({}).i32(2).i32(2).i32(4).data),
      ...chunk('nTRN', new VoxWriter().i32(2).dict({}).i32(3).i32(-1).i32(0).i32(1).dict({ _t: '10 20 30' }).data),
      ...chunk('nSHP', new VoxWriter().i32(3).dict({}).i32(1).i32(0).dict({}).data),
      ...chunk('nTRN', new VoxWriter().i32(4).dict({}).i32(5).i32(-1).i32(0).i32(1).dict({ _t: '-5 0 7' }).data),
      ...chunk('nSHP', new VoxWriter().i32(5).dict({}).i32(1).i32(1).dict({}).data),
    ]
    const buf = voxFile([
      ...sizeXyzi(1, 1, 1, [{ x: 0, y: 0, z: 0, ci: 1 }]),
      ...sizeXyzi(1, 1, 1, [{ x: 0, y: 0, z: 0, ci: 2 }]),
      ...rgbaChunk([]),
      ...graph,
    ])
    const f = parseVox(buf)
    expect(f.instances).toEqual([
      { modelId: 0, tx: 10, ty: 20, tz: 30 },
      { modelId: 1, tx: -5, ty: 0, tz: 7 },
    ])
  })

  it('rejects garbage buffers loudly', () => {
    expect(() => parseVox(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow(/magic/)
    expect(() => parseVox(voxFile([...rgbaChunk([])]))).toThrow(/no models/)
  })
})

describe('.vox material remap (T18)', () => {
  it('explicit overrides win, nearest-color fills the rest', () => {
    const colors: [number, number, number, number][] = []
    colors[0] = [166, 82, 55, 255] // exact brick ramp mid (0x9c4a32..0xb05a3c) — T99 rust sits near the old approx value
    colors[1] = [120, 128, 136, 255] // ≈ metal
    colors[2] = [180, 205, 232, 255] // ≈ glass
    const buf = voxFile([...sizeXyzi(1, 1, 1, [{ x: 0, y: 0, z: 0, ci: 1 }]), ...rgbaChunk(colors)])
    const f = parseVox(buf)

    const table = buildRemap(f.palette, { 2: MAT_WOOD })
    expect(table[0]).toBe(MAT_AIR) // empty stays air
    expect(table[1]).toBe(MAT_BRICK) // nearest color
    expect(table[2]).toBe(MAT_WOOD) // override beats nearest (metal)
    expect(table[3]).toBe(MAT_GLASS) // nearest color
  })

  it('nearestMaterial matches exact ramp midpoints and never returns air', () => {
    expect(nearestMaterial(89, 136, 65)).toBe(MAT_GRASS) // grass ramp mid
    expect(nearestMaterial(0, 0, 0)).not.toBe(MAT_AIR) // black still maps to a solid
  })

  it('toGrid converts z-up palette voxels to y-up material voxels', () => {
    // single voxel at vox (1, 2, 3) — z=3 is height → world (x=1, y=3, z=2)
    const colors: [number, number, number, number][] = [[120, 128, 136, 255]] // metal
    const buf = voxFile([...sizeXyzi(2, 3, 4, [{ x: 1, y: 2, z: 3, ci: 1 }]), ...rgbaChunk(colors)])
    const f = parseVox(buf)
    const grid = toGrid(f.models[0], buildRemap(f.palette))
    expect([grid.sx, grid.sy, grid.sz]).toEqual([2, 4, 3])
    expect(grid.mats[1 + 2 * grid.sx + 3 * grid.sx * grid.sz]).toBe(MAT_METAL)
    expect(grid.mats.reduce((n, c) => n + (c !== 0 ? 1 : 0), 0)).toBe(1)
  })
})
