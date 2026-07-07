/**
 * Box3D spike — REAL destruction pipeline on the REAL suburb (T85 + perf probe).
 * Stamps the game's procedural world (generateLayout + stampScene) and clips a
 * region of it, then drives a real Sim + Box3DPhysicsWorld with real explode
 * commands. Buildings are the game's actual voxel buildings, not hand-built bars.
 *
 * Profiling HUD breaks the per-tick cost into structural / step / readback /
 * reweld so the exact perf cost of repeated destruction is visible. [R] fires a
 * rocket barrage (repro), [F] toggles reweld (perf A/B). No Jolt, no net.
 */
import { Scene, WebGPURenderer, DirectionalLight, HemisphereLight, Color, Group, Vector3 } from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { clusterToGroup } from './houses'
import { createBox3DPhysics, type Box3DPhysicsWorld } from './box3d-physics'
import { Sim } from '../sim/loop'
import { registerEditOps } from '../sim/edit-ops'
import { generateLayout } from '../sim/gen/layout'
import { stampScene } from '../sim/gen/stamper'
import { placeholderProps } from '../sim/gen/props'
import { CHUNK, VOXEL_SIZE, WORLD_CX, WORLD_CZ, chunkIndex } from '../world/chunks'

const app = document.getElementById('app')!
const hud = document.getElementById('hud')!
const fatal = document.getElementById('fatal')!
function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}
if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

const SEED = 1337
const PHYS_HZ = 60
// active region (chunk-space AABB) clipped from the full stamped suburb — the
// densest building cluster for seed 1337 sits around chunk (56,56).
const REGION = { cx0: 52, cy0: 0, cz0: 52, cx1: 66, cy1: 7, cz1: 66 }
const CX = (REGION.cx0 + REGION.cx1) / 2
const CZ = (REGION.cz0 + REGION.cz1) / 2
const CENTER_VX = Math.round(CX * CHUNK + CHUNK / 2)
const CENTER_VZ = Math.round(CZ * CHUNK + CHUNK / 2)

const HOTKEYS = [
  'MOUSE aim · CLICK explode-at-aim',
  '[R] rocket barrage (repro)  [X] blast center  [F] reweld on/off',
  '[B] toggle island bodies',
].join('\n')

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

/** scan the region for the tallest solid column (a building) → blast target */
function findTallColumn(sim: Sim): { vx: number; vy: number; vz: number } {
  let best = { vx: CENTER_VX, vy: 12, vz: CENTER_VZ, top: -1 }
  const x0 = REGION.cx0 * CHUNK, x1 = REGION.cx1 * CHUNK + CHUNK - 1
  const z0 = REGION.cz0 * CHUNK, z1 = REGION.cz1 * CHUNK + CHUNK - 1
  const yTop = REGION.cy1 * CHUNK + CHUNK - 1
  for (let vz = z0; vz <= z1; vz += 3)
    for (let vx = x0; vx <= x1; vx += 3) {
      for (let vy = yTop; vy >= 0; vy--) {
        if (sim.world.getVoxel(vx, vy, vz) !== 0) {
          if (vy > best.top) best = { vx, vy, vz, top: vy }
          break
        }
      }
    }
  return { vx: best.vx, vy: best.vy, vz: best.vz }
}

