/**
 * T71 — combined desync hash (V3, V10). The desync detector originally hashed
 * only hashSim (tick + prng + entities + chunks); physics bodies and the water
 * field are sim state too (INTEGRATION-net.md open issue 4) — a divergence
 * there must not stay invisible. This combines the three EXISTING exported
 * hash functions into one FNV word: hashSim ⊕ hashPhysics ⊕ water field.
 *
 * Read-only over all three systems (V1/V6). Deterministic: fixed order,
 * fixed-width u32 feeds.
 */
import type { Sim } from '../sim/loop'
import { Fnv, hashSim } from '../sim/hash'
import { hashPhysics, type PhysicsWorld } from '../sim/physics'
import { hashWaterInto, type WaterSim } from '../sim/water/water-sim'

export function combinedHash(sim: Sim, phys: PhysicsWorld, water: WaterSim): number {
  const h = new Fnv()
  h.u32(hashSim(sim))
  h.u32(hashPhysics(phys))
  return hashWaterInto(h, water).value
}
