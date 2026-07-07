/**
 * Box3D spike — REAL destruction pipeline on the REAL suburb (T85 + perf probe).
 * Stamps the game's procedural world (generateLayout + stampScene) and clips a
 * region of it, then drives a real Sim + Box3DPhysicsWorld with real explode
 * commands. Buildings are the game's actual voxel buildings, not hand-built bars.
 *
 * Profiling HUD breaks the per-tick cost into structural / step / readback /
 * reweld so the exact perf cost of repeated destruction is visible. [R] fires a
 * rocket barrage (repro), [F] toggles freeze (perf A/B). No Jolt, no net.
 */
import {
  Scene,
  WebGPURenderer,
  DirectionalLight,
  HemisphereLight,
  Color,
  Group,
  Vector3,
  Matrix3,
  Sphere,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  MeshStandardMaterial,
} from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { clusterToGroup } from './houses'
import { createBox3DPhysics, type Box3DPhysicsWorld } from './box3d-physics'
import { Sim } from '../sim/loop'
import { registerEditOps } from '../sim/edit-ops'
import { generateLayout } from '../sim/gen/layout'
import { stampScene } from '../sim/gen/stamper'
import { placeholderProps } from '../sim/gen/props'
import { CHUNK, VOXEL_SIZE, WORLD_CX, WORLD_CZ } from '../world/chunks'
import { MAT_GRASS, MAT_CONCRETE, MAT_GLASS, MAT_BRICK, MAT_METAL } from '../sim/materials'

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
// demolition playground: a cleared pad of freestanding highrises + test shapes,
// placed next to the real suburb's dense cluster (chunk ~56). Region covers both.
const PAD_X = 1400
const PAD_Z = 1810
const REGION = { cx0: 42, cy0: 0, cz0: 54, cx1: 66, cy1: 6, cz1: 68 }
const CENTER_VX = PAD_X + 110
const CENTER_VZ = PAD_Z + 95

// --- freestanding highrises to kaputt --------------------------------------
type W = { setVoxel(x: number, y: number, z: number, m: number): void; fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void }

/** hollow tower: perimeter walls `wall` thick, floor slab every `storey`, glass window band */
function hollowTower(w: W, x0: number, y0: number, z0: number, sw: number, h: number, sd: number, wall: number, storey: number, wallMat: number, glassMat: number): void {
  for (let y = 0; y < h; y++) {
    const floor = y % storey === 0 || y === h - 1
    for (let z = 0; z < sd; z++)
      for (let x = 0; x < sw; x++) {
        const perim = x < wall || x >= sw - wall || z < wall || z >= sd - wall
        if (floor) w.setVoxel(x0 + x, y0 + y, z0 + z, MAT_CONCRETE)
        else if (perim) {
          const band = y % storey >= 2 && y % storey <= storey - 2
          const mid = (x > wall && x < sw - wall - 1) || (z > wall && z < sd - wall - 1)
          w.setVoxel(x0 + x, y0 + y, z0 + z, band && mid ? glassMat : wallMat)
        }
      }
  }
}

/** framed tower: 4 corner columns + floor slabs every `storey` (hollow → pancakes) */
function framedTower(w: W, x0: number, y0: number, z0: number, sw: number, h: number, sd: number, storey: number, col: number): void {
  for (let y = 0; y < h; y++) {
    const floor = y % storey === 0 || y === h - 1
    for (let z = 0; z < sd; z++)
      for (let x = 0; x < sw; x++) {
        const inCol = (x < col || x >= sw - col) && (z < col || z >= sd - col)
        if (floor || inCol) w.setVoxel(x0 + x, y0 + y, z0 + z, MAT_CONCRETE)
      }
  }
}

