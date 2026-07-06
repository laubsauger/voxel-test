/**
 * T84 — destructible voxel structure on Box3D, built on the game's voxel engine
 * (greedyBoxes colliders + meshCoarse visuals). Starts as static voxel colliders;
 * an impulse (explosion / projectile impact / crash) within a radius:
 *   1. removes the hit voxels from the grid,
 *   2. support-floods the remainder from its ground row — voxels no longer
 *      connected to the base are "unsupported" and also freed (undermined →
 *      collapse, a cheap stand-in for the game's T55/T56 connectivity solver),
 *   3. respawns every freed voxel region as greedy-merged DYNAMIC debris bodies
 *      (1 mesh each, V15) with a radial impulse from the blast,
 *   4. re-greedies + remeshes the surviving voxels.
 *
 * This is deliberately NOT the full game structural sim — it is the spike proof
 * that voxel destruction + debris + collapse ride cleanly on Box3D. Grid index
 * convention matches meshCoarse/greedyBoxes: idx = x + z*sx + y*sx*sz.
 */
import { Group, type Scene } from 'three/webgpu'
import type { B3Body } from 'box3d-wasm/standard'
import { greedyBoxes } from '../sim/greedy-boxes'
import { MAT_AIR, MATERIALS } from '../sim/materials'
import { VOXEL_SIZE } from '../world/chunks'
import { clusterToGroup, type VoxelCluster } from './houses'
import { spawnDynamic, type SpawnCtx } from './spawner'
import type { SpikeWorld, Vec3 } from './box3d-bridge'

const H = VOXEL_SIZE / 2

export class Destructible {
  private grid: Uint8Array
  readonly sx: number
  readonly sy: number
  readonly sz: number
  readonly origin: Vec3
  readonly label: string
  private statics: B3Body[] = []
  private group: Group | null = null

  constructor(
    cluster: VoxelCluster,
    private readonly phys: SpikeWorld,
    private readonly scene: Scene,
  ) {
    this.grid = cluster.grid.slice() // own mutable copy
    this.sx = cluster.sx
    this.sy = cluster.sy
    this.sz = cluster.sz
    this.origin = cluster.origin
    this.label = cluster.label
    this.rebuild()
  }

  private idx(x: number, y: number, z: number): number {
    return x + z * this.sx + y * this.sx * this.sz
  }

  colliderCount(): number {
    return this.statics.length
  }

  setVisible(v: boolean): void {
    if (this.group) this.group.visible = v
  }

  /** greedy-merge current voxels into static colliders + remesh the visual */
  private rebuild(): void {
    for (const b of this.statics) this.phys.removeStaticBox(b)
    this.statics = []
    const boxes = greedyBoxes(this.grid, this.sx, this.sy, this.sz)
    for (const b of boxes) {
      const body = this.phys.addStaticBox(
        {
          x: this.origin.x + (b.x + b.sx / 2) * VOXEL_SIZE,
          y: this.origin.y + (b.y + b.sy / 2) * VOXEL_SIZE,
          z: this.origin.z + (b.z + b.sz / 2) * VOXEL_SIZE,
        },
        { x: b.sx * H, y: b.sy * H, z: b.sz * H },
      )
      this.statics.push(body)
    }
    if (this.group) {
      this.scene.remove(this.group)
      this.group.traverse((o) => {
        const mesh = o as { geometry?: { dispose(): void } }
        mesh.geometry?.dispose()
      })
    }
    this.group = clusterToGroup({
      grid: this.grid,
      sx: this.sx,
      sy: this.sy,
      sz: this.sz,
      origin: this.origin,
      label: this.label,
    })
    this.scene.add(this.group)
  }

