/**
 * T14 — debris/dust particle bursts on destroy. Render-only (V6): fed by
 * the ChunkMeshManager.onEdit hook (drained dirty-chunk info), writes no
 * sim state. Math.random is fine here — visual salt on the render layer,
 * never inside src/sim or src/world (V2).
 *
 * T53/B13 DEMOTION: these chunk-center bursts were the old "explosion" — they
 * rained up/down from chunk centers with no relation to the blast. Explosions
 * and gun impacts now come from real sim events (src/render/fx/fx-system.ts,
 * seeded with removed-voxel positions and blast-radial velocities). This pool
 * remains only as a LIGHT edit puff for dig/place feedback, so burst() clamps
 * count and dampens speed/size/life regardless of what callers pass.
 *
 * GPU-instanced: one THREE.Sprite drawn `capacity` times. Motion is fully
 * analytic in the vertex stage (spawn + v·t + ½g·t²) from per-instance
 * attributes, so update() only bumps a time uniform — CPU touches buffers
 * only when a burst spawns, and dead particles collapse to zero scale.
 */
import { InstancedBufferAttribute, Sprite, SpriteNodeMaterial } from 'three/webgpu'
import { color, float, instancedBufferAttribute, mix, select, uniform, vec3 } from 'three/tsl'
import type { Vec3Like } from './remesh-scheduler'

const GRAVITY = -9.8

export class DebrisParticles {
  /** add this to the scene */
  readonly object: Sprite

  private readonly capacity: number
  private cursor = 0
  private now = 0
  private readonly tNow = uniform(0)
  private readonly spawn: InstancedBufferAttribute
  private readonly velocity: InstancedBufferAttribute
  /** x: spawnTime, y: life (s), z: size (m), w: seed 0..1 */
  private readonly meta: InstancedBufferAttribute

  constructor(capacity = 4096) {
    this.capacity = capacity
    this.spawn = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.velocity = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    const meta = new Float32Array(capacity * 4)
    for (let i = 0; i < capacity; i++) meta[i * 4] = -1e9 // born long-dead
    this.meta = new InstancedBufferAttribute(meta, 4)

    const p0 = instancedBufferAttribute<'vec3'>(this.spawn, 'vec3')
    const v0 = instancedBufferAttribute<'vec3'>(this.velocity, 'vec3')
    const m = instancedBufferAttribute<'vec4'>(this.meta, 'vec4')

    const age = this.tNow.sub(m.x)
    const life = m.y
    const t = age.div(life).clamp(0, 1)
    const alive = age.greaterThanEqual(0).and(age.lessThan(life))

    const material = new SpriteNodeMaterial()
    material.positionNode = p0
      .add(v0.mul(age))
      .add(vec3(0, GRAVITY * 0.5, 0).mul(age.mul(age)))
    // shrink slightly over life; dead → scale 0 (degenerate, no fragments)
    material.scaleNode = select(alive, m.z.mul(float(1).sub(t.mul(0.6))), float(0))
    material.rotationNode = m.w.mul(6.283).add(age.mul(m.w.sub(0.5).mul(10)))
    material.colorNode = mix(color(0x54483a), color(0xa89a86), m.w)
    material.opacityNode = float(1).sub(t).mul(0.55) // demoted (T53): subtle edit puff
    material.transparent = true
    material.depthWrite = false

    this.object = new Sprite(material)
    this.object.count = capacity // instanced draw
    this.object.frustumCulled = false
  }

  /**
   * Spawn a debris/dust burst at `center` (world meters). Overwrites the
   * oldest slots when the ring wraps — bounded memory, no allocation.
   */
  burst(center: Vec3Like, count = 32, speed = 3.5): void {
    // T53 demotion: light edit puff only — real destruction FX live in fx/
    const n = Math.min(count, 10, this.capacity)
    const s0 = speed * 0.45
    for (let i = 0; i < n; i++) {
      const j = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
      // random direction, upward biased — dust plumes up and out
      const yaw = Math.random() * Math.PI * 2
      const up = Math.random()
      const horiz = Math.sqrt(Math.max(0, 1 - up * up)) * (0.4 + 0.6 * Math.random())
      const s = s0 * (0.35 + 0.65 * Math.random())
      this.velocity.setXYZ(j, Math.cos(yaw) * horiz * s, (0.4 + 0.6 * up) * s, Math.sin(yaw) * horiz * s)
      this.spawn.setXYZ(
        j,
        center.x + (Math.random() - 0.5) * 0.6,
        center.y + (Math.random() - 0.5) * 0.6,
        center.z + (Math.random() - 0.5) * 0.6,
      )
      this.meta.setXYZW(j, this.now, 0.35 + Math.random() * 0.4, 0.03 + Math.random() * 0.04, Math.random())
    }
    this.spawn.needsUpdate = true
    this.velocity.needsUpdate = true
    this.meta.needsUpdate = true
  }

  /** advance the render-side particle clock; call once per frame */
  update(dt: number): void {
    this.now += dt
    this.tNow.value = this.now
  }
}
