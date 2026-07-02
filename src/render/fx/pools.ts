/**
 * T53 — pooled, GPU-instanced analytic effect primitives. Render-only (V6).
 *
 * Every pool preallocates `capacity` instances in ring buffers; spawning
 * overwrites the oldest slot and bumps the attribute upload range — steady
 * state does ZERO per-frame allocation and update() only advances one time
 * uniform (motion is fully analytic in the vertex stage, same contract as
 * the T14 DebrisParticles). Math.random is fine here: visual salt on the
 * render layer, never sim state (V2 untouched).
 *
 * HDR emission hierarchy (bloom threshold sits at ~0.85, ACES tonemap):
 *   explosion flash (≈28) > sparks (≈9) > fireball (≈6) > muzzle (≈10 tiny)
 *   > tracer (≈3) > fuse spark (≈8, tiny) > lit surfaces (≤1).
 */
import {
  AdditiveBlending,
  BoxGeometry,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  NormalBlending,
  Sprite,
  SpriteNodeMaterial,
} from 'three/webgpu'
import {
  exp,
  float,
  instancedBufferAttribute,
  positionLocal,
  rotate,
  select,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl'

const GRAVITY = -9.8

/** shared ring-buffer attribute bundle */
class Ring {
  cursor = 0
  readonly spawn: InstancedBufferAttribute
  readonly vel: InstancedBufferAttribute
  /** x: spawnTime, y: life (s), z: size (m), w: seed 0..1 */
  readonly meta: InstancedBufferAttribute
  /** rgb (HDR-scaled), w: alpha (or per-instance extra) */
  readonly tint: InstancedBufferAttribute

  constructor(readonly capacity: number) {
    this.spawn = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.vel = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    const meta = new Float32Array(capacity * 4)
    for (let i = 0; i < capacity; i++) meta[i * 4] = -1e9 // born long-dead
    this.meta = new InstancedBufferAttribute(meta, 4)
    this.tint = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
  }

  /** claim the next slot index */
  next(): number {
    const j = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    return j
  }

  markDirty(): void {
    this.spawn.needsUpdate = true
    this.vel.needsUpdate = true
    this.meta.needsUpdate = true
    this.tint.needsUpdate = true
  }
}

export interface SpritePoolOpts {
  capacity: number
  additive: boolean
  /** scale multiplier reached at end of life (1 = constant size) */
  growth: number
  /** velocity decay: p = v·(1−e^(−k·age))/k. 0 = ballistic (no drag) */
  drag: number
  /** vertical acceleration (m/s²), e.g. −9.8 for sparks, 0 for smoke */
  gravity: number
  /** fraction of life spent fading in */
  fadeIn: number
  /** fraction of life where fade-out starts */
  fadeOut: number
  /** soft-edge band of the radial falloff: [inner, outer] in quad radii */
  edge: [number, number]
  /** rotation rate scale (rad/s, seed-signed) */
  spin: number
}

/**
 * Soft round camera-facing sprites — fireball puffs, smoke plume, dust ring,
 * impact puffs, flashes, sparks. One draw call per pool.
 */
export class SpritePool {
  readonly object: Sprite
  private readonly ring: Ring
  private readonly tNow = uniform(0)
  private now = 0
  private dirty = false

  constructor(opts: SpritePoolOpts) {
    this.ring = new Ring(opts.capacity)
    const p0 = instancedBufferAttribute<'vec3'>(this.ring.spawn, 'vec3')
    const v0 = instancedBufferAttribute<'vec3'>(this.ring.vel, 'vec3')
    const m = instancedBufferAttribute<'vec4'>(this.ring.meta, 'vec4')
    const tint = instancedBufferAttribute<'vec4'>(this.ring.tint, 'vec4')

    const age = this.tNow.sub(m.x)
    const life = m.y
    const t = age.div(life).clamp(0, 1)
    const alive = age.greaterThanEqual(0).and(age.lessThan(life))

    const travel =
      opts.drag > 0
        ? v0.mul(float(1).sub(exp(age.mul(-opts.drag))).div(opts.drag))
        : v0.mul(age)

    const material = new SpriteNodeMaterial()
    material.positionNode = p0.add(travel).add(vec3(0, opts.gravity * 0.5, 0).mul(age.mul(age)))
    material.scaleNode = select(alive, m.z.mul(float(1).add(t.mul(opts.growth - 1))), float(0))
    material.rotationNode = m.w.mul(6.283).add(age.mul(m.w.sub(0.5)).mul(opts.spin))

    const d = uv().sub(0.5).length().mul(2)
    const soft = float(1).sub(smoothstep(float(opts.edge[0]), float(opts.edge[1]), d))
    const fade = smoothstep(float(0), float(opts.fadeIn), t).mul(
      float(1).sub(smoothstep(float(opts.fadeOut), float(1), t)),
    )
    material.colorNode = tint.xyz
    material.opacityNode = tint.w.mul(fade).mul(soft)
    material.transparent = true
    material.depthWrite = false
    material.blending = opts.additive ? AdditiveBlending : NormalBlending
    if (opts.additive) material.fog = false

    this.object = new Sprite(material)
    this.object.count = opts.capacity
    this.object.frustumCulled = false
    this.object.renderOrder = opts.additive ? 20 : 10
  }

  /** spawn one sprite; `delay` staggers birth into the future (plumes) */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number,
    r: number, g: number, b: number, alpha: number,
    delay = 0,
  ): void {
    const j = this.ring.next()
    this.ring.spawn.setXYZ(j, x, y, z)
    this.ring.vel.setXYZ(j, vx, vy, vz)
    this.ring.meta.setXYZW(j, this.now + delay, life, size, Math.random())
    this.ring.tint.setXYZW(j, r, g, b, alpha)
    this.dirty = true
  }

  update(dt: number): void {
    this.now += dt
    this.tNow.value = this.now
    if (this.dirty) {
      this.dirty = false
      this.ring.markDirty()
    }
  }
}

