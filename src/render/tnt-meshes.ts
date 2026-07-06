/**
 * P19 — placed TNT charge renderer. Follows the BodyMeshes pattern: reads
 * phys.charges once per frame, one visual per placed charge, writes no sim
 * state (V6). Charges vanish (with their mesh) when the remote detonator fires
 * and the sim removes them from the map.
 *
 * Visual: a red dynamite bundle (voxel-chunky box + light wrap band) with a
 * small dark detonator nub and a faint blinking HDR sprite so armed charges
 * read at a glance (render-side blink — cosmetic, sim owns existence).
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
} from 'three/webgpu'
import { float, smoothstep, uniform, uv, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Charge } from '../sim/tnt'
import type { FxSystem } from './fx/fx-system'

let chargeGeometry: BufferGeometry | undefined

/** red bundle body + detonator nub, built once and shared */
function getChargeBodyGeometry(): BufferGeometry {
  if (chargeGeometry) return chargeGeometry
  const parts: BufferGeometry[] = [
    new BoxGeometry(0.3, 0.26, 0.24).translate(0, 0.13, 0), // bundle
    new BoxGeometry(0.05, 0.14, 0.05).translate(0, 0.32, 0), // detonator nub
  ]
  chargeGeometry = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return chargeGeometry
}

let bandGeometry: BufferGeometry | undefined
function getBandGeometry(): BufferGeometry {
  return (bandGeometry ??= new BoxGeometry(0.31, 0.07, 0.25).translate(0, 0.13, 0))
}

const bodyMaterial = /* lazy */ (() => {
  let m: MeshStandardMaterial | undefined
  return () => (m ??= new MeshStandardMaterial({ color: 0xb0342a, roughness: 0.85 }))
})()
const bandMaterial = /* lazy */ (() => {
  let m: MeshStandardMaterial | undefined
  return () => (m ??= new MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8 }))
})()

interface Entry {
  group: Group
}

export class TntMeshes {
  private readonly entries = new Map<number, Entry>()
  private readonly blinkGain = uniform(1)
  private readonly blinkMaterial: SpriteNodeMaterial
  private time = 0

  constructor(
    private readonly parent: Object3D,
    private readonly _fx: FxSystem | null = null,
  ) {
    const m = new SpriteNodeMaterial()
    const d = uv().sub(0.5).length().mul(2)
    m.colorNode = vec3(8, 0.6, 0.4).mul(this.blinkGain)
    m.opacityNode = float(1).sub(smoothstep(float(0.1), float(1), d))
    m.transparent = true
    m.depthWrite = false
    m.blending = AdditiveBlending
    this.blinkMaterial = m
  }

  get count(): number {
    return this.entries.size
  }

  update(charges: ReadonlyMap<number, Charge>, dt: number): void {
    this.time += dt
    // armed-light blink (render-side, cosmetic)
    this.blinkGain.value = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.time * 6))

    for (const [id, e] of this.entries) {
      if (!charges.has(id)) {
        this.parent.remove(e.group)
        this.entries.delete(id)
      }
    }

    for (const [id, c] of charges) {
      let e = this.entries.get(id)
      if (!e) {
        const group = new Group()
        const body = new Mesh(getChargeBodyGeometry(), bodyMaterial())
        body.castShadow = true
        const band = new Mesh(getBandGeometry(), bandMaterial())
        const light = new Sprite(this.blinkMaterial)
        light.scale.setScalar(0.08)
        light.position.set(0, 0.42, 0)
        group.add(body, band, light)
        e = { group }
        this.entries.set(id, e)
        this.parent.add(group)
      }
      // charge y is the center of the resting voxel; drop the bundle so it
      // sits ON that surface rather than floating at cell center
      e.group.position.set(c.x, c.y - 0.5 * 0.1, c.z)
    }
  }
}
