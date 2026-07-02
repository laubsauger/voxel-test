/**
 * T49 [PL] — first-person viewmodel: voxel-style arms/hands in the bottom
 * corners of the view + the equipped hotbar tool in the right hand.
 *
 * Render layer only (V6): reads the equipped tool id + stride phase, writes
 * nothing to the sim. The whole rig is a Group parented to the FP camera.
 *
 * Animation is analytic timelines (threejs-procedural-animation skill):
 * - swap: lower → switch tool mesh → raise (on hotbar change)
 * - swing: windup → strike arc → recover (dig/build/bomb use)
 * - recoil: impulse + exponential recovery (gun)
 * - bob: synced to the SAME stride phase as the body rig (no desync)
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three/webgpu'
import { clamp, expSmooth } from './player-anim'
import { COLOR_SHIRT, COLOR_SKIN } from './player-mesh'

export const SWAP_DURATION = 0.3
export const SWING_DURATION = 0.3

/** per-tool swing/recoil style; mirrors the hotbar ToolIds (src/ui/hud.ts) */
export type ViewTool = 'dig' | 'build' | 'gun' | 'bomb'
const TOOL_IDS: readonly ViewTool[] = ['dig', 'build', 'gun', 'bomb']

/** render-side anim cooldowns (ms) — mirror tool cadence, feedback only */
const ANIM_COOLDOWN_MS: Record<ViewTool, number> = { dig: 220, build: 220, gun: 160, bomb: 900 }

const SKIN_MAT = new MeshStandardMaterial({ color: COLOR_SKIN, roughness: 0.85 })
const SLEEVE_MAT = new MeshStandardMaterial({ color: COLOR_SHIRT, roughness: 0.9 })
const WOOD_MAT = new MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8 })
const METAL_MAT = new MeshStandardMaterial({ color: 0x8d939c, roughness: 0.35, metalness: 0.8 })
const DARK_MAT = new MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.5, metalness: 0.3 })
const CONCRETE_MAT = new MeshStandardMaterial({ color: 0xb8b4ac, roughness: 0.95 })
const FUSE_MAT = new MeshStandardMaterial({ color: 0xd9a13c, roughness: 0.6 })

function box(w: number, h: number, d: number, mat: MeshStandardMaterial, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  return m
}

/**
 * Voxel-chunky forearm + hand. Group origin = the ELBOW, geometry extends
 * toward -z (away from the camera) so rotating the group swings the hand,
 * not the cuff into the near plane.
 */
function buildArm(): Group {
  const g = new Group()
  g.add(box(0.14, 0.14, 0.12, SLEEVE_MAT, 0, 0, -0.02)) // sleeve cuff at elbow
  g.add(box(0.1, 0.1, 0.24, SKIN_MAT, 0, 0, -0.17)) // forearm
  g.add(box(0.13, 0.13, 0.13, SKIN_MAT, 0, 0, -0.33)) // chunky hand
  return g
}

/** tool geometry relative to the GRIP point (the hand center) */
function buildTool(id: ViewTool): Group {
  const g = new Group()
  switch (id) {
    case 'dig': // shovel
      g.add(box(0.05, 0.05, 0.55, WOOD_MAT, 0, 0.02, -0.1))
      g.add(box(0.17, 0.035, 0.2, METAL_MAT, 0, 0.0, -0.44))
      g.add(box(0.11, 0.05, 0.05, WOOD_MAT, 0, 0.02, 0.2)) // grip tee
      break
    case 'build': // concrete block held on the palm
      g.add(box(0.2, 0.2, 0.2, CONCRETE_MAT, 0, 0.14, -0.08))
      break
    case 'gun': // blocky pistol above the fist
      g.add(box(0.09, 0.13, 0.3, DARK_MAT, 0, 0.11, -0.14))
      g.add(box(0.05, 0.06, 0.16, METAL_MAT, 0, 0.13, -0.36))
      g.add(box(0.025, 0.035, 0.05, METAL_MAT, 0, 0.2, -0.02)) // sight
      break
    case 'bomb': // black cartoon bomb + fuse
      g.add(box(0.18, 0.18, 0.18, DARK_MAT, 0, 0.13, -0.08))
      g.add(box(0.04, 0.1, 0.04, FUSE_MAT, 0.04, 0.26, -0.1))
      break
  }
  return g
}

export class PlayerViewmodel {
  readonly group = new Group()
  private readonly armR: Group
  private readonly armL: Group
  private readonly tools = new Map<ViewTool, Group>()
  private equipped: ViewTool = 'dig'
  private pendingTool: ViewTool | null = null
  private swapT = 1 // finished
  private swingT = 1 // finished
  private recoilK = 0
  private lastUseAt = 0
  private time = 0
  private bobX = 0
  private bobY = 0

