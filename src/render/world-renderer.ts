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

export interface WorldRendererOptions {
  renderer: WebGPURenderer
  scene: Scene
  world: ChunkStore
  camera: PerspectiveCamera
  workerCount?: number
  maxDispatchPerFrame?: number
  maxApplyPerFrame?: number
  /** bloom post-processing (default true) */
  bloom?: boolean
}

export class WorldRenderer {
  readonly chunks: ChunkMeshManager
  readonly sun: DirectionalLight
  private readonly csm: CSMShadowNode
  private readonly pipeline: RenderPipeline | null
  private readonly renderer: WebGPURenderer
  private readonly scene: Scene
  private readonly camera: PerspectiveCamera

  constructor(opts: WorldRendererOptions) {
    this.renderer = opts.renderer
    this.scene = opts.scene
    this.camera = opts.camera

    // sun + CSM-style cascaded shadows (T8). Direction: position → origin.
    this.sun = new DirectionalLight(0xfff2dc, 3)
    this.sun.position.set(60, 100, 40)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0002
    this.sun.shadow.normalBias = 0.02
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
    })
    // pick up chunks written before construction (world gen), then let the
    // per-frame drainDirty catch everything after
    this.chunks.enqueueAll()

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
  update(_dt: number): void {
    this.chunks.update(this.camera.position)
  }

  /** renders the scene (through the bloom pipeline when enabled) */
  render(): void {
    if (this.pipeline) this.pipeline.render()
    else this.renderer.render(this.scene, this.camera)
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
