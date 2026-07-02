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
      line.visible = false
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
    s.line.visible = true
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.line.visible) continue
      s.ttl -= dt
      if (s.ttl <= 0) {
        s.line.visible = false
        s.fade.value = 0
      } else {
        s.fade.value = s.ttl / TRACER_LIFE
      }
    }
  }
}
