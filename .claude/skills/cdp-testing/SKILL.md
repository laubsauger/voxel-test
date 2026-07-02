---
name: cdp-testing
description: How to drive BLOCKBURB in real Chrome via CDP (puppeteer-core) — boot, WebGPU flags, pointer lock, screenshots, audio, two-browser MP, frame profiling. Read BEFORE writing any browser test/probe script so you don't reinvent the plumbing.
---

# CDP testing in this repo — the accumulated knowledge

Every agent that verifies in-browser behavior uses the same stack: vite dev
server + puppeteer-core driving the user's local Chrome. These patterns were
learned the hard way; do not rediscover them.

## Canonical references (read the real code, copy from it)

- `scripts/smoke.mjs` — THE reference harness: vite boot, Chrome launch,
  boot-param navigation, HUD gating, settle wait, PNG analysis, error
  collection. The merge gate. Never weaken its assertions.
- `scripts/frame-probe.mjs` — frame-time capture + long-task attribution
  (rAF timestamps + PerformanceObserver injected via `page.evaluate`).
- `scripts/world-shot.mjs`, `dev-shots.mjs`, `cycle-shots.mjs`,
  `water-shots.mjs`, `ui-shot.mjs` — fly-cam probes, time-of-day overrides,
  scenario screenshots.

## Boot + environment

- Chrome binary: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  via `puppeteer-core` `launch({ executablePath })`. Never puppeteer-full.
- WebGPU flags (all required, headless works fine on this Mac):
  `--enable-unsafe-webgpu --enable-features=WebGPU --use-angle=metal`.
- **Port collisions**: many agents run vite simultaneously. Always use a
  per-process port: `Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))`
  with `--strictPort`. Never hardcode a port.
- **Script location**: ESM scripts must live INSIDE the repo (`scripts/…`) or
  `import puppeteer from 'puppeteer-core'` fails — module resolution is
  script-path-relative, not cwd-relative. Scratchpad scripts can't import
  repo deps. Create `scripts/tmp-*.mjs`, run, delete.
- Boot straight into gameplay: `/?boot=game&seed=1337` (I.boot). Menu path:
  `/` (preloader → menu; menu appears at ~45% mesh coverage). `?dev=1`
  enables the dev overlay + `window.__bb*` debug handles.

## Gating and timing

- Render-loop-alive gate: wait for `/fps/` in `#hud` textContent.
- World-meshed gate: wait for `/pending 0(\D|$)/` in `#hud` (60s timeout on
  the 2048 world; settle ≈ tick 800-1200).
- Let the fps counter stabilize ~1.5s before reading it; absolute fps swings
  wildly under parallel-agent machine load (47→120 observed) — compare
  paired A/B runs back-to-back, never absolute numbers across sessions.

## Screenshots

- **WebGPU canvas readback via 2d drawImage returns BLANK** (frame already
  presented). Screenshot with `page.screenshot()` and analyze the PNG file
  (pngjs luma spread — see smoke.mjs). Never assert on canvas pixel reads.
- Blank check: luma spread < 8 = broken frame.
- LOOK at every screenshot you take (Read tool renders PNGs). Screenshot
  iteration ≥2 rounds is the norm; first drafts always have a visual bug.
- Camera control for shots: click canvas (pointer lock), then
  `page.mouse.move` deltas rotate the view (relative movement while locked).
  Large downward sweep = look down. For fly-cam framing use `?dev=1` +
  KeyF + WASD key events, or the `window.__bbCycle`-style debug handles.

## Input / interaction

- Pointer lock: `page.mouse.click(640, 400)` on the canvas counts as a user
  gesture; `document.pointerLockElement` confirms. After Esc, Chrome has a
  ~1.5s re-lock cooldown — expect a rejected `requestPointerLock` once.
- Keys: `page.keyboard.down/up('KeyW')` etc. Hotbar = Digit1-4. KeyV camera,
  KeyF fly, KeyL flashlight, KeyM map, KeyN noclip (dev), KeyU unlock cursor.
