/**
 * T13 [P] — explode op handler (I.cmd). This IS the command path (V1):
 * sphere-destroy voxels strength-scaled by material, then connectivity check
 * (island extraction), then radial impulse to nearby dynamic bodies.
 * Registered by createPhysics().
 */
import type { Sim } from './loop'
import { VOXEL_SIZE } from '../world/chunks'
import { material } from './materials'
import { damagePlayersSphere } from './player'
import type { PhysicsWorld } from './physics'

/** impulse (kg·m/s) applied per unit of explode power at the blast center */
export const IMPULSE_PER_POWER = 50
/** impulse reach relative to the destruction radius */
export const IMPULSE_RADIUS_SCALE = 2

/**
 * Destroy voxels in a sphere, harder materials surviving the outer radius:
 * a voxel dies when falloff·power ≥ strength, falloff = 1 − dist/r.
 * Deterministic iteration order (y→z→x), integer voxel coords (V2).
 */
export function destroySphere(sim: Sim, cx: number, cy: number, cz: number, r: number, power: number): void {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r)
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r)
  const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r)
  const r2 = r * r
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const mat = sim.world.getVoxel(x, y, z)
        if (mat === 0) continue
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > r2) continue
        const falloff = 1 - Math.sqrt(d2) / r
        if (falloff * power >= material(mat).strength) sim.world.setVoxel(x, y, z, 0)
      }
    }
  }
}

export function registerDestructionOps(sim: Sim, phys: PhysicsWorld): void {
  sim.onOp('explode', (s, cmd) => {
    const { x, y, z, r, power } = cmd.op
    destroySphere(s, x, y, z, r, power)
    // T22: explode overlap damages player body segments (same strength rule)
    damagePlayersSphere(phys, x, y, z, r, power)
    // synchronous connectivity + island extraction on the affected region (T11/T12)
    phys.structuralPass(s)
    // radial impulse to nearby dynamic bodies — including islands spawned above
    phys.applyRadialImpulse(
      x * VOXEL_SIZE,
      y * VOXEL_SIZE,
      z * VOXEL_SIZE,
      r * VOXEL_SIZE * IMPULSE_RADIUS_SCALE,
      power * IMPULSE_PER_POWER,
    )
  })
}
