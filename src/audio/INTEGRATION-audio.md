# INTEGRATION — audio (T36/T37/T38, I.audio)

Audio is render-layer only (V6): it reads sim state (player entity, voxels via
`ChunkStore.getVoxel`) and never writes it. All modules live in `src/audio/`;
assets in `public/audio/` (committed); the generation pipeline in
`scripts/audio/generate-sfx.mjs` (offline, node only — never imported by client code).

## main.ts wiring

```ts
import { AudioEngine } from './audio/engine'
import { GameAudio } from './audio/game-audio'

// 1. construct early (reads persisted volumes from localStorage, no AudioContext yet)
const audio = new AudioEngine()
void audio.loadManifest() // fetches /audio/manifest.json, validates schema

const gameAudio = new GameAudio(audio, sim.world) // sim.world = ChunkStore (read-only)

// 2. unlock on the FIRST user gesture (browser autoplay policy)
const unlock = () => {
  audio.unlock() // idempotent — safe to call from several handlers
  audio.playMusic('music-menu') // or 'music-game-ambient' if booting straight into game
  audio.play('ambience-suburb-day') // looping bed, sfx bus
}
addEventListener('pointerdown', unlock, { once: true })
addEventListener('keydown', unlock, { once: true })

// menu → game transition (I.boot / T33):
//   audio.playMusic('music-game-ambient')   // crossfades 1.5s by default

// 3. every render frame (inside the setAnimationLoop callback):
//   a) listener follows the camera (world meters)
const fwd = new Vector3(); const up = new Vector3(0, 1, 0)
cam.camera.getWorldDirection(fwd)
up.set(0, 1, 0).applyQuaternion(cam.camera.quaternion)
audio.setListener(
  cam.camera.position.x, cam.camera.position.y, cam.camera.position.z,
  fwd.x, fwd.y, fwd.z, up.x, up.y, up.z,
)
//   b) footstep/jump/land poller with the local player's interpolated state
gameAudio.update(dtSeconds, player && {
  px: player.px, py: player.py, pz: player.pz,
  vx: player.vx, vy: player.vy, vz: player.vz,
  grounded: /* char.GetGroundState() === OnGround, mirrored on the render snapshot */,
})
```

### Event hooks (call sites the integrator owns)

All positions are **world meters** (multiply voxel coords by `VOXEL_SIZE`).

| event source | call |
| --- | --- |
| dig/place op applied (where the command is issued/observed, or from `ChunkMeshManager.onEdit` chunk centers) | `gameAudio.onImpact(x, y, z, matHit)` |
| shoot op (local player fires) | `gameAudio.onShoot()` then `onImpact(...)` at the raycast hit with the hit material |
| explode op | `gameAudio.onExplosion(x, y, z, power)` — size/layers derive from op power |
| island extraction (T12) spawns a dynamic body | `gameAudio.onCollapse(x, y, z, voxelCount)` |
| glass voxels destroyed in an edit | `gameAudio.onGlassShatter(x, y, z)` |
| body enters water / buoyancy event (T17, when wired) | `gameAudio.onWaterSplash(x, y, z, 'small'│'large')` |
| player segment damage (T22 `seg.version` bump) | `gameAudio.onHurt()` |
| all-segments-critical / death state | `gameAudio.onDeath()` |
| health below threshold toggles | `gameAudio.setLowHealth(bool)` — starts/stops heartbeat loop |
| UI (T28/T33/T34) | `audio.play('ui-hover-1' \| 'ui-click-1' \| 'ui-back-1' \| 'ui-error-1' \| 'ui-hotbar-1')` |

`GameAudio.update()` handles footsteps (surface-aware via `getVoxel` under the
feet), jump takeoff and landing automatically from the grounded/velocity
transitions — no extra wiring.

## Settings-store volume contract (I.settings)

- Keys: `settings.audio.master`, `settings.audio.music`, `settings.audio.sfx`
  (exported as `VOLUME_STORAGE_KEYS` from `src/audio/engine.ts`).
- Value: **linear 0..1** stored as a decimal string (`"0.5"`). The settings UI
  showing 0–100 divides/multiplies by 100 at the edge.
- The engine reads these keys at construction and writes them on every
  `setVolume()`. The future I.settings store (T34) should read/write the same
  keys and call `engine.setVolume(bus, v)` for live application; no other
  channel is needed.
- Applied gain is `v²` (perceptual curve) — the stored value stays linear.

## Adding sounds later (pipeline usage)

1. Add a group entry to `SFX_GROUPS` (or `MUSIC_TRACKS`) in
   `scripts/audio/generate-sfx.mjs` — prompt, duration, count, loop, volume
   trim, positional flag.
2. Ensure `.env.dev` exists at the repo root with `ELEVENLABS_API_KEY=...`.
   It is gitignored — **never commit it, never echo it, never import it into
   `src/**`**. The script redacts the key from all output and only talks to
   `api.elevenlabs.io`.
3. Run `node scripts/audio/generate-sfx.mjs` (flags: `--dry`, `--only=sfx|music`,
   `--limit=N`). It is **idempotent**: existing files are skipped; to
   regenerate one sound, delete its mp3 and re-run. Each generation costs
   credits — no bulk re-runs.
4. The script rewrites `public/audio/manifest.json` from the spec (only files
   present on disk are listed; gaps are reported loudly). Commit the new mp3s
   + manifest.
5. `tests/audio-manifest.test.ts` pins category counts — update the expected
   numbers in the same change (deliberate drift gate).

## Cost notes (2026-07-02 generation run)

- 92 SFX (0.5–22s, mp3 44.1kHz 128kbps) + 2 music beds ≈ **2069 credits**
  total (from `character-cost` response headers): 6 (smoke) + 1463 (91 sfx)
  + 600 (2×30s music fallback).
- SFX bill by duration (~10 credits/s with explicit `duration_seconds`).
- **Music API is plan-gated** (402 `paid_plan_required` on this key). T38 fell
  back to two 30s loopable ambient beds via sound-generation (documented
  fallback). If the plan is upgraded: delete `public/audio/music/*.mp3` and run
  `node scripts/audio/generate-sfx.mjs --only=music` to get the real 90s/120s
  tracks (the script tries `/v1/music` first, falls back only on 402).

## Testing

`tests/audio-*.test.ts` — manifest schema + on-disk assets, volume bus math +
persistence (mock localStorage/AudioContext, no real WebAudio), round-robin
cycling, exhaustive material-id→surface/impact maps (tied to `MATERIALS`, V13),
footstep cadence/jump/land behavior, and the key-leak scan over `src/**` +
the manifest.
