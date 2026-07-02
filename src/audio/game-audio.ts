/**
 * T37 [A] — game event → sound mapping (I.audio). Render layer (V6): reads
 * voxels via ChunkStore.getVoxel (read-only) and the player entity snapshot
 * the integrator passes each frame; writes no sim state.
 *
 * Material ids come from the single I.mat authority src/sim/materials.ts
 * (V13) — the surface/impact maps below are keyed by those ids and covered
 * by an exhaustive per-id unit test.
 *
 * Positions in this module are world METERS (render-side convention); voxel
 * lookups convert via VOXEL_SIZE.
 */
import {
  MAT_AIR,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_FLESH,
  MAT_GLASS,
  MAT_GRASS,
  MAT_LAMP,
  MAT_LEAVES,
  MAT_METAL,
  MAT_PAINT,
  MAT_PLASTER,
  MAT_ROOFTILE,
  MAT_WATER_SOLID,
  MAT_WOOD,
} from '../sim/materials'
import { VOXEL_SIZE } from '../world/chunks'
import type { PlayOptions } from './engine'

/** what GameAudio needs from AudioEngine (kept minimal for unit-test fakes) */
export interface SoundPlayer {
  play(name: string, opts?: PlayOptions): unknown
}

/** read-only voxel access (ChunkStore satisfies this) */
export interface VoxelReader {
  getVoxel(x: number, y: number, z: number): number
}

// --- material id → sound mapping ------------------------------------------------
export type FootstepSurface = 'grass' | 'concrete' | 'asphalt' | 'wood' | 'dirt' | 'water'

/** voxel material under the player's feet → footstep surface (null = air, no step) */
export function footstepSurface(mat: number): FootstepSurface | null {
  switch (mat) {
    case MAT_AIR:
      return null
    case MAT_DIRT:
      return 'dirt'
    case MAT_GRASS:
    case MAT_LEAVES:
      return 'grass'
    case MAT_ASPHALT:
    case MAT_PAINT:
      return 'asphalt' // paint is a 1-voxel skin on road surfaces
    case MAT_CONCRETE:
    case MAT_BRICK:
    case MAT_PLASTER:
    case MAT_ROOFTILE:
    case MAT_GLASS:
    case MAT_METAL:
    case MAT_LAMP:
      return 'concrete' // hard mineral/metal surfaces share the concrete set
    case MAT_WOOD:
      return 'wood'
    case MAT_WATER_SOLID:
      return 'water'
    case MAT_FLESH:
      return 'dirt' // soft organic — closest match
    default:
      return 'dirt' // unknown/reserved ids: safe soft default, never crash audio
  }
}

/** hit material → impact round-robin group (null = air, no sound) */
export function impactGroup(mat: number): string | null {
  switch (mat) {
    case MAT_AIR:
      return null
    case MAT_DIRT:
    case MAT_FLESH:
      return 'impact-dirt'
    case MAT_GRASS:
    case MAT_LEAVES:
      return 'impact-grass'
    case MAT_ASPHALT:
    case MAT_PAINT:
    case MAT_CONCRETE:
    case MAT_PLASTER:
    case MAT_ROOFTILE:
      return 'impact-concrete'
    case MAT_BRICK:
      return 'impact-brick'
    case MAT_WOOD:
      return 'impact-wood'
    case MAT_GLASS:
      return 'impact-glass'
    case MAT_METAL:
    case MAT_LAMP:
      return 'impact-metal'
    case MAT_WATER_SOLID:
      return 'impact-water'
    default:
      return 'impact-dirt'
  }
}

/** explode op power → explosion asset (thresholds vs I.mat strengths 1..8) */
export function explosionGroup(power: number): 'explosion-small' | 'explosion-medium' | 'explosion-large' {
  if (power < 4) return 'explosion-small'
  if (power < 8) return 'explosion-medium'
  return 'explosion-large'
}

const SOFT_SURFACES: ReadonlySet<FootstepSurface> = new Set(['grass', 'dirt', 'water'])

// --- footsteps -------------------------------------------------------------------
/** speed above which the run set plays (walk 4 m/s, crouch 2 m/s per sim) */
export const RUN_SPEED_THRESHOLD = 3
/** meters travelled per step */
export const WALK_STRIDE = 0.85
export const RUN_STRIDE = 1.35
/** minimum speed to produce footsteps at all */
export const MIN_STEP_SPEED = 0.3
/** takeoff detection: upward velocity on leaving the ground */
export const JUMP_VY_THRESHOLD = 1

export interface PlayerAudioState {
  /** feet position, meters (PlayerEntity px/py/pz) */
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  grounded: boolean
}

export class GameAudio {
  private readonly engine: SoundPlayer
  private readonly world: VoxelReader

  private strideAcc = 0
  private prevGrounded = true
  private heartbeat: { stop(fade?: number): void } | null = null
  private lowHealth = false

  constructor(engine: SoundPlayer, world: VoxelReader) {
    this.engine = engine
    this.world = world
  }

  /** first solid voxel within 3 voxels below the feet → surface (null = airborne over nothing) */
  surfaceAt(px: number, py: number, pz: number): FootstepSurface | null {
    const vx = Math.floor(px / VOXEL_SIZE)
    const vz = Math.floor(pz / VOXEL_SIZE)
    const vy0 = Math.floor((py + 0.01) / VOXEL_SIZE) - 1
    for (let dy = 0; dy < 3; dy++) {
      const mat = this.world.getVoxel(vx, vy0 - dy, vz)
      if (mat !== MAT_AIR) return footstepSurface(mat)
    }
    return null
  }

