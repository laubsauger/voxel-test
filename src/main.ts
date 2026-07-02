/**
 * T31 — boot orchestration (I.boot). Thin by design:
 *   1. capability check (WebGPU, fail loud)
 *   2. preloader → Game.create (real progress stages)
 *   3. route by URL params: ?boot=game&seed=N straight into gameplay
 *      (agent/CDP smoke path), ?dev=1 profiling overlay, default → menu.
 * All sim/render wiring lives in src/game.ts; all UI in src/ui/**.
 *
 * T52 (B9) — audio wiring per src/audio/INTEGRATION-audio.md: engine unlock
 * on the first user gesture, listener sync + footstep poller per frame,
 * tool/damage event hooks, UI sounds, menu↔game music crossfade. Plus
 * fullscreen + mute quick-access and Esc-closes-pause (B10).
 *
 * T71 — multiplayer (I.net, V2/V3/V10). Boot decision, documented:
 * solo keeps the original flow (Game created before the menu — it IS the
 * menu's orbit backdrop). HOST/JOIN reuse that backdrop game for the lobby;
 * when the session starts, the backdrop game is DISPOSED and a fresh Game is
 * created with the host's seed — the backdrop sim has been ticking since boot
 * and cannot serve as tick-0 lockstep state. `wireGame` rebinds every
 * per-instance hook so HUD/tools/audio/settings survive the swap.
 * Leaving a lobby/session = location.reload() (clean slate; v1 pragmatism).
 */
import { Vector3 } from 'three/webgpu'
import './ui/style.css'
import { Game } from './game'
import { AudioEngine, type AudioContextLike, type PlayOptions } from './audio/engine'
import { GameAudio } from './audio/game-audio'
import { parseBootParams } from './ui/boot-params'
import { SettingsStore } from './ui/settings-store'
import { Preloader } from './ui/preloader'
import { Hud } from './ui/hud'
import { ToolController } from './ui/tools'
import { MainMenu, PauseMenu } from './ui/menu'
import { SettingsPanel } from './ui/settings-panel'
import { DevOverlay } from './ui/dev-overlay'
import { wireAudioSettings, attachUiSounds } from './ui/audio-wiring'
import { FullscreenControl } from './ui/fullscreen'
import { MpLobby, NetHud, StallBanner, DesyncOverlay } from './ui/mp'
import { SignalingClient } from './net/signaling'
import { GuestLobby, HostLobby, HOST_PLAYER_ID, playerName, type SessionPlayer } from './net/session'
import { LockstepClient, LockstepDriver, LockstepHost, DEFAULT_INPUT_DELAY, type LockstepNode } from './net/lockstep'
import { DesyncDetectorHost, DesyncReporter, DEFAULT_HASH_INTERVAL, type DesyncEvent } from './net/desync'
import { combinedHash } from './net/combined-hash'
import type { Channel } from './net/channel'
import type { Op } from './sim/commands'

const app = document.getElementById('app')!
const root = document.getElementById('ui-root')!
const fatal = document.getElementById('fatal')!

function die(msg: string): never {
  fatal.textContent = msg
  fatal.style.display = 'grid'
  throw new Error(msg)
}

// --- phase 1: capability check (§C: WebGPU only, no fallback, fail loud) -----
if (!('gpu' in navigator)) die('WebGPU not available. Desktop Chrome required.')

const boot = parseBootParams(location.search)
const store = new SettingsStore()

// --- audio engine (T52/B9) ----------------------------------------------------
// The engine gets a null storage: SettingsStore is the single persistence
// authority for volumes (0..100 ints under settings.audio.*); wireAudioSettings
// converts to the engine's linear 0..1 live. createContext is wrapped to keep
// a debug view (context state + the three bus gain nodes) for CDP verification.
const audioDebug: { ctx: AudioContext | null; buses: GainNode[] } = { ctx: null, buses: [] }
const audio = new AudioEngine({
  storage: { getItem: () => null, setItem: () => {} },
  createContext: () => {
    const ctx = new AudioContext()
    audioDebug.ctx = ctx
    const orig = ctx.createGain.bind(ctx)
    ctx.createGain = () => {
      const g = orig()
      if (audioDebug.buses.length < 3) audioDebug.buses.push(g) // unlock order: master, music, sfx
      return g
    }
    return ctx as unknown as AudioContextLike // same cast as the engine default
  },
})
// manifest downloads in parallel with world/physics boot
const manifestReady = audio.loadManifest().catch((e: unknown) => {
  console.error('[audio] manifest load failed:', e)
})
wireAudioSettings(store, audio)

