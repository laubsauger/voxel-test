/**
 * T64 [V] — vehicle rendering: BodyMeshes pattern (V6: reads phys.vehicles,
 * writes nothing back to the sim).
 *
 * - Chassis: meshed from the vehicle's voxel grid via the pure chunk mesher,
 *   chunk material contract ('mat'/'ao' attributes) — MAT_LAMP headlight
 *   accents get the chunk material's emissive + day-factor handling for free
 *   (B25). Rebuilt when entity.version bumps (crash dents).
 * - Wheels: spinning dark cylinders — round VISUALS for the round physics
 *   wheels (the sim grid carries no wheel voxels). Steering deflection on the
 *   front pair, suspension travel, broken wheels hidden (they fly off as
 *   debris bodies).
 * - Steering wheel: small dark ring in front of the driver seat, deflecting
 *   with the steer input.
 *
 * Also exports installVehicleDevControls — dev-gated key bindings that push
 * vehicle ops through sim.queue (V1: commands are the sanctioned path, same
 * as ui/tools.ts). Wiring lives in game.ts (see INTEGRATION-vehicles.md).
 */
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
  type Material,
} from 'three/webgpu'
import type { PhysicsWorld } from '../sim/physics'
import type { VehicleEntity } from '../sim/vehicle'
import type { Sim } from '../sim/loop'
import { VOXEL_SIZE, CHUNK, WORLD_VY } from '../world/chunks'
import { buildPaddedChunk, meshChunk } from './mesher'
import { nextSeq } from './command-seq'

interface Entry {
  group: Group
  chassis: Mesh
  chassisT: Mesh | null
  wheels: Mesh[]
  steering: Mesh
  version: number
}

export class VehicleMeshes {
  private readonly meshes = new Map<number, Entry>()
  private readonly rubber = new MeshStandardMaterial({ color: 0x17171a, roughness: 0.92, metalness: 0.05 })
  private readonly hub = new MeshStandardMaterial({ color: 0x8a929a, roughness: 0.4, metalness: 0.8 })
  private readonly wheelGeometry: CylinderGeometry
  private readonly hubGeometry: CylinderGeometry
  private readonly steeringGeometry: TorusGeometry

  constructor(
    private readonly parent: Object3D,
    private readonly material: Material,
    private readonly transparentMaterial?: Material,
  ) {
    // cylinder axis along local X (axle): rotate the default Y-axis geometry
    this.wheelGeometry = new CylinderGeometry(1, 1, 1, 20)
    this.wheelGeometry.rotateZ(Math.PI / 2)
    this.hubGeometry = new CylinderGeometry(0.55, 0.55, 1.06, 12)
    this.hubGeometry.rotateZ(Math.PI / 2)
    this.steeringGeometry = new TorusGeometry(0.17, 0.025, 8, 20)
  }

  get count(): number {
    return this.meshes.size
  }

