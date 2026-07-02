/**
 * T22/T46/T48 [PL] — render the segmented voxel player body.
 *
 * T46: per-voxel render-side color zones (skin/hair/eyes/shirt/pants/shoes)
 * mapped onto the SIM's segment grids. The sim grids stay MAT_FLESH and remain
 * the damage authority (V6): this module reads them, never writes, and
 * rebuilds a segment's instances only when its version counter changes — so
 * shot-off voxels stay visibly missing.
 *
 * T48: segments hang off a pivot hierarchy (pelvis → torso → head/arms,
 * legs at the hips) posed each frame from src/render/player-anim.ts.
 *
 * Public API kept compatible with the original T22 wiring:
 *   new PlayerMesh(player) / mesh.group / mesh.update(player).
 */
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
} from 'three/webgpu'
import { VOXEL_SIZE } from '../world/chunks'
import type { PlayerEntity, PlayerSegment, SegmentDef } from '../sim/player'
import { createAnimState, stepAnim, type AnimState, type Pose } from './player-anim'

const VOXEL_GEO = new BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE)
const BODY_MAT = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 })

// ---------------------------------------------------------------------------
// T46 — render-side color zones (constants; sim voxels stay MAT_FLESH)
// ---------------------------------------------------------------------------

export const COLOR_SKIN = 0xe0a878
export const COLOR_SKIN_SHADE = 0xcf9668
export const COLOR_HAIR = 0x5b3d26
export const COLOR_EYE = 0x26262e
export const COLOR_SHIRT = 0xc94f38
export const COLOR_BELT = 0x2c2620
export const COLOR_PANTS = 0x3e5a80
export const COLOR_SHOES = 0x33302e

export type SegmentName = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR'

/**
 * Color zone for a live voxel at local grid index (x,y,z) of a segment.
 * Front of the body is local -z (grid z index 0). Pure — unit tested.
 */
export function segmentVoxelColor(name: string, x: number, y: number, z: number, def: SegmentDef): number {
  switch (name) {
    case 'head': {
      // hair: crown + back of head; eyes: two dark voxels on the front face
      if (y === def.sy - 1) return COLOR_HAIR
      if (z === def.sz - 1 && y >= 1) return COLOR_HAIR
      if (y === def.sy - 2 && z >= def.sz - 2) return COLOR_HAIR
      if (y === def.sy - 2 && z === 0 && (x === 1 || x === def.sx - 2)) return COLOR_EYE
      if (y === 0) return COLOR_SKIN_SHADE // jaw hint
      return COLOR_SKIN
    }
    case 'torso':
      return y === 0 ? COLOR_BELT : COLOR_SHIRT
    case 'armL':
    case 'armR':
      // short sleeve: shirt on the upper half, bare forearm + hand below
      return y >= def.sy / 2 ? COLOR_SHIRT : COLOR_SKIN
    case 'legL':
    case 'legR':
      return y >= 2 ? COLOR_PANTS : COLOR_SHOES
    default:
      return COLOR_SKIN
  }
}

/** deterministic per-voxel brightness jitter (±4%) — breaks up flat faces */
export function voxelJitter(seg: number, x: number, y: number, z: number): number {
  let h = (seg * 374761393 + x * 668265263 + y * 2246822519 + z * 3266489917) >>> 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = (h ^ (h >>> 16)) >>> 0
  return 0.96 + (h % 1000) / 1000 * 0.08
}

// ---------------------------------------------------------------------------
// T48 — pivot hierarchy (joint positions in voxel units, feet-center origin)
// ---------------------------------------------------------------------------

/** joint pivot per segment, voxel coords relative to the feet center */
const PIVOTS: Record<SegmentName, [number, number, number]> = {
  head: [0, 14, 0], // neck
  torso: [0, 6, 0], // hip
  armL: [-4, 13, 0], // shoulder
  armR: [4, 13, 0],
  legL: [-2, 6, 0], // hip sockets
  legR: [2, 6, 0],
}

/** cute-but-capable: slightly oversized head, reads at TP distance (T46) */
const HEAD_SCALE = 1.18

export class PlayerMesh {
  readonly group = new Group()
  /** exposed so the FP viewmodel bob syncs to the SAME stride phase (T49) */
  readonly anim: AnimState
  private readonly pelvis = new Group()
  private readonly torsoPivot = new Group()
  private readonly headPivot = new Group()
  private readonly armLPivot = new Group()
  private readonly armRPivot = new Group()
  private readonly legLPivot = new Group()
  private readonly legRPivot = new Group()
  private readonly meshes: InstancedMesh[] = []
  private readonly versions: number[] = []
  private readonly scratch = new Matrix4()
  private readonly scratchColor = new Color()
  private lastNow = -1
  private firstPerson = false