let scheduledCount = 0
/** guarded play: silent before unlock/manifest (nicety), loud on real failures */
function sfxPlay(name: string, opts?: PlayOptions): Promise<unknown> | null {
  if (!audio.loaded || !audio.unlocked) return null
  const p = audio.play(name, opts)
  p.then((h) => {
    if (h) scheduledCount++
  }).catch((e: unknown) => console.error(`[audio] play '${name}' failed:`, e))
  return p
}

// --- phase 2: preloader + game construction ----------------------------------
// `game` is a let: an MP session start replaces the instance (see header).
const pre = new Preloader(root, boot.seed)
let game = await Game.create({
  seed: boot.seed,
  host: app,
  onStage: (s) => pre.stage(s),
  graphics: { quality: store.get('graphics.quality'), fov: store.get('graphics.fov') },
}).catch((e: unknown) => die(`boot failed: ${e instanceof Error ? e.message : String(e)}`))

let gameAudio = new GameAudio({ play: sfxPlay }, game.sim.world)

// unlock on the FIRST user gesture (autoplay policy); menu PLAY / any click works
let bedsStarted = false
const startAudio = () => {
  audio.unlock() // idempotent
  void manifestReady.then(() => {
    if (bedsStarted || !audio.loaded) return
    bedsStarted = true
    void audio
      .playMusic(game.state === 'play' ? 'music-game-ambient' : 'music-menu')
      .then((h) => {
        if (h) scheduledCount++
      })
      .catch((e: unknown) => console.error('[audio] music failed:', e))
    void sfxPlay('ambience-suburb-day') // looping bed, sfx bus
  })
}
addEventListener('pointerdown', startAudio, { once: true })
addEventListener('keydown', startAudio, { once: true })

/** menu ↔ game music crossfade (1.5s default) */
function setMusic(name: 'music-menu' | 'music-game-ambient'): void {
  if (!bedsStarted) return // startAudio picks the right bed once the manifest lands
  void audio
    .playMusic(name)
    .then((h) => {
      if (h) scheduledCount++
    })
    .catch((e: unknown) => console.error('[audio] music failed:', e))
}

// per-frame: listener follows the active camera; footstep/jump/land poller
const listenerFwd = new Vector3()
const listenerUp = new Vector3()
const audioFrameHook = (dt: number): void => {
  const cam = game.cam.camera
  cam.getWorldDirection(listenerFwd)
  listenerUp.set(0, 1, 0).applyQuaternion(cam.quaternion)
  audio.setListener(
    cam.position.x,
    cam.position.y,
    cam.position.z,
    listenerFwd.x,
    listenerFwd.y,
    listenerFwd.z,
    listenerUp.x,
    listenerUp.y,
    listenerUp.z,
  )
  const p = game.phys.players.get(game.localPlayerId)
  gameAudio.update(
    dt,
    p
      ? {
          px: p.px,
          py: p.py,
          pz: p.pz,
          vx: p.vx,
          vy: p.vy,
          vz: p.vz,
          grounded: p.char.GetGroundState() === game.phys.api.EGroundState_OnGround,
        }
      : null,
  )
}

// --- settings wiring (I.settings — live apply, render-layer only, V6) --------
const applyControls = () => {
  game.input.sensitivity = store.get('controls.sensitivity')
  game.input.invertY = store.get('controls.invertY')
}
const applyGraphics = () =>
  game.applyGraphics({ quality: store.get('graphics.quality'), fov: store.get('graphics.fov') })
store.subscribe('controls.sensitivity', applyControls)
store.subscribe('controls.invertY', applyControls)
store.subscribe('graphics.quality', applyGraphics)
store.subscribe('graphics.fov', applyGraphics)

