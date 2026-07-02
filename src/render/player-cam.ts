/**
 * T21 [PL] — first-person camera driven by the sim's player entity.
 * Render reads sim state (position/yaw/pitch), never writes it (V6).
 * T23 adds the third-person boom + toggle.
 */
import { PerspectiveCamera } from 'three/webgpu'
import { EYE_HEIGHT, type PlayerEntity } from '../sim/player'

export class PlayerCam {
  readonly camera: PerspectiveCamera

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(75, aspect, 0.05, 500)
  }

  /** call once per rendered frame with the sim player entity (read-only) */
  update(player: PlayerEntity): void {
    this.camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ')
    this.camera.position.set(player.px, player.py + EYE_HEIGHT, player.pz)
  }
}
