/**
 * T6 — thin Worker wrapper around the pure mesher (V7: meshing off the main
 * thread). Spawned by ChunkMeshManager via
 * `new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })`.
 * All buffers cross the boundary as transferables — zero copies.
 */
import { meshChunk, type ChunkMesh } from './mesher'

export interface MeshRequest {
  /** chunk index in the store */
  ci: number
  /** monotonic per-chunk job version — manager drops stale results */
  version: number
  /** padded 34³ voxel grid, transferred */
  padded: ArrayBuffer
}

export interface MeshResponse extends ChunkMesh {
  ci: number
  version: number
}

const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { ci, version, padded } = e.data
  const mesh = meshChunk(new Uint8Array(padded))
  const msg: MeshResponse = { ci, version, ...mesh }
  ctx.postMessage(msg, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.uvs.buffer,
    mesh.materials.buffer,
    mesh.ao.buffer,
    mesh.indices.buffer,
  ])
}
