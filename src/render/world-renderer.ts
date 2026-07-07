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
import { float, mix, mrt, normalView, output, pass, renderOutput, uniform, vec3, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
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
import { LodManager } from './lod-manager'
import {
  createChunkMaterial,
  createTransparentChunkMaterial,
  emissiveNightBoost,
} from './chunk-material'
import { createChunkTextures, type ChunkTextures } from './texture-arrays'
import { DebrisParticles } from './particles'
import { MATERIALS } from './materials'
// gfx dials — the store module is DOM-free plain data; reading persisted
// settings.gfx.* here follows the documented cross-track localStorage
// contract (settings-store header). Render layer only — no sim state (V6).
import { SettingsStore, type Settings } from '../ui/settings-store'

/** advanced per-pass pipeline dials, persisted as settings.gfx.* (settings-store) */
export type GfxSettings = Settings['gfx']

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
 * rock-stable, but each commit re-snaps the grid and the whole shadow VISIBLY
 * JUMPS to the next step. B34 — dropped 0.0015→0.0003 (5× smaller): the step is
 * now ~0.017°, so the sun's shadow creeps smoothly instead of snapping ~once a
 * second. The map re-renders every frame regardless, so more-frequent commits
 * cost nothing here; only the perceived jump changes.
 */
const LIGHT_DIR_EPSILON = 0.0003
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
  private readonly lod: LodManager
  /** the sun/moon light — REPLACED wholesale on CSM rebuilds (gfx dials), so
   *  always read through this getter, never cache the instance */
  get sun(): DirectionalLight {
    return this._sun
  }
  private _sun: DirectionalLight
  /** T14: debris/dust bursts, render-only (V6) */
  readonly particles: DebrisParticles
  /**
   * T58 day/night cycle params — plain options for the settings/dev UI:
   * `cycle.cycleLengthSec` (real seconds per 24 h day, default 1200),
   * `cycle.timeOfDayOffsetHours` (time at tick 0, default 15) and
   * `cycle.overrideHours` (fixed-time override, null = tick-driven).
   */
  readonly cycle = new DayCycle()

  /** current day factor 0(night)..1(noon) — render-only consumers (birds T74) */
  get dayFactor(): number {
    return this.cycleState.dayF
  }
  /** B37 — read-only cycle snapshot for the in-game time-of-day gizmo (sun/moon
   *  direction, current hours, day/dusk/night weights). Live-updated each frame. */
  get sky(): Readonly<CycleState> {
    return this.cycleState
  }
  private readonly cycleState: CycleState = createCycleState()
  /** displayed time follows the target exponentially (T65: a slider jump or
   * override toggle glides over ~0.3 s instead of popping CSM/exposure) */
  private smoothedHours: number
  private lastSimTick = 0
  private readonly hemi: HemisphereLight
  /** committed (texel-stable) shadow-light direction — see LIGHT_DIR_EPSILON */
  private readonly committedLightDir = new Vector3()
  /** dev preview: hours advanced per real second while > 0 (__bbCycle.demo) */
  private demoSpeed = 0
  // T58 lamp point-light pool + incremental lamp-head index
  private readonly lampLights: PointLight[] = []
  private readonly lampTargets: number[] = [] // B31 — per-lamp intensity target
  private readonly lampPositions: Vector3[] = []
  private lampScanCursor = 0
  private readonly lampClusters = new Map<number, { x: number; y: number; z: number; n: number }>()
  private lampPickTimer = 0
  private csm!: CSMShadowNode
  private pipeline: RenderPipeline | null = null
  private readonly atmosphere: ReturnType<typeof createAtmosphere> | null
  private readonly clouds: BlockyClouds | null
  private aoPass: ReturnType<typeof ao> | null = null
  // --- gfx dials (settings.gfx.*) — live per-pass toggles/dials ------------
  /** current dial values; defaults reproduce the preset visuals exactly */
  private readonly gfx: GfxSettings
  /** preset-granted passes — gfx booleans AND with these, never force on */
  private readonly presetAo: boolean
  private readonly presetBloom: boolean
  /** preset had any post pipeline at all (fxaa rides it) */
  private readonly postAvailable: boolean
  /** false = bypass the post pipeline (direct renderer.render) */
  private postEnabled = false
  // Persistent pass nodes + per-combination wiring cache. Pass nodes are
  // NEVER recreated on dial changes: three's PassNode/GTAONode/BloomNode
  // disposal does not release everything (measured ~9 leaked textures per
  // ao off/on cycle via the CDP probe), so toggles re-wire the pipeline
  // output from cached graphs instead. An unreferenced pass node never
  // renders (no GPU cost) and its targets just idle — bounded by the 8
  // possible combinations instead of growing per toggle.
  private scenePass: ReturnType<typeof pass> | null = null
  private readonly bloomPasses = new Map<string, ReturnType<typeof bloom>>()
  private readonly postConfigs = new Map<string, { node: Node; fxaa: boolean }>()
  /** GTAO blend factor as a uniform so the intensity dial is recompile-free */
  private readonly aoBlend = uniform(0.85)
  /** pixelRatio the quality preset chose — renderScale is a % of this */
  private basePixelRatio = 1
  /** shadow map size 'auto' resolves to (the preset's/boot value) — kept
   *  separately because a manual size override mutates the base shadow */
  private autoShadowMapSize = 2048
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

    // gfx dials — persisted values via the settings-store contract (defaults
    // when nothing is stored ⇒ identical visuals). Live changes arrive through
    // the __bbGfx handle below (the settings panel forwards gfx.* writes).
    const stored = new SettingsStore()
    this.gfx = {
      shadows: stored.get('gfx.shadows'),
      shadowMapSize: stored.get('gfx.shadowMapSize'),
      cascades: stored.get('gfx.cascades'),
      ao: stored.get('gfx.ao'),
      aoIntensity: stored.get('gfx.aoIntensity'),
      aoRadius: stored.get('gfx.aoRadius'),
      bloom: stored.get('gfx.bloom'),
      fxaa: stored.get('gfx.fxaa'),
      clouds: stored.get('gfx.clouds'),
      renderScale: stored.get('gfx.renderScale'),
      textures: stored.get('gfx.textures'),
    }
    this.presetAo = opts.ao !== false
    this.presetBloom = opts.bloom !== false
    this.postAvailable = this.presetAo || this.presetBloom
    // preset pixelRatio was applied by game.ts before construction
    this.basePixelRatio = this.renderer.getPixelRatio()

    // T58: initial cycle state at tick 0 (default 15:00 golden afternoon —
    // ~the old static (85,62,38) sun) — lights and sky boot coherent.
    this.smoothedHours = this.cycle.hoursAt(0)
    computeCycleState(this.smoothedHours, this.cycleState)
    emissiveNightBoost.value = this.cycleState.lampBoost // B25: lamps off by day

    // sun/moon + CSM-style cascaded shadows (T8/T58). One DirectionalLight
    // plays both bodies: sun by day, moon by night (dim, blue-ish); the
    // direction swap happens while intensity ≈ 0 at twilight, so it is never
    // visible and shadow-pass cost stays identical to the static build.
    this._sun = new DirectionalLight(this.cycleState.lightColor, this.cycleState.lightIntensity)
    this.committedLightDir.copy(this.cycleState.lightDir)
    this.sun.position.copy(this.cycleState.lightDir).multiplyScalar(LIGHT_DIST)
    this.sun.castShadow = this.gfx.shadows // gfx dial (default true)
    const mapSize = this.gfx.shadowMapSize === 'auto' ? 2048 : Number(this.gfx.shadowMapSize)
    this.sun.shadow.mapSize.set(mapSize, mapSize)
    // B4: chunk material renders front faces into the shadow map (see
    // chunk-material.ts) — depth bias stays tiny (CSMShadowNode scales it
    // ×(i+1) per cascade), acne is handled by normalBias instead, which we
    // scale per cascade after the CSM node initializes (see render()).
    this.sun.shadow.bias = -0.00005
    this.sun.shadow.normalBias = 0.03
    // B34 — maxFar 150→110: tighter far cascade packs the 2048² map onto less
    // area (sharper shadows) and drops the fog-hidden fringe. (The real perf win
    // was REGION 8, not shorter shadows — see chunk-mesh-manager; this is kept
    // just for the crisper look.) 3 cascades.
    // B37 — 3→2 cascades. The frame is CPU-bound on three.js iterating every
    // region mesh ONCE PER PASS (main + one shadow render per cascade); dropping
    // a cascade removes a whole scene-traversal + shadow render each frame. The
    // 2048² map splits over 2 slices instead of 3 (slightly coarser mid-range
    // shadows) — a good trade for the per-frame object-processing saved.
    // T94 — 2→1: attribution round showed world.render at a flat ~15ms CPU
    // (draw submission), still pass-count-bound. One 2048² map over the full
    // 110m ≈ 5.4cm texels — same order as the old far slice. Removes another
    // whole scene traversal + shadow render per frame. Visual check pending.
    // gfx dials: cascade count is a live setting now (default '1' = T94);
    // live map-size/cascade changes go through rebuildSunAndCsm().
    this.buildCsm()
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
      l.visible = true // B31 — permanently counted; intensity 0 parks it dark
      opts.scene.add(l)
      this.lampLights.push(l)
      this.lampTargets.push(0)
    }

    // T29: PBR texture arrays load async; material starts on placeholder
    // content (ramp midpoints) and re-uploads once. A failed set rejects
    // loudly (unhandled → pageerror → smoke fails) instead of a silent
    // flat look.
    const textures: ChunkTextures | undefined =
      opts.textures !== false && this.gfx.textures ? createChunkTextures() : undefined

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
    // B37 — coarse LOD tier for the far field (clones the chunk materials so it
    // shades identically, just blocky). Full meshes now stop at ~120 m; the LOD
    // cells carry 120–340 m as a handful of big draws instead of ~1700.
    // T91b — the clones carry a polygonOffset depth bias: while a coarse cell
    // overlaps streaming full-detail meshes (held until FULLY meshed, T91), ALL
    // its coplanar faces — walls included, which the P9 vertical sink cannot
    // separate — lose the depth test to fine geometry instead of z-fighting.
    const lodOpaque = this.chunks.material.clone()
    const lodTransparent = this.chunks.transparentMaterial.clone()
    for (const m of [lodOpaque, lodTransparent]) {
      m.polygonOffset = true
      m.polygonOffsetFactor = 2
      m.polygonOffsetUnits = 4
    }
    this.lod = new LodManager(
      opts.world,
      opts.scene,
      lodOpaque,
      lodTransparent,
      (x, z) => this.chunks.hasMeshAt(x, z), // B37 — hold coarse cells until full meshes exist
    )
    // B35 — no enqueueAll: view-distance streaming (ChunkMeshManager.update)
    // meshes only the regions near the camera each frame and evicts the rest,
    // so the world is materialised on demand rather than all ~54k chunks up
    // front. Load = mesh the spawn bubble; the rest streams in as you explore.

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
      this.clouds.group.visible = this.gfx.clouds // gfx dial (default true)
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
      setSpeed: (m: number) => this.setCycleSpeed(m),
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
      // live getter — the sun light is REPLACED on gfx CSM rebuilds
      get sun(): DirectionalLight {
        return self.sun
      },
    }

    // post stack (T8 bloom, T30 GTAO, P27 FXAA) — built (and live-rebuilt on
    // gfx dial changes) by buildPost()
    this.buildPost()
    if (this.gfx.renderScale !== 100) this.applyRenderScale()

    // gfx dials live-apply handle: the settings panel (and CDP probes) call
    // __bbGfx.apply({ ao: false, ... }) — same debug-handle pattern as
    // __bbCycle. Render-layer only (V6); persistence stays in SettingsStore.
    ;(globalThis as { __bbGfx?: unknown }).__bbGfx = {
      apply: (patch: Partial<GfxSettings>) => this.applyGfx(patch),
      state: () => ({ ...this.gfx }),
    }
  }

  /**
   * gfx dials: live shadow map-size / cascade change. CSM clones the sun's
   * shadow per cascade at its lazy _init, so both changes need a fresh
   * CSMShadowNode — and the SUN LIGHT ITSELF is replaced along with it.
   * Merely swapping shadow.shadowNode is racy: the lighting cacheKey (light
   * id + castShadow, see LightsNode.customCacheKey) would return to an
   * already-seen value and cached compiled pipelines that still bind the
   * DISPOSED old node get reused. A new light id forces a never-seen
   * cacheKey → every lit material deterministically rebuilds against the
   * new node. One full recompile per manual dial change — acceptable.
   */
  private rebuildSunAndCsm(): void {
    const old = this._sun
    // CSMShadowNode.dispose() detaches its cascade lights but leaves their
    // cloned shadow maps alive — dispose them or every rebuild leaks maps
    for (const l of this.csm.lights) {
      l.shadow?.map?.dispose()
      if (l.shadow) l.shadow.map = null
    }
    this.csm.dispose()
    this.scene.remove(old.target)
    this.scene.remove(old)
    old.dispose() // frees the base shadow map + fires lighting-node cleanup

    const size =
      this.gfx.shadowMapSize === 'auto' ? this.autoShadowMapSize : Number(this.gfx.shadowMapSize)
    this._sun = new DirectionalLight(old.color, old.intensity)
    this._sun.position.copy(old.position)
    this._sun.castShadow = this.gfx.shadows
    this._sun.shadow.mapSize.set(size, size)
    // same bias tuning as construction (B4) — normalBias rescales per
    // cascade in render() once the new CSM node initializes
    this._sun.shadow.bias = -0.00005
    this._sun.shadow.normalBias = 0.03
    this.scene.add(this._sun)
    this.scene.add(this._sun.target)
    this.buildCsm()
  }

  /** build the CSMShadowNode for the current gfx dials (cascade count) */
  private buildCsm(): void {
    this.csm = new CSMShadowNode(this.sun, {
      cascades: Number(this.gfx.cascades),
      maxFar: 110,
      mode: 'practical',
    })
    this.csm.fade = true
    // custom shadow node hook (not yet in @types/three)
    ;(this.sun.shadow as DirectionalLightShadow & { shadowNode?: CSMShadowNode }).shadowNode =
      this.csm
    this.csmBiasTuned = false
  }

  /**
   * (Re)wire the post chain for the current gfx dials: scene → AO → bloom →
   * tonemap → FXAA. RenderPipeline applies renderer.toneMapping (ACES) +
   * output color space once on the final node — HDR is preserved through AO
   * and bloom. gfx booleans AND with the quality preset (a pass the preset
   * disabled stays off). With every pass off the pipeline is bypassed
   * entirely (direct renderer.render, which uses the renderer's MSAA).
   * Pass nodes persist across changes (see postConfigs) — a toggle swaps
   * the pipeline outputNode, never disposes/recreates GPU targets.
   */
  private buildPost(): void {
    const wantAo = this.presetAo && this.gfx.ao
    const wantBloom = this.presetBloom && this.gfx.bloom
    // fxaa rides the post pipeline — never creates one on a preset without it
    const wantFxaa = this.postAvailable && this.gfx.fxaa
    // AO dials are uniforms — live regardless of wiring
    this.aoBlend.value = Math.min(1, 0.85 * (this.gfx.aoIntensity / 100))
    if (this.aoPass) this.aoPass.radius.value = 0.55 * (this.gfx.aoRadius / 100)
    if (!wantAo && !wantBloom && !wantFxaa) {
      this.postEnabled = false
      return
    }
    if (!this.pipeline) this.pipeline = new RenderPipeline(this.renderer)
    const key = `${wantAo}|${wantBloom}|${wantFxaa}`
    let cfg = this.postConfigs.get(key)
    if (!cfg) {
      cfg = this.wirePost(wantAo, wantBloom, wantFxaa)
      this.postConfigs.set(key, cfg)
    }
    this.pipeline.outputColorTransform = !cfg.fxaa
    this.pipeline.outputNode = cfg.node
    this.pipeline.needsUpdate = true
    this.postEnabled = true
  }

  /** build one output-node graph for a pass combination (cached by caller) */
  private wirePost(
    wantAo: boolean,
    wantBloom: boolean,
    wantFxaa: boolean,
  ): { node: Node; fxaa: boolean } {
    if (!this.scenePass) {
      this.scenePass = pass(this.scene, this.camera)
      if (this.presetAo) {
        // half-res GTAO from depth + MRT view normals (see SSAO skill notes:
        // radius in meters and well above one voxel per B8, blend kept
        // partial so direct sun is never crushed to grey). MRT stays attached
        // while the ao dial is off (pass graph stays stable) — the GTAO node
        // itself only renders when a wiring references it.
        this.scenePass.setMRT(mrt({ output, normal: normalView }))
        const aoPass = ao(
          this.scenePass.getTextureNode('depth'),
          this.scenePass.getTextureNode('normal'),
          this.camera,
        )
        // B37 — FULL-res GTAO (was 0.5). Half-res AO upscaled onto high-frequency
        // voxel geometry was a prime source of the shimmering moiré at distance.
        // The frame is CPU-bound (three.js object processing), so the GPU has
        // ample headroom for the full-res AO pass — no fps cost on the target.
        aoPass.resolutionScale = 1.0
        aoPass.radius.value = 0.55 * (this.gfx.aoRadius / 100)
        aoPass.thickness.value = 0.5
        aoPass.scale.value = 1.1
        this.aoPass = aoPass
      }
    }
    const sceneColor = this.scenePass.getTextureNode('output')
    let lit: Node<'vec4'> = sceneColor
    if (wantAo && this.aoPass) {
      // blend factor is a uniform (aoBlend): intensity dial needs no rewiring.
      // Clamped ≤ 1 in buildPost (>1 would push visibility negative and
      // break the tonemap).
      const visibility = mix(float(1), this.aoPass.getTextureNode().r, this.aoBlend)
      lit = vec4(sceneColor.rgb.mul(vec3(visibility)), sceneColor.a)
    }
    // threshold 1.0: only true HDR sources bloom (sun disc, lamps,
    // specular hits) — keeps white plaster from glowing. One bloom chain per
    // input variant (with/without AO), reused across re-toggles.
    let litHdr = lit
    if (wantBloom) {
      const bloomKey = wantAo ? 'ao' : 'plain'
      let bloomPass = this.bloomPasses.get(bloomKey)
      if (!bloomPass) {
        bloomPass = bloom(lit, 0.35, 0.35, 1.0)
        this.bloomPasses.set(bloomKey, bloomPass)
      }
      litHdr = lit.add(bloomPass)
    }
    if (wantFxaa) {
      // P27 — final FXAA anti-alias pass. The scene renders WITHOUT MSAA (the
      // post pipeline bypasses the renderer's antialias), so voxel/road edges
      // and the thin tower spandrels aliased + shimmered (moiré). FXAA needs the
      // LDR image, so tone-map manually via renderOutput here and turn OFF the
      // pipeline's own output transform to avoid double tone-mapping. GPU-cheap
      // and the frame is CPU-bound, so it's effectively free.
      return { node: fxaa(renderOutput(litHdr)), fxaa: true }
    }
    return { node: litHdr, fxaa: false }
  }

  /** renderScale dial: % of the pixelRatio the quality preset chose */
  private applyRenderScale(): void {
    this.renderer.setPixelRatio(this.basePixelRatio * (this.gfx.renderScale / 100))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  /**
   * Live-apply gfx dial changes (window.__bbGfx.apply / settings panel).
   * ao/bloom/fxaa rebuild the post chain; shadowMapSize/cascades schedule the
   * two-phase CSM rebuild; the rest are uniform/visibility/pixelRatio updates.
   * `textures` is baked into the chunk material — applies on next boot.
   */
  applyGfx(patch: Partial<GfxSettings>): void {
    const prev = { ...this.gfx }
    Object.assign(this.gfx, patch)
    const g = this.gfx
    if (g.shadowMapSize !== prev.shadowMapSize || g.cascades !== prev.cascades) {
      this.rebuildSunAndCsm() // also applies g.shadows via castShadow
    } else if (g.shadows !== prev.shadows) {
      // LightsNode hashes castShadow — flipping it recompiles lighting.
      // (Re-enabling reuses the same CSM node, so pipeline-cache reuse of
      // the returning cacheKey is correct here, unlike the rebuild case.)
      this.sun.castShadow = g.shadows
    }
    if (g.ao !== prev.ao || g.bloom !== prev.bloom || g.fxaa !== prev.fxaa) {
      this.buildPost()
    } else if (this.aoPass) {
      // dial-only updates — no rebuild needed
      this.aoBlend.value = Math.min(1, 0.85 * (g.aoIntensity / 100))
      this.aoPass.radius.value = 0.55 * (g.aoRadius / 100)
    }
    if (this.clouds) this.clouds.group.visible = g.clouds
    if (g.renderScale !== prev.renderScale) this.applyRenderScale()
  }

  /**
   * Re-assert gfx dials after Game.applyGraphics applies a quality preset
   * (which stomps pixelRatio and the base shadow map size). Called by
   * game.ts at the end of applyGraphics — keeps preset/fov changes from
   * silently resetting the advanced dials.
   */
  reapplyGfxOverrides(): void {
    this.basePixelRatio = this.renderer.getPixelRatio()
    if (this.gfx.renderScale !== 100) this.applyRenderScale()
    // the preset just wrote its size into the base shadow — that's what
    // 'auto' means from here on (a manual override mutates the base)
    this.autoShadowMapSize = this.sun.shadow.mapSize.x
    if (this.gfx.shadowMapSize !== 'auto') {
      const size = Number(this.gfx.shadowMapSize)
      const current = this.csm.lights[0]?.shadow?.mapSize.x ?? this.sun.shadow.mapSize.x
      if (current !== size) this.rebuildSunAndCsm()
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
    // --- T58/T65 day/night cycle ---------------------------------------------
    if (simTick !== undefined) this.lastSimTick = simTick
    if (this.demoSpeed > 0 && this.cycle.overrideHours !== null) {
      this.cycle.overrideHours = (this.cycle.overrideHours + dt * this.demoSpeed) % 24
    }
    // fast exponential glide toward the target hour (shortest wrap direction):
    // continuous cycle deltas pass through ~unchanged, a 12 h slider jump
    // settles in well under a second without CSM/exposure pops
    const target = this.cycle.hoursAt(this.lastSimTick)
    const wrapDelta = ((target - this.smoothedHours + 36) % 24) - 12
    this.smoothedHours =
      (((this.smoothedHours + wrapDelta * Math.min(1, dt * 6)) % 24) + 24) % 24
    if (Math.abs(wrapDelta) < 1e-4) this.smoothedHours = target
    this.applyCycle(this.smoothedHours)

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
    this.lod.update(camPos) // B37 — coarse distant cells beyond the full-mesh radius
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

  /**
   * T65 — change the cycle speed live without jumping the clock (rebases the
   * DayCycle offset at the current sim tick). Settings slider entry point.
   */
  setCycleSpeed(multiplier: number): void {
    this.cycle.setSpeed(multiplier, this.lastSimTick)
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

    const darkness = this.cycleState.lampFactor // 0 day → 1 night
    const lit = darkness >= 0.02 && this.lampPositions.length > 0

    this.lampPickTimer -= dt
    if (this.lampPickTimer <= 0) {
      this.lampPickTimer = LAMP_PICK_INTERVAL
      // pick the N nearest lamp clusters to the camera (N tiny, list ~dozens)
      const cam = this.camera.position
      const picked = lit
        ? [...this.lampPositions]
            .sort((a, b) => a.distanceToSquared(cam) - b.distanceToSquared(cam))
            .slice(0, this.lampLights.length)
        : []
      for (let i = 0; i < this.lampLights.length; i++) {
        const p = picked[i]
        if (p) {
          // park just under the head so the pole/street catch the falloff
          this.lampLights[i].position.set(p.x, p.y - 0.3, p.z)
          this.lampTargets[i] = 5.5 * darkness
        } else {
          this.lampTargets[i] = 0 // dark slot: fade to 0, but stay visible/counted
        }
      }
    } else if (lit) {
      // keep already-picked lamps tracking the deepening/lifting darkness
      for (let i = 0; i < this.lampLights.length; i++) {
        if (this.lampTargets[i] > 0) this.lampTargets[i] = 5.5 * darkness
      }
    } else {
      for (let i = 0; i < this.lampTargets.length; i++) this.lampTargets[i] = 0
    }
    // ease intensity so pool re-picks / dawn never pop. B31: .visible is NEVER
    // toggled here — a changed light count recompiles every lit material.
    for (let i = 0; i < this.lampLights.length; i++) {
      const l = this.lampLights[i]
      l.intensity += (this.lampTargets[i] - l.intensity) * Math.min(1, dt * 5)
    }
  }

  /** budget-bounded pass over the chunk array collecting lamp-head clusters */
  private scanLampChunks(): void {
    if (this.lampScanCursor >= CHUNK_COUNT) return
    const lampId = MATERIALS.findIndex((m) => m.name === 'lamp')
    // budget counts DENSE chunks (the 32k-voxel scans); empty/uniform chunks
    // are a single field read and skip freely — the expanded world is ~85%
    // empty chunks and would otherwise take ~30 s to index
    let denseScanned = 0
    let ci = this.lampScanCursor
    for (; ci < CHUNK_COUNT && denseScanned < LAMP_SCAN_CHUNKS_PER_FRAME; ci++) {
      const c = this.world.chunkAt(ci)
      if (c.kind !== ChunkKind.Dense) continue // uniform-lamp chunks don't exist
      denseScanned++
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
    this.lampScanCursor = ci
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

  /** renders the scene (through the post pipeline when enabled) */
  render(): void {
    if (this.postEnabled && this.pipeline) this.pipeline.render()
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
    this.lod.dispose()
    this.chunks.dispose()
    this.csm.dispose()
    this.clouds?.dispose()
    this.aoPass?.dispose()
    this.scenePass?.dispose()
    for (const b of this.bloomPasses.values()) b.dispose()
    this.bloomPasses.clear()
    this.postConfigs.clear()
    for (const l of this.lampLights) l.removeFromParent()
    if ((globalThis as { __bbCycle?: unknown }).__bbCycle) {
      delete (globalThis as { __bbCycle?: unknown }).__bbCycle
    }
    if ((globalThis as { __bbGfx?: unknown }).__bbGfx) {
      delete (globalThis as { __bbGfx?: unknown }).__bbGfx
    }
  }
}