/** simple experimental shapes to probe collapsibility (offset to the pad) */
function buildTestShapes(w: W, ox: number, oz: number): void {
  const pillar = (x: number, z: number, s: number, h: number, m: number): void => w.fillBox(ox + x, 4, oz + z, ox + x + s - 1, 4 + h - 1, oz + z + s - 1, m)
  // pillars of increasing thickness (how slender before it topples)
  pillar(28, 172, 1, 22, MAT_BRICK)
  pillar(38, 172, 2, 28, MAT_BRICK)
  pillar(50, 172, 3, 34, MAT_CONCRETE)
  pillar(64, 172, 5, 40, MAT_CONCRETE)
  pillar(82, 172, 8, 48, MAT_CONCRETE)
  // gate/portal — two legs + a lintel. Knock a leg → the lintel drops.
  const gx = ox + 105, gz = oz + 172, leg = 3, gap = 10, gh = 24
  w.fillBox(gx, 4, gz, gx + leg - 1, 4 + gh - 1, gz + leg - 1, MAT_CONCRETE)
  w.fillBox(gx + leg + gap, 4, gz, gx + leg + gap + leg - 1, 4 + gh - 1, gz + leg - 1, MAT_CONCRETE)
  w.fillBox(gx, 4 + gh, gz, gx + leg + gap + leg - 1, 6 + gh, gz + leg - 1, MAT_CONCRETE) // lintel
  // cantilever / overhang (T): post + horizontal arm sticking out unsupported
  w.fillBox(ox + 140, 4, oz + 173, ox + 142, 37, oz + 175, MAT_CONCRETE)
  w.fillBox(ox + 140, 35, oz + 173, ox + 162, 37, oz + 175, MAT_CONCRETE)
  // freestanding wall with a doorway
  w.fillBox(ox + 175, 4, oz + 172, ox + 205, 30, oz + 174, MAT_BRICK)
  w.fillBox(ox + 186, 4, oz + 172, ox + 193, 17, oz + 174, 0)
}

/** clear a flat demolition pad beside the suburb + build the towers + test shapes */
function buildPlayground(w: W, ox: number, oz: number): void {
  // clear whatever the suburb stamped here, lay a flat grass pad + rim wall
  w.fillBox(ox - 6, 4, oz - 6, ox + 224, 120, oz + 224, 0)
  w.fillBox(ox - 6, 0, oz - 6, ox + 224, 3, oz + 224, MAT_GRASS)
  w.fillBox(ox + 10, 3, oz + 10, ox + 210, 6, oz + 12, MAT_METAL)
  w.fillBox(ox + 10, 3, oz + 208, ox + 210, 6, oz + 210, MAT_METAL)
  w.fillBox(ox + 10, 3, oz + 10, ox + 12, 6, oz + 210, MAT_METAL)
  w.fillBox(ox + 208, 3, oz + 10, ox + 210, 6, oz + 210, MAT_METAL)
  hollowTower(w, ox + 40, 4, oz + 40, 18, 92, 18, 2, 10, MAT_CONCRETE, MAT_GLASS) // glass highrise
  w.fillBox(ox + 90, 4, oz + 42, ox + 105, 78, oz + 57, MAT_CONCRETE) // solid concrete tower
  framedTower(w, ox + 150, 4, oz + 40, 22, 104, 22, 9, 3) // columned frame → pancake
  hollowTower(w, ox + 45, 4, oz + 110, 18, 66, 18, 2, 8, MAT_BRICK, MAT_GLASS) // brick tower
  w.fillBox(ox + 120, 4, oz + 120, ox + 149, 40, oz + 149, MAT_CONCRETE) // stepped setback
  w.fillBox(ox + 126, 40, oz + 126, ox + 143, 74, oz + 143, MAT_CONCRETE)
  w.fillBox(ox + 131, 74, oz + 131, ox + 138, 100, oz + 138, MAT_CONCRETE)
  buildTestShapes(w, ox, oz)
}

const HOTKEYS = [
  'MOUSE aim · CLICK blast-at-crosshair',
  '[R] rocket barrage at aim  [X] big blast at aim  [F] freeze on/off',
  '[B] hide loose bodies  [V] hide welded world (isolate loose)',
].join('\n')

/**
 * Frozen rubble batch — settled debris keeps its exact shape but its baked mesh
 * is merged into ONE geometry (one draw call, one frustum-cull object) so render
 * cost decouples from body count. Without this, every frozen piece is a separate
 * three.js object and the per-object cull iteration dies past ~8k. Fresh/active
 * debris stays individual (moving, shootable); on freeze it bakes in here, on
 * unfreeze (shot) it degenerates out and goes back to an individual mesh.
 */
