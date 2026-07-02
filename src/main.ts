import { Color, Scene, WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu'
import { WorldRenderer } from './render/world-renderer'
import { PlayerCam } from './render/player-cam'
import { PlayerInput } from './render/player-input'
import { PlayerMesh } from './render/player-mesh'
import { WaterSurface } from './render/water/surface'
import { BodyMeshes } from './render/body-meshes'
import { FixedStepDriver, Sim } from './sim/loop'
import { registerEditOps } from './sim/edit-ops'
import { createPhysics, loadJolt } from './sim/physics'
import { attachWaterSim } from './sim/water/water-sim'
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

// --- sim (authoritative, deterministic) --------------------------------------
// Order matters and is fixed here (V2): scene stamp → water system → physics
// (createPhysics drains the dirty set for static collision and registers the
// physics step; water registered first ⇒ CA runs before physics each tick).
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

await loadJolt().catch((e) => die(`Jolt WASM failed to load: ${e}`))
const phys = await createPhysics(sim).catch((e) => die(`physics init failed: ${e}`))

const driver = new FixedStepDriver()

// --- render -------------------------------------------------------------------
const renderer = new WebGPURenderer({ antialias: true })
renderer.toneMapping = ACESFilmicToneMapping
renderer.shadowMap.enabled = true
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
app.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color(0x87b5e0)

const cam = new PlayerCam(innerWidth / innerHeight, renderer.domElement) // KeyV: fp/tp
const input = new PlayerInput(renderer.domElement)

const world = new WorldRenderer({
  renderer,
  scene,
  world: sim.world,
  camera: cam.camera,
  // physics drains ChunkStore.dirty in-tick; render consumes its re-feed
  dirtySource: () => phys.drainRemesh(),
})

const waterSurface = new WaterSurface()
scene.add(waterSurface.mesh)

// dynamic island bodies (T12) share the chunk TSL material
const bodyMeshes = new BodyMeshes(scene, world.chunks.material)

const LOCAL_PLAYER = 1
sim.queue.push({ tick: 0, playerId: LOCAL_PLAYER, seq: 0, op: { kind: 'spawn' } })

let playerMesh: PlayerMesh | undefined

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

  // local input → command queue (lockstep swaps this for the net queue, M5)
  sim.queue.push(input.moveCommand(sim.tick, LOCAL_PLAYER))
  driver.advance(dtMs, sim) // fixed-tick sim (V11)

  const player = phys.players.get(LOCAL_PLAYER)
  if (player) {
    if (!playerMesh) {
      playerMesh = new PlayerMesh(player)
      scene.add(playerMesh.group)
    }
    playerMesh.update(player)
    cam.update(player, sim.world)
    playerMesh.group.visible = cam.mode === 'tp' // FP: don't render inside own head
  }

  world.update(dtMs / 1000) // remesh budget, debris, CSM (V7)
  bodyMeshes.update(phys.bodies)
  waterSurface.update(water, sim.world)

  frames++
  if (now - fpsAt > 500) {
    hud.textContent =
      `${Math.round((frames * 1000) / (now - fpsAt))} fps  |  tick ${sim.tick}` +
      `  |  meshes ${world.chunks.chunkMeshCount} pending ${world.chunks.pendingCount}` +
      `  |  bodies ${phys.bodies.size}  |  WASD move, V camera, click to look`
    frames = 0
    fpsAt = now
  }
  world.render()
})
