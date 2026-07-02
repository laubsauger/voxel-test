/**
 * T60 — underwater camera treatment. Render layer only (V6): reads the water
 * field + camera position, mutates nothing sim-side.
 *
 * Pragmatic fullscreen DOM overlay (per T60 scope: cheap tint + fog feel, no
 * post-stack change): a teal gradient with a soft vignette fades in when the
 * camera point is inside a water cell. Costs one composited div — zero GPU
 * pipeline impact, works with any render pipeline.
 *
 * Wiring (documented in INTEGRATION-water.md §6 — game.ts owner):
 *   const underwater = new UnderwaterOverlay()   // appends to document.body
 *   // per frame, after camera update:
 *   underwater.update(cam.camera.position, water)
 */

import type { Vector3 } from 'three/webgpu'
import { VOXEL_SIZE } from '../../world/chunks'
import { MAX_LEVEL } from '../../sim/water/rules'

/** structural WaterSim view — keeps this module import-light */
interface WaterField {
  levelAt(vx: number, vy: number, vz: number): number
}

/** overlay fade speed (per second) — fast plunge-in, slightly softer out */
const FADE_IN_RATE = 10
const FADE_OUT_RATE = 6

export class UnderwaterOverlay {
  readonly el: HTMLDivElement
  private opacity = 0
  private lastMs: number | null = null

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div')
    this.el.id = 'underwater-overlay'
    Object.assign(this.el.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '5', // under HUD/menus (they sit at 10+), over the canvas
      opacity: '0',
      background:
        'radial-gradient(ellipse at 50% 40%, rgba(24, 96, 122, 0.38) 0%, rgba(8, 44, 66, 0.62) 70%, rgba(3, 24, 40, 0.78) 100%)',
      backdropFilter: 'blur(1.5px)',
      transition: 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    parent.appendChild(this.el)
  }

  /** true when a world-space point sits below the local water surface */
  static isUnderwater(pos: { x: number; y: number; z: number }, water: WaterField): boolean {
    const vx = Math.floor(pos.x / VOXEL_SIZE)
    const vy = Math.floor(pos.y / VOXEL_SIZE)
    const vz = Math.floor(pos.z / VOXEL_SIZE)
    const level = water.levelAt(vx, vy, vz)
    if (level === 0) return false
    // partial cell: underwater only below its fill height
    return pos.y / VOXEL_SIZE - vy <= level / MAX_LEVEL
  }

  /** call once per rendered frame with the active camera world position */
  update(cameraPos: Vector3, water: WaterField, nowMs: number = performance.now()): void {
    const dt = this.lastMs === null ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.1)
    this.lastMs = nowMs
    const target = UnderwaterOverlay.isUnderwater(cameraPos, water) ? 1 : 0
    const rate = target > this.opacity ? FADE_IN_RATE : FADE_OUT_RATE
    this.opacity += (target - this.opacity) * Math.min(1, rate * dt)
    if (Math.abs(target - this.opacity) < 0.01) this.opacity = target
    this.el.style.opacity = this.opacity.toFixed(3)
  }

  dispose(): void {
    this.el.remove()
  }
}
