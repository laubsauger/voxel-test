/**
 * T81 — dynamic drop spawner. Rains Box3D dynamic bodies (cubes + spheres) from
 * the sky onto/around the houses. Each body is paired 1:1 with exactly one
 * three.js mesh (V15) via the shared meshes map; the render loop (T82) copies
 * transforms back. Randomised placement is fine here — the spike is a
 * non-deterministic eval (V14), so Math.random is allowed (unlike sim code, V2).
 */
import { Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, type Scene } from 'three/webgpu'
import { SpikeWorld, type DynamicHandle } from './box3d-bridge'

export interface SpawnCtx {
  phys: SpikeWorld
  scene: Scene
  meshes: Map<number, DynamicMeshRecord>
}

/** one dynamic body's render mesh + the geometry sizing needed to rebuild it */
export interface DynamicMeshRecord {
  mesh: Mesh
  kind: 'box' | 'sphere'
}

const boxMat = new MeshStandardMaterial({ color: 0xd8843a, roughness: 0.7 })
const sphereMat = new MeshStandardMaterial({ color: 0x4a90d8, roughness: 0.4, metalness: 0.1 })
// shared material per color so structure bricks/blocks don't allocate per-body
const matCache = new Map<number, MeshStandardMaterial>()
function coloredMat(color: number): MeshStandardMaterial {
  let m = matCache.get(color)
  if (!m) {
    m = new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 })
    matCache.set(color, m)
  }
  return m
}

export interface SpawnOpts {
  /** box half-extent / sphere radius (metres) — uniform; ignored if `half` set */
  size?: number
  /** non-cubic box half-extents (structure bricks/blocks) */
  half?: { x: number; y: number; z: number }
  /** override mesh color (structures); default = orange box / blue sphere */
  color?: number
  /** continuous-collision bullet flag — tunneling probe (T83 q2) */
  bullet?: boolean
  /** initial downward speed (m/s) for the fast-mover tunneling test */
  speed?: number
}

/** spawn one dynamic cube or sphere at pos, create its 1:1 mesh (V15) */
export function spawnDynamic(
  ctx: SpawnCtx,
  kind: 'box' | 'sphere',
  pos: { x: number; y: number; z: number },
  opts: SpawnOpts = {},
): DynamicHandle {
  const size = opts.size ?? 0.5
  const bullet = opts.bullet ?? false
  const half = opts.half ?? { x: size, y: size, z: size }
  const h =
    kind === 'box'
      ? ctx.phys.spawnDynamicBox(pos, half, bullet)
      : ctx.phys.spawnDynamicSphere(pos, size, bullet)

  const geo =
    kind === 'box' ? new BoxGeometry(half.x * 2, half.y * 2, half.z * 2) : new SphereGeometry(size, 20, 14)
  const mat = opts.color !== undefined ? coloredMat(opts.color) : kind === 'box' ? boxMat : sphereMat
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  ctx.scene.add(mesh)
  ctx.meshes.set(h.id, { mesh, kind })

  if (opts.speed) h.body.setLinearVelocity({ x: 0, y: -opts.speed, z: 0 })
  return h
}

/**
 * burst: rain `n` bodies (mixed cubes/spheres) from ~sky height over the house
 * cluster (roughly a ±R metres square around origin).
 */
export function burstSpawn(ctx: SpawnCtx, n: number, opts: { radius?: number; height?: number } = {}): DynamicHandle[] {
  const R = opts.radius ?? 3
  const H = opts.height ?? 9
  const out: DynamicHandle[] = []
  for (let i = 0; i < n; i++) {
    const kind = Math.random() < 0.5 ? 'box' : 'sphere'
    const pos = {
      x: (Math.random() * 2 - 1) * R,
      y: H + Math.random() * 4,
      z: (Math.random() * 2 - 1) * R,
    }
    out.push(spawnDynamic(ctx, kind, pos, { size: 0.3 + Math.random() * 0.3 }))
  }
  return out
}