  constructor(player: PlayerEntity) {
    this.anim = createAnimState(player.yaw)
    this.group.name = 'player-body'

    const vs = VOXEL_SIZE
    this.pelvis.add(this.torsoPivot, this.legLPivot, this.legRPivot)
    this.torsoPivot.add(this.headPivot, this.armLPivot, this.armRPivot)
    this.group.add(this.pelvis)

    const place = (g: Group, name: SegmentName, parentPivot: [number, number, number] | null) => {
      const p = PIVOTS[name]
      const base = parentPivot ?? [0, 0, 0]
      g.position.set((p[0] - base[0]) * vs, (p[1] - base[1]) * vs, (p[2] - base[2]) * vs)
    }
    place(this.torsoPivot, 'torso', null)
    place(this.legLPivot, 'legL', null)
    place(this.legRPivot, 'legR', null)
    place(this.headPivot, 'head', PIVOTS.torso)
    place(this.armLPivot, 'armL', PIVOTS.torso)
    place(this.armRPivot, 'armR', PIVOTS.torso)
    this.headPivot.scale.setScalar(HEAD_SCALE)

    const pivotOf: Record<SegmentName, Group> = {
      head: this.headPivot,
      torso: this.torsoPivot,
      armL: this.armLPivot,
      armR: this.armRPivot,
      legL: this.legLPivot,
      legR: this.legRPivot,
    }
    for (const seg of player.segments) {
      const mesh = new InstancedMesh(VOXEL_GEO, BODY_MAT, seg.grid.length)
      mesh.castShadow = true
      this.meshes.push(mesh)
      this.versions.push(-1) // force initial build
      pivotOf[seg.def.name as SegmentName].add(mesh)
    }
  }

  /**
   * First-person: legs-only rig (T49). Hiding the whole torso pivot (torso +
   * head + arms) keeps the view clean — a chunky 6×4-voxel torso right under
   * the camera reads as a dark mass, while legs/feet still show when looking
   * down. The FP arms come from the viewmodel instead.
   */
  setFirstPerson(fp: boolean): void {
    this.firstPerson = fp
    this.torsoPivot.visible = !fp
  }

  /**
   * Call once per rendered frame with the sim player entity (read-only, V6).
   * `dt` optional — when omitted (legacy T22 wiring) an internal clock is used.
   */
  update(player: PlayerEntity, dt?: number): void {
    if (dt === undefined) {
      const now = performance.now()
      dt = this.lastNow < 0 ? 1 / 60 : (now - this.lastNow) / 1000
      this.lastNow = now
    }
    const pose = stepAnim(
      this.anim,
      {
        vx: player.vx,
        vy: player.vy,
        vz: player.vz,
        yaw: player.yaw,
        pitch: player.pitch,
        crouching: player.crouching,
        noclip: player.noclip,
        fpBody: this.firstPerson,
      },
      dt,
    )
    // FP: tuck the legs slightly behind the eye so looking straight down
    // shows the feet in front of the camera instead of underneath it
    const back = this.firstPerson ? 0.15 : 0
    this.group.position.set(
      player.px + Math.sin(this.anim.bodyYaw) * back,
      player.py,
      player.pz + Math.cos(this.anim.bodyYaw) * back,
    )
    this.applyPose(pose)
    for (let i = 0; i < player.segments.length; i++) {
      const seg = player.segments[i]
      if (seg.version !== this.versions[i]) {
        this.rebuild(this.meshes[i], i, seg)
        this.versions[i] = seg.version
      }
    }
  }

  /** apply a computed pose to the pivot hierarchy (T48) */
  applyPose(p: Pose): void {
    this.group.rotation.set(0, p.rootYaw, 0)
    this.pelvis.position.y = p.pelvisY
    this.torsoPivot.rotation.set(p.torsoPitch, p.torsoYaw, p.torsoRoll)
    this.headPivot.rotation.set(p.headPitch, p.headYaw, 0)
    this.armLPivot.rotation.set(p.armLPitch, 0, p.armLRoll)
    this.armRPivot.rotation.set(p.armRPitch, 0, p.armRRoll)
    this.legLPivot.rotation.set(p.legLPitch, 0, 0)
    this.legRPivot.rotation.set(p.legRPitch, 0, 0)
  }

  /** rebuild a segment's voxel instances from the sim grid (damage-visible) */
  private rebuild(mesh: InstancedMesh, segIndex: number, seg: PlayerSegment): void {
    const { name, ox, oy, oz, sx, sy, sz } = seg.def
    const pivot = PIVOTS[name as SegmentName]
    let n = 0
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          if (seg.grid[x + z * sx + y * sx * sz] === 0) continue
          this.scratch.makeTranslation(
            (ox + x + 0.5 - pivot[0]) * VOXEL_SIZE,
            (oy + y + 0.5 - pivot[1]) * VOXEL_SIZE,
            (oz + z + 0.5 - pivot[2]) * VOXEL_SIZE,
          )
          mesh.setMatrixAt(n, this.scratch)
          const jit = voxelJitter(segIndex, x, y, z)
          this.scratchColor.set(segmentVoxelColor(name, x, y, z, seg.def))
          this.scratchColor.multiplyScalar(jit)
          mesh.setColorAt(n, this.scratchColor)
          n++
        }
      }
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }
}
