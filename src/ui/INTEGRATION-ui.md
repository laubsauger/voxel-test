# INTEGRATION-ui — UI track (T28, T31, T32, T33, T34 + T44/T45 input & camera UX)

## main.ts restructure (T31)

`src/main.ts` is now thin boot orchestration; ALL sim/render wiring moved to
`src/game.ts` (class `Game`, `Game.create()`):

1. **capability check** — `navigator.gpu` missing → `#fatal` overlay, throw (fail loud).
2. **preloader** (`src/ui/preloader.ts`) — real stages fed by `Game.create`'s
   `onStage` callback: `world` (layout+stamp+water fill) → `physics`
   (Jolt WASM + createPhysics + `registerShootOp`) → `renderer`
   (WebGPURenderer + WorldRenderer, loop starts) → `meshing`
   (gate: `chunks.pendingCount === 0` or 15 s cap).
3. **route** (`src/ui/boot-params.ts`, pure + unit-tested):
   - `?boot=game&seed=N` → straight into gameplay (CDP/agent smoke path;
     default seed **1337**). No pointer lock without a gesture → HUD shows a
     "click to take control" hint.
   - `?dev=1` → profiling overlay on (also toggleable via Dev settings).
   - default → main menu over the live orbiting scene.

Wiring order inside `Game.create` is byte-for-byte the old main.ts order
(V2): stamp → water attach → `onVoxelChanged` hook → pool fill →
`loadJolt`/`createPhysics` → WorldRenderer with
`dirtySource: () => phys.drainRemesh()` → BodyMeshes → WaterSurface → loop.

`scripts/smoke.mjs` navigates `/?boot=game&seed=1337`; all previous
assertions unchanged. `scripts/ui-shot.mjs` captures
preloader/menu/settings/game-hud PNGs into `smoke-artifacts/`.

## menu / game state flow (T33)

`Game.state`: `'orbit'` (cinematic camera circles the suburb center ~30 m
out with a slight height bob — menu backdrop) | `'play'` (PlayerCam fp/tp,
or fly). Transitions:

- menu **PLAY** → `game.enterPlay(defaultCam)` (pushes the spawn command
  once, via the shared seq allocator) + pointer lock + HUD show.
- pointer-lock lost while in play (Esc) → pause menu (resume / settings /
  quit-to-menu). **The sim keeps ticking while paused** (sandbox; lockstep
  later makes local pause moot anyway).
- quit-to-menu → `game.enterOrbit()` + main menu; the player capsule stays
  spawned in the sim.
- **F** toggles fly/spectator (T45): render-only free cam
  (`src/render/spectator-cam.ts`, WASD+QE, Shift fast); move commands are
  still sent every tick but with **empty input bits** so the capsule stays
  put and lockstep is untouched (V6). Tool raycasts originate from the
  active camera, so you can build/dig from the air. 'FLY' chip in the HUD.

## tools / commands (T28)

- Hotbar 1-4 / wheel: Dig `{dig r:4}`, Build `{place r:3 mat:4(concrete)}`
  (targets the face-adjacent voxel), Gun `{shoot origin+dir in meters}`,
  Bomb `{explode r:14 power:4}` at the ray hit. All pushed into `sim.queue`
  at `tick = sim.tick` — UI never mutates sim state (V1/V6).
- **seq**: `src/render/command-seq.ts` exposes `nextSeq()`; PlayerInput and
  the tool controller both use it → no `(playerId, seq)` collisions.
  Anything else that pushes commands for the local player MUST use it too.
- **shoot** (`src/sim/shoot-op.ts`, the only sim addition): DDA raycast
  (canonical Amanatides & Woo, exported) → `destroySphere(r=1.5, power=3)`
  → `damagePlayersSphere` → `phys.structuralPass` (same connectivity path
  as explode). Registered from `Game.create` after `createPhysics`.
- Hit feedback: crosshair kick + hitmarker on confirmed hit; damage
  vignette wired to `Game.onPlayerDamaged` (fires when any local player
  segment version increases — real hook, not a stub).

## settings contract (T34) — what the audio track reads

`src/ui/settings-store.ts` persists every leaf under localStorage key
`settings.<group>.<field>` as JSON:

- `settings.audio.master` / `settings.audio.music` / `settings.audio.sfx`
  — integers 0–100 (raw values like `"80"`). Written by the Audio settings
  tab; live-updated on slider input. Audio engine: read at boot + listen
  via its own `SettingsStore` instance or `storage` events.
- Other keys: `settings.graphics.quality` (`"low"|"medium"|"high"`),
  `settings.graphics.fov`, `settings.controls.sensitivity`,
  `settings.controls.invertY`, `settings.gameplay.camera` (`"fp"|"tp"`),
  `settings.dev.profiling`.
- Unknown keys are ignored; malformed/mistyped values fall back to
  defaults (migration-safe).

Live apply: quality preset → pixelRatio cap + shadow map size (live), fov →
camera (live), sensitivity/invertY → PlayerInput (live). **Bloom on/off is
baked into the WorldRenderer pipeline at construction** — quality changes
affecting bloom apply on next boot (render pipeline is owned by the perf
track; noted in the Graphics tab).

## profiling (T32)

three r185 built-in `Inspector` (`three/addons/inspector/Inspector.js`)
attached via `renderer.inspector`; because we attach after renderer init,
`inspector.init()` is called explicitly (otherwise its DOM never mounts).
Plus a small `renderer.info` panel (draws/tris/geoms/textures, sampled
post-render) and the legacy `#hud` stats line (kept for the smoke test,
visible only in dev mode).

## design system

"Demolition brief": smoked-glass panels over the live scene, safety-amber
accent (#ffb03c), hazard-stripe motif, bundled **Chakra Petch** (SIL OFL,
`public/fonts/`), expo-out motion. All styles in `src/ui/style.css`.
Title **BLOCKBURB** is a placeholder working title.

## open issues

- Bloom toggle not live (see above) — revisit after T35 render refactor.
- Pause does not freeze the sim (documented above).
- JOIN GAME menu entry is a disabled placeholder ('SOON') — session UI is a
  later task; net layer exists.
- Player body damage → screen flash works, but there is no death/respawn
  flow yet.
- `?dev=1` Inspector + hud line verified error-free in headless Chrome;
  smoke fps gate stays red until T35 (B2).
