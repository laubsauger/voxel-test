/**
 * T33 — main menu + pause menu. Full-screen DOM overlays over the live
 * scene (the game keeps rendering its cinematic orbit behind the menu).
 * Title 'BLOCKBURB' is a working-title placeholder (see INTEGRATION-ui.md).
 *
 * T52 — both menus carry quick-access icon buttons: mute (drives
 * settings.audio.muted so the Audio tab stays consistent) and fullscreen
 * (live document state, transient — see fullscreen.ts).
 */

import { createSocialFooter } from './social-footer'

const ICON_SOUND_ON =
  '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>'
const ICON_SOUND_OFF = '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m16.5 9.5 5 5M21.5 9.5l-5 5"/>'
const ICON_FS_ENTER =
  '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
const ICON_FS_EXIT =
  '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'

export interface QuickAccessHooks {
  onToggleMute: () => void
  onToggleFullscreen: () => void
}

/** shared quick-access strip (mute + fullscreen icon buttons) */
class QuickAccess {
  readonly el: HTMLElement
  private readonly muteBtn: HTMLButtonElement
  private readonly fsBtn: HTMLButtonElement

  constructor(hooks: QuickAccessHooks) {
    this.el = document.createElement('div')
    this.el.className = 'bb-quick'
    this.el.innerHTML = `
      <button class="bb-icon-btn" data-act="mute" title="Mute" aria-label="Mute">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICON_SOUND_ON}</svg>
      </button>
      <button class="bb-icon-btn" data-act="fullscreen" title="Fullscreen" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICON_FS_ENTER}</svg>
      </button>`
    this.muteBtn = this.el.querySelector('[data-act="mute"]') as HTMLButtonElement
    this.fsBtn = this.el.querySelector('[data-act="fullscreen"]') as HTMLButtonElement
    this.muteBtn.addEventListener('click', hooks.onToggleMute)
    this.fsBtn.addEventListener('click', hooks.onToggleFullscreen)
  }

  setMuted(muted: boolean): void {
    this.muteBtn.classList.toggle('bb-off', muted)
    this.muteBtn.title = muted ? 'Unmute' : 'Mute'
    this.muteBtn.querySelector('svg')!.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON
  }

  setFullscreen(active: boolean): void {
    this.fsBtn.title = active ? 'Exit fullscreen' : 'Fullscreen'
    this.fsBtn.querySelector('svg')!.innerHTML = active ? ICON_FS_EXIT : ICON_FS_ENTER
  }
}

export interface MainMenuHooks extends QuickAccessHooks {
  seed: number
  onPlay: () => void
  onSettings: () => void
}

export class MainMenu {
  private readonly el: HTMLElement
  private readonly quick: QuickAccess

  constructor(root: HTMLElement, hooks: MainMenuHooks) {
    this.el = document.createElement('div')
    this.el.className = 'bb-screen bb-menu bb-leave'
    this.el.innerHTML = `
      <div class="bb-logo">
        <span class="bb-logo-kicker">Demolition Sandbox</span>
        <span class="bb-logo-word">BLOCK<em>BURB</em></span>
        <span class="bb-hazard"></span>
      </div>
      <nav class="bb-menu-items">
        <button class="bb-menu-item" data-act="play"><span class="bb-mi-index">01</span>Play</button>
        <button class="bb-menu-item" data-act="join" disabled>
          <span class="bb-mi-index">02</span>Join Game<span class="bb-mi-tag">Soon</span>
        </button>
        <button class="bb-menu-item" data-act="settings"><span class="bb-mi-index">03</span>Settings</button>
      </nav>
      <div class="bb-menu-footer">
        <div class="bb-social-slot"></div>
        <div class="bb-menu-meta">
          <span>seed <b>${hooks.seed}</b></span>
          <span>build <b>${import.meta.env.MODE}</b></span>
          <span><b>WebGPU</b></span>
        </div>
        <div class="bb-key-hints">
          <span class="bb-key-hint"><span class="bb-kbd">WASD</span>move</span>
          <span class="bb-key-hint"><span class="bb-kbd">1–4</span>tools</span>
          <span class="bb-key-hint"><span class="bb-kbd">F</span>fly</span>
          <span class="bb-key-hint"><span class="bb-kbd">V</span>camera</span>
          <span class="bb-key-hint"><span class="bb-kbd">Esc</span>pause</span>
        </div>
      </div>`
    this.el.querySelector('[data-act="play"]')!.addEventListener('click', hooks.onPlay)
    this.el.querySelector('[data-act="settings"]')!.addEventListener('click', hooks.onSettings)
    this.quick = new QuickAccess(hooks)
    this.quick.el.classList.add('bb-quick-screen')
    this.el.appendChild(this.quick.el)
    this.el.querySelector('.bb-social-slot')!.appendChild(createSocialFooter())
    root.appendChild(this.el)
  }

  setMuted(muted: boolean): void {
    this.quick.setMuted(muted)
  }

  setFullscreen(active: boolean): void {
    this.quick.setFullscreen(active)
  }

  show(): void {
    this.el.classList.remove('bb-leave')
  }

  hide(): void {
    this.el.classList.add('bb-leave')
  }
}

export interface PauseMenuHooks extends QuickAccessHooks {
  onResume: () => void
  onSettings: () => void
  onQuit: () => void
}

export class PauseMenu {
  private readonly el: HTMLElement
  private readonly quick: QuickAccess

  constructor(root: HTMLElement, hooks: PauseMenuHooks) {
    this.el = document.createElement('div')
    this.el.className = 'bb-screen bb-pause bb-leave'
    this.el.innerHTML = `
      <div class="bb-pause-panel">
        <div class="bb-pause-title">Paused</div>
        <span class="bb-hazard"></span>
        <button class="bb-pause-item" data-act="resume">Resume</button>
        <button class="bb-pause-item" data-act="settings">Settings</button>
        <button class="bb-pause-item" data-act="quit">Quit to Menu</button>
      </div>`
    this.el.querySelector('[data-act="resume"]')!.addEventListener('click', hooks.onResume)
    this.el.querySelector('[data-act="settings"]')!.addEventListener('click', hooks.onSettings)
    this.el.querySelector('[data-act="quit"]')!.addEventListener('click', hooks.onQuit)
    this.quick = new QuickAccess(hooks)
    this.quick.el.classList.add('bb-quick-panel')
    this.el.querySelector('.bb-pause-panel')!.appendChild(this.quick.el)
    const pauseSocial = createSocialFooter()
    pauseSocial.classList.add('bb-social-pause')
    this.el.appendChild(pauseSocial)
    root.appendChild(this.el)
  }

  setMuted(muted: boolean): void {
    this.quick.setMuted(muted)
  }

  setFullscreen(active: boolean): void {
    this.quick.setFullscreen(active)
  }

  get visible(): boolean {
    return !this.el.classList.contains('bb-leave')
  }

  show(): void {
    this.el.classList.remove('bb-leave')
  }

  hide(): void {
    this.el.classList.add('bb-leave')
  }
}
