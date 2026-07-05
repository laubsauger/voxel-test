/**
 * T46/T48/T49 [PL] — player visuals facade: one object the game loop drives.
 *
 * Owns the third-person voxel body (PlayerMesh: color zones + procedural
 * animation rig) and the first-person viewmodel (arms + equipped tool).
 * Read-only on sim state (V6); wiring documented in
 * src/render/INTEGRATION-player-visuals.md.
 *
 * Visibility matrix:
 *   fp    → body shown headless/armless (feet visible looking down), viewmodel shown
 *   tp    → full body, no viewmodel
 *   fly   → full body (spectator sees own body floating/standing), no viewmodel
 *   orbit → full body, no viewmodel
 */
import type { Object3D, Scene } from 'three/webgpu'
import type { PlayerEntity } from '../sim/player'
import { PlayerMesh } from './player-mesh'
import { PlayerViewmodel } from './player-viewmodel'

export type VisualCamMode = 'fp' | 'tp' | 'fly' | 'orbit'

export class PlayerVisuals {
  private readonly scene: Scene
  private readonly camera: Object3D
  private readonly viewmodel: PlayerViewmodel
  private body: PlayerMesh | null = null

  constructor(scene: Scene, camera: Object3D) {
    this.scene = scene
    this.camera = camera
    // camera children only render when the camera is in the scene graph
    if (!camera.parent) scene.add(camera)
    this.viewmodel = new PlayerViewmodel(camera)
    this.viewmodel.group.visible = false
    // render-side use feedback: pointer-locked primary click = tool use.
    // (Pure presentation — the sim command path lives in ui/tools.ts.)
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0 && document.pointerLockElement && this.viewmodel.group.visible) {
        this.viewmodel.triggerUse()
      }
    })
  }

  /** optional precise hook: call when a tool command is actually fired */
  triggerUse(): void {
    this.viewmodel.triggerUse()
  }

  /** the third-person body root (null until the first update with a player) */
  get bodyGroup(): Object3D | null {
    return this.body?.group ?? null
  }

  /**
   * Call once per rendered frame.
   * @param dt seconds since last frame
   * @param player the sim player entity (read-only, V6) — undefined pre-spawn
   * @param camMode current camera mode (fp/tp/fly/orbit)
   * @param equippedTool hotbar tool id (ToolController.equipped)
   */
  update(
    dt: number,
    player: PlayerEntity | undefined,
    camMode: VisualCamMode,
    equippedTool = 'dig',
    seatYaw?: number | null,
  ): void {
    if (!player) {
      if (this.body) this.body.group.visible = false
      this.viewmodel.group.visible = false
      return
    }
    if (!this.body) {
      this.body = new PlayerMesh(player)
      this.scene.add(this.body.group)
    }
    // B31 — seated: chase cam shows the full body sitting in the seat, so we
    // render the whole body (never the FP-hidden variant) and suppress the
    // first-person viewmodel (its floating arms would hover over the wheel).
    const seated = seatYaw !== null && seatYaw !== undefined
    const fp = camMode === 'fp'
    this.body.group.visible = true
    this.body.setFirstPerson(fp && !seated)
    this.body.update(player, dt, seatYaw)

    this.viewmodel.group.visible = fp && !seated
    if (fp && !seated) {
      this.viewmodel.update(dt, this.body.anim.phase, this.body.anim.moveW, equippedTool)
    }
  }
}
