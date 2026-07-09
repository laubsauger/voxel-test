# INTEGRATION — water track (T15–T17, T60–T62)

Status: v3 — COLUMN HEIGHTFIELD (2026-07). Replaces the 3D per-voxel CA
(user verdict: "too intense for too little gain"). The GPU CA mirror
(`src/render/water/compute.ts`) was dead code and is deleted.

Files:

- `src/sim/water/rules.ts` — column rule spec (integer, sill/deadband/cap
  flow law) + the full fidelity-loss list. Single source of truth.
- `src/sim/water/water-sim.ts` — the sim: sparse per-chunk-column pages
  (Int32 mass + Int16 bottom per (x,z) column), budgeted wake set,
  source/sink API, `hashWater`/`hashWaterInto`, `attachWaterSim`.
- `src/sim/water/buoyancy.ts` — pure buoyancy solver (T17, unchanged).
- `src/render/water/surface.ts` — surface extraction + `WaterSurface` mesh
  (T16, unchanged — consumes synthesized 3D page views, see below).
- `src/render/water/material.ts` — TSL water material (T16, unchanged).

## 1. Model in one paragraph

One contiguous water span per (x,z) column: integer `bottom` voxel +
integer mass (255 units per voxel). `levelAt` returns 255 below the
surface, the partial remainder at the surface cell — bit-compatible with
the old CA for settled water, so extraction, buoyancy, swimming, and the
underwater overlay needed NO changes. Per step (2 steps/tick), awake
chunk-columns (budgeted + deterministically rotated, T92 pattern) run:
unsupported spans fall 1 voxel, then neighbor columns exchange mass through
the lowest open "sill" voxel (walls hold; a breached wall opens a sill and
the pool drains through it at up to FLOW_CAP — the B21 promise). Settled
water costs literally zero (step() early-returns; `workCount` proves it).

## 2. API compatibility (consumers, unchanged call sites)

- `attachWaterSim(sim)`, `WATER_STEPS_PER_TICK`, `WaterSim` — as before.
- `levelAt/addWater/removeWater/notifyVoxelChanged/totalMass/version/
  stepCount/activeChunkCount/isChunkAwake/drainRenderDirty` — same
  signatures + semantics. `notifyVoxelChanged` still returns displaced
  water when a cell turns solid; NEW: a block placed mid-span also releases
  the water beneath it (single-span representation) — the FULL removed
  amount is returned (reported sink, V9 accounting).
- `pageAt(ci)` / `forEachPage(cb)` — kept as SYNTHESIZED 3D views over the
  columns (fresh Uint8Array per call). Extraction output is identical for
  settled pools.
- NEW `forEachColumnPage(cb)` — raw column state in ascending key order;
  the hash and tests use it.
- Water hash layout CHANGED (combined hash callers unaffected —
  `hashWaterInto` signature same): stepCount + per chunk-column page
  key + m bytes + bottom bytes. ~6KB/page vs 32KB/chunk before.

## 3. Scene loading / pool filling (unchanged contract)

Bottom-up `addWater(x, y, z, 255)` box fills work exactly as before
(refuses solids, returns actual amount, clamps per cell). Fills land
pre-settled; pages go back to sleep after WAKE_TTL steps.

## 4. Buoyancy + swimming (unchanged)

`computeBuoyancy` samplers read `levelAt` — untouched. `attachBuoyancy`
wiring, `phys.water`, splash events, underwater overlay: all untouched.

## 5. Behavior notes & known artifacts (by design, tested)

- Mass: exactly conserved across steps (V9). Only reported sinks/sources
  change it; totals are bounded and can never grow silently.
- Residue films: adjacent settled columns may differ by ≤ SURFACE_DEADBAND
  (2/255 voxel). Draining leaves a damp gradient, not a leak.
- DROPPED fidelity (user-accepted, full list in rules.ts): airborne
  blobs/streams (transfers land directly on the receiving surface),
  stacked water bodies per column, water traveling UNDER a still-wet
  column (interior floor pinholes dip the level instead of emptying the
  pool; wall breaches and edge/crater floor breaches drain fully).
- No pressure/U-bend rule (unchanged from v2).
- Water at the world edge is walled in (no out-of-bounds leak).

## 6. Perf contract

- Settled water: zero work (workCount frozen — water-active test).
- Disturbances: WAKE_BUDGET=16 chunk-columns/step, each ≤1024 column
  updates — an order of magnitude cheaper than the old CA's 32³ voxel
  passes; mega-wakes rotate deterministically instead of stalling a tick.
- Surface extraction path unchanged (region-merged meshes, T94 budget).