let dev: DevOverlay | null = null
// T47 — noclip on N, dev-gated (deterministic sim op, lockstep-safe)
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyN' && (boot.dev || store.get('dev.profiling')) && game.state === 'play') {
    game.toggleNoclip()
  }
})
const syncDev = () => dev?.setEnabled(boot.dev || store.get('dev.profiling'))
store.subscribe('dev.profiling', syncDev)

// --- HUD + tools (T28) --------------------------------------------------------
const hud = new Hud(root)
const tools = new ToolController(game, hud, (e) => {
  // T52 — tool feedback → material-aware impact/explosion sounds
  switch (e.kind) {
    case 'dig':
    case 'place':
      gameAudio.onImpact(e.x, e.y, e.z, e.mat)
      break
    case 'shoot':
      gameAudio.onShoot()
      if (e.hit) gameAudio.onImpact(e.hit.x, e.hit.y, e.hit.z, e.hit.mat)
      break
    case 'explode':
      gameAudio.onExplosion(e.x, e.y, e.z, e.power)
      break
  }
})
hud.onSelect = () => void sfxPlay('ui-hotbar')
hud.setLockHint(false)

/**
 * T71 — bind all per-instance hooks to a (possibly new) Game. Called once at
 * boot and again when an MP session replaces the backdrop game. Everything
 * here must be idempotent per instance.
 */
function wireGame(g: Game): void {
  game = g
  gameAudio = new GameAudio({ play: sfxPlay }, g.sim.world)
  g.addFrameHook(audioFrameHook)
  applyControls()
  applyGraphics()
  // T54 — bomb detonations happen ticks after the throw: audio rides sim events
  g.onSimEvents = (events) => {
    for (const e of events) {
      if (e.kind === 'explosion') gameAudio.onExplosion(e.x, e.y, e.z, e.power)
    }
  }
  g.equippedTool = () => tools.equipped // T49 — FP viewmodel reads the hotbar
  g.onFlyChange = (f) => hud.setFly(f)
  g.onPlayerDamaged = () => {
    hud.damageFlash()
    gameAudio.onHurt()
  }
  tools.setGame(g)
  dev?.setEnabled(false)
  dev = new DevOverlay(g)
  syncDev()
}
wireGame(game)

// --- menus (T33) ----------------------------------------------------------------
let settingsReturn: 'menu' | 'pause' | null = null

const fullscreen = new FullscreenControl()
const quickHooks = {
  // mute flips the shared settings flag — Audio tab + both menus stay consistent
  onToggleMute: () => store.set('audio.muted', !store.get('audio.muted')),
  onToggleFullscreen: () => fullscreen.toggle(),
}

const settings = new SettingsPanel(root, store, boot, fullscreen)
const menu = new MainMenu(root, {
  seed: boot.seed,
  onPlay: () => startPlay(true),
  onHost: () => void hostFlow(),
  onJoin: () => void joinFlow(),
  onSettings: () => openSettings('menu'),
  ...quickHooks,
})
const pause = new PauseMenu(root, {
  onResume: resume,
  onSettings: () => openSettings('pause'),
  onQuit: quitToMenu,
  ...quickHooks,
})

const syncMuted = () => {
  const m = store.get('audio.muted')
  menu.setMuted(m)
  pause.setMuted(m)
}
store.subscribe('audio.muted', syncMuted)
syncMuted()
const syncFullscreen = (on: boolean) => {
  menu.setFullscreen(on)
  pause.setFullscreen(on)
}
fullscreen.onChange(syncFullscreen)
syncFullscreen(fullscreen.active)

attachUiSounds(root, { play: sfxPlay }) // hover/click/back on all menu controls

function lock(): void {
  // may reject during Chrome's post-Esc cooldown — the click hint stays available
  const p = game.renderer.domElement.requestPointerLock() as Promise<void> | undefined
  p?.catch(() => hud.setLockHint(true))
}

