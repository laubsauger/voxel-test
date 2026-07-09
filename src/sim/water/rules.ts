/**
 * T15/T62 — water COLUMN rules. Single source of truth for the column
 * heightfield sim (src/sim/water/water-sim.ts).
 *
 * MODEL (v3 — replaces the 3D per-voxel CA; user verdict on the CA: "too
 * intense for too little gain"). Water is a set of vertical COLUMNS, one per
 * (x,z) with water. A column is ONE contiguous span: an integer `bottom`
 * voxel plus an integer `mass` in units of 1/255 voxel. The surface sits at
 * `surfU = bottom*255 + mass` (absolute units, 255 per voxel): every cell
 * strictly below the surface is full (level 255), the surface cell holds the
 * partial remainder. That keeps levelAt()/extraction/buoyancy semantics of
 * the old CA bit-compatible for settled water.
 *
 * Design constraints (V2, V9):
 *   - Integer state only. Deterministic iteration order. No wall clock, no
 *     ambient randomness.
 *   - Transfers move whole integer unit amounts between exactly two columns
 *     (sequential relaxation in fixed order) — mass is exactly conserved by
 *     construction across every step. Explicit sinks (solid placed into
 *     water, removeWater) are the only mass events, and they are reported.
 *
 * LATERAL rule (per ordered neighbor pair, donor = higher surface):
 *   - SILL: water can leave the donor only through an open (non-solid) voxel
 *     of the receiver column within the donor's span — the lowest such voxel
 *     is the sill. No open voxel ⇒ walls hold (pools). Breaching a wall
 *     opens a sill below the surface ⇒ the column drains through it (B21).
 *   - flow t = min( (surfA − surfB)/2,   equalization half-step
 *                   surfA − sill·255,     nothing below the sill can leave
 *                   FLOW_CAP )            advection rate limit per pair/step
 *   - DEADBAND (wet receiver only): |surfA − surfB| ≤ SURFACE_DEADBAND is a
 *     fixpoint — kills the bucket-brigade trickle that kept the old CA awake
 *     for O(area) steps (B21). A DRY receiver has no deadband: residue films
 *     still roll over ledges instead of stranding at lips.
 *
 * VERTICAL rule: a span whose below-bottom voxel is open falls 1 voxel per
 * step (12 m/s at 2 steps/tick — same fall rate as the old CA). Received
 * water lands directly on the receiver's surface (free-fall streams are NOT
 * simulated — explicitly accepted fidelity loss; the render layer may fake
 * them).
 *
 * Settle guarantee: every transfer strictly lowers the donor's surface to no
 * lower than the receiver's new surface (t ≤ half the difference), so pair
 * order cannot oscillate; falls strictly decrease potential energy; the
 * deadband makes near-flat configurations exact fixpoints over finite
 * integer state ⇒ the active set empties.
 *
 * DROPPED vs the old CA (documented fidelity loss, user-approved):
 *   - free-falling / airborne water blobs (streams teleport to the surface)
 *   - more than one water body stacked in the same (x,z) column. Corollary:
 *     water cannot travel UNDER a column that still holds water above, so an
 *     interior floor pinhole only relocates/equalizes the breached columns
 *     (pool level dips, does not empty); a floor breach whose columns have a
 *     lateral exit (basin edge, crater to daylight) drains fully — tested.
 *     WALL breaches — the B21 case — always drain.
 *   - splash/slosh of falling columns (no falling columns anymore)
 */

/** units per full voxel cell — levelAt() range stays 0..255 */
export const MAX_LEVEL = 255

/**
 * Wet-receiver pairs with surface difference ≤ this (units) do not flow.
 * Residue: adjacent settled columns may differ by ≤2/255 voxel (~0.8%).
 */
export const SURFACE_DEADBAND = 2

/**
 * Max units moved across one column pair per step: 2 voxels × 2 steps/tick
 * = up to 4 voxels/tick through a breach face — pools drain on gameplay
 * timescales (the B21 promise) while staying rate-limited enough to read as
 * flow, not teleportation.
 */
export const FLOW_CAP = 510

/**
 * Units to move from the donor column (surface surfA) to the receiver
 * (surface surfB — for a dry receiver pass its landing floor `bottom*255`).
 * `sillU` = lowest open exchange voxel × 255 (see header). Pure, integer.
 * Returns 0..min(FLOW_CAP, surfA − sillU). Donor never ends below receiver.
 */
export function columnFlow(surfA: number, surfB: number, sillU: number, receiverWet: boolean): number {
  const diff = surfA - surfB
  if (diff <= 0) return 0
  if (receiverWet && diff <= SURFACE_DEADBAND) return 0
  const avail = surfA - sillU
  if (avail <= 0) return 0
  let t = diff >> 1
  if (t > avail) t = avail
  if (t > FLOW_CAP) t = FLOW_CAP
  return t
}
