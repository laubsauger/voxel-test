/**
 * T86 — render the LOCAL debris layer (V17): ACTIVE (moving) pieces are
 * individual meshes synced from body transforms each frame; FROZEN (settled)
 * pieces bake their world-transformed geometry into ONE merged batch mesh —
 * one draw call + one scene object, so render cost decouples from rubble
 * count (three.js's per-object cull iteration died past ~8k objects, B2).
 * A piece that unfreezes (shot/blast) degenerates out of the batch and comes
 * back as an individual mesh. Render-only (V6): reads the layer, writes nothing.
 *
 * Geometry uses the game's chunk mesher attributes (position/normal/uv/mat/ao)
 * so the SAME chunk material shades world, active debris, and batched rubble.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Sphere,
  Vector3,
  type Material,
} from 'three/webgpu'
import type { DebrisLayer } from '../sim/debris'
import { buildBodyGeometry } from './body-meshes'

const BATCH_VERTS = 600000
/** T97 — freeze-transition bakes per frame (each pays buildBodyGeometry) */
const BAKE_BUDGET = 6
const BATCH_INDICES = 1200000

const _m4 = new Matrix4()
const _nm = new Matrix3()
const _v = new Vector3()
const _q = new Quaternion()
const _n = new Vector3()

class RubbleBatch {
  private readonly pos = new Float32Array(BATCH_VERTS * 3)
  private readonly nor = new Float32Array(BATCH_VERTS * 3)
  private readonly uv = new Float32Array(BATCH_VERTS * 2)
  private readonly mat = new Float32Array(BATCH_VERTS)
  private readonly ao = new Float32Array(BATCH_VERTS)
  private readonly idx = new Uint32Array(BATCH_INDICES)
  private vHead = 0
  private iHead = 0
  private readonly ranges = new Map<number, { i0: number; ic: number }>()
  private readonly geom = new BufferGeometry()
  readonly mesh: Mesh

  constructor(material: Material) {
    this.geom.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geom.setAttribute('normal', new BufferAttribute(this.nor, 3))
    this.geom.setAttribute('uv', new BufferAttribute(this.uv, 2))
    this.geom.setAttribute('mat', new BufferAttribute(this.mat, 1))
    this.geom.setAttribute('ao', new BufferAttribute(this.ao, 1))
    this.geom.setIndex(new BufferAttribute(this.idx, 1))
    this.geom.setDrawRange(0, 0)
    this.geom.boundingSphere = new Sphere(new Vector3(), 1e6) // manual, never recompute
    this.mesh = new Mesh(this.geom, material)
    this.mesh.frustumCulled = false // one object; skip per-frame bounds work
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
  }

  has(id: number): boolean {
    return this.ranges.has(id)
  }

  ids(): number[] {
    return [...this.ranges.keys()]
  }

  get count(): number {
    return this.ranges.size
  }

  /** bake a body's geometry at a world transform; false when capacity is full */
  add(id: number, g: BufferGeometry, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): boolean {
    if (this.ranges.has(id)) return true
    const p = g.getAttribute('position') as BufferAttribute
    const n = g.getAttribute('normal') as BufferAttribute
    const u = g.getAttribute('uv') as BufferAttribute
    const m = g.getAttribute('mat') as BufferAttribute
    const a = g.getAttribute('ao') as BufferAttribute
    const index = g.getIndex()
    if (!p || !index) return true
    const vc = p.count
    const ic = index.count
    if (this.vHead + vc > BATCH_VERTS || this.iHead + ic > BATCH_INDICES) return false
    _q.set(qx, qy, qz, qw)
    _m4.compose(_v.set(px, py, pz), _q, _n.set(1, 1, 1))
    _nm.getNormalMatrix(_m4)
    const v0 = this.vHead
    for (let i = 0; i < vc; i++) {
      _v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(_m4)
      const o = (v0 + i) * 3
      this.pos[o] = _v.x; this.pos[o + 1] = _v.y; this.pos[o + 2] = _v.z
      _n.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(_nm).normalize()
      this.nor[o] = _n.x; this.nor[o + 1] = _n.y; this.nor[o + 2] = _n.z
      this.uv[(v0 + i) * 2] = u.getX(i)
      this.uv[(v0 + i) * 2 + 1] = u.getY(i)
      this.mat[v0 + i] = m.getX(i)
      this.ao[v0 + i] = a.getX(i)
    }
    const i0 = this.iHead
    for (let i = 0; i < ic; i++) this.idx[i0 + i] = v0 + index.getX(i)
    for (const name of ['position', 'normal', 'uv', 'mat', 'ao'] as const) {
      const attr = this.geom.getAttribute(name) as BufferAttribute
      const per = attr.itemSize
      attr.addUpdateRange(v0 * per, vc * per)
      attr.needsUpdate = true
    }
    const ia = this.geom.getIndex() as BufferAttribute
    ia.addUpdateRange(i0, ic)
    ia.needsUpdate = true
    this.vHead += vc
    this.iHead += ic
    this.ranges.set(id, { i0, ic })
    this.geom.setDrawRange(0, this.iHead)
    return true
  }

