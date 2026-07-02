/**
 * Greedy box merging over a small dense voxel grid (T10/T12).
 * Deterministic: scan order y→z→x, growth order x→z→y (V2).
 * Used to build Jolt colliders: chunk static bodies and island compounds.
 *
 * Grid layout matches ChunkStore dense chunks: index = x + z*sx + y*sx*sz.
 * Nonzero byte = solid.
 */

export interface Box {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
}

export function greedyBoxes(grid: Uint8Array, sx: number, sy: number, sz: number): Box[] {
  if (grid.length !== sx * sy * sz) {
    throw new Error(`greedyBoxes: grid length ${grid.length} != ${sx}*${sy}*${sz}`)
  }
  const used = new Uint8Array(grid.length)
  const idx = (x: number, y: number, z: number) => x + z * sx + y * sx * sz
  const solid = (x: number, y: number, z: number) => grid[idx(x, y, z)] !== 0 && used[idx(x, y, z)] === 0
  const boxes: Box[] = []

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (!solid(x, y, z)) continue
        // grow along +x
        let ex = x + 1
        while (ex < sx && solid(ex, y, z)) ex++
        // grow along +z: whole row [x,ex) must be solid+unused
        let ez = z + 1
        grow_z: while (ez < sz) {
          for (let ix = x; ix < ex; ix++) if (!solid(ix, y, ez)) break grow_z
          ez++
        }
        // grow along +y: whole slab [x,ex)×[z,ez) must be solid+unused
        let ey = y + 1
        grow_y: while (ey < sy) {
          for (let iz = z; iz < ez; iz++)
            for (let ix = x; ix < ex; ix++) if (!solid(ix, ey, iz)) break grow_y
          ey++
        }
        for (let iy = y; iy < ey; iy++)
          for (let iz = z; iz < ez; iz++)
            for (let ix = x; ix < ex; ix++) used[idx(ix, iy, iz)] = 1
        boxes.push({ x, y, z, sx: ex - x, sy: ey - y, sz: ez - z })
      }
    }
  }
  return boxes
}
