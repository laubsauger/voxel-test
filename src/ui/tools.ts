/**
 * T28 — tool controller: hotbar selection (1-4 / wheel) + pointer-locked
 * clicks → I.cmd pushes into sim.queue at tick = sim.tick (V1: commands are
 * the ONLY mutation path; the UI never touches sim state, V6).
 *
 * Raycasts originate from the active camera — player eye in fp/tp, the
 * spectator camera while flying (T45: build/dig from above).
 */
import { Vector3 } from 'three/webgpu'
import type { Game } from '../game'
import { LOCAL_PLAYER } from '../game'
import { nextSeq } from '../render/command-seq'
import { MAT_CONCRETE } from '../sim/materials'
import { raycastWorld } from './raycast'
import type { Hud, ToolId } from './hud'

/** reach for dig/build, meters */
export const EDIT_RANGE = 9
/** bomb toss targeting range, meters */
export const BOMB_RANGE = 80

interface ToolSpec {
  cooldownMs: number
}

const SPECS: Record<string, ToolSpec> = {
  dig: { cooldownMs: 220 },
  build: { cooldownMs: 220 },
  gun: { cooldownMs: 160 },
  bomb: { cooldownMs: 900 },
}

export class ToolController {
  private lastFire = 0
  private readonly fwd = new Vector3()

  constructor(
    private readonly game: Game,
    private readonly hud: Hud,
  ) {
    document.addEventListener('keydown', (e) => {
      if (game.state !== 'play') return
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code)
      if (n >= 0) hud.select(n)
    })
    document.addEventListener(
      'wheel',
      (e) => {
        if (game.state !== 'play' || !this.locked()) return
        hud.select(hud.selected + (e.deltaY > 0 ? 1 : -1))
      },
      { passive: true },
    )
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || game.state !== 'play' || !this.locked()) return
      this.fire()
    })
  }

  /** T49 — equipped hotbar tool id (render-side read for the FP viewmodel) */
  get equipped(): ToolId {
    return this.hud.tool.id
  }

  private locked(): boolean {
    return document.pointerLockElement === this.game.renderer.domElement
  }

  private fire(): void {
    const now = performance.now()
    const spec = SPECS[this.hud.tool.id]
    if (now - this.lastFire < spec.cooldownMs) return
    this.lastFire = now

    const { game, hud } = this
    const cam = game.cam.camera
    cam.getWorldDirection(this.fwd)
    const o = cam.position
    const d = this.fwd
    hud.pulseCrosshair()

    const push = (op: Parameters<typeof game.sim.queue.push>[0]['op']) =>
      game.sim.queue.push({ tick: game.sim.tick, playerId: LOCAL_PLAYER, seq: nextSeq(), op })

    switch (hud.tool.id) {
      case 'dig': {
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, EDIT_RANGE)
        if (!hit) return
        push({ kind: 'dig', x: hit.x, y: hit.y, z: hit.z, r: 4 })
        hud.hitmarker()
        break
      }
      case 'build': {
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, EDIT_RANGE)
        if (!hit) return
        // build against the hit face — the sphere grows out of the surface
        push({ kind: 'place', x: hit.px, y: hit.py, z: hit.pz, r: 3, mat: MAT_CONCRETE })
        hud.hitmarker()
        break
      }
      case 'gun': {
        // hitscan resolved in the sim (src/sim/shoot-op.ts) — deterministic
        push({ kind: 'shoot', ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z })
        // render-side raycast only for feedback (same DDA as the sim handler)
        if (raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, 120)) hud.hitmarker()
        break
      }
      case 'bomb': {
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, BOMB_RANGE)
        if (!hit) return
        push({ kind: 'explode', x: hit.x, y: hit.y, z: hit.z, r: 14, power: 4 })
        hud.hitmarker()
        break
      }
    }
  }
}
