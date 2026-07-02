/**
 * I.cmd — the only mutation path into the sim (V1).
 * All coordinates are voxel-space integers unless noted. Ops must stay
 * JSON-serializable (network transport + replay logs).
 */

export interface DigOp {
  kind: 'dig'
  x: number
  y: number
  z: number
  /** radius in voxels */
  r: number
}

export interface PlaceOp {
  kind: 'place'
  x: number
  y: number
  z: number
  r: number
  mat: number
}

export interface ShootOp {
  kind: 'shoot'
  /** ray origin, world meters */
  ox: number
  oy: number
  oz: number
  /** ray direction, normalized */
  dx: number
  dy: number
  dz: number
}

export interface ExplodeOp {
  kind: 'explode'
  x: number
  y: number
  z: number
  r: number
  power: number
}

export interface MoveOp {
  kind: 'move'
  /** bitfield: 1 fwd, 2 back, 4 left, 8 right, 16 jump, 32 crouch, 64 sprint */
  input: number
  yaw: number
  pitch: number
}

export interface SpawnOp {
  kind: 'spawn'
}

/** T47 — toggle noclip fly mode on the issuing player (dev tool, hashable state) */
export interface NoclipOp {
  kind: 'noclip'
}

/** T54 — throw a bomb projectile: arcs, bounces, 3s fuse → T55 explosion */
export interface ThrowOp {
  kind: 'throw'
  /** spawn position, world meters */
  ox: number
  oy: number
  oz: number
  /** initial velocity, m/s */
  vx: number
  vy: number
  vz: number
}

export type Op = DigOp | PlaceOp | ShootOp | ExplodeOp | MoveOp | SpawnOp | NoclipOp | ThrowOp

export interface Command {
  tick: number
  playerId: number
  seq: number
  op: Op
}

/**
 * Per-tick command buffer. Drain order is (playerId, seq) — total and
 * deterministic regardless of arrival order (V2).
 */
export class CommandQueue {
  private byTick = new Map<number, Command[]>()

  push(cmd: Command): void {
    let list = this.byTick.get(cmd.tick)
    if (!list) {
      list = []
      this.byTick.set(cmd.tick, list)
    }
    list.push(cmd)
  }

  drain(tick: number): Command[] {
    const list = this.byTick.get(tick) ?? []
    this.byTick.delete(tick)
    list.sort((a, b) => a.playerId - b.playerId || a.seq - b.seq)
    return list
  }
}
