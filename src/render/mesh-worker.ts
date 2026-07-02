/**
 * T6 — thin Worker wrapper around the pure mesher (V7: meshing off the main
 * thread). Spawned by ChunkMeshManager via
 * `new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })`.
 * All buffers cross the boundary as transferables — zero copies.
 * T39: responses carry both geometry streams (opaque + transparent).
 */
import { meshChunk, type ChunkMesh, type ChunkMeshStreams } from './mesher'

export interface MeshRequest {
  /** chunk index in the store */
  ci: number
  /** monotonic per-chunk job version — manager drops stale results */
  version: number
  /** padded 34³ voxel grid, transferred */
  padded: ArrayBuffer
}

export interface MeshResponse extends ChunkMeshStreams {
  ci: number
  version: number
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

ctx.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { ci, version, padded } = e.data
  const mesh = meshChunk(new Uint8Array(padded))
  const msg: MeshResponse = { ci, version, ...mesh }
  ctx.postMessage(msg, [...transfers(mesh.opaque), ...transfers(mesh.transparent)])
}
