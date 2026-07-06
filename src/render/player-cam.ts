/**
 * T21/T23 [PL] — first/third-person camera driven by the sim's player entity.
 * Render reads sim state (position/yaw/pitch/world voxels), never writes (V6).
 *
 * T23: toggle key (KeyV) handled here in the render layer; third-person boom
 * arm behind the player, shortened by a voxel ray march (sphere-cast
 * approximation: ray + pull-back margin) so it never clips through the world.
 * Both camera modes read the same player entity.
 */
import { PerspectiveCamera } from 'three/webgpu'
import { CROUCH_HEIGHT, EYE_HEIGHT, type PlayerEntity } from '../sim/player'
import { VOXEL_SIZE, type ChunkStore } from '../world/chunks'

export type CamMode = 'fp' | 'tp'

export const TP_BOOM_LENGTH = 3.5
/** pull-back from the hit voxel — approximates a sphere cast of this radius */
export const TP_COLLISION_MARGIN = 0.25

// T64 — vehicle chase cam tuning. B37 — pulled further out + up and tightened:
// at 6.5 m / stiffness 5 the idle cam sat on the roof and only revealed the
// vehicle once you accelerated (spring lag). Now a rigider, further boom that
// also SCALES with the vehicle size (the plane is much bigger than a car).
export const CHASE_DISTANCE = 9
export const CHASE_HEIGHT = 3.8
/** spring stiffness (1/s) for the chase follow — higher = tighter/more static */
export const CHASE_STIFFNESS = 9
/** P12 — seated first-person eye above the parked capsule origin (py ≈ chassis
 * floor). Voxel cars are authored as SOLID blocks (glass cabin included), so the
 * seat is embedded in glass — a true in-cabin view just sees murk. Instead the
 * eye rides at cabin-roof height, pushed forward past the windshield, so the
 * driver looks out over the hood down the road. Tuned for the sedan cabin
 * (roof ≈ 1.5 m, windshield ≈ 1.2 m forward of the front axle). */
export const SEAT_EYE_HEIGHT = 1.35
/** P12 — forward offset (m) off the seat to clear the windshield glass shell. */
export const SEAT_EYE_FORWARD = 0.85

/** minimal vehicle transform slice the chase cam reads (V6: read-only) */
export interface ChaseTarget {
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  sx: number
  sy: number
  sz: number
}

/**
 * March a ray through the voxel grid (meters in, meters out): returns the
 * free distance before the first solid voxel, capped at maxDist.
 */
