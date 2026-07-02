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
import {
  CONNECTIVITY_MARGIN,
  findUnsupportedIslands,
  type Island,
  type Region,
} from './connectivity'
import { material, VOXEL_VOLUME } from './materials'

type JoltApi = typeof Jolt

export const LAYER_STATIC = 0
export const LAYER_MOVING = 1
const NUM_OBJECT_LAYERS = 2
const NUM_BP_LAYERS = 2

export const GRAVITY_Y = -9.81

/** Full 32³ chunk as a single box — fast path for Uniform chunks. */
const FULL_CHUNK_BOX: Box[] = [{ x: 0, y: 0, z: 0, sx: CHUNK, sy: CHUNK, sz: CHUNK }]

/**
 * Union voxel-space bounding box of a set of chunk indices, expanded by
 * `margin`. clampRegion (in connectivity) bounds the final search volume.
 */
export function chunkUnionRegion(chunkIndices: number[], margin: number): Region {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (const ci of chunkIndices) {
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    x0 = Math.min(x0, cx * CHUNK)
    y0 = Math.min(y0, cy * CHUNK)
    z0 = Math.min(z0, cz * CHUNK)
    x1 = Math.max(x1, cx * CHUNK + CHUNK - 1)
    y1 = Math.max(y1, cy * CHUNK + CHUNK - 1)
    z1 = Math.max(z1, cz * CHUNK + CHUNK - 1)
  }
  return {
    x0: x0 - margin,
    y0: y0 - margin,
    z0: z0 - margin,
    x1: x1 + margin,
    y1: y1 + margin,
    z1: z1 + margin,
  }
}

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
  /** chunk indices needing a connectivity check next structural pass (island-removal cascades, T12) */
  private pendingConnectivity: number[] = []

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
   * Structural update (T11/T12): rebuild static chunk bodies for chunks
   * dirtied by this tick's commands, then run the region-limited connectivity
   * check over the affected neighborhood and extract unsupported islands into
   * dynamic bodies. Island removal re-dirties chunks; those are rebuilt
   * immediately (no one-tick collider overlap with the new body) and queued
   * for a connectivity check next pass — cascades settle over ticks,
   * deterministically (V2).
   */
  structuralPass(sim: Sim): void {
    const drained = sim.world.drainDirty()
    for (const ci of drained) {
      this.rebuildChunkBody(sim.world, ci)
      this.remesh.add(ci)
    }
    const check = this.pendingConnectivity.concat(drained)
    this.pendingConnectivity = []
    if (check.length === 0) return

    const region = chunkUnionRegion(check, CONNECTIVITY_MARGIN)
    for (const island of findUnsupportedIslands(sim.world, region)) {
      this.extractIsland(sim, island)
    }
    const dirtied = sim.world.drainDirty()
    for (const ci of dirtied) {
      this.rebuildChunkBody(sim.world, ci)
      this.remesh.add(ci)
      this.pendingConnectivity.push(ci)
    }
  }

  /**
   * T12: island voxels → dynamic body entity. Voxels leave the ChunkStore and
   * live in the body's own mini grid; collider = greedy-box compound; mass =
   * Σ voxel density × voxel volume. Entity id via sim.allocEntityId() (V8).
   * Bodies stay dynamic after settling (V12) — sleep is allowed, re-weld is not.
   */
  extractIsland(sim: Sim, island: Island): DynamicBody {
    const vs = island.voxels
    if (vs.length === 0) throw new Error('extractIsland: empty island')
    let x0 = vs[0].x, y0 = vs[0].y, z0 = vs[0].z
    let x1 = x0, y1 = y0, z1 = z0
    for (const v of vs) {
      if (v.x < x0) x0 = v.x
      if (v.y < y0) y0 = v.y
      if (v.z < z0) z0 = v.z
      if (v.x > x1) x1 = v.x
      if (v.y > y1) y1 = v.y
      if (v.z > z1) z1 = v.z
    }
    const sx = x1 - x0 + 1
    const sy = y1 - y0 + 1
    const sz = z1 - z0 + 1
    const grid = new Uint8Array(sx * sy * sz)
    let mass = 0
    for (const v of vs) {
      grid[v.x - x0 + (v.z - z0) * sx + (v.y - y0) * sx * sz] = v.mat
      mass += material(v.mat).density * VOXEL_VOLUME
      sim.world.setVoxel(v.x, v.y, v.z, 0)
    }

    const api = this.api
    const shape = this.buildBoxesShape(greedyBoxes(grid, sx, sy, sz))
    const pos = new api.RVec3(x0 * VOXEL_SIZE, y0 * VOXEL_SIZE, z0 * VOXEL_SIZE)
    const rot = new api.Quat(0, 0, 0, 1)
    const bcs = new api.BodyCreationSettings(shape, pos, rot, api.EMotionType_Dynamic, LAYER_MOVING)
    bcs.mOverrideMassProperties = api.EOverrideMassProperties_CalculateInertia
    bcs.mMassPropertiesOverride.mMass = mass
    const body = this.bodyInterface.CreateBody(bcs)
    this.bodyInterface.AddBody(body.GetID(), api.EActivation_Activate)
    api.destroy(bcs)
    api.destroy(pos)
    api.destroy(rot)

    const id = sim.allocEntityId()
    body.SetUserData(id)
    const entity: DynamicBody = {
      id,
      sx,
      sy,
      sz,
      grid,
      count: vs.length,
      mass,
      px: x0 * VOXEL_SIZE,
      py: y0 * VOXEL_SIZE,
      pz: z0 * VOXEL_SIZE,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      body,
      version: 0,
    }
    this.bodies.set(id, entity)
    return entity
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
