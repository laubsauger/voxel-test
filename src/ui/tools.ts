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
import { MAT_CONCRETE } from '../sim/materials'
import { raycastWorld, type ToolHit } from './raycast'
import type { Hud, ToolId } from './hud'
import { VOXEL_SIZE } from '../world/chunks'

/**
 * T52 — tool fire notifications for the audio wiring (render-layer feedback
 * at the command call site; positions in world meters). Not a sim hook (V6).
 */
export type ToolFireEvent =
  | { kind: 'dig' | 'place'; x: number; y: number; z: number; mat: number }
  | { kind: 'shoot'; hit: { x: number; y: number; z: number; mat: number } | null }
  | { kind: 'explode'; x: number; y: number; z: number; power: number }
  | { kind: 'rocket'; x: number; y: number; z: number } // P19 — launch position (muzzle)
  | { kind: 'tnt_place'; x: number; y: number; z: number } // P19 — charge drop point
  | { kind: 'tnt_detonate' } // P19 — remote trigger pressed

const hitMeters = (hit: ToolHit) => ({ x: hit.mx, y: hit.my, z: hit.mz, mat: hit.mat })

/** shovel reach, meters — melee-ish tool, deliberately short */
export const DIG_RANGE = 5
/** build reach, meters */
export const EDIT_RANGE = 9
/** bomb toss targeting range, meters (unused since T54 made the bomb a projectile) */
export const BOMB_RANGE = 80
/** T54 — bomb toss speed along the view ray, m/s */
export const BOMB_THROW_SPEED = 14
/** T54 — extra upward velocity for a satisfying lob arc, m/s */
export const BOMB_THROW_LOFT = 2.5
/** P19 — rocket aim range for hitmarker feedback, meters */
export const ROCKET_RANGE = 120
/** P19 — TNT placement reach, meters */
export const TNT_PLACE_RANGE = 12

interface ToolSpec {
  cooldownMs: number
}

const SPECS: Record<string, ToolSpec> = {
  dig: { cooldownMs: 220 },
  build: { cooldownMs: 220 },
  gun: { cooldownMs: 160 },
  bomb: { cooldownMs: 900 },
  rocket: { cooldownMs: 750 },
  tnt: { cooldownMs: 260 },
}

export class ToolController {
  private lastFire = 0
  private readonly fwd = new Vector3()

