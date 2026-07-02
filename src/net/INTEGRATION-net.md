# INTEGRATION — net track (T24–T27)

How the integrator wires `src/net/**` into `main.ts`. Nothing in this track
modifies existing files; everything below is additive wiring.

## Files

| File | What |
|---|---|
| `server/signal.mjs` | WS signaling server (run: `npm run signal`, `PORT` env, default 8787) |
| `server/rooms.mjs` (+`.d.mts`) | room/relay state machine, pure, unit-tested |
| `src/net/channel.ts` | `Channel {send, onMessage}` + `MockChannel` for tests |
| `src/net/signaling.ts` | browser-only: signaling client + RTCPeerConnection/DataChannel adapter |
| `src/net/lockstep.ts` | `LockstepHost` / `LockstepClient` / `LockstepNode` / `LockstepDriver` |
| `src/net/snapshot.ts` | `SnapshotCodec` (sectioned, RLE), `rleEncode/rleDecode` |
| `src/net/framing.ts` | 16KB DataChannel framing: `frameTransfer` / `FrameAssembler` |
| `src/net/desync.ts` | `DesyncDetectorHost` / `DesyncReporter` |

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
2. **WebRTC layer untested** — `signaling.ts` (RTCPeerConnection/DataChannel)
   has no unit tests by design (no WebRTC in the vitest node env); needs a
   manual 2-browser smoke test against `npm run signal`. Server ws wiring was
   smoke-tested end-to-end (create/join/relay OK).
3. **Peer drop mid-session** — a disconnected peer stalls everyone at the tick
   barrier forever (correct per lockstep, but needs UX: timeout → error
   overlay / host removes player at a released tick boundary).
4. **hashSim coverage** — currently tick+prng+entityId+chunks. When physics/
   water state lands, it must be added to hashSim or desyncs in those systems
   are invisible to T27.
5. **Backpressure** — snapshot frames are sent without watching
   `RTCDataChannel.bufferedAmount`; fine at current sizes (uniform world
   ≈ 33KB), revisit if snapshots grow past a few MB.
