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
import type { ChunkStore } from '../world/chunks'
import { createAtmosphere } from './atmosphere'
import { BlockyClouds } from './clouds'
import { ChunkMeshManager } from './chunk-mesh-manager'
import { createChunkMaterial } from './chunk-material'
import { createChunkTextures, type ChunkTextures } from './texture-arrays'
import { DebrisParticles } from './particles'

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
  private readonly csm: CSMShadowNode
  private readonly pipeline: RenderPipeline | null
  private readonly atmosphere: ReturnType<typeof createAtmosphere> | null
  private readonly clouds: BlockyClouds | null
  private aoPass: ReturnType<typeof ao> | null = null
  private readonly renderer: WebGPURenderer
  private readonly scene: Scene
  private readonly camera: PerspectiveCamera
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

    // sun + CSM-style cascaded shadows (T8). Direction: position → origin.
    // T30: late-afternoon elevation (~35°) + warm color for the golden mood;
    // the analytic sky's sun disc shares this exact direction.
    this.sun = new DirectionalLight(0xffe2ba, 3.1)
    this.sun.position.set(85, 62, 38)
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
    opts.scene.add(new HemisphereLight(0xa9c6ea, 0x8f7d62, 0.95))

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

    // T30: analytic sky (sun disc aligned with the CSM light) + aerial fog.
    // backgroundNode takes priority over the Scene.background color.
    if (opts.sky !== false) {
      const atmosphere = createAtmosphere(this.sun.position.clone().normalize())
      opts.scene.backgroundNode = atmosphere.backgroundNode
      opts.scene.fogNode = atmosphere.fogNode
      this.atmosphere = atmosphere
    } else {
      this.atmosphere = null
    }

    // T30: blocky drifting clouds (render-only, no shadows)
    if (opts.clouds !== false) {
      this.clouds = new BlockyClouds()
      opts.scene.add(this.clouds.group)
    } else {
      this.clouds = null
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
   */
  update(dt: number): void {
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
  }
}
