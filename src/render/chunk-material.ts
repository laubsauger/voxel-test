/**
 * T8/T29 — TSL node material for chunk meshes (WebGPURenderer).
 *
 * Per-vertex attributes from the mesher:
 *   'mat' — material id (float, flat across each quad)
 *   'ao'  — voxel AO level 0..3 (T7)
 *
 * T29: world-space triplanar PBR texturing. Textured materials sample two
 * DataArrayTextures (albedo sRGB + packed normal/rough/AO, one layer per
 * material — see texture-arrays.ts) projected along all three axes and
 * blended by the surface normal; cut surfaces need no UVs, which is the
 * point. Materials without a texture set keep the flat color-ramp path,
 * selected per-fragment by the 'mat' attribute.
 *
 * B8: per-voxel tint variation is FLAT per voxel — the spatial hash samples
 * the voxel CELL (half a voxel behind the face, floor + epsilon), never
 * interpolates inside a voxel, and its amplitude is per-material (organic
 * high, smooth manufactured surfaces near-zero) so flat plaster/concrete
 * walls read smooth instead of noisy fake-AO patchwork. The epsilon keeps
 * floor() off exact voxel boundaries where f32 interpolation error across a
 * merged quad's two triangles flickered the cell id (diagonal seams).
 */
import { Color, FrontSide, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  float,
  hash,
  mix,
  normalWorld,
  positionWorld,
  texture,
  transformNormalToView,
  uniform,
  uniformArray,
  vec3,
} from 'three/tsl'
import { VOXEL_SIZE } from '../world/chunks'
import { MATERIALS } from './materials'
import type { ChunkTextures } from './texture-arrays'

/**
 * T58 — night boost for emissive materials (lamp id 13 is the only emissive
 * entry). WorldRenderer's day cycle drives this per frame (1 by day, ~3 at
 * night) so street lamps visibly carry the scene after dark via bloom.
 * Module-level uniform: shared by every chunk material instance (single
 * renderer per page).
 */
export const emissiveNightBoost = uniform(1)

/** shared per-fragment nodes: material id, voxel AO shade, flat voxel salt */
function chunkCommonNodes() {
  // 'mat' is constant across a quad; +0.5 then truncate = round-to-nearest
  const matId = attribute<'float'>('mat', 'float').add(0.5).toInt()
  // AO level 0..3 → occlusion factor; keep a floor so pits stay readable
  const ao = attribute<'float'>('ao', 'float').div(3)
  const aoShade = mix(float(0.45), float(1.0), ao)

  // B8: stable per-voxel cell — sample half a voxel behind the face so faces
  // on voxel boundaries land inside their owning voxel; +2e-3 voxel epsilon
  // keeps floor() away from exact-integer boundaries where f32 interpolation
  // error across a merged quad's two triangles flickered the cell id
  // (diagonal seams / per-voxel gradient noise)
  const cell = positionWorld
    .sub(normalWorld.mul(VOXEL_SIZE * 0.5))
    .div(VOXEL_SIZE)
    .add(0.002)
    .floor()
  const salt = hash(cell.dot(vec3(127.1, 311.7, 74.7)))

  const variation = uniformArray<'float'>(MATERIALS.map((m) => m.variation), 'float')
  // per-material amplitude: 0 → ramp midpoint (flat), 1 → full lo..hi swing
  const rampT = mix(float(0.5), salt, variation.element(matId))

  const rampLo = uniformArray<'color'>(MATERIALS.map((m) => new Color(m.colorRamp[0])), 'color')
  const rampHi = uniformArray<'color'>(MATERIALS.map((m) => new Color(m.colorRamp[1])), 'color')
  const lo = rampLo.element(matId)
  const hi = rampHi.element(matId)
  const rampColor = mix(lo, hi, rampT)

  return { matId, aoShade, rampColor, lo, hi }
}

