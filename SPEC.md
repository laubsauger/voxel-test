# SPEC.md — voxel sandbox

Source design: DESIGN.md (2026-07-02). Format: FORMAT.md.

## §G goal

Browser voxel sandbox: fully destructible suburban arena (terrain→player), structural physics, CA water, lockstep co-op 2-4. three.js WebGPU.

## §C constraints

- Stack: TypeScript, Vite, three.js WebGPURenderer + TSL, Jolt WASM.
- Desktop Chrome, WebGPU only. No WebGL fallback code.
- Voxel 10cm. Arena fixed ~205×205×77m (2048×2048×768 voxel space, 64×64×24 chunks). No streaming. (Expanded from 100×100×50m per user 2026-07-02 — B11.)
- Perf bar (raised 2026-07-02): calm scene 120fps on the dev machine (Apple Silicon) = headroom for weaker targets at 60. Destruction may dip, never hitch (B23 gates stay).
- Sandbox first. Combat shape deferred to post-M4 playtest.
- Visual bar: AAA aspiration. Real PBR textures (CC0: ambientcg.com, freepbr.com), quality lighting + atmosphere. Voxel geo ≠ excuse for flat look.
- UI bar: same AAA standard for ALL UI — menu, HUD, hotbar, crosshair, hit/damage feedback, overlays. Cohesive design system (type, spacing, motion, sound hooks). No programmer-art UI ever ships.
- Perf-critical sims GPU compute (TSL) or WASM. JS main thread = orchestration only.

## §I interfaces

- I.cmd: command `(tick, playerId, seq, op)`. Ops: dig, place, shoot, explode, move, spawn. Serializable.
- I.chunk: chunk store API. get/set voxel, stamp shape, dirty set, chunk states empty|uniform(mat)|dense(Uint8Array 32³).
- I.mat: material table. id byte → {colorRamp, strength, density, flags: flammable|floats|transparent}. 0=air. ~16 entries.
- I.vox: MagicaVoxel .vox import → voxel grid + material remap.
- I.jolt: Jolt WASM. Fixed 60Hz step, deterministic mode, single-thread. Bodies: world-static, dynamic islands, char capsule.
- I.net: signaling (WS, handshake only) + WebRTC DataChannel lockstep transport. Host peer = session owner.
- I.hash: sim state hash fn. Input: full sim state. Used by desync detector + determinism tests.
- I.boot: URL params control boot path. `?boot=game&seed=N` = bypass menu straight into scene (agents/CDP smoke, dev iteration). `?dev=1` = dev settings + profiling HUD on. Default = preloader → menu.
- I.settings: settings store. Graphics (quality tiers, post toggles), audio (master/music/sfx volume 0-100), controls, gameplay + dev section (profiling, debug draws, scene seed). Persist localStorage. Render-layer only, never sim state.
- I.audio: asset pipeline (node script, ElevenLabs API, key in .env.dev — NEVER committed/bundled/logged) → generated SFX+music in public/audio/ + manifest.json. Runtime: WebAudio engine, gain buses master→{music,sfx}, positional 3D SFX, surface-aware footsteps. Render layer (V6).
- I.box3d: Box3D — erincatto/box3d, C17, 3D, v0.1.0 (2026-06-30). Soft-step solver, CCD (continuous collision = tunneling defense), multi-shape/compound bodies. Web: Emscripten build, SSE2 WASM (or BOX3D_DISABLE_SIMD). NO prebuilt npm binding at v0.1 → we compile lib→WASM + author JS glue (T78). PRECISION: undocumented, Box2D-v3 lineage = single float, so user's "double-precision" pos claim likely FALSE — treat transforms as f32. b3dWorld (downward gravity, fixed 60Hz step + substeps), static box/compound colliders, dynamic bodies. Spike-only, NOT in main game.

## §V invariants

