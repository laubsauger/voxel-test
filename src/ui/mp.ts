/**
 * T71 — multiplayer UI (design system: Chakra Petch / safety-amber / smoked
 * glass, see style.css "demolition brief"). Four pieces:
 *
 *   MpLobby       — full-screen session screen over the orbit backdrop:
 *                   connect / host (room code + roster + START) / join
 *                   (code entry) / guest lobby ("waiting for host")
 *   NetHud        — in-game presence chips (players + ping + sync tick)
 *   StallBanner   — "waiting for <player> (Xs)" barrier-stall banner
 *   DesyncOverlay — V10 full-screen red glass, session is dead
 *
 * Pure DOM + hooks; all net logic lives in main.ts / src/net/**.
 */
import type { SessionPlayer } from '../net/session'

export type LobbyMode = 'connecting' | 'host' | 'join' | 'guest' | 'starting'

export interface MpLobbyHooks {
  /** host pressed START (only rendered for the host) */
  onStart: () => void
  /** join screen: user submitted a room code */
  onJoinCode: (code: string) => void
  /** leave lobby / cancel → back to main menu */
  onLeave: () => void
}

export class MpLobby {
  private readonly el: HTMLElement
  private readonly title: HTMLElement
  private readonly body: HTMLElement
  private readonly status: HTMLElement
  private mode: LobbyMode = 'connecting'
  private players: SessionPlayer[] = []
  private code = ''
  private joinError = ''

  constructor(
    root: HTMLElement,
    private readonly hooks: MpLobbyHooks,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'bb-screen bb-mp bb-leave'
    this.el.innerHTML = `
      <div class="bb-mp-panel">
        <div class="bb-mp-title">Multiplayer</div>
        <span class="bb-hazard"></span>
        <div class="bb-mp-body"></div>
        <div class="bb-mp-status"></div>
      </div>`
    this.title = this.el.querySelector('.bb-mp-title') as HTMLElement
    this.body = this.el.querySelector('.bb-mp-body') as HTMLElement
    this.status = this.el.querySelector('.bb-mp-status') as HTMLElement
    root.appendChild(this.el)
  }

  get visible(): boolean {
    return !this.el.classList.contains('bb-leave')
  }

  show(mode: LobbyMode): void {
    this.mode = mode
    this.joinError = ''
    this.render()
    this.el.classList.remove('bb-leave')
  }

  hide(): void {
    this.el.classList.add('bb-leave')
  }

  setStatus(text: string): void {
    this.status.textContent = text
  }

  setCode(code: string): void {
    this.code = code
    this.render()
  }

  setPlayers(players: SessionPlayer[]): void {
    this.players = players
    this.render()
  }

  setMode(mode: LobbyMode): void {
    this.mode = mode
    this.render()
  }

  setJoinError(msg: string): void {
    this.joinError = msg
    this.render()
  }

  private roster(): string {
    const rows = this.players
      .map(
        (p) => `
        <div class="bb-mp-player">
          <span class="bb-mp-player-dot"></span>
          <span class="bb-mp-player-name">${p.name}</span>
        </div>`,
      )
      .join('')
    const empty = Math.max(0, 4 - this.players.length)
    const slots = Array.from(
      { length: empty },
      () => `
        <div class="bb-mp-player bb-mp-slot-open">
          <span class="bb-mp-player-dot"></span>
          <span class="bb-mp-player-name">waiting for player…</span>
        </div>`,
    ).join('')
    return `<div class="bb-mp-roster">${rows}${slots}</div>`
  }