export function createChunkMaterial(textures?: ChunkTextures): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()

  // B4: render front faces into the shadow map (three's default is back
  // faces). Voxel walls/roofs are a single voxel (10cm) thick — back-face
  // depth sits on the interior surface, so bias + far-cascade texel error
  // let light bleed through wall/roof/floor joins into interiors. Front-face
  // depth puts interiors a full wall thickness below the stored depth: no
  // leaks. Acne on lit faces is handled by the sun's normalBias
  // (world-renderer). Any other world-geometry material must do the same.
  material.shadowSide = FrontSide

  const roughness = uniformArray<'float'>(MATERIALS.map((m) => m.roughness), 'float')
  const metalness = uniformArray<'float'>(MATERIALS.map((m) => m.metalness), 'float')
  const emissive = uniformArray<'float'>(MATERIALS.map((m) => m.emissive), 'float')

  const { matId, aoShade, rampColor, lo, hi } = chunkCommonNodes()

  if (!textures) {
    // flat ramp path only (tests / fallback)
    material.colorNode = rampColor.mul(aoShade)
    material.roughnessNode = roughness.element(matId)
    material.metalnessNode = metalness.element(matId)
    material.emissiveNode = rampColor.mul(emissive.element(matId)).mul(emissiveNightBoost)
    return material
  }

  const layerArr = uniformArray<'float'>(Array.from(textures.layerForMat), 'float')
  const uvScaleArr = uniformArray<'float'>(Array.from(textures.uvScaleForMat), 'float')

  const layerF = layerArr.element(matId)
  const hasTex = layerF.greaterThanEqual(0).select(float(1), float(0))
  const layer = layerF.max(0).add(0.5).toInt()
  const uvScale = uvScaleArr.element(matId)

  // world-space triplanar projection — blend weights from the geometry
  // normal (voxel faces are axis-aligned so weights are one-hot there, but
  // dynamic island bodies rotate: keep the full blend)
  const w4 = normalWorld.abs().pow(4)
  const wSum = w4.x.add(w4.y).add(w4.z)
  const w = w4.div(wSum)
  const p = positionWorld.mul(uvScale)
  const uvX = p.zy
  const uvY = p.xz
  const uvZ = p.xy

  const albedoTri = texture(textures.albedo, uvX)
    .depth(layer)
    .mul(w.x)
    .add(texture(textures.albedo, uvY).depth(layer).mul(w.y))
    .add(texture(textures.albedo, uvZ).depth(layer).mul(w.z))

  // packed maps: RG = tangent normal xy (GL), B = roughness, A = texture AO
  const nraX = texture(textures.normalRoughAo, uvX).depth(layer)
  const nraY = texture(textures.normalRoughAo, uvY).depth(layer)
  const nraZ = texture(textures.normalRoughAo, uvZ).depth(layer)

  // per-projection tangent-space → world-space normal (tangent frames of the
  // three projections; z reconstructed from unit length), whiteout-style blend
  const tnX = nraX.xy.mul(2).sub(1)
  const tnY = nraY.xy.mul(2).sub(1)
  const tnZ = nraZ.xy.mul(2).sub(1)
  const reconstructZ = (nxy: typeof tnX) => float(1).sub(nxy.dot(nxy)).max(0).sqrt()
  const sgn = normalWorld.sign()
  // uvX=(z,y): T=+z B=+y N=±x   uvY=(x,z): T=+x B=+z N=±y   uvZ=(x,y): T=+x B=+y N=±z
  const nX = vec3(sgn.x.mul(reconstructZ(tnX)), tnX.y, tnX.x)
  const nY = vec3(tnY.x, sgn.y.mul(reconstructZ(tnY)), tnY.y)
  const nZ = vec3(tnZ.x, tnZ.y, sgn.z.mul(reconstructZ(tnZ)))
  const mappedNormal = nX.mul(w.x).add(nY.mul(w.y)).add(nZ.mul(w.z)).normalize()
  material.normalNode = transformNormalToView(mix(normalWorld, mappedNormal, hasTex.mul(0.9)))

  // per-voxel ramp variation modulates the texture albedo subtly (voxel
  // charm, B8: flat per voxel): tint = ramp sample / ramp midpoint ≈ 1
  const rampMid = lo.rgb.add(hi.rgb).mul(0.5).max(vec3(1e-3))
  const tint = rampColor.div(rampMid)
  const texturedColor = albedoTri.rgb.mul(tint)
  const base = mix(rampColor, texturedColor, hasTex)

  const texRough = nraX.z.mul(w.x).add(nraY.z.mul(w.y)).add(nraZ.z.mul(w.z))
  const texAo = nraX.w.mul(w.x).add(nraY.w.mul(w.y)).add(nraZ.w.mul(w.z))
  // texture AO multiplies the baked voxel AO (kept partial so crevice detail
  // adds depth without crushing lit walls)
  const aoCombined = aoShade.mul(mix(float(1), texAo, hasTex.mul(0.85)))

  material.colorNode = base.mul(aoCombined)
  const roughScalar = roughness.element(matId)
  material.roughnessNode = mix(roughScalar, texRough.mul(roughScalar).mul(1.6).clamp(0, 1), hasTex)
  material.metalnessNode = metalness.element(matId)
  // emissive materials (lamp) feed the bloom pass; night cycle boosts them
  material.emissiveNode = base.mul(emissive.element(matId)).mul(emissiveNightBoost)

  return material
}

/**
 * T39 — material for the transparent geometry stream (glass 8, water-solid
 * 10). Alpha-blended fresnel glass: mostly see-through head-on, tinted by
 * the material ramp, more reflective/opaque at grazing angles. depthWrite
 * off (blends against what's behind); region meshes using it must not cast
 * shadows (ChunkMeshManager sets castShadow=false — B5 v1 call).
 */
export function createTransparentChunkMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.transparent = true
  material.depthWrite = false
  material.shadowSide = FrontSide // B4 safety if castShadow is ever enabled

  const roughness = uniformArray<'float'>(MATERIALS.map((m) => m.roughness), 'float')
  const { matId, aoShade, rampColor } = chunkCommonNodes()

  // fresnel: normal incidence stays glassy-clear, grazing angles pick up
  // sky/sun response and read as a reflective pane
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const fresnel = float(1).sub(normalWorld.dot(viewDir).abs()).clamp(0, 1).pow(2.5)

  material.colorNode = rampColor.mul(aoShade)
  material.opacityNode = fresnel.mul(0.55).add(0.3)
  material.roughnessNode = roughness.element(matId)
  material.metalnessNode = float(0)
  // faint emissive lift keeps panes visible against dark interiors
  material.emissiveNode = rampColor.mul(fresnel.mul(0.25))

  return material
}
