import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import { FlyCam } from './render/flycam'

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

const renderer = new WebGPURenderer({ antialias: true })
renderer.toneMapping = ACESFilmicToneMapping
renderer.shadowMap.enabled = true
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
app.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color(0x87b5e0)

const sun = new DirectionalLight(0xfff4e0, 3)
sun.position.set(60, 100, 40)
sun.castShadow = true
sun.shadow.camera.left = -80
sun.shadow.camera.right = 80
sun.shadow.camera.top = 80
sun.shadow.camera.bottom = -80
sun.shadow.mapSize.set(2048, 2048)
scene.add(sun)
scene.add(new AmbientLight(0xb0c8e0, 0.6))

// Placeholder ground until chunk meshes land (T6).
const ground = new Mesh(
  new PlaneGeometry(102.4, 102.4),
  new MeshStandardMaterial({ color: 0x5a7d4a }),
)
ground.rotation.x = -Math.PI / 2
ground.position.set(51.2, 0, 51.2)
ground.receiveShadow = true
scene.add(ground)

const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)

addEventListener('resize', () => {
  cam.camera.aspect = innerWidth / innerHeight
  cam.camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

let last = performance.now()
let frames = 0
let fpsAt = last
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  cam.update(dt)
  frames++
  if (now - fpsAt > 500) {
    hud.textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps  |  click: capture mouse, WASD+QE fly, shift fast`
    frames = 0
    fpsAt = now
  }
  renderer.render(scene, cam.camera)
})
