/**
 * T30/T58 — blocky voxel clouds: cute chunky cloud volumes drifting over the
 * arena. Render-only cosmetic (V6: the sim never sees these; local PRNG is
 * fine — seeded only so smoke screenshots stay stable).
 *
 * Each cloud is a handful of 4m-cell boxes merged into one geometry (blocky
 * Minecraft-meets-Teardown silhouette, no raymarch realism), unlit with soft
 * bottom shading, drifting slowly along +x and wrapping around the arena.
 * No shadows v1.
 *
 * B22: the layer sits lower (y 58–110 m, biased low) with real per-cloud
 * altitude spread, per-cloud size scale (small wisps to big slabs — big
 * clouds ride higher, matching real cumulus) and per-cloud drift speed.
 * The lit/shade tint is a pair of uniforms driven by the day cycle
 * (WorldRenderer calls apply(state)): white by day, pink at dusk, barely-lit
 * silver at night (cheap moon lining).
 */
import { BoxGeometry, Color, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu'
import { mix, positionLocal, smoothstep, uniform } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { VOXEL_SIZE, WORLD_VX, WORLD_VZ } from '../world/chunks'
import type { CycleState } from './atmosphere'

/** arena center (m) — cloud field centers over the world, whatever its size */
const CENTER_X = (WORLD_VX / 2) * VOXEL_SIZE
const CENTER_Z = (WORLD_VZ / 2) * VOXEL_SIZE

/** cloud cell size (m) — the blocky voxel scale of the sky layer */
const CELL = 4
const CLOUD_COUNT = 24
/** altitude band (m): biased toward the low edge, big clouds pushed higher */
const ALT_MIN = 58
const ALT_RANGE = 52
/** drift bounds (m) around the arena center; clouds wrap across. Tighter
 * than v1 (340) so a useful number of clouds is actually overhead (B22). */
const WRAP = 220
/** per-cloud drift speed range (m/s) — lazy, but no longer lockstep */
const DRIFT_MIN = 0.9
const DRIFT_RANGE = 1.7

export class BlockyClouds {
  readonly group = new Group()
  private readonly meshes: Mesh[] = []
  private readonly speeds: number[] = []
  // cycle-driven tints: white by day, pink dusk, moon-silver night (T58/B22)
  private readonly litColor = uniform(new Color(0xffffff))
  private readonly shadeColor = uniform(new Color(0xc4d2e4))

  constructor(seed = 7, arenaCenterX = CENTER_X, arenaCenterZ = CENTER_Z) {
    const rand = mulberry(seed)
    const material = new MeshBasicNodeMaterial()
    // bottom shading: lit tint on top, shade tint underneath — both cycle
    // uniforms; the whole gradient lives in local y so every cloud shades
    // the same way
    material.colorNode = mix(
      this.shadeColor,
      this.litColor,
      smoothstep(-CELL * 0.75, CELL * 1.25, positionLocal.y),
    )
    material.fog = false // the layer floats above the aerial haze

    for (let i = 0; i < CLOUD_COUNT; i++) {
      // size scale 0.7..2.2 — wisps to slabs; altitude biased low, big high
      const scale = 0.7 + rand() * rand() * 1.5 + rand() * 0.5
      const geometry = buildCloudGeometry(rand, scale)
      const mesh = new Mesh(geometry, material)
      mesh.castShadow = false
      mesh.receiveShadow = false
      const altT = Math.pow(rand(), 1.5) // bias low
      const alt = ALT_MIN + (altT * 0.7 + (scale - 0.6) * 0.18) * ALT_RANGE
      mesh.position.set(
        arenaCenterX + (rand() * 2 - 1) * WRAP,
        alt,
        arenaCenterZ + (rand() * 2 - 1) * WRAP,
      )
      this.meshes.push(mesh)
      this.speeds.push(DRIFT_MIN + rand() * DRIFT_RANGE)
      this.group.add(mesh)
    }
  }

  /** per-frame: cloud tint follows the day cycle (moon silver at night) */
  apply(state: CycleState): void {
    this.litColor.value.copy(state.cloudLit)
    this.shadeColor.value.copy(state.cloudShade)
  }

  /** drift + wrap; dt in seconds (render clock) */
  update(dt: number, centerX = CENTER_X): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i]
      m.position.x += this.speeds[i] * dt
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
function buildCloudGeometry(rand: () => number, scale: number) {
  const snap = (v: number): number => Math.max(1, Math.round(v)) * CELL
  const parts: BoxGeometry[] = []
  const add = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const g = new BoxGeometry(snap(w * scale), snap(h), snap(d * scale))
    g.translate(
      Math.round(x * scale) * CELL,
      Math.round(y) * CELL,
      Math.round(z * scale) * CELL,
    )
    parts.push(g)
  }

  // core slab, wider than tall
  const coreW = 3 + Math.floor(rand() * 7)
  const coreD = 2 + Math.floor(rand() * 4)
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
  // puffy top bumps — big clouds get a second storey
  const bumps = 1 + Math.floor(rand() * 3) + (scale > 1.3 ? 1 : 0)
  for (let i = 0; i < bumps; i++) {
    add(1 + rand() * 2.5, 1, 1 + rand() * 1.5, (rand() - 0.5) * (coreW - 2), 1, (rand() - 0.5) * coreD)
  }
  if (scale > 1.5) add(1 + rand() * 2, 1, 1 + rand(), (rand() - 0.5) * 2, 2, (rand() - 0.5) * 2)

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
