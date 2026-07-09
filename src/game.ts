/**
 * T31 — game module: owns sim + render construction and the frame loop.
 * main.ts is thin orchestration (boot phases, menu/HUD routing) on top.
 *
 * Wiring order is fixed and preserved from the original main.ts (V2):
 * stamp scene → water attach → onVoxelChanged hook → pool fill →
 * loadJolt/createPhysics → renderer/WorldRenderer (dirtySource =
 * phys.drainRemesh) → BodyMeshes → WaterSurface → per-frame loop.
 *
 * States (render-side only, V6 — sim always ticks the same way):
 *   'orbit' — cinematic camera circles the suburb (menu backdrop)
 *   'play'  — player cam (fp/tp) or fly/spectator cam (T45)
 */
import { Color, Scene, WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu'
import { WorldRenderer } from './render/world-renderer'
import { PlayerCam } from './render/player-cam'
import { PlayerInput } from './render/player-input'
import { PlayerVisuals } from './render/player-visuals'
import { SpectatorCam } from './render/spectator-cam'
import { WaterSurface } from './render/water/surface'
import { BodyMeshes } from './render/body-meshes'
import { DebrisMeshes } from './render/debris-meshes'
import { RagdollMeshes } from './render/ragdoll-meshes'
import { VehicleMeshes } from './render/vehicle-meshes'
import { Birds } from './render/birds'
import { Flashlight } from './render/flashlight'
import { UnderwaterOverlay } from './render/water/underwater'
import { FxSystem } from './render/fx/fx-system'
import { ProjectileMeshes } from './render/projectile-meshes'
import { RocketMeshes } from './render/rocket-meshes'
import { TntMeshes } from './render/tnt-meshes'
import { FixedStepDriver, Sim } from './sim/loop'
import type { Op } from './sim/commands'
import { HIDDEN_HEARTBEAT_LEAD, type LockstepDriver, type LockstepNode } from './net/lockstep'
import { registerEditOps } from './sim/edit-ops'
import { registerShootOp } from './sim/shoot-op'
import { createPhysics, loadJolt, type PhysicsWorld } from './sim/physics'
import { spawnVehicle, type VehicleEntity } from './sim/vehicle'
import { spawnAircraft } from './sim/aircraft'
import { attachBuoyancy } from './sim/buoyancy-coupling'
import { attachWaterSim, type WaterSim } from './sim/water/water-sim'
import { generateLayout } from './sim/gen/layout'
import { stampScene } from './sim/gen/stamper'
import { stampMiniScene } from './sim/gen/mini-scene'
import { placeholderProps } from './sim/gen/props'
import { nextSeq } from './render/command-seq'
import { CHUNK_COUNT, VOXEL_SIZE, WORLD_VX, WORLD_VZ } from './world/chunks'
import type { Settings } from './ui/settings-store'
import { PlayerMesh } from './render/player-mesh'
import { lerpTransform } from './render/interp'

/** solo default. In MP the session assigns Game.localPlayerId (host=1, guests 2..4). */
export const LOCAL_PLAYER = 1

/** T71 — lockstep session handle: the loop advances via the tick barrier */
export interface NetSession {
  node: LockstepNode
  driver: LockstepDriver
}

export type GameState = 'orbit' | 'play'
export type StageId = 'world' | 'physics' | 'renderer' | 'meshing'

export interface CreateGameOptions {
  seed: number
  host: HTMLElement
  onStage?: (stage: StageId) => void
  /** initial graphics settings (applied before first frame) */
  graphics?: Settings['graphics']
  /**
   * T71 — MP: freeze the sim at tick 0 until attachNet(). Without this the
   * loop free-runs the fresh session game while peers are still building,
   * and lockstep tick 0 meets a sim already hundreds of ticks in (found by
   * mp-e2e: "stale bundle for tick 0 (sim at 484)"). Rendering/meshing still
   * run — initStatic seeds the remesh feed without any ticks.
   */
  holdTicks?: boolean
  /** T98 — 'mini' = small test arena (dev boot); 'full' (default) = the city */
  world?: 'full' | 'mini'
}

/** orbit rig tuning (menu backdrop) */
const ORBIT_RADIUS = 30
const ORBIT_HEIGHT = 16
const ORBIT_BOB = 2.2
const ORBIT_RATE = 0.05 // rad/s

const QUALITY = {
  low: { pixelRatio: 1, shadow: 1024, bloom: false, ao: false, clouds: false, textures: false },
  medium: { pixelRatio: 1.5, shadow: 2048, bloom: false, ao: true, clouds: true, textures: true },
  // B34 — 'high' pixelRatio 2.0→1.6: applied as min(devicePixelRatio, cap), so
  // it only bites on hi-DPI. On a retina Mac (dpr 2) the scene + the whole post
  // stack (GTAO, bloom, tonemap) ran at 4× the fragments; 1.6 cuts that ~36% for
  // a barely-perceptible softening (still supersampled). 'ultra' can restore 2.
  high: { pixelRatio: 2, shadow: 2048, bloom: true, ao: true, clouds: true, textures: true },
} as const

/** let the browser paint (preloader stage updates) between heavy sync phases */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/** B31 — heading (world yaw, rad) of a vehicle from its quaternion, using the
 * same forward = -z convention as the player. Roll/pitch on hills are ignored;
 * the seated body only needs to face the car's heading. */
function vehicleYaw(v: { qx: number; qy: number; qz: number; qw: number }): number {
  return Math.atan2(2 * (v.qx * v.qz + v.qw * v.qy), 1 - 2 * (v.qx * v.qx + v.qy * v.qy))
}

/** T90 — aircraft chase boom multiplier: a plane needs the camera much further
 *  back than a car to be steerable from outside */
const AIRCRAFT_CHASE_BOOM = 2.2

export class Game {
  readonly seed: number
  readonly sim: Sim
  readonly phys: PhysicsWorld
  readonly water: WaterSim
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly cam: PlayerCam
  readonly input: PlayerInput
  readonly world: WorldRenderer

  state: GameState = 'orbit'
  /** T71 — this client's sim identity. Solo: always 1. MP: host-assigned. */
  localPlayerId = LOCAL_PLAYER
  /** T45 fly/spectator mode (only meaningful in 'play') */
  flying = false
  onFlyChange: ((flying: boolean) => void) | null = null
  /** local player took segment damage this frame (T28 hit feedback) */
  onPlayerDamaged: (() => void) | null = null

  private readonly driver = new FixedStepDriver()
  /** T71 — non-null while a lockstep session is live; the loop then advances
   *  ONLY host-released ticks (tick barrier) and local ops go over the wire. */
  private net: NetSession | null = null
  /** MP: one move op per stepped frame (avoids unbounded pile-up at a stall) */
  private movePending = false
  /** sim frozen until attachNet (MP build phase, see CreateGameOptions.holdTicks) */
  private holdTicks = false
  /** T71 — remote player bodies (playerId → mesh); local player uses playerVisuals */
  private readonly remoteMeshes = new Map<number, PlayerMesh>()
  private disposed = false
  private readonly onResize: () => void
  private readonly waterSurface: WaterSurface
  private readonly bodyMeshes: BodyMeshes
  /** T86 — local Box3D debris render: active pieces individual, frozen batched */
  private readonly debrisMeshes: DebrisMeshes
  /** P17 — flyable aircraft render from their voxel grid (BodyMeshes pattern;
   *  a wrecked plane moves into phys.bodies and the main bodyMeshes takes over) */
  private readonly aircraftMeshes: BodyMeshes
  /** T77 — death-ragdoll corpses (6 boxes per ragdoll, V6 read-only) */
  private readonly ragdollMeshes: RagdollMeshes
  private readonly fx: FxSystem
  private readonly vehicleMeshes: VehicleMeshes
  private readonly birds = new Birds()
  readonly flashlight: Flashlight
  private readonly underwater = new UnderwaterOverlay()
  private readonly projectileMeshes: ProjectileMeshes
  /** P19 — rocket-launcher projectile + placed-TNT-charge visuals (V6 reads) */
  private readonly rocketMeshes: RocketMeshes
  private readonly tntMeshes: TntMeshes
  /** sim event tap for audio (main.ts) — called with the frame's drained events */
  onSimEvents: ((events: ReturnType<Sim['drainEvents']>) => void) | null = null
  private readonly spectator: SpectatorCam
  private readonly hudEl: HTMLElement | null
  private playerVisuals: PlayerVisuals | undefined
  /** T49 — equipped hotbar tool id provider (wired by main.ts) */
  equippedTool: (() => string) | null = null
  private spawned = false
  private lastDamageSum = 0
  private lastRenderCalls = 0
  private lastRenderTriangles = 0
  private readonly frameHooks = new Set<(dt: number) => void>()

  private constructor(opts: {
    seed: number
    sim: Sim
    phys: PhysicsWorld
    water: WaterSim
    renderer: WebGPURenderer
    scene: Scene
    cam: PlayerCam
    input: PlayerInput
    world: WorldRenderer
  }) {
    this.seed = opts.seed
    this.sim = opts.sim
    this.phys = opts.phys
    this.water = opts.water
    this.renderer = opts.renderer
    this.scene = opts.scene
    this.cam = opts.cam
    this.input = opts.input
    this.world = opts.world
    this.waterSurface = new WaterSurface()
    this.scene.add(this.waterSurface.mesh)
    this.bodyMeshes = new BodyMeshes(this.scene, this.world.chunks.material)
    this.debrisMeshes = new DebrisMeshes(this.scene, this.world.chunks.material) // T86 — local Box3D debris (V17)
    this.aircraftMeshes = new BodyMeshes(this.scene, this.world.chunks.material) // P17
    this.ragdollMeshes = new RagdollMeshes(this.scene) // T77 — death ragdolls
    // T64 — vehicle rendering (chassis via chunk materials, spinning wheels)
    this.vehicleMeshes = new VehicleMeshes(
      this.scene,
      this.world.chunks.material,
      this.world.chunks.transparentMaterial,
    )
    // T53 — event-driven destruction/combat VFX (V6: reads events, writes nothing)
    this.fx = new FxSystem(this.sim.world)
    this.scene.add(this.fx.group)
    // T54 — bomb projectile visuals (reads phys.projectiles, trails via fx)
    this.projectileMeshes = new ProjectileMeshes(this.scene, this.fx)
    // P19 — rocket projectile + placed TNT charge visuals (read-only, V6)
    this.rocketMeshes = new RocketMeshes(this.scene, this.fx)
    this.tntMeshes = new TntMeshes(this.scene, this.fx)
    // T74 birds + T75 flashlight + T60 underwater tint (all render-only, V6)
    this.scene.add(this.birds.group)
    this.flashlight = new Flashlight(this.cam.camera)
    this.scene.add(this.flashlight.group)
    this.spectator = new SpectatorCam(this.cam.camera, this.input)
    this.hudEl = document.getElementById('hud')

    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' && this.state === 'play' && !this.disposed) this.toggleFly()
    })

    this.onResize = () => {
      this.cam.camera.aspect = innerWidth / innerHeight
      this.cam.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
      this.world.resize()
    }
    addEventListener('resize', this.onResize)
  }

  /**
   * T71 — attach a live lockstep session. From here on the frame loop
   * advances only released ticks and pushOp routes over the wire.
   * Must be called before enterPlay so the spawn op ships via lockstep.
   */
  attachNet(net: NetSession): void {
    if (this.net) throw new Error('game: net session already attached')
    if (net.node.sim !== this.sim) throw new Error('game: lockstep node drives a different sim')
    if (this.sim.tick !== 0) {
      // V10: lockstep MUST start from identical state on every peer
      throw new Error(`game: net attach at tick ${this.sim.tick} — sim must be pristine (holdTicks)`)
    }
    this.net = net
  }

  /**
   * T71 — the sanctioned op path for UI/tools (V1). Solo: straight into
   * sim.queue at the current tick. MP: LockstepNode.submitLocal — the op
   * applies at tick+inputDelay on EVERY peer simultaneously; pushing into
   * sim.queue directly in MP would desync (only this client would see it).
   */
  pushOp(op: Op): void {
    if (this.net) this.net.node.submitLocal(op)
    else this.sim.queue.push({ tick: this.sim.tick, playerId: this.localPlayerId, seq: nextSeq(), op })
  }

  /**
   * T71 — stop this Game instance (MP session start replaces the menu-orbit
   * backdrop game with a fresh seed-synced one). The old instance's document
   * listeners stay registered but are inert (state stays 'orbit', canvas is
   * detached). The Jolt world is NOT destroyed — one physics world leaks per
   * session start (safe: WASM heap, reclaimed on page unload; teardown of a
   * live Jolt world while another boots is riskier than the leak).
   */
  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    removeEventListener('resize', this.onResize)
    this.renderer.domElement.remove()
    try {
      this.renderer.dispose()
    } catch (e) {
      console.warn('[game] renderer dispose failed:', e)
    }
  }

  /** per-frame render-layer hook (tools, dev overlay). Returns unsubscribe. */
  addFrameHook(fn: (dt: number) => void): () => void {
    this.frameHooks.add(fn)
    return () => this.frameHooks.delete(fn)
  }

  /** spawn (idempotent) + switch to player camera */
  enterPlay(defaultCamMode: 'fp' | 'tp'): void {
    if (!this.spawned) {
      this.spawned = true
      this.pushOp({ kind: 'spawn' })
    }
    this.cam.mode = defaultCamMode
    this.state = 'play'
    if (this.flying) this.toggleFly()
  }

  /** T47 — dev noclip toggle (deterministic op; UI gates behind dev mode) */
  toggleNoclip(): void {
    this.pushOp({ kind: 'noclip' })
  }

  /** back to the cinematic orbit (quit to menu) */
  enterOrbit(): void {
    this.state = 'orbit'
    if (this.flying) this.toggleFly()
  }

  /**
   * B29 — fly now MOVES THE BODY: F rides the deterministic noclip op
   * (player entity flies via move commands, works in lockstep), so exiting
   * fly drops you where you are. The camera stays the player cam (fp/tp).
   * The old detached SpectatorCam remains only for the menu orbit.
   */
  toggleFly(): void {
    this.flying = !this.flying
    this.toggleNoclip() // deterministic sim op; move input flies the capsule
    this.onFlyChange?.(this.flying)
  }

  /** T34 — apply graphics settings live (render-only knobs, V6) */
  applyGraphics(g: Settings['graphics']): void {
    const q = QUALITY[g.quality]
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio))
    this.renderer.setSize(innerWidth, innerHeight)
    this.cam.camera.fov = g.fov
    this.cam.camera.updateProjectionMatrix()
    try {
      const shadow = this.world.sun.shadow
      if (shadow.mapSize.x !== q.shadow) {
        shadow.mapSize.set(q.shadow, q.shadow)
        shadow.map?.dispose()
        shadow.map = null
      }
    } catch (e) {
      console.warn('[settings] shadow map resize failed (applies on reload):', e)
    }
    // NOTE: bloom on/off is baked into the WorldRenderer pipeline at creation
    // (render pipeline is owned by the perf track) — applies on next boot.
    // gfx dials (settings.gfx.*) re-assert after the preset stomps
    // pixelRatio / shadow map size — see WorldRenderer.reapplyGfxOverrides.
    this.world.reapplyGfxOverrides()
  }

  /**
   * Resolves when initial meshing is PRESENTABLE — not complete. The remesh
   * scheduler is near-camera-first, so the menu-orbit view meshes first;
   * gating on ~45% coverage (or the cap) shows the menu in a few seconds
   * while the far districts keep streaming in behind it. Full completion
   * still happens in the background (HUD `pending` drains to 0).
   */
  waitForMeshing(capMs = 8000): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now()
      let initial = 0
      const off = this.addFrameHook(() => {
        const pending = this.world.chunks.pendingCount
        initial = Math.max(initial, pending)
        const presentable = initial > 0 && pending <= initial * 0.55
        const minShown = performance.now() - start > 800 // let the burst fill the near view
        if ((presentable && minShown) || pending === 0 || performance.now() - start > capMs) {
          off()
          resolve()
        }
      })
    })
  }

  private orbitSnap = true

  /** T99 — interpolated chase-cam target (reused scratch; render-only) */
  private readonly chaseScratch = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 0, sy: 0, sz: 0 }
  private lerpedChase(v: { sx: number; sy: number; sz: number } & Parameters<typeof lerpTransform>[0], alpha: number) {
    lerpTransform(v, alpha, this.chaseScratch)
    this.chaseScratch.sx = v.sx
    this.chaseScratch.sy = v.sy
    this.chaseScratch.sz = v.sz
    return this.chaseScratch
  }

  private orbitUpdate(nowMs: number, dt: number): void {
    const t = nowMs / 1000
    const cx = (WORLD_VX / 2) * VOXEL_SIZE
    const cz = (WORLD_VZ / 2) * VOXEL_SIZE
    const a = t * ORBIT_RATE
    const cam = this.cam.camera
    const tx = cx + Math.cos(a) * ORBIT_RADIUS
    const ty = ORBIT_HEIGHT + Math.sin(t * 0.23) * ORBIT_BOB
    const tz = cz + Math.sin(a) * ORBIT_RADIUS
    // exponential lerp toward the rig — smooth handoff when re-entering orbit
    const k = this.orbitSnap ? 1 : 1 - Math.exp(-2.5 * dt)
    this.orbitSnap = false
    cam.position.x += (tx - cam.position.x) * k
    cam.position.y += (ty - cam.position.y) * k
    cam.position.z += (tz - cam.position.z) * k
    cam.lookAt(cx, 6, cz)
  }

  /** rAF starvation diagnostics (mp-e2e triage; __bbNet reads these) */
  lastRafAt = performance.now()
  maxRafGapMs = 0

  /**
   * T71/T72 — advance the lockstep session. Called from the rAF loop AND
   * from a low-frequency background pump: if rAF starves (occluded/
   * backgrounded tab, GPU contention — observed 30s+ gaps in headless e2e),
   * a peer that only steps in rAF stops sending inputs and stalls the whole
   * session until the host drops it. The pump keeps the barrier fed;
   * rendering stays rAF-only. Time comes from one shared clock so the two
   * callers never double-count (V2: ticks, not wall time, stay authoritative).
   */
  private lastNetAdvanceAt = performance.now()

  private advanceNet(): void {
    if (!this.net) return
    const now = performance.now()
    const dtMs = now - this.lastNetAdvanceAt
    this.lastNetAdvanceAt = now
    // T71 — lockstep: local move ships via submitLocal (applies at
    // tick+inputDelay everywhere). One move per stepped advance: at a
    // barrier stall we stop submitting so a 30s stall doesn't dump
    // thousands of stale moves into one bundle on release.
    if (this.spawned && !this.movePending) {
      this.net.node.submitLocal({
        kind: 'move',
        input: this.input.inputBits(), // B29: noclip-fly consumes input too
        yaw: this.input.yaw,
        pitch: this.input.pitch,
      })
      this.movePending = true
    }
    // advance ONLY released ticks (tick barrier, V2) — never free-run
    if (this.net.driver.advance(dtMs, this.net.node) > 0) this.movePending = false
  }

  private startLoop(): void {
    let last = performance.now()
    let frames = 0
    let fpsAt = last
    // background pump: only acts when rAF has been silent for >250ms.
    // maxStepsPerAdvance on the interval path must cover the pump period at
    // 60Hz (250ms ≈ 15 ticks) or a starved tab caps below real-time.
    const pump = setInterval(() => {
      if (this.disposed) {
        clearInterval(pump)
        return
      }
      if (!this.net) return
      // Hidden-tab heartbeat: a backgrounded tab stops stepping, so it stops
      // emitting inputs and the ACTIVE peer stalls at the barrier waiting on us
      // (the ping-pong lockup). Keep our input flowing ahead so peers never
      // stall. Gated on document.hidden — a hidden tab receives no input, so
      // pre-committing empty inputs is lossless; NEVER while visible.
      if (document.hidden) this.net.node.pumpEmptyInput(HIDDEN_HEARTBEAT_LEAD)
      if (performance.now() - this.lastRafAt < 250) return
      // real background tabs throttle timers to ~1s — 60 steps covers a full
      // second so a hidden tab holds 60Hz instead of dragging the barrier
      this.net.driver.maxStepsPerAdvance = 60
      this.advanceNet()
      this.net.driver.maxStepsPerAdvance = 10
    }, 250)
    this.renderer.setAnimationLoop((now: number) => {
      const dtMs = Math.min(now - last, 100)
      last = now
      const dt = dtMs / 1000
      this.maxRafGapMs = Math.max(this.maxRafGapMs, now - this.lastRafAt)
      this.lastRafAt = now

      if (this.net) {
        this.advanceNet()
      } else if (this.holdTicks) {
        // MP build phase: render/mesh, but the sim stays at tick 0 for lockstep
      } else {
        // solo: local input → command queue directly
        if (this.spawned) {
          // flying: spectator cam roams, capsule stays put → empty move bits (T45)
          this.sim.queue.push(
            this.input.moveCommand(this.sim.tick, this.localPlayerId),
          )
        }
        this.driver.advance(dtMs, this.sim) // fixed-tick sim (V11)
      }
      const fxEvents = this.sim.drainEvents() // T53 — sim → render outbox (once per frame)
      this.onSimEvents?.(fxEvents)

      const player = this.phys.players.get(this.localPlayerId)
      if (!this.playerVisuals) this.playerVisuals = new PlayerVisuals(this.scene, this.cam.camera)
      const camMode = this.state !== 'play' ? 'orbit' : this.flying ? 'fly' : this.cam.mode
      // T64 — seated players get the chase cam; on-foot restores fp/tp
      const seatedV =
        player && player.seatedVehicle !== 0 ? this.phys.vehicles.get(player.seatedVehicle) : undefined
      // T90 — piloting was never wired to the camera: the plane fell back to the
      // on-foot cam glued to the seat. Pilots get the same chase/FP system with a
      // much longer boom (a plane is unsteerable from a car-length chase cam).
      const seatedA =
        player && player.seatedAircraft !== 0 ? this.phys.aircraft.get(player.seatedAircraft) : undefined
      const seatYaw = seatedV ? vehicleYaw(seatedV) : seatedA ? vehicleYaw(seatedA) : null
      // T77 — dead local player: the ragdoll is the corpse, so hide the
      // animated body + viewmodel until respawn (undefined = hidden). The
      // camera stays where the player died; the death screen overlays it.
      this.playerVisuals.update(
        dt,
        player && player.alive ? player : undefined,
        camMode,
        this.equippedTool?.() ?? 'dig',
        seatYaw,
      )
      // T99 — frame alpha for transform interpolation (fast vehicles/planes
      // shudder against the 60Hz tick grid otherwise). Both drivers expose it.
      const alpha = this.net ? this.net.driver.alpha : this.driver.alpha
      if (player) {
        if (this.state === 'play') {
          if (seatedV) this.cam.updateVehicle(this.lerpedChase(seatedV, alpha), this.sim.world, dt, player)
          else if (seatedA)
            this.cam.updateVehicle(this.lerpedChase(seatedA, alpha), this.sim.world, dt, player, AIRCRAFT_CHASE_BOOM)
          else this.cam.update(player, this.sim.world)
        }

        // T28 hit feedback: segment damage → HUD flash
        let dmg = 0
        for (const seg of player.segments) dmg += seg.version
        if (dmg > this.lastDamageSum) this.onPlayerDamaged?.()
        this.lastDamageSum = dmg
      }

      // T71 — remote players: full third-person bodies for every spawned
      // player that isn't the camera-driving local one (read-only, V6)
      for (const [pid, p] of this.phys.players) {
        if (pid === this.localPlayerId) continue
        let mesh = this.remoteMeshes.get(pid)
        if (!mesh) {
          mesh = new PlayerMesh(p)
          this.remoteMeshes.set(pid, mesh)
          this.scene.add(mesh.group)
        }
        // T77 — dead remote: the ragdoll IS the corpse; hide the animated body
        // so it isn't drawn twice (restored on respawn)
        mesh.group.visible = p.alive
        if (!p.alive) continue
        // B31 — seated remotes sit in their vehicle too
        const rv = p.seatedVehicle !== 0 ? this.phys.vehicles.get(p.seatedVehicle) : undefined
        mesh.update(p, dt, rv ? vehicleYaw(rv) : null)
      }

      if (this.state === 'orbit') this.orbitUpdate(now, dt)


      // P18 — background palette compaction: compress a few cold Dense chunks
      // per frame to reclaim heap. Memory-only, off the sim tick — logical
      // voxels and the determinism hash are unaffected, so the schedule is free
      // of desync concerns. Skips dirty (pending-remesh) chunks to avoid churn.
      this.sim.world.compactStep(6, 9000) // B37 — lighter scan (was 8/40000 → ~3.6% CPU); still drains the cold set over a few seconds
      this.world.update(dt, this.sim.tick) // remesh budget, debris, CSM, day cycle (V7/T58)
      this.bodyMeshes.update(this.phys.bodies)
      if (this.phys.debris) this.debrisMeshes.update(this.phys.debris) // T86
      this.vehicleMeshes.update(this.phys.vehicles, alpha) // T99 — interpolated
      this.aircraftMeshes.update(this.phys.aircraft, alpha) // P17/T99
      this.ragdollMeshes.update(this.phys.ragdolls) // T77 — death ragdolls (V6 read)
      this.fx.update(dt, fxEvents, this.cam.camera)
      this.projectileMeshes.update(this.phys.projectiles, dt)
      this.rocketMeshes.update(this.phys.rockets, dt) // P19
      this.tntMeshes.update(this.phys.charges, dt) // P19
      this.birds.update(dt, this.world.dayFactor)
      this.flashlight.update(dt)
      this.underwater.update(this.cam.camera.position, this.water)
      this.waterSurface.update(this.water, this.sim.world)

      frames++
      if (now - fpsAt > 500) {
        if (this.hudEl) {
          const info = this.renderer.info.render
          const callDelta = info.calls >= this.lastRenderCalls ? info.calls - this.lastRenderCalls : info.calls
          const triDelta = info.triangles >= this.lastRenderTriangles ? info.triangles - this.lastRenderTriangles : info.triangles
          const drawsPerFrame = Math.round(callDelta / Math.max(1, frames))
          const trisPerFrame = Math.round(triDelta / Math.max(1, frames))
          this.lastRenderCalls = info.calls
          this.lastRenderTriangles = info.triangles
          this.hudEl.textContent =
            `${Math.round((frames * 1000) / (now - fpsAt))} fps  |  tick ${this.sim.tick}` +
            `  |  meshes ${this.world.chunks.chunkMeshCount} pending ${this.world.chunks.pendingCount}` +
            `  |  draws/f ${drawsPerFrame} tris/f ${trisPerFrame}` +
            `  |  bodies ${this.phys.bodies.size}+${this.phys.debris?.bodies.size ?? 0}d(${this.phys.debris?.frozen.size ?? 0}f)`
        }
        frames = 0
        fpsAt = now
      }
      this.world.render()
      // post-render: renderer.info counters are valid here (dev overlay reads them)
      for (const fn of this.frameHooks) fn(dt)
    })
  }

  /**
   * Phased async construction (T31 preloader feeds off onStage):
   * 'world' → 'physics' → 'renderer' → 'meshing'.
   */
  static async create(opts: CreateGameOptions): Promise<Game> {
    const { seed, onStage } = opts

    // --- sim (authoritative, deterministic) ----------------------------------
    onStage?.('world')
    await nextFrame()
    const sim = new Sim(seed)
    registerEditOps(sim)
    // T98 — mini test arena for dev iteration: seconds instead of the ~10s+
    // full-city stamp+mesh+compact cycle. Same systems, same determinism.
    const mini = opts.world === 'mini'
    const layout = mini ? null : generateLayout(seed)
    const { waterFills, vehicleSpawns, aircraftSpawns } = mini
      ? stampMiniScene(sim.world)
      : stampScene(sim.world, layout!, placeholderProps())

    // T97/V21 — full palette-compaction sweep straight after the stamp: at
    // WORLD_CX=256 the freshly-stamped dense store would peak ~3 GB; one
    // bounded pass over every chunk compresses it before physics/water attach.
    // Memory-only (hash-neutral, same as the per-frame trickle in startLoop).
    for (let swept = 0; swept < CHUNK_COUNT; swept += 65536) {
      sim.world.compactStep(65536, 65536, /*ignoreDirty*/ true) // pre-drain: dirty = whole world
      await nextFrame() // keep the preloader responsive between sweep slices
    }

    const water = attachWaterSim(sim)
    // edits wake settled water (breached pool wall etc.)
    sim.world.onVoxelChanged = (x, y, z) => water.notifyVoxelChanged(x, y, z)
    // fill pool basins before tick 0 — part of deterministic scene construction
    for (const { box } of waterFills) {
      for (let y = box.y0; y <= box.y1; y++)
        for (let z = box.z0; z <= box.z1; z++)
          for (let x = box.x0; x <= box.x1; x++) water.addWater(x, y, z, 255)
    }

    onStage?.('physics')
    await nextFrame()
    await loadJolt()
    const phys = await createPhysics(sim)
    registerShootOp(sim, phys) // T28 — hitscan op, same connectivity path as explode
    // T64 — parked cars are real vehicles, spawned pre-tick-0 in layout order
    // (deterministic ids via sim.allocEntityId — same on every lockstep peer)
    for (const v of vehicleSpawns) spawnVehicle(sim, phys, v.archetype, v.cx, v.cy, v.cz, v.yaw)
    // P17 — the on-runway airport plane becomes a flyable aircraft (deterministic
    // ids allocated after the vehicles — same on every lockstep peer)
    for (const a of aircraftSpawns) spawnAircraft(sim, phys, a.cx, a.cy, a.cz, a.yaw)
    attachBuoyancy(sim, phys, water) // T40 — after BOTH physics + water (one-tick force latency, deterministic)

    // --- render ---------------------------------------------------------------
    onStage?.('renderer')
    await nextFrame()
    const graphics = opts.graphics ?? { quality: 'high' as const, fov: 75 }
    const q = QUALITY[graphics.quality]
    const renderer = new WebGPURenderer({ antialias: true })
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio))
    renderer.setSize(innerWidth, innerHeight)
    opts.host.appendChild(renderer.domElement)

    const scene = new Scene()
    scene.background = new Color(0x87b5e0)

    const cam = new PlayerCam(innerWidth / innerHeight, renderer.domElement) // KeyV: fp/tp
    cam.camera.fov = graphics.fov
    cam.camera.updateProjectionMatrix()
    const input = new PlayerInput(renderer.domElement)

    const world = new WorldRenderer({
      renderer,
      scene,
      world: sim.world,
      camera: cam.camera,
      bloom: q.bloom,
      ao: q.ao,
      clouds: q.clouds,
      textures: q.textures,
      // physics drains ChunkStore.dirty in-tick; render consumes its re-feed
      dirtySource: () => phys.drainRemesh(),
    })

    const game = new Game({ seed, sim, phys, water, renderer, scene, cam, input, world })
    game.holdTicks = opts.holdTicks ?? false
    game.startLoop()

    onStage?.('meshing')
    await game.waitForMeshing()
    return game
  }
}
