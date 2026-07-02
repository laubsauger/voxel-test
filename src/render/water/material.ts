/**
 * T16 — TSL water material for WebGPURenderer. Render layer only (V6).
 *
 * Refraction-ish look via physical transmission + IOR; absorption tint by
 * depth: the extractor writes a per-vertex `waterDepth` attribute (meters of
 * water below the surface) and the material darkens/saturates with
 * exp(-absorption * depth) — shallow edges read pale and clear, pool centers
 * read deep. Floats are fine here: render-only, never part of sim state.
 */

import { Color, DoubleSide, MeshPhysicalNodeMaterial } from 'three/webgpu'
import { attribute, color, exp, float, mix } from 'three/tsl'

export interface WaterMaterialOptions {
  /** absorption coefficient per meter of water depth */
  absorption?: number
  shallowColor?: number
  deepColor?: number
}

export function createWaterMaterial(opts: WaterMaterialOptions = {}): MeshPhysicalNodeMaterial {
  const absorption = opts.absorption ?? 2.2
  const shallow = new Color(opts.shallowColor ?? 0x5fb8d4)
  const deep = new Color(opts.deepColor ?? 0x03222f)

  const mat = new MeshPhysicalNodeMaterial()
  const depth = attribute<'float'>('waterDepth', 'float')
  /** 1 at a thin film → 0 for deep water (Beer–Lambert-ish falloff) */
  const clarity = exp(depth.mul(-absorption))

  mat.colorNode = mix(color(deep), color(shallow), clarity)
  mat.opacityNode = mix(float(0.95), float(0.55), clarity)
  mat.transparent = true
  mat.transmission = 0.7 // refraction-ish see-through, tinted by colorNode
  mat.ior = 1.33
  mat.roughness = 0.07
  mat.metalness = 0
  mat.side = DoubleSide // water visible from below/inside too
  mat.depthWrite = false
  return mat
}
