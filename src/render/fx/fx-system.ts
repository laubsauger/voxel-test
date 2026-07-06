/**
 * T53 — destruction/combat VFX orchestrator (B13/B18). Render-only (V6):
 * consumes the sim event outbox (Sim.drainEvents(), drained once per frame by
 * the game loop and passed in) plus the projectile map for trails. Writes
 * NOTHING back into the sim.
 *
 * Explosion = flash (top of the HDR hierarchy) + fireball puffs + radial
 * voxel-debris cubes seeded from the event's removed-voxel sample (velocities
 * FROM the blast center — B13's fix for "particles rain up/down") + expanding
 * ground dust ring + rising smoke plume + sparks.
 *
 * Gun impact FX (B18): particles emit AT the hit voxel face, in a cone around
 * the surface normal blended with the reflected impact direction —
 * material-colored puffs, plus hot sparks on metal/masonry. Muzzle flash =
 * brief HDR sprite + point light at the camera (viewmodel agent can re-anchor
 * later). Tracer = fading HDR line.
 *
 * Wiring: see src/render/INTEGRATION-boom.md (game.ts is owned elsewhere).
 */
import { Group, PointLight, Sprite, SpriteNodeMaterial, type PerspectiveCamera } from 'three/webgpu'
import { uniform, vec3, uv, float, smoothstep } from 'three/tsl'
import { AdditiveBlending } from 'three/webgpu'
import type { SimEvent, ExplosionEvent, ShotEvent } from '../../sim/events'
import { getMaterial, MAT_ASPHALT, MAT_BRICK, MAT_CONCRETE, MAT_METAL } from '../../sim/materials'
import { ddaRaycast } from '../../sim/shoot-op'
import { VOXEL_SIZE } from '../../world/chunks'
import { CubePool, SpritePool } from './pools'
import { TracerPool } from './tracers'

interface VoxelSource {
  getVoxel(x: number, y: number, z: number): number
}

/** materials that throw hot sparks when shot */
const SPARKY = new Set<number>([MAT_METAL, MAT_ASPHALT, MAT_CONCRETE, MAT_BRICK])

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)

/** material id → mid-ramp rgb in 0..1 (render-side derive, V13) */
function matColor(mat: number): [number, number, number] {
  const m = getMaterial(mat)
  const [a, b] = m ? m.colorRamp : [0x808080, 0x808080]
  const k = Math.random()
  const mix = (ca: number, cb: number, sh: number) =>
    (((ca >> sh) & 0xff) / 255) * (1 - k) + (((cb >> sh) & 0xff) / 255) * k
  return [mix(a, b, 16), mix(a, b, 8), mix(a, b, 0)]
}

export class FxSystem {
  /** add to the scene once; everything lives under it */
  readonly group = new Group()

  private readonly debris = new CubePool(1536)
  private readonly flash: SpritePool
  private readonly fire: SpritePool
  private readonly sparks: SpritePool
  private readonly smoke: SpritePool
  private readonly dust: SpritePool
  private readonly tracers = new TracerPool(12)

  // muzzle flash: one sprite + light, re-triggered per local shot
  private readonly muzzle: Sprite
  private readonly muzzleGain = uniform(0)
  private readonly muzzleLight: PointLight
  private muzzleTtl = 0

