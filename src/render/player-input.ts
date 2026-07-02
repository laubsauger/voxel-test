/**
 * T21 [PL] — pointer-lock input capture → 'move' commands.
 *
 * This is NOT the render layer writing sim state (V6): commands through
 * sim.queue are THE sanctioned mutation path (V1, I.cmd). The main loop asks
 * for a move command each tick and pushes it into the queue (in multiplayer,
 * onto the wire). Wall-clock/frame time never enters the op payload (V2).
 */
import { INPUT_BACK, INPUT_CROUCH, INPUT_FWD, INPUT_JUMP, INPUT_LEFT, INPUT_RIGHT } from '../sim/player'
import type { Command } from '../sim/commands'

export class PlayerInput {
  yaw = 0
  pitch = 0
  private readonly keys = new Set<string>()
  private seq = 0

  constructor(dom: HTMLElement) {
    dom.addEventListener('click', () => dom.requestPointerLock())
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return
      this.yaw -= e.movementX * 0.002
      this.pitch -= e.movementY * 0.002
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch))
    })
    document.addEventListener('keydown', (e) => this.keys.add(e.code))
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
  }

  /** current input bitfield (see MoveOp in src/sim/commands.ts) */
  inputBits(): number {
    let bits = 0
    if (this.keys.has('KeyW')) bits |= INPUT_FWD
    if (this.keys.has('KeyS')) bits |= INPUT_BACK
    if (this.keys.has('KeyA')) bits |= INPUT_LEFT
    if (this.keys.has('KeyD')) bits |= INPUT_RIGHT
    if (this.keys.has('Space')) bits |= INPUT_JUMP
    if (this.keys.has('ControlLeft')) bits |= INPUT_CROUCH
    return bits
  }

  /**
   * Build this tick's move command. seq is module-local: if other command
   * sources exist for the same player, coordinate seq allocation upstream.
   */
  moveCommand(tick: number, playerId: number): Command {
    return {
      tick,
      playerId,
      seq: this.seq++,
      op: { kind: 'move', input: this.inputBits(), yaw: this.yaw, pitch: this.pitch },
    }
  }
}
