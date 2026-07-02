/**
 * T30 — blocky voxel clouds: cute chunky cloud volumes drifting over the
 * arena. Render-only cosmetic (V6: the sim never sees these; local PRNG is
 * fine — seeded only so smoke screenshots stay stable).
 *
 * Each cloud is a handful of 4m-cell boxes merged into one geometry (blocky
 * Minecraft-meets-Teardown silhouette, no raymarch realism), unlit white
 * with soft bottom shading, drifting slowly along +x and wrapping around
 * the arena. No shadows v1.
 */
import { BoxGeometry, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu'
import { color, mix, positionLocal, smoothstep } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/** cloud cell size (m) — the blocky voxel scale of the sky layer */
const CELL = 4
const CLOUD_COUNT = 14
/** drift bounds (m) around the arena center; clouds wrap across */
const WRAP = 340
const DRIFT_SPEED = 1.6 // m/s, lazy afternoon drift

export class BlockyClouds {
  readonly group = new Group()
  private readonly meshes: Mesh[] = []

  constructor(seed = 7, arenaCenterX = 51.2, arenaCenterZ = 51.2) {
    const rand = mulberry(seed)
    const material = new MeshBasicNodeMaterial()
    // bottom shading: flat white on top, soft blue-grey underside — the
    // whole gradient lives in local y so every cloud shades the same way
    material.colorNode = mix(
      color(0xc4d2e4),
      color(0xffffff),
      smoothstep(-CELL * 0.75, CELL * 1.25, positionLocal.y),
    )
    material.fog = false // the layer floats above the aerial haze

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const geometry = buildCloudGeometry(rand)
      const mesh = new Mesh(geometry, material)
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.position.set(
        arenaCenterX + (rand() * 2 - 1) * WRAP,
        88 + rand() * 34,
        arenaCenterZ + (rand() * 2 - 1) * WRAP,
      )
      this.meshes.push(mesh)
      this.group.add(mesh)
    }
  }

  /** drift + wrap; dt in seconds (render clock) */
  update(dt: number, centerX = 51.2): void {
    for (const m of this.meshes) {
      m.position.x += DRIFT_SPEED * dt
      if (m.position.x > centerX + WRAP) m.position.x -= WRAP * 2
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose()
    ;(this.meshes[0]?.material as MeshBasicNodeMaterial | undefined)?.dispose()
    this.meshes.length = 0
    this.group.clear()
  }
}

/** merged blocky blob: one long core slab + snapped side/top lobes */
function buildCloudGeometry(rand: () => number) {
  const snap = (v: number): number => Math.max(1, Math.round(v)) * CELL
  const parts: BoxGeometry[] = []
  const add = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const g = new BoxGeometry(snap(w), snap(h), snap(d))
    g.translate(Math.round(x) * CELL, Math.round(y) * CELL, Math.round(z) * CELL)
    parts.push(g)
  }

  // core slab, wider than tall
  const coreW = 4 + Math.floor(rand() * 6) // 16-36m
  const coreD = 3 + Math.floor(rand() * 3)
  add(coreW, 1, coreD, 0, 0, 0)
  // side lobes hugging the core
  const lobes = 2 + Math.floor(rand() * 4)
  for (let i = 0; i < lobes; i++) {
    add(
      1 + rand() * 3,
      1,
      1 + rand() * 2,
      (rand() - 0.5) * coreW,
      0,
      (rand() - 0.5) * (coreD + 1),
    )
  }
  // puffy top bumps
  const bumps = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < bumps; i++) {
    add(1 + rand() * 2.5, 1, 1 + rand() * 1.5, (rand() - 0.5) * (coreW - 2), 1, (rand() - 0.5) * coreD)
  }

  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

/** tiny deterministic PRNG (render-side visual salt only, never sim — V2) */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