const _bv = new Vector3()
const _bn = new Vector3()
const _bnm = new Matrix3()
class RubbleBatch {
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly nor: Float32Array
  private readonly idx: Uint32Array
  private vHead = 0
  private iHead = 0
  private readonly ranges = new Map<number, { i0: number; ic: number }>()
  private readonly geom = new BufferGeometry()
  readonly mesh: Mesh
  full = false
  constructor(private readonly capV = 900000, private readonly capI = 1600000, center = new Vector3(), radius = 400) {
    this.pos = new Float32Array(capV * 3)
    this.col = new Float32Array(capV * 3)
    this.nor = new Float32Array(capV * 3)
    this.idx = new Uint32Array(capI)
    this.geom.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geom.setAttribute('color', new BufferAttribute(this.col, 3))
    this.geom.setAttribute('normal', new BufferAttribute(this.nor, 3))
    this.geom.setIndex(new BufferAttribute(this.idx, 1))
    this.geom.setDrawRange(0, 0)
    this.geom.boundingSphere = new Sphere(center, radius) // manual — never recompute
    this.mesh = new Mesh(this.geom, new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }))
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
  }
  /** bake a world-transformed opaque mesh into the batch; false if capacity hit */
  add(id: number, m: Mesh): boolean {
    if (this.ranges.has(id)) return true
    const g = m.geometry
    const p = g.getAttribute('position') as BufferAttribute | undefined
    const c = g.getAttribute('color') as BufferAttribute | undefined
    const na = g.getAttribute('normal') as BufferAttribute | undefined
    const index = g.getIndex()
    if (!p || !index) return true
    const vc = p.count, ic = index.count
    if (this.vHead + vc > this.capV || this.iHead + ic > this.capI) { this.full = true; return false }
    const wm = m.matrixWorld
    _bnm.getNormalMatrix(wm)
    const v0 = this.vHead
    for (let i = 0; i < vc; i++) {
      _bv.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(wm)
      const o = (v0 + i) * 3
      this.pos[o] = _bv.x; this.pos[o + 1] = _bv.y; this.pos[o + 2] = _bv.z
      if (c) { this.col[o] = c.getX(i); this.col[o + 1] = c.getY(i); this.col[o + 2] = c.getZ(i) }
      if (na) { _bn.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(_bnm).normalize(); this.nor[o] = _bn.x; this.nor[o + 1] = _bn.y; this.nor[o + 2] = _bn.z }
    }
    const i0 = this.iHead
    for (let i = 0; i < ic; i++) this.idx[i0 + i] = v0 + index.getX(i)
    this.markUpdate(v0, vc, i0, ic)
    this.vHead += vc; this.iHead += ic
    this.ranges.set(id, { i0, ic })
    this.geom.setDrawRange(0, this.iHead)
    return true
  }
  /** collapse a piece's triangles to zero-area (removed from view), keep capacity slot */
  remove(id: number): void {
    const r = this.ranges.get(id)
    if (!r) return
    for (let k = 0; k < r.ic; k++) this.idx[r.i0 + k] = 0
    ;(this.geom.getIndex() as BufferAttribute).addUpdateRange(r.i0, r.ic)
    ;(this.geom.getIndex() as BufferAttribute).needsUpdate = true
    this.ranges.delete(id)
  }
  has(id: number): boolean {
    return this.ranges.has(id)
  }
  idList(): number[] {
    return [...this.ranges.keys()]
  }
  get count(): number {
    return this.ranges.size
  }
  private markUpdate(v0: number, vc: number, i0: number, ic: number): void {
    for (const name of ['position', 'color', 'normal']) {
      const a = this.geom.getAttribute(name) as BufferAttribute
      a.addUpdateRange(v0 * 3, vc * 3)
      a.needsUpdate = true
    }
    const ia = this.geom.getIndex() as BufferAttribute
    ia.addUpdateRange(i0, ic)
    ia.needsUpdate = true
  }
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
  stampScene(sim.world, generateLayout(SEED), placeholderProps()) // real suburb
  buildPlayground(sim.world, PAD_X, PAD_Z) // + tower/test-shape demolition pad
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
  const rubble = new RubbleBatch(900000, 1600000, new Vector3(CENTER_VX * VOXEL_SIZE, 25, CENTER_VZ * VOXEL_SIZE), 500)
  scene.add(rubble.mesh)

  const disposeGroup = (g: Group): void => {
    scene.remove(g)
    g.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose())
  }
  const opaqueMesh = (g: Group): Mesh | null => {
    for (const c of g.children) {
      const m = c as Mesh
      if (m.isMesh && !(m.material as { transparent?: boolean }).transparent) return m
    }
    return null
  }
  const makeGroup = (b: { grid: Uint8Array; sx: number; sy: number; sz: number; px: number; py: number; pz: number; qx: number; qy: number; qz: number; qw: number }): Group => {
    const g = clusterToGroup({ grid: b.grid, sx: b.sx, sy: b.sy, sz: b.sz, origin: { x: 0, y: 0, z: 0 }, label: 'body' })
    g.position.set(b.px, b.py, b.pz)
    g.quaternion.set(b.qx, b.qy, b.qz, b.qw)
    return g
  }

  function syncBodies(): void {
    // despawned bodies → drop from wherever they live
    for (const [id, rec] of bodyGroups) if (!phys.bodies.has(id)) { disposeGroup(rec.group); bodyGroups.delete(id) }
    for (const id of rubble.idList()) if (!phys.bodies.has(id)) rubble.remove(id)

    for (const b of phys.bodies.values()) {
      if (phys.frozen.has(b.id)) {
        if (rubble.has(b.id)) continue // already baked, static — nothing to do
        // freeze transition: build/refresh a transformed group, bake it, drop the group
        let rec = bodyGroups.get(b.id)
        if (rec && rec.version === b.version) scene.remove(rec.group)
        else { if (rec) disposeGroup(rec.group); rec = { group: makeGroup(b), version: b.version } }
        rec.group.updateWorldMatrix(true, true)
        const op = opaqueMesh(rec.group)
        const baked = op ? rubble.add(b.id, op) : false
        bodyGroups.delete(b.id)
        if (baked) disposeGroup(rec.group)
        else { rec.group.visible = showBodies; scene.add(rec.group); bodyGroups.set(b.id, rec) } // batch full / pure-glass → keep individual
        continue
      }
      // active (moving) body → individual mesh; pull it out of the batch if it was frozen
      if (rubble.has(b.id)) rubble.remove(b.id)
      let rec = bodyGroups.get(b.id)
      if (!rec || rec.version !== b.version) {
        if (rec) disposeGroup(rec.group)
        const group = makeGroup(b)
        group.visible = showBodies
        scene.add(group)
        rec = { group, version: b.version }
        bodyGroups.set(b.id, rec)
      } else {
        rec.group.position.set(b.px, b.py, b.pz)
        rec.group.quaternion.set(b.qx, b.qy, b.qz, b.qw)
      }
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
    // raycast the physics world — hits static walls AND dynamic/frozen debris, so
    // a shot stops at the first real surface (fallen rubble included), never
    // tunnels through to the wall behind it.
    const hit = phys.raycast(o.x, o.y, o.z, fwd.x, fwd.y, fwd.z, 80)
    if (!hit) return null
    // nudge slightly along the ray so the blast centres in the material it hit
    return {
      vx: Math.round((hit.x + fwd.x * 0.15) / VOXEL_SIZE),
      vy: Math.round((hit.y + fwd.y * 0.15) / VOXEL_SIZE),
      vz: Math.round((hit.z + fwd.z * 0.15) / VOXEL_SIZE),
    }
  }
  // throttle blasts — a held [X] / mouse repeats every frame and over-spams the
  // pipeline (heavy stutter). Min ~18 ticks (0.3s) between blasts = ~1/3 the rate.
  let lastBlastTick = -999
  function canBlast(): boolean {
    if (sim.tick - lastBlastTick < 18) return false
    lastBlastTick = sim.tick
    return true
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
      case 'KeyR': if (canBlast()) fireBarrage(); break
      case 'KeyX': { if (!canBlast()) break; const a = aimVoxel() ?? target; explode(a.vx, a.vy, a.vz, 12, 9); break }
      case 'KeyF': phys.freezeEnabled = !phys.freezeEnabled; break
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
    if (document.pointerLockElement === renderer.domElement && canBlast()) explodeAtAim()
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
      `BOX3D SPIKE — freestanding highrises · REAL pipeline\n${HOTKEYS}\n` +
      `tick ${sim.tick}  bodies ${p.bodies}  chunks ${chunkGroups.size}  freeze ${phys.freezeEnabled ? 'ON' : 'off'} (frozen/t ${p.weldedThisTick})\n` +
      `PHYS  structural ${p.structuralMs.toFixed(2)}  step ${p.stepMs.toFixed(2)}  readback ${p.readbackMs.toFixed(2)}  freeze ${p.reweldMs.toFixed(2)} ms\n` +
      `RENDER ${renderMs.toFixed(2)} ms  (${bodyGroups.size} active meshes + ${rubble.count} rubble in 1 batch)`
  })

  ;(globalThis as unknown as { __spike: unknown }).__spike = {
    sim, phys, scene, cam: cam.camera, target,
    fireBarrage, explode,
    prof: () => ({ ...phys.prof, renderMs, bodyMeshes: bodyGroups.size, rubble: rubble.count, chunks: chunkGroups.size }),
    setFreeze: (on: boolean) => { phys.freezeEnabled = on },
  }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