  constructor(private readonly world?: VoxelSource) {
    this.flash = new SpritePool({
      capacity: 8, additive: true, growth: 2.4, drag: 0, gravity: 0,
      fadeIn: 0.02, fadeOut: 0.1, edge: [0.05, 1], spin: 0,
    })
    this.fire = new SpritePool({
      capacity: 96, additive: true, growth: 2.6, drag: 3, gravity: 0,
      fadeIn: 0.04, fadeOut: 0.3, edge: [0.15, 0.95], spin: 2.5,
    })
    this.sparks = new SpritePool({
      capacity: 512, additive: true, growth: 0.55, drag: 1.6, gravity: -7,
      fadeIn: 0.01, fadeOut: 0.35, edge: [0.05, 0.9], spin: 0,
    })
    this.smoke = new SpritePool({
      capacity: 256, additive: false, growth: 3.6, drag: 1.2, gravity: 0.35,
      fadeIn: 0.1, fadeOut: 0.4, edge: [0.3, 1], spin: 1.2,
    })
    this.dust = new SpritePool({
      capacity: 256, additive: false, growth: 3.8, drag: 2.4, gravity: 0,
      fadeIn: 0.05, fadeOut: 0.4, edge: [0.35, 1], spin: 0.8,
    })
    this.group.add(
      this.debris.object, this.flash.object, this.fire.object,
      this.sparks.object, this.smoke.object, this.dust.object, this.tracers.group,
    )

    const mMat = new SpriteNodeMaterial()
    const d = uv().sub(0.5).length().mul(2)
    mMat.colorNode = vec3(10, 7, 3.5).mul(this.muzzleGain)
    mMat.opacityNode = float(1).sub(smoothstep(float(0.1), float(1), d)).mul(this.muzzleGain)
    mMat.transparent = true
    mMat.depthWrite = false
    mMat.blending = AdditiveBlending
    this.muzzle = new Sprite(mMat)
    // P26 — scale 0 when idle so a fade-to-black sprite can't linger as a black
    // square (additive blending doesn't reliably hide gain-0 in WebGPU). Stays
    // in the render list at size 0 → pipeline stays warm (no .visible recompile).
    this.muzzle.scale.setScalar(0)
    // B33 — stay permanently visible (muzzleGain drives opacity/color to 0 when
    // idle, so it renders nothing). A .visible=false→true flip on the first
    // shot defers this SpriteNodeMaterial's pipeline compile to that frame — a
    // one-time render-thread stall (the residual shoot hitch after B31). Being
    // visible from construction warms it during the loading render instead.
    this.muzzle.visible = true
    this.muzzle.frustumCulled = false
    // B31 — muzzle light stays permanently visible (intensity 0 when idle):
    // toggling .visible per shot recompiled every lit material (see flashlight).
    this.muzzleLight = new PointLight(0xffc37a, 0, 7, 1.8)
    this.muzzleLight.visible = true
    this.group.add(this.muzzle, this.muzzleLight)
  }

  /**
   * Per frame, after the sim tick(s): `events` = sim.drainEvents().
   * Camera anchors the muzzle flash for local shots.
   */
  update(dt: number, events: readonly SimEvent[], camera?: PerspectiveCamera): void {
    for (const ev of events) {
      if (ev.kind === 'explosion') this.onExplosion(ev)
      else if (ev.kind === 'shot') this.onShot(ev, camera)
    }
    this.debris.update(dt)
    this.flash.update(dt)
    this.fire.update(dt)
    this.sparks.update(dt)
    this.smoke.update(dt)
    this.dust.update(dt)
    this.tracers.update(dt)

    if (this.muzzleTtl > 0) {
      this.muzzleTtl -= dt
      const k = Math.max(this.muzzleTtl / 0.055, 0)
      this.muzzleGain.value = k
      this.muzzleLight.intensity = 60 * k
      if (this.muzzleTtl <= 0) {
        // B33 — muzzleGain is already 0 here (k clamps to 0), so the sprite is
        // invisible without a .visible flip; keep it visible to hold the warm
        // pipeline (see constructor).
        this.muzzleLight.intensity = 0 // stays visible/counted; just goes dark
        this.muzzle.scale.setScalar(0) // P26 — collapse so no black square lingers
      }
    }
  }

  /** small grey puff behind an airborne bomb (called by ProjectileMeshes) */
  bombTrail(x: number, y: number, z: number): void {
    const g = rand(0.25, 0.4)
    this.smoke.emit(
      x + rand(-0.03, 0.03), y + rand(-0.02, 0.05), z + rand(-0.03, 0.03),
      rand(-0.1, 0.1), rand(0.3, 0.6), rand(-0.1, 0.1),
      rand(0.5, 0.9), rand(0.09, 0.16), g, g, g, 0.4,
    )
  }

