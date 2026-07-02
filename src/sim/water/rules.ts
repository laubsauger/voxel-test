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
 *   else coord-1. Exchange requires both cells non-solid and in bounds
 *   (else: keep L). The DONOR is the fuller cell; its mobility selects the
 *   rule leg. Mobility derives from the donor's below-cell in the SAME
 *   previous-state snapshot, so both sides of the pair compute it
 *   identically (pairwise symmetry ⇒ mass exact, V9):
 *
 *   SUPPORTED donor (y == 0, or solid below, or water below at MAX):
 *     1) WATERFALL leg (T62/B21 drain acceleration): if the partner is EMPTY
 *        and the partner is itself unsupported (its below-cell is open and
 *        not full — the received water will fall next vertical pass), the
 *        donor gives EVERYTHING: donor → 0, partner → L. This turns the
 *        approach to a breach/ledge from diffusion (half-diff per visit)
 *        into advection (full cells per visit) — pools visibly drain and
 *        cascades stay chunky instead of thinning into films. Convergent:
 *        the moved mass falls on the next vertical pass (strict Σ y·L
 *        decrease); it cannot ping-pong because the emptied donor no longer
 *        donates and a filled-up receiver becomes supported (normal legs).
 *     2) otherwise equalize with a settle deadband (B21):
 *       diff = |L - Ln|; diff <= LATERAL_DEADBAND ⇒ no flow;
 *       else total = L + Ln; half = total >> 1; remainder to the FULLER cell.
 *     Why the deadband: without it, diff-2 ramps under the alternating
 *     pairing sustain a bucket-brigade trickle for O(area) steps (tens of
 *     thousands at yard scale) — the sim never slept, breach outflow "ran
 *     forever" and the surface mesh rebuilt every frame (B21 + B20 flicker).
 *     With it, any configuration whose adjacent diffs are all <= 2 is a true
 *     fixpoint; residue films are <= 2 levels/cell (~0.8% of a voxel).
 *
 *   SPLASHING donor (unsupported, landing on partial water: 0 < below < MAX):
 *     partial lateral spill (T62 "rolling"):
 *       t = diff >> 2; t == 0 ⇒ no flow; else donor -t, partner +t.
 *     Quarter-diff is contractive (no overshoot ⇒ no pair oscillation) and
 *     mass-exact; falls visibly slosh outward where they meet a pool instead
 *     of stacking a 1-wide column.
 *
 *   FALLING donor (unsupported, below open and empty): no lateral flow —
 *     free-falling streams stay coherent. A supported donor may still push
 *     into an unsupported partner (waterfall over a ledge works).
 *
 * Settle guarantee: vertical flow strictly decreases Σ y·L; lateral flow
 * keeps it constant and either strictly decreases Σ L² (deadbanded
 * equalization; contractive splash) or hands mass to a cell that must fall
 * next vertical pass (waterfall leg ⇒ later strict Σ y·L decrease). The
 * pair (Σ y·L, Σ L²) is a lexicographic Lyapunov function over finite
 * integer state ⇒ the CA reaches a fixpoint and the active set empties.
 *
 * Neighborhood note (V4): the lateral pass reads the pair cells plus BOTH
 * pair cells' below-cells (donor mobility + waterfall receiver check). That
 * is one diagonal read per side — still a fixed, tiny stencil on the
 * previous-state snapshot; gather-only and atomics-free as before.
 *
 * Compression/pressure rule: intentionally omitted in v1 (task marks it
 * optional). Consequence: no upward equalization through U-bends. Documented
 * in INTEGRATION-water.md.
 */

export const MAX_LEVEL = 255

/** supported-donor pairs with level difference <= this do not flow (B21 settle deadband) */
export const LATERAL_DEADBAND = 2

/** donor mobility for the lateral pass — decided by the donor's below-cell */
export const enum DonorMode {
  /** unsupported, below open and empty — falls, no lateral flow */
  Falling = 0,
  /** unsupported, landing on partial water below — quarter-diff spill (T62) */
  Splashing = 1,
  /** y == 0, solid below, or full water below — deadbanded equalization */
  Supported = 2,
}

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
 * Symmetric: both cells of the pair evaluate this with swapped (level,
 * partner) and identical donorMode/receiverUnsupported (both derive from the
 * same previous-state snapshot), and the results sum to level + partner.
 *
 * `receiverUnsupported`: the EMPTIER cell of the pair is not supported (its
 * below-cell is open and below MAX) — it would fall next vertical pass.
 * Only consulted by the waterfall leg; pass false when unknown/irrelevant
 * (e.g. equal levels).
 */
export function lateralNext(
  level: number,
  partner: number,
  donorMode: DonorMode,
  receiverUnsupported: boolean,
): number {
  if (level === partner || donorMode === DonorMode.Falling) return level
  const diff = level > partner ? level - partner : partner - level
  if (donorMode === DonorMode.Splashing) {
    const t = diff >> 2
    if (t === 0) return level
    return level > partner ? level - t : level + t
  }
  // Supported donor. Waterfall leg: empty receiver about to fall gets it all.
  if ((level === 0 || partner === 0) && receiverUnsupported) {
    return level > partner ? 0 : level + partner
  }
  // Deadbanded equalization
  if (diff <= LATERAL_DEADBAND) return level
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
