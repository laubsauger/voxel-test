/**
 * T29 — runtime PBR texture arrays for the chunk material.
 *
 * Loads the processed CC0 sets from public/textures/<mat>/ (see
 * scripts/textures/fetch-textures.mjs) into two DataArrayTextures:
 *
 *   albedo        rgba8 sRGB — color per textured material layer
 *   normalRoughAo rgba8 linear — R,G = tangent normal xy (GL convention,
 *                 z reconstructed in-shader), B = roughness, A = texture AO
 *
 * One layer per textured I.mat entry; `layerForMat[matId]` maps material id →
 * layer (-1 = untextured, shader keeps the flat color-ramp path). Layer
 * assignment derives from the canonical material NAMES (V13: ids stay owned
 * by src/sim/materials.ts).
 *
 * The arrays are allocated full-size up front with placeholder content
 * (albedo = ramp midpoint, flat normal, material roughness, open AO) so the
 * material compiles and first frames look like the pre-T29 flat look; one
 * needsUpdate re-uploads everything once all images decoded.
 */
import {
  Color,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu'
import { MATERIALS } from './materials'

/** material names (I.mat) with a texture set, in layer order */
export const TEXTURED_MATS = [
  'dirt',
  'grass',
  'asphalt',
  'concrete',
  'brick',
  'wood',
  'plaster',
  'metal',
  'rooftile',
] as const

/** texture repeats per world meter, per layer (tuned visually, T29) */
const UV_SCALE: Record<string, number> = {
  dirt: 0.5, // ~2m repeat — big organic features
  grass: 0.55,
  asphalt: 0.35, // large-scale asphalt grain
  concrete: 0.5,
  brick: 0.75, // mortar lines read at ~1.3m repeat
  wood: 0.7,
  plaster: 0.5,
  metal: 0.6,
  rooftile: 0.7,
}

export const TEXTURE_SIZE = 1024

export interface ChunkTextures {
  albedo: DataArrayTexture
  normalRoughAo: DataArrayTexture
  /** material id → array layer, -1 = untextured (flat ramp path) */
  layerForMat: Int32Array
  /** material id → uv repeats per world meter (0 for untextured) */
  uvScaleForMat: Float32Array
  /** resolves when all layers are decoded + uploaded flag set */
  ready: Promise<void>
}

function makeArrayTexture(data: Uint8Array, srgb: boolean): DataArrayTexture {
  const tex = new DataArrayTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, TEXTURED_MATS.length)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  if (srgb) tex.colorSpace = SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

async function fetchPixels(url: string): Promise<Uint8ClampedArray | null> {
  const res = await fetch(url)
  // dev servers answer missing files with the SPA index.html (200) — treat
  // any non-image response as absent
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null
  const bitmap = await createImageBitmap(await res.blob(), {
    resizeWidth: TEXTURE_SIZE,
    resizeHeight: TEXTURE_SIZE,
  })
  const canvas = new OffscreenCanvas(TEXTURE_SIZE, TEXTURE_SIZE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE).data
}

/**
 * Build the chunk texture arrays and kick off async loading. Base url is
 * usually '' (vite serves public/ at root).
 */
export function createChunkTextures(baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '')): ChunkTextures {
  const layers = TEXTURED_MATS.length
  const px = TEXTURE_SIZE * TEXTURE_SIZE
  const albedoData = new Uint8Array(px * 4 * layers)
  const nraData = new Uint8Array(px * 4 * layers)

  const layerForMat = new Int32Array(MATERIALS.length).fill(-1)
  const uvScaleForMat = new Float32Array(MATERIALS.length)
  const color = new Color()
  for (let layer = 0; layer < layers; layer++) {
    const name = TEXTURED_MATS[layer]
    const def = MATERIALS.find((m) => m.name === name)
    if (!def) throw new Error(`texture set '${name}' has no I.mat entry`) // V13 drift
    layerForMat[def.id] = layer
    uvScaleForMat[def.id] = UV_SCALE[name]

    // placeholder fill: ramp midpoint albedo, flat normal, scalar roughness
    color.setHex(def.colorRamp[0]).lerp(new Color(def.colorRamp[1]), 0.5)
    const r = Math.round(color.r * 255)
    const g = Math.round(color.g * 255)
    const b = Math.round(color.b * 255)
    const rough = Math.round(def.roughness * 255)
    const a0 = layer * px * 4
    for (let i = 0; i < px; i++) {
      albedoData[a0 + i * 4] = r
      albedoData[a0 + i * 4 + 1] = g
      albedoData[a0 + i * 4 + 2] = b
      albedoData[a0 + i * 4 + 3] = 255
      nraData[a0 + i * 4] = 128 // normal x
      nraData[a0 + i * 4 + 1] = 128 // normal y
      nraData[a0 + i * 4 + 2] = rough
      nraData[a0 + i * 4 + 3] = 255 // AO open
    }
  }

  const albedo = makeArrayTexture(albedoData, true)
  const normalRoughAo = makeArrayTexture(nraData, false)

  const loadLayer = async (layer: number): Promise<void> => {
    const name = TEXTURED_MATS[layer]
    const dir = `${baseUrl}/textures/${name}`
    const [alb, nrm, rgh, ao] = await Promise.all([
      fetchPixels(`${dir}/albedo.jpg`),
      fetchPixels(`${dir}/normal.jpg`),
      fetchPixels(`${dir}/roughness.jpg`),
      fetchPixels(`${dir}/ao.jpg`), // optional per set
    ])
    // fail loud (V10 spirit): a missing required map means the fetch script
    // didn't run or the deploy lost assets — silent flat look hides it
    if (!alb || !nrm || !rgh) throw new Error(`texture set '${name}' failed to load from ${dir}`)
    const a0 = layer * px * 4
    for (let i = 0; i < px; i++) {
      albedoData[a0 + i * 4] = alb[i * 4]
      albedoData[a0 + i * 4 + 1] = alb[i * 4 + 1]
      albedoData[a0 + i * 4 + 2] = alb[i * 4 + 2]
      nraData[a0 + i * 4] = nrm[i * 4]
      nraData[a0 + i * 4 + 1] = nrm[i * 4 + 1]
      nraData[a0 + i * 4 + 2] = rgh[i * 4]
      nraData[a0 + i * 4 + 3] = ao ? ao[i * 4] : 255
    }
  }

  const ready = Promise.all(
    Array.from({ length: layers }, (_, layer) => loadLayer(layer)),
  ).then(() => {
    albedo.needsUpdate = true
    normalRoughAo.needsUpdate = true
  })

  return { albedo, normalRoughAo, layerForMat, uvScaleForMat, ready }
}