  /**
   * P19 — hot exhaust puff + spark behind a flying rocket (called by
   * RocketMeshes each cadence tick). Bright additive smoke so it reads as a
   * jet plume, plus a small ember.
   */
  rocketTrail(x: number, y: number, z: number): void {
    const g = rand(0.5, 0.75)
    this.smoke.emit(
      x + rand(-0.04, 0.04), y + rand(-0.04, 0.04), z + rand(-0.04, 0.04),
      rand(-0.15, 0.15), rand(-0.05, 0.2), rand(-0.15, 0.15),
      rand(0.35, 0.6), rand(0.12, 0.22), g, g * 0.85, g * 0.7, 0.6,
    )
    this.sparks.emit(
      x, y, z,
      rand(-0.6, 0.6), rand(-0.3, 0.6), rand(-0.6, 0.6),
      rand(0.1, 0.25), rand(0.012, 0.02), 9, 4.6, 1.5, 1,
    )
  }

  /**
   * P19 — backblast when a rocket launches: a cone of smoke + sparks fired
   * OPPOSITE the aim direction (nx,ny,nz = travel dir). Called once by
   * RocketMeshes the frame a new rocket id first appears.
   */
  rocketBackblast(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    for (let i = 0; i < 10; i++) {
      const s = rand(2.5, 6)
      this.smoke.emit(
        x, y, z,
        -nx * s + rand(-1, 1), -ny * s + rand(-0.4, 0.8), -nz * s + rand(-1, 1),
        rand(0.35, 0.6), rand(0.12, 0.22), 0.5, 0.42, 0.36, 0.6,
      )
    }
    for (let i = 0; i < 14; i++) {
      const s = rand(4, 10)
      this.sparks.emit(
        x, y, z,
        -nx * s + rand(-1.2, 1.2), -ny * s + rand(-0.5, 1), -nz * s + rand(-1.2, 1.2),
        rand(0.15, 0.35), rand(0.014, 0.024), 9, 4.6, 1.5, 1,
      )
    }
    // muzzle flash sprite reuse: a brief hot puff at the tube mouth
    this.flash.emit(x, y, z, 0, 0, 0, 0.08, 0.8, 14, 9, 4, 1)
  }

  /** tiny hot sputter at the fuse tip (called by ProjectileMeshes) */
  fuseSpark(x: number, y: number, z: number): void {
    for (let i = 0; i < 2; i++) {
      this.sparks.emit(
        x, y, z,
        rand(-0.7, 0.7), rand(0.4, 1.4), rand(-0.7, 0.7),
        rand(0.15, 0.3), rand(0.012, 0.022), 8, 4.2, 1.2, 1,
      )
    }
  }

  // -------------------------------------------------------------------------

  private groundY(x: number, y: number, z: number): number {
    if (!this.world) return y - 1
    const hit = ddaRaycast(this.world, x / VOXEL_SIZE, y / VOXEL_SIZE, z / VOXEL_SIZE, 0, -1, 0, 80)
    return hit ? (hit.y + 1) * VOXEL_SIZE : y - 8
  }