function startPlay(requestLock: boolean): void {
  menu.hide()
  game.enterPlay(store.get('gameplay.camera'))
  hud.show()
  setMusic('music-game-ambient')
  if (requestLock) lock()
  else hud.setLockHint(true)
}

function resume(): void {
  pause.hide()
  lock()
}

function quitToMenu(): void {
  if (mpSession) {
    // T71 — leaving a live lockstep session abandons the peers (host leave =
    // room dead). Clean slate is the only correct state: reload to menu.
    location.reload()
    return
  }
  pause.hide()
  hud.hide()
  game.enterOrbit()
  setMusic('music-menu')
  menu.show()
}

function openSettings(from: 'menu' | 'pause'): void {
  settingsReturn = from
  if (from === 'menu') menu.hide()
  else pause.hide()
  settings.show()
}

settings.onClose = () => {
  settings.hide()
  if (settingsReturn === 'pause') pause.show()
  else menu.show()
  settingsReturn = null
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return
  if (settings.visible) {
    settings.onClose?.()
    return
  }
  // B10: Esc while the pause menu is up resumes. Chrome may reject the
  // re-lock during its ~1.5s post-Esc cooldown — lock() falls back to the
  // click hint (click the canvas to re-lock).
  if (pause.visible && game.state === 'play') resume()
})

// U — unlock cursor WITHOUT pausing (regioned screenshots, dev). Click re-locks.
let screenshotUnlock = false
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyU' && game.state === 'play' && document.pointerLockElement) {
    screenshotUnlock = true
    document.exitPointerLock()
    hud.setLockHint(true)
  }
})

// pointer-lock lost in play (Esc) → pause menu
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === game.renderer.domElement
  if (locked) {
    hud.setLockHint(false)
    pause.hide()
    return
  }
  if (screenshotUnlock) {
    screenshotUnlock = false // deliberate unlock: no pause, HUD hint shows re-lock path
    return
  }
  if (game.state === 'play' && !settings.visible && settingsReturn === null) pause.show()
})

// ============================================================================
// T71 — multiplayer session wiring (I.net). Same-seed sessions only; late
// join is explicitly deferred (LockstepHost.addPeer throws after start).
// ============================================================================

const STALL_BANNER_AFTER_MS = 2000
const STALL_DROP_AFTER_MS = 30_000
const PING_INTERVAL_MS = 2000

interface MpSession {
  role: 'host' | 'guest'
  playerId: number
  code: string
  players: SessionPlayer[]
  dropped: Set<number>
  pings: Map<number, number>
  node: LockstepNode
  lockstepHost: LockstepHost | null
  verifiedTick: () => number
  desync: DesyncEvent | null
  lastHashes: { tick: number; hash: number }[]
}
let mpSession: MpSession | null = null

const mpLobby = new MpLobby(root, {
  onStart: () => mpOnStart?.(),
  onJoinCode: (code) => mpOnJoinCode?.(code),
  onLeave: () => location.reload(), // pre-session leave: clean slate (v1)
})
const netHud = new NetHud(root)
const stallBanner = new StallBanner(root)
const desyncOverlay = new DesyncOverlay(root)
let mpOnStart: (() => void) | null = null
let mpOnJoinCode: ((code: string) => void) | null = null

function mpFatal(title: string, lines: string[]): void {
  desyncOverlay.show(title, lines)
}

function onDesyncEvent(e: DesyncEvent): void {
  if (mpSession) mpSession.desync = e
  mpFatal(`Desync at tick ${e.tick}`, [
    'Peers disagree on sim state — the session is unrecoverable (V10).',
    ...e.hashes.map((h) => `${playerName(h.playerId)} &nbsp; hash 0x${h.hash.toString(16).padStart(8, '0')}`),
  ])
}

async function connectSignaling(): Promise<SignalingClient | null> {
  mpLobby.show('connecting')
  mpLobby.setStatus(boot.signalUrl)
  try {
    const sig = await SignalingClient.connect(boot.signalUrl)
    sig.onError = (err) => {
      console.error('[net]', err)
      if (mpSession) mpFatal('Connection lost', [err.message])
      else mpLobby.setStatus(`error: ${err.message}`)
    }
    return sig
  } catch (e) {
    mpLobby.setStatus(`cannot reach signal server at ${boot.signalUrl} — is \`npm run signal\` up?`)
    console.error('[net] signaling connect failed:', e)
    return null
  }
}

