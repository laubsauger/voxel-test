import { BufferAttribute, BufferGeometry, Mesh, Object3D, type Material } from 'three/webgpu'
import type { DynamicBody } from '../sim/physics'
import { VOXEL_SIZE, CHUNK } from '../world/chunks'
import { buildPaddedChunk, meshChunk } from './mesher'

/**
 * Render dynamic island bodies (T12) — one mesh per body, rebuilt when the
 * body's grid version bumps (further destruction), transform synced from
 * Jolt every frame. Render-only (V6): reads phys.bodies, writes nothing.
 * Reuses the pure chunk mesher over the body's local grid in 32³ sections.
 */
export class BodyMeshes {
  private readonly meshes = new Map<number, { mesh: Mesh; version: number }>()

  constructor(
    private readonly parent: Object3D,
    private readonly material: Material,
  ) {}

  get count(): number {
    return this.meshes.size
  }

  update(bodies: ReadonlyMap<number, DynamicBody>): void {
    // remove meshes whose body is gone
    for (const [id, entry] of this.meshes) {
      if (!bodies.has(id)) {
        entry.mesh.geometry.dispose()
        this.parent.remove(entry.mesh)
        this.meshes.delete(id)
      }
    }
    for (const [id, body] of bodies) {
      let entry = this.meshes.get(id)
      if (!entry || entry.version !== body.version) {
        const geometry = buildBodyGeometry(body)
        if (entry) {
          entry.mesh.geometry.dispose()
          entry.mesh.geometry = geometry
          entry.version = body.version
        } else {
          const mesh = new Mesh(geometry, this.material)
          mesh.castShadow = true
          mesh.receiveShadow = true
          entry = { mesh, version: body.version }
          this.meshes.set(id, entry)
          this.parent.add(mesh)
        }
      }
      entry.mesh.position.set(body.px, body.py, body.pz)
      entry.mesh.quaternion.set(body.qx, body.qy, body.qz, body.qw)
    }
  }
}

export function buildBodyGeometry(body: DynamicBody): BufferGeometry {
  const { grid, sx, sy, sz } = body
  const sample = (x: number, y: number, z: number): number =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz
      ? grid[x + z * sx + y * sx * sz]
      : 0

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const materials: number[] = []
  const ao: number[] = []
  const indices: number[] = []

  for (let cy = 0; cy * CHUNK < sy; cy++) {
    for (let cz = 0; cz * CHUNK < sz; cz++) {
      for (let cx = 0; cx * CHUNK < sx; cx++) {
        const streams = meshChunk(buildPaddedChunk(sample, cx, cy, cz))
        // T39: bodies keep a single mesh on the opaque chunk material —
        // transparent faces (glass debris) merge in and render opaque, same
        // as pre-T39 (fine for tumbling rubble)
        for (const m of [streams.opaque, streams.transparent]) {
          if (m.quadCount === 0) continue
          const base = positions.length / 3
          for (let i = 0; i < m.positions.length; i += 3) {
            positions.push(
              (m.positions[i] + cx * CHUNK) * VOXEL_SIZE,
              (m.positions[i + 1] + cy * CHUNK) * VOXEL_SIZE,
              (m.positions[i + 2] + cz * CHUNK) * VOXEL_SIZE,
            )
          }
          for (let i = 0; i < m.normals.length; i++) normals.push(m.normals[i])
          for (let i = 0; i < m.uvs.length; i++) uvs.push(m.uvs[i])
          for (let i = 0; i < m.materials.length; i++) materials.push(m.materials[i])
          for (let i = 0; i < m.ao.length; i++) ao.push(m.ao[i])
          for (let i = 0; i < m.indices.length; i++) indices.push(m.indices[i] + base)
        }
      }
    }
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  g.setAttribute('mat', new BufferAttribute(new Float32Array(materials), 1))
  g.setAttribute('ao', new BufferAttribute(new Float32Array(ao), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1))
  g.computeBoundingSphere()
  return g
}