  /** call once per rendered frame with phys.vehicles (read-only) */
  update(vehicles: ReadonlyMap<number, VehicleEntity>): void {
    for (const [id, entry] of this.meshes) {
      if (!vehicles.has(id)) {
        // despawned or converted to a wreck (BodyMeshes takes over there)
        entry.chassis.geometry.dispose()
        entry.chassisT?.geometry.dispose()
        this.parent.remove(entry.group)
        this.meshes.delete(id)
      }
    }
    for (const [id, v] of vehicles) {
      let entry = this.meshes.get(id)
      if (!entry) {
        entry = this.buildEntry(v)
        this.meshes.set(id, entry)
        this.parent.add(entry.group)
      } else if (entry.version !== v.version) {
        const { opaque, transparent } = buildChassisGeometries(v)
        entry.chassis.geometry.dispose()
        entry.chassis.geometry = opaque
        if (entry.chassisT) {
          entry.chassisT.geometry.dispose()
          if (transparent) entry.chassisT.geometry = transparent
          else entry.chassisT.visible = false
        }
        entry.version = v.version
      }
      entry.group.position.set(v.px, v.py, v.pz)
      entry.group.quaternion.set(v.qx, v.qy, v.qz, v.qw)

      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i]
        const mesh = entry.wheels[i]
        mesh.visible = !w.broken
        if (w.broken) continue
        mesh.position.set(w.x, w.y - w.suspension, w.z)
        // YXZ: steer about the up axis, then roll about the axle.
        // Jolt rotation angle increases rolling forward; our forward is -z,
        // so the visual roll about +x is the negated angle.
        mesh.rotation.set(-w.rotation, w.steer, 0, 'YXZ')
      }
      // steering wheel mirrors the front-left steer angle, amplified
      entry.steering.rotation.z = -v.wheels[0].steer * 2.5
    }
  }

  private buildEntry(v: VehicleEntity): Entry {
    const group = new Group()
    const { opaque, transparent } = buildChassisGeometries(v)
    const chassis = new Mesh(opaque, this.material)
    chassis.castShadow = true
    chassis.receiveShadow = true
    group.add(chassis)
    let chassisT: Mesh | null = null
    if (transparent && this.transparentMaterial) {
      chassisT = new Mesh(transparent, this.transparentMaterial)
      group.add(chassisT)
    } else if (transparent) {
      // no transparent material handed in: glass renders opaque (T39 note)
      group.add(new Mesh(transparent, this.material))
    }

    const wheels: Mesh[] = []
    for (const w of v.wheels) {
      const wheel = new Mesh(this.wheelGeometry, this.rubber)
      wheel.scale.set(w.width, w.radius, w.radius)
      wheel.castShadow = true
      const hubcap = new Mesh(this.hubGeometry, this.hub)
      wheel.add(hubcap)
      group.add(wheel)
      wheels.push(wheel)
    }

    // steering wheel in front of the driver seat, facing the driver (+z look)
    const steering = new Mesh(this.steeringGeometry, this.rubber)
    const seat = v.seats[0]
    steering.position.set(seat.x, seat.y + 0.35, seat.z - 0.45)
    steering.rotation.x = -0.35 // raked like a dashboard column
    group.add(steering)

    return { group, chassis, chassisT, wheels, steering, version: v.version }
  }
}

/**
 * Chassis grid → opaque + transparent BufferGeometries (chunk material
 * contract: 'mat'/'ao' vertex attributes). Same approach as body-meshes.ts
 * but with the glass stream split out so car windows stay see-through (T39).
 */
function buildChassisGeometries(v: VehicleEntity): { opaque: BufferGeometry; transparent: BufferGeometry | null } {
  const { grid, sx, sy, sz } = v
  const sample = (x: number, y: number, z: number): number =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz ? grid[x + z * sx + y * sx * sz] : 0

  const streams = { opaque: makeAccum(), transparent: makeAccum() }
  for (let cy = 0; cy * CHUNK < sy; cy++) {
    for (let cz = 0; cz * CHUNK < sz; cz++) {
      for (let cx = 0; cx * CHUNK < sx; cx++) {
        const m = meshChunk(buildPaddedChunk(sample, cx, cy, cz))
        appendStream(streams.opaque, m.opaque, cx, cy, cz)
        appendStream(streams.transparent, m.transparent, cx, cy, cz)
      }
    }
  }
  return {
    opaque: toGeometry(streams.opaque),
    transparent: streams.transparent.positions.length > 0 ? toGeometry(streams.transparent) : null,
  }
}

interface Accum {
  positions: number[]
  normals: number[]
  uvs: number[]
  materials: number[]
  ao: number[]
  indices: number[]
}

const makeAccum = (): Accum => ({ positions: [], normals: [], uvs: [], materials: [], ao: [], indices: [] })

