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

/**
 * P19 — fire a rocket: a fast straight projectile from the camera aim that
 * detonates a T55 explosion on the first world-voxel or dynamic-body impact.
 */
export interface RocketOp {
  kind: 'rocket'
  /** launch position, world meters */
  ox: number
  oy: number
  oz: number
  /** aim direction, normalized */
  dx: number
  dy: number
  dz: number
}

/** P19 — place a remote-detonated TNT charge entity at the aim point (world meters) */
export interface TntPlaceOp {
  kind: 'tnt_place'
  x: number
  y: number
  z: number
}

/** P19 — remote detonator: blow ALL placed charges at once (chained explosions) */
export interface TntDetonateOp {
  kind: 'tnt_detonate'
}

/**
 * T64 — spawn a drivable vehicle entity (dev/scene op). Position is the
 * CENTER of the car footprint in world meters (y = ground surface under the
 * wheels); yaw in radians about +Y (0 = car front faces -z, three.js YXZ).
 */
export interface VehicleSpawnOp {
  kind: 'vehicle_spawn'
  /** archetype key from gen/props car builders: sedan0..2, pickup0..2, van0..2 */
  archetype: string
  x: number
  y: number
  z: number
  yaw: number
}

/** T64 — issuing player enters the nearest vehicle with a free seat (driver first) */
export interface VehicleEnterOp {
  kind: 'vehicle_enter'
}

/** T64 — issuing player exits their vehicle (voxel-clearance-checked door placement) */
export interface VehicleExitOp {
  kind: 'vehicle_exit'
}

/**
 * P17 — spawn a flyable aircraft entity (gen/dev op). Position is the CENTER of
 * the plane footprint in world meters (y = ground surface under the gear); yaw
 * in radians about +Y (0 = nose faces -z, three.js YXZ).
 */
export interface AircraftSpawnOp {
  kind: 'aircraft_spawn'
  x: number
  y: number
  z: number
  yaw: number
}

/** P17 — issuing player boards the nearest aircraft with a free seat (pilot) */
export interface AircraftEnterOp {
  kind: 'aircraft_enter'
}

/** P17 — issuing player exits their aircraft (voxel-clearance-checked placement) */
export interface AircraftExitOp {
  kind: 'aircraft_exit'
}

export type Op =
  | DigOp
  | PlaceOp
  | ShootOp
  | ExplodeOp
  | MoveOp
  | SpawnOp
  | NoclipOp
  | ThrowOp
  | RocketOp
  | TntPlaceOp
  | TntDetonateOp
  | VehicleSpawnOp
  | VehicleEnterOp
  | VehicleExitOp
  | AircraftSpawnOp
  | AircraftEnterOp
  | AircraftExitOp

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
