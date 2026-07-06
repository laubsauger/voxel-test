/**
 * T79 — example level built from the game's voxel system. Small hand-authored
 * voxel clusters (a ground slab + 3-5 houses), meshed with the game's coarse
 * greedy mesher (meshCoarse) for visuals and returned as raw grids so T80 can
 * derive Box3D static colliders from the SAME voxels (visual/physics parity).
 *
 * Grid index convention MATCHES meshCoarse: idx(x,y,z) = x + z*sx + y*sx*sz
 * (y is up / outer). A cluster's `origin` is the world-metre position of the
 * lower corner of voxel (0,0,0); voxel v world-center = origin + (v+0.5)*VOXEL_SIZE.
 */
import { Mesh, Group, BufferGeometry, BufferAttribute, MeshStandardMaterial } from 'three/webgpu'
import { meshCoarse } from '../render/mesh-coarse'
import type { ChunkMesh } from '../render/mesher'
import {
  MATERIALS,
  MAT_AIR,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_ROOFTILE,
  MAT_GLASS,
  MAT_GRASS,
  MAT_WOOD,
  MAT_METAL,
  MAT_FLAG_TRANSPARENT,
} from '../sim/materials'
import { VOXEL_SIZE } from '../world/chunks'
import type { Vec3 } from './box3d-bridge'

export interface VoxelCluster {
  grid: Uint8Array
  sx: number
  sy: number
  sz: number
  /** world-metre position of voxel (0,0,0)'s lower corner */
  origin: Vec3
  label: string
}

const idx = (x: number, y: number, z: number, sx: number, sz: number): number => x + z * sx + y * sx * sz

/** solid voxel count — reported by T83 (drives per-voxel collider count) */
export function solidCount(c: VoxelCluster): number {
  let n = 0
  for (let i = 0; i < c.grid.length; i++) if (c.grid[i] !== MAT_AIR) n++
  return n
}

/** flat ground slab: sx×sz footprint, `thick` voxels of grass */
function buildGround(sx: number, sz: number, thick: number): Uint8Array {
  const grid = new Uint8Array(sx * thick * sz)
  for (let y = 0; y < thick; y++)
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) grid[idx(x, y, z, sx, sz)] = MAT_GRASS
  return grid
}

/**
 * a simple box house: brick perimeter walls (1 voxel thick), concrete floor,
 * rooftile slab lid, a door gap on -Z wall, glass windows on the other walls.
 * w/h/d in voxels.
 */
function buildHouse(w: number, h: number, d: number): Uint8Array {
  const grid = new Uint8Array(w * h * d)
  const set = (x: number, y: number, z: number, m: number): void => {
    grid[idx(x, y, z, w, d)] = m
  }
  for (let z = 0; z < d; z++)
    for (let x = 0; x < w; x++) {
      set(x, 0, z, MAT_CONCRETE) // floor
      set(x, h - 1, z, MAT_ROOFTILE) // roof lid
    }
  for (let y = 1; y < h - 1; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const edge = x === 0 || x === w - 1 || z === 0 || z === d - 1
        if (!edge) continue
        // windows: mid-height band, skip corners
        const window = y >= 2 && y <= h - 3 && x > 1 && x < w - 2 && z > 1 && z < d - 2
        set(x, y, z, window ? MAT_GLASS : MAT_BRICK)
      }
  // door gap on -Z wall (z=0), centered, 2 wide up to h/2
  const dcx = Math.floor(w / 2)
  for (let y = 1; y < Math.min(4, h - 1); y++) {
    set(dcx, y, 0, MAT_AIR)
    set(dcx - 1, y, 0, MAT_AIR)
  }
  // a wooden door frame lintel
  set(dcx, Math.min(4, h - 1), 0, MAT_WOOD)
  set(dcx - 1, Math.min(4, h - 1), 0, MAT_WOOD)
  return grid
}

const TRANSPARENT = new Uint8Array(256)
for (const m of MATERIALS) if (m && (m.flags & MAT_FLAG_TRANSPARENT) !== 0) TRANSPARENT[m.id] = 1

/** build a three.js Mesh for one coarse stream, colored per-material (vertexColors) */
function streamToMesh(m: ChunkMesh, origin: Vec3, transparent: boolean): Mesh | null {
  if (m.quadCount === 0) return null
  const geo = new BufferGeometry()
  const vcount = m.positions.length / 3
  // scale grid-unit positions to metres and offset to world origin
  const pos = new Float32Array(m.positions.length)
  for (let i = 0; i < vcount; i++) {
    pos[i * 3] = m.positions[i * 3] * VOXEL_SIZE + origin.x
    pos[i * 3 + 1] = m.positions[i * 3 + 1] * VOXEL_SIZE + origin.y
    pos[i * 3 + 2] = m.positions[i * 3 + 2] * VOXEL_SIZE + origin.z
  }
  // per-vertex color from material colorRamp[0], darkened by AO (0..3)
  const col = new Float32Array(vcount * 3)
  for (let i = 0; i < vcount; i++) {
    const mat = MATERIALS[m.materials[i] | 0]
    const rgb = mat ? mat.colorRamp[0] : 0xffffff
    const shade = 0.5 + 0.5 * (m.ao[i] / 3)
    col[i * 3] = (((rgb >> 16) & 0xff) / 255) * shade
    col[i * 3 + 1] = (((rgb >> 8) & 0xff) / 255) * shade
    col[i * 3 + 2] = ((rgb & 0xff) / 255) * shade
  }
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('normal', new BufferAttribute(m.normals, 3))
  geo.setAttribute('color', new BufferAttribute(col, 3))
  geo.setIndex(new BufferAttribute(m.indices, 1))
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: transparent ? 0.15 : 0.85,
    metalness: 0,
    transparent,
    opacity: transparent ? 0.4 : 1,
  })
  const mesh = new Mesh(geo, material)
  mesh.castShadow = !transparent
  mesh.receiveShadow = true
  return mesh
}

