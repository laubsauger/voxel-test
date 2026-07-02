# INTEGRATION — vehicles track (T64, B24)

Drivable GTA-like cars. Deliverables and how to wire them into `src/game.ts`
(this track does not touch game.ts/main.ts — the coordinator owns the merge).

Files: `src/sim/vehicle.ts` (new), `src/sim/{physics,player,commands}.ts`
(additive/surgical), `src/render/{vehicle-meshes,player-cam}.ts`,
`scripts/audio/generate-sfx.mjs` + `public/audio/sfx/vehicle/*`,
`tests/vehicles.test.ts`.

## game.ts wiring (exact)

```ts
import { VehicleMeshes, installVehicleDevControls } from './render/vehicle-meshes'

// --- construction (next to `new BodyMeshes(...)`) --------------------------
// second arg = opaque chunk material, third = transparent (glass windows).
// world.chunks is the ChunkMeshManager: material / transparentMaterial.
const vehicleMeshes = new VehicleMeshes(
  scene,
  world.chunks.material,
  world.chunks.transparentMaterial,
)

// dev controls (KeyG = summon car ahead of player, Enter = enter/exit).
// Gate KeyG behind dev mode exactly like the noclip key in main.ts;
// Enter always works (it is the enter/exit UX until a HUD prompt exists).
installVehicleDevControls(game.sim, game.phys, LOCAL_PLAYER, () => boot.dev || store.get('dev.profiling'))

// --- per-frame (inside startLoop, next to bodyMeshes.update) ---------------
vehicleMeshes.update(this.phys.vehicles)

// --- camera: seated players get the chase cam ------------------------------
// REPLACE the existing `this.cam.update(player, this.sim.world)` call with:
const seatedV = player && player.seatedVehicle !== 0
  ? this.phys.vehicles.get(player.seatedVehicle)
  : undefined
if (this.state === 'play' && !this.flying) {
  if (seatedV) this.cam.updateVehicle(seatedV, this.sim.world, dt)
  else this.cam.update(player, this.sim.world)   // restores saved fp/tp itself
}
// PlayerCam saves the fp/tp mode on the first updateVehicle call and restores
// it on the next update() — no extra bookkeeping in game.ts.

// While seated, the player's move input drives the CAR, not the capsule
// (sim-side). Recommendation: keep pushing input.moveCommand as-is — the sim
// routes it. Optionally hide the player body while seated (PlayerVisuals
// update with camMode 'tp' shows the body sitting inside the car; acceptable
// v1 — the seat position keeps it inside the cabin).
```

### Enter-key UX suggestion

`Enter` = context action: pushes `vehicle_enter` when on foot (sim resolves
the nearest free seat within 4 m, driver seat first), `vehicle_exit` when
seated. `installVehicleDevControls` already binds exactly this; when a HUD
prompt lands ("Press Enter to drive"), read
`phys.vehicles` distances render-side to show/hide it — the op stays the same.

Drive mapping (already sim-side, rides the existing `move` op — V1):
W/S = throttle / brake-then-reverse (GTA pedal model), A/D = steer,
Space = handbrake (rear wheels lock → drift). Passengers send input but the
sim ignores everything except the driver's (seat 0).

## Audio hooks (render layer, V6)

Assets shipped (manifest category `vehicle`, all positional):
`engine-idle-loop-1`, `engine-rev-loop-1`, `skid-loop-1`,
`car-crash-small-1/2`, `car-crash-large-1`, `car-door-open-1`,
`car-door-close-1`, `car-horn-1/2`.

Continuous loops — poll per frame for the local player's vehicle:

```ts
// v = phys.vehicles.get(player.seatedVehicle)
const speed = Math.hypot(v.vx, v.vy, v.vz)          // m/s, 0..21
const rpm01 = v.rpm / 7000                          // 0..1 mirrored engine RPM
// engine: start idle loop on vehicle_enter, stop on exit/wreck.
//   crossfade idle→rev with speed, pitch via playbackRate:
//   idle.playbackRate = 0.9 + 0.3 * rpm01
//   rev.playbackRate  = 0.7 + 0.9 * (speed / 21)   // pitch-scales with speed
//   rev.gain ∝ clamp(speed / 6)                    // silent at standstill
// skid: max wheel slip (hashed sim state, mirrored per tick):
const slip = Math.max(...v.wheels.map(w => w.slip))
//   skid loop gain ∝ clamp((slip - 1.2) / 3) while speed > 4 — start/stop the
//   loop on threshold crossings, playbackRate 0.95..1.1 by slip.
```