  private render(): void {
    switch (this.mode) {
      case 'connecting':
        this.title.textContent = 'Multiplayer'
        this.body.innerHTML = `<div class="bb-mp-wait">Contacting signal server<span class="bb-mp-ellipsis"></span></div>`
        break
      case 'host':
        this.title.textContent = 'Hosting'
        this.body.innerHTML = `
          <div class="bb-mp-code-label" data-mp="code-label">Room code — click to copy</div>
          <div class="bb-mp-code bb-mp-code-copy" data-mp="code" title="Click to copy">${this.code || '······'}</div>
          ${this.roster()}
          <div class="bb-mp-actions">
            <button class="bb-mp-btn bb-mp-primary" data-mp="start" ${this.players.length < 2 ? 'disabled' : ''}>Start Session</button>
            <button class="bb-mp-btn" data-mp="leave">Cancel</button>
          </div>`
        break
      case 'join':
        this.title.textContent = 'Join Game'
        this.body.innerHTML = `
          <div class="bb-mp-code-label">Enter room code</div>
          <input class="bb-mp-input" data-mp="code-input" maxlength="6" spellcheck="false"
                 autocomplete="off" placeholder="ABC123" />
          <div class="bb-mp-error">${this.joinError}</div>
          <div class="bb-mp-actions">
            <button class="bb-mp-btn bb-mp-primary" data-mp="join">Join</button>
            <button class="bb-mp-btn" data-mp="paste">Paste</button>
            <button class="bb-mp-btn" data-mp="leave">Back</button>
          </div>`
        break
      case 'guest':
        this.title.textContent = 'Lobby'
        this.body.innerHTML = `
          <div class="bb-mp-code-label">Room</div>
          <div class="bb-mp-code">${this.code}</div>
          ${this.roster()}
          <div class="bb-mp-wait">Waiting for the host to start<span class="bb-mp-ellipsis"></span></div>
          <div class="bb-mp-actions">
            <button class="bb-mp-btn" data-mp="leave">Leave</button>
          </div>`
        break
      case 'starting':
        this.title.textContent = 'Launching'
        this.body.innerHTML = `<div class="bb-mp-wait">Synchronizing world<span class="bb-mp-ellipsis"></span></div>`
        break
    }
    this.body.querySelector('[data-mp="start"]')?.addEventListener('click', this.hooks.onStart)
    this.body.querySelector('[data-mp="leave"]')?.addEventListener('click', this.hooks.onLeave)

    // host: click the code to copy it (secure context — https Pages / localhost)
    const codeEl = this.body.querySelector('[data-mp="code"]') as HTMLElement | null
    if (codeEl && this.mode === 'host') {
      codeEl.addEventListener('click', () => {
        if (!this.code) return
        void navigator.clipboard.writeText(this.code).then(
          () => this.flashLabel('Copied!'),
          () => this.flashLabel('Copy failed — select manually'),
        )
      })
    }

    const input = this.body.querySelector('[data-mp="code-input"]') as HTMLInputElement | null
    if (input) {
      const clean = (v: string) => v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6)
      input.addEventListener('input', () => (input.value = clean(input.value)))
      const submit = () => {
        const code = clean(input.value)
        if (code.length > 0) this.hooks.onJoinCode(code)
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit()
        e.stopPropagation() // don't leak WASD etc. into game input
      })
      this.body.querySelector('[data-mp="join"]')?.addEventListener('click', submit)
      // paste: pull the code from the clipboard into the input (the click is the
      // user gesture clipboard.readText needs). Native Ctrl/Cmd+V still works too.
      this.body.querySelector('[data-mp="paste"]')?.addEventListener('click', () => {
        void navigator.clipboard.readText().then(
          (text) => {
            input.value = clean(text)
            input.focus()
          },
          () => {
            // set the error text directly — a full re-render would clear the input
            const err = this.body.querySelector('.bb-mp-error')
            if (err) err.textContent = 'Paste blocked — type the code or use Ctrl/Cmd+V'
          },
        )
      })
      setTimeout(() => input.focus(), 0)
    }
  }

  /** briefly swap the host code label to a transient message (copy feedback) */
  private flashLabel(msg: string): void {
    const label = this.body.querySelector('[data-mp="code-label"]') as HTMLElement | null
    if (!label) return
    label.textContent = msg
    setTimeout(() => {
      if (this.mode === 'host') label.textContent = 'Room code — click to copy'
    }, 1400)
  }
}

/** in-game presence: one chip per player, ping + sync tick on the local row */
export class NetHud {
  private readonly el: HTMLElement

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'bb-net-hud'
    this.el.style.display = 'none'
    root.appendChild(this.el)
  }

  show(): void {
    this.el.style.display = ''
  }

  hide(): void {
    this.el.style.display = 'none'
  }

  update(
    players: { playerId: number; name: string; local: boolean; ping: number | null; dropped: boolean }[],
    verifiedTick: number,
  ): void {
    this.el.innerHTML =
      players
        .map(
          (p) => `
      <div class="bb-net-chip${p.local ? ' bb-net-local' : ''}${p.dropped ? ' bb-net-dropped' : ''}">
        <span class="bb-net-dot"></span>
        <span>${p.name}</span>
        ${p.dropped ? '<span class="bb-net-ping">lost</span>' : p.ping !== null ? `<span class="bb-net-ping">${p.ping}ms</span>` : ''}
      </div>`,
        )
        .join('') +
      `<div class="bb-net-chip bb-net-sync"><span class="bb-net-dot"></span><span>sync ${verifiedTick >= 0 ? `#${verifiedTick}` : '—'}</span></div>`
  }
}

/** barrier-stall banner: "waiting for P3 (12s)" */
export class StallBanner {
  private readonly el: HTMLElement

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'bb-stall'
    this.el.style.display = 'none'
    root.appendChild(this.el)
  }

  show(who: string, seconds: number): void {
    this.el.innerHTML = `<span class="bb-stall-spin"></span>waiting for ${who} (${seconds}s)`
    this.el.style.display = ''
  }

  hide(): void {
    this.el.style.display = 'none'
  }

  /** transient notice (peer dropped) reusing the banner slot */
  toast(text: string, ms = 4000): void {
    this.el.innerHTML = text
    this.el.style.display = ''
    setTimeout(() => this.hide(), ms)
  }
}

/**
 * V10 — desync/session-death overlay. LOUD by design: full-screen red-tinted
 * glass, hashes on display, one exit (back to menu = clean reload; the
 * session is unrecoverable without late-join snapshot transfer).
 */
export class DesyncOverlay {
  private readonly el: HTMLElement

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'bb-desync'
    this.el.style.display = 'none'
    root.appendChild(this.el)
  }

  show(title: string, detailLines: string[]): void {
    this.el.innerHTML = `
      <div class="bb-desync-panel">
        <div class="bb-desync-title">${title}</div>
        <span class="bb-hazard"></span>
        <div class="bb-desync-detail">${detailLines.map((l) => `<div>${l}</div>`).join('')}</div>
        <button class="bb-mp-btn bb-mp-primary" data-mp="menu">Return to Menu</button>
      </div>`
    this.el.style.display = ''
    this.el.querySelector('[data-mp="menu"]')!.addEventListener('click', () => location.reload())
    // pointer lock hides the cursor — release it so the button is clickable
    if (document.pointerLockElement) document.exitPointerLock()
  }
}