/** dispose the backdrop game, build the session game on the shared seed */
async function buildMpGame(seed: number): Promise<Game> {
  const mpPre = new Preloader(root, seed)
  game.dispose() // backdrop game: sim already ticked past 0, useless for lockstep
  const g = await Game.create({
    seed,
    host: app,
    onStage: (s) => mpPre.stage(s),
    graphics: { quality: store.get('graphics.quality'), fov: store.get('graphics.fov') },
    holdTicks: true, // sim stays pristine at tick 0 until attachNet (V2)
  }).catch((e: unknown) => die(`mp boot failed: ${e instanceof Error ? e.message : String(e)}`))
  wireGame(g)
  await mpPre.done()
  return g
}

/** memoized per tick: combined hash feeds detector + reporter + __bbNet */
function makeHashFn(g: Game): () => number {
  let atTick = -1
  let value = 0
  return () => {
    if (g.sim.tick !== atTick) {
      atTick = g.sim.tick
      value = combinedHash(g.sim, g.phys, g.water)
    }
    return value
  }
}

function recordCheckpointHashes(s: MpSession, hashFn: () => number): void {
  s.node.onStep((sim) => {
    if (sim.tick % DEFAULT_HASH_INTERVAL !== 0) return
    s.lastHashes.push({ tick: sim.tick, hash: hashFn() })
    if (s.lastHashes.length > 200) s.lastHashes.shift()
  })
}

/** common post-wiring: HUD, monitors, ping, debug handle, enter play */
function finishSessionStart(s: MpSession, pingSend: (n: number) => void): void {
  mpSession = s
  s.node.onPlayerDropped((pid) => {
    s.dropped.add(pid)
    stallBanner.toast(`${playerName(pid)} lost — continuing without them`)
  })
  pause.setMpSession(true)
  mpLobby.hide()
  startPlay(true)
  netHud.show()

  // presence + stall monitor
  const stallSince = new Map<number, number>()
  let lastTick = -1
  let lastTickAt = performance.now()
  setInterval(() => {
    const now = performance.now()
    if (game.sim.tick !== lastTick) {
      lastTick = game.sim.tick
      lastTickAt = now
    }
    // stall UX
    if (s.role === 'host' && s.lockstepHost) {
      const waiting = s.lockstepHost.waitingOn().filter((pid) => pid !== s.playerId)
      for (const pid of waiting) if (!stallSince.has(pid)) stallSince.set(pid, now)
      for (const pid of [...stallSince.keys()]) if (!waiting.includes(pid)) stallSince.delete(pid)
      let worst: { pid: number; ms: number } | null = null
      for (const [pid, since] of stallSince) {
        const ms = now - since
        if (ms >= STALL_DROP_AFTER_MS) {
          // T71 — deterministic empty-input substitution, announced in-bundle
          s.lockstepHost.dropPlayer(pid)
          stallSince.delete(pid)
          continue
        }
        if (!worst || ms > worst.ms) worst = { pid, ms }
      }
      if (worst && worst.ms >= STALL_BANNER_AFTER_MS) {
        stallBanner.show(playerName(worst.pid), Math.round(worst.ms / 1000))
      } else if (!s.desync) stallBanner.hide()
    } else if (s.role === 'guest') {
      const ms = now - lastTickAt
      if (ms >= STALL_BANNER_AFTER_MS) stallBanner.show('host', Math.round(ms / 1000))
      else if (!s.desync) stallBanner.hide()
    }
    // presence chips
    netHud.update(
      s.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        local: p.playerId === s.playerId,
        ping: s.pings.get(p.playerId) ?? null,
        dropped: s.dropped.has(p.playerId),
      })),
      s.verifiedTick(),
    )
  }, 500)

  // ping (ss/ping n = send timestamp, echoed back verbatim)
  setInterval(() => pingSend(Math.round(performance.now())), PING_INTERVAL_MS)

  // T72 — CDP debug handle (read-side + sanctioned op injection via pushOp)
  ;(window as unknown as { __bbNet: unknown }).__bbNet = {
    get role() {
      return s.role
    },
    get playerId() {
      return s.playerId
    },
    get code() {
      return s.code
    },
    get tick() {
      return game.sim.tick
    },
    get running() {
      return true
    },
    get verifiedTick() {
      return s.verifiedTick()
    },
    get desync() {
      return s.desync
    },
    get lastHashes() {
      return s.lastHashes
    },
    get players() {
      return s.players
    },
    playerPos: () => {
      const p = game.phys.players.get(s.playerId)
      return p ? { x: p.px, y: p.py, z: p.pz } : null
    },
    /**
     * T72 — full kinematic player state, all players. Player capsules are in
     * NEITHER hashSim NOR hashPhysics (missing export, reported in
     * INTEGRATION-net.md) — the e2e compares this across pages instead.
     */
    playersState: () =>
      [...game.phys.players.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pid, p]) => ({
          pid,
          x: p.px,
          y: p.py,
          z: p.pz,
          vx: p.vx,
          vy: p.vy,
          vz: p.vz,
          yaw: p.yaw,
          flags: p.flags,
        })),
    submitOp: (op: Op) => game.pushOp(op),
  }
}

