/**
 * T21 [PL] — pointer-lock input capture → 'move' commands.
 *
 * This is NOT the render layer writing sim state (V6): commands through
 * sim.queue are THE sanctioned mutation path (V1, I.cmd). The main loop asks
 * for a move command each tick and pushes it into the queue (in multiplayer,
 * onto the wire). Wall-clock/frame time never enters the op payload (V2).
 *
 * T28/T34 additions: seq comes from the shared allocator (command-seq.ts) so
 * tool commands and move commands never collide on (playerId, seq);
 * sensitivity/invertY knobs are driven by the settings store (I.settings).
 * T44: Shift = sprint bit (64, sim-side handler lands with the physics
 * track), Ctrl/C = crouch.
 */
import { INPUT_BACK, INPUT_CROUCH, INPUT_FWD, INPUT_JUMP, INPUT_LEFT, INPUT_RIGHT } from '../sim/player'
import type { Command } from '../sim/commands'
import { nextSeq } from './command-seq'

/** sprint bit (T44) — sim-side handling lands with the physics track */
export const INPUT_SPRINT = 64

export class PlayerInput {
  yaw = 0
  pitch = 0
  /** mouse sensitivity multiplier (I.settings controls.sensitivity) */
  sensitivity = 1
  /** invert mouse Y (I.settings controls.invertY) */
  invertY = false
  private readonly keys = new Set<string>()

  constructor(dom: HTMLElement) {
    dom.addEventListener('click', () => dom.requestPointerLock())
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return
      const k = 0.002 * this.sensitivity
      this.yaw -= e.movementX * k
      this.pitch += e.movementY * k * (this.invertY ? 1 : -1)
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch))
    })
    document.addEventListener('keydown', (e) => this.keys.add(e.code))
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    // pointer lock swallows keyup for some combos; clear on blur to avoid stuck keys
    addEventListener('blur', () => this.keys.clear())
  }

  /** is a key currently held (render-layer helpers, e.g. fly mode) */
  isDown(code: string): boolean {
    return this.keys.has(code)
  }

  /** current input bitfield (see MoveOp in src/sim/commands.ts) */
  inputBits(): number {
    let bits = 0
    if (this.keys.has('KeyW')) bits |= INPUT_FWD
    if (this.keys.has('KeyS')) bits |= INPUT_BACK
    if (this.keys.has('KeyA')) bits |= INPUT_LEFT
    if (this.keys.has('KeyD')) bits |= INPUT_RIGHT
    if (this.keys.has('Space')) bits |= INPUT_JUMP
    if (this.keys.has('ControlLeft') || this.keys.has('KeyC')) bits |= INPUT_CROUCH
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) bits |= INPUT_SPRINT
    return bits
  }

  /**
   * Build this tick's move command. seq comes from the shared allocator
   * (command-seq.ts) — coordinated with tool commands for the same player.
   * `overrideBits` replaces the keyboard bits (fly mode sends 0: the capsule
   * stays put while the spectator camera roams, V6).
   */
  moveCommand(tick: number, playerId: number, overrideBits?: number): Command {
    return {
      tick,
      playerId,
      seq: nextSeq(),
      op: {
        kind: 'move',
        input: overrideBits ?? this.inputBits(),
        yaw: this.yaw,
        pitch: this.pitch,
      },
    }
  }
}
