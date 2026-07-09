/**
 * T77 — render death ragdolls: 6 boxes per ragdoll (head, torso, arms, legs)
 * with the same proportions and color zones as the PlayerMesh segments,
 * transforms synced from the sim ragdoll parts every frame.
 *
 * Read-only pattern (V6), following body-meshes.ts / vehicle-meshes.ts:
 * reads phys.ragdolls, writes nothing back. Geometries + materials are
 * module-static and shared across all ragdolls (never disposed — same
 * lifetime policy as PlayerMesh's VOXEL_GEO/BODY_MAT).
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three/webgpu'
import { VOXEL_SIZE } from '../world/chunks'
import { PLAYER_HEIGHT, SEGMENT_DEFS } from '../sim/player'
import type { RagdollEntity } from '../sim/ragdoll'
import { COLOR_PANTS, COLOR_SHIRT, COLOR_SKIN } from './player-mesh'

/** body authored at 18 vox = 1.8 m, scaled to the capsule height (player-mesh) */
const SCALE = PLAYER_HEIGHT / 1.8
/** head renders slightly oversized to match PlayerMesh's HEAD_SCALE */
const HEAD_SCALE = 1.18

/** per-part color, index-aligned with SEGMENT_DEFS (head, torso, armL/R, legL/R) */
const PART_COLORS = [COLOR_SKIN, COLOR_SHIRT, COLOR_SKIN, COLOR_SKIN, COLOR_PANTS, COLOR_PANTS]

const MATERIALS = PART_COLORS.map(
  (color) => new MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 }),
)
const GEOMETRIES = SEGMENT_DEFS.map(
  (d) => new BoxGeometry(d.sx * VOXEL_SIZE * SCALE, d.sy * VOXEL_SIZE * SCALE, d.sz * VOXEL_SIZE * SCALE),
)

export class RagdollMeshes {
  private readonly entries = new Map<number, { group: Group; parts: Mesh[] }>()

  constructor(private readonly parent: Object3D) {}

  get count(): number {
    return this.entries.size
  }

  update(ragdolls: ReadonlyMap<number, RagdollEntity>): void {
    // drop meshes whose ragdoll despawned (shared geometry/materials — no dispose)
    for (const [id, entry] of this.entries) {
      if (!ragdolls.has(id)) {
        this.parent.remove(entry.group)
        this.entries.delete(id)
      }
    }
    for (const [id, r] of ragdolls) {
      let entry = this.entries.get(id)
      if (!entry) {
        const group = new Group()
        group.name = 'ragdoll'
        const parts: Mesh[] = []
        for (let i = 0; i < SEGMENT_DEFS.length; i++) {
          const mesh = new Mesh(GEOMETRIES[i], MATERIALS[i])
          mesh.castShadow = true
          if (i === 0) mesh.scale.setScalar(HEAD_SCALE) // head, like PlayerMesh
          group.add(mesh)
          parts.push(mesh)
        }
        entry = { group, parts }
        this.entries.set(id, entry)
        this.parent.add(group)
      }
      for (let i = 0; i < entry.parts.length; i++) {
        const p = r.parts[i]
        entry.parts[i].position.set(p.px, p.py, p.pz)
        entry.parts[i].quaternion.set(p.qx, p.qy, p.qz, p.qw)
      }
    }
  }
}
