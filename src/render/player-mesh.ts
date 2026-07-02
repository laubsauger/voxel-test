/**
 * T22 [PL] — render the segmented voxel player body as per-segment instanced
 * boxes (one instance per live voxel). Visual-quality placeholder; the sim
 * data model is the point. Read-only on the player entity (V6): rebuilds only
 * when a segment's version counter changes.
 */
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
} from 'three/webgpu'
import { VOXEL_SIZE } from '../world/chunks'
import type { PlayerEntity, PlayerSegment } from '../sim/player'

const VOXEL_GEO = new BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE)
const FLESH_MAT = new MeshStandardMaterial({ color: 0xc98d6b })

export class PlayerMesh {
  readonly group = new Group()
  private readonly meshes: InstancedMesh[] = []
  private readonly versions: number[] = []
  private readonly scratch = new Matrix4()

  constructor(player: PlayerEntity) {
    for (const seg of player.segments) {
      const mesh = new InstancedMesh(VOXEL_GEO, FLESH_MAT, seg.grid.length)
      mesh.castShadow = true
      this.meshes.push(mesh)
      this.versions.push(-1) // force initial build
      this.group.add(mesh)
    }
  }

  /** call once per rendered frame */
  update(player: PlayerEntity): void {
    this.group.position.set(player.px, player.py, player.pz)
    this.group.rotation.set(0, player.yaw, 0)
    for (let i = 0; i < player.segments.length; i++) {
      const seg = player.segments[i]
      if (seg.version !== this.versions[i]) {
        this.rebuild(this.meshes[i], seg)
        this.versions[i] = seg.version
      }
    }
  }

  private rebuild(mesh: InstancedMesh, seg: PlayerSegment): void {
    const { ox, oy, oz, sx, sy, sz } = seg.def
    let n = 0
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          if (seg.grid[x + z * sx + y * sx * sz] === 0) continue
          this.scratch.makeTranslation(
            (ox + x + 0.5) * VOXEL_SIZE,
            (oy + y + 0.5) * VOXEL_SIZE,
            (oz + z + 0.5) * VOXEL_SIZE,
          )
          mesh.setMatrixAt(n++, this.scratch)
        }
      }
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
  }
}