  /** solid voxels not 6-connected to the base row (y=0) after a blast */
  private floodUnsupported(): number[] {
    const n = this.grid.length
    const reached = new Uint8Array(n)
    const stack: number[] = []
    const { sx, sy, sz } = this
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const i = this.idx(x, 0, z)
        if (this.grid[i] !== MAT_AIR) {
          reached[i] = 1
          stack.push(i)
        }
      }
    while (stack.length) {
      const i = stack.pop()!
      const y = Math.floor(i / (sx * sz))
      const rem = i - y * sx * sz
      const z = Math.floor(rem / sx)
      const x = rem - z * sx
      const push = (nx: number, ny: number, nz: number): void => {
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) return
        const j = this.idx(nx, ny, nz)
        if (this.grid[j] !== MAT_AIR && !reached[j]) {
          reached[j] = 1
          stack.push(j)
        }
      }
      push(x + 1, y, z)
      push(x - 1, y, z)
      push(x, y + 1, z)
      push(x, y - 1, z)
      push(x, y, z + 1)
      push(x, y, z - 1)
    }
    const un: number[] = []
    for (let i = 0; i < n; i++) if (this.grid[i] !== MAT_AIR && !reached[i]) un.push(i)
    return un
  }

  /**
   * fracture: free voxels within `radius` of world point `p`, plus any remnant
   * left unsupported, and respawn them as dynamic debris with a radial impulse
   * (`strength`). Returns the debris-body count. No-op if nothing is in range.
   */
  explodeAt(p: Vec3, radius: number, strength: number, ctx: SpawnCtx): number {
    const mats = new Map<number, number>() // freed idx → material
    const r2 = radius * radius
    const { sx, sy, sz } = this
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const i = this.idx(x, y, z)
          if (this.grid[i] === MAT_AIR) continue
          const cx = this.origin.x + (x + 0.5) * VOXEL_SIZE
          const cy = this.origin.y + (y + 0.5) * VOXEL_SIZE
          const cz = this.origin.z + (z + 0.5) * VOXEL_SIZE
          const dx = cx - p.x
          const dy = cy - p.y
          const dz = cz - p.z
          if (dx * dx + dy * dy + dz * dz <= r2) {
            mats.set(i, this.grid[i])
            this.grid[i] = MAT_AIR
          }
        }
    if (mats.size === 0) return 0

    // undermined remnant → also freed
    for (const i of this.floodUnsupported()) {
      mats.set(i, this.grid[i])
      this.grid[i] = MAT_AIR
    }

    // greedy-merge the freed voxels into debris chunks
    const tmp = new Uint8Array(this.grid.length)
    for (const [i, m] of mats) tmp[i] = m
    const boxes = greedyBoxes(tmp, sx, sy, sz)
    for (const b of boxes) {
      const cx = this.origin.x + (b.x + b.sx / 2) * VOXEL_SIZE
      const cy = this.origin.y + (b.y + b.sy / 2) * VOXEL_SIZE
      const cz = this.origin.z + (b.z + b.sz / 2) * VOXEL_SIZE
      const mat = tmp[this.idx(b.x, b.y, b.z)]
      const h = spawnDynamic(
        ctx,
        'box',
        { x: cx, y: cy, z: cz },
        { half: { x: b.sx * H, y: b.sy * H, z: b.sz * H }, color: MATERIALS[mat]?.colorRamp[0] ?? 0x999999 },
      )
      const dx = cx - p.x
      const dy = cy - p.y
      const dz = cz - p.z
      const d = Math.hypot(dx, dy, dz) || 1
      const f = strength * Math.max(0.15, 1 - d / (radius * 2))
      // radial push with a slight upward bias so debris lofts, not just slides
      h.impulse({ x: (dx / d) * f, y: Math.abs(dy / d) * f * 0.4 + f * 0.25, z: (dz / d) * f })
    }

    this.rebuild()
    return boxes.length
  }

  /** world-space AABB (for projectile/crash proximity tests) */
  aabb(): { min: Vec3; max: Vec3 } {
    return {
      min: this.origin,
      max: {
        x: this.origin.x + this.sx * VOXEL_SIZE,
        y: this.origin.y + this.sy * VOXEL_SIZE,
        z: this.origin.z + this.sz * VOXEL_SIZE,
      },
    }
  }
}
