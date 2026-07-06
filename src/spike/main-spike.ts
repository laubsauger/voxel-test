/**
 * Box3D spike — REAL destruction pipeline in the browser (T85). Drives an actual
 * Sim + ChunkStore + Box3DPhysicsWorld (createBox3DPhysics) with the game's real
 * edit/destruction ops. Explosions run through structuralPass →
 * connectivity.findUnsupportedIslands → extractIsland → convex-hull Box3D debris —
 * the exact same pipeline as tests/box3d-physics.test.ts, now rendered.
 *
 * Render: static chunk meshes rebuilt from phys.drainRemesh() (the game's dirty
 * feed); dynamic island bodies meshed from their voxel grids and transformed each
 * frame from phys.bodies (V15 1:1). No Jolt, no net (V14/B30).
 */
import { Scene, WebGPURenderer, DirectionalLight, HemisphereLight, Color, Group, Vector3, Plane } from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { clusterToGroup } from './houses'
import { createBox3DPhysics, type Box3DPhysicsWorld } from './box3d-physics'
import { Sim } from '../sim/loop'
import { registerEditOps } from '../sim/edit-ops'
import { CHUNK, VOXEL_SIZE, WORLD_CX, WORLD_CZ } from '../world/chunks'
import { MAT_GRASS, MAT_BRICK, MAT_CONCRETE, MAT_GLASS, MAT_METAL } from '../sim/materials'

const app = document.getElementById('app')!
const hud = document.getElementById('hud')!
const fatal = document.getElementById('fatal')!

function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}
if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

const PHYS_HZ = 60

const HOTKEYS = [
  'MOUSE aim · CLICK explode-at-aim',
  '[X] blow tower  [G] blow wall  [Z] big blast center',
  '[B] toggle island bodies visible',
].join('\n')

// --- small real world: ground + destructible buildings (voxel coords) --------
const GROUND = { x0: 0, z0: 0, x1: 255, z1: 255, top: 3 }
const TOWER = { x0: 40, z0: 40, x1: 58, z1: 58, y0: 4, y1: 64 } // concrete/glass highrise
const WALL = { x0: 90, z0: 60, x1: 140, z1: 64, y0: 4, y1: 32 } // freestanding brick wall
const HOUSE = { x0: 150, z0: 150, x1: 175, z1: 175, y0: 4, y1: 22 }

function buildWorld(sim: Sim): void {
  const w = sim.world
  w.fillBox(GROUND.x0, 0, GROUND.z0, GROUND.x1, GROUND.top - 1, GROUND.z1, MAT_GRASS)
  // tower: hollow concrete shell + glass band + floor slabs every 12
  for (let y = TOWER.y0; y <= TOWER.y1; y++) {
    const floor = (y - TOWER.y0) % 12 === 0 || y === TOWER.y1
    for (let z = TOWER.z0; z <= TOWER.z1; z++)
      for (let x = TOWER.x0; x <= TOWER.x1; x++) {
        const wall = x <= TOWER.x0 + 1 || x >= TOWER.x1 - 1 || z <= TOWER.z0 + 1 || z >= TOWER.z1 - 1
        if (floor) w.setVoxel(x, y, z, MAT_CONCRETE)
        else if (wall) {
          const band = (y - TOWER.y0) % 12 >= 3 && (y - TOWER.y0) % 12 <= 9
          w.setVoxel(x, y, z, band ? MAT_GLASS : MAT_CONCRETE)
        }
      }
  }
  w.fillBox(WALL.x0, WALL.y0, WALL.z0, WALL.x1, WALL.y1, WALL.z1, MAT_BRICK)
  // house: brick box shell
  for (let y = HOUSE.y0; y <= HOUSE.y1; y++)
    for (let z = HOUSE.z0; z <= HOUSE.z1; z++)
      for (let x = HOUSE.x0; x <= HOUSE.x1; x++) {
        const shell = x === HOUSE.x0 || x === HOUSE.x1 || z === HOUSE.z0 || z === HOUSE.z1 || y === HOUSE.y0 || y === HOUSE.y1
        if (shell) w.setVoxel(x, y, z, MAT_BRICK)
      }
  // perimeter bumpers so debris stays near the action
  w.fillBox(20, 3, 20, 200, 5, 21, MAT_METAL)
  w.fillBox(20, 3, 199, 200, 5, 200, MAT_METAL)
  w.fillBox(20, 3, 20, 21, 5, 200, MAT_METAL)
  w.fillBox(199, 3, 20, 200, 5, 200, MAT_METAL)
}

function chunkGrid(sim: Sim, cx: number, cy: number, cz: number): { grid: Uint8Array; any: boolean } {
  const grid = new Uint8Array(CHUNK * CHUNK * CHUNK)
  const ox = cx * CHUNK, oy = cy * CHUNK, oz = cz * CHUNK
  let any = false
  for (let ly = 0; ly < CHUNK; ly++)
    for (let lz = 0; lz < CHUNK; lz++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const m = sim.world.getVoxel(ox + lx, oy + ly, oz + lz)
        if (m !== 0) { grid[lx + lz * CHUNK + ly * CHUNK * CHUNK] = m; any = true }
      }
  return { grid, any }
}

