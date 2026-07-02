/**
 * T33 — main menu + pause menu. Full-screen DOM overlays over the live
 * scene (the game keeps rendering its cinematic orbit behind the menu).
 * Title 'BLOCKBURB' is a working-title placeholder (see INTEGRATION-ui.md).
 */

export interface MainMenuHooks {
  seed: number
  onPlay: () => void
  onSettings: () => void
}

export class MainMenu {
  private readonly el: HTMLElement

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
    root.appendChild(this.el)
  }

  show(): void {
    this.el.classList.remove('bb-leave')
  }

  hide(): void {
    this.el.classList.add('bb-leave')
  }
}

export interface PauseMenuHooks {
  onResume: () => void
  onSettings: () => void
  onQuit: () => void
}

export class PauseMenu {
  private readonly el: HTMLElement

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
    root.appendChild(this.el)
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
