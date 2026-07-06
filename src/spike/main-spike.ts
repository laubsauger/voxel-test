/**
 * Box3D spike — standalone entry (box3d-spike.html). Interim destruction demo:
 * a real-voxel arena (houses, perimeter) with Box3D colliders, plus destructible
 * voxel structures (wall, tower) that fracture into dynamic debris on impulse.
 *
 * NOTE (2026-07-06): this is the T78-T82 scaffold + a Box3D-native destruction
 * demo (Destructible). The chosen direction (T84/T85) replaces the hand-rolled
 * Destructible with the REAL game destruction pipeline (connectivity.ts +
 * destruction.ts) driving a Box3DPhysicsWorld. This file is the visual harness
 * that path will reuse (renderer, camera, HUD, triggers, toggles).
 */
import {
  Scene,
  WebGPURenderer,
  DirectionalLight,
  HemisphereLight,
  Color,
  Group,
  BoxGeometry,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Vector3,
} from 'three/webgpu'
import { FlyCam } from '../render/flycam'
import { SpikeWorld, type DynamicHandle, type Vec3 } from './box3d-bridge'
import { buildTestLevel, clusterToGroup } from './houses'
import { buildColliders, type ColliderMode, type ColliderStats } from './colliders'
import { spawnDynamic, burstSpawn, type SpawnCtx, type DynamicMeshRecord } from './spawner'
import { Destructible } from './destructible'

const app = document.getElementById('app')!
const hud = document.getElementById('hud')!
const fatal = document.getElementById('fatal')!

function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}

if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

const PHYS_DT = 1 / 60
const SUB_STEPS = 4

const HOTKEYS = [
  'MOUSE aim/look · CLICK shoot',
  '[Space] burst  [X] explode(center)  [G] crash-mover',
  '[1] per-voxel  [2] greedy  [C] cont-collision',
  '[V] collider grid  [B] voxel mesh',
].join('\n')