  private onExplosion(ev: ExplosionEvent): void {
    const { x, y, z, r } = ev
    const floor = this.groundY(x, y + 0.05, z)

    // flash — brightest thing in the scene for a few frames
    this.flash.emit(x, y, z, 0, 0, 0, 0.13, r * 3, 28, 22, 13, 1)

    // fireball puffs, radial
    for (let i = 0; i < 16; i++) {
      const th = rand(0, Math.PI * 2)
      const ph = rand(-0.6, 1.0)
      const s = rand(2.5, 6.5)
      const hot = rand(0.6, 1)
      this.fire.emit(
        x + rand(-0.2, 0.2) * r, y + rand(-0.15, 0.25) * r, z + rand(-0.2, 0.2) * r,
        Math.cos(th) * Math.cos(ph) * s, Math.sin(ph) * s + 1.2, Math.sin(th) * Math.cos(ph) * s,
        rand(0.35, 0.6), r * rand(0.55, 0.9), 7 * hot, 2.6 * hot, 0.55 * hot, 1,
        i * 0.012,
      )
    }

    // sparks — fast, hot, ballistic
    for (let i = 0; i < 40; i++) {
      const th = rand(0, Math.PI * 2)
      const up = rand(-0.15, 0.95)
      const h = Math.sqrt(Math.max(0, 1 - up * up))
      const s = rand(7, 17)
      this.sparks.emit(
        x, y, z,
        Math.cos(th) * h * s, up * s, Math.sin(th) * h * s,
        rand(0.35, 0.8), rand(0.025, 0.05), 9, 4.4, 1.3, 1,
      )
    }

    // radial voxel debris from the REAL removed-voxel sample (B13):
    // velocity points from the blast center through each voxel
    const sample = ev.sample
    for (let i = 0; i < sample.length; i += 4) {
      const px = (sample[i] + 0.5) * VOXEL_SIZE
      const py = (sample[i + 1] + 0.5) * VOXEL_SIZE
      const pz = (sample[i + 2] + 0.5) * VOXEL_SIZE
      const [cr, cg, cb] = matColor(sample[i + 3])
      let dx = px - x, dy = py - y, dz = pz - z
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      dx /= len; dy /= len; dz /= len
      const s = rand(3.5, 10) * (1.25 - (0.5 * len) / r)
      this.debris.emit(
        px, py, pz,
        dx * s + rand(-0.6, 0.6), dy * s + rand(1.2, 3), dz * s + rand(-0.6, 0.6),
        rand(1.3, 2.4), rand(0.06, 0.115), cr, cg, cb, floor + rand(0, 0.08),
      )
    }
    // top up with shell-random debris so big blasts stay dense even though
    // the event sample is capped (colors weighted by removedByMat)
    let removed = 0
    for (let i = 1; i < ev.removedByMat.length; i += 2) removed += ev.removedByMat[i]
    const extra = Math.min(Math.max(removed - sample.length / 4, 0), 160)
    for (let i = 0; i < extra; i++) {
      const mi = Math.floor(rand(0, ev.removedByMat.length / 2)) * 2
      const [cr, cg, cb] = matColor(ev.removedByMat[mi])
      const th = rand(0, Math.PI * 2)
      const up = rand(-0.2, 1)
      const h = Math.sqrt(Math.max(0, 1 - up * up))
      const s = rand(3, 9)
      this.debris.emit(
        x + Math.cos(th) * h * 0.3 * r, y + up * 0.3 * r, z + Math.sin(th) * h * 0.3 * r,
        Math.cos(th) * h * s, up * s + rand(1, 3), Math.sin(th) * h * s,
        rand(1.2, 2.2), rand(0.05, 0.1), cr, cg, cb, floor + rand(0, 0.08),
      )
    }

    // expanding dust ring at ground height
    for (let i = 0; i < 26; i++) {
      const th = (i / 26) * Math.PI * 2 + rand(-0.1, 0.1)
      const s = rand(5, 9)
      this.dust.emit(
        x + Math.cos(th) * 0.6 * r, floor + 0.12, z + Math.sin(th) * 0.6 * r,
        Math.cos(th) * s, rand(0.2, 0.7), Math.sin(th) * s,
        rand(1.0, 1.6), r * rand(0.45, 0.65), 0.42, 0.38, 0.32, 0.55,
      )
    }

    // rising smoke plume — staggered births so the column builds up and lingers
    for (let i = 0; i < 18; i++) {
      const g = rand(0.07, 0.16)
      this.smoke.emit(
        x + rand(-0.3, 0.3) * r, y + rand(-0.1, 0.4) * r, z + rand(-0.3, 0.3) * r,
        rand(-0.5, 0.5), rand(1.4, 3.0), rand(-0.5, 0.5),
        rand(2.6, 4.4), r * rand(0.55, 0.95), g, g, g * 1.05, rand(0.5, 0.65),
        i * 0.07,
      )
    }
  }

