/**
 * T70 — standalone dev page for the map system (no game boot, no WebGPU).
 * Real generateLayout(1337) data through the full MapSystem, scripted player.
 * Serve: `npm run dev` → http://localhost:5173/src/ui/map/dev.html
 */

import '../style.css' // design-system variables (glass/amber/type)
import { generateLayout } from '../../sim/gen/layout'
import { WORLD_VX, WORLD_VZ } from '../../world/chunks'
import { MapSystem } from './map-system'

const root = document.getElementById('ui-root')!
root.style.pointerEvents = 'none'

const layout = generateLayout(1337)
const map = new MapSystem(layout, { vx: WORLD_VX, vz: WORLD_VZ })
map.attach(root)

// scripted player: strolls the central crossing, yaw sweeps
let walking = true
let t = 0
let px = 51.2
let pz = 51.2
let yaw = 0

function frame(): void {
  if (walking) {
    t += 1 / 60
    px = 51.2 + Math.cos(t * 0.12) * 22
    pz = 51.2 + Math.sin(t * 0.19) * 16
    yaw = Math.sin(t * 0.3) * Math.PI
  }
  map.update(px, pz, yaw)
  requestAnimationFrame(frame)
}
frame()

document.getElementById('btn-map')!.addEventListener('click', () => map.toggleFullscreen())
document.getElementById('btn-walk')!.addEventListener('click', () => {
  walking = !walking
})
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') map.toggleFullscreen()
})

// screenshot-script hooks
;(window as unknown as { __map: unknown }).__map = {
  system: map,
  setPlayer(x: number, z: number, y: number) {
    walking = false
    px = x
    pz = z
    yaw = y
  },
}
