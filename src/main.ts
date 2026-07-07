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
import { TodGizmo } from './ui/tod-gizmo'
import { ToolController } from './ui/tools'
import { MainMenu, PauseMenu } from './ui/menu'
import { SettingsPanel } from './ui/settings-panel'
import { DevOverlay } from './ui/dev-overlay'
import { wireAudioSettings, attachUiSounds } from './ui/audio-wiring'
import { FullscreenControl } from './ui/fullscreen'
import { MapSystem } from './ui/map/map-system'
import { adaptLayout } from './ui/map/layout-adapter'
import { installVehicleDevControls } from './render/vehicle-meshes'
import { generateLayout } from './sim/gen/layout'
import { WORLD_VX, WORLD_VZ } from './world/chunks'
import { MpLobby, NetHud, StallBanner, DesyncOverlay } from './ui/mp'
import { SignalingClient, type Signaling } from './net/signaling'
import { PeerSignalingClient } from './net/peer-signaling'
import { GuestLobby, HostLobby, HOST_PLAYER_ID, playerName, type SessionPlayer } from './net/session'
import { LockstepClient, LockstepDriver, LockstepHost, DEFAULT_INPUT_DELAY, type LockstepNode } from './net/lockstep'
import { DesyncDetectorHost, DesyncReporter, DEFAULT_HASH_INTERVAL, type DesyncEvent } from './net/desync'
import { combinedHash } from './net/combined-hash'
import type { DataChannelAdapter } from './net/signaling'
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

// T65 — time-of-day controls drive the T58 cycle live (render-only, V6)
const applyTime = () => {
  const t = store.get('dev.timeOfDay')
  game.world.cycle.overrideHours = t < 0 ? null : t
}
const applyCycleSpeed = () => game.world.setCycleSpeed(store.get('dev.cycleSpeed'))
applyTime()
applyCycleSpeed()
store.subscribe('dev.timeOfDay', applyTime)
store.subscribe('dev.cycleSpeed', applyCycleSpeed)