  /** collapse a piece's triangles to zero area (slot stays allocated) */
  remove(id: number): void {
    const r = this.ranges.get(id)
    if (!r) return
    for (let k = 0; k < r.ic; k++) this.idx[r.i0 + k] = 0
    const ia = this.geom.getIndex() as BufferAttribute
    ia.addUpdateRange(r.i0, r.ic)
    ia.needsUpdate = true
    this.ranges.delete(id)
  }
}

export class DebrisMeshes {
  private readonly active = new Map<number, { mesh: Mesh; version: number }>()
  private readonly batch: RubbleBatch

  constructor(
    private readonly parent: Object3D,
    private readonly material: Material,
  ) {
    this.batch = new RubbleBatch(material)
    parent.add(this.batch.mesh)
  }

  get activeCount(): number {
    return this.active.size
  }
  get batchedCount(): number {
    return this.batch.count
  }

  update(layer: DebrisLayer): void {
    const { bodies, frozen } = layer
    // drop despawned pieces from both homes
    for (const [id, entry] of this.active) {
      if (!bodies.has(id)) {
        entry.mesh.geometry.dispose()
        this.parent.remove(entry.mesh)
        this.active.delete(id)
      }
    }
    for (const id of this.batch.ids()) if (!bodies.has(id)) this.batch.remove(id)

    // T97 — bake BUDGET: a whole blast's pieces freeze within a tick or two of
    // each other (same FREEZE_TICKS) and each bake pays buildBodyGeometry —
    // 30-80 in one frame was a ~27ms spike. Budgeted, an unbaked frozen piece
    // keeps its static individual mesh a few frames longer (identical visuals)
    // and the batch absorbs the backlog over the following frames.
    let bakes = 0
    for (const [id, b] of bodies) {
      if (frozen.has(id)) {
        if (this.batch.has(id)) continue // baked + static — nothing per-frame
        if (bakes >= BAKE_BUDGET) continue // keep the static individual mesh this frame
        bakes++
        // freeze transition: bake fresh geometry at the rest transform, then
        // drop the individual mesh. On a full batch, fall through to the
        // individual-mesh path below (graceful: the piece just stays an object).
        const geom = buildBodyGeometry(b)
        const baked = this.batch.add(id, geom, b.px, b.py, b.pz, b.qx, b.qy, b.qz, b.qw)
        if (baked) {
          geom.dispose()
          const entry = this.active.get(id)
          if (entry) {
            entry.mesh.geometry.dispose()
            this.parent.remove(entry.mesh)
            this.active.delete(id)
          }
          continue
        }
        geom.dispose()
        // fall through: render as a (static) individual mesh
      }
      // active piece → individual mesh; pull out of the batch if it woke up
      if (this.batch.has(id)) this.batch.remove(id)
      let entry = this.active.get(id)
      if (!entry || entry.version !== b.version) {
        const geometry = buildBodyGeometry(b)
        if (entry) {
          entry.mesh.geometry.dispose()
          entry.mesh.geometry = geometry
          entry.version = b.version
        } else {
          const mesh = new Mesh(geometry, this.material)
          mesh.castShadow = true
          mesh.receiveShadow = true
          entry = { mesh, version: b.version }
          this.active.set(id, entry)
          this.parent.add(mesh)
        }
      }
      entry.mesh.position.set(b.px, b.py, b.pz)
      entry.mesh.quaternion.set(b.qx, b.qy, b.qz, b.qw)
    }
  }
}
