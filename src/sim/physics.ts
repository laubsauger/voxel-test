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
  type IslandVoxel,
  type Region,
} from './connectivity'
import { material, VOXEL_VOLUME } from './materials'
import { registerDestructionOps } from './destruction'
import { registerPlayerOps, updatePlayers, type PlayerEntity, type SplashEvent } from './player'
import { registerProjectileOps, tickProjectiles, type Projectile } from './projectiles'
import { attachEditPhysics } from './edit-ops'
import type { WaterSim } from './water/water-sim'

type JoltApi = typeof Jolt

export const LAYER_STATIC = 0
export const LAYER_MOVING = 1
const NUM_OBJECT_LAYERS = 2
const NUM_BP_LAYERS = 2

export const GRAVITY_Y = -9.81

// ---------------------------------------------------------------------------
// T40 — destruction feel tuning
// ---------------------------------------------------------------------------

/**
 * Hard cap on dynamic island body speed (m/s). Set on MotionProperties via
 * BodyCreationSettings; Jolt clamps both at impulse application
 * (SetLinearVelocityClamped inside Body.AddImpulse) and after each solver
 * step — nothing ever flies off to infinity or NaNs (T40).
 */
export const MAX_BODY_LINEAR_VELOCITY = 60
/** rad/s cap on island spin — debris tumbles, never turns into a blur */
export const MAX_BODY_ANGULAR_VELOCITY = 25
/** extra angular damping on islands so tumbling chunks settle and sleep */
export const BODY_ANGULAR_DAMPING = 0.25
/** bodies whose origin falls below this (meters) are removed from sim + Jolt */
export const KILL_PLANE_Y = -10

/** per-material surface response for island bodies (T40) */
export interface MaterialFeel {
  friction: number
  restitution: number
}

/**
 * I.mat-derived friction/restitution, indexed by material id. materials.ts is
 * the id authority (V13) and is read-only for this track, so the feel columns
 * live here. Values chosen for weight-believability:
 *   - masonry/earth (dirt, grass, asphalt, concrete, brick): high friction,
 *     near-zero restitution — slabs thud and stay put.
 *   - wood: moderate friction 0.7, restitution 0.25 — planks clatter/bounce.
 *   - metal: low friction 0.25, restitution 0.3 — slides and clangs.
 *   - glass: slick, small bounce before it (visually) shatters.
 *   - leaves: grippy and dead — foliage clumps flop, never bounce.
 */
export const MATERIAL_FEEL: readonly MaterialFeel[] = [
  { friction: 0.5, restitution: 0.05 }, // 0 air (unused)
  { friction: 0.9, restitution: 0.02 }, // 1 dirt
  { friction: 0.9, restitution: 0.02 }, // 2 grass
  { friction: 0.85, restitution: 0.04 }, // 3 asphalt
  { friction: 0.85, restitution: 0.03 }, // 4 concrete
  { friction: 0.8, restitution: 0.05 }, // 5 brick
  { friction: 0.7, restitution: 0.25 }, // 6 wood
  { friction: 0.75, restitution: 0.05 }, // 7 plaster
  { friction: 0.4, restitution: 0.1 }, // 8 glass
  { friction: 0.25, restitution: 0.3 }, // 9 metal
  { friction: 0.3, restitution: 0.0 }, // 10 water-solid
  { friction: 0.9, restitution: 0.0 }, // 11 leaves
  { friction: 0.7, restitution: 0.15 }, // 12 rooftile
  { friction: 0.5, restitution: 0.2 }, // 13 lamp
  { friction: 0.8, restitution: 0.0 }, // 14 flesh
]

const DEFAULT_FEEL: MaterialFeel = { friction: 0.5, restitution: 0.05 }

/** feel params for a material id — safe on ids outside the table */
export function materialFeel(mat: number): MaterialFeel {
  return MATERIAL_FEEL[mat] ?? DEFAULT_FEEL
}

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
  /** dominant material id (most voxels, ties → lowest id) — feel + buoyancy */
  mat: number
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

/** B17 — result of a ray cast against dynamic island bodies */
export interface BodyRayHit {
  body: DynamicBody
  fraction: number
  /** hit point, world meters */
  px: number
  py: number
  pz: number
  /** surface normal at the hit */
  nx: number
  ny: number
  nz: number
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

  /** player entities keyed by playerId (T21) — see player.ts */
  readonly players = new Map<number, PlayerEntity>()

