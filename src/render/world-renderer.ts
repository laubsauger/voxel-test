/**
 * T8 — world render setup: chunk meshes with the TSL material, sun with
 * CSM-style cascaded shadows, bloom post. Owns the T6 ChunkMeshManager and
 * the T9 budgeted remesh pipeline.
 *
 * Render layer only (V6): reads ChunkStore, never writes sim state. Driven
 * from the rAF loop — no sim stepping here (V11 is main.ts's job).
 *
 * Integration wiring: see src/render/INTEGRATION.md. This module does NOT
 * touch main.ts.
 */
import {
  DirectionalLight,
  HemisphereLight,
  PointLight,
  RenderPipeline,
  Vector3,
  type DirectionalLightShadow,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import { float, mix, mrt, normalView, output, pass, vec3, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { ChunkKind, CHUNK, CHUNK_COUNT, VOXEL_SIZE, WORLD_CX, WORLD_CZ, type ChunkStore } from '../world/chunks'
import {
  DayCycle,
  computeCycleState,
  createCycleState,
  createAtmosphere,
  type CycleState,
} from './atmosphere'
import { BlockyClouds } from './clouds'
import { ChunkMeshManager } from './chunk-mesh-manager'
import {
  createChunkMaterial,
  createTransparentChunkMaterial,
  emissiveNightBoost,
} from './chunk-material'
import { createChunkTextures, type ChunkTextures } from './texture-arrays'
import { DebrisParticles } from './particles'
import { MATERIALS } from './materials'

export interface WorldRendererOptions {
  renderer: WebGPURenderer
  scene: Scene
  world: ChunkStore
  camera: PerspectiveCamera
  workerCount?: number
  maxDispatchPerFrame?: number
  maxApplyPerFrame?: number
  maxRegionBuildsPerFrame?: number
  /** bloom post-processing (default true) */
  bloom?: boolean
  /** debris/dust bursts on edits (default true) */
  debris?: boolean
  /** T29 triplanar PBR texture arrays (default true; false = flat ramp look) */
  textures?: boolean
  /** T30 analytic sky + aerial fog replacing the flat background (default true) */
  sky?: boolean
  /** T30 half-res GTAO in the post stack (default true) */
  ao?: boolean
  /** T30 blocky drifting clouds (default true) */
  clouds?: boolean
  /** dirty-chunk feed override — see ChunkMeshManagerOptions.dirtySource */
  dirtySource?: () => number[]
}

/** max debris bursts per frame — a huge explosion dirties many chunks */
const MAX_BURSTS_PER_FRAME = 8

/**
 * T58 — CSM stabilization for the moving sun (shadow-systems skill): commit
 * the shadow light direction only when it drifts past this angle (radians).
 * Between commits the light-space texel grid is frozen, so shadows are
 * rock-stable; each ~0.09° step shifts shadow edges well under one voxel at
 * scene distances. At the default 20-min cycle the sun moves 0.0052 rad/s →
 * a coherent refresh roughly every 0.3 s.
 */
const LIGHT_DIR_EPSILON = 0.0015
/** distance (m) the directional light sits from its origin target */
const LIGHT_DIST = 120

/**
 * T58 — pooled real PointLights parked on the lamps nearest the camera at
 * night (castShadow OFF — these are cheap local fill, the CSM light owns
 * shadows). Budget-tested via the CDP probe; set to 0 to drop the feature.
 */
const LAMP_LIGHT_COUNT = 3
/** lamp head scan: dense chunks scanned per frame until the index is built */
const LAMP_SCAN_CHUNKS_PER_FRAME = 48
/** re-pick nearest lamps at this interval (s) — avoids per-frame sorting */
const LAMP_PICK_INTERVAL = 0.4

/**
 * B3 — movement-aware remesh priority: the scheduler focus is the camera
 * position led along its velocity, so chunks ahead of a moving camera mesh
 * first instead of popping in late. Lead is clamped to one region.
 */
const FOCUS_LEAD_TIME = 0.5
const FOCUS_MAX_LEAD = 12.8

export class WorldRenderer {
  readonly chunks: ChunkMeshManager
  readonly sun: DirectionalLight
  /** T14: debris/dust bursts, render-only (V6) */
  readonly particles: DebrisParticles
  /**
   * T58 day/night cycle params — plain options for the settings/dev UI:
   * `cycle.cycleLengthSec` (real seconds per 24 h day, default 1200),
   * `cycle.timeOfDayOffsetHours` (time at tick 0, default 15) and
   * `cycle.overrideHours` (fixed-time override, null = tick-driven).
   */
  readonly cycle = new DayCycle()
  private readonly cycleState: CycleState = createCycleState()
  private readonly hemi: HemisphereLight
  /** committed (texel-stable) shadow-light direction — see LIGHT_DIR_EPSILON */
  private readonly committedLightDir = new Vector3()
  /** dev preview: hours advanced per real second while > 0 (__bbCycle.demo) */
  private demoSpeed = 0
  // T58 lamp point-light pool + incremental lamp-head index
  private readonly lampLights: PointLight[] = []
  private readonly lampPositions: Vector3[] = []
  private lampScanCursor = 0
  private readonly lampClusters = new Map<number, { x: number; y: number; z: number; n: number }>()
  private lampPickTimer = 0
  private readonly csm: CSMShadowNode
  private readonly pipeline: RenderPipeline | null
  private readonly atmosphere: ReturnType<typeof createAtmosphere> | null
  private readonly clouds: BlockyClouds | null
  private aoPass: ReturnType<typeof ao> | null = null
  private readonly renderer: WebGPURenderer
  private readonly scene: Scene
  private readonly camera: PerspectiveCamera
  private readonly world: ChunkStore
  private firstUpdate = true
  private csmBiasTuned = false
  private readonly debrisEnabled: boolean
  // B3 focus prediction scratch (no per-frame allocations)
  private readonly prevCamPos = new Vector3()
  private readonly meshFocus = new Vector3()

  constructor(opts: WorldRendererOptions) {
    this.renderer = opts.renderer
    this.scene = opts.scene
    this.camera = opts.camera
    this.world = opts.world

    // T58: initial cycle state at tick 0 (default 15:00 golden afternoon —
    // ~the old static (85,62,38) sun) — lights and sky boot coherent.
    computeCycleState(this.cycle.hoursAt(0), this.cycleState)

    // sun/moon + CSM-style cascaded shadows (T8/T58). One DirectionalLight
    // plays both bodies: sun by day, moon by night (dim, blue-ish); the
    // direction swap happens while intensity ≈ 0 at twilight, so it is never
    // visible and shadow-pass cost stays identical to the static build.
    this.sun = new DirectionalLight(this.cycleState.lightColor, this.cycleState.lightIntensity)
    this.committedLightDir.copy(this.cycleState.lightDir)
    this.sun.position.copy(this.cycleState.lightDir).multiplyScalar(LIGHT_DIST)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    // B4: chunk material renders front faces into the shadow map (see
    // chunk-material.ts) — depth bias stays tiny (CSMShadowNode scales it
    // ×(i+1) per cascade), acne is handled by normalBias instead, which we
    // scale per cascade after the CSM node initializes (see render()).
    this.sun.shadow.bias = -0.00005
    this.sun.shadow.normalBias = 0.03
    this.csm = new CSMShadowNode(this.sun, { cascades: 3, maxFar: 150, mode: 'practical' })
    this.csm.fade = true
    // custom shadow node hook (not yet in @types/three)
    ;(this.sun.shadow as DirectionalLightShadow & { shadowNode?: CSMShadowNode }).shadowNode =
      this.csm
    opts.scene.add(this.sun)
    opts.scene.add(this.sun.target)
    // sky/ground bounce — slightly warm ground for the afternoon mood (T30).
    // Intensity keeps ACES from crushing shaded grass/walls to black.
    // T58: colors + intensity follow the cycle (dims way down at night).
    this.hemi = new HemisphereLight(
      this.cycleState.hemiSky,
      this.cycleState.hemiGround,
      this.cycleState.hemiIntensity,
    )
    opts.scene.add(this.hemi)

    // T58: pooled lamp point lights (parked dark until night; castShadow off)
    for (let i = 0; i < LAMP_LIGHT_COUNT; i++) {
      const l = new PointLight(0xffb46b, 0, 13, 2)
      l.castShadow = false
      l.visible = false
      opts.scene.add(l)
      this.lampLights.push(l)
    }

    // T29: PBR texture arrays load async; material starts on placeholder
    // content (ramp midpoints) and re-uploads once. A failed set rejects
    // loudly (unhandled → pageerror → smoke fails) instead of a silent
    // flat look.
    const textures: ChunkTextures | undefined =
      opts.textures !== false ? createChunkTextures() : undefined

    // chunk meshing pipeline (T6/T7/T9)
    this.chunks = new ChunkMeshManager({
      parent: opts.scene,
      world: opts.world,
      material: createChunkMaterial(textures),
      transparentMaterial: createTransparentChunkMaterial(), // T39 glass/water

      workerCount: opts.workerCount,
      maxDispatchPerFrame: opts.maxDispatchPerFrame,
      maxApplyPerFrame: opts.maxApplyPerFrame,
      maxRegionBuildsPerFrame: opts.maxRegionBuildsPerFrame,
      dirtySource: opts.dirtySource,
    })
    // pick up chunks written before construction (world gen), then let the
    // per-frame drainDirty catch everything after
    this.chunks.enqueueAll()

    // debris/dust on destroy (T14) — hooked up after the first update()
    // so the initial world-gen dirty flood doesn't fire a particle storm
    this.debrisEnabled = opts.debris !== false
    this.particles = new DebrisParticles()
    opts.scene.add(this.particles.object)

    // T30/T58: analytic sky (sun disc aligned with the CSM light) + aerial
    // fog, both driven by the shared cycle state. backgroundNode takes
    // priority over the Scene.background color.
    if (opts.sky !== false) {
      const atmosphere = createAtmosphere(this.cycleState)
      opts.scene.backgroundNode = atmosphere.backgroundNode
      opts.scene.fogNode = atmosphere.fogNode
      this.atmosphere = atmosphere
    } else {
      this.atmosphere = null
    }

    // T30/B22: blocky drifting clouds (render-only, no shadows), tinted by
    // the cycle (white day / pink dusk / moon-silver night)
    if (opts.clouds !== false) {
      this.clouds = new BlockyClouds()
      this.clouds.apply(this.cycleState)
      opts.scene.add(this.clouds.group)
    } else {
      this.clouds = null
    }

    // T58 dev handle (CDP probes + until the settings UI wires cycle knobs):
    // window.__bbCycle.{setOverride(h|null), demo(hoursPerSec), stop(), hours,
    // state, info}. Render-layer debug only — never touches sim state (V6).
    const self = this
    ;(globalThis as { __bbCycle?: unknown }).__bbCycle = {
      cycle: this.cycle,
      setOverride: (h: number | null) => {
        this.cycle.overrideHours = h
      },
      demo: (hoursPerSec = 0.4) => {
        if (this.cycle.overrideHours === null) this.cycle.overrideHours = this.cycleState.hours
        this.demoSpeed = hoursPerSec
      },
      stop: () => {
        this.demoSpeed = 0
      },
      get hours(): number {
        return self.cycleState.hours
      },
      state: this.cycleState,
      info: this.renderer.info,
      lampCount: () => this.lampPositions.length,
      regionCount: () => this.chunks.regionMeshCount,
      sun: this.sun,
    }

    // post stack (T8 bloom, T30 GTAO): scene → AO → bloom → tonemap.
    // RenderPipeline applies renderer.toneMapping (ACES) + output color
    // space once on the final node — HDR is preserved through AO and bloom.
    const wantAo = opts.ao !== false
    if (opts.bloom !== false || wantAo) {
      const scenePass = pass(opts.scene, opts.camera)
      const sceneColor = scenePass.getTextureNode('output')
      let lit: Node<'vec4'> = sceneColor
      if (wantAo) {
        // half-res GTAO from depth + MRT view normals (see SSAO skill notes:
        // radius in meters and well above one voxel per B8, blend kept
        // partial so direct sun is never crushed to grey)
        scenePass.setMRT(mrt({ output, normal: normalView }))
        const aoPass = ao(
          scenePass.getTextureNode('depth'),
          scenePass.getTextureNode('normal'),
          opts.camera,
        )
        aoPass.resolutionScale = 0.5
        aoPass.radius.value = 0.55
        aoPass.thickness.value = 0.5
        aoPass.scale.value = 1.1
        this.aoPass = aoPass
        const visibility = mix(float(1), aoPass.getTextureNode().r, float(0.85))
        lit = vec4(sceneColor.rgb.mul(vec3(visibility)), sceneColor.a)
      }
      this.pipeline = new RenderPipeline(opts.renderer)
      // threshold 1.0: only true HDR sources bloom (sun disc, lamps,
      // specular hits) — keeps white plaster from glowing
      this.pipeline.outputNode =
        opts.bloom !== false ? lit.add(bloom(lit, 0.35, 0.35, 1.0)) : lit
    } else {
      this.pipeline = null
    }
  }

  /**
   * Per-frame, from the rAF loop, before render(). `dt` = render delta
   * seconds (render-side clock only — never fed back into the sim, V6).
   *
   * T58: `simTick` drives the day/night cycle — pass `sim.tick` here (render
   * READS the tick, never writes: deterministic + multiplayer-synced for
   * free). Omitted ⇒ the world stays at the default golden afternoon
   * (15:00), which is what the smoke gate screenshots.
   */
  update(dt: number, simTick?: number): void {
    // --- T58 day/night cycle -------------------------------------------------
    if (this.demoSpeed > 0 && this.cycle.overrideHours !== null) {
      this.cycle.overrideHours = (this.cycle.overrideHours + dt * this.demoSpeed) % 24
    }
    this.applyCycle(this.cycle.hoursAt(simTick ?? 0))

    // B3: remesh focus = camera position led along its velocity
    const camPos = this.camera.position
    if (this.firstUpdate || dt <= 0) {
      this.meshFocus.copy(camPos)
    } else {
      this.meshFocus.subVectors(camPos, this.prevCamPos).divideScalar(dt) // velocity m/s
      const lead = Math.min(this.meshFocus.length() * FOCUS_LEAD_TIME, FOCUS_MAX_LEAD)
      if (lead > 1e-3) this.meshFocus.normalize().multiplyScalar(lead).add(camPos)
      else this.meshFocus.copy(camPos)
    }
    this.prevCamPos.copy(camPos)
    this.chunks.update(this.meshFocus)
    if (this.firstUpdate) {
      this.firstUpdate = false
      if (this.debrisEnabled) {
        this.chunks.onEdit = (edits) => {
          for (const e of edits.slice(0, MAX_BURSTS_PER_FRAME)) {
            this.particles.burst(e.center, 28)
          }
        }
      }
    }
    this.particles.update(dt)
    this.clouds?.update(dt)
    this.updateLampLights(dt)
  }

  /** T58 — apply one frame of the day cycle to lights, sky, clouds, exposure */
  private applyCycle(hours: number): void {
    const s = computeCycleState(hours, this.cycleState)

    // shadow light: color/intensity every frame (cheap, no shimmer impact);
    // DIRECTION only in epsilon steps so the CSM texel grid stays put between
    // commits (shadow-systems skill: coherent refreshes, no per-frame crawl)
    this.sun.color.copy(s.lightColor)
    this.sun.intensity = s.lightIntensity
    if (this.committedLightDir.dot(s.lightDir) < Math.cos(LIGHT_DIR_EPSILON)) {
      this.committedLightDir.copy(s.lightDir)
      this.sun.position.copy(s.lightDir).multiplyScalar(LIGHT_DIST)
    }

    this.hemi.color.copy(s.hemiSky)
    this.hemi.groundColor.copy(s.hemiGround)
    this.hemi.intensity = s.hemiIntensity

    // mild exposure shift (readable-dark night); RenderPipeline's tone-map
    // node reads renderer.toneMappingExposure live
    this.renderer.toneMappingExposure = s.exposure
    // lamp material emissive boost — streets glow after dark (bloom feed)
    emissiveNightBoost.value = s.lampBoost

    this.atmosphere?.apply(s)
    this.clouds?.apply(s)
  }

  /**
   * T58 — lamp point-light pool: an incremental one-time scan indexes lamp
   * heads (material id from the canonical table, V13) from dense chunks,
   * then the LAMP_LIGHT_COUNT lights park on the lamps nearest the camera
   * while it's dark. Pure ChunkStore reads (V6).
   */
  private updateLampLights(dt: number): void {
    if (this.lampLights.length === 0) return
    this.scanLampChunks()

    const darkness = (this.cycleState.lampBoost - 1) / 2.2 // 0 day → 1 night
    if (darkness < 0.02 || this.lampPositions.length === 0) {
      for (const l of this.lampLights) {
        l.intensity = 0
        l.visible = false
      }
      return
    }

    this.lampPickTimer -= dt
    if (this.lampPickTimer <= 0) {
      this.lampPickTimer = LAMP_PICK_INTERVAL
      // pick the N nearest lamp clusters to the camera (N tiny, list ~dozens)
      const cam = this.camera.position
      const picked = [...this.lampPositions]
        .sort((a, b) => a.distanceToSquared(cam) - b.distanceToSquared(cam))
        .slice(0, this.lampLights.length)
      for (let i = 0; i < this.lampLights.length; i++) {
        const l = this.lampLights[i]
        const p = picked[i]
        if (p) {
          // park just under the head so the pole/street catch the falloff
          l.position.set(p.x, p.y - 0.3, p.z)
          l.visible = true
        } else {
          l.visible = false
        }
      }
    }
    const target = 5.5 * darkness
    for (const l of this.lampLights) {
      if (!l.visible) continue
      // ease intensity so pool re-picks never pop
      l.intensity += (target - l.intensity) * Math.min(1, dt * 5)
    }
  }

  /** budget-bounded pass over the chunk array collecting lamp-head clusters */
  private scanLampChunks(): void {
    if (this.lampScanCursor >= CHUNK_COUNT) return
    const lampId = MATERIALS.findIndex((m) => m.name === 'lamp')
    const end = Math.min(this.lampScanCursor + LAMP_SCAN_CHUNKS_PER_FRAME, CHUNK_COUNT)
    for (let ci = this.lampScanCursor; ci < end; ci++) {
      const c = this.world.chunkAt(ci)
      if (c.kind !== ChunkKind.Dense) continue // uniform-lamp chunks don't exist
      const data = c.data!
      const cx = ci % WORLD_CX
      const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
      const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== lampId) continue
        const x = cx * CHUNK + (i & 31)
        const z = cz * CHUNK + ((i >> 5) & 31)
        const y = cy * CHUNK + (i >> 10)
        // cluster on a 1.6 m grid — one entry per lamp head
        const key = (x >> 4) | ((z >> 4) << 8) | ((y >> 4) << 16)
        const e = this.lampClusters.get(key)
        if (e) {
          e.x += x
          e.y += y
          e.z += z
          e.n++
        } else {
          this.lampClusters.set(key, { x, y, z, n: 1 })
        }
      }
    }
    this.lampScanCursor = end
    if (this.lampScanCursor >= CHUNK_COUNT) {
      // scan complete → freeze cluster centers as world-space points; merge
      // heads that straddle a grid boundary (< 1.2 m apart = one lamp)
      for (const e of this.lampClusters.values()) {
        const p = new Vector3(
          (e.x / e.n + 0.5) * VOXEL_SIZE,
          (e.y / e.n + 0.5) * VOXEL_SIZE,
          (e.z / e.n + 0.5) * VOXEL_SIZE,
        )
        if (!this.lampPositions.some((q) => q.distanceToSquared(p) < 1.44)) {
          this.lampPositions.push(p)
        }
      }
      this.lampClusters.clear()
    }
  }

  /** renders the scene (through the bloom pipeline when enabled) */
  render(): void {
    if (this.pipeline) this.pipeline.render()
    else this.renderer.render(this.scene, this.camera)
    // B4: CSMShadowNode clones the sun shadow per cascade lazily on first
    // render and only scales `bias` ×(i+1) — scale normalBias to match once
    // the cascade lights exist (far cascades have ~3× the texel size, so a
    // constant normalBias leaves acne/leaks at distance).
    if (!this.csmBiasTuned && this.csm.lights.length > 0) {
      this.csmBiasTuned = true
      const base = this.sun.shadow.normalBias
      this.csm.lights.forEach((l, i) => {
        if (l.shadow) l.shadow.normalBias = base * (i + 1)
      })
    }
  }

  /** call on window resize, after camera.updateProjectionMatrix() */
  resize(): void {
    this.csm.updateFrustums()
  }

  dispose(): void {
    this.chunks.dispose()
    this.csm.dispose()
    this.clouds?.dispose()
    this.aoPass?.dispose()
    for (const l of this.lampLights) l.removeFromParent()
    if ((globalThis as { __bbCycle?: unknown }).__bbCycle) {
      delete (globalThis as { __bbCycle?: unknown }).__bbCycle
    }
  }
}
