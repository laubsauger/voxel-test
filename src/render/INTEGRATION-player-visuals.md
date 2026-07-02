# Player visuals (T46/T48/T49) — integration guide

One class wires everything: `PlayerVisuals` (src/render/player-visuals.ts).
It owns the third-person voxel body (color zones + procedural animation rig)
AND the first-person viewmodel (arms + equipped tool). Render layer only —
it reads the sim player entity and never writes it (V6); the sim segment
grids remain the damage authority.

## Backward compatibility note

`PlayerMesh` kept its old public API (`new PlayerMesh(player)`, `.group`,
`.update(player)`) — the existing game.ts wiring keeps working unchanged and
already gets T46 colors + T48 body animation for free (update() runs an
internal clock when `dt` is omitted). The wiring below REPLACES that block to
add the FP viewmodel (T49) and correct visibility per camera mode.

## Exact wiring (src/game.ts)

1. Import swap — replace the PlayerMesh import:

```ts
// import { PlayerMesh } from './render/player-mesh'   ← remove
import { PlayerVisuals } from './render/player-visuals'
```

2. Field swap — in class `Game`, replace

```ts
private playerMesh: PlayerMesh | undefined
```

with

```ts
private playerVisuals: PlayerVisuals | undefined
```

3. Optional tool feed — `Game` never sees the HUD, so give it a provider the
   UI layer fills in (same pattern as `onFlyChange`). Add one field:

```ts
/** T49 — equipped hotbar tool id provider (wired by main.ts, see step 5) */
equippedTool: (() => string) | null = null
```

4. Frame-loop swap — in `startLoop()`, replace the whole `if (player) { ... }`
   playerMesh block body's first half with:

```ts
const player = this.phys.players.get(LOCAL_PLAYER)
if (!this.playerVisuals) this.playerVisuals = new PlayerVisuals(this.scene, this.cam.camera)
const camMode =
  this.state !== 'play' ? 'orbit' : this.flying ? 'fly' : this.cam.mode // 'fp' | 'tp'
this.playerVisuals.update(dt, player, camMode, this.equippedTool?.() ?? 'dig')
if (player) {
  if (this.state === 'play' && !this.flying) this.cam.update(player, this.sim.world)
  // T28 hit feedback block stays exactly as-is (lastDamageSum)
  ...
}
```

   Delete the old lines:
   - `if (!this.playerMesh) { this.playerMesh = new PlayerMesh(player); ... }`
   - `this.playerMesh.update(player)`
   - `this.playerMesh.group.visible = ...` (PlayerVisuals owns visibility now:
     fp → headless/armless body so feet show looking down + viewmodel;
     tp/fly/orbit → full body, viewmodel hidden)

5. main.ts (one line, next to the existing `game.onFlyChange` wiring):

```ts
const tools = new ToolController(game, hud)
game.equippedTool = () => tools.equipped   // T49 — ToolController.equipped getter
```

   (`ToolController` gained a public `equipped: ToolId` getter — the only
   change to src/ui/tools.ts.)

## Notes

- `PlayerVisuals` adds the camera to the scene if it has no parent (camera
  children — the viewmodel — only render when the camera is in the graph).
  This is safe: PlayerCam sets world-space position/rotation directly.
- Use-animations (swing/recoil) self-trigger on pointer-locked left click.
  For frame-exact sync with actual command pushes, ToolController may call
  `playerVisuals.triggerUse()` instead — optional, not required.
- The FP viewmodel bob reads the SAME stride-phase state object the body rig
  advances (`PlayerMesh.anim`) — desync is impossible by construction.
- Feet in FP: the TP body is reused with head + arms hidden
  (`PlayerMesh.setFirstPerson(true)`), so looking straight down shows the
  animated torso/legs/shoes, and the player still casts a full-body shadow.