  /**
   * Per-frame footstep/jump/land poller. Call with the interpolated player
   * state each render frame; dt in seconds. Distance-based stride so step
   * cadence tracks actual speed.
   */
  update(dt: number, player: PlayerAudioState | null): void {
    if (!player) return
    const speed = Math.hypot(player.vx, player.vz)
    const pos = { x: player.px, y: player.py, z: player.pz }

    // jump / land transitions
    if (this.prevGrounded && !player.grounded && player.vy > JUMP_VY_THRESHOLD) {
      const surface = this.surfaceAt(player.px, player.py, player.pz)
      if (surface) {
        this.engine.play(SOFT_SURFACES.has(surface) ? 'jump-takeoff-soft' : 'jump-takeoff-hard', {
          position: pos,
        })
      }
    } else if (!this.prevGrounded && player.grounded) {
      const surface = this.surfaceAt(player.px, player.py, player.pz)
      if (surface) {
        this.engine.play(SOFT_SURFACES.has(surface) ? 'jump-land-soft' : 'jump-land-hard', {
          position: pos,
        })
      }
      this.strideAcc = 0 // landing resets the cadence
    }
    this.prevGrounded = player.grounded

    // footsteps: accumulate travelled distance while grounded and moving
    if (!player.grounded || speed < MIN_STEP_SPEED) {
      return
    }
    const running = speed >= RUN_SPEED_THRESHOLD
    const stride = running ? RUN_STRIDE : WALK_STRIDE
    this.strideAcc += speed * dt
    if (this.strideAcc >= stride) {
      this.strideAcc -= stride
      if (this.strideAcc > stride) this.strideAcc = 0 // don't burst after a long stall
      const surface = this.surfaceAt(player.px, player.py, player.pz)
      if (surface) {
        // jittered volume + playback rate so fast cadences (sprint) don't
        // machine-gun the same transient — render-side randomness is fine (V6)
        this.engine.play(`footstep-${running ? 'run' : 'walk'}-${surface}`, {
          position: pos,
          refDistance: 1.5,
          maxDistance: 30,
          volume: (running ? 0.55 : 0.85) * (0.85 + Math.random() * 0.15),
          playbackRate: 0.92 + Math.random() * 0.16,
        })
      }
    }
  }

  // --- event hooks (integrator wires these — see INTEGRATION-audio.md) ----------

  /** dig/place/projectile hit at world meters against material `mat` */
  onImpact(x: number, y: number, z: number, mat: number): void {
    const group = impactGroup(mat)
    if (!group) return
    this.engine.play(group, { position: { x, y, z }, refDistance: 2, maxDistance: 60 })
  }

  /** explode op: position world meters, power = op power */
  onExplosion(x: number, y: number, z: number, power: number): void {
    const position = { x, y, z }
    this.engine.play(explosionGroup(power), {
      position,
      refDistance: 8,
      maxDistance: 250,
      rolloffFactor: 0.8,
    })
    if (power >= 4) {
      this.engine.play('explosion-debris-rain', { position, refDistance: 6, maxDistance: 120 })
    }
    // non-positional distant layer sells scale on big blasts
    if (power >= 8) this.engine.play('explosion-distant-rumble', { volume: 0.8 })
  }

  /** local player fired — non-positional shot + echo tail */
  onShoot(): void {
    this.engine.play('shot-pistol')
    this.engine.play('shot-echo-tail', { volume: 0.7 })
  }

  /** structure collapse (island extraction) at world meters, voxel count for scale */
  onCollapse(x: number, y: number, z: number, voxels: number): void {
    const position = { x, y, z }
    if (voxels > 200) {
      this.engine.play('collapse-structure', { position, refDistance: 6, maxDistance: 150 })
    } else {
      this.engine.play('chunk-crumble', { position, refDistance: 3, maxDistance: 80 })
    }
  }

  /** glass pane broke (render can detect glass in dirty edits) */
  onGlassShatter(x: number, y: number, z: number): void {
    this.engine.play('glass-pane-shatter', { position: { x, y, z }, refDistance: 3, maxDistance: 80 })
  }

  /**
   * Water splash API — wire from buoyancy/water events when those land
   * (body enters water, large water displacement). World meters.
   */
  onWaterSplash(x: number, y: number, z: number, size: 'small' | 'large' = 'small'): void {
    this.engine.play(size === 'large' ? 'splash-large' : 'splash-small', {
      position: { x, y, z },
      refDistance: 3,
      maxDistance: 70,
    })
  }

  /** player took damage (segment loss / hit) */
  onHurt(): void {
    this.engine.play('player-hurt')
  }

  onDeath(): void {
    this.engine.play('player-death')
  }

  /** toggle the low-health heartbeat loop */
  setLowHealth(low: boolean): void {
    if (low === this.lowHealth) return
    this.lowHealth = low
    if (low) {
      const h = this.engine.play('heartbeat-low-health-loop')
      // AudioEngine.play resolves async; if health recovered meanwhile, stop right away
      Promise.resolve(h as Promise<{ stop(fade?: number): void } | null>).then((handle) => {
        if (!handle) return
        if (this.lowHealth) this.heartbeat = handle
        else handle.stop()
      })
    } else if (this.heartbeat) {
      this.heartbeat.stop(0.5)
      this.heartbeat = null
    }
  }
}