// T70 — map + minimap (layout regenerated: pure fn of seed, cheap vs restamping)
const map = new MapSystem(adaptLayout(generateLayout(boot.seed)), { vx: WORLD_VX, vz: WORLD_VZ })
map.attach(root)
map.setVisible(false) // hidden until play (user nit: no minimap over the menu)
// T64 — continuous vehicle audio: engine/skid loops follow the seated vehicle
type LoopHandle = { gain: { gain: { value: number } }; source: { playbackRate?: { value: number } }; stop: (f?: number) => void }
const vloops: { engine: LoopHandle | null; skid: LoopHandle | null; arch: string } = { engine: null, skid: null, arch: '' }
function stopVehicleLoops(): void {
  vloops.engine?.stop(0.3)
  vloops.skid?.stop(0.15)
  vloops.engine = vloops.skid = null
}
const vehicleAudioHook = (): void => {
  const pl = game.phys.players.get(game.localPlayerId)
  const v = pl && pl.seatedVehicle !== 0 ? game.phys.vehicles.get(pl.seatedVehicle) : undefined
  const ac = pl && pl.seatedAircraft !== 0 ? game.phys.aircraft.get(pl.seatedAircraft) : undefined
  if ((!v && !ac) || !audio.unlocked || !audio.loaded) {
    if (vloops.engine || vloops.skid) stopVehicleLoops()
    return
  }
  // P17 — plane prop engine: a steady drone pitched by throttle + airspeed
  if (ac) {
    if (vloops.arch !== 'plane' && (vloops.engine || vloops.skid)) stopVehicleLoops()
    vloops.arch = 'plane'
    if (!vloops.engine) {
      void audio.play('engine-rev-loop', { volume: 0.0001 }).then((h) => { if (h) vloops.engine = h as unknown as LoopHandle })
    } else {
      const spd = Math.hypot(ac.vx, ac.vy, ac.vz)
      const t = Math.min(1, ac.throttle * 0.7 + spd / 60)
      vloops.engine.gain.gain.value = 0.3 + 0.5 * t
      if (vloops.engine.source.playbackRate) vloops.engine.source.playbackRate.value = 1.15 + 0.7 * t
    }
    return
  }
  if (!v) return // (narrowing: past the aircraft branch, a seated vehicle exists)
  const speed = Math.hypot(v.vx, v.vy, v.vz)
  const arch = v.archetype
  if (vloops.arch !== arch && (vloops.engine || vloops.skid)) stopVehicleLoops()
  vloops.arch = arch
  const loopName =
    arch === 'bicycle' ? (speed > 1 ? 'bicycle-freewheel-loop' : 'bicycle-chain-loop')
    : arch === 'scooter' ? 'scooter-engine-loop'
    : 'engine-rev-loop'
  if (!vloops.engine) {
    void audio.play(loopName, { volume: 0.0001 }).then((h) => { if (h) vloops.engine = h as unknown as LoopHandle })
  } else {
    const top = arch === 'bicycle' ? 7 : arch === 'scooter' ? 13 : 21
    vloops.engine.gain.gain.value = arch === 'bicycle' ? 0.35 : Math.min(0.8, 0.25 + (speed / top) * 0.6)
    if (vloops.engine.source.playbackRate) vloops.engine.source.playbackRate.value = 0.75 + 0.85 * (speed / top)
  }
  const slip = Math.max(0, ...v.wheels.map((w) => w.slip))
  const skidGain = speed > 4 ? Math.min(1, Math.max(0, (slip - 1.2) / 3)) : 0
  if (skidGain > 0 && !vloops.skid) {
    void audio.play('skid-loop', { volume: 0.0001 }).then((h) => { if (h) vloops.skid = h as unknown as LoopHandle })
  } else if (vloops.skid) {
    if (skidGain <= 0) { vloops.skid.stop(0.15); vloops.skid = null }
    else vloops.skid.gain.gain.value = skidGain * 0.7
  }
}

// T64 — contextual `Enter` prompt: nearest free vehicle within reach, on foot only
const promptHook = (): void => {
  if (game.state !== 'play') return hud.setPrompt(null)
  const p = game.phys.players.get(game.localPlayerId)
  if (!p) return hud.setPrompt(null)
  if (p.seatedVehicle !== 0) return hud.setPrompt({ hotkey: 'Enter', action: 'Exit vehicle' })
  if (p.seatedAircraft !== 0) return hud.setPrompt({ hotkey: 'Enter', action: 'Exit plane' })
  let near = false
  let arch = ''
  for (const v of game.phys.vehicles.values()) {
    const dx = v.px - p.px
    const dy = v.py - p.py
    const dz = v.pz - p.pz
    if (dx * dx + dy * dy + dz * dz < 16) {
      near = true
      arch = v.archetype
      break
    }
  }
  // P17 — aircraft are big; a roomier reach so you can board from a wingtip
  let nearPlane = false
  for (const a of game.phys.aircraft.values()) {
    const dx = a.px - p.px
    const dy = a.py - p.py
    const dz = a.pz - p.pz
    if (dx * dx + dy * dy + dz * dz < 64) {
      nearPlane = true
      break
    }
  }
  hud.setPrompt(
    nearPlane
      ? { hotkey: 'Enter', action: 'Fly' }
      : near
        ? { hotkey: 'Enter', action: arch === 'bicycle' ? 'Ride bike' : arch === 'scooter' ? 'Ride scooter' : 'Drive' }
        : null,
  )
}

const mapHook = (): void => {
  map.setVisible(game.state === 'play')
  const p = game.phys.players.get(game.localPlayerId)
  if (p && game.state === 'play') map.update(p.px, p.pz, p.yaw)
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && game.state === 'play' && !settings.visible) map.toggleFullscreen()
  if (e.code === 'KeyL' && game.state === 'play') game.flashlight.toggle() // T75
})