  /** T54 bomb projectiles keyed by entity id (V8) — see projectiles.ts */
  readonly projectiles = new Map<number, Projectile>()

  /**
   * T60 — water field reference for player swimming. Set by attachBuoyancy()
   * (buoyancy-coupling.ts) — the one wiring point that already sees both
   * physics and water. Null until then; swimming is inert without it.
   * Water steps before physics in the sim system order (game.ts), so player
   * updates read the current tick's field — deterministic (V2).
   */
  water: WaterSim | null = null

  /**
   * T60 — splash event hook (render/audio layer, V6): fired when a player
   * enters/exits swimming with meaningful vertical speed. The callback runs
   * in-tick and MUST NOT mutate sim state. See INTEGRATION-water.md §7.
   */
  onSplash: ((e: SplashEvent) => void) | null = null

  /** total bodies removed by the kill plane — hashed sim state (T40, V3) */
  removedBodies = 0

  private readonly settings: Jolt.JoltSettings
  /** shared gravity vector for character updates (matches physics system gravity) */
  readonly gravity: Jolt.Vec3
  // CharacterVirtual update plumbing (T21) — built once, reused every tick
  readonly updateSettings: Jolt.ExtendedUpdateSettings
  readonly movingBPFilter: Jolt.BroadPhaseLayerFilter
  readonly movingLayerFilter: Jolt.ObjectLayerFilter
  readonly bodyFilter: Jolt.BodyFilter
  readonly shapeFilter: Jolt.ShapeFilter
  readonly tempAllocator: Jolt.TempAllocator
  // pass-all filters for narrow-phase ray queries (B17)
  private readonly allBPFilter: Jolt.BroadPhaseLayerFilter
  private readonly allObjFilter: Jolt.ObjectLayerFilter

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
    this.updateSettings = new api.ExtendedUpdateSettings()
    // d.ts mistypes DefaultBroadPhaseLayerFilter as ObjectLayerFilter; runtime is correct
    this.movingBPFilter = new api.DefaultBroadPhaseLayerFilter(
      this.joltInterface.GetObjectVsBroadPhaseLayerFilter(),
      LAYER_MOVING,
    ) as unknown as Jolt.BroadPhaseLayerFilter
    this.movingLayerFilter = new api.DefaultObjectLayerFilter(this.joltInterface.GetObjectLayerPairFilter(), LAYER_MOVING)
    this.bodyFilter = new api.BodyFilter()
    this.shapeFilter = new api.ShapeFilter()
    this.tempAllocator = this.joltInterface.GetTempAllocator()
    this.allBPFilter = new api.BroadPhaseLayerFilter()
    this.allObjFilter = new api.ObjectLayerFilter()

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
    updatePlayers(this, sim) // character controllers, fixed order (T21)
    tickProjectiles(sim, this) // T54 — bomb arcs/fuses; detonation spawns ejecta this tick
    this.readbackBodies()
    this.killPlanePass()
  }

  /**
   * T40 — kill plane: bodies whose origin fell below KILL_PLANE_Y leave the
   * sim and Jolt this tick. Removal order = ascending entity id (map insertion
   * is allocation order, but sort anyway — deterministic, hashable via the
   * removedBodies counter + body-set shrink).
   */
  private killPlanePass(): void {
    let doomed: number[] | undefined
    for (const [id, b] of this.bodies) {
      if (b.py < KILL_PLANE_Y) (doomed ??= []).push(id)
    }
    if (!doomed) return
    doomed.sort((a, b) => a - b)
    for (const id of doomed) {
      const b = this.bodies.get(id)!
      this.bodyInterface.RemoveBody(b.body.GetID())
      this.bodyInterface.DestroyBody(b.body.GetID())
      this.bodies.delete(id)
      this.removedBodies++
    }
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
    for (const v of island.voxels) sim.world.setVoxel(v.x, v.y, v.z, 0)
    return this.buildVoxelBody(sim, island.voxels)
  }

  /**
   * T55 — ejecta clump → dynamic body. Voxels were already removed from the
   * ChunkStore by the explosion scan; this only creates the body entity.
   */
  spawnDebrisBody(sim: Sim, voxels: IslandVoxel[]): DynamicBody {
    return this.buildVoxelBody(sim, voxels)
  }

  /**
   * T55 — set a fresh body's linear + angular velocity (clamped to the T40
   * caps). Deterministic: called from op handlers only.
   */
  setBodyVelocity(b: DynamicBody, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): void {
    const api = this.api
    const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz)
    if (vlen > MAX_BODY_LINEAR_VELOCITY) {
      const s = MAX_BODY_LINEAR_VELOCITY / vlen
      vx *= s; vy *= s; vz *= s
    }
    const wlen = Math.sqrt(wx * wx + wy * wy + wz * wz)
    if (wlen > MAX_BODY_ANGULAR_VELOCITY) {
      const s = MAX_BODY_ANGULAR_VELOCITY / wlen
      wx *= s; wy *= s; wz *= s
    }
    const v = new api.Vec3(vx, vy, vz)
    const w = new api.Vec3(wx, wy, wz)
    this.bodyInterface.SetLinearAndAngularVelocity(b.body.GetID(), v, w)
    api.destroy(v)
    api.destroy(w)
  }

  /** Shared body construction for islands (T12) and ejecta clumps (T55). */
  private buildVoxelBody(sim: Sim, vs: IslandVoxel[]): DynamicBody {
    if (vs.length === 0) throw new Error('buildVoxelBody: empty voxel set')
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
    const matCounts = new Uint32Array(256)
    for (const v of vs) {
      grid[v.x - x0 + (v.z - z0) * sx + (v.y - y0) * sx * sz] = v.mat
      mass += material(v.mat).density * VOXEL_VOLUME
      matCounts[v.mat]++
    }
    // dominant material: most voxels, ties broken by lowest id (deterministic)
    let mat = 0
    let best = 0
    for (let m = 1; m < 256; m++) {
      if (matCounts[m] > best) {
        best = matCounts[m]
        mat = m
      }
    }

    const api = this.api
    const shape = this.buildBoxesShape(greedyBoxes(grid, sx, sy, sz))
    const pos = new api.RVec3(x0 * VOXEL_SIZE, y0 * VOXEL_SIZE, z0 * VOXEL_SIZE)
    const rot = new api.Quat(0, 0, 0, 1)
    const bcs = new api.BodyCreationSettings(shape, pos, rot, api.EMotionType_Dynamic, LAYER_MOVING)
    bcs.mOverrideMassProperties = api.EOverrideMassProperties_CalculateInertia
    bcs.mMassPropertiesOverride.mMass = mass
    // T40 feel: per-material surface response + velocity caps + settle damping
    const feel = materialFeel(mat)
    bcs.mFriction = feel.friction
    bcs.mRestitution = feel.restitution
    bcs.mAngularDamping = BODY_ANGULAR_DAMPING
    bcs.mMaxLinearVelocity = MAX_BODY_LINEAR_VELOCITY
    bcs.mMaxAngularVelocity = MAX_BODY_ANGULAR_VELOCITY
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
      mat,
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
    // T63 (B23): reusable temporaries — Jolt copies constructor/AddShape args,
    // so one Vec3 each suffices. The old per-box `new api.Vec3` pair was never
    // destroyed: a WASM heap leak plus 2 allocs per box on every chunk rebuild.
    const halfExtent = new api.Vec3(0, 0, 0)
    const center = new api.Vec3(0, 0, 0)
    const makeBox = (b: Box) => {
      halfExtent.Set(b.sx * half, b.sy * half, b.sz * half)
      return new api.BoxShapeSettings(halfExtent, 0)
    }
    const setCenter = (b: Box) =>
      center.Set((b.x + b.sx * 0.5) * VOXEL_SIZE, (b.y + b.sy * 0.5) * VOXEL_SIZE, (b.z + b.sz * 0.5) * VOXEL_SIZE)

    let settings: Jolt.ShapeSettings
    if (boxes.length === 1) {
      const rot = new api.Quat(0, 0, 0, 1)
      setCenter(boxes[0])
      settings = new api.RotatedTranslatedShapeSettings(center, rot, makeBox(boxes[0]))
      api.destroy(rot)
    } else {
      const compound = new api.StaticCompoundShapeSettings()
      const rot = new api.Quat(0, 0, 0, 1)
      for (const b of boxes) {
        const bs = makeBox(b)
        setCenter(b)
        compound.AddShape(center, rot, bs, 0)
      }
      api.destroy(rot)
      settings = compound
    }
    api.destroy(halfExtent)
    api.destroy(center)
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

  // ---------------------------------------------------------------------------
  // B17 — dynamic bodies react to shooting/digging/blasts
  // ---------------------------------------------------------------------------

  /**
   * B17 — narrow-phase ray vs Jolt bodies. Returns the closest DYNAMIC island
   * body hit within maxDist (meters), or null. Static chunk bodies may be the
   * closest hit — they carry userdata 0 and map to no entity, which correctly
   * yields null (the world DDA owns voxel hits). Deterministic: Jolt query
   * over deterministic body state (V2).
   */
  castRayBody(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): BodyRayHit | null {
    const api = this.api
    const origin = new api.RVec3(ox, oy, oz)
    const dir = new api.Vec3(dx * maxDist, dy * maxDist, dz * maxDist)
    const ray = new api.RRayCast(origin, dir)
    const settings = new api.RayCastSettings()
    const collector = new api.CastRayClosestHitCollisionCollector()
    this.physicsSystem
      .GetNarrowPhaseQuery()
      .CastRay(ray, settings, collector, this.allBPFilter, this.allObjFilter, this.bodyFilter, this.shapeFilter)
    let out: BodyRayHit | null = null
    if (collector.HadHit()) {
      const hit = collector.mHit
      const body = this.bodies.get(this.bodyInterface.GetUserData(hit.mBodyID))
      if (body) {
        const f = hit.mFraction
        const px = ox + dx * maxDist * f
        const py = oy + dy * maxDist * f
        const pz = oz + dz * maxDist * f
        const pos = new api.RVec3(px, py, pz)
        const n = body.body.GetWorldSpaceSurfaceNormal(hit.mSubShapeID2, pos)
        out = { body, fraction: f, px, py, pz, nx: n.GetX(), ny: n.GetY(), nz: n.GetZ() }
        api.destroy(pos)
      }
    }
    api.destroy(collector)
    api.destroy(settings)
    api.destroy(ray)
    api.destroy(origin)
    api.destroy(dir)
    return out
  }

  /** B17 — impulse on a body at a world point (shot response). */
  impulseBodyAt(b: DynamicBody, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void {
    const api = this.api
    this.bodyInterface.ActivateBody(b.body.GetID())
    const imp = new api.Vec3(ix, iy, iz)
    const at = new api.RVec3(px, py, pz)
    b.body.AddImpulse(imp, at)
    api.destroy(imp)
    api.destroy(at)
  }

  /**
   * B17 — remove voxels from a body's mini grid inside a world-space sphere
   * (same falloff·power ≥ strength rule as world destruction). Rebuilds the
   * compound collider + mass on change; despawns the body when it empties.
   * Returns the number of voxels removed. Deterministic (fixed y→z→x scan).
   */
  damageBodySphere(
    b: DynamicBody,
    wx: number,
    wy: number,
    wz: number,
    rMeters: number,
    power: number,
    snapToVoxel = false,
  ): number {
    // world → body-local (grid corner origin): l = R⁻¹ · (w − p)
    const tx = wx - b.px
    const ty = wy - b.py
    const tz = wz - b.pz
    // rotate by conjugate quaternion: v' = v + 2 q̄×(q̄×v + w·v), q̄ = -q.xyz
    const qx = -b.qx, qy = -b.qy, qz = -b.qz, qw = b.qw
    const cx1 = qy * tz - qz * ty + qw * tx
    const cy1 = qz * tx - qx * tz + qw * ty
    const cz1 = qx * ty - qy * tx + qw * tz
    let lx = tx + 2 * (qy * cz1 - qz * cy1)
    let ly = ty + 2 * (qz * cx1 - qx * cz1)
    let lz = tz + 2 * (qx * cy1 - qy * cx1)
    if (snapToVoxel) {
      // center the sphere on the containing voxel's center — matches the
      // world path (destroySphere at hit voxel center + 0.5), so a shot
      // kills the hit voxel instead of grazing between cells
      lx = (Math.floor(lx / VOXEL_SIZE) + 0.5) * VOXEL_SIZE
      ly = (Math.floor(ly / VOXEL_SIZE) + 0.5) * VOXEL_SIZE
      lz = (Math.floor(lz / VOXEL_SIZE) + 0.5) * VOXEL_SIZE
    }

    const { grid, sx, sy, sz } = b
    let removed = 0
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          const mat = grid[x + z * sx + y * sx * sz]
          if (mat === 0) continue
          const dx = (x + 0.5) * VOXEL_SIZE - lx
          const dy = (y + 0.5) * VOXEL_SIZE - ly
          const dz = (z + 0.5) * VOXEL_SIZE - lz
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d > rMeters) continue
          const falloff = 1 - d / rMeters
          if (falloff * power >= material(mat).strength) {
            grid[x + z * sx + y * sx * sz] = 0
            b.mass -= material(mat).density * VOXEL_VOLUME
            b.count--
            removed++
          }
        }
      }
    }
    if (removed === 0) return 0
    b.version++
    if (b.count <= 0) {
      this.despawnBody(b)
      return removed
    }
    const boxes = greedyBoxes(grid, sx, sy, sz)
    if (boxes.length === 0) {
      this.despawnBody(b)
      return removed
    }
    const shape = this.buildBoxesShape(boxes)
    this.bodyInterface.SetShape(b.body.GetID(), shape, false, this.api.EActivation_Activate)
    // keep the explicit voxel mass authoritative (inertia stays shape-derived)
    b.body.GetMotionProperties().SetInverseMass(1 / Math.max(b.mass, 0.001))
    return removed
  }

  /**
   * B17 — blast damage to body voxels: every body near the blast center loses
   * voxels by the same strength rule the world uses. Deterministic id order.
   * Coordinates in meters.
   */
  damageBodiesSphere(wx: number, wy: number, wz: number, rMeters: number, power: number, onlyIds?: number[]): void {
    const ids = onlyIds ?? [...this.bodies.keys()] // snapshot: despawn mutates the map
    for (const id of ids) {
      const b = this.bodies.get(id)
      if (!b) continue
      // coarse cull on the body's bounding sphere around its grid center
      const hx = b.px + (b.sx * VOXEL_SIZE) / 2 - wx
      const hy = b.py + (b.sy * VOXEL_SIZE) / 2 - wy
      const hz = b.pz + (b.sz * VOXEL_SIZE) / 2 - wz
      const reach = rMeters + (Math.sqrt(b.sx * b.sx + b.sy * b.sy + b.sz * b.sz) * VOXEL_SIZE) / 2
      if (hx * hx + hy * hy + hz * hz > reach * reach) continue
      this.damageBodySphere(b, wx, wy, wz, rMeters, power)
    }
  }

  /** Remove a body from the sim + Jolt (emptied by damage). Hash-visible via removedBodies. */
  private despawnBody(b: DynamicBody): void {
    this.bodyInterface.RemoveBody(b.body.GetID())
    this.bodyInterface.DestroyBody(b.body.GetID())
    this.bodies.delete(b.id)
    this.removedBodies++
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
    this.projectiles.clear()
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
  h.u32(phys.removedBodies) // kill-plane removals are sim state (T40)
  const ids = [...phys.bodies.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const b = phys.bodies.get(id)!
    h.u32(id)
    h.f64(b.px).f64(b.py).f64(b.pz)
    h.f64(b.qx).f64(b.qy).f64(b.qz).f64(b.qw)
    h.f64(b.mass)
    h.u32(b.mat)
    h.u32(b.sx).u32(b.sy).u32(b.sz)
    h.bytes(b.grid)
  }
  // T54 — projectiles are sim state (V3)
  h.u32(phys.projectiles.size)
  const projIds = [...phys.projectiles.keys()].sort((a, b) => a - b)
  for (const id of projIds) {
    const p = phys.projectiles.get(id)!
    h.u32(id)
    h.f64(p.x).f64(p.y).f64(p.z)
    h.f64(p.vx).f64(p.vy).f64(p.vz)
    h.u32(p.fuse)
    h.u8(p.resting ? 1 : 0)
  }
  h.u32(phys.players.size)
  const pids = [...phys.players.keys()].sort((a, b) => a - b)
  for (const pid of pids) {
    const p = phys.players.get(pid)!
    h.u32(pid).u32(p.id)
    h.f64(p.px).f64(p.py).f64(p.pz)
    h.f64(p.vx).f64(p.vy).f64(p.vz)
    h.f64(p.yaw).f64(p.pitch)
    h.u32(p.input)
    h.u32(p.flags)
    // T44/T47 — capsule height + noclip are sim state (V3)
    h.u32((p.crouching ? 1 : 0) | (p.noclip ? 2 : 0))
    for (const seg of p.segments) {
      h.u32(seg.count)
      h.bytes(seg.grid)
    }
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
  registerDestructionOps(sim, phys)
  registerPlayerOps(sim, phys)
  registerProjectileOps(sim, phys) // T54 — 'throw' op; integration runs in phys.tick
  attachEditPhysics(sim, phys) // B17 — dig pushes rubble

  phys.initStatic(sim.world)
  sim.addSystem(() => phys.tick(sim))
  return phys
}
