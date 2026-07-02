# T53/T54/T55 destruction-immersion — game.ts wiring (coordinator applies)

`src/game.ts` is owned by another agent this wave, so the two new renderers
ship unwired. Everything else (sim ops, events, tests) is self-contained —
`createPhysics` already registers the `throw` op and projectile integration.

## What needs wiring

1. **`FxSystem`** (`src/render/fx/fx-system.ts`) — event-driven VFX
   (explosion flash/fireball/radial debris/dust ring/smoke plume, gun
   tracer/muzzle/impact FX). Feed it `sim.drainEvents()` once per frame
   AFTER `driver.advance(...)` (the sim → render outbox, V6-safe like
   `phys.drainRemesh()`). Pass `sim.world` so it can probe ground height for
   the dust ring, and the player camera so local shots get a muzzle flash.
2. **`ProjectileMeshes`** (`src/render/projectile-meshes.ts`) — bomb visuals
   (black voxel-sphere bomb, fuse spark, spin, smoke trail). Reads
   `phys.projectiles` per frame, needs the `FxSystem` for trail puffs.

Call order inside the frame loop: drain events after the sim advanced, update
fx/projectiles anywhere after that (before `world.render()`).

## Exact patch

```patch
--- a/src/game.ts
+++ b/src/game.ts
@@
 import { BodyMeshes } from './render/body-meshes'
+import { FxSystem } from './render/fx/fx-system'
+import { ProjectileMeshes } from './render/projectile-meshes'
@@ class Game — private fields (next to bodyMeshes)
   private readonly bodyMeshes: BodyMeshes
+  private readonly fx: FxSystem
+  private readonly projectileMeshes: ProjectileMeshes
@@ constructor, after `this.bodyMeshes = new BodyMeshes(...)`
     this.bodyMeshes = new BodyMeshes(this.scene, this.world.chunks.material)
+    // T53 — event-driven destruction/combat VFX (V6: reads events, writes nothing)
+    this.fx = new FxSystem(this.sim.world)
+    this.scene.add(this.fx.group)
+    // T54 — bomb projectile visuals (reads phys.projectiles, trails via fx)
+    this.projectileMeshes = new ProjectileMeshes(this.scene, this.fx)
@@ startLoop(), after `this.driver.advance(dtMs, this.sim)`
       this.driver.advance(dtMs, this.sim) // fixed-tick sim (V11)
+      const fxEvents = this.sim.drainEvents() // T53 — sim → render outbox
@@ startLoop(), after `this.bodyMeshes.update(this.phys.bodies)`
       this.bodyMeshes.update(this.phys.bodies)
+      this.fx.update(dt, fxEvents, this.cam.camera)
+      this.projectileMeshes.update(this.phys.projectiles, dt)
```

## Notes

- `sim.drainEvents()` must be called exactly once per frame and its result
  passed along — a second drain returns `[]` (outbox semantics). Nothing else
  may consume it.
- The muzzle flash anchors at the camera + view direction; when the FP
  viewmodel (T49) lands, re-anchor by giving `FxSystem.update` a different
  camera/anchor — the flash placement is contained in `onShot`.
- Effect budgets: all pools are fixed-capacity GPU-instanced ring buffers
  (flash 8, fire 96, sparks 512, smoke 256, dust 256, debris cubes 1536,
  tracers 12). Zero steady-state allocation; spawning only writes attribute
  ranges. Total extra draw calls: 7 (+1 muzzle sprite, +1 point light).
- The old chunk-center edit bursts (`world-renderer.ts` → `particles.burst`)
  are demoted inside `particles.ts` to a light dig/place puff — no
  world-renderer change needed or made (file is owned elsewhere).
