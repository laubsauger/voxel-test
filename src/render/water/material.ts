/**
 * T16/T61 — TSL water material for WebGPURenderer. Render layer only (V6).
 *
 * Built per the threejs-water-optics "normal-only wave bundle": the voxel
 * water mesh stays flat, all wave motion lives in the normal. Two scrolling
 * gravity-wave bands (dispersion omega = sqrt(9.81·k)) perturb the +y
 * surface normal; a third short "chop" band fades in through the per-vertex
 * `waterFlow` attribute the extractor writes for recently-disturbed cells,
 * so breaches/splashes shimmer while a calm pool keeps long lazy ripples.
 *
 * Optics:
 *  - side-aware Fresnel: F = F0 + (1-F0)·(1-|N·V|)^5 on the rippled normal,
 *    used to boost opacity and blend a sky tint at grazing angles — grazing
 *    reflection reads without SSR (budget). Underwater/backface hits the
 *    same lobe through |N·V| (DoubleSide mesh).
 *  - Beer–Lambert absorption: per-channel transmittance
 *    exp(-absorption · depth) from the extractor's `waterDepth` (meters of
 *    water under the surface). Red dies first, deep water goes teal.
 *  - disturbance also widens the specular lobe (roughness), so churned
 *    water scatters the sun while a calm pool keeps a tight glint.
 * Floats are fine here: render-only, never part of sim state.
 */

import { Color, DoubleSide, MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  cos,
  exp,
  float,
  mix,
  normalGeometry,
  normalize,
  positionWorld,
  pow,
  time,
  vec2,
  vec3,
} from 'three/tsl'

export interface WaterMaterialOptions {
  /** per-channel absorption per meter of water depth (r dies first) */
  absorption?: [number, number, number]
  shallowColor?: number
  deepColor?: number
  /** grazing-angle tint (sky-ish) blended in by Fresnel */
  skyColor?: number
}

/** one scrolling gravity-wave band, defined by direction/wavelength/amplitude */
interface Band {
  dirX: number
  dirZ: number
  wavelength: number
  amplitude: number
  speedMul: number
}

/** pool-scale ripple bands (10cm voxels, backyard pools 2–8m across) */
const BAND_A: Band = { dirX: 0.94, dirZ: 0.32, wavelength: 1.7, amplitude: 0.055, speedMul: 1 }
const BAND_B: Band = { dirX: -0.42, dirZ: 0.91, wavelength: 0.8, amplitude: 0.03, speedMul: 1 }
/** short chop band, only where the sim recently moved water (waterFlow attr) */
const BAND_CHOP: Band = { dirX: 0.6, dirZ: -0.8, wavelength: 0.35, amplitude: 0.085, speedMul: 1.6 }

export function createWaterMaterial(opts: WaterMaterialOptions = {}): MeshPhysicalNodeMaterial {
  const absorption = opts.absorption ?? [3.1, 0.85, 0.5]
  const shallow = new Color(opts.shallowColor ?? 0x74c7dc)
  const deep = new Color(opts.deepColor ?? 0x02222e)
  const sky = new Color(opts.skyColor ?? 0xa8c8e6)

  const mat = new MeshPhysicalNodeMaterial()
  const depth = attribute<'float'>('waterDepth', 'float')
  const flow = clamp(attribute<'float'>('waterFlow', 'float'), 0, 1)

  // ---- ripple normal (2 bands + flow-gated chop), +y faces only -------------
  /** surface height gradient (dh/dx, dh/dz) of one band at this fragment */
  const gradient = (b: Band) => {
    const k = (2 * Math.PI) / b.wavelength
    const omega = Math.sqrt(9.81 * k) * b.speedMul // deep-water dispersion
    const phase = positionWorld.x
      .mul(b.dirX * k)
      .add(positionWorld.z.mul(b.dirZ * k))
      .sub(time.mul(omega))
    const slope = cos(phase).mul(b.amplitude * k)
    return vec2(slope.mul(b.dirX), slope.mul(b.dirZ))
  }

  const gA = gradient(BAND_A)
  const gB = gradient(BAND_B)
  const gC = gradient(BAND_CHOP).mul(flow)
  const gx = gA.x.add(gB.x).add(gC.x)
  const gz = gA.y.add(gB.y).add(gC.y)
  const rippled = normalize(vec3(gx.negate(), 1, gz.negate()))
  // ripple only up-facing surface; side walls keep their face normal so the
  // closed skin (B20) stays visually watertight from the side
  const upness = clamp(normalGeometry.y, 0, 1)
  const rippleNormal = normalize(mix(normalGeometry, rippled, upness))

  mat.normalNode = rippleNormal

  // ---- side-aware Fresnel ----------------------------------------------------
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const facing = rippleNormal.dot(viewDir).abs().clamp(0, 1)
  const f0 = float(0.02) // air→water; |N·V| makes the backface reuse the lobe
  const fresnel = f0.add(f0.oneMinus().mul(pow(facing.oneMinus(), 5)))

  // ---- Beer–Lambert absorption ------------------------------------------------
  const transmit = exp(vec3(-absorption[0], -absorption[1], -absorption[2]).mul(depth))
  // per-channel lerp deep→shallow by transmittance (mix() types want scalar t)
  const bodyColor = vec3(shallow.r, shallow.g, shallow.b)
    .mul(transmit)
    .add(vec3(deep.r, deep.g, deep.b).mul(transmit.oneMinus()))

  mat.colorNode = mix(bodyColor, color(sky), fresnel.mul(0.8))
  // grazing angles read reflective/opaque; straight down into shallow water stays glassy
  const clarity = transmit.dot(vec3(0.333, 0.333, 0.334))
  mat.opacityNode = clamp(mix(float(0.92), float(0.6), clarity).add(fresnel.mul(0.5)), 0, 0.97)
  mat.transparent = true
  mat.transmission = 0.6 // refraction-ish see-through, tinted by colorNode
  mat.ior = 1.33
  mat.roughnessNode = mix(float(0.06), float(0.28), flow)
  mat.metalness = 0
  mat.side = DoubleSide // water visible from below/inside too
  mat.depthWrite = false
  return mat
}