/**
 * Instanced voxel-debris cubes: ballistic (gravity), clamped to a per-instance
 * floor height (rubble "lands" instead of falling through), shrink out at end
 * of life. Opaque — no sorting, no overdraw cost beyond the mesh.
 * tint.w carries the floor height (world y, meters).
 */
export class CubePool {
  readonly object: Mesh
  private readonly ring: Ring
  private readonly tNow = uniform(0)
  private now = 0
  private dirty = false

  constructor(capacity = 1024) {
    this.ring = new Ring(capacity)
    const p0 = instancedBufferAttribute<'vec3'>(this.ring.spawn, 'vec3')
    const v0 = instancedBufferAttribute<'vec3'>(this.ring.vel, 'vec3')
    const m = instancedBufferAttribute<'vec4'>(this.ring.meta, 'vec4')
    const tint = instancedBufferAttribute<'vec4'>(this.ring.tint, 'vec4')

    const age = this.tNow.sub(m.x)
    const life = m.y
    const t = age.div(life).clamp(0, 1)
    const alive = age.greaterThanEqual(0).and(age.lessThan(life))

    const scale = select(alive, m.z.mul(float(1).sub(smoothstep(float(0.7), float(1), t))), float(0))
    const euler = vec3(m.w.mul(9.7), m.w.mul(17.3), m.w.mul(5.1)).add(
      vec3(m.w.sub(0.5).mul(9), m.w.sub(0.5).mul(7), m.w.sub(0.5).mul(11)).mul(age),
    )
    const center = p0.add(v0.mul(age)).add(vec3(0, GRAVITY * 0.5, 0).mul(age.mul(age)))
    // land on the blast's ground plane instead of sinking out of view
    const centerClamped = vec3(center.x, center.y.max(tint.w.add(scale.mul(0.5))), center.z)

    const material = new MeshStandardNodeMaterial()
    material.positionNode = rotate(positionLocal.mul(scale), euler).add(centerClamped)
    material.colorNode = tint.xyz.mul(m.w.mul(0.45).add(0.65))
    material.roughnessNode = float(0.9)
    material.metalnessNode = float(0)

    this.object = new Mesh(new BoxGeometry(1, 1, 1), material)
    this.object.count = capacity
    this.object.frustumCulled = false
    this.object.castShadow = false
    this.object.receiveShadow = false
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number,
    r: number, g: number, b: number, floorY: number,
  ): void {
    const j = this.ring.next()
    this.ring.spawn.setXYZ(j, x, y, z)
    this.ring.vel.setXYZ(j, vx, vy, vz)
    this.ring.meta.setXYZW(j, this.now, life, size, Math.random())
    this.ring.tint.setXYZW(j, r, g, b, floorY)
    this.dirty = true
  }

  update(dt: number): void {
    this.now += dt
    this.tNow.value = this.now
    if (this.dirty) {
      this.dirty = false
      this.ring.markDirty()
    }
  }
}
