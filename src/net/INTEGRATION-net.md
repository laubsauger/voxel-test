# INTEGRATION — net track (T24–T27, wired live in T71/T72)

How the integrator wires `src/net/**` into `main.ts`.

## Status after T71/T72 — what is LIVE

| Piece | Status |
|---|---|
| Menu HOST/JOIN → lobby → synchronized start | **live** (`main.ts` hostFlow/joinFlow, `src/ui/mp.ts`) |
| Session protocol `ss/*` (hello/lobby/start/ready/ping) | **live** (`src/net/session.ts`, unit-tested) |
| Lockstep tick barrier in the real game loop | **live** (`Game.attachNet` + `LockstepDriver` in `game.ts`) |
| Session-aware command sink (`Game.pushOp`), playerId threading | **live** (tools/spawn/noclip/move; solo stays playerId 1) |
| Remote player rendering (`PlayerMesh` per spawned peer) | **live** (`game.ts` loop) |
| Desync detector every 30 ticks, **combined** hash (sim+physics+water) | **live** (`src/net/combined-hash.ts`, V10 red overlay) |
| Stall UX: banner ≥2s, host drop ≥30s (empty-input substitution) | **live** (`LockstepHost.dropPlayer`, announced in `BundleMsg.dropped`) |
| Presence HUD (players + ping + sync tick), pause-menu MP note | **live** |
| 2-browser e2e determinism gate | **live** (`npm run mp-e2e` — MERGE GATE for sim-touching changes) |
| WS-relay test transport (`?transport=ws`) | **live** (`SignalingClient.relayChannel` — automated tests only) |

Key wiring facts (differ from the original sketch below):

- **The session game is a fresh `Game.create` with `holdTicks: true`.** The
  menu-orbit backdrop game has been ticking since boot and cannot be lockstep
  tick-0 state; it is disposed at session start. `holdTicks` freezes the new
  sim at tick 0 (rendering/meshing still run — `initStatic` seeds the remesh
  feed without ticks) until `attachNet`, which asserts `sim.tick === 0`.
  First live run without this: "stale bundle for tick 0 (sim at 484)".
- **Readiness barrier before `LockstepHost.start()`.** `DataChannelAdapter`
  does not buffer for unregistered listeners, and guests take seconds to build
  their Game — bundles sent early would be silently lost. Guests send
  `ss/ready` after wiring `LockstepClient` + `DesyncReporter`; the host starts
  the tick stream only after `onAllReady` (see `session.ts` header).
- **Desync hash is `combinedHash(sim, phys, water)`** — `hashSim` alone would
  miss physics/water divergence (old open issue 4, now closed). The hash fn is
  injectable on `DesyncDetectorHost`/`DesyncReporter`; host and guests MUST
  use the same one.
