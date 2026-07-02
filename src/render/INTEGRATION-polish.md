# INTEGRATION — polish (T74 birds, T75 flashlight)

Both modules are render-only (V6): they read nothing from the sim and write
nothing. Neither file touches `game.ts`/`main.ts` — the coordinator applies
the wiring below.

## T74 birds (`src/render/birds.ts`)

Budget: ONE draw call (single InstancedMesh, wing flap in the vertex shader),
zero per-frame allocation. Day-only: fades with the cycle day factor and is
hidden (draw skipped) at night.

`game.ts` — construct next to the other scene cosmetics (e.g. after
`WaterSurface`), update in the frame loop right after `this.world.update(...)`:

```ts
import { Birds } from './render/birds'

// construct (once, constructor / Game.create)
const birds = new Birds(); this.scene.add(birds.group)

// per frame (after this.world.update(dt, this.sim.tick) so the cycle state is fresh)
birds.update(dt, (globalThis as { __bbCycle?: { state: { dayF: number } } }).__bbCycle?.state.dayF ?? 1)
```

`__bbCycle.state` is WorldRenderer's live per-frame `CycleState` (T58 dev
handle — always installed by the WorldRenderer constructor). If a typed path
is preferred, expose `WorldRenderer.cycleState` as a public readonly and pass
`this.world.cycleState.dayF` instead; birds only need the `dayF` number.

## T75 flashlight (`src/render/flashlight.ts`)

Warm ~3000 K SpotLight, 25 m range, castShadow OFF (v1 budget: one extra
forward light when on, zero shadow passes). Anchored right-and-below the
camera; the beam target is a lagged spring for handheld sway. Boots OFF.

`game.ts` (or wherever the render loop lives):

```ts
import { Flashlight } from './render/flashlight'

// construct (once) — cam.camera is the PlayerCam PerspectiveCamera
const flashlight = new Flashlight(this.cam.camera); this.scene.add(flashlight.group)

// per frame (any point after the camera pose is final for the frame)
flashlight.update(dt)
```

`main.ts` — key toggle (mirrors the existing KeyF fly toggle style):

```ts
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyL') game.flashlight.toggle()
})
```

State query for UI/HUD: `flashlight.isOn`.
