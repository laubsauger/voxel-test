import { Color, Scene, WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu'
import { FlyCam } from './render/flycam'
import { WorldRenderer } from './render/world-renderer'
import { FixedStepDriver, Sim } from './sim/loop'
import { registerEditOps } from './sim/edit-ops'
import { generateLayout } from './sim/gen/layout'
import { stampScene } from './sim/gen/stamper'
import { placeholderProps } from './sim/gen/props'

const app = document.getElementById('app')!
const hud = document.getElementById('hud')!
const fatal = document.getElementById('fatal')!

function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}

// §C: WebGPU only, no fallback. Fail loud.
if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

// I.boot (interim until T31): ?seed=N picks the map; fixed default keeps
// CDP smoke deterministic.
const params = new URLSearchParams(location.search)
const seed = Number(params.get('seed') ?? 1337) >>> 0

// --- sim (authoritative, deterministic) -------------------------------------
const sim = new Sim(seed)
registerEditOps(sim)
const layout = generateLayout(seed)
const { waterFills } = stampScene(sim.world, layout, placeholderProps())
void waterFills // handed to water sim at T15 integration
const driver = new FixedStepDriver()

// --- render ------------------------------------------------------------------
const renderer = new WebGPURenderer({ antialias: true })
renderer.toneMapping = ACESFilmicToneMapping
renderer.shadowMap.enabled = true
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
app.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color(0x87b5e0)

const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)
cam.camera.position.set(30, 12, 30)

const world = new WorldRenderer({
  renderer,
  scene,
  world: sim.world,
  camera: cam.camera,
})

addEventListener('resize', () => {
  cam.camera.aspect = innerWidth / innerHeight
  cam.camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  world.resize()
})

let last = performance.now()
let frames = 0
let fpsAt = last
renderer.setAnimationLoop((now: number) => {
  const dtMs = Math.min(now - last, 100)
  last = now
  driver.advance(dtMs, sim) // fixed-tick sim (V11)
  cam.update(dtMs / 1000)
  world.update(dtMs / 1000) // dirty → remesh budget → geometry swaps (V7)
  frames++
  if (now - fpsAt > 500) {
    hud.textContent =
      `${Math.round((frames * 1000) / (now - fpsAt))} fps  |  tick ${sim.tick}` +
      `  |  meshes ${world.chunks.chunkMeshCount} pending ${world.chunks.pendingCount}` +
      `  |  click: mouse, WASD+QE fly, shift fast`
    frames = 0
    fpsAt = now
  }
  world.render() // bloom pipeline; replaces renderer.render
})