  constructor(
    private game: Game,
    private readonly hud: Hud,
    private readonly onFire?: (e: ToolFireEvent) => void,
  ) {
    document.addEventListener('keydown', (e) => {
      if (this.game.state !== 'play') return
      // P19 — hotbar Digit1..Digit6 (dig/build/gun/bomb/rocket/tnt)
      const m = /^Digit([1-6])$/.exec(e.code)
      if (m) {
        hud.select(Number(m[1]) - 1)
        return
      }
      // P19 — dedicated remote-detonate key for the TNT tool
      if (e.code === 'KeyG' && this.locked() && hud.tool.id === 'tnt') this.detonateTnt()
    })
    document.addEventListener(
      'wheel',
      (e) => {
        if (this.game.state !== 'play' || !this.locked()) return
        hud.select(hud.selected + (e.deltaY > 0 ? 1 : -1))
      },
      { passive: true },
    )
    // hold-to-fire: mousedown starts, per-tool cooldown paces via the rAF
    // poller in fire(); mouseup/lock-loss/blur stop
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.game.state !== 'play' || !this.locked()) return
      this.held = true
      this.fire()
    })
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held = false
    })
    // P19 — right-click is the TNT remote detonator (all placed charges at once)
    document.addEventListener('contextmenu', (e) => {
      if (this.game.state === 'play' && this.locked()) e.preventDefault()
    })
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 2 || this.game.state !== 'play' || !this.locked()) return
      if (this.hud.tool.id === 'tnt') this.detonateTnt()
    })
    addEventListener('blur', () => (this.held = false))
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked()) this.held = false
    })
    const pump = () => {
      if (this.held && this.game.state === 'play' && this.locked()) this.fire()
      requestAnimationFrame(pump)
    }
    requestAnimationFrame(pump)
  }

  /** T71 — an MP session replaces the Game instance; retarget the controller */
  setGame(game: Game): void {
    this.game = game
    this.held = false
  }

  private held = false

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

    // T71 — Game.pushOp is the session-aware sink: solo → sim.queue at the
    // current tick; MP → lockstep submitLocal (applies at tick+delay on all
    // peers, stamped with the session playerId)
    const push = (op: Parameters<Game['pushOp']>[0]) => game.pushOp(op)

    switch (hud.tool.id) {
      case 'dig': {
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, DIG_RANGE)
        if (!hit) return
        push({ kind: 'dig', x: hit.x, y: hit.y, z: hit.z, r: 4 })
        hud.hitmarker()
        this.onFire?.({ kind: 'dig', ...hitMeters(hit) })
        break
      }
      case 'build': {
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, EDIT_RANGE)
        if (!hit) return
        // build against the hit face — the sphere grows out of the surface
        push({ kind: 'place', x: hit.px, y: hit.py, z: hit.pz, r: 3, mat: MAT_CONCRETE })
        hud.hitmarker()
        this.onFire?.({
          kind: 'place',
          x: (hit.px + 0.5) * VOXEL_SIZE,
          y: (hit.py + 0.5) * VOXEL_SIZE,
          z: (hit.pz + 0.5) * VOXEL_SIZE,
          mat: MAT_CONCRETE,
        })
        break
      }
      case 'gun': {
        // hitscan resolved in the sim (src/sim/shoot-op.ts) — deterministic
        push({ kind: 'shoot', ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z })
        // render-side raycast only for feedback (same DDA as the sim handler)
        const shotHit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, 120)
        if (shotHit) hud.hitmarker()
        this.onFire?.({ kind: 'shoot', hit: shotHit ? hitMeters(shotHit) : null })
        break
      }
      case 'bomb': {
        // T54: lob a bomb projectile — the sim integrates arc/bounce/fuse and
        // detonates the T55 zoned explosion where it lies (B13/B14).
        // Detonation audio/FX ride the sim explosion events, not onFire.
        push({
          kind: 'throw',
          ox: o.x + d.x * 0.4,
          oy: o.y + d.y * 0.4,
          oz: o.z + d.z * 0.4,
          vx: d.x * BOMB_THROW_SPEED,
          vy: d.y * BOMB_THROW_SPEED + BOMB_THROW_LOFT,
          vz: d.z * BOMB_THROW_SPEED,
        })
        break
      }
      case 'rocket': {
        // P19: fire a fast straight rocket — the sim flies it and detonates the
        // T55 explosion on the first voxel/body impact. Detonation FX ride the
        // sim explosion events; onFire only carries the launch (muzzle) point.
        push({ kind: 'rocket', ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z })
        const rHit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, ROCKET_RANGE)
        if (rHit) hud.hitmarker()
        this.onFire?.({ kind: 'rocket', x: o.x, y: o.y, z: o.z })
        break
      }
      case 'tnt': {
        // P19: PLACE a charge on the aimed surface (place several, then remote
        // detonate). Right-click / G triggers detonateTnt() — not this path.
        const hit = raycastWorld(game.sim.world, o.x, o.y, o.z, d.x, d.y, d.z, TNT_PLACE_RANGE)
        if (!hit) return
        // rest the charge on the struck face (empty voxel just outside it)
        const cx = (hit.px + 0.5) * VOXEL_SIZE
        const cy = (hit.py + 0.5) * VOXEL_SIZE
        const cz = (hit.pz + 0.5) * VOXEL_SIZE
        push({ kind: 'tnt_place', x: cx, y: cy, z: cz })
        hud.hitmarker()
        this.onFire?.({ kind: 'tnt_place', x: cx, y: cy, z: cz })
        break
      }
    }
  }

  /** P19 — remote detonator: blow every placed TNT charge at once (deterministic sim op) */
  private detonateTnt(): void {
    const now = performance.now()
    // share the tnt cooldown so a right-click can't spam the queue
    if (now - this.lastFire < SPECS.tnt.cooldownMs) return
    this.lastFire = now
    this.game.pushOp({ kind: 'tnt_detonate' })
    this.hud.pulseCrosshair()
    this.onFire?.({ kind: 'tnt_detonate' })
  }
}