async function main(): Promise<void> {
  const renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.shadowMap.enabled = true
  app.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(0x8fb6e8)

  const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)
  // FlyCam fixed forward ≈ (-0.65,-0.39,+0.65); sit on the ray from the building
  // cluster centroid (~9,3,9 m) so tower/wall/house are framed on boot.
  cam.camera.position.set(21, 11, -3)
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

  // --- real sim + Box3D destruction backend ---------------------------------
  const sim = new Sim(1337)
  registerEditOps(sim)
  buildWorld(sim)
  const phys: Box3DPhysicsWorld = await createBox3DPhysics(sim)

  // static chunk meshes, rebuilt from the dirty feed (phys.drainRemesh)
  const chunkGroups = new Map<number, Group>()
  function renderChunk(ci: number): void {
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    const old = chunkGroups.get(ci)
    if (old) {
      scene.remove(old)
      old.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose())
      chunkGroups.delete(ci)
    }
    const { grid, any } = chunkGrid(sim, cx, cy, cz)
    if (!any) return
    const g = clusterToGroup({
      grid, sx: CHUNK, sy: CHUNK, sz: CHUNK,
      origin: { x: cx * CHUNK * VOXEL_SIZE, y: cy * CHUNK * VOXEL_SIZE, z: cz * CHUNK * VOXEL_SIZE },
      label: `chunk${ci}`,
    })
    chunkGroups.set(ci, g)
    scene.add(g)
  }
  for (const ci of phys.drainRemesh()) renderChunk(ci)

  // dynamic island bodies: mesh from voxel grid (local), transform each frame (V15)
  const bodyGroups = new Map<number, { group: Group; version: number }>()
  let showBodies = true
  function bodyMesh(grid: Uint8Array, sx: number, sy: number, sz: number): Group {
    return clusterToGroup({ grid, sx, sy, sz, origin: { x: 0, y: 0, z: 0 }, label: 'body' })
  }
  function syncBodies(): void {
    for (const [id, rec] of bodyGroups) {
      if (!phys.bodies.has(id)) {
        scene.remove(rec.group)
        rec.group.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose())
        bodyGroups.delete(id)
      }
    }
    for (const b of phys.bodies.values()) {
      let rec = bodyGroups.get(b.id)
      if (!rec || rec.version !== b.version) {
        if (rec) {
          scene.remove(rec.group)
          rec.group.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose())
        }
        const group = bodyMesh(b.grid, b.sx, b.sy, b.sz)
        group.visible = showBodies
        scene.add(group)
        rec = { group, version: b.version }
        bodyGroups.set(b.id, rec)
      }
      rec.group.position.set(b.px, b.py, b.pz)
      rec.group.quaternion.set(b.qx, b.qy, b.qz, b.qw)
    }
  }

  // --- destruction via REAL commands (voxel coords) --------------------------
  function explode(x: number, y: number, z: number, r: number, power: number): void {
    sim.queue.push({ tick: sim.tick, playerId: 1, seq: sim.tick, op: { kind: 'explode', x, y, z, r, power } })
  }
  const c = (b: { x0: number; x1: number; z0: number; z1: number }, y: number) => ({
    x: (b.x0 + b.x1) / 2, y, z: (b.z0 + b.z1) / 2,
  })

  const fwd = new Vector3()
  const plane = new Plane(new Vector3(0, 1, 0), -(TOWER.y0 + 6) * VOXEL_SIZE) // aim plane at building mid-height
  const hitP = new Vector3()
  function explodeAtAim(): void {
    cam.camera.getWorldDirection(fwd)
    const o = cam.camera.position
    const ray = { origin: o, direction: fwd }
    // ray-plane intersect
    const denom = fwd.y
    if (Math.abs(denom) < 1e-4) return
    const t = -(o.y + plane.constant) / denom
    if (t < 0) return
    hitP.copy(o).addScaledVector(fwd, t)
    explode(Math.round(hitP.x / VOXEL_SIZE), Math.round(hitP.y / VOXEL_SIZE), Math.round(hitP.z / VOXEL_SIZE), 6, 7)
    void ray
  }

  addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyX': { const p = c(TOWER, TOWER.y0 + 3); explode(p.x, p.y, p.z, 16, 10); break }
      case 'KeyG': { const p = c(WALL, WALL.y0 + 6); explode(p.x, p.y, p.z, 12, 9); break }
      case 'KeyZ': { const p = c(TOWER, TOWER.y0 + 20); explode(p.x, p.y, p.z, 26, 12); break }
      case 'KeyB':
        showBodies = !showBodies
        for (const rec of bodyGroups.values()) rec.group.visible = showBodies
        break
    }
  })
  renderer.domElement.addEventListener('mousedown', () => {
    if (document.pointerLockElement === renderer.domElement) explodeAtAim()
  })

  // --- loop: fixed-step real sim, then render --------------------------------
  let acc = 0, last = 0, ticks = 0
  const stepDt = 1 / PHYS_HZ
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000
    const frameDt = last === 0 ? 0 : Math.min(0.1, t - last)
    last = t
    cam.update(frameDt)

    acc += frameDt
    let n = 0
    while (acc >= stepDt && n < 5) {
      sim.step()
      acc -= stepDt
      ticks++
      n++
    }
    for (const ci of phys.drainRemesh()) renderChunk(ci)
    syncBodies()
    renderer.render(scene, cam.camera)

    hud.textContent =
      `BOX3D SPIKE — REAL destruction pipeline (Sim + Box3DPhysicsWorld)\n${HOTKEYS}\n` +
      `tick ${sim.tick}  island bodies ${phys.bodies.size}  static colliders ${phys.staticColliderCount}\n` +
      `chunks ${chunkGroups.size}`
  })

  ;(globalThis as unknown as { __spike: unknown }).__spike = {
    sim, phys, scene, cam: cam.camera,
    explode, explodeTower: () => { const p = c(TOWER, TOWER.y0 + 3); explode(p.x, p.y, p.z, 16, 10) },
    bodyCount: () => phys.bodies.size,
  }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
