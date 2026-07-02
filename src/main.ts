/**
 * T31 — boot orchestration (I.boot). Thin by design:
 *   1. capability check (WebGPU, fail loud)
 *   2. preloader → Game.create (real progress stages)
 *   3. route by URL params: ?boot=game&seed=N straight into gameplay
 *      (agent/CDP smoke path), ?dev=1 profiling overlay, default → menu.
 * All sim/render wiring lives in src/game.ts; all UI in src/ui/**.
 */
import './ui/style.css'
import { Game } from './game'
import { parseBootParams } from './ui/boot-params'
import { SettingsStore } from './ui/settings-store'
import { Preloader } from './ui/preloader'
import { Hud } from './ui/hud'
import { ToolController } from './ui/tools'
import { MainMenu, PauseMenu } from './ui/menu'
import { SettingsPanel } from './ui/settings-panel'
import { DevOverlay } from './ui/dev-overlay'

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

// --- phase 2: preloader + game construction ----------------------------------
const pre = new Preloader(root, boot.seed)
const game = await Game.create({
  seed: boot.seed,
  host: app,
  onStage: (s) => pre.stage(s),
  graphics: { quality: store.get('graphics.quality'), fov: store.get('graphics.fov') },
}).catch((e: unknown) => die(`boot failed: ${e instanceof Error ? e.message : String(e)}`))

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

const dev = new DevOverlay(game)
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
new ToolController(game, hud)
game.onFlyChange = (f) => hud.setFly(f)
game.onPlayerDamaged = () => hud.damageFlash()
hud.setLockHint(false)

// --- menus (T33) ----------------------------------------------------------------
let settingsReturn: 'menu' | 'pause' | null = null

const settings = new SettingsPanel(root, store, boot)
const menu = new MainMenu(root, {
  seed: boot.seed,
  onPlay: () => startPlay(true),
  onSettings: () => openSettings('menu'),
})
const pause = new PauseMenu(root, {
  onResume: resume,
  onSettings: () => openSettings('pause'),
  onQuit: quitToMenu,
})

function lock(): void {
  // may reject during Chrome's post-Esc cooldown — the click hint stays available
  const p = game.renderer.domElement.requestPointerLock() as Promise<void> | undefined
  p?.catch(() => hud.setLockHint(true))
}

function startPlay(requestLock: boolean): void {
  menu.hide()
  game.enterPlay(store.get('gameplay.camera'))
  hud.show()
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
  if (e.code === 'Escape' && settings.visible) settings.onClose?.()
})

// pointer-lock lost in play (Esc) → pause menu
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === game.renderer.domElement
  if (locked) {
    hud.setLockHint(false)
    pause.hide()
    return
  }
  if (game.state === 'play' && !settings.visible && settingsReturn === null) pause.show()
})

// --- phase 3: route (I.boot) ---------------------------------------------------
await pre.done()
if (boot.mode === 'game') {
  // agent/CDP smoke path — no user gesture available, hint until first click
  startPlay(false)
} else {
  menu.show()
}
