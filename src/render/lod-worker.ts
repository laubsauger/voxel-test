/**
 * T90 — coarse-LOD mesh worker: runs meshCoarse for LOD cells off the main
 * thread (the 128×~48×128 greedy pass was 36-82ms and hitched every LOD-band
 * crossing while driving/flying). Same transferable-buffers pattern as
 * mesh-worker.ts. Render-only (V6) — no determinism concerns.
 */
import { meshCoarse } from './mesh-coarse'
import type { ChunkMesh } from './mesher'

export interface LodMeshRequest {
  ci: number
  /** generation counter — manager drops stale responses (evict/rebuild races) */
  gen: number
  /** downsampled cell grid (transferred) */
  grid: ArrayBuffer
  gxz: number
  gy: number
}

export interface LodMeshResponse {
  ci: number
  gen: number
  opaque: ChunkMesh
  transparent: ChunkMesh
}

const ctx = self as unknown as Worker

const transfers = (m: ChunkMesh): ArrayBuffer[] => [
  m.positions.buffer as ArrayBuffer,
  m.normals.buffer as ArrayBuffer,
  m.uvs.buffer as ArrayBuffer,
  m.materials.buffer as ArrayBuffer,
  m.ao.buffer as ArrayBuffer,
  m.indices.buffer as ArrayBuffer,
]

ctx.onmessage = (e: MessageEvent<LodMeshRequest>) => {
  const { ci, gen, grid, gxz, gy } = e.data
  const { opaque, transparent } = meshCoarse(new Uint8Array(grid), gxz, gy, gxz)
  const msg: LodMeshResponse = { ci, gen, opaque, transparent }
  ctx.postMessage(msg, [...transfers(opaque), ...transfers(transparent)])
}
