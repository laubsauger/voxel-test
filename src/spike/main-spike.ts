/**
 * Box3D spike — standalone entry (V14: own Vite page box3d-spike.html, NEVER
 * routed through src/main.ts, never imports Jolt sim / net / I.hash). Reuses ONLY
 * render-layer primitives from the game: WebGPURenderer, FlyCam, and later the
 * voxel mesher (T79) + greedy-box decomposition (T80).
 *
 * T78 here: boot the renderer, init the Box3D world (I.box3d), fixed 60Hz step
 * folded into the rAF render loop, and prove the bridge end-to-end with a static
 * ground box + a synced drop box. T79-T83 layer houses, collider mappings, the
 * drop spawner, and the eval instrumentation on top.
 */
import {
  Scene,
  WebGPURenderer,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  Color,
} from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { SpikeWorld, type DynamicHandle } from './box3d-bridge'
import { buildTestLevel, clusterToGroup, solidCount, type VoxelCluster } from './houses'
import { buildColliders, type ColliderMode, type ColliderStats } from './colliders'

const app = document.getElementById('app')!
const hud = document.getElementById('hud')!
const fatal = document.getElementById('fatal')!

function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}

if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

// fixed physics step (V14: NOT the sim FixedStepDriver — spike is non-deterministic eval)
const PHYS_DT = 1 / 60
const SUB_STEPS = 4

async function main(): Promise<void> {
  // --- renderer + camera (reused render primitives) --------------------------
  const renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.shadowMap.enabled = true
  app.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(0x8fb6e8)

  const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)
  // FlyCam's fixed default forward is ~(-0.65,-0.39,+0.65); sit on the ray from
  // the scene (origin) along -forward so the houses are framed on boot.
  cam.camera.position.set(9, 6.5, -9)

  const sun = new DirectionalLight(0xffffff, 2.4)
  sun.position.set(30, 50, 20)
  sun.castShadow = true
  scene.add(sun)
  scene.add(new HemisphereLight(0xbcd6ff, 0x44403a, 1.1))

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    cam.camera.aspect = innerWidth / innerHeight
    cam.camera.updateProjectionMatrix()
  })

  // --- T79 example level: voxel ground + houses (visuals from the game mesher) --
  const level: VoxelCluster[] = buildTestLevel()
  for (const c of level) scene.add(clusterToGroup(c))
  const totalSolid = level.reduce((n, c) => n + solidCount(c), 0)

  // --- Box3D world + T80 collider mapping (I.box3d) --------------------------
  let phys: SpikeWorld
  let mode: ColliderMode = 'greedy' // default = fewer bodies; Digit1/2 toggles
  let ccd = true
  let stats: ColliderStats = { mode, bodyCount: 0, solidVoxels: 0, buildMs: 0 }

  const meshes = new Map<number, Mesh>()
  function clearDynamicMeshes(): void {
    for (const m of meshes.values()) {
      scene.remove(m)
      m.geometry.dispose()
    }
    meshes.clear()
  }

  // dynamic box, one render mesh per body (V15). T81 layers a burst spawner on top.
  function spawnBox(x: number, y: number, z: number, bullet = false): void {
    const half = { x: 0.5, y: 0.5, z: 0.5 }
    const h = phys.spawnDynamicBox({ x, y, z }, half, bullet)
    const mesh = new Mesh(
      new BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
      new MeshStandardMaterial({ color: 0xd8843a, roughness: 0.7 }),
    )
    mesh.castShadow = true
    scene.add(mesh)
    meshes.set(h.id, mesh)
  }

  // (re)build the physics world under the current collider mode. Recreating the
  // world is the clean way to swap mappings (no per-body static removal API).
  async function buildWorld(): Promise<void> {
    phys?.destroy()
    clearDynamicMeshes()
    phys = await SpikeWorld.create({ continuous: ccd })
    stats = buildColliders(phys, level, mode)
    // a couple of proof drops so a rebuild is immediately visible/testable
    spawnBox(0, 6, 0)
    spawnBox(1.2, 9, -0.4)
  }

  await buildWorld()

  // sync render mesh transforms from physics (T82 direct copy, no interpolation)
  function sync(): void {
    for (const h of phys.dynamics as DynamicHandle[]) {
      const mesh = meshes.get(h.id)
      if (!mesh) continue
      const p = h.position()
      const r = h.rotation()
      mesh.position.set(p.x, p.y, p.z)
      mesh.quaternion.set(r.x, r.y, r.z, r.w)
    }
  }

  // --- controls: 1/2 collider mode, C continuous-collision -------------------
  addEventListener('keydown', (e) => {
    if (e.code === 'Digit1' && mode !== 'per-voxel') {
      mode = 'per-voxel'
      void buildWorld()
    } else if (e.code === 'Digit2' && mode !== 'greedy') {
      mode = 'greedy'
      void buildWorld()
    } else if (e.code === 'KeyC') {
      ccd = !ccd
      phys.setContinuous(ccd)
    }
  })

  let acc = 0
  let last = 0
  let steps = 0
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000
    const frameDt = last === 0 ? 0 : Math.min(0.1, t - last)
    last = t
    cam.update(frameDt)

    // fixed-step accumulator (decoupled from frame rate)
    acc += frameDt
    let n = 0
    while (acc >= PHYS_DT && n < 5) {
      phys.step(PHYS_DT, SUB_STEPS)
      acc -= PHYS_DT
      steps++
      n++
    }
    sync()
    renderer.render(scene, cam.camera)

    const prof = phys.profile()
    hud.textContent =
      `BOX3D SPIKE   [1]per-voxel [2]greedy  [C]cont=${ccd ? 'on' : 'off'}\n` +
      `mode ${stats.mode}  static bodies ${stats.bodyCount} / ${stats.solidVoxels} voxels  build ${stats.buildMs.toFixed(1)}ms\n` +
      `dyn ${phys.dynamics.length}  awake ${phys.awakeCount}  steps ${steps}\n` +
      `step ${prof.step.toFixed(2)}ms  solve ${prof.solve.toFixed(2)}ms`
  })

  // expose for CDP smoke (T83)
  ;(globalThis as unknown as { __spike: unknown }).__spike = {
    get phys() {
      return phys
    },
    spawnBox,
    meshes,
    level,
    totalSolid,
    get stats() {
      return stats
    },
    setMode: (m: ColliderMode) => {
      if (m !== mode) {
        mode = m
        return buildWorld()
      }
    },
    scene,
    cam: cam.camera,
  }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