async function main(): Promise<void> {
  const renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.shadowMap.enabled = true
  app.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(0x8fb6e8)

  const cam = new FlyCam(renderer.domElement, innerWidth / innerHeight)
  cam.camera.position.set(15, 11, -15)

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

  // --- level: static arena (visuals) + destructible structure specs ----------
  const level = buildTestLevel()
  const staticGroups = level.statics.map((c) => clusterToGroup(c))
  for (const g of staticGroups) scene.add(g)

  // --- Box3D world state -----------------------------------------------------
  let phys: SpikeWorld
  let mode: ColliderMode = 'greedy'
  let ccd = true
  let stats: ColliderStats = { mode, bodyCount: 0, solidVoxels: 0, buildMs: 0 }
  let dests: Destructible[] = []
  const meshes = new Map<number, DynamicMeshRecord>()
  const projectiles: DynamicHandle[] = []
  let ctx: SpawnCtx

  let showColliders = false
  let showVoxels = true
  let colliderDebug: Group | null = null
  const debugMat = new LineBasicMaterial({ color: 0x39ff88 })

  function clearDynamicMeshes(): void {
    for (const rec of meshes.values()) {
      scene.remove(rec.mesh)
      rec.mesh.geometry.dispose()
    }
    meshes.clear()
  }

  function refreshColliderDebug(): void {
    if (colliderDebug) {
      scene.remove(colliderDebug)
      colliderDebug.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose())
      colliderDebug = null
    }
    if (!showColliders) return
    const g = new Group()
    for (const b of phys.staticBoxes()) {
      const edges = new EdgesGeometry(new BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2))
      const seg = new LineSegments(edges, debugMat)
      seg.position.set(b.center.x, b.center.y, b.center.z)
      g.add(seg)
    }
    colliderDebug = g
    scene.add(g)
  }

  async function buildWorld(): Promise<void> {
    phys?.destroy()
    clearDynamicMeshes()
    projectiles.length = 0
    phys = await SpikeWorld.create({ continuous: ccd })
    stats = buildColliders(phys, level.statics, mode)
    ctx = { phys, scene, meshes }
    dests = level.destructibles.map((c) => new Destructible(c, phys, scene))
    refreshColliderDebug()
  }

  await buildWorld()

  function sync(): void {
    for (const h of phys.dynamics) {
      const rec = meshes.get(h.id)
      if (!rec) continue
      const p = h.position()
      const r = h.rotation()
      rec.mesh.position.set(p.x, p.y, p.z)
      rec.mesh.quaternion.set(r.x, r.y, r.z, r.w)
    }
  }

  // --- destruction triggers (interim: Destructible; T84/T85 = real pipeline) --
  function explodeAt(p: Vec3, radius: number, strength: number): void {
    for (const d of dests) d.explodeAt(p, radius, strength, ctx)
    phys.explode(p, radius, strength * 12) // shove loose debris/bodies too
    if (showColliders) refreshColliderDebug()
  }

  const fwd = new Vector3()
  function shoot(): void {
    cam.camera.getWorldDirection(fwd)
    const o = cam.camera.position
    const pos = { x: o.x + fwd.x, y: o.y + fwd.y, z: o.z + fwd.z }
    const h = spawnDynamic(ctx, 'sphere', pos, { size: 0.22, bullet: ccd })
    const S = 70
    h.body.setLinearVelocity({ x: fwd.x * S, y: fwd.y * S, z: fwd.z * S })
    projectiles.push(h)
  }

  function crash(): void {
    // heavy fast block hurled at the tower (x≈5,z≈4) from the -Z side
    const h = spawnDynamic(ctx, 'box', { x: 5, y: 2, z: -6 }, { half: { x: 0.6, y: 0.6, z: 0.6 }, color: 0x555a66, bullet: ccd })
    h.body.setLinearVelocity({ x: 0, y: 1, z: 55 })
    projectiles.push(h)
  }

  function inflatedHit(pos: Vec3, d: Destructible): boolean {
    const a = d.aabb()
    const m = 0.4
    return (
      pos.x >= a.min.x - m &&
      pos.x <= a.max.x + m &&
      pos.y >= a.min.y - m &&
      pos.y <= a.max.y + m &&
      pos.z >= a.min.z - m &&
      pos.z <= a.max.z + m
    )
  }

  function checkImpacts(): void {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]
      const pos = p.position()
      if (pos.y < -8) {
        projectiles.splice(i, 1)
        continue
      }
      for (const d of dests) {
        if (inflatedHit(pos, d)) {
          explodeAt(pos, 1.3, 6)
          projectiles.splice(i, 1)
          break
        }
      }
    }
  }

  // --- controls --------------------------------------------------------------
  addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Digit1':
        if (mode !== 'per-voxel') {
          mode = 'per-voxel'
          void buildWorld()
        }
        break
      case 'Digit2':
        if (mode !== 'greedy') {
          mode = 'greedy'
          void buildWorld()
        }
        break
      case 'KeyC':
        ccd = !ccd
        phys.setContinuous(ccd)
        break
      case 'Space':
        e.preventDefault()
        burstSpawn(ctx, 24)
        break
      case 'KeyX':
        explodeAt({ x: 5, y: 1.2, z: 4 }, 2.2, 8) // blast the tower base
        break
      case 'KeyG':
        crash()
        break
      case 'KeyV':
        showColliders = !showColliders
        refreshColliderDebug()
        break
      case 'KeyB':
        showVoxels = !showVoxels
        for (const g of staticGroups) g.visible = showVoxels
        for (const d of dests) d.setVisible(showVoxels)
        break
    }
  })
  renderer.domElement.addEventListener('mousedown', () => {
    if (document.pointerLockElement === renderer.domElement) shoot()
  })

  let acc = 0
  let last = 0
  let steps = 0
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000
    const frameDt = last === 0 ? 0 : Math.min(0.1, t - last)
    last = t
    cam.update(frameDt)

    acc += frameDt
    let n = 0
    while (acc >= PHYS_DT && n < 5) {
      phys.step(PHYS_DT, SUB_STEPS)
      acc -= PHYS_DT
      steps++
      n++
    }
    checkImpacts()
    sync()
    renderer.render(scene, cam.camera)

    const prof = phys.profile()
    const dc = dests.reduce((s, d) => s + d.colliderCount(), 0)
    hud.textContent =
      `BOX3D SPIKE — destruction demo\n${HOTKEYS}\n` +
      `mode ${stats.mode}  static ${phys.staticColliderCount} (arena ${stats.bodyCount} + struct ${dc})\n` +
      `dyn ${phys.dynamics.length}  awake ${phys.awakeCount}  cont ${ccd ? 'on' : 'off'}  steps ${steps}\n` +
      `step ${prof.step.toFixed(2)}ms  solve ${prof.solve.toFixed(2)}ms`
  })

  ;(globalThis as unknown as { __spike: unknown }).__spike = {
    get phys() {
      return phys
    },
    get dests() {
      return dests
    },
    explodeAt,
    shoot,
    crash,
    burst: (n = 24) => burstSpawn(ctx, n),
    meshes,
    scene,
    cam: cam.camera,
    get stats() {
      return stats
    },
    setMode: (m: ColliderMode) => {
      if (m !== mode) {
        mode = m
        return buildWorld()
      }
    },
  }
}

main().catch((e) => die(`Box3D spike boot failed:\n${e?.message ?? e}`))