- Tools fire on mousedown (hold-to-fire repeats on cooldown).

## Audio verification (headless can't hear)

- Add `--autoplay-policy=no-user-gesture-required` in throwaway scripts ONLY
  (never smoke.mjs).
- Verify wiring, not sound: AudioContext state === 'running' after gesture,
  bus gain node values, scheduled-sound counters (`window.__bbAudio` debug
  handle). PCM proxy analysis (peak/ZCR/HF-ratio) can flag metallic/loud
  assets but cannot judge texture — say so honestly.

## Two-browser multiplayer (T72 harness)

- `scripts/mp-e2e.mjs` (LANDED, `npm run mp-e2e`): starts `server/signal.mjs`
  on a free port, one vite, TWO `browser = await puppeteer.launch(...)`
  instances (separate processes = real cross-process determinism test), host
  drives menu UI to create a room, guest joins by code, mirrored scripted
  inputs, assert identical `window.__bbNet.lastHashes` sequences + bit-exact
  `__bbNet.playersState()` + zero console errors on both pages.
- Walk = real keyboard (`page.keyboard.down('KeyW')` hits document listeners
  without pointer lock). Mouse tools can't fire headless (no pointer lock) —
  inject at the same layer via `__bbNet.submitOp(op)` → `Game.pushOp`.
- Extra launch flags beyond WebGPU: `--disable-background-timer-throttling
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
  (a throttled page stalls the lockstep tick barrier for EVERYONE).

## WebRTC under CDP (learned the hard way, T72)

- **mDNS candidate obfuscation**: Chrome hides host ICE candidates behind
  `.local` mDNS names; headless/automation contexts can resolve them flakily
  or not at all. ALWAYS add `--disable-features=WebRtcHideLocalIpsWithMdns`
  to BOTH launches for loopback WebRTC tests (test-only; real users
  unaffected). No STUN/TURN needed on loopback once this is off.
- **Even with that flag, loopback WebRTC under headless CDP flakes ~10%**:
  both `pc.connectionState` stay `connected`, no `iceconnectionstatechange`,
  no `datachannel.onclose`, no JS errors — but SCTP delivery silently dies
  mid-run (sometimes transiently, sometimes permanently). Symptom in
  lockstep: one peer starves at the tick barrier while the other stalls,
  then drops it. Diagnosed with per-channel sent/received counters +
  `bufferedAmount` + a rAF heartbeat exposed on `window.__bbNet` — main
  threads alive, transport dead. Not product code.
- **Consequence: don't gate merges on headless WebRTC.** The `Channel`
  interface is transport-agnostic; `mp-e2e` defaults to `?transport=ws`
  (lockstep tunneled through the signaling server relay,
  `SignalingClient.relayChannel`) which is deterministic and stable — that
  run proves cross-process sim determinism. `npm run mp-e2e -- --rtc`
  exercises the real WebRTC path (passes most runs; expect the ~10% env
  flake). Real sessions always use WebRTC.
- Transport state breadcrumbs live in `src/net/signaling.ts` as
  `console.warn('[net] …')` — harnesses should echo warnings starting with
  `[net]` for live triage but NOT count them as failures.

## Frame profiling

- Inject `PerformanceObserver({ entryTypes: ['longtask'] })` + rAF timestamp
  ring buffer via `page.evaluate` BEFORE the scenario; collect after.
- Attribute cost with `performance.mark/measure` patched around suspects at
  runtime (frame-probe.mjs prototype-patches without source changes).
- Report p50/p95/p99/max per phase (idle / dig / bomb) from paired runs.

## General hygiene

- Collect `page.on('pageerror')` + `page.on('console')` type==='error'
  (filter favicon by URL) in every harness; errors = failure.
- Kill vite in `finally`; close browser with `.catch(() => {})`.
- `npm install` in a worktree dirties `package-lock.json` — never commit
  that churn.
- Artifacts → `smoke-artifacts/` (gitignored).
