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
 */
import { Vector3 } from 'three/webgpu'
import './ui/style.css'
import { Game, LOCAL_PLAYER } from './game'
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
import { MapSystem } from './ui/map/map-system'
import { adaptLayout } from './ui/map/layout-adapter'
import { installVehicleDevControls } from './render/vehicle-meshes'
import { generateLayout } from './sim/gen/layout'
import { WORLD_VX, WORLD_VZ } from './world/chunks'

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
const pre = new Preloader(root, boot.seed)
const game = await Game.create({
  seed: boot.seed,
  host: app,
  onStage: (s) => pre.stage(s),
  graphics: { quality: store.get('graphics.quality'), fov: store.get('graphics.fov') },
}).catch((e: unknown) => die(`boot failed: ${e instanceof Error ? e.message : String(e)}`))

const gameAudio = new GameAudio({ play: sfxPlay }, game.sim.world)

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
game.addFrameHook((dt) => {
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
  const p = game.phys.players.get(LOCAL_PLAYER)
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
})

// --- settings wiring (I.settings — live apply, render-layer only, V6) --------
const applyControls = () => {
  game.input.sensitivity = store.get('controls.sensitivity')
  game.input.invertY = store.get('controls.invertY')
}
const applyGraphics = () =>
  game.applyGraphics({ quality: store.get('graphics.quality'), fov: store.get('graphics.fov') })
applyControls()
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
game.addFrameHook(() => {
  const pl = game.phys.players.get(LOCAL_PLAYER)
  const v = pl && pl.seatedVehicle !== 0 ? game.phys.vehicles.get(pl.seatedVehicle) : undefined
  if (!v || !audio.unlocked || !audio.loaded) {
    if (vloops.engine || vloops.skid) stopVehicleLoops()
    return
  }
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
})

game.addFrameHook(() => {
  map.setVisible(game.state === 'play')
  const p = game.phys.players.get(LOCAL_PLAYER)
  if (p && game.state === 'play') map.update(p.px, p.pz, p.yaw)
})
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && game.state === 'play' && !settings.visible) map.toggleFullscreen()
  if (e.code === 'KeyL' && game.state === 'play') game.flashlight.toggle() // T75
})

const dev = new DevOverlay(game)
// T64 — vehicle dev controls: KeyG summon (dev-gated), Enter enter/exit
installVehicleDevControls(game.sim, game.phys, LOCAL_PLAYER, () => boot.dev || store.get('dev.profiling'))

// T47 — noclip on N, dev-gated (deterministic sim op, lockstep-safe)
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyN' && (boot.dev || store.get('dev.profiling')) && game.state === 'play') {
    game.toggleNoclip()
  }
})
const syncDev = () => dev.setEnabled(boot.dev || store.get('dev.profiling'))
store.subscribe('dev.profiling', syncDev)
syncDev()

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
// T54 — bomb detonations happen ticks after the throw: audio rides sim events
game.phys.onSplash = (e) => {
  void sfxPlay(e.speed > 5 ? 'splash-large' : 'splash-small', {
    position: { x: e.x, y: e.y, z: e.z },
    volume: Math.min(1, 0.4 + e.speed * 0.08),
  })
}
game.onSimEvents = (events) => {
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
game.equippedTool = () => tools.equipped // T49 — FP viewmodel reads the hotbar
game.onFlyChange = (f) => hud.setFly(f)
game.onPlayerDamaged = () => {
  hud.damageFlash()
  gameAudio.onHurt()
}
hud.setLockHint(false)

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
  if (game.state === 'play' && !settings.visible && settingsReturn === null && !map.isOpen) pause.show()
})

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