// --- host flow ----------------------------------------------------------------
async function hostFlow(): Promise<void> {
  menu.hide()
  const sig = await connectSignaling()
  if (!sig) return
  const lobby = new HostLobby(boot.seed, DEFAULT_INPUT_DELAY)
  const allReady = new Promise<void>((res) => (lobby.onAllReady = res))
  const peerToPlayer = new Map<number, number>()

  mpLobby.setMode('host')
  mpLobby.setPlayers(lobby.players)
  mpLobby.setStatus(`seed ${lobby.seed} · ${boot.signalUrl}`)
  lobby.onChange = (players) => {
    mpLobby.setPlayers(players)
    if (mpSession) mpSession.players = players
  }
  sig.onPeerLeft = (peerId) => {
    const pid = peerToPlayer.get(peerId)
    if (pid === undefined) return
    if (lobby.state === 'lobby') lobby.removePeer(pid)
    else mpSession?.lockstepHost?.dropPlayer(pid) // faster than the 30s stall timeout
  }
  const code = await sig.hostRoom((peerId, channel) => {
    try {
      peerToPlayer.set(peerId, lobby.addPeer(channel))
    } catch (e) {
      console.error('[net] peer rejected:', e) // room full / already started
    }
  })
  mpLobby.setCode(code)

  mpOnStart = () => {
    mpOnStart = null
    lobby.start()
    mpLobby.setMode('starting')
    void (async () => {
      const g = await buildMpGame(lobby.seed)
      const lockstep = new LockstepHost(g.sim, HOST_PLAYER_ID, lobby.inputDelay)
      const hashFn = makeHashFn(g)
      const detector = new DesyncDetectorHost(g.sim, HOST_PLAYER_ID, DEFAULT_HASH_INTERVAL, hashFn)
      for (const { playerId, channel } of lobby.peerChannels) {
        lockstep.addPeer(playerId, channel)
        detector.addPeer(playerId, channel)
      }
      lockstep.node.onStep(() => detector.afterStep())
      detector.onDesync(onDesyncEvent)
      g.localPlayerId = HOST_PLAYER_ID
      g.attachNet({ node: lockstep.node, driver: new LockstepDriver() })

      const s: MpSession = {
        role: 'host',
        playerId: HOST_PLAYER_ID,
        code,
        players: lobby.players,
        dropped: new Set(),
        pings: new Map(),
        node: lockstep.node,
        lockstepHost: lockstep,
        verifiedTick: () => detector.lastVerifiedTick,
        desync: null,
        lastHashes: [],
      }
      recordCheckpointHashes(s, hashFn)
      lobby.onPong = (pid, n) => s.pings.set(pid, Math.max(0, Math.round(performance.now() - n)))

      // readiness barrier: every guest has built its game + wired listeners
      await allReady
      lockstep.start()
      finishSessionStart(s, (n) => {
        for (const { playerId } of lobby.peerChannels) if (!s.dropped.has(playerId)) lobby.ping(playerId, n)
      })
    })()
  }
}

