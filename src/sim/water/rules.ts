/**
 * T15 — water CA rule spec. THE single source of truth for both
 * implementations:
 *   - CPU reference: src/sim/water/water-sim.ts (authoritative, unit-tested)
 *   - GPU mirror:    src/render/water/compute.ts (TSL, perf path)
 * Any change here must be mirrored in the TSL kernels, and vice versa.
 *
 * Design constraints (V4, V9, V2):
 *   - Integer state only: water level 0..255 per cell (u8). No floats anywhere
 *     in state or rules.
 *   - Gather-only: next(cell) depends only on the PREVIOUS state of the cell
 *     and its face neighbors. Both sides of a flow pair compute the identical
 *     flow amount from the same inputs, so mass is conserved without atomics.
 *   - Solid voxels (material != 0) never hold water; their level is always 0
 *     and they block all flow.
 *   - One sim step = two sub-passes in fixed order: VERTICAL then LATERAL.
 *     Each sub-pass is a full gather pass over its own double buffer
 *     (ping-pong). Fixed dispatch order (V4).
 *
 * VERTICAL pass (gravity):
 *   out_down = belowOpen ? min(L, MAX - L_below) : 0
 *   in_above = min(L_above, MAX - L)          // 0 if above is solid/OOB, since
 *                                             // solid/OOB cells hold level 0
 *   next = L - out_down + in_above
 *   Pairwise symmetry: the flow across the (above, self) face is
 *   min(L_above, MAX - L) computed identically by both cells.
 *
 * LATERAL pass (spread, Margolus-style pairing):
 *   phase = stepCount & 3 selects axis (x or z) and pairing offset (0 or 1),
 *   so over 4 steps every lateral face is visited once. Cell pairs with
 *   exactly one partner per pass: partner = coord+1 if (coord+offset) even,
 *   else coord-1. The pair equalizes:
 *     total = L + Ln; half = total >> 1; remainder goes to the FULLER cell
 *   (prevents 2-cell oscillation; equal levels have even total, no remainder).
 *   Exchange happens only if:
 *     - both cells non-solid and in bounds (else: keep L), and
 *     - the DONOR (fuller cell) is supported: y == 0, or solid below, or
 *       water below at MAX. Unsupported water falls instead of spreading;
 *       a supported donor may push into an unsupported partner (waterfall
 *       over a ledge works).
 *
 * Compression/pressure rule: intentionally omitted in v1 (task marks it
 * optional). Consequence: no upward equalization through U-bends. Documented
 * in INTEGRATION-water.md.
 */

export const MAX_LEVEL = 255

/** Next level of a cell in the vertical pass. Caller guarantees self is non-solid. */
export function verticalNext(level: number, above: number, below: number, belowOpen: boolean): number {
  const room = MAX_LEVEL - below
  const out = belowOpen ? (level < room ? level : room) : 0
  const selfRoom = MAX_LEVEL - level
  const inn = above < selfRoom ? above : selfRoom
  return level - out + inn
}

/**
 * Next level of a cell in the lateral pass, given its pair partner.
 * Caller guarantees: self non-solid, partner non-solid and in bounds.
 * Symmetric: both cells of the pair evaluate this with swapped (level, partner)
 * and identical donorSupported, and the results sum to level + partner.
 */
export function lateralNext(level: number, partner: number, donorSupported: boolean): number {
  if (level === partner || !donorSupported) return level
  const total = level + partner
  const half = total >> 1
  // remainder (total odd) goes to the fuller cell
  return (total & 1) === 1 && level > partner ? half + 1 : half
}

/** Lateral pairing schedule: axis 0 = x, 1 = z; offset flips pairing parity. */
export function lateralPhase(stepCount: number): { axis: 0 | 1; offset: 0 | 1 } {
  const phase = stepCount & 3
  return { axis: (phase & 1) as 0 | 1, offset: (phase >> 1) as 0 | 1 }
}