- V1: all sim mutations via I.cmd stream. No system writes voxel/physics/water state directly.
- V2: sim deterministic. Fixed 60Hz tick. Seeded PRNG only. Math.random/Date.now/performance.now banned in sim code.
- V3: same command log ⇒ same I.hash sequence. Replay test enforces.
- V4: GPU authoritative sims: integer math only, gather-only ping-pong, fixed dispatch order. No atomics, no floats.
- V5: voxel = 1 byte material id (I.mat). Chunk 32³. Sparse: empty|uniform|dense.
- V6: render layer never mutates sim state. Sim never reads render state.
- V7: remesh budgeted per frame. Big edit = amortized, no frame >33ms from meshing.
- V8: entity ids = deterministic counter in sim state. No UUIDs in sim.
- V9: water CA mass-conserving: total water integer sum constant absent source/sink ops.
- V10: desync/hash mismatch = loud error surfaced to user. Never silent divergence.
- V11: render interpolates between sim ticks. No sim stepping from rAF directly.
- V12: dynamic island bodies stay dynamic after settle. No re-weld v1.
- V13: single I.mat authority = src/sim/materials.ts. Other layers derive params by id, never redefine id assignments. Test enforces render/sim id agreement.
- V14: Box3D spike ISOLATED. Own boot path (I.boot ?boot=box3d-spike) + own scene/loop. Never imports Jolt sim, never writes I.cmd/sim state, never wired to lockstep/MP (I.net) or determinism harness (I.hash). Eval sandbox only. V1-V13 do NOT govern spike.
- V15: each dynamic b3dBody ↔ exactly 1 three.js mesh (1:1). After each physics step, mesh world transform == body transform (pos+orientation copied, no drift). Sync test: N bodies → N meshes, transforms match post-step.

## §T tasks