function appendStream(
  a: Accum,
  m: { quadCount: number; positions: ArrayLike<number>; normals: ArrayLike<number>; uvs: ArrayLike<number>; materials: ArrayLike<number>; ao: ArrayLike<number>; indices: ArrayLike<number> },
  cx: number,
  cy: number,
  cz: number,
): void {
  if (m.quadCount === 0) return
  const base = a.positions.length / 3
  for (let i = 0; i < m.positions.length; i += 3) {
    a.positions.push(
      (m.positions[i] + cx * CHUNK) * VOXEL_SIZE,
      (m.positions[i + 1] + cy * CHUNK) * VOXEL_SIZE,
      (m.positions[i + 2] + cz * CHUNK) * VOXEL_SIZE,
    )
  }
  for (let i = 0; i < m.normals.length; i++) a.normals.push(m.normals[i])
  for (let i = 0; i < m.uvs.length; i++) a.uvs.push(m.uvs[i])
  for (let i = 0; i < m.materials.length; i++) a.materials.push(m.materials[i])
  for (let i = 0; i < m.ao.length; i++) a.ao.push(m.ao[i])
  for (let i = 0; i < m.indices.length; i++) a.indices.push(m.indices[i] + base)
}

function toGeometry(a: Accum): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(a.positions), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(a.normals), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(a.uvs), 2))
  g.setAttribute('mat', new BufferAttribute(new Float32Array(a.materials), 1))
  g.setAttribute('ao', new BufferAttribute(new Float32Array(a.ao), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(a.indices), 1))
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------
// dev controls (T64.7) — testable NOW without gen changes
// ---------------------------------------------------------------------------

const DEV_ARCHETYPES = ['sedan1', 'sedan0', 'sedan2', 'pickup0', 'pickup1', 'van0']

/**
 * Dev-gated vehicle keys (game.ts wires this; see INTEGRATION-vehicles.md):
 *   KeyG  — summon a car ~6 m in front of the player (cycles archetypes)
 *   Enter — enter the nearest car / exit the current one
 * All effects go through sim.queue ops (V1). Returns an uninstall fn.
 */
export function installVehicleDevControls(
  sim: Sim,
  phys: PhysicsWorld,
  playerId: number,
  enabled: () => boolean,
): () => void {
  let nextArchetype = 0
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Enter') {
      const p = phys.players.get(playerId)
      if (!p) return
      const kind = p.seatedVehicle !== 0 ? 'vehicle_exit' : 'vehicle_enter'
      sim.queue.push({ tick: sim.tick, playerId, seq: nextSeq(), op: { kind } })
      return
    }
    if (e.code !== 'KeyG' || !enabled()) return
    const p = phys.players.get(playerId)
    if (!p) return
    // just ahead along the player's yaw (close enough that the driver seat is
    // inside ENTER_RANGE), dropped onto the ground surface
    const fx = -Math.sin(p.yaw)
    const fz = -Math.cos(p.yaw)
    const cx = p.px + fx * 4
    const cz = p.pz + fz * 4
    const vx = Math.floor(cx / VOXEL_SIZE)
    const vz = Math.floor(cz / VOXEL_SIZE)
    let groundY = p.py
    for (let vy = Math.min(WORLD_VY - 1, Math.floor((p.py + 2) / VOXEL_SIZE)); vy >= 0; vy--) {
      if (sim.world.getVoxel(vx, vy, vz) !== 0) {
        groundY = (vy + 1) * VOXEL_SIZE
        break
      }
    }
    const archetype = DEV_ARCHETYPES[nextArchetype++ % DEV_ARCHETYPES.length]
    sim.queue.push({
      tick: sim.tick,
      playerId,
      seq: nextSeq(),
      op: { kind: 'vehicle_spawn', archetype, x: cx, y: groundY, z: cz, yaw: p.yaw },
    })
  }
  document.addEventListener('keydown', onKey)
  return () => document.removeEventListener('keydown', onKey)
}
