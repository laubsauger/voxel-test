/**
 * T21/T23 [PL] — first/third-person camera driven by the sim's player entity.
 * Render reads sim state (position/yaw/pitch/world voxels), never writes (V6).
 *
 * T23: toggle key (KeyV) handled here in the render layer; third-person boom
 * arm behind the player, shortened by a voxel ray march (sphere-cast
 * approximation: ray + pull-back margin) so it never clips through the world.
 * Both camera modes read the same player entity.
 */
import { PerspectiveCamera } from 'three/webgpu'
import { EYE_HEIGHT, type PlayerEntity } from '../sim/player'
import { VOXEL_SIZE, type ChunkStore } from '../world/chunks'

export type CamMode = 'fp' | 'tp'

export const TP_BOOM_LENGTH = 3.5
/** pull-back from the hit voxel — approximates a sphere cast of this radius */
export const TP_COLLISION_MARGIN = 0.25

/**
 * March a ray through the voxel grid (meters in, meters out): returns the
 * free distance before the first solid voxel, capped at maxDist.
 */
export function voxelRayDistance(
  world: ChunkStore,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number {
  // simple fixed-step march at half-voxel resolution — render-side only,
  // cheap and good enough for a camera boom
  const step = VOXEL_SIZE * 0.5
  for (let d = step; d <= maxDist; d += step) {
    const x = Math.floor((ox + dx * d) / VOXEL_SIZE)
    const y = Math.floor((oy + dy * d) / VOXEL_SIZE)
    const z = Math.floor((oz + dz * d) / VOXEL_SIZE)
    if (world.getVoxel(x, y, z) !== 0) return d - step
  }
  return maxDist
}

export class PlayerCam {
  readonly camera: PerspectiveCamera
  mode: CamMode = 'fp'

  constructor(aspect: number, dom?: HTMLElement) {
    this.camera = new PerspectiveCamera(75, aspect, 0.05, 500)
    if (dom) {
      document.addEventListener('keydown', (e) => {
        if (e.code === 'KeyV') this.toggle()
      })
    }
  }

  toggle(): void {
    this.mode = this.mode === 'fp' ? 'tp' : 'fp'
  }

  /** call once per rendered frame with the sim player entity (read-only) */
  update(player: PlayerEntity, world: ChunkStore): void {
    this.camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ')
    const ex = player.px
    const ey = player.py + EYE_HEIGHT
    const ez = player.pz
    if (this.mode === 'fp') {
      this.camera.position.set(ex, ey, ez)
      return
    }
    // boom arm: from the eye, backwards along the view direction
    const cp = Math.cos(player.pitch)
    const bx = Math.sin(player.yaw) * cp
    const by = -Math.sin(player.pitch)
    const bz = Math.cos(player.yaw) * cp
    const free = voxelRayDistance(world, ex, ey, ez, bx, by, bz, TP_BOOM_LENGTH)
    const boom = Math.max(0, free - TP_COLLISION_MARGIN)
    this.camera.position.set(ex + bx * boom, ey + by * boom, ez + bz * boom)
  }
}