  /** attach to the FP camera; caller adds camera to the scene graph */
  constructor(camera: Object3D) {
    this.group.name = 'player-viewmodel'
    this.armR = buildArm()
    this.armR.position.set(0.3, -0.3, -0.3)
    this.armR.rotation.set(0.35, -0.1, 0.05)
    this.armL = buildArm()
    this.armL.position.set(-0.32, -0.34, -0.32)
    this.armL.rotation.set(0.3, 0.12, -0.05)
    this.group.add(this.armR, this.armL)
    // carry angle per tool: cancels the arm's upward pitch so the shovel
    // rides tip-down and the gun sits level
    const carry: Record<ViewTool, number> = { dig: -0.85, build: -0.25, gun: -0.3, bomb: -0.25 }
    for (const id of TOOL_IDS) {
      const t = buildTool(id)
      t.visible = id === this.equipped
      this.armR.add(t)
      t.position.set(0, 0.02, -0.33) // grip at the hand
      t.rotation.x = carry[id]
      this.tools.set(id, t)
    }
    camera.add(this.group)
  }

  /** play the use animation for the equipped tool (dig/build swing, gun recoil, bomb toss) */
  triggerUse(): void {
    const now = performance.now()
    if (now - this.lastUseAt < ANIM_COOLDOWN_MS[this.equipped]) return
    this.lastUseAt = now
    if (this.equipped === 'gun') this.recoilK = 1
    else this.swingT = 0
  }

  /** current tool actually shown (lags requested tool by the swap-down phase) */
  get shownTool(): ViewTool {
    return this.equipped
  }

  /**
   * @param dt seconds (clamped internally)
   * @param stridePhase the body rig's stride phase — SAME source, no desync
   * @param moveW walk-cycle weight from the body rig
   * @param requestedTool hotbar equipped tool id
   */
  update(dt: number, stridePhase: number, moveW: number, requestedTool: string): void {
    dt = clamp(dt, 0, 0.1)
    this.time += dt

    // --- tool swap timeline: lower, switch mesh at the bottom, raise --------
    const wanted = (TOOL_IDS as readonly string[]).includes(requestedTool)
      ? (requestedTool as ViewTool)
      : this.equipped
    if (wanted !== this.equipped && this.pendingTool === null) {
      this.pendingTool = wanted
      this.swapT = 0
    }
    if (this.swapT < 1) {
      this.swapT = Math.min(1, this.swapT + dt / SWAP_DURATION)
      if (this.pendingTool !== null && this.swapT >= 0.5) {
        this.tools.get(this.equipped)!.visible = false
        this.equipped = this.pendingTool
        this.tools.get(this.equipped)!.visible = true
        this.pendingTool = null
      }
    }
    // triangular envelope: 0 at rest, 1 fully lowered at the switch point
    const swapDip = this.swapT < 0.5 ? this.swapT * 2 : (1 - this.swapT) * 2

    // --- swing timeline: windup (30%) → strike → recover ---------------------
    let swingAngle = 0
    let swingPush = 0
    if (this.swingT < 1) {
      this.swingT = Math.min(1, this.swingT + dt / SWING_DURATION)
      const t = this.swingT
      if (t < 0.3) {
        const k = t / 0.3
        swingAngle = 0.45 * k * k // windup: raise
      } else {
        const k = (t - 0.3) / 0.7
        const strike = Math.sin(Math.min(k * 2, 1) * Math.PI * 0.5)
        const recover = k < 0.5 ? 1 : 1 - (k - 0.5) * 2
        swingAngle = 0.45 - 1.5 * strike * recover
        swingPush = -0.14 * strike * recover
      }
    }

    // --- gun recoil: impulse + exponential recovery --------------------------
    this.recoilK *= Math.exp(-13 * dt)

    // --- walk bob synced to the body stride phase (T48 ↔ T49 contract) -------
    const twoPi = Math.PI * 2
    const targetX = Math.sin(stridePhase * twoPi) * 0.014 * moveW
    const targetY = -Math.abs(Math.sin(stridePhase * twoPi)) * 0.016 * moveW
    this.bobX = expSmooth(this.bobX, targetX, 18, dt)
    this.bobY = expSmooth(this.bobY, targetY, 18, dt)
    const breathe = Math.sin(this.time * 1.7) * 0.0035 * (1 - moveW)

    this.group.position.set(this.bobX, this.bobY + breathe, 0)

    // compose right arm: rest pose + swap dip + swing + recoil
    this.armR.position.set(
      0.3 + this.recoilK * 0.01,
      -0.3 - swapDip * 0.38,
      -0.3 + swingPush + this.recoilK * 0.07,
    )
    this.armR.rotation.set(
      0.35 + swingAngle + this.recoilK * 0.35 + swapDip * 0.6,
      -0.1,
      0.05,
    )
    // left arm mirrors the bob, dips slightly on swaps, stays home otherwise
    this.armL.position.set(-0.32, -0.34 - swapDip * 0.1, -0.32)
  }
}