/** render a cluster (opaque + transparent streams) into a Group */
export function clusterToGroup(c: VoxelCluster): Group {
  const g = new Group()
  const streams = meshCoarse(c.grid, c.sx, c.sy, c.sz)
  const opaque = streamToMesh(streams.opaque, c.origin, false)
  const glass = streamToMesh(streams.transparent, c.origin, true)
  if (opaque) g.add(opaque)
  if (glass) g.add(glass)
  return g
}

/** solid rectangular block of one material — freestanding wall / perimeter */
function buildSolidBlock(w: number, h: number, d: number, mat: number): Uint8Array {
  const grid = new Uint8Array(w * h * d)
  grid.fill(mat)
  return grid
}

/**
 * hollow tower shell (highrise): concrete perimeter walls `wall` voxels thick,
 * a concrete floor slab every `storey` voxels, glass window band per storey.
 * Hollow interior keeps the voxel count down and makes collapse dramatic.
 */
function buildTower(w: number, h: number, d: number, wall: number, storey: number): Uint8Array {
  const grid = new Uint8Array(w * h * d)
  const set = (x: number, y: number, z: number, m: number): void => {
    grid[idx(x, y, z, w, d)] = m
  }
  for (let y = 0; y < h; y++) {
    const floor = y % storey === 0 || y === h - 1
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const inWall = x < wall || x >= w - wall || z < wall || z >= d - wall
        if (floor) set(x, y, z, MAT_CONCRETE)
        else if (inWall) {
          const band = y % storey >= 3 && y % storey <= storey - 3
          const midX = x > wall + 1 && x < w - wall - 2
          const midZ = z > wall + 1 && z < d - wall - 2
          set(x, y, z, band && (midX || midZ) ? MAT_GLASS : MAT_CONCRETE)
        }
      }
  }
  return grid
}

/**
 * the test level (T79 + T84). A large 24×24 m arena (ground + perimeter walls so
 * debris stays contained), 5 static voxel houses clustered in one quadrant, and
 * an open plaza holding the destructible freestanding brick wall + highrise tower.
 * Fixed layout = repeatable CDP captures (determinism not required, V14).
 */
export function buildTestLevel(): { statics: VoxelCluster[]; destructibles: VoxelCluster[] } {
  const statics: VoxelCluster[] = []
  const destructibles: VoxelCluster[] = []

  // arena ground: 240×240 voxels (24×24 m), 2 thick, centered at origin
  const GS = 240
  const GT = 2
  const half = (GS * VOXEL_SIZE) / 2 // 12 m
  statics.push({
    grid: buildGround(GS, GS, GT),
    sx: GS,
    sy: GT,
    sz: GS,
    origin: { x: -half, y: 0, z: -half },
    label: 'ground',
  })
  const groundTop = GT * VOXEL_SIZE

  // perimeter walls (concrete): 20 tall (2 m), 3 thick — bumpers so bodies don't
  // fall off. A solid slab greedy-merges to ~1 collider each (cheap).
  const WH = 20
  const WT = 3
  const perim: Array<{ w: number; d: number; x: number; z: number; label: string }> = [
    { w: GS, d: WT, x: -half, z: -half, label: 'perim-n' },
    { w: GS, d: WT, x: -half, z: half - WT * VOXEL_SIZE, label: 'perim-s' },
    { w: WT, d: GS, x: -half, z: -half, label: 'perim-w' },
    { w: WT, d: GS, x: half - WT * VOXEL_SIZE, z: -half, label: 'perim-e' },
  ]
  for (const p of perim)
    statics.push({
      grid: buildSolidBlock(p.w, WH, p.d, MAT_METAL),
      sx: p.w,
      sy: WH,
      sz: p.d,
      origin: { x: p.x, y: groundTop, z: p.z },
      label: p.label,
    })

  // 5 houses clustered in the -X/-Z quadrant, leaving the +X plaza clear
  const houses: Array<{ w: number; h: number; d: number; x: number; z: number }> = [
    { w: 20, h: 16, d: 20, x: -8.5, z: -8.5 },
    { w: 16, h: 14, d: 24, x: -5.6, z: -8.2 },
    { w: 24, h: 18, d: 16, x: -8.8, z: -5.4 },
    { w: 18, h: 12, d: 18, x: -5.2, z: -5.2 },
    { w: 14, h: 20, d: 14, x: -7.0, z: -3.0 },
  ]
  houses.forEach((s, i) => {
    statics.push({
      grid: buildHouse(s.w, s.h, s.d),
      sx: s.w,
      sy: s.h,
      sz: s.d,
      origin: { x: s.x, y: groundTop, z: s.z },
      label: `house${i}`,
    })
  })

  // --- destructibles (T84), in the open +X plaza ------------------------------
  // freestanding brick wall: 40 wide × 26 tall × 4 thick (4×2.6×0.4 m)
  destructibles.push({
    grid: buildSolidBlock(40, 26, 4, MAT_BRICK),
    sx: 40,
    sy: 26,
    sz: 4,
    origin: { x: 1.5, y: groundTop, z: -5.0 },
    label: 'wall',
  })
  // highrise tower: hollow concrete shell 20×56×20, 2-thick walls, storey=12
  destructibles.push({
    grid: buildTower(20, 56, 20, 2, 12),
    sx: 20,
    sy: 56,
    sz: 20,
    origin: { x: 5.0, y: groundTop, z: 4.0 },
    label: 'tower',
  })

  return { statics, destructibles }
}