- **MISSING HASH EXPORT (open):** player capsule state (`phys.players` —
  px/py/pz, velocity, yaw, input, segments, noclip) is in **neither `hashSim`
  nor `hashPhysics`**. A player-only desync is invisible to the detector.
  Needs a `hashPlayers` export from the physics/player owners (sim/** is not
  this track's to edit). `mp-e2e` compensates with a bit-exact cross-browser
  `playersState()` comparison.
- **Move ops are gated to one per stepped frame** (`Game` MP loop): during a
  barrier stall nothing is submitted, so a 30s stall can't dump thousands of
  stale moves into one bundle at release.
- Leaving a lobby/session (or the desync overlay's "Return to Menu") is a
  `location.reload()` — clean-slate v1 pragmatism; the backdrop-game swap
  only runs forward (menu → session), never backward.
- **rAF starvation is handled.** The lockstep pump originally lived only in
  `setAnimationLoop`; a page whose rAF starves (backgrounded/occluded tab,
  GPU contention — headless e2e showed routine 0.6-1.5s and occasional 30s+
  gaps) stopped sending inputs and stalled the whole session until the host
  dropped it. `Game.startLoop` now runs a 250ms background interval pump
  that feeds the barrier whenever rAF has been silent >250ms (60-step budget
  → a hidden tab holds ~60Hz even with 1s-throttled timers). This was
  initially misdiagnosed as silent WebRTC death — the ws-relay transport
  reproduced it, exonerating WebRTC.
- **Transports.** Real sessions: WebRTC DataChannel (default, and the mp-e2e
  gate path). `?transport=ws` tunnels lockstep through the signaling server
  relay (JSON only, binary throws) — transport-isolation debugging
  (`npm run mp-e2e -- --ws`); see `.claude/skills/cdp-testing/SKILL.md`
  "WebRTC under CDP". NOTE for real networks: no ICE-restart/reconnect
  handling — a mid-session transport blip behaves like a dropped peer
  (stall banner → host drop at 30s).

## Still deferred (NOT built)

1. **Late join / mid-session snapshot transfer** — explicitly out of scope for
   T71. `SnapshotCodec` + framing are ready; `LockstepHost.addPeer` still
   throws after `start()`. Host-side bundle buffering + peer admission at a
   tick boundary remain open (see "Late-join transfer flow" sketch below).
2. **Session persistence / reconnect** — a dropped player cannot rejoin
   (their capsule stays in-world, frozen by empty-input substitution).
3. **Snapshot sections for physics/water/entities** — blocked on late join.
4. **Client-side host-death auto-exit** — guests get the stall banner and the
   `room-closed` fatal overlay (via signaling), but no timeout-based local
   drop of a silent host (host is the authority; nothing to fail over to).

---

Original wiring sketch from the net track (kept for reference; superseded
where the table above says so):

## Files

| File | What |
|---|---|
| `server/signal.mjs` | WS signaling server (run: `npm run signal`, `PORT` env, default **8081**; client default `ws://localhost:8081`, override with `?signal=ws://...`) |
| `server/rooms.mjs` (+`.d.mts`) | room/relay state machine, pure, unit-tested |
| `src/net/channel.ts` | `Channel {send, onMessage}` + `MockChannel` for tests |
| `src/net/signaling.ts` | browser-only: signaling client + RTCPeerConnection/DataChannel adapter |
| `src/net/lockstep.ts` | `LockstepHost` / `LockstepClient` / `LockstepNode` / `LockstepDriver` |
| `src/net/snapshot.ts` | `SnapshotCodec` (sectioned, RLE), `rleEncode/rleDecode` |
| `src/net/framing.ts` | 16KB DataChannel framing: `frameTransfer` / `FrameAssembler` |
| `src/net/desync.ts` | `DesyncDetectorHost` / `DesyncReporter` (hash fn injectable, T71) |
| `src/net/session.ts` | `HostLobby` / `GuestLobby` — `ss/*` lobby protocol (T71) |
| `src/net/combined-hash.ts` | `combinedHash(sim, phys, water)` — the live desync hash (T71) |

## Host / join UI flow

Run the signaling server somewhere reachable (`npm run signal`).

**Host:**

```ts
const sig = await SignalingClient.connect('ws://localhost:8787')
const sim = new Sim(seed); registerEditOps(sim) // + all other op handlers
const host = new LockstepHost(sim, /*hostPlayerId*/ 1)
const detector = new DesyncDetectorHost(sim, 1)
host.node.onStep(() => detector.afterStep())

