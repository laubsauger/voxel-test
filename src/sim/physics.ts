/**
 * T10 [P] — I.jolt: Jolt WASM integration.
 *
 * Fixed 60Hz step INSIDE the sim tick (registered as a Sim system, V2).
 * Single-threaded (mMaxWorkerThreads = 0), deterministic simulation settings.
 * World-static collision: one static body per solid chunk, rebuilt from dirty
 * chunks via greedy-merged boxes (v1).
 *
 * Jolt loads async (WASM): `await createPhysics(sim)` before the loop starts.
 * All mutations here run inside command handlers or sim systems (V1).
 */
import Jolt from 'jolt-physics'
import { DT, type Sim } from './loop'
import { Fnv } from './hash'
import {
  CHUNK,
  ChunkKind,
  VOXEL_SIZE,
  WORLD_CX,
  WORLD_CZ,
  type ChunkStore,
} from '../world/chunks'
import { greedyBoxes, type Box } from './greedy-boxes'

type JoltApi = typeof Jolt

export const LAYER_STATIC = 0
export const LAYER_MOVING = 1
const NUM_OBJECT_LAYERS = 2
const NUM_BP_LAYERS = 2

export const GRAVITY_Y = -9.81

/** Full 32³ chunk as a single box — fast path for Uniform chunks. */
const FULL_CHUNK_BOX: Box[] = [{ x: 0, y: 0, z: 0, sx: CHUNK, sy: CHUNK, sz: CHUNK }]

let joltPromise: Promise<JoltApi> | undefined

/** Load the Jolt WASM module once per process (async, before the sim loop). */
export function loadJolt(): Promise<JoltApi> {
  if (!joltPromise) joltPromise = Jolt() as Promise<JoltApi>
  return joltPromise
}

/**
 * Dynamic island body entity (T12). `grid` is the body's own mini voxel grid,
 * layout x + z*sx + y*sx*sz; the body-local origin is grid corner (0,0,0).
 * Transform fields mirror Jolt state after each step — hashable (V3).
 */
export interface DynamicBody {
  /** entity id via sim.allocEntityId() (V8) */
  id: number
  sx: number
  sy: number
  sz: number
  grid: Uint8Array
  /** live voxel count */
  count: number
  /** kg — voxel count × material density × voxel volume */
  mass: number
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** stable Jolt body pointer (BodyID wrappers returned by Jolt are transient temps) */
  body: Jolt.Body
  /** bumped when grid content changes — render rebuild trigger */
  version: number
}

export class PhysicsWorld {
  readonly api: JoltApi
  readonly joltInterface: Jolt.JoltInterface
  readonly physicsSystem: Jolt.PhysicsSystem
  readonly bodyInterface: Jolt.BodyInterface

  /** chunk index → static body for that chunk's solid voxels */
  private readonly chunkBodies = new Map<number, Jolt.Body>()
  /** entity id → dynamic island body, insertion order = allocation order (deterministic) */
  readonly bodies = new Map<number, DynamicBody>()

  /** chunk indices rebuilt since last drainRemesh() — render consumes these (see INTEGRATION-physics.md) */
  private readonly remesh = new Set<number>()

  private readonly settings: Jolt.JoltSettings
  private readonly gravity: Jolt.Vec3