id|st|task|deps|cites
T1|x|[CORE] scaffold: vite+ts+three WebGPURenderer, rAF render loop, fly cam, flat test ground plane||§C
T2|x|[CORE] fixed-tick sim loop + I.cmd command queue + seeded PRNG|T1|V1,V2,V11
T3|x|[CORE] sparse chunk store (I.chunk) + GPU mirror upload|T1|V5
T4|x|[CORE] I.hash harness + replay determinism test|T2,T3|V3,V10
T5|x|[CORE] edit ops: sphere dig/place via commands, dirty tracking|T2,T3|V1,I.cmd
T6|x|[R] greedy mesher, CPU worker, per-chunk|T3|V7
T7|x|[R] voxel AO per-vertex in mesher|T6|
T8|x|[R] I.mat table + TSL PBR material, sun + CSM shadows, bloom|T6|I.mat
T9|x|[R] remesh scheduler: budget/frame, near-camera priority|T6|V7
T10|x|[P] Jolt WASM integration, fixed step in sim tick, world-static body|T2|I.jolt,V2
T11|x|[P] connectivity flood-fill worker, region-limited, deterministic order|T3,T5|V2
T12|x|[P] island extraction → dynamic body: mini grid + greedy-box compound collider + own mesh|T10,T11|V8,V12
T13|x|[P] explode op: sphere destroy + impulse to bodies|T5,T12|I.cmd
T14|x|[R] debris/dust particles on destroy (render-only)|T6|V6
T15|x|[W] water CA: integer level buffer, ping-pong TSL compute, solid blocking|T3,T4|V4,V9
T16|x|[W] water surface extract + TSL water shading (refract, depth absorb)|T15|
T17|x|[W] buoyancy: field readback → force on floats-flagged bodies|T15,T12|I.mat
T18|x|[C] .vox importer (I.vox) + material remap|T3|I.vox
T19|x|[C] proc suburb layout: streets, lots, terrain, pool placement, from seed|T3|V2
T20|x|[C] scene stamp: layout + .vox props → world, deterministic from seed|T18,T19|V2
T21|x|[PL] Jolt char controller capsule + FP camera + walk via move commands|T10|I.jolt,V1
T22|x|[PL] segmented voxel body: per-bone grids, damage removes voxels, segment-loss effects|T21|
T23|x|[PL] TP camera toggle + sphere-cast collision vs world|T21|
T24|x|[N] signaling server (WS) + WebRTC DataChannel pairing|T4|I.net
T25|x|[N] lockstep transport: input delay buffer 2-3 ticks, tick barrier|T24|V2,V3
T26|x|[N] join snapshot: serialize sim state, RLE chunks, fast-forward|T25|V3
T27|x|[N] desync detector: periodic hash exchange, loud fail|T25|V10
T28|x|[CORE] tool UX: hotbar dig/place/gun/explode, crosshair, hit feedback — AAA HUD styling per §C UI bar, shared design system with T33 menu|T5,T13|§C
T29|x|[R] PBR texture pipeline: CC0 sets (ambientcg/freepbr) per I.mat entry, triplanar TSL mapping (albedo/normal/rough/ao), texture array|T8|I.mat,§C
T30|x|[R] atmosphere polish: physical sky + sun disc + moon, voxel/block clouds (cute, drifting, seed-varied), height/distance fog, exposure tuning, SSAO/GTAO, TAA or SMAA, post stack within 60fps budget|T8|§C
T31|x|[UI] boot pipeline: preloader gate (WASM+assets+scene stamp+water fill done → then UI), I.boot URL params, dev bypass straight into scene||I.boot
T32|x|[UI] profiling from get-go: three r185 Inspector addon (three/addons/inspector/Inspector.js — NOT stats-gl) + renderer.info line, toggle via I.boot dev flag + I.settings dev section|T31|I.boot,I.settings
T33|x|[UI] main menu AAA: slick styled, live in-game scene as background (slow orbit cam over suburb), play/join/settings entries|T31,T20|§C,I.boot
T34|x|[UI] settings screens: graphics/audio/controls/gameplay + dev settings, I.settings store, localStorage persist, applies live|T33|I.settings,V6
T35|x|[R] draw-call batching: 2437 chunk meshes × CSM passes = 23fps settled. BatchedMesh or region merge + shadow pass reduction. Exit: settled suburb ≥60fps smoke gate|T9|§C,B2
T36|x|[A] SFX asset pipeline: ElevenLabs gen (I.audio) — footsteps×surface, shoot, impacts×material, explosions, water, ambience, UI, hurt. Rich AAA set, manifest|T31|I.audio,§C
T37|x|[A] runtime audio engine: WebAudio buses (master/music/sfx), positional SFX, footstep surface detect, event hooks from sim/render, volumes via I.settings|T36|I.audio,I.settings,V6
T38|x|[A] music: DESCOPED 2026-07-02 — user supplies own tracks. Placeholder ambient beds stay until replaced. Crossfade + music bus shipped, drop-in = replace public/audio/music/*.mp3 + manifest entries|T36|I.audio
T39|x|[R] transparency pass: second mesh pass per chunk for transparent mats (glass, water-solid), no cull vs transparent neighbors, sorted blend|T35|B5,I.mat
T40|x|[P] physics feel: density-true impulse response, per-material friction/restitution, max lin/ang velocity clamps, sleep tuning, kill plane despawn, buoyancy coupling (FloatingBodyAdapter per INTEGRATION-water.md §4)|T13,T17|B7,V2,V12
T41|x|[C] stairs: multi-story houses get interior stairs + floor openings, walkable slope for char controller|T20|B6
T42|x|[C] vegetation: trees (trunk+leaf canopy, MAT_LEAVES), shrubs, yard/parkway placement from seed|T20|B6,V2
T43|x|[C] street detail: road markings (id 15 = paint), fences, lamp posts (emissive), mailboxes, driveway/roof/palette variation — cute pass|T20|B6,V2
T44|x|[PL] sprint (input bit 64, speed mult) + functional crouch (capsule shrink, slow) — sim-side, deterministic move op|T21|V1,V2
T45|x|[PL] fly/spectator mode: quick toggle (F), free camera detached from player (render-only, lockstep-safe), speed tiers|T21|V6
T46|x|[PL] player visual detail: segment-based colors (skin/shirt/pants/shoes), better proportions, damage-visible voxel body|T22|§C
T47|x|[PL] noclip dev mode: 'noclip' toggle op, player skips collision + direct velocity integration, deterministic (command-driven), dev-gated in UI|T21|V1,V2
T50|x|[C] world expansion (B11): 2048×2048×768 world. Districts: suburban core (spawn), rowhouse/denser blocks, commercial+highrise (5-15 story towers: concrete/glass/metal, elevator shafts/stairwells), parks (ponds=water, paths, tree clusters), parking lots. Deep procgen variety, deterministic|T20|B11,V2,§C
T51|x|[C] house/lot detail (B11): interiors — rooms, interior doors, basic voxel furniture; garages, balconies, chimneys, varied rooflines; backyard variety|T50|B11,V2
T55|x|[P] explosion falloff zones (B14): core=vaporize, mid=voxels ejected as small debris bodies/ballistic ejecta (deterministic Prng-capped clumps) radiating from center, outer=loosened/cracked singles knocked free, shockwave impulse on bodies+ejecta, per-material scaling|T13|B14,V1,V2,V8
T56|.|[P] structural support heuristic: after edits, weak necks (small connection cross-section vs supported mass, per-material strength) break → collapse. Walls cave, undermined buildings crumble progressively. Region-scoped, deterministic, budgeted per tick|T55|B15,V1,V2
T57|-|[SPIKE] 5cm voxels: BENCHED 2026-07-02 by user — staying at 10cm (Teardown parity). Revisit only on explicit ask|T29,T30|§C
T58|x|[R] day/night cycle: time from sim.tick (deterministic, MP-synced free), sun/moon orbit driving CSM light + sky uniforms, dusk/dawn palettes, night = lamps/emissive carry the scene (+ a few real point lights budget-tested), cloud height variation + sky interest (B22), culling re-audit|T30|B22,§C
T59|x|[C] car upgrade: multiple voxel car archetypes (sedan/pickup/van), body colors, glass windows, metal trim, wheels — replace placeholder blobs|T20|B6
T60|.|[PL] player swimming: in-water detection, capsule buoyancy + drag, swim locomotion (deterministic), underwater camera tint/fog, splash events|T40|V1,V2
T61|.|[W] water visuals v2: animated surface normals/ripples (threejs-water-optics), fresnel + depth tint tuning, disturbance ripples, side-face rendering fix (B20), pool must read as WATER|T16|B20,§C
T62|.|[W] water CA v2: fix live mass loss/duplication (B21 — pool must drain when breached), lateral flow for falling water ('rolling' behavior, not pure up/down columns), faster settle|T15|B21,V9
T64|x|[V] drivable vehicles (GTA-like): cars become sim entities (voxel grid bodies, not world-stamped), enter/exit as driver/passenger (ops), Jolt VehicleConstraint driving physics (round physics wheels, voxel visuals), MUTUAL momentum-scaled crash damage — car dents AND obstacle breaks: through fences (weak), stopped by brick/concrete (strong), energy-budget vs I.mat strength, structural pass on vehicle damage; engine/skid/crash/horn SFX (ElevenLabs pipeline), camera modes, deterministic drive input op|T40,T55|B24,V1,V2,V8
T65|x|[UI] time-of-day controls: settings/dev slider for fixed time + cycle speed + pause, live apply via sky-cycle API|T58|B22,I.settings
T66|.|[P] hinge constraints: Jolt HingeConstraint wrapper — hinged voxel sub-bodies anchored to world/bodies (house doors, car doors, signs, crane arms), deterministic state, breakable hinges|T64|V1,V2,V8
T67|.|[C] power poles + wires: wooden poles along roads, catenary-sagging wires (organic, imperfect spans, slight lean/variation), destructible poles drop wire spans|T50|B6
T68|.|[C] hood district: rundown vibe — worn/boarded houses, chain-link fences, dumpsters, cracked asphalt+patches, faded paint, overgrown lots, corner store|T50|B6
T69|.|[C+R] beach/ocean district: arena edge becomes sand beach + boardwalk, shallow CA water surf zone, infinite ocean visual plane beyond arena (horizon), palms|T50|B6,V9
T70|x|[UI] map + minimap: Google-Maps-style styled map generated from layout data (roads/lots/districts/water/POI), minimap HUD w/ player arrow + heading, M = fullscreen pan/zoom map|T50|I.settings,§C
T76|x|[V] two-wheelers: bicycle (pedal power, balance-assist, chain/freewheel sounds) + delivery moto-scooter (uber-eats style topbox, moped engine) via Jolt MotorcycleController|T64|V1,V2
T77|.|[PL] ragdoll physics: Jolt Ragdoll from the 6 voxel segments — triggers on death, hard falls, vehicle hits, explosion impulse over threshold; blends back to animated on recovery (or stays on death), deterministic + hashed|T64|V1,V2,V8
T73|.|[W] weapons: rocket launcher (fast projectile, impact-detonated T55 explosion, backblast+trail FX, hotbar slot) + TNT (placeable block prop, interact-to-light fuse ~3s spark, BIG zoned boom, chainable), SFX via pipeline|T54,T55|V1,V2
T74|.|[R] birds: occasional small flocks — simple boid-ish sprite/voxel birds, lazy loops over the town, day-only, render-only|T58|B22
T75|.|[R] flashlight: toggleable spotlight (L), camera-anchored in FP, warm beam, night-useful, subtle battery-free v1|T58|§C
T71|x|[N] MP integration v1: menu host/join flow (room code lobby, player list), lockstep driver wired into game loop (net queue swaps local, tick barrier gates FixedStepDriver), combined desync hash (sim+physics+water via existing hash fns), desync overlay (V10), same-seed boot only — late join deferred|T25,T27|I.net,V2,V3,V10
T72|x|[N] 2-browser E2E harness: CDP script boots signaling + 2 Chromes, host+join, scripted inputs both sides, asserts synced hashes over N ticks + green desync detector — the real V3 proof|T71|V3,V10
T63|x|[R/P] destruction stutter (B23): profile dig/explode frame spikes via CDP tracing, then fix — incremental region updates, spread/defer Jolt shape rebuilds, buffer reuse, no main-thread hitches >4ms. Exit: scripted dig+bomb with frame-time capture, p99 frame <20ms during destruction|T35,T55|B23,V7,§C
T53|x|[R] destruction/combat VFX (B13): explosion = flash+fireball+radial debris (velocities FROM blast center)+smoke plume+dust ring; gun muzzle flash+tracer+impact fx by material; debris particle overhaul (impulse-centered emission)|T14|B13,V6,§C
T54|x|[P] projectile entities: thrown bomb = sim projectile (arc, bounce, fuse timer → explode at rest), deterministic. Visual: classic black round voxel bomb + fuse spark, trailed|T13|B13,B14,V1,V2
T52|x|[UI] audio wiring per INTEGRATION-audio.md (B9: engine init on gesture, listener sync, footstep poller, event hooks) + fullscreen setting & quick-access + mute quick-access in main/pause menus + ESC toggles pause closed (B10)|T34,T37|B9,B10,I.audio,I.settings
T48|x|[PL] procedural animation rig: render-side bone animation of voxel segments — walk/run cycles stride-matched to velocity (NO foot skating), idle sway, jump/fall/land, crouch pose, yaw/pitch aim. Sim segments stay authoritative for damage (V6)|T22,T46|§C,V6
T49|x|[PL] FP viewmodel: hands (+feet when looking down) visible in first person, equipped hotbar tool rendered in hand, FP anims (swing/dig, place, recoil, bob synced to stride)|T48,T28|§C,V6
T78|x|[SPIKE] Box3D WASM bridge + boot gate: build erincatto/box3d → WASM via Emscripten (SSE2 or BOX3D_DISABLE_SIMD), author JS glue (world/body/shape create, step, transform read). Confirm loads in Chrome. Init b3dWorld (downward gravity matching Jolt scale), fixed 60Hz step folded into existing rAF render loop (reuse WebGPURenderer + fly cam from T1, NOT sim FixedStepDriver). New I.boot path ?boot=box3d-spike, own scene module, no menu. Transforms f32 (precision undocumented)|T1|I.box3d,I.boot,V14
T79|x|[SPIKE] example level via existing voxel system: flat grid ground + 3-5 voxel houses. Reuse I.chunk store + T6 greedy mesher for VISUALS (own tiny voxel grids, not the suburb procgen). Static, hand-placed, deterministic-not-required|T78,T6|I.chunk,V14
T80|.|[SPIKE] voxel→Box3D static colliders: two mappings behind toggle — (a) per-solid-voxel b3dBoxShape, (b) greedy-box compound (reuse T12 greedy-box logic from island extraction). Ground + houses. Measure build cost + collider count each mode|T79|I.box3d,V14
T81|.|[SPIKE] dynamic drop spawner: rain b3dBody cubes/spheres from sky onto/around houses. Each body → 1 three.js mesh (own material, NOT sim island path). Key/HUD trigger to burst-spawn|T78|I.box3d,V15
T82|.|[SPIKE] state sync: after b3dWorld step, copy body pos+orientation → matching three.js mesh transform. No sim-tick interpolation (V11 not in scope — direct copy). Enforce V15 1:1|T81|I.box3d,V15
T83|.|[SPIKE] eval report: CDP smoke (?boot=box3d-spike) capturing the 3 questions — (1) voxel-edge contact snag/jitter, (2) tunneling of fast bodies vs thin voxel walls (Box3D CCD on vs off), (3) perf: frame cost under M bodies × N static colliders, per-mapping (T80 a vs b), substep behavior. Screenshots + frame-time trace → findings doc. NO 60fps gate (eval, not ship)|T80,T82|I.box3d,§C

Parallel plan: T1→(T2,T3)→T4,T5 serial-ish core. Then tracks fan out — R(T6-T9,T14), P(T10-T13), W(T15-T17), C(T18-T20), PL(T21-T23), N(T24-T27) run parallel where deps met. Subagents per track, worktree isolation for file-overlap safety.

## §B bugs

id|date|cause|fix
B1|2026-07-02|parallel track agents (C, R, P) each defined I.mat table, divergent id assignments (R: 3=sand,8=wood,11=metal; P: 3=stone,7=metal,9=flesh vs canonical 3=asphalt,6=wood,9=metal) — merge-time discovery, would have corrupted stamped worlds|V13; render derives from sim table; P merge kept canonical ids + P strength scale
B2|2026-07-02|per-chunk meshes: suburb = 2437 draws × (main + 3 CSM cascades) ≈ 10k draws/frame → 23fps settled, misses §C 60fps. Found by CDP smoke settle gate|T35 batching; smoke fps gate stays red until fixed
B3|2026-07-02|user smoke feedback: chunk mesh-in slow at load + visible pop-in when moving fast (12/frame dispatch+apply budgets conservative, priority near-camera only)|T35 scope extended: initial-load fast path + movement-directed prefetch + budget tuning
B4|2026-07-02|user smoke feedback: light leaks at roof/wall joins + wall/floor joins + wall corners (CSM bias/normalBias vs voxel-thin geometry)|T35 scope extended: shadow bias/normal-bias/cascade tuning to kill leaks
B6|2026-07-02|user feedback: scene sterile/meh — no stairs (upper floors unreachable), no vegetation, no road markings/fences/street detail|T41,T42,T43
B7|2026-07-02|user feedback risk: physics impulse feel must track material density (heavy=sluggish), bodies must never fly off to infinity|T40 velocity clamps + kill plane + feel tuning
B9|2026-07-02|audio engine never wired into game loop — user hears nothing (UI track branched pre-audio-merge, hookup fell between tracks)|T52
B10|2026-07-02|ESC opens pause but does not close it (nit)|T52
B11|2026-07-02|user: world too small + monotone — needs highrises, parks, deeper procedural variety; houses/lots need more detail incl. interiors|T50,T51
B12|2026-07-02|driveways/walkways render white+red checkered (paver pattern alternates brick+plaster — reads as bug not pavers)|T50 world agent fixes pattern
B13|2026-07-02|user: destruction/combat not immersive — no projectiles, no muzzle flash/smoke, bomb lacks explosion VFX, debris particles rain up/down instead of radiating from impulse center, no gun impact effects|T53,T54
B14|2026-07-02|explosion feels binary — voxels vanish or nothing (threshold shell). No graduated falloff, no ejecta ('yanked out' voxels), no shockwave feel. Bomb needs classic look: black round voxel bomb + fuse|T54,T55
B15|2026-07-02|wall pieces crumble then get STUCK MID-AIR, non-interactive — suspected: region-limited connectivity escape hatch marks floating fragments 'supported' at region boundary → stay in static world mesh|boom agent investigating; T56 follow-up
B16|2026-07-02|user: vaporize must not be default — bomb into wall should crumble it into persistent debris, minimal vaporization. Teardown model: most removed volume → debris bodies/particles|T55 emphasis shift
B17|2026-07-02|dynamic bodies opt out of interaction — dig/shoot raycasts test WORLD voxels only, never Jolt bodies: no impulse, no damage to debris/islands|boom agent: tool rays vs bodies + body-local voxel damage
B18|2026-07-02|impact particles: wrong origin (not at hit voxel), ignore surface normal + impact vector, always emit bottom-up|boom agent T53 requirement
B19|2026-07-02|spawn pool tiny 2x2 plunge + NO VISIBLE WATER. Spawn lot should be villa/mansion: garden, LARGE pool, pool house|world agent
B20|2026-07-02|water surface flickers/glitches when disturbed: visible transparent seams — side faces of water voxels missing/uncolored, see-through from the side. Surface extraction 'closed skin' not closed in practice|water agent
B21|2026-07-02|pool never drains despite outflow — mass conservation violated in practice (duplication somewhere: breach outflow runs forever, basin level static). CA unit tests conserve; live world does not|water agent CRITICAL
B22|2026-07-02|clouds too high + uniform height; sky still boring; static time of day means lamps never matter|T58
B23|2026-07-02|clear frame stutter on ANY destruction — even single shovel dig palpable. Suspects: region geometry rebuild (concat+upload on main thread), in-tick Jolt static shape rebuild, connectivity pass|T63
B24|2026-07-02|cars spawn partially inside houses (placement overlap); also user wants some cars ON roads, not all parked at home|T64 agent fixes placement + road cars
B25|2026-07-02|streetlights + car light bars glow in bright daylight — emissive must follow time-of-day|sky-cycle agent
B26|2026-07-02|WaterSurface re-extracts the ENTIRE pool surface on every dig anywhere (water-sim notifyVoxelChanged bumps version unconditionally) — 5.5-7.8ms/dig, found by T63 probe|water-v2 agent
B27|2026-07-02|asphalt/street footsteps sound weirdly metallic — regenerate toned-down asphalt (+concrete check) footstep set|polish agent
B28|2026-07-02|user perf concern: calm scene must hold 120fps on dev machine (weaker-machine headroom). Measure ONLY with agent queue drained (parallel agent Chrome/vitest load skews local fps). Budget audit: post-stack cost (GTAO/bloom), water surface, region draws, FX pools|perf wave after current agents land
B29|2026-07-02|fly mode exit teleports you back to where the body stayed — user wants body to follow flight + exit in place. Fix: F rides the noclip op (deterministic body flight, camera stays player FP) instead of the detached spectator cam; spectator remains for orbit only|coordinator at MP merge (game.ts owned)
B8|2026-07-02|flat walls show per-voxel diagonal shading noise reading as broken AO (screenshot evidence) — per-voxel color hash interpolates across voxel + triangle diagonal seams; true AO must be uniform on coplanar faces, darken only real edges/corners|render-quality agent: flat-per-voxel variation sampling (voxel-center hash, no in-voxel gradient), verify AO uniformity on flat walls, GTAO radius > voxel size
B5|2026-07-02|user smoke feedback: glass windows render opaque (known R-track v1 limitation, single opaque mesh pass)|T39

## §P polish + backlog (B37/B38 session, 2026-07)

Captured from live user review. status: x done · ~ partial · . todo. Sized S/M/L.

id|status|size|item|notes
P1|x|M|AO striping on walls/floors|per-voxel salt + half-res GTAO + stretched vertex-AO smeared coplanar faces. Fixed: full-res GTAO, vertex-AO floor 0.45→0.74, salt amp 0.4×. Verify shadow-side walls
P2|x|S|TOD gizmo restyle + marker on arc|bottom-left, small, subtle; sun/moon rides the semicircle by transit time
P3|x|S|fog never reaches world edge|FOG_FAR 720→330, FOG_MAX 0.38→0.92 — boundary dissolves into horizon, incl. flying up
P4|x|S|airport planes clip hangar / run off apron|rot-0 in runway-side strips, guarded, 0 overlaps
P5|x|S|trailers too short|body ~1.7→2.6 m
P6|x|S|trailer-park roads too clean/fancy|added jittered dirt tracks INSIDE; bordering arterial still wide+clean → make shoddy/narrow there too
P7|x|M|beach is ugly|road grid cuts through it; want dune terrain (value-noise sand height, analog to trailer-park terrain, beach biome), natural sand→water shoreline, no grid interruption
P8|x|S|airport interrupted by road grid + z-fighting|except airport district from the road grid; kill coplanar apron/foundation z-fight
P9|x|S|z-fighting on tower foundations|coplanar overlap outside highrises — depth offset / dedupe the slab
P10|x|M|water waves in pools ugly|too high-frequency, too dark, unnatural — lower freq, lighten, smoother surface
P11|x|M|disturbed water side faces glitch|displaced water voxels at differing heights show broken lines / missing side faces (skin not closed on height steps) — B20 follow-up
P12|x|S|first-person camera inside vehicles|toggle FP/chase while seated (currently chase only)
P13|x|M|some cars cannot be driven|subset of parked cars fail the enter/drive path — find + fix
P14|x|M|two-wheelers not in the world|bicycle/scooter are rideable archetypes (T76) but never placed as city props — models + scatter placement
P15|x|M|car vertical proportions compressed|raising the car grid broke crash crumple (grid height ⇄ vehicle collision) — needs a seat/collision-aware pass, not a naive grid bump
P17|x|L|flyable plane|aircraft flight controller — the parked airport planes become pilotable
P18|x|L|palette chunk compression|bit-packed palette store for COLD chunks (memory), keep active chunks flat (CPU-bound safe), lossless + deterministic — unlocks world >5-6×
P19|x|S|TNT (remote detonator) + rocket launcher missing from action hotbar|T73 authored but not wired to hotbar slots — add + fire path
P20|x|M|airport rework|no trees (done), wider runway + small Cessna planes + one ON the runway ready for takeoff (done); still need: verify NO grid rows on rebuild, flyable (→P17)
P21|x|M|farmhouse / hacienda on the outer nature rim|occasional large rural building type, distinct from suburb houses
P22|x|L|outer-rim blocks 2× size|bigger plots + half the intersections on the nature rim → more open, distinct from the dense city grid (grid/road-gen change)
P23|x|S|highrise variety|all towers identical — add ≥1 more facade/massing style (setbacks, brick+glass mix, different mullion/crown)
P24|x|S|input box less stylish than before|a text input lost styling (regression) — restore the nicer look
P25|x|S|bomb/explosion damage too weak on hard surfaces|highrises + roads barely dent — scale destruction or add power vs hard materials
P26|x|S|pistol muzzle black lines + black square|tracer/muzzle-flash renders as black lines (trajectory to impact) + a semi-opaque black square at the muzzle — VFX material/blend bug

## §P open (post-B37, remaining)

status: . todo. Everything else in §P is done (x). This is the live open list.

id|status|size|item|notes
P16|.|L|occlusion culling|LOW ROI: frame is CPU-bound on three.js ITERATING all objects to frustum-cull them; occlusion culling only cuts DRAWN objects, not that iteration. Marginal for our bottleneck. Deprioritized unless proven otherwise.
P27|x|M|anti-aliasing (no AA currently)|renderer antialias is bypassed by the post pipeline → hard edge aliasing + moiré on high-freq voxel/road detail, and the RESIDUAL tower-facade flicker is sub-pixel edge aliasing of the metal spandrels. GPU has headroom (CPU-bound), so FXAA/SMAA/TAA post pass is affordable. Add a final AA node to the RenderPipeline.
P28|x|S|verify P9 residuals live|tower foundation/ground z-fight should be gone (LOD-cell sink + recessed glass); confirm in-game across sun angles, close the loop.