let nextPlayerId = 2
const code = await sig.hostRoom((peerId, channel) => {
  const playerId = nextPlayerId++
  // hello: host assigns playerId + session params (first message on the channel)
  channel.send(JSON.stringify({ t: 'hello', playerId, seed, inputDelay: host.node.inputDelay }))
  host.addPeer(playerId, channel)
  detector.addPeer(playerId, channel)
})
showJoinCode(code)
// when the lobby is full / player clicks start:
host.start()
```

**Client:**

```ts
const sig = await SignalingClient.connect('ws://localhost:8787')
const { channel } = await sig.joinRoom(codeFromUi)
const hello = await firstJsonMessage(channel, 'hello') // integrator helper
const sim = new Sim(hello.seed); registerEditOps(sim)
const client = new LockstepClient(sim, hello.playerId, channel, hello.inputDelay)
const reporter = new DesyncReporter(sim, hello.playerId, channel, 30)
client.node.onStep(() => reporter.afterStep())
```

Notes:
- **playerId assignment is the host's job** (deterministic join order, 2..4);
  signaling peerIds are transport-level and must not leak into the sim.
- `seed` and `inputDelay` must be identical on all peers — ship them in the
  hello message, never hardcode on the client.
- The lockstep protocol messages are namespaced (`ls/*`), desync (`dd/*`),
  binary frames = snapshot transfer. All three share the one reliable-ordered
  DataChannel; each component ignores traffic that isn't its own.

## Render loop / FixedStepDriver → tick barrier

Multiplayer does NOT use `FixedStepDriver` (it steps unconditionally).
`LockstepDriver` (src/net/lockstep.ts) has the same accumulator/alpha contract
(V11) but defers to the tick barrier — when the bundle for `sim.tick` hasn't
arrived it holds time (capped) instead of stepping:

```ts
renderer.setAnimationLoop((now) => {
  const node = isHost ? host.node : client.node
  lockstepDriver.advance(now - last, node) // steps 0..N ticks, barrier-gated
  last = now
  ui.input.pendingOps.forEach((op) => node.submitLocal(op)) // V1: ops only
  render(lockstepDriver.alpha)
})
```

Singleplayer keeps using `FixedStepDriver` + local `sim.queue.push` unchanged.
Local player ops in MP go through `node.submitLocal(op)` — they apply at
`tick + inputDelay` (default 3) on every peer simultaneously. Never push into
`sim.queue` directly in MP.

## Desync overlay (V10)

Both `DesyncDetectorHost.onDesync(cb)` and `DesyncReporter.onDesync(cb)` emit
`DesyncEvent { tick, hashes: {playerId, hash}[] }`. Wire both to a fullscreen
error overlay (same pattern as the `#fatal` div in index.html):

```ts
const onDesync = (e: DesyncEvent) => die(`DESYNC at tick ${e.tick} — session dead. ` +
  e.hashes.map(h => `p${h.playerId}=${h.hash.toString(16)}`).join(' '))
detector.onDesync(onDesync)   // host
reporter.onDesync(onDesync)   // client
```

If no handler is wired, the detector **throws** on mismatch — it cannot fail
silently. `detector.lastVerifiedTick` is available for a "sync OK" HUD field.
Detector and reporters must use the same `interval` (default 30 ticks).

## Snapshot section contract (physics / water / entity tracks)

`SnapshotCodec` ships two built-in sections: `core` (tick, prng state,
nextEntityId) and `chunks` (sparse chunk store; empty/uniform = 2 bytes,
dense = RLE with raw fallback). Jolt bodies, water field, and entity state
are NOT in ChunkStore — their owners must register sections:

```ts
codec.registerSection('phys', {
  serialize(sim: Sim): Uint8Array { /* deterministic body state */ },
  deserialize(sim: Sim, data: Uint8Array): void { /* rebuild bodies */ },
})
```

Rules:
- Register the **same section ids on host and joiner, before** snapshot
  exchange. Unknown section in an incoming snapshot ⇒ throw (V10). Section
  registered locally but missing from the snapshot ⇒ throw (V10).
- Serialize only deterministic sim state (V2): everything that feeds
  `hashSim` — and once physics/water land, extend `hashSim` and the section
  together. Round-trip must reproduce the hash exactly (see tests).
- Suggested ids: `phys` (Jolt bodies + island grids), `water` (level buffer),
  `ents` (entity table). Payloads are opaque bytes to the codec.

### Late-join transfer flow (host side)

```ts
host is at tick S, pauses adding new peer to lockstep:
1. buf = codec.serialize(sim)                  // at tick S
2. frames = frameTransfer(buf, transferId)     // each ≤ 16KB
3. for (f of frames) channel.send(f)
4. joiner: FrameAssembler.push per frame → codec.deserialize(freshSim, buf)
5. host keeps buffering bundle msgs ≥ S for the joiner, sends them after the
   snapshot; joiner fast-forwards via node.tryStep() until caught up
```

Step 5 (mid-session join into a *running* lockstep session) is NOT implemented:
`LockstepHost.addPeer` throws after `start()`. v1 flow = everyone joins in the
lobby, then `start()`. Snapshot+framing are ready for late join; the host-side
bundle buffering + peer-set change mid-session is the open piece.

## Running the signaling server

```
npm run signal            # ws://localhost:8787
PORT=9000 npm run signal
```

Stateless beyond room membership; no game logic; host disconnect closes the
room (`room-closed` to all — surface as fatal, the lockstep authority is gone).

## Open issues

1. **Mid-session late join** — see above; needs host bundle buffering and a
   protocol message admitting a new playerId at a tick boundary.
2. ~~WebRTC layer untested~~ — **closed by T72**: `npm run mp-e2e` exercises
   signaling + RTCPeerConnection/DataChannel end-to-end in two real Chrome
   processes on every run.
3. ~~Peer drop mid-session~~ — **closed by T71**: stall banner ≥2s, host
   `dropPlayer` ≥30s (also on signaling `peer-left`) with deterministic
   empty-input substitution announced in `BundleMsg.dropped`
   (tests/lockstep-drop.test.ts).
4. ~~hashSim coverage~~ — **closed by T71** for physics + water via
   `combinedHash`. **Still open for player capsule state** (no exported hash;
   see "MISSING HASH EXPORT" above).
5. **Backpressure** — snapshot frames are sent without watching
   `RTCDataChannel.bufferedAmount`; fine at current sizes (uniform world
   ≈ 33KB), revisit if snapshots grow past a few MB.
