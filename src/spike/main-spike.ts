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
  PlaneGeometry,
  MeshStandardMaterial,
  Color,
  Quaternion,
} from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { SpikeWorld, type DynamicHandle } from './box3d-bridge'

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
  cam.camera.position.set(14, 10, 14)

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

  // --- Box3D world (I.box3d) -------------------------------------------------
  const phys = await SpikeWorld.create({ continuous: true })

  // ground: static box collider + matching visual plane
  const GROUND_HALF = 30
  phys.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: GROUND_HALF, y: 0.5, z: GROUND_HALF })
  const ground = new Mesh(
    new PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2),
    new MeshStandardMaterial({ color: 0x5a6b4a, roughness: 1 }),
  )
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  // --- T78 bridge proof: a couple of dynamic boxes, mesh per body (V15) ------
  // (T81 generalises this into a spawner; kept minimal here to keep T78 verifiable.)
  const meshes = new Map<number, Mesh>()
  const _q = new Quaternion()
  function spawnBox(x: number, y: number, z: number): void {
    const half = { x: 0.5, y: 0.5, z: 0.5 }
    const h = phys.spawnDynamicBox({ x, y, z }, half)
    const mesh = new Mesh(
      new BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
      new MeshStandardMaterial({ color: 0xd8843a, roughness: 0.7 }),
    )
    mesh.castShadow = true
    scene.add(mesh)
    meshes.set(h.id, mesh)
  }
  spawnBox(0, 6, 0)
  spawnBox(1.2, 9, -0.4)

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
      `BOX3D SPIKE\n` +
      `bodies dyn ${phys.dynamics.length}  static ${phys.staticColliderCount}\n` +
      `awake ${phys.awakeCount}  steps ${steps}\n` +
      `step ${prof.step.toFixed(2)}ms  solve ${prof.solve.toFixed(2)}ms`
  })

  // expose for CDP smoke (T83)
  ;(globalThis as unknown as { __spike: unknown }).__spike = { phys, spawnBox, meshes }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