export function voxelRayDistance(
  world: ChunkStore,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number {
  // simple fixed-step march at half-voxel resolution — render-side only,
  // cheap and good enough for a camera boom
  const step = VOXEL_SIZE * 0.5
  for (let d = step; d <= maxDist; d += step) {
    const x = Math.floor((ox + dx * d) / VOXEL_SIZE)
    const y = Math.floor((oy + dy * d) / VOXEL_SIZE)
    const z = Math.floor((oz + dz * d) / VOXEL_SIZE)
    if (world.getVoxel(x, y, z) !== 0) return d - step
  }
  return maxDist
}

export class PlayerCam {
  readonly camera: PerspectiveCamera
  mode: CamMode = 'fp'
  /** mode saved while the vehicle chase cam is active (T64); restored on exit */
  private savedMode: CamMode | null = null
  private chaseSnap = true

  constructor(aspect: number, dom?: HTMLElement) {
    this.camera = new PerspectiveCamera(75, aspect, 0.05, 1200) // B32 — 4× world
    if (dom) {
      document.addEventListener('keydown', (e) => {
        if (e.code === 'KeyV') this.toggle()
      })
    }
  }

  toggle(): void {
    this.mode = this.mode === 'fp' ? 'tp' : 'fp'
  }

  private eyeSmooth = EYE_HEIGHT

  /**
   * T64 — seated chase cam: spring-follow behind the vehicle, looking over
   * it. Voxel-clearance clamped (same ray-march as the tp boom). Saves the
   * fp/tp mode on the first call; the next update() (player on foot again)
   * restores it. Call once per rendered frame while the player is seated.
   */
  updateVehicle(v: ChaseTarget, world: ChunkStore, dt: number, player?: PlayerEntity): void {
    if (this.savedMode === null) {
      // P12 — save the on-foot fp/tp mode (restored on exit) and always board
      // in the chase cam; KeyV then toggles to the in-vehicle first person.
      this.savedMode = this.mode
      this.mode = 'tp'
      this.chaseSnap = true
    }
    // P12 — in-vehicle first person: camera at the driver's head, yaw locked to
    // the vehicle heading (looking forward through the windshield), pitch from
    // the mouse. The seated body is rendered with its head hidden (player-visuals)
    // so we don't stare at head backfaces; the arms stay on the wheel.
    if (this.mode === 'fp' && player) {
      const yaw = Math.atan2(2 * (v.qx * v.qz + v.qw * v.qy), 1 - 2 * (v.qx * v.qx + v.qy * v.qy))
      // vehicle forward (same -z convention as the player): (-sin, -cos)
      const fwx = -Math.sin(yaw)
      const fwz = -Math.cos(yaw)
      this.camera.rotation.set(player.pitch, yaw, 0, 'YXZ')
      this.camera.position.set(
        player.px + fwx * SEAT_EYE_FORWARD,
        player.py + SEAT_EYE_HEIGHT,
        player.pz + fwz * SEAT_EYE_FORWARD,
      )
      // re-snap the chase spring so toggling back to third person doesn't swing
      this.chaseSnap = true
      return
    }
    // vehicle center + forward (local -z) from the quaternion
    const cxo = (v.sx * VOXEL_SIZE) / 2
    const cyo = (v.sy * VOXEL_SIZE) / 2
    const czo = (v.sz * VOXEL_SIZE) / 2
    const { qx, qy, qz, qw } = v
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      const cx1 = qy * z - qz * y + qw * x
      const cy1 = qz * x - qx * z + qw * y
      const cz1 = qx * y - qy * x + qw * z
      return [x + 2 * (qy * cz1 - qz * cy1), y + 2 * (qz * cx1 - qx * cz1), z + 2 * (qx * cy1 - qy * cx1)]
    }
    const [ox, oy, oz] = rot(cxo, cyo, czo)
    const cx = v.px + ox
    const cy = v.py + oy
    const cz = v.pz + oz
    const [fx, , fz] = rot(0, 0, -1)
    // horizontal-only forward so the cam doesn't dive when the car pitches
    const fl = Math.hypot(fx, fz) || 1
    const hx = fx / fl
    const hz = fz / fl

    // B37 — scale the boom by vehicle size so big craft (plane) sit further out
    const sizeM = Math.max(v.sx, v.sz) * VOXEL_SIZE
    const dist = CHASE_DISTANCE + sizeM * 0.55
    let tx = cx - hx * dist
    let ty = cy + CHASE_HEIGHT + sizeM * 0.18
    let tz = cz - hz * dist
    // clearance: pull the boom in if a wall sits between car and camera
    const bx = tx - cx
    const by = ty - cy
    const bz = tz - cz
    const blen = Math.hypot(bx, by, bz)
    const free = voxelRayDistance(world, cx, cy, cz, bx / blen, by / blen, bz / blen, blen)
    if (free < blen) {
      const s = Math.max(0, free - TP_COLLISION_MARGIN) / blen
      tx = cx + bx * s
      ty = cy + by * s
      tz = cz + bz * s
    }
    const k = this.chaseSnap ? 1 : 1 - Math.exp(-CHASE_STIFFNESS * dt)
    this.chaseSnap = false
    const cam = this.camera
    cam.position.x += (tx - cam.position.x) * k
    cam.position.y += (ty - cam.position.y) * k
    cam.position.z += (tz - cam.position.z) * k
    cam.lookAt(cx + hx * 2, cy + 0.8, cz + hz * 2)
  }

  /** call once per rendered frame with the sim player entity (read-only) */
  update(player: PlayerEntity, world: ChunkStore): void {
    // T64 — back on foot: restore the camera mode saved when the chase cam took over
    if (this.savedMode !== null) {
      this.mode = this.savedMode
      this.savedMode = null
    }
    this.camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ')
    // T44 — crouching shrinks the capsule; the eye must follow or FP looks
    // unchanged (user bug). Exp-smoothed so the transition reads as a duck.
    const targetEye = player.crouching ? CROUCH_HEIGHT - 0.15 : EYE_HEIGHT
    this.eyeSmooth += (targetEye - this.eyeSmooth) * 0.25
    const ex = player.px
    const ey = player.py + this.eyeSmooth
    const ez = player.pz
    if (this.mode === 'fp') {
      this.camera.position.set(ex, ey, ez)
      return
    }
    // boom arm: from the eye, backwards along the view direction
    const cp = Math.cos(player.pitch)
    const bx = Math.sin(player.yaw) * cp
    const by = -Math.sin(player.pitch)
    const bz = Math.cos(player.yaw) * cp
    const free = voxelRayDistance(world, ex, ey, ez, bx, by, bz, TP_BOOM_LENGTH)
    const boom = Math.max(0, free - TP_COLLISION_MARGIN)
    this.camera.position.set(ex + bx * boom, ey + by * boom, ez + bz * boom)
  }
}
