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
import { FxSystem } from './render/fx/fx-system'
import { ProjectileMeshes } from './render/projectile-meshes'
import { FixedStepDriver, Sim } from './sim/loop'
import type { Op } from './sim/commands'
import type { LockstepDriver, LockstepNode } from './net/lockstep'
import { registerEditOps } from './sim/edit-ops'
import { registerShootOp } from './sim/shoot-op'
import { createPhysics, loadJolt, type PhysicsWorld } from './sim/physics'
import { attachBuoyancy } from './sim/buoyancy-coupling'
import { attachWaterSim, type WaterSim } from './sim/water/water-sim'
import { generateLayout } from './sim/gen/layout'
import { stampScene } from './sim/gen/stamper'
import { placeholderProps } from './sim/gen/props'
import { nextSeq } from './render/command-seq'
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ } from './world/chunks'
import type { Settings } from './ui/settings-store'
import { PlayerMesh } from './render/player-mesh'

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
}

/** orbit rig tuning (menu backdrop) */
const ORBIT_RADIUS = 30
const ORBIT_HEIGHT = 16
const ORBIT_BOB = 2.2
const ORBIT_RATE = 0.05 // rad/s

const QUALITY = {
  low: { pixelRatio: 1, shadow: 1024, bloom: false },
  medium: { pixelRatio: 1.5, shadow: 2048, bloom: true },
  high: { pixelRatio: 2, shadow: 2048, bloom: true },
} as const

/** let the browser paint (preloader stage updates) between heavy sync phases */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

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
  /** T71 — remote player bodies (playerId → mesh); local player uses playerVisuals */
  private readonly remoteMeshes = new Map<number, PlayerMesh>()
  private disposed = false
  private readonly onResize: () => void
  private readonly waterSurface: WaterSurface
  private readonly bodyMeshes: BodyMeshes
  private readonly fx: FxSystem
  private readonly projectileMeshes: ProjectileMeshes
  /** sim event tap for audio (main.ts) — called with the frame's drained events */
  onSimEvents: ((events: ReturnType<Sim['drainEvents']>) => void) | null = null
  private readonly spectator: SpectatorCam
  private readonly hudEl: HTMLElement | null
  private playerVisuals: PlayerVisuals | undefined
  /** T49 — equipped hotbar tool id provider (wired by main.ts) */
  equippedTool: (() => string) | null = null
  private spawned = false
  private lastDamageSum = 0
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
    // T53 — event-driven destruction/combat VFX (V6: reads events, writes nothing)
    this.fx = new FxSystem(this.sim.world)
    this.scene.add(this.fx.group)
    // T54 — bomb projectile visuals (reads phys.projectiles, trails via fx)
    this.projectileMeshes = new ProjectileMeshes(this.scene, this.fx)
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

  toggleFly(): void {
    this.flying = !this.flying
    if (this.flying) this.spectator.enter()
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

  private startLoop(): void {
    let last = performance.now()
    let frames = 0
    let fpsAt = last
    this.renderer.setAnimationLoop((now: number) => {
      const dtMs = Math.min(now - last, 100)
      last = now
      const dt = dtMs / 1000

      if (this.net) {
        // T71 — lockstep: local move ships via submitLocal (applies at
        // tick+inputDelay everywhere). One move per stepped frame: at a
        // barrier stall we stop submitting so a 30s stall doesn't dump
        // thousands of stale moves into one bundle on release.
        if (this.spawned && !this.movePending) {
          this.net.node.submitLocal({
            kind: 'move',
            input: this.flying ? 0 : this.input.inputBits(),
            yaw: this.input.yaw,
            pitch: this.input.pitch,
          })
          this.movePending = true
        }
        // advance ONLY released ticks (tick barrier, V2) — never free-run
        if (this.net.driver.advance(dtMs, this.net.node) > 0) this.movePending = false
      } else {
        // solo: local input → command queue directly
        if (this.spawned) {
          // flying: spectator cam roams, capsule stays put → empty move bits (T45)
          this.sim.queue.push(
            this.input.moveCommand(this.sim.tick, this.localPlayerId, this.flying ? 0 : undefined),
          )
        }
        this.driver.advance(dtMs, this.sim) // fixed-tick sim (V11)
      }
      const fxEvents = this.sim.drainEvents() // T53 — sim → render outbox (once per frame)
      this.onSimEvents?.(fxEvents)

      const player = this.phys.players.get(this.localPlayerId)
      if (!this.playerVisuals) this.playerVisuals = new PlayerVisuals(this.scene, this.cam.camera)
      const camMode = this.state !== 'play' ? 'orbit' : this.flying ? 'fly' : this.cam.mode
      this.playerVisuals.update(dt, player, camMode, this.equippedTool?.() ?? 'dig')
      if (player) {
        if (this.state === 'play' && !this.flying) this.cam.update(player, this.sim.world)

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
        mesh.update(p, dt)
      }

      if (this.state === 'orbit') this.orbitUpdate(now, dt)
      else if (this.flying) this.spectator.update(dt)

      this.world.update(dt, this.sim.tick) // remesh budget, debris, CSM, day cycle (V7/T58)
      this.bodyMeshes.update(this.phys.bodies)
      this.fx.update(dt, fxEvents, this.cam.camera)
      this.projectileMeshes.update(this.phys.projectiles, dt)
      this.waterSurface.update(this.water, this.sim.world)

      frames++
      if (now - fpsAt > 500) {
        if (this.hudEl) {
          this.hudEl.textContent =
            `${Math.round((frames * 1000) / (now - fpsAt))} fps  |  tick ${this.sim.tick}` +
            `  |  meshes ${this.world.chunks.chunkMeshCount} pending ${this.world.chunks.pendingCount}` +
            `  |  bodies ${this.phys.bodies.size}`
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
    const layout = generateLayout(seed)
    const { waterFills } = stampScene(sim.world, layout, placeholderProps())

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
      // physics drains ChunkStore.dirty in-tick; render consumes its re-feed
      dirtySource: () => phys.drainRemesh(),
    })

    const game = new Game({ seed, sim, phys, water, renderer, scene, cam, input, world })
    game.startLoop()

    onStage?.('meshing')
    await game.waitForMeshing()
    return game
  }
}
