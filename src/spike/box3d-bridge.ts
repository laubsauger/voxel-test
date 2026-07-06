/**
 * T78 — Box3D WASM bridge (I.box3d, V14). Thin async adapter over
 * box3d-wasm@0.2.0 (Erin Catto's Box3D, C17 → WASM). RENDER-FREE by design:
 * no three.js import, so it runs headless in Node (V15 sync test) and the
 * isolation contract (V14) holds — it never reaches into sim/net/Jolt.
 *
 * Flavour = `/standard` (SIMD, single-threaded). The `/deluxe` threaded build
 * needs SharedArrayBuffer = cross-origin isolation (COOP/COEP), which the Vite
 * dev server + Pages deploy do not set. A spike does not need threads.
 *
 * Coordinate scale matches the game: metres, Y up, gravity -9.81 (Jolt parity,
 * INTEGRATION-physics.md). Box3D transforms are f32 (precision undocumented; the
 * handoff's "double-precision" claim does not hold — see SPEC I.box3d).
 */
import Box3D, { type B3Body, type B3World, type B3Profile } from 'box3d-wasm/standard'

export interface Vec3 {
  x: number
  y: number
  z: number
}
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export type DynamicKind = 'box' | 'sphere'

/** a dynamic body paired 1:1 with exactly one render mesh by the caller (V15) */
export interface DynamicHandle {
  readonly id: number
  readonly kind: DynamicKind
  /** box half-extents (kind === 'box') */
  readonly halfExtents?: Vec3
  /** sphere radius (kind === 'sphere') */
  readonly radius?: number
  readonly body: B3Body
  position(): Vec3
  rotation(): Quat
  /** apply a linear impulse at the center of mass (debris knockback, T84) */
  impulse(v: Vec3): void
}

export interface SpikeWorldOptions {
  gravity?: Vec3
  /** world-level continuous collision (tunneling defense) — T83 q2 */
  continuous?: boolean
  /** default dynamic-body density (kg/m³-ish, relative) */
  density?: number
}

export const GRAVITY_Y = -9.81

/**
 * Owns the Box3D world + every body. Static colliders (ground, houses) and
 * dynamic drops are created through here so the spike has a single physics
 * authority to step and to tear down.
 */
export class SpikeWorld {
  readonly world: B3World
  readonly dynamics: DynamicHandle[] = []
  /** live static bodies — tracked so destruction (T84) can remove them */
  readonly statics = new Set<B3Body>()
  /** static box extents, for the collider-grid debug view (T85) */
  private readonly staticInfo = new Map<B3Body, { center: Vec3; half: Vec3 }>()
  private nextId = 0
  private readonly density: number

  private constructor(world: B3World, density: number) {
    this.world = world
    this.density = density
  }

  static async create(opts: SpikeWorldOptions = {}): Promise<SpikeWorld> {
    const b3 = await Box3D()
    const g = opts.gravity ?? { x: 0, y: GRAVITY_Y, z: 0 }
    const world = new b3.World({ gravity: g })
    world.enableContinuous(opts.continuous ?? true)
    return new SpikeWorld(world, opts.density ?? 1)
  }

  /**
   * single static box collider = one static body with one box at its origin.
   * Both T80 mappings use this: (a) one call per solid voxel, (b) one call per
   * greedy-merged box. box3d-wasm 0.2.0 exposes NO shape-local offset, so a
   * single-body compound of offset boxes is not expressible — the merged-box
   * decomposition IS the "compound" here, just spread over one body per box.
   * The eval lever (T83 q3) is body/shape COUNT: (b) yields far fewer than (a).
   */
  addStaticBox(center: Vec3, halfExtents: Vec3): B3Body {
    const body = this.world.createBody({ type: 'static', position: center })
    body.createBox({ halfExtents })
    this.statics.add(body)
    this.staticInfo.set(body, { center, half: halfExtents })
    return body
  }

  /** remove a static collider (T84 destruction: voxels blasted out of a structure) */
  removeStaticBox(body: B3Body): void {
    if (this.statics.delete(body)) {
      this.staticInfo.delete(body)
      body.destroy()
    }
  }

  /** collider extents for the debug-grid view (T85) */
  staticBoxes(): Array<{ center: Vec3; half: Vec3 }> {
    return [...this.staticInfo.values()]
  }

  spawnDynamicBox(position: Vec3, halfExtents: Vec3, bullet = false): DynamicHandle {
    const body = this.world.createBody({ type: 'dynamic', position })
    body.createBox({ halfExtents, density: this.density })
    body.applyMassFromShapes()
    body.setBullet(bullet)
    const h: DynamicHandle = {
      id: this.nextId++,
      kind: 'box',
      halfExtents,
      body,
      position: () => body.getPosition(),
      rotation: () => body.getRotation(),
      impulse: (v) => body.applyLinearImpulseToCenter(v, true),
    }
    this.dynamics.push(h)
    return h
  }

  spawnDynamicSphere(position: Vec3, radius: number, bullet = false): DynamicHandle {
    const body = this.world.createBody({ type: 'dynamic', position })
    body.createSphere({ radius, density: this.density })
    body.applyMassFromShapes()
    body.setBullet(bullet)
    const h: DynamicHandle = {
      id: this.nextId++,
      kind: 'sphere',
      radius,
      body,
      position: () => body.getPosition(),
      rotation: () => body.getRotation(),
      impulse: (v) => body.applyLinearImpulseToCenter(v, true),
    }
    this.dynamics.push(h)
    return h
  }

  setContinuous(on: boolean): void {
    this.world.enableContinuous(on)
    for (const h of this.dynamics) h.body.setBullet(on)
  }

  /** radial impulse shockwave — topples dynamic stacks (T84 collapse trigger) */
  explode(position: Vec3, radius: number, impulsePerLength: number): void {
    this.world.explode({ position, radius, impulsePerLength })
  }

  step(dt: number, subSteps: number): void {
    this.world.step(dt, subSteps)
  }

  get staticColliderCount(): number {
    return this.statics.size
  }
  get awakeCount(): number {
    return this.world.getAwakeBodyCount()
  }
  profile(): B3Profile {
    return this.world.getProfile()
  }

  destroy(): void {
    this.world.destroy()
    this.dynamics.length = 0
  }
}
