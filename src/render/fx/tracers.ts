/**
 * T53 — hitscan tracer pool: a handful of fading HDR line segments.
 * Pooled Line objects (fixed capacity), per-slot fade uniform — no
 * allocations after construction. Render-only (V6).
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Line, LineBasicNodeMaterial } from 'three/webgpu'
import { uniform, vec3 } from 'three/tsl'

const TRACER_LIFE = 0.09
/** HDR tracer color — above bloom threshold, below spark/flash tier */
const TRACER_RGB: [number, number, number] = [3.2, 2.6, 1.6]

interface Slot {
  line: Line
  fade: ReturnType<typeof uniform>
  ttl: number
}

export class TracerPool {
  readonly group = new Group()
  private readonly slots: Slot[] = []
  private cursor = 0

  constructor(capacity = 12) {
    for (let i = 0; i < capacity; i++) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3))
      const fade = uniform(0)
      const material = new LineBasicNodeMaterial()
      material.colorNode = vec3(...TRACER_RGB).mul(fade)
      material.transparent = true
      material.blending = AdditiveBlending
      material.depthWrite = false
      const line = new Line(geometry, material)
      line.frustumCulled = false
      // B33 — stay permanently visible (fade drives color to 0 + the geometry
      // starts zero-length, so it renders nothing). A .visible flip on the
      // first shot would defer this LineBasicNodeMaterial's pipeline compile to
      // that frame — part of the residual shoot hitch. Visible from the start
      // warms the pipeline during the loading render instead.
      line.visible = true
      this.slots.push({ line, fade, ttl: 0 })
      this.group.add(line)
    }
  }

  fire(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const s = this.slots[this.cursor]
    this.cursor = (this.cursor + 1) % this.slots.length
    const pos = s.line.geometry.getAttribute('position') as BufferAttribute
    pos.setXYZ(0, x0, y0, z0)
    pos.setXYZ(1, x1, y1, z1)
    pos.needsUpdate = true
    s.ttl = TRACER_LIFE
    s.fade.value = 1
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.ttl <= 0) continue // already collapsed to zero length (renders nothing)
      s.ttl -= dt
      if (s.ttl > 0) {
        s.fade.value = s.ttl / TRACER_LIFE
      } else {
        // P26 — fade hit 0. Additive blending does NOT reliably hide a
        // color-0 line in WebGPU, so a black segment was lingering along the
        // shot path. Collapse the segment to a point (both endpoints equal) so
        // it truly renders nothing — no .visible flip (avoids the pipeline
        // recompile hitch the pool was designed around).
        s.fade.value = 0
        const pos = s.line.geometry.getAttribute('position') as BufferAttribute
        pos.setXYZ(1, pos.getX(0), pos.getY(0), pos.getZ(0))
        pos.needsUpdate = true
      }
    }
  }
}
