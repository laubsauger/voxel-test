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
import { VehicleMeshes } from './render/vehicle-meshes'
import { Birds } from './render/birds'
import { Flashlight } from './render/flashlight'
import { UnderwaterOverlay } from './render/water/underwater'
import { FxSystem } from './render/fx/fx-system'
import { ProjectileMeshes } from './render/projectile-meshes'
import { FixedStepDriver, Sim } from './sim/loop'
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

export const LOCAL_PLAYER = 1

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
  /** T45 fly/spectator mode (only meaningful in 'play') */
  flying = false
  onFlyChange: ((flying: boolean) => void) | null = null
  /** local player took segment damage this frame (T28 hit feedback) */
  onPlayerDamaged: (() => void) | null = null

  private readonly driver = new FixedStepDriver()
  private readonly waterSurface: WaterSurface
  private readonly bodyMeshes: BodyMeshes
  private readonly fx: FxSystem
  private readonly vehicleMeshes: VehicleMeshes
  private readonly birds = new Birds()
  readonly flashlight: Flashlight
  private readonly underwater = new UnderwaterOverlay()
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
    // T74 birds + T75 flashlight + T60 underwater tint (all render-only, V6)
    this.scene.add(this.birds.group)
    this.flashlight = new Flashlight(this.cam.camera)
    this.scene.add(this.flashlight.group)
    this.spectator = new SpectatorCam(this.cam.camera, this.input)
    this.hudEl = document.getElementById('hud')

    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' && this.state === 'play') this.toggleFly()
    })

    addEventListener('resize', () => {
      this.cam.camera.aspect = innerWidth / innerHeight
      this.cam.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
      this.world.resize()
    })
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
      this.sim.queue.push({ tick: this.sim.tick, playerId: LOCAL_PLAYER, seq: nextSeq(), op: { kind: 'spawn' } })
    }
    this.cam.mode = defaultCamMode
    this.state = 'play'
    if (this.flying) this.toggleFly()
  }

  /** T47 — dev noclip toggle (deterministic op; UI gates behind dev mode) */
  toggleNoclip(): void {
    this.sim.queue.push({ tick: this.sim.tick, playerId: LOCAL_PLAYER, seq: nextSeq(), op: { kind: 'noclip' } })
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

      // local input → command queue (lockstep swaps this for the net queue, M5)
      if (this.spawned) {
        // flying: spectator cam roams, capsule stays put → empty move bits (T45)
        this.sim.queue.push(
          this.input.moveCommand(this.sim.tick, LOCAL_PLAYER, this.flying ? 0 : undefined),
        )
      }
      this.driver.advance(dtMs, this.sim) // fixed-tick sim (V11)
      const fxEvents = this.sim.drainEvents() // T53 — sim → render outbox (once per frame)
      this.onSimEvents?.(fxEvents)

      const player = this.phys.players.get(LOCAL_PLAYER)
      if (!this.playerVisuals) this.playerVisuals = new PlayerVisuals(this.scene, this.cam.camera)
      const camMode = this.state !== 'play' ? 'orbit' : this.flying ? 'fly' : this.cam.mode
      this.playerVisuals.update(dt, player, camMode, this.equippedTool?.() ?? 'dig')
      if (player) {
        // T64 — seated players get the chase cam; on-foot restores fp/tp
        const seatedV =
          player.seatedVehicle !== 0 ? this.phys.vehicles.get(player.seatedVehicle) : undefined
        if (this.state === 'play' && !this.flying) {
          if (seatedV) this.cam.updateVehicle(seatedV, this.sim.world, dt)
          else this.cam.update(player, this.sim.world)
        }

        // T28 hit feedback: segment damage → HUD flash
        let dmg = 0
        for (const seg of player.segments) dmg += seg.version
        if (dmg > this.lastDamageSum) this.onPlayerDamaged?.()
        this.lastDamageSum = dmg
      }

      if (this.state === 'orbit') this.orbitUpdate(now, dt)
      else if (this.flying) this.spectator.update(dt)

      this.world.update(dt, this.sim.tick) // remesh budget, debris, CSM, day cycle (V7/T58)
      this.bodyMeshes.update(this.phys.bodies)
      this.vehicleMeshes.update(this.phys.vehicles)
      this.fx.update(dt, fxEvents, this.cam.camera)
      this.projectileMeshes.update(this.phys.projectiles, dt)
      this.birds.update(dt, this.world.dayFactor)
      this.flashlight.update(dt)
      this.underwater.update(this.cam.camera.position, this.water)
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