let dev: DevOverlay | null = null
// T64 — vehicle dev controls: KeyG summon (dev-gated), Enter enter/exit.
// Re-installed per game instance by wireGame; uninstall fn guards duplicates.
let uninstallVehicleControls: (() => void) | null = null

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
    case 'rocket': // P19 — launch report; the impact boom rides explosion events
      gameAudio.onShoot()
      break
    case 'tnt_place': // P19 — soft click as the charge is set down
      void sfxPlay('ui-hotbar', { position: { x: e.x, y: e.y, z: e.z }, volume: 0.5 })
      break
    case 'tnt_detonate': // P19 — chained booms ride the sim explosion events
      break
  }
})
hud.onSelect = () => void sfxPlay('ui-hotbar')
hud.setLockHint(false)

// Cinematic mode (H) — hide ALL overlay UI (HUD, hotbar, crosshair, net HUD,
// TOD gizmo, dev panel) for clean screenshots / video. Toggles a body class;
// `#fatal` stays top-level and visible, and any session-death or pause exits
// cinematic (see mpFatal + the pause branch below) so V10 failures never hide.
let cinematic = false
function setCinematic(on: boolean): void {
  cinematic = on
  document.body.classList.toggle('bb-cinematic', on)
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyH' && game.state === 'play') setCinematic(!cinematic)
})

// B37 — in-game time-of-day gizmo (sun/moon arc + clock + scrub/pause controls)
const todGizmo = new TodGizmo(() => game.world.sky, store)
root.appendChild(todGizmo.el)
game.addFrameHook(() => todGizmo.update())

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
  // T54/T64 — detonations + vehicle one-shots ride sim events (V6)
  g.onSimEvents = (events) => {
    for (const e of events) {
      switch (e.kind) {
        case 'explosion':
          gameAudio.onExplosion(e.x, e.y, e.z, e.power)
          break
        case 'vehicle_crash':
          void sfxPlay(e.large ? 'car-crash-large' : 'car-crash-small', {
            position: { x: e.x, y: e.y, z: e.z },
            volume: Math.min(1, 0.35 + e.dv * 0.06),
          })
          break
        case 'vehicle_door':
          void sfxPlay('car-door-open', { position: { x: e.x, y: e.y, z: e.z } })
          if (e.enter) setTimeout(() => void sfxPlay('car-door-close', { position: { x: e.x, y: e.y, z: e.z } }), 350)
          break
        case 'vehicle_wheel_loss':
          void sfxPlay('car-crash-small', { position: { x: e.x, y: e.y, z: e.z } })
          void sfxPlay('impact-metal', { position: { x: e.x, y: e.y, z: e.z } })
          break
      }
    }
  }
  // T60 — swim splashes (positional)
  g.phys.onSplash = (e) => {
    void sfxPlay(e.speed > 5 ? 'splash-large' : 'splash-small', {
      position: { x: e.x, y: e.y, z: e.z },
      volume: Math.min(1, 0.4 + e.speed * 0.08),
    })
  }
  // T64 engine/skid loops + T70 minimap follow the CURRENT game instance
  stopVehicleLoops()
  g.addFrameHook(vehicleAudioHook)
  g.addFrameHook(mapHook)
  g.addFrameHook(promptHook)
  // T65 — re-apply time-of-day + cycle speed to the new world renderer
  applyTime()
  applyCycleSpeed()
  // T64 — vehicle dev controls bound to the current instance
  uninstallVehicleControls?.()
  uninstallVehicleControls = installVehicleDevControls(g.sim, g.phys, g.localPlayerId, () => boot.dev || store.get('dev.profiling'))
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
  if (game.state === 'play' && !settings.visible && settingsReturn === null && !map.isOpen) {
    if (cinematic) setCinematic(false) // reveal UI when the session pauses
    pause.show()
  }
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
  /** transport triage (mp-e2e): playerId → channel (DataChannelAdapter live) */
  channels: { playerId: number; channel: Channel }[]
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
  setCinematic(false) // V10: session-death UI must never be hidden by cinematic
  desyncOverlay.show(title, lines)
}

