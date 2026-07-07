/**
 * T78 — ambient type shim for box3d-wasm@0.2.0 (ships no .d.ts). Declares only
 * the embind surface the spike bridge touches; verified live against the real
 * module (see _b3d_probe introspection, 2026-07-06). NOT exhaustive — joints,
 * sensors, hulls etc. exist but the spike does not use them.
 */
declare module 'box3d-wasm/standard' {
  export interface B3Vec3 {
    x: number
    y: number
    z: number
  }
  export interface B3Quat {
    x: number
    y: number
    z: number
    w: number
  }
  export interface B3Profile {
    step: number
    pairs: number
    collide: number
    solve: number
  }
  export interface B3ShapeDef {
    density?: number
    friction?: number
    restitution?: number
  }
  export interface B3Shape {
    setFriction(f: number): void
    setRestitution(r: number): void
    destroy(): void
  }
  export interface B3Body {
    createBox(def: { halfExtents: B3Vec3 } & B3ShapeDef): B3Shape
    createSphere(def: { radius: number } & B3ShapeDef): B3Shape
    /** convex hull of a point cloud (non-convex islands → convex approx, B30) */
    createHull(def: { points: B3Vec3[] } & B3ShapeDef): B3Shape
    applyMassFromShapes(): void
    getPosition(): B3Vec3
    getRotation(): B3Quat
    setTransform(def: { position: B3Vec3; rotation?: B3Quat }): void
    setType(type: 'static' | 'kinematic' | 'dynamic'): void
    getType(): string
    setBullet(on: boolean): void
    isBullet(): boolean
    setLinearVelocity(v: B3Vec3): void
    getLinearVelocity(): B3Vec3
    setAngularVelocity(v: B3Vec3): void
    getAngularVelocity(): B3Vec3
    setLinearDamping(d: number): void
    setAngularDamping(d: number): void
    applyLinearImpulseToCenter(impulse: B3Vec3, wake?: boolean): void
    applyLinearImpulse(impulse: B3Vec3, point: B3Vec3, wake?: boolean): void
    setUserData(v: number): void
    getUserData(): number
    getShapeCount(): number
    getMass(): number
    destroy(): void
  }
  export interface B3RayHit {
    hit: boolean
    point?: B3Vec3
    normal?: B3Vec3
    fraction?: number
    /** userData of the hit body (set via body.setUserData) — 0 if none */
    bodyUserData?: number
    shapeUserData?: number
  }
  export interface B3World {
    createBody(def: { type: 'static' | 'dynamic'; position?: B3Vec3 }): B3Body
    step(dt: number, subStepCount: number): void
    setGravity(g: B3Vec3): void
    getGravity(): B3Vec3
    enableContinuous(on: boolean): void
    enableSleeping(on: boolean): void
    getAwakeBodyCount(): number
    getProfile(): B3Profile
    explode(def: { position: B3Vec3; radius: number; impulsePerLength: number; falloff?: number }): void
    castRayClosest(origin: B3Vec3, translation: B3Vec3): B3RayHit
    destroy(): void
  }
  export interface B3Module {
    World: new (def: { gravity: B3Vec3 }) => B3World
  }
  const factory: (options?: Record<string, unknown>) => Promise<B3Module>
  export default factory
}