  constructor(api: JoltApi) {
    this.api = api
    const settings = new api.JoltSettings()
    settings.mMaxBodies = 32768
    settings.mMaxWorkerThreads = 0 // single-threaded: determinism (V2, I.jolt)

    const objectFilter = new api.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS)
    objectFilter.EnableCollision(LAYER_STATIC, LAYER_MOVING)
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING)
    const bpInterface = new api.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BP_LAYERS)
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_STATIC, new api.BroadPhaseLayer(0))
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new api.BroadPhaseLayer(1))
    settings.mObjectLayerPairFilter = objectFilter
    settings.mBroadPhaseLayerInterface = bpInterface
    settings.mObjectVsBroadPhaseLayerFilter = new api.ObjectVsBroadPhaseLayerFilterTable(
      bpInterface,
      NUM_BP_LAYERS,
      objectFilter,
      NUM_OBJECT_LAYERS,
    )

    this.settings = settings
    this.joltInterface = new api.JoltInterface(settings)
    this.physicsSystem = this.joltInterface.GetPhysicsSystem()
    this.bodyInterface = this.physicsSystem.GetBodyInterface()
    this.gravity = new api.Vec3(0, GRAVITY_Y, 0)

    // Jolt defaults to deterministic simulation; assert loudly rather than assume (V10).
    const phys = this.physicsSystem.GetPhysicsSettings()
    if (!phys.mDeterministicSimulation) {
      phys.mDeterministicSimulation = true
      this.physicsSystem.SetPhysicsSettings(phys)
    }
  }

  get staticBodyCount(): number {
    return this.chunkBodies.size
  }

  /**
   * Build static bodies for everything currently dirty (scene setup edits).
   * No connectivity checks here — authored content is taken as-is.
   */
  initStatic(world: ChunkStore): void {
    for (const ci of world.drainDirty()) {
      this.rebuildChunkBody(world, ci)
      this.remesh.add(ci)
    }
    this.physicsSystem.OptimizeBroadPhase()
  }

  /** Sim system body: structural updates, then the fixed Jolt step (V2: DT only). */
  tick(sim: Sim): void {
    this.structuralPass(sim)
    this.joltInterface.Step(DT, 1)
    this.readbackBodies()
  }

  /**
   * Rebuild static chunk bodies for chunks dirtied by this tick's commands.
   * Connectivity/island extraction extends this at T11/T12.
   */
  structuralPass(sim: Sim): void {
    const drained = sim.world.drainDirty()
    for (const ci of drained) {
      this.rebuildChunkBody(sim.world, ci)
      this.remesh.add(ci)
    }
  }

  /** Chunk indices needing remesh — the render layer's dirty feed (replaces world.drainDirty(), V6-safe read). */
  drainRemesh(): number[] {
    const out = [...this.remesh].sort((a, b) => a - b)
    this.remesh.clear()
    return out
  }

  private rebuildChunkBody(world: ChunkStore, ci: number): void {
    const existing = this.chunkBodies.get(ci)
    if (existing !== undefined) {
      this.bodyInterface.RemoveBody(existing.GetID())
      this.bodyInterface.DestroyBody(existing.GetID())
      this.chunkBodies.delete(ci)
    }
    const chunk = world.chunkAt(ci)
    if (chunk.kind === ChunkKind.Empty) return

    let boxes: Box[]
    if (chunk.kind === ChunkKind.Uniform) {
      boxes = chunk.mat !== 0 ? FULL_CHUNK_BOX : []
    } else {
      boxes = greedyBoxes(chunk.data!, CHUNK, CHUNK, CHUNK)
    }
    if (boxes.length === 0) return

    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0

    const api = this.api
    const shape = this.buildBoxesShape(boxes)
    const pos = new api.RVec3(cx * CHUNK * VOXEL_SIZE, cy * CHUNK * VOXEL_SIZE, cz * CHUNK * VOXEL_SIZE)
    const rot = new api.Quat(0, 0, 0, 1)
    const bcs = new api.BodyCreationSettings(shape, pos, rot, api.EMotionType_Static, LAYER_STATIC)
    const body = this.bodyInterface.CreateBody(bcs)
    this.bodyInterface.AddBody(body.GetID(), api.EActivation_DontActivate)
    api.destroy(bcs)
    api.destroy(pos)
    api.destroy(rot)
    this.chunkBodies.set(ci, body)
  }

  /**
   * Boxes (local voxel coords) → Jolt shape whose local origin is the grid
   * corner (0,0,0). Compound for ≥2 boxes, RotatedTranslated wrapper for 1
   * (Jolt compounds require ≥2 sub-shapes).
   */
  buildBoxesShape(boxes: Box[]): Jolt.Shape {
    const api = this.api
    const half = VOXEL_SIZE * 0.5
    const makeBox = (b: Box) =>
      new api.BoxShapeSettings(new api.Vec3(b.sx * half, b.sy * half, b.sz * half), 0)
    const center = (b: Box) =>
      new api.Vec3((b.x + b.sx * 0.5) * VOXEL_SIZE, (b.y + b.sy * 0.5) * VOXEL_SIZE, (b.z + b.sz * 0.5) * VOXEL_SIZE)

    let settings: Jolt.ShapeSettings
    if (boxes.length === 1) {
      const rot = new api.Quat(0, 0, 0, 1)
      settings = new api.RotatedTranslatedShapeSettings(center(boxes[0]), rot, makeBox(boxes[0]))
      api.destroy(rot)
    } else {
      const compound = new api.StaticCompoundShapeSettings()
      const rot = new api.Quat(0, 0, 0, 1)
      for (const b of boxes) compound.AddShape(center(b), rot, makeBox(b), 0)
      api.destroy(rot)
      settings = compound
    }
    const result = settings.Create()
    if (result.HasError()) {
      throw new Error(`Jolt shape build failed: ${result.GetError().c_str()}`)
    }
    const shape = result.Get()
    api.destroy(settings) // releases child settings refs; shape is ref-held by the body
    return shape
  }

  /** Mirror Jolt transforms into hashable entity fields after each step. */
  private readbackBodies(): void {
    for (const b of this.bodies.values()) {
      const p = b.body.GetPosition()
      b.px = p.GetX()
      b.py = p.GetY()
      b.pz = p.GetZ()
      const q = b.body.GetRotation()
      b.qx = q.GetX()
      b.qy = q.GetY()
      b.qz = q.GetZ()
      b.qw = q.GetW()
    }
  }

  /** Radial impulse to dynamic bodies near a blast (T13). Deterministic id order. */
  applyRadialImpulse(cx: number, cy: number, cz: number, radius: number, strength: number): void {
    const api = this.api
    for (const b of this.bodies.values()) {
      const p = b.body.GetPosition()
      const dx = p.GetX() - cx
      const dy = p.GetY() - cy
      const dz = p.GetZ() - cz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist >= radius) continue
      const falloff = 1 - dist / radius
      const inv = dist > 1e-6 ? 1 / dist : 0
      const mag = strength * falloff
      // straight up if the body sits exactly at the blast center
      const imp = new api.Vec3(dx * inv * mag, dist > 1e-6 ? dy * inv * mag : mag, dz * inv * mag)
      this.bodyInterface.ActivateBody(b.body.GetID())
      b.body.AddImpulse(imp)
      api.destroy(imp)
    }
  }

  /** Free Jolt-side resources (tests). The WASM module itself stays loaded. */
  dispose(): void {
    const api = this.api
    for (const body of this.chunkBodies.values()) {
      this.bodyInterface.RemoveBody(body.GetID())
      this.bodyInterface.DestroyBody(body.GetID())
    }
    this.chunkBodies.clear()
    for (const b of this.bodies.values()) {
      this.bodyInterface.RemoveBody(b.body.GetID())
      this.bodyInterface.DestroyBody(b.body.GetID())
    }
    this.bodies.clear()
    api.destroy(this.gravity)
    api.destroy(this.joltInterface)
    api.destroy(this.settings)
  }
}

/**
 * I.hash extension for physics state (V3 groundwork): body count + transforms
 * as raw f64 bits through Fnv. Deterministic order: ids ascending.
 */
export function hashPhysics(phys: PhysicsWorld): number {
  const h = new Fnv()
  h.u32(phys.staticBodyCount)
  h.u32(phys.bodies.size)
  const ids = [...phys.bodies.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const b = phys.bodies.get(id)!
    h.u32(id)
    h.f64(b.px).f64(b.py).f64(b.pz)
    h.f64(b.qx).f64(b.qy).f64(b.qz).f64(b.qw)
    h.f64(b.mass)
    h.u32(b.sx).u32(b.sy).u32(b.sz)
    h.bytes(b.grid)
  }
  return h.value
}

/**
 * Async physics init — call `await createPhysics(sim)` before the loop starts.
 * Registers the physics step as a Sim system (runs inside the sim tick, V2)
 * and builds static collision for already-stamped world content.
 */
export async function createPhysics(sim: Sim): Promise<PhysicsWorld> {
  const api = await loadJolt()
  const phys = new PhysicsWorld(api)
  phys.initStatic(sim.world)
  sim.addSystem(() => phys.tick(sim))
  return phys
}
