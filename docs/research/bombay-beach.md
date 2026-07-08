# BOMBAY BEACH + SALTON SEA SLICE — Design Research Document

**Target:** new zone for the voxel world (deterministic procgen, 0.1 m voxels, chunk 32³). Feeds directly into SPEC. All real-world numbers below are OSM/USGS-derived unless flagged; game numbers are in meters and voxels (1 m = 10 vox).

---

## 1. GROUND TRUTH — the real place

### 1.1 Street grid (measured from OSM, independently verified)

Cardinal-aligned grid (NOT rotated; E-W streets bear ~90.1°, N-S avenues ~0°). Core footprint **795.8 m E-W × ~594 m N-S** between outermost centerlines; residential landuse polygon **822 × 623 m**. Town sits at **-68 m (-223 ft)**, lowest community in the US.

**E-W streets (5), each ~795–800 m long** *(verified; "each 795.7 m" hides ~1–6 m spread)*:
| Pair | Spacing (centerline) |
|---|---|
| 1st – 2nd | 101.3 m (dirt alley mid-block, 46.9 / 54.4 m from streets) |
| 2nd – 3rd | 97.5 m (dirt alley mid-block, 52.5 / 45.0 m from streets) |
| 3rd – 4th | 201.7 m (no alley — double-deep block) |
| 4th – 5th | ~194–197 m (no alley; position-dependent, 5th bends) |

**N-S roads (9), west→east:** Avenue A, B, C, D, **"E Street"** (quirk: no "Avenue E" exists), F, G, H, **Aisle of Palms** (eastern edge). Spacing ~100 m uniform (A-B 102.0, B-C 98.1, C–H ≈100.0–100.8), final H–Aisle of Palms gap **93.5 m**.

**Sea relation:** shoreline/berm cuts diagonally NW-SE across the SW corner. 5th Street is the only bent street (bends 111.4°→90.1° west-to-east). Avenue B, C, and E Street dead-end **93.8 / 82.2 / 110.4 m** south of 5th toward the berm *(corrected from 97/86/114)*. E Street stub is the longest = the beach-access crossing.

**Entrance:** exactly ONE junction with the outside world — Avenue A meets CA-111 at 33.35764, -115.73398. **375 m of open desert spur** from highway to 1st Street; 967 m highway-to-berm total. Approach descends ~1% (highway -194 ft → town -216 ft → playa -227 ft): the town sits visibly *below* the highway.

**⚠ CORRECTED (verification found the original claim wrong):** CA-111 locally bears **~231–268°** past the town (it bends around the shoreline bulge; ~293° only holds 3–8 km away). The UP Yuma Subdivision railway is **single-track with passing sidings** here (Bertram siding MP 646.1), *not* double-track, and sits on the highway's inland (N/NNW) side — the town spur never crosses the tracks.

**Surfaces:** all named streets asphalt except 2nd Street (untagged) and the two alleys (dirt). *(Inferred, treat as directive:)* render all "asphalt" as old cracked, sand-blown asphalt; alleys as dirt.

### 1.2 The berm

- Earthen flood dike, built after tropical storms Kathleen (1976) / Doris (1977) drowned the eastern third of town. Wraps the entire seaward side, roughly along/past 5th Street on the NW-SE diagonal.
- **Dims (INFERRED — no published engineering source):** trapezoidal, **3–6 m above street grade**, flat drivable crest **4–6 m wide** (dirt/gravel two-track), gentle dirt/riprap faces. Ramp crossings at street ends (Ave C and E Street are the ones visitors use).
- **The critical level-design fact (sourced):** from inside town the berm **completely blocks any view of the water**. You climb it and the dead sea reveals itself — and today you look *down*: the sea surface (-240.85 ft NAVD88, Sept 2025) is now ~15–18 ft **below** town grade. *(Datum caveat: 2018→2025 drop is ~7.1 ft in a consistent datum; "10+ ft in two decades" holds.)*

### 1.3 Beach zone (berm → waterline)

- Berm-to-waterline walk: **~300–500 m and growing** *(inferred from recession rates: ~40 ft/yr 2002–2017, ~120 ft/yr 2017–2020)*.
- Surface is **not sand**: pulverized tilapia bone, scales, otoliths, barnacle shell over salt crust over cracked mud — bleached white-tan, crunches "like a bowl of broken porcelain." Near ruins: dried mud hummocks; half-buried trailers (one famously tipped ~45°), salt-crusted debris, rebar, dead trees, salt-rimed pier piling stumps marching toward the water, a derelict dock off E Street.
- ~6 collapsed beach houses (only ~1 substantially intact as of 2025).