async function main(): Promise<void> {
  const renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.shadowMap.enabled = true
  app.appendChild(renderer.domElement)

  // aiming crosshair (center screen)
  const crosshair = document.createElement('div')
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;width:16px;height:16px;transform:translate(-50%,-50%);pointer-events:none;z-index:20'
  crosshair.innerHTML =
    '<div style="position:absolute;left:7px;top:0;width:2px;height:16px;background:rgba(255,255,255,.8);box-shadow:0 0 2px #000"></div>' +
    '<div style="position:absolute;top:7px;left:0;height:2px;width:16px;background:rgba(255,255,255,.8);box-shadow:0 0 2px #000"></div>'
  document.body.appendChild(crosshair)

  const scene = new Scene()
  scene.background = new Color(0x8fb6e8)

  const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)
  // sit back+up from the region center on the FlyCam forward ray (~-0.65,-0.39,0.65)
  cam.camera.position.set(CENTER_VX * VOXEL_SIZE + 16, 13, CENTER_VZ * VOXEL_SIZE - 16)
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

  // --- real suburb, clipped to REGION ---------------------------------------
  const sim = new Sim(SEED)
  registerEditOps(sim)
  stampScene(sim.world, generateLayout(SEED), placeholderProps())
  const phys: Box3DPhysicsWorld = await createBox3DPhysics(sim, REGION)
  const target = findTallColumn(sim) // a real building column to blast
  // frame the camera on the target building
  cam.camera.position.set(target.vx * VOXEL_SIZE + 15, target.vy * VOXEL_SIZE * 0.6 + 6, target.vz * VOXEL_SIZE - 15)

  // shadows: aim the sun's shadow camera at the target so voxels cast real shadows
  const tw = { x: target.vx * VOXEL_SIZE, y: target.vy * VOXEL_SIZE * 0.5, z: target.vz * VOXEL_SIZE }
  sun.position.set(tw.x + 24, tw.y + 46, tw.z + 16)
  sun.target.position.set(tw.x, tw.y, tw.z)
  scene.add(sun.target)
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 170
  sun.shadow.camera.left = -38
  sun.shadow.camera.right = 38
  sun.shadow.camera.top = 38
  sun.shadow.camera.bottom = -38
  sun.shadow.bias = -0.0006

  const chunkGroups = new Map<number, Group>()
  function renderChunk(ci: number): void {
    const cx = ci % WORLD_CX
    const cz = ((ci / WORLD_CX) | 0) % WORLD_CZ
    const cy = (ci / (WORLD_CX * WORLD_CZ)) | 0
    if (cx < REGION.cx0 || cx > REGION.cx1 || cy < REGION.cy0 || cy > REGION.cy1 || cz < REGION.cz0 || cz > REGION.cz1) return
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

  const bodyGroups = new Map<number, { group: Group; version: number }>()
  let showBodies = true
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
        const group = clusterToGroup({ grid: b.grid, sx: b.sx, sy: b.sy, sz: b.sz, origin: { x: 0, y: 0, z: 0 }, label: 'body' })
        group.visible = showBodies
        scene.add(group)
        rec = { group, version: b.version }
        bodyGroups.set(b.id, rec)
      }
      rec.group.position.set(b.px, b.py, b.pz)
      rec.group.quaternion.set(b.qx, b.qy, b.qz, b.qw)
    }
  }

  function explode(x: number, y: number, z: number, r: number, power: number): void {
    sim.queue.push({ tick: sim.tick, playerId: 1, seq: sim.tick, op: { kind: 'explode', x, y, z, r, power } })
  }

  // raycast the camera crosshair to the first solid voxel (the real aim target)
  const fwd = new Vector3()
  function aimVoxel(): { vx: number; vy: number; vz: number } | null {
    cam.camera.getWorldDirection(fwd)
    const o = cam.camera.position
    for (let d = 1; d < 70; d += 0.35) {
      const vx = Math.round((o.x + fwd.x * d) / VOXEL_SIZE)
      const vy = Math.round((o.y + fwd.y * d) / VOXEL_SIZE)
      const vz = Math.round((o.z + fwd.z * d) / VOXEL_SIZE)
      if (sim.world.getVoxel(vx, vy, vz) !== 0) return { vx, vy, vz }
    }
    return null
  }
  function explodeAtAim(): void {
    const a = aimVoxel()
    if (a) explode(a.vx, a.vy, a.vz, 8, 8)
  }

  // rocket barrage: blasts march DOWN the building you're aiming at (repro)
  let barrage: { n: number; nextTick: number; tx: number; ty: number; tz: number } | null = null
  function fireBarrage(): void {
    const a = aimVoxel() ?? target
    barrage = { n: 0, nextTick: sim.tick, tx: a.vx, ty: a.vy, tz: a.vz }
  }

  let showWorld = true // KeyV isolates the loose debris by hiding the welded world
  addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyR': fireBarrage(); break
      case 'KeyX': { const a = aimVoxel() ?? target; explode(a.vx, a.vy, a.vz, 12, 9); break }
      case 'KeyF': phys.reweldEnabled = !phys.reweldEnabled; break
      case 'KeyB':
        showBodies = !showBodies
        for (const rec of bodyGroups.values()) rec.group.visible = showBodies
        break
      case 'KeyV':
        showWorld = !showWorld
        for (const g of chunkGroups.values()) g.visible = showWorld
        break
    }
  })
  renderer.domElement.addEventListener('mousedown', () => {
    if (document.pointerLockElement === renderer.domElement) explodeAtAim()
  })

  let acc = 0, last = 0, ticks = 0, renderMs = 0
  const stepDt = 1 / PHYS_HZ
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000
    const frameDt = last === 0 ? 0 : Math.min(0.1, t - last)
    last = t
    cam.update(frameDt)

    acc += frameDt
    let n = 0
    while (acc >= stepDt && n < 5) {
      // drive the barrage: one blast every ~8 ticks, 6 total, marching up
      if (barrage && sim.tick >= barrage.nextTick && barrage.n < 6) {
        // march blasts DOWN the aimed building (top→base) — rockets chewing it down
        explode(barrage.tx, Math.max(6, barrage.ty - barrage.n * 4), barrage.tz, 10, 9)
        barrage.n++
        barrage.nextTick = sim.tick + 8
        if (barrage.n >= 6) barrage = null
      }
      sim.step()
      acc -= stepDt
      ticks++
      n++
    }
    const r0 = performance.now()
    for (const ci of phys.drainRemesh()) renderChunk(ci)
    syncBodies()
    renderer.render(scene, cam.camera)
    renderMs = performance.now() - r0

    const p = phys.prof
    hud.textContent =
      `BOX3D SPIKE — REAL suburb, REAL pipeline\n${HOTKEYS}\n` +
      `tick ${sim.tick}  bodies ${p.bodies}  chunks ${chunkGroups.size}  reweld ${phys.reweldEnabled ? 'ON' : 'off'} (welded/t ${p.weldedThisTick})\n` +
      `PHYS  structural ${p.structuralMs.toFixed(2)}  step ${p.stepMs.toFixed(2)}  readback ${p.readbackMs.toFixed(2)}  reweld ${p.reweldMs.toFixed(2)} ms\n` +
      `RENDER ${renderMs.toFixed(2)} ms  (chunk remesh + ${bodyGroups.size} body meshes)`
  })

  ;(globalThis as unknown as { __spike: unknown }).__spike = {
    sim, phys, scene, cam: cam.camera,
    fireBarrage, explode,
    prof: () => ({ ...phys.prof, renderMs, bodyMeshes: bodyGroups.size, chunks: chunkGroups.size }),
    setReweld: (on: boolean) => { phys.reweldEnabled = on },
  }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