  private onShot(ev: ShotEvent, camera?: PerspectiveCamera): void {
    // tracer: from just outside the muzzle to the end point
    this.tracers.fire(
      ev.ox + ev.dx * 0.9, ev.oy + ev.dy * 0.9 - 0.06, ev.oz + ev.dz * 0.9,
      ev.x, ev.y, ev.z,
    )

    // muzzle flash if this shot left the local camera (viewmodel anchor TBD)
    if (camera) {
      const ddx = ev.ox - camera.position.x
      const ddy = ev.oy - camera.position.y
      const ddz = ev.oz - camera.position.z
      if (ddx * ddx + ddy * ddy + ddz * ddz < 0.35) {
        this.muzzle.position.set(ev.ox + ev.dx * 0.7, ev.oy + ev.dy * 0.7 - 0.09, ev.oz + ev.dz * 0.7)
        this.muzzleLight.position.copy(this.muzzle.position)
        // muzzle stays permanently visible (B33); muzzleTtl ramps muzzleGain up
        this.muzzleTtl = 0.055
        this.muzzle.scale.setScalar(0.16) // P26 — pop to size for the flash
      }
    }

    if (!ev.hit) return

    // B18 — impact FX emit AT the hit face, in a cone around the surface
    // normal blended with the reflected impact direction
    const dn = ev.dx * ev.nx + ev.dy * ev.ny + ev.dz * ev.nz
    const rx = ev.dx - 2 * dn * ev.nx
    const ry = ev.dy - 2 * dn * ev.ny
    const rz = ev.dz - 2 * dn * ev.nz
    const px = ev.x + ev.nx * 0.04
    const py = ev.y + ev.ny * 0.04
    const pz = ev.z + ev.nz * 0.04
    const cone = (spread: number): [number, number, number] => {
      const cx = ev.nx * 1.1 + rx * 0.55 + rand(-spread, spread)
      const cy = ev.ny * 1.1 + ry * 0.55 + rand(-spread, spread)
      const cz = ev.nz * 1.1 + rz * 0.55 + rand(-spread, spread)
      const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1
      return [cx / l, cy / l, cz / l]
    }

    // material-colored puffs
    for (let i = 0; i < 3; i++) {
      const [cr, cg, cb] = matColor(ev.mat)
      const [ux, uy, uz] = cone(0.55)
      const s = rand(0.8, 1.7)
      this.dust.emit(
        px, py, pz, ux * s, uy * s, uz * s,
        rand(0.28, 0.45), rand(0.1, 0.18), cr, cg, cb, 0.55,
      )
    }
    // small material chips
    for (let i = 0; i < 5; i++) {
      const [cr, cg, cb] = matColor(ev.mat)
      const [ux, uy, uz] = cone(0.7)
      const s = rand(1.8, 4.2)
      this.debris.emit(
        px, py, pz, ux * s, uy * s, uz * s,
        rand(0.4, 0.8), rand(0.018, 0.032), cr, cg, cb, py - 4,
      )
    }
    // hot sparks on metal/masonry
    if (SPARKY.has(ev.mat)) {
      for (let i = 0; i < 12; i++) {
        const [ux, uy, uz] = cone(0.5)
        const s = rand(3.5, 8.5)
        this.sparks.emit(
          px, py, pz, ux * s, uy * s, uz * s,
          rand(0.2, 0.45), rand(0.014, 0.026), 9, 4.6, 1.5, 1,
        )
      }
    }
  }
}
