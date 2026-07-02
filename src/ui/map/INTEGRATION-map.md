# INTEGRATION — T70 map + minimap (src/ui/map/**)

Owner: map track. Nothing outside `src/ui/map/**` + `tests/map-*.test.ts` was
touched — the coordinator wires main.ts as below.

## What ships

- `MapSystem` (map-system.ts) — the only class the coordinator needs.
  - Base map: generated ONCE at boot from the layout into an offscreen canvas
    (pure draw-command list, deterministic, unit-tested; no per-frame redraw).
  - Minimap: bottom-right glass widget, 140 px, north-up ~60 m view, amber
    player chevron rotating with yaw, blit every other frame.
  - Fullscreen map: dark-glass sheet, pan (drag) + zoom (wheel at cursor),
    player marker + amber view cone, scale bar, live coords, seed readout.

## Wiring (3 lines + 1 handler edit in main.ts)

```ts
import { MapSystem } from './ui/map/map-system'
import { WORLD_VX, WORLD_VZ } from './world/chunks'

// 1 — construction (after Game.create; `layout` is generateLayout(boot.seed) —
//     Game currently keeps it local, either re-generate (pure fn of seed,
//     cheap) or expose game.layout):
const map = new MapSystem(generateLayout(boot.seed), { vx: WORLD_VX, vz: WORLD_VZ })
map.attach(root)

// 2 — per-frame update (inside the existing game.addFrameHook callback;
//     px/pz are METERS, yaw radians — the sim player state):
const mp = game.phys.players.get(LOCAL_PLAYER)
if (mp) map.update(mp.px, mp.pz, mp.yaw)

// 3 — M key toggle (same pattern as the KeyN noclip binding):
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && game.state === 'play' && !settings.visible) map.toggleFullscreen()
})
```

### REQUIRED: pointerlockchange consult (1-line condition edit)

Opening the fullscreen map while pointer-locked calls
`document.exitPointerLock()` so the mouse can pan/zoom. main.ts's
`pointerlockchange` handler currently treats any unlock in play as "show
pause". Add `!map.isOpen` to that condition:

```ts
// main.ts pointerlockchange handler, last line:
if (game.state === 'play' && !settings.visible && settingsReturn === null && !map.isOpen) pause.show()
```

### ESC behavior (no main.ts change needed)

`MapSystem.attach()` installs a **capture-phase** document keydown listener:
when the map is open, Escape closes the map and calls
`stopImmediatePropagation()` + `preventDefault()`, so main.ts's bubble-phase
Esc handler (pause resume, B10) never fires for that press. When the map is
closed the listener is a no-op — the pause logic is untouched.

### Optional niceties

- `map.onClose = () => { if (game.state === 'play' && !pause.visible) lock() }`
  — re-grab pointer lock when the map closes mid-play (otherwise the click
  hint path recovers, same as the U-unlock flow).
- `map.setVisible(on)` — hide the minimap in menu/orbit: call
  `map.setVisible(true)` in `startPlay()` and `map.setVisible(false)` in
  `quitToMenu()`. Also force-closes the fullscreen map. Default: visible.
- Pause menu: M works there too (game.state stays 'play' while paused); the
  map renders above the pause glass. Nothing to wire.

## Contract details

- `new MapSystem(layout, dims)` — `layout` is the `generateLayout(seed)`
  result (structurally typed; T50 may add `districts` / `ponds` / `parking` /
  `parkPaths` / `buildings` arrays — all optional, styled table-driven by
  district `kind` string with a sane default for unknown kinds).
  `dims = { vx: WORLD_VX, vz: WORLD_VZ }` in voxels.
- `attach(root)` — mount into `#ui-root` (works with `pointer-events: none`
  root; the fullscreen sheet re-enables its own pointer events).
- `update(px, pz, yaw)` — world METERS + yaw radians, every frame (internally
  throttles the minimap blit to every other frame). North-up arrow rotation
  is `-yaw` (derivation documented in map-math.ts `arrowAngle`).
- `toggleFullscreen()` / `get isOpen` / `onClose` / `setVisible(on)` as above.

## Dev harness

`src/ui/map/dev.html` — standalone page (vite dev server:
`http://localhost:5173/src/ui/map/dev.html`) rendering the real
`generateLayout(1337)` through the full MapSystem with a scripted walking
player. Not part of the production build (only index.html is a rollup input).

## Tests

- `tests/map-math.test.ts` — projection round-trips, pan/zoom cursor
  anchoring, minimap crop clamping, yaw→arrow angle.
- `tests/map-render.test.ts` — draw-command determinism digest, feature
  completeness (every road/house/pool/tree present), Google-style layer
  ordering, T50 district forward-compat.