// --- guest flow -----------------------------------------------------------------
async function joinFlow(): Promise<void> {
  menu.hide()
  const sig = await connectSignaling()
  if (!sig) return
  mpLobby.setMode('join')

  const tryJoin = (code: string): void => {
    mpOnJoinCode = null // one attempt in flight
    mpLobby.setJoinError('')
    mpLobby.setStatus('connecting to host…')
    // NOTE: a bad code / full room surfaces via sig.onError (the server's
    // error message), not a joinRoom rejection — see the handler below.
    void (async () => {
      const { channel } = await sig.joinRoom(code)
      // construct synchronously after join — the host's hello races the listener
      const guest = new GuestLobby(channel)
      mpLobby.setMode('guest')
      mpLobby.setCode(code)
      mpLobby.setStatus(boot.signalUrl)
      guest.onChange = (players) => {
        mpLobby.setPlayers(players)
        if (mpSession) mpSession.players = players
      }
      guest.onStart = () => {
        mpLobby.setMode('starting')
        void (async () => {
          const hello = guest.hello
          if (!hello) return die('mp: host started the session before the hello arrived')
          const g = await buildMpGame(hello.seed)
          const client = new LockstepClient(g.sim, hello.playerId, channel, hello.inputDelay)
          const hashFn = makeHashFn(g)
          const reporter = new DesyncReporter(g.sim, hello.playerId, channel, DEFAULT_HASH_INTERVAL, hashFn)
          client.node.onStep(() => reporter.afterStep())
          reporter.onDesync(onDesyncEvent)
          g.localPlayerId = hello.playerId
          g.attachNet({ node: client.node, driver: new LockstepDriver() })

          const s: MpSession = {
            role: 'guest',
            playerId: hello.playerId,
            code,
            players: guest.players,
            dropped: new Set(),
            pings: new Map(),
            node: client.node,
            lockstepHost: null,
            verifiedTick: () => lastGuestVerified,
            desync: null,
            lastHashes: [],
          }
          let lastGuestVerified = -1
          // guests have no detector; "verified" = last checkpoint we reported
          client.node.onStep((sim) => {
            if (sim.tick % DEFAULT_HASH_INTERVAL === 0) lastGuestVerified = sim.tick
          })
          recordCheckpointHashes(s, hashFn)
          guest.onPong = (n) => s.pings.set(HOST_PLAYER_ID, Math.max(0, Math.round(performance.now() - n)))

          guest.sendReady() // listeners are wired — host may open the tick stream
          finishSessionStart(s, (n) => guest.ping(n))
        })()
      }
    })()
  }
  mpOnJoinCode = tryJoin

  // bad code / room full arrive as server error messages → re-arm code entry
  sig.onError = (err) => {
    console.error('[net]', err)
    if (mpSession) {
      mpFatal('Connection lost', [err.message])
      return
    }
    if (mpLobby.visible && mpOnJoinCode === null) {
      mpLobby.setJoinError(err.message.replace(/^signaling: /, ''))
      mpLobby.setMode('join')
      mpLobby.setStatus('')
      mpOnJoinCode = tryJoin
    } else {
      mpLobby.setStatus(`error: ${err.message}`)
    }
  }
}

// --- T52 debug handle (CDP audio verification — read-side state only) ---------
;(window as unknown as { __bbAudio: unknown }).__bbAudio = {
  engine: audio,
  store,
  get ctxState() {
    return audioDebug.ctx?.state ?? 'none'
  },
  get busGains() {
    return audioDebug.buses.map((g) => g.gain.value)
  },
  get scheduled() {
    return scheduledCount
  },
}

// --- phase 3: route (I.boot) ---------------------------------------------------
await pre.done()
if (boot.mode === 'game') {
  // agent/CDP smoke path — no user gesture available, hint until first click
  startPlay(false)
} else {
  menu.show()
}