### 1.4 The sea

- Color: flat metallic grey-green, "flat as hammered tin — glares, doesn't sparkle." Algae-bloom states shift pea-green → red-brown → dull brown. Foam lines of salt scum at the edge. Golden hour: dead-calm mirror.
- Salinity 68,000–86,000 mg/L (~2× Pacific). Year-round H₂S rotten-egg smell (lore/audio hook, not visual).
- Far shore mostly dissolves in milky haze; purple mountain silhouettes at dusk.

### 1.5 Landmark inventory + placements

**In-grid (real coordinates):**
| Landmark | Location | Notes |
|---|---|---|
| **Ski Inn** | 9596 Avenue A (33.3536, -115.7335), near entrance | Only bar/restaurant; "lowest bar in the Western Hemisphere." Single-story, ~10×15 m, tan/beige + dark brown trim, flat roof, swamp cooler, painted SKI INN lettering + freestanding pole sign *(exterior details inferred from photos)*. Interior: thousands of signed dollar bills on every surface, jukebox, pool table, diner counter |
| Bombay Market | 9592 Avenue A (33.3526, -115.7337) | convenience store |
| Niland Fire Station 2 | 2188 3rd St (33.3527, -115.7330) | volunteer, tiny |
| American Legion Post 801 | 2108 1st St NE corner (33.3548, -115.7258) | the "other bar," 2 parking lots, fenced |
| Seaside Baptist Church | 9558 Avenue H (33.3504, -115.7259) | |
| Community Cafe / Arts & Culture | 2159 2nd St (33.3531, -115.7304) | |
| Comms mast + 3 satellite dishes | near Ave A / 2nd (33.3531, -115.7332) | |
| **Bombay Beach Drive-In** | 9575 Avenue E (~33.3517, -115.7299), south end near 5th/berm | rows of rusted wheel-less vintage cars facing a white semi-trailer as screen |
| **Opera House** | in-grid trailer conversion | sky-blue/cerulean (#3E7FBF-ish), facade of thousands of flip-flops laid like bricks, doors open into a stage |
| **Bombay Beach TVs** | lot at 4th Street | 60+ TVs each painted a different vibrant color, stacked haphazardly |
| Bombay Beach Estates | Ave F–G / 5th St | block of 6+ abandoned structures as walk-through art |
| Da Vinci Fish sculpture | 33.3532, -115.7305 | kinetic, 40 ft long / 44 ft wingspan |

**On the beach (past berm):**
- **Swing set** ("The Water Ain't That Bad, It's Just Salty," 2019) — installed 50 ft *into* the water, now stranded far up the dry playa; a deliberate recession marker. THE postcard image.
- **Lodestar** — 1940s Lockheed Lodestar aircraft tipped nose-down on steel legs, ~15 m tall, glass flowers at the cockpit, pink LED at night, climbable.
- "The only other thing is nothing" metal text sign; concrete star wrapped in barbed wire (off Ave C crossing); driftwood pirate ship; painted crash boat; drive-through of dead fountain (waterline reached it in 2011).
- **⚠ NO dinosaur/mammoth:** the famous rusted prehistoric sculptures are at Borrego Springs, not here. Use generic rusted-scrap creatures instead.

### 1.6 Building stock

- 2020 census: 231 residents; **369 housing units, 132 occupied (35.8%)**. Game mix: **~35% tidy/lived-in, ~40% vacant-but-standing (graffiti husks), ~25% ruin (collapsed/burned/stripped)**.
- 377 OSM footprints: median 108 m², mean 125 m², p10 50 m², p90 220 m² — trailer scale. Overwhelmingly single-wides and vintage travel trailers; a handful of CMU/stucco bungalows; very few double-wides.
- Real dims: single-wide 4.3 × 18–24 m; vintage trailer 2.4–3 × 8–15 m; lots **15.2 × 30.5 m (50×100 ft)**, two lot rows backing onto each alley, 6–7 lots per 100 m block face *(lot size inferred from plat + alley offsets)*.
- Dressing: aluminum carport awnings, ramadas, add-on porches, chain-link + scrap/pallet fences, rooftop swamp coolers, water tanks, dead cars/boats in yards, no paved driveways.

### 1.7 Palette (proposed hex, tune in-engine)

**Rule: 80% bleached neutrals / 15% rust-decay browns / 5% shockingly saturated art color.**
- Sky: #A8C4D4 dusty blue; horizon haze band #E8DCC8; golden hour #FFB65C→#FF8E4D; dusk #E7A0B4→#7E6E9C.
- Ground: playa #EDE8DC (crust highlight #F7F4EA), cracked mud #C9B08A / #8A7458, dirt/berm #B59B72, waterline scum #D8CBA6.
- Water: murky grey-green #8FA48E; bloom state #7A3B2E; golden-hour mirror reflecting sky.
- Built: chalked trailer white #E5DED2, seafoam #6FB5AE/#9CCFC4, opera-house blue #3E7FBF, rust #B4552D/#7A3B24 with streaks #8E5A3A, bleached wood #A79B87, galv metal #9AA0A3. Art pops: #E63946, #F4C430, #2EC4B6, #FF6FB5.

---

## 2. SCALE MAPPING — real → game

### 2.1 World-size decision (from repo analysis)

Real town+beach ≈ 800×600 m town + 300–500 m playa — larger than the *entire* current 512 m world (WORLD_CX=160, `src/world/chunks.ts:12-24`). 

**RECOMMENDED: bump WORLD_CX/CZ 160 → 256 (819.2 m square).** Costs (measured/derived in repo analysis):
- ~1.57 M chunk headers (~150 MB JS overhead); dense store ~3.1 GB transient at boot → ~0.5–1 GB after palette compaction. **Hard requirement: wire `compactStep` (chunks.ts:358-374) into the boot stamp loop** — currently background-only; boot peak memory is the one real engineering risk.
- Boot stamp time ×2.56. Steady-state frame cost ≈ zero (physics/render/LOD all radius-bounded: physics.ts:179-191, chunk-mesh-manager.ts:100, lod-manager.ts:30-42). Minimap fidelity drops 0.8→0.5 px/voxel (auto-fits, map-math.ts:11-38).
- **Avoid CX≥320** (~4.9 GB uncompressed).
- **Fallback if WP0 slips:** keep CX=160, compress Bombay to ~0.3× into the 2×2 park rim blocks south of the desert corner (bi 6-7, bj 2-3). Ships today, reads as a diorama.

At CX=256: 13 road centers after P22 thinning → **BLOCKS=12**; existing desert trailer park lands at **bi∈{10,11}, bj∈{0,1}** (NE corner, rule layout.ts:615).

### 2.2 Zone placement & attachment

Claim an east-rim region **directly south of the desert trailer park** so the desert becomes Bombay's approach frame:

- **Town grid:** bi∈{9,10}, bj∈{2..5} → ~166 m wide × ~333 m tall of block area.
- **Berm + playa + sea:** bi=11 column for all bj∈{2..5} PLUS the east GRID_MARGIN (24 m) → ~107 m of shore depth, **east-facing** (berm runs N-S along the world's east edge, slightly skewed/jittered to echo the real NW-SE diagonal).
- **Approach:** the existing world road bordering bj=1/2 plays CA-111; the desert corner's B37 dirt tracks + a stamped rail line (cosmetic) on its far side complete the picture. Roads span the full world (layout.ts:549-580), so the zone is automatically road-connected — no plumbing.
- Graft points: extend `DistrictKind` union (layout.ts:61), add rule in `districtKindAt` (layout.ts:608-619), new `makeBombay()` layout emitter, new `stampBombay()` appended to the fixed stamp order **after roads** (like beach/desert/airport, stamper.ts:1487-1492) so its surfaces overwrite the city grid. Add a `map-style.ts` entry (falls back safely without one, map-style.ts:77).

### 2.3 Compression table (anisotropic: streets compress, props stay 1:1)

Principle: **trailers, cars, people-scale props at true scale; block pitch and counts compress.** E-W ≈0.3×, N-S ≈0.5× with double-blocks halved.

| Real | Game | Voxels |
|---|---|---|
| 9 avenues @ ~100 m pitch (800 m) | 6 avenues @ 30 m pitch (A, B, C, E St, F, Aisle of Palms — keep the "no Avenue E" quirk) → 150 m + margins ≈ 166 m | pitch 300 vox |
| 5 streets, 101/98/202/195 m gaps | 5 streets @ 50/50/60/60 m gaps → 220 m + spur | gaps 500/500/600/600 vox |
| 2 dirt alleys mid-block | 2 alleys mid-block between 1st-2nd and 2nd-3rd | 25 m offset = 250 vox |
| Street width ~7 m asphalt | 5 m cracked asphalt + 1 m sand verge each side | 50 vox + 10 vox |
| Ave A spur, 375 m | 60–80 m open desert spur from frame road to 1st St | 600–800 vox |
| Lot 15.2 × 30.5 m | 8 × 15 m, 3–4 lots per block face | 80 × 150 vox |
| Trailer 4.3 × 18 m single-wide | keep existing 5.6 × 2.8 m stamp + add 8.4 × 3.2 m long variant | 56×28 / 84×32 vox |
| Berm 3–6 m high, 4–6 m crest | 4 m high, 5 m crest, ~14 m base | h 40, crest 50, base 140 vox |
| Playa 300–500 m | 60–80 m berm-to-waterline | 600–800 vox |
| Town 3 m below highway grade | 2–3 m gentle fall from frame road to berm foot | 20–30 vox over zone |
| Sea below town grade | water surface **1–2 m below town street level** (you look DOWN from the berm) | -10 to -20 vox |
| ~369 structures | ~60–80 structures at mix 35/40/25 | — |

---

## 3. GENERATION PLAN — work packages

**Dependency shape:** WP0 → WP-L (layout contract) → everything else in parallel. WP1 (materials) only needs its ID reservations merged first (one-line table rows, materials.ts:46-83; coordinate via `src/sim/gen/INTEGRATION-content.md`). 239 free material ids exist.

### WP0 — World resize + boot compaction *(serial prerequisite)*
- **Does:** WORLD_CX/CZ 160→256 (chunks.ts:12-24); call `compactStep` aggressively during/after `stampTerrain`; verify spawn/roads/minimap auto-derive (they do: layout.ts:418-449, map-math.ts:11-38).
- **New code:** boot compaction loop; nothing else.
- **Accept:** boots in browser tab without OOM; heap steady-state ≤ ~1.5 GB; all existing districts render; existing P22 parity invariant holds (odd road count).

### WP-L — Bombay layout contract *(serial, small; unblocks WP2–WP9)*
- **Does:** `DistrictKind` 'bombay' + 'bombayBeach'; `districtKindAt` rules per §2.2; `makeBombay()` emitting typed Layout entries (streets, alleys, lots+condition enum {lived, vacant, burned, collapsed}, landmarks, berm polyline, playa extent, art-prop list) from the world seed.
- **Reuse:** DesertPlot/Trailer interfaces (layout.ts:272-284), jittered-grid placement pattern (layout.ts:1111-1130).
- **Accept:** deterministic across reloads for fixed seed; lot condition histogram = 35/40/25 ±5%; map opens without crash (fallback style ok).

### WP1 — Materials & palette *(parallel)*
- **Does:** new material rows: `MAT_SALT_CRUST` (#EDE8DC ramp→#F7F4EA), `MAT_PLAYA_MUD` (#C9B08A/#8A7458), `MAT_RUST` (#B4552D→#7A3B24 ramp), `MAT_CHAR`, `MAT_BONE_SHELL` speckle, `MAT_CRACKED_ASPHALT`, `MAT_GALV_METAL`, opera-blue + 3–4 art-pop colors. colorRamp gives free per-voxel variation.
- **Reuse:** materials.ts table (render/physics derive automatically).
- **Accept:** all ids registered in INTEGRATION-content.md; palette rule holds in a test stamp (≥80% of surface voxels in bleached-neutral band).

### WP2 — Terrain, berm, playa, sea *(parallel)*
- **Does:** gentle 2–3 m seaward slope across zone; trapezoidal berm ridge (noise-jittered crest line, 40 vox high, 50 vox crest) with 3 ramp cut-throughs (Ave C, E St = widest, Aisle of Palms end); playa: salt-crust surface + cracked-mud patches + bone-shell speckle band near old waterline; second inland-sea waterFill east of playa, surface 10–20 vox below town grade, grey-green.
- **Reuse:** valueNoise dune technique (stamper.ts:1041-1056, 1092-1136); Beach/ocean waterfill pattern (stamper.ts:1005-1033, 1515); water-sim is page-sparse (fine).
- **New:** berm stamper (~30 lines of noise-height fillBox runs); **east-facing generalization of stampBeach** (axis parameter — the one flagged refactor).
- **Accept:** from any town street the water is invisible; from berm crest the full playa+sea is visible; player and vehicles can cross ramps; sea never floods over the berm (CA sanity).

### WP3 — Street grid, alleys, spur *(parallel)*
- **Does:** 6 N-S + 5 E-W cracked-asphalt streets per §2.3 grid, 2 dirt alleys, dirt dead-end stubs of Ave B/C/E-St past 5th toward the berm (10/8/11 m), the Ave A spur to the frame road, 5th Street with a slight bend, sand drift patches over asphalt edges.
- **Reuse:** B37 ragged `track()` (stamper.ts:1107-1128) per street line; `stampShoddyDesertRoads` degradation (stamper.ts:1147-1165) verbatim on the frame.
- **New:** cracked-asphalt street stamp (asphalt base + hash-dropped patches → MAT_PLAYA_MUD/sand showing through; ~40 lines).
- **Accept:** every lot reachable by road; exactly one connection into the world grid reads as "the entrance"; 2nd St + alleys are dirt; no street renders as clean city asphalt.

### WP4 — Mobile-home variants *(parallel; biggest content WP)*
- **Does:** parameterize `stampTrailer` with condition:
  - **lived-in (35%):** intact + carport awning, porch, chain-link or pallet fence, swamp cooler, water tank, parked sedan/pickup (existing props), string lights optional;
  - **vacant (40%):** hash-dropped windows/door voxels, graffiti color patches on walls, sand drift at base, junk scatter;
  - **burned (~10%):** MAT_CHAR shell, partial roof collapse;
  - **collapsed (~15%):** half-height rubble box + rust/wood debris.
  - Plus the long single-wide (84×32 vox) and 2–3 CMU bungalow footprints.
- **Reuse:** stampTrailer (stamper.ts:1060-1089); ragged-shell voxel-drop pattern (stamper.ts:1342-1343, ~37% outer-shell drop); FenceLine (layout.ts:348-353); props.ts vehicles/sheds.
- **New:** ~60–100 lines of condition parameterization; new prop grids: wrecked/wheel-less car (rust ramp over existing sedan grid), boat hulk.
- **Accept:** 20-seed sweep shows all 4 conditions on every block; no two adjacent lots identical (jitter on tint+rotation+addon set); graffiti chroma only on vacant/ruin walls.

### WP5 — Ski Inn + civic strip *(parallel)*
- **Does:** Ski Inn on Ave A near entrance: ~10×8 m (100×80 vox) single-story, tan + brown trim, flat roof + swamp cooler, "SKI INN" voxel lettering, freestanding pole sign; interior: bar counter, stools/tables, jukebox block, pool table, dollar-bill wall material (cream speckle). Nearby: Bombay Market (small store), fire station (1-bay garage), American Legion on 1st (fenced, 2 gravel lots), small church with cross at far avenue, comms mast + 3 dishes.
- **Reuse:** perimeter walls + `wallOpening` (stamper.ts:299), partitions + furniture placement (layout.ts:731-836), counter/table/chair props (PROP_DIMS layout.ts:496-508).
- **New:** ~100-line Ski Inn stamper; pole-sign prop; small variants of existing building shells.
- **Accept:** player can walk in the Ski Inn door, around the bar, back out; sign readable from the entrance spur; all civic buildings on the correct streets per §1.5.

### WP6 — Art installations *(parallel)*
- **Does:**
  - **Drive-In** (south end of E St at the berm): 2 rows × 4 wheel-less rust-ramp cars facing a white box-trailer screen;
  - **Opera House:** trailer conversion in #3E7FBF with multicolor 2-vox speckle facade (flip-flop read), doors-open stage front;
  - **TV wall** (lot at 4th St): 20–40 stacked boxes, each a random saturated tint with a dark screen face;
  - **Da Vinci Fish** (near 2nd/E-St): 12 m rusted fish skeleton on a pole;
  - misc: "The only other thing is nothing" text sign, concrete star + barbed wire near Ave C ramp, painted-TV clusters, generic rusted-scrap creature (explicitly NOT a Breceda dinosaur).
- **Reuse:** props.ts code-built VoxelGrid pattern (or .vox pipeline via src/sim/vox/remap.ts).
- **New:** ~6–8 prop grids; all small.
- **Accept:** drive-in/opera house/TVs each identifiable in a blind screenshot at 30 m; art chroma budget ≤5% of visible zone voxels from berm crest.

### WP7 — Beach ruins + swing set *(parallel; depends on WP2 heights only)*
- **Does:** on the playa: **swing set** ~50–60 m out from the berm, alone (mid-playa, nowhere near today's water — it's the recession marker); 5–6 half-buried tilted trailers/house ruins (one at ~45°) within 30 m of the berm foot; row of salt-rimed piling stumps running toward the water off E-St axis; derelict dock frame; **Lodestar** nose-down plane sculpture (12–15 m tall — reuse/re-skin the Cessna grid from stampPlane, stamper.ts:1171+, rust+glass-flower tip); fish-skeleton speckle band + boat hulk near the waterline; salt scum line at water's edge.
- **Reuse:** partial box stamp + sand overfill technique; ragged-shell drop; existing plane grid.
- **New:** half-buried stamp helper (box stamp clipped by playa surface + overfill; small); piling-row stamper (trivial).
- **Accept:** cresting the berm at the E-St ramp frames swing set → pilings → sea in one view; every ruin partially below playa surface (no floating boxes); walkable to the waterline without collision holes.

### WP8 — Desert approach + rail frame *(parallel, lowest priority)*
- **Does:** dress the existing NE desert corner as the approach: "Welcome to Bombay Beach" sign at the spur junction, leaning utility-pole line down Ave A spur and through town, faded billboard ("The Last Resort"), sparse creosote scrub (0.5–2 m olive shrubs, large bare gaps) on tan sand, cosmetic single-track rail line + poles along the zone's outer frame road far side *(single-track — verified correction)*.
- **Reuse:** stampDesert (stamper.ts:1092-1136), B37 dirt tracks, fence/pole patterns.
- **New:** rail stamp (2 rails + ties, cosmetic, ~30 lines), shrub prop, billboard prop, sign prop.
- **Accept:** approaching on the frame road, sequence reads: rail/desert → sign → spur → town below → berm wall on the horizon.

### WP9 — Map style + polish *(parallel, small)*
- **Does:** map-style.ts entries for 'bombay' (sun-bleached paper tone) and 'bombayBeach' (salt-white with water edge); district label; optional: warm-tinted dusk haze / milky noon haze tuning over the zone (ties into existing TOD gizmo).
- **Accept:** minimap shows grid + berm line + sea; no fallback-label rendering.

---

## 4. VIBE CHECKLIST — ranked, the zone fails if these don't land

1. **The berm reveal** — water fully hidden inside town; climb 4 m of dirt and the dead sea appears *below* you across empty white playa. The core level-design beat.
2. **Half-buried tilted trailers** beyond the berm, one at ~45°, salt-crusted. The most photographed motif.
3. **Lone swing set** stranded mid-playa, far from the water it was built in.
4. **The 80/15/5 palette contrast** — bleached bone neutrals everywhere, rust streaks, then sudden full-chroma art. If the whole zone is colorful, it's wrong.
5. **Bombay Beach TVs** — the stacked multicolor TV lot (pure voxel gold).
6. **Drive-In** — rusted car grid facing a white trailer screen at the berm foot.
7. **Graffiti'd windowless husks** alternating with tidy lived-in lots on the same street — the 35/40/25 mix must be visibly interleaved, not zoned.
8. **Ski Inn** glowing at the entrance strip — the one warm, alive interior.
9. **Bone-white beach detail** — fish-skeleton speckle, salt-rimed piling stumps, scum line; ground that reads as *remains*, not sand.
10. **Connective tissue** — cracked sand-blown asphalt, leaning power poles, chain-link, dirt alleys, faded billboard. The ordinary decay that makes the weird stuff land.

**Lighting note for the eventual atmosphere pass:** milky-grey haze at noon (far shore dissolves), warm haze-fattened flare at golden hour with mirror water, purple mountain silhouettes at dusk. The Salton basin never has a crisp horizon.

---
*Sources: OSM extract bbox -115.740,33.346,-115.723,33.357 (cached at /private/tmp/claude-501/-Users-flo-work-code-voxel-test/b534ba42-4dac-4504-b1ae-d92be01ca6b3/scratchpad/bb_map.osm, bb_ways.json), USGS EPQS + gage 10254005, Wikipedia/Biennale/press per input briefs; repo facts from src/world/chunks.ts, src/sim/gen/layout.ts, src/sim/gen/stamper.ts, src/sim/gen/props.ts, src/sim/materials.ts. Verification corrections applied: CA-111 local bearing, single-track rail, dead-end stub lengths, datum-consistent sea-level drop.*