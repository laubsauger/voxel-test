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
  type PerspectiveCamera,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import type { ChunkStore } from '../world/chunks'
import { ChunkMeshManager } from './chunk-mesh-manager'
import { createChunkMaterial } from './chunk-material'
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
    this.sun = new DirectionalLight(0xfff2dc, 3)
    this.sun.position.set(60, 100, 40)
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
    opts.scene.add(new HemisphereLight(0xbcd8f5, 0x8a7f6a, 0.55))

    // chunk meshing pipeline (T6/T7/T9)
    this.chunks = new ChunkMeshManager({
      parent: opts.scene,
      world: opts.world,
      material: createChunkMaterial(),
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

    // bloom post via three/tsl (T8)
    if (opts.bloom !== false) {
      const scenePass = pass(opts.scene, opts.camera)
      const scenePassColor = scenePass.getTextureNode('output')
      const bloomPass = bloom(scenePassColor, 0.25, 0.4, 0.85)
      this.pipeline = new RenderPipeline(opts.renderer)
      this.pipeline.outputNode = scenePassColor.add(bloomPass)
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
  }
}
