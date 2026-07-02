/**
 * T45 — fly/spectator mode (render-only, V6). Adapted from flycam.ts but
 * driven by the shared PlayerInput look state, so entering/leaving fly mode
 * keeps the view direction continuous. The player capsule stays put in the
 * sim while flying (the game loop sends empty move bits) — lockstep untouched.
 */
import { Vector3, type PerspectiveCamera } from 'three/webgpu'
import type { PlayerInput } from './player-input'

export const FLY_SPEED = 12
export const FLY_SPEED_FAST = 40

export class SpectatorCam {
  private readonly dir = new Vector3()

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: PlayerInput,
  ) {}

  /** call when entering fly mode — takes off from the current camera pose */
  enter(): void {
    // camera position/rotation are already where the player cam left them
  }

  /** per-frame while flying; dt in seconds (render clock — never sim, V6) */
  update(dt: number): void {
    const { camera, input, dir } = this
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ')

    const speed = (input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? FLY_SPEED_FAST : FLY_SPEED) * dt
    dir.set(0, 0, 0)
    if (input.isDown('KeyW')) dir.z -= 1
    if (input.isDown('KeyS')) dir.z += 1
    if (input.isDown('KeyA')) dir.x -= 1
    if (input.isDown('KeyD')) dir.x += 1
    if (dir.lengthSq() > 0) {
      dir.normalize().applyEuler(camera.rotation)
      camera.position.addScaledVector(dir, speed)
    }
    if (input.isDown('KeyQ')) camera.position.y -= speed
    if (input.isDown('KeyE')) camera.position.y += speed
  }
}
