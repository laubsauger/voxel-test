/**
 * T8 — TSL node material for chunk meshes (WebGPURenderer).
 *
 * Per-vertex attributes from the mesher:
 *   'mat' — material id (float, flat across each quad)
 *   'ao'  — voxel AO level 0..3 (T7)
 *
 * The I.mat table is uploaded as small uniform arrays (16 entries): color
 * ramp lo/hi, roughness, metalness, emissive. Fragment picks its entry by
 * id, mixes the ramp with a per-voxel hash (stable spatial variation — this
 * is visual salt, not sim randomness; render layer may be non-deterministic),
 * and darkens by baked AO.
 */
import { Color, FrontSide, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  float,
  hash,
  mix,
  normalWorld,
  positionWorld,
  uniformArray,
  vec3,
} from 'three/tsl'
import { VOXEL_SIZE } from '../world/chunks'
import { MATERIALS } from './materials'

export function createChunkMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()

  // B4: render front faces into the shadow map (three's default is back
  // faces). Voxel walls/roofs are a single voxel (10cm) thick — back-face
  // depth sits on the interior surface, so bias + far-cascade texel error
  // let light bleed through wall/roof/floor joins. Front-face depth puts
  // interiors a full wall thickness below the stored depth: no leaks.
  // Acne on lit faces is handled by the sun's normalBias (world-renderer).
  material.shadowSide = FrontSide

  const rampLo = uniformArray<'color'>(MATERIALS.map((m) => new Color(m.colorRamp[0])), 'color')
  const rampHi = uniformArray<'color'>(MATERIALS.map((m) => new Color(m.colorRamp[1])), 'color')
  const roughness = uniformArray<'float'>(MATERIALS.map((m) => m.roughness), 'float')
  const metalness = uniformArray<'float'>(MATERIALS.map((m) => m.metalness), 'float')
  const emissive = uniformArray<'float'>(MATERIALS.map((m) => m.emissive), 'float')

  // 'mat' is constant across a quad; +0.5 then truncate = round-to-nearest
  const matId = attribute<'float'>('mat', 'float').add(0.5).toInt()
  // AO level 0..3 → occlusion factor; keep a floor so pits stay readable
  const ao = attribute<'float'>('ao', 'float').div(3)
  const aoShade = mix(float(0.45), float(1.0), ao)

  // stable per-voxel hash: sample half a voxel behind the face so faces on
  // voxel boundaries land inside their owning voxel
  const cell = positionWorld
    .sub(normalWorld.mul(VOXEL_SIZE * 0.5))
    .div(VOXEL_SIZE)
    .floor()
  const salt = hash(cell.dot(vec3(127.1, 311.7, 74.7)))

  const base = mix(rampLo.element(matId), rampHi.element(matId), salt)
  material.colorNode = base.mul(aoShade)
  material.roughnessNode = roughness.element(matId)
  material.metalnessNode = metalness.element(matId)
  // emissive materials (lamp) feed the bloom pass
  material.emissiveNode = base.mul(emissive.element(matId))

  return material
}