/** transport death is never silent (V10): host drops the peer, guest gets the overlay */
function watchChannelClose(channel: Channel, onDead: () => void): void {
  if ('onClose' in channel) (channel as DataChannelAdapter).onClose(onDead)
}

function onDesyncEvent(e: DesyncEvent): void {
  if (mpSession) mpSession.desync = e
  mpFatal(`Desync at tick ${e.tick}`, [
    'Peers disagree on sim state — the session is unrecoverable (V10).',
    ...e.hashes.map((h) => `${playerName(h.playerId)} &nbsp; hash 0x${h.hash.toString(16).padStart(8, '0')}`),
  ])
}

/** ws://|wss:// → self-hosted signal server; anything else → PeerJS cloud broker */
const usesWsServer = /^wss?:\/\//.test(boot.signalUrl)

async function connectSignaling(): Promise<Signaling | null> {
  mpLobby.show('connecting')
  mpLobby.setStatus(boot.signalUrl)
  try {
    const sig = usesWsServer
      ? await SignalingClient.connect(boot.signalUrl)
      : await PeerSignalingClient.connect(boot.signalUrl)
    sig.onError = (err) => {
      console.error('[net]', err)
      if (mpSession) mpFatal('Connection lost', [err.message])
      else mpLobby.setStatus(`error: ${err.message}`)
    }
    return sig
  } catch (e) {
    mpLobby.setStatus(
      usesWsServer
        ? `cannot reach signal server at ${boot.signalUrl} — is \`npm run signal\` up?`
        : `cannot reach PeerJS broker — check your connection`,
    )
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

  // rAF heartbeat — distinguishes "barrier stalled" from "render loop dead"
  let frames = 0
  game.addFrameHook(() => frames++)

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
    get frames() {
      return frames
    },
    get maxRafGapMs() {
      return Math.round(game.maxRafGapMs)
    },
    get canStep() {
      return s.node.canStep
    },
    get waitingOn() {
      return s.lockstepHost?.waitingOn() ?? null
    },
    get channelStats() {
      return s.channels.map(({ playerId, channel }) => {
        const c = channel as Partial<DataChannelAdapter>
        return {
          playerId,
          sent: c.sent ?? -1,
          received: c.received ?? -1,
          buffered: c.bufferedAmount ?? -1,
          state: c.readyState ?? 'n/a',
        }
      })
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
      const pid = lobby.addPeer(channel)
      peerToPlayer.set(peerId, pid)
      watchChannelClose(channel, () => {
        if (lobby.state === 'lobby') lobby.removePeer(pid)
        else mpSession?.lockstepHost?.dropPlayer(pid)
      })
    } catch (e) {
      console.error('[net] peer rejected:', e) // room full / already started
    }
  }, boot.transport)
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
        channels: [...lobby.peerChannels],
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
      const { channel } = await sig.joinRoom(code, boot.transport)
      // construct synchronously after join — the host's hello races the listener
      const guest = new GuestLobby(channel)
      watchChannelClose(channel, () =>
        mpFatal('Connection lost', ['The channel to the host closed — session over.']),
      )
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
            channels: [{ playerId: HOST_PLAYER_ID, channel }],
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

// --- T86 dev handle (CDP single-player probes): sanctioned op injection via the
// SAME pushOp path __bbNet uses, + debris-layer counters. Dev-gated (I.boot). ---
if (boot.dev) {
  ;(window as unknown as { __bbDev: unknown }).__bbDev = {
    submitOp: (op: Op) => game.pushOp(op),
    get tick() {
      return game.sim.tick
    },
    get debris() {
      return {
        bodies: game.phys.debris?.bodies.size ?? 0,
        frozen: game.phys.debris?.frozen.size ?? 0,
        active: game.phys.debris?.activeCount ?? 0,
      }
    },
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