One-shots — ride the sim event outbox (`game.onSimEvents`), same as
explosions. **NOTE:** the three vehicle event types currently live in
`src/sim/vehicle.ts` (`VehicleCrashEvent`, `VehicleDoorEvent`,
`VehicleWheelLossEvent`) and are emitted through a cast — **fold them into the
`SimEvent` union in `src/sim/events.ts` at merge** (events.ts was not editable
on this track; the runtime shape is already JSON-plain and correct).

| event | fields | sound |
| --- | --- | --- |
| `vehicle_crash` | x,y,z (m), dv, large (0/1) | `car-crash-small` / `car-crash-large` (large=1); volume ∝ dv |
| `vehicle_door` | x,y,z, enter (1=enter) | enter: `car-door-open` then `car-door-close` (~350 ms later); exit: `car-door-open` |
| `vehicle_wheel_loss` | x,y,z | `car-crash-small` + `impact-metal` layered |

Horn: not an op (render-only flair) — bind a key (e.g. H while seated) to
`gameAudio`-style positional play of `car-horn` at the vehicle position.
If multiplayer-visible horns are wanted later, promote it to an op.

Headlights: MAT_LAMP voxels are part of the chassis grid and render through
the chunk material — they inherit the day-factor emissive handling (B25)
with zero extra wiring.

## gen conversion contract (B24)

This track may not touch `src/sim/gen/**`. The current world stamps car
PROPS as world voxels. To convert (coordinator, at merge):

1. gen stops stamping `sedan*/pickup*/van*` prop grids into the ChunkStore
   and instead emits a spawns list: `{ archetype, x, y, z, yaw }` in world
   meters (x,z = footprint center, y = ground surface, yaw about +Y with the
   car front facing -z at yaw 0 — same convention as prop placement).
2. every spawn MUST pass `vehicleSpawnClear(world, archetype, x, y, z, yaw)`
   (exported from `src/sim/vehicle.ts`): rotated chassis-band overlap check +
   ground-under-wheels check. This is the B24 fix — cars can no longer clip
   into houses, and road-placed cars just work (any clear asphalt passes).
3. game.ts pushes them as pre-tick-0 ops during scene construction, BEFORE
   the first `sim.step()` (deterministic — part of the command log):

```ts
let seq = 0
for (const s of layout.vehicleSpawns) {
  if (!vehicleSpawnClear(sim.world, s.archetype, s.x, s.y, s.z, s.yaw)) continue // or fix placement
  sim.queue.push({ tick: 0, playerId: 0, seq: seq++, op: { kind: 'vehicle_spawn', ...s } })
}
```

Until gen converts, the dev key (KeyG) summons cars for testing.

## Sim facts the integrator should know

- `VehicleEntity extends DynamicBody` — same corner-origin local frame.
  A vehicle whose live voxel count drops below 40% of initial converts to a
  plain wreck: same entity id moves `phys.vehicles → phys.bodies`, constraint
  removed. BodyMeshes renders wrecks automatically; VehicleMeshes drops them.
- Order inside `phys.tick`: structuralPass → vehicle pre-step (driver input)
  → Jolt step → vehicle post-step (readback, crash detection, seat sync,
  kill plane, wreck check) → updatePlayers (skips seated) → projectiles.
- Crash model: gravity-corrected one-tick Δv ≥ 4 m/s at ≥ 3 m/s pre-speed →
  world `destroySphere` at the contact (real crashes chew fences/walls, the
  structural pass collapses what that undermines next tick) + chassis dent +
  nearest-wheel damage (2 hits or Δv ≥ 10 → wheel breaks off as a debris
  body; that corner loses steer/brake/grip). 10-tick per-vehicle cooldown.
- Explosions: `damageBodiesSphere` also dents vehicles (strength capped at
  2.5 — sheet metal), `applyRadialImpulse` shoves them.
- Hash: `hashPhysics` now covers vehicles (transforms, velocity, rpm, grid,
  occupants, per-wheel state) and player `seatedVehicle`/`seat`. Desync
  detector needs no changes.
- Seated capsule: parked (updatePlayers skip), position synced to the seat
  every tick, `CharacterVirtual.SetPosition` kept in sync so exit resumes
  cleanly. Exit placement: door side → other side → rear → front → roof,
  first voxel-clear spot (deterministic).

## Overlap flags

- `src/sim/player.ts`: T64 added `seatedVehicle`/`seat` fields + one
  `if (p.seatedVehicle !== 0) continue` in updatePlayers. The water/swim
  track must keep seated players out of swim logic (a seated player whose
  car drives into a pool should not trigger swim locomotion — suggest
  `if (p.seatedVehicle !== 0) skip swim`).
- `src/audio/manifest-types.ts`: 'vehicle' added to SOUND_CATEGORIES (one
  line — the runtime validator rejects the manifest otherwise).
- `hashPhysics` layout changed (new fields) — any recorded replay hashes from
  before this track are invalidated (expected; replay tests regenerate).
