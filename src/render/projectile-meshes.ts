/**
 * T54 — bomb projectile renderer. Follows the BodyMeshes pattern: reads
 * phys.projectiles once per frame, one visual per live projectile, writes no
 * sim state (V6).
 *
 * Visual: classic cartoon bomb — a black voxel sphere (~0.4 m, merged 10 cm
 * cubes so it sits in the voxel art style), a short grey fuse stub on top and
 * a flickering HDR spark sprite at the fuse tip (bloom picks it up for free).
 * Airborne bombs tumble (render-side spin — cosmetic, sim owns position) and
 * leave a smoke/spark trail through the FxSystem.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu'
import { float, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Projectile } from '../sim/projectiles'
import type { FxSystem } from './fx/fx-system'

const VOX = 0.1
/** trail puff cadence while airborne, seconds */
const TRAIL_DT = 0.05
/** fuse sputter cadence, seconds */
const SPARK_DT = 0.12

let bombGeometry: BufferGeometry | undefined

/** black voxel sphere (r ≈ 0.2 m) + fuse stub, built once and shared */
function getBombGeometry(): BufferGeometry {
  if (bombGeometry) return bombGeometry
  const parts: BufferGeometry[] = []
  for (let i = -2; i < 2; i++) {
    for (let j = -2; j < 2; j++) {
      for (let k = -2; k < 2; k++) {
        const cx = (i + 0.5) * VOX
        const cy = (j + 0.5) * VOX
        const cz = (k + 0.5) * VOX
        if (Math.sqrt(cx * cx + cy * cy + cz * cz) > 0.19) continue
        parts.push(new BoxGeometry(VOX, VOX, VOX).translate(cx, cy, cz))
      }
    }
  }
  // fuse stub — half-voxel column poking out the top
  parts.push(new BoxGeometry(0.05, 0.1, 0.05).translate(0, 0.235, 0))
  bombGeometry = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return bombGeometry
}

const bombMaterial = /* lazy */ (() => {
  let m: MeshStandardMaterial | undefined
  return () => (m ??= new MeshStandardMaterial({ color: 0x16161a, roughness: 0.55, metalness: 0.25 }))
})()

interface Entry {
  group: Group
  spark: Sprite
  angle: number
  axis: Vector3
  trailAcc: number
  sparkAcc: number
}

export class ProjectileMeshes {
  private readonly entries = new Map<number, Entry>()
  /** shared flicker gain for every fuse spark */
  private readonly sparkGain = uniform(1)
  private readonly sparkMaterial: SpriteNodeMaterial

  constructor(
    private readonly parent: Object3D,
    private readonly fx: FxSystem | null = null,
  ) {
    const m = new SpriteNodeMaterial()
    const d = uv().sub(0.5).length().mul(2)
    m.colorNode = vec3(8, 4.2, 1.2).mul(this.sparkGain)
    m.opacityNode = float(1).sub(smoothstep(float(0.1), float(1), d))
    m.transparent = true
    m.depthWrite = false
    m.blending = AdditiveBlending
    this.sparkMaterial = m
  }

  get count(): number {
    return this.entries.size
  }

  update(projectiles: ReadonlyMap<number, Projectile>, dt: number): void {
    // drop visuals whose projectile detonated/despawned
    for (const [id, e] of this.entries) {
      if (!projectiles.has(id)) {
        this.parent.remove(e.group)
        this.entries.delete(id)
      }
    }
    // fuse flicker (shared uniform, Math.random is render-side salt)
    this.sparkGain.value = 0.6 + Math.random() * 0.9

    for (const [id, p] of projectiles) {
      let e = this.entries.get(id)
      if (!e) {
        const group = new Group()
        const mesh = new Mesh(getBombGeometry(), bombMaterial())
        mesh.castShadow = true
        const spark = new Sprite(this.sparkMaterial)
        spark.scale.setScalar(0.09)
        spark.position.set(0, 0.3, 0)
        group.add(mesh, spark)
        e = { group, spark, angle: 0, axis: new Vector3(1, 0, 0), trailAcc: 0, sparkAcc: 0 }
        this.entries.set(id, e)
        this.parent.add(group)
      }
      e.group.position.set(p.x, p.y, p.z)

      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
      if (!p.resting && speed > 0.3) {
        // tumble around the rolling axis (up × velocity), rate ∝ speed
        e.axis.set(-p.vz, 0, p.vx)
        if (e.axis.lengthSq() < 1e-6) e.axis.set(1, 0, 0)
        e.axis.normalize()
        e.angle += (speed / 0.2) * 0.55 * dt
        e.group.quaternion.setFromAxisAngle(e.axis, e.angle)
        // smoke trail while flying
        e.trailAcc += dt
        while (e.trailAcc >= TRAIL_DT) {
          e.trailAcc -= TRAIL_DT
          this.fx?.bombTrail(p.x, p.y + 0.1, p.z)
        }
      }
      // fuse sputters whether flying or resting — the countdown is visible
      e.sparkAcc += dt
      while (e.sparkAcc >= SPARK_DT) {
        e.sparkAcc -= SPARK_DT
        const tip = e.spark.getWorldPosition(_tip)
        this.fx?.fuseSpark(tip.x, tip.y, tip.z)
      }
    }
  }
}

const _tip = new Vector3()
