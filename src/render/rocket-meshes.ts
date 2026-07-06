/**
 * P19 — rocket-launcher projectile renderer. Follows the ProjectileMeshes /
 * BodyMeshes pattern: reads phys.rockets once per frame, one visual per live
 * rocket, writes no sim state (V6).
 *
 * Visual: a short metal dart (voxel-chunky body + warhead nose) oriented along
 * its velocity, an HDR exhaust glow sprite at the tail (bloom picks it up), a
 * hot smoke/spark trail through the FxSystem, and a one-shot backblast the
 * frame a rocket first appears (launch). The sim owns position/velocity; the
 * mesh only visualises them.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu'
import { float, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Rocket } from '../sim/rockets'
import type { FxSystem } from './fx/fx-system'

/** exhaust puff cadence while flying, seconds */
const TRAIL_DT = 0.02
/** local -z is the nose; the sim velocity is mapped onto it each frame */
const FORWARD = new Vector3(0, 0, -1)

let rocketGeometry: BufferGeometry | undefined

/** metal body + warhead nose, built once and shared (nose points -z) */
function getRocketGeometry(): BufferGeometry {
  if (rocketGeometry) return rocketGeometry
  const parts: BufferGeometry[] = [
    new BoxGeometry(0.12, 0.12, 0.4).translate(0, 0, 0.05), // body
    new BoxGeometry(0.09, 0.09, 0.14).translate(0, 0, -0.22), // warhead
    new BoxGeometry(0.22, 0.02, 0.08).translate(0, 0, 0.22), // fin (h)
    new BoxGeometry(0.02, 0.22, 0.08).translate(0, 0, 0.22), // fin (v)
  ]
  rocketGeometry = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return rocketGeometry
}

const rocketMaterial = /* lazy */ (() => {
  let m: MeshStandardMaterial | undefined
  return () => (m ??= new MeshStandardMaterial({ color: 0x6a7078, roughness: 0.4, metalness: 0.7 }))
})()

interface Entry {
  group: Group
  glow: Sprite
  trailAcc: number
}

export class RocketMeshes {
  private readonly entries = new Map<number, Entry>()
  private readonly glowGain = uniform(1)
  private readonly glowMaterial: SpriteNodeMaterial
  private readonly _q = new Quaternion()
  private readonly _dir = new Vector3()

  constructor(
    private readonly parent: Object3D,
    private readonly fx: FxSystem | null = null,
  ) {
    const m = new SpriteNodeMaterial()
    const d = uv().sub(0.5).length().mul(2)
    m.colorNode = vec3(9, 5, 1.6).mul(this.glowGain)
    m.opacityNode = float(1).sub(smoothstep(float(0.1), float(1), d))
    m.transparent = true
    m.depthWrite = false
    m.blending = AdditiveBlending
    this.glowMaterial = m
  }

  get count(): number {
    return this.entries.size
  }

  update(rockets: ReadonlyMap<number, Rocket>, dt: number): void {
    // drop visuals whose rocket detonated/despawned
    for (const [id, e] of this.entries) {
      if (!rockets.has(id)) {
        this.parent.remove(e.group)
        this.entries.delete(id)
      }
    }
    // shared exhaust flicker (render-side salt)
    this.glowGain.value = 0.7 + Math.random() * 0.8

    for (const [id, r] of rockets) {
      const speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy + r.vz * r.vz) || 1
      const nx = r.vx / speed, ny = r.vy / speed, nz = r.vz / speed
      let e = this.entries.get(id)
      if (!e) {
        const group = new Group()
        const mesh = new Mesh(getRocketGeometry(), rocketMaterial())
        mesh.castShadow = true
        const glow = new Sprite(this.glowMaterial)
        glow.scale.setScalar(0.16)
        glow.position.set(0, 0, 0.26) // tail
        group.add(mesh, glow)
        e = { group, glow, trailAcc: 0 }
        this.entries.set(id, e)
        this.parent.add(group)
        // launch backblast fired opposite the travel direction (once)
        this.fx?.rocketBackblast(r.x, r.y, r.z, nx, ny, nz)
      }
      e.group.position.set(r.x, r.y, r.z)
      // orient the nose (-z) along the velocity
      this._dir.set(nx, ny, nz)
      this._q.setFromUnitVectors(FORWARD, this._dir)
      e.group.quaternion.copy(this._q)

      // exhaust trail behind the tail
      e.trailAcc += dt
      while (e.trailAcc >= TRAIL_DT) {
        e.trailAcc -= TRAIL_DT
        this.fx?.rocketTrail(r.x - nx * 0.3, r.y - ny * 0.3, r.z - nz * 0.3)
      }
    }
  }
}
