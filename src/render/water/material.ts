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

/**
 * Pool-scale ripple bands (10cm voxels, backyard pools 2–8m across).
 * P10: four low-amplitude octaves in DIFFERENT directions sum to an isotropic
 * shimmer — a single strong band read as diagonal "venetian-blind" stripes.
 * Wavelengths are long and amplitudes small so a resting pool is a calm,
 * gently-reflective sheet, not a corrugated one.
 */
const CALM_BANDS: readonly Band[] = [
  { dirX: 0.98, dirZ: 0.2, wavelength: 3.6, amplitude: 0.022, speedMul: 1 },
  { dirX: -0.28, dirZ: 0.96, wavelength: 2.7, amplitude: 0.016, speedMul: 1 },
  { dirX: 0.6, dirZ: -0.8, wavelength: 2.0, amplitude: 0.012, speedMul: 1 },
  { dirX: -0.86, dirZ: -0.51, wavelength: 1.5, amplitude: 0.0085, speedMul: 1 },
]
/** short chop band, only where the sim recently moved water (waterFlow attr) —
 *  P10: far gentler + longer than before so disturbance shimmers, not stripes */
const BAND_CHOP: Band = { dirX: 0.6, dirZ: -0.8, wavelength: 0.9, amplitude: 0.02, speedMul: 1.4 }

export function createWaterMaterial(opts: WaterMaterialOptions = {}): MeshPhysicalNodeMaterial {
  // P10: lighter, less red-hungry absorption so deep water stays a readable
  // teal instead of collapsing toward black; the deep floor is lifted well off
  // near-black so wave troughs never read as dark gaps.
  const absorption = opts.absorption ?? [1.7, 0.6, 0.4]
  const shallow = new Color(opts.shallowColor ?? 0x86d0e4)
  const deep = new Color(opts.deepColor ?? 0x0e4b5a)
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

  // sum the calm octaves (isotropic), then add the flow-gated chop on top
  const gA = gradient(CALM_BANDS[0])
  const gB = gradient(CALM_BANDS[1])
  const gC = gradient(CALM_BANDS[2])
  const gD = gradient(CALM_BANDS[3])
  const gChop = gradient(BAND_CHOP).mul(flow)
  const gx = gA.x.add(gB.x).add(gC.x).add(gD.x).add(gChop.x)
  const gz = gA.y.add(gB.y).add(gC.y).add(gD.y).add(gChop.y)
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
  const bodyOpacity = mix(float(0.92), float(0.6), clarity).add(fresnel.mul(0.5))
  // P11: the extractor emits a closed vertical skin at height steps (B20), but
  // a THIN disturbed column has tiny `waterDepth` → high transmittance → the
  // body-opacity above collapses toward 0.6 and, with transmission on, the
  // near-vertical side faces render see-through — reading as missing sides /
  // seams between neighbouring water columns of different heights. Force the
  // vertical skin (low upness = side/bottom faces) toward opaque so the closed
  // wall stays visible. Up-facing surface keeps its glassy body opacity.
  const sideness = upness.oneMinus()
  mat.opacityNode = clamp(mix(bodyOpacity, float(0.98), sideness.mul(0.9)), 0, 0.98)
  mat.transparent = true
  mat.transmission = 0.6 // refraction-ish see-through, tinted by colorNode
  mat.ior = 1.33
  mat.roughnessNode = mix(float(0.06), float(0.28), flow)
  mat.metalness = 0
  mat.side = DoubleSide // water visible from below/inside too
  mat.depthWrite = false
  return mat
}
