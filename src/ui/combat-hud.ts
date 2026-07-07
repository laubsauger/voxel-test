/**
 * T95 — combat HUD: HP bar, PUBG-style directional damage indicator, kill
 * feed, hold-Tab scoreboard (K/D), death screen with respawn countdown.
 * Pure DOM overlay, render layer only (V6): reads sim events + player state,
 * never writes sim. Hit-CONFIRM feedback (hitmarker/vignette) stays in Hud
 * (T28); this module owns everything new for player-vs-player combat.
 */

import type { SimEvent } from '../sim/events'

export interface CombatPlayerView {
  id: number
  hp: number
  alive: boolean
  respawnAtTick: number
  kills: number
  deaths: number
}

export interface CombatHudCtx {
  localId: () => number
  tick: () => number
  /** all spawned players (scoreboard) */
  players: () => CombatPlayerView[]
  name: (pid: number) => string
  /** camera yaw (rad) — rotates damage-direction arrows into screen space */
  camYaw: () => number
  /** false in menu/orbit — the whole combat overlay hides */
  inPlay: () => boolean
}

const FEED_TTL_MS = 4500
const ARROW_TTL_MS = 1600
const TICK_HZ = 60

export class CombatHud {
  private readonly el: HTMLElement
  private readonly hpFill: HTMLElement
  private readonly hpText: HTMLElement
  private readonly feedEl: HTMLElement
  private readonly arrowsEl: HTMLElement
  private readonly deathEl: HTMLElement
  private readonly deathSub: HTMLElement
  private readonly boardEl: HTMLElement
  private readonly arrows: { el: HTMLElement; worldAngle: number; until: number }[] = []
  private boardOpen = false
  private readonly onKey: (e: KeyboardEvent) => void

  constructor(root: HTMLElement, private readonly ctx: CombatHudCtx) {
    this.el = document.createElement('div')
    this.el.className = 'bb-combat'
    this.el.innerHTML = `
      <div class="bb-hp"><div class="bb-hp-track"><div class="bb-hp-fill"></div></div><span class="bb-hp-text">100</span></div>
      <div class="bb-killfeed"></div>
      <div class="bb-dmg-arrows"></div>
      <div class="bb-death" style="display:none">
        <div class="bb-death-title">YOU DIED</div>
        <div class="bb-death-sub"></div>
      </div>
      <div class="bb-board" style="display:none"></div>`
    this.hpFill = this.el.querySelector('.bb-hp-fill') as HTMLElement
    this.hpText = this.el.querySelector('.bb-hp-text') as HTMLElement
    this.feedEl = this.el.querySelector('.bb-killfeed') as HTMLElement
    this.arrowsEl = this.el.querySelector('.bb-dmg-arrows') as HTMLElement
    this.deathEl = this.el.querySelector('.bb-death') as HTMLElement
    this.deathSub = this.el.querySelector('.bb-death-sub') as HTMLElement
    this.boardEl = this.el.querySelector('.bb-board') as HTMLElement
    root.appendChild(this.el)
    this.onKey = (e) => {
      if (e.code !== 'Tab') return
      e.preventDefault() // keep focus in-game
      const open = e.type === 'keydown'
      if (open !== this.boardOpen) {
        this.boardOpen = open
        this.boardEl.style.display = open ? 'block' : 'none'
        if (open) this.renderBoard()
      }
    }
    addEventListener('keydown', this.onKey)
    addEventListener('keyup', this.onKey)
  }

  /** feed the frame's drained sim events (call from the onSimEvents tap) */
  onEvent(e: SimEvent): void {
    const local = this.ctx.localId()
    if (e.kind === 'player-hit') {
      if (e.victim === local && e.attacker !== 0 && e.attacker !== local) {
        // dx/dz point attacker→victim; the arrow must point victim→attacker
        const dx = -e.dx
        const dz = -e.dz
        if (dx !== 0 || dz !== 0) this.pushArrow(Math.atan2(dx, dz))
      }
    } else if (e.kind === 'player-death') {
      const who =
        e.attacker === 0 || e.attacker === e.victim
          ? `${this.ctx.name(e.victim)} died`
          : `${this.ctx.name(e.attacker)} ▸ ${this.ctx.name(e.victim)}`
      this.pushFeed(who, e.victim === local || e.attacker === local)
      if (this.boardOpen) this.renderBoard()
    } else if (e.kind === 'player-respawn' && this.boardOpen) {
      this.renderBoard()
    }
  }

  /** once per rendered frame */
  frame(): void {
    // menu/orbit backdrop: no combat overlay (T95 fix — HP bar showed in menu)
    const inPlay = this.ctx.inPlay()
    this.el.style.display = inPlay ? 'block' : 'none'
    if (!inPlay) return
    const me = this.ctx.players().find((p) => p.id === this.ctx.localId())
    // HP bar
    const hp = me ? me.hp : 100
    this.hpFill.style.width = `${hp}%`
    this.hpFill.classList.toggle('bb-hp-low', hp <= 30)
    this.hpText.textContent = String(hp)
    // death screen + countdown
    const dead = me !== undefined && !me.alive
    this.deathEl.style.display = dead ? 'grid' : 'none'
    if (dead && me) {
      const secs = Math.max(0, Math.ceil((me.respawnAtTick - this.ctx.tick()) / TICK_HZ))
      this.deathSub.textContent = `respawn in ${secs}s`
    }
    // damage arrows track camera yaw (world-space angle → screen rotation)
    const now = performance.now()
    const yaw = this.ctx.camYaw()
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i]
      if (now > a.until) {
        a.el.remove()
        this.arrows.splice(i, 1)
        continue
      }
      // screen angle: 0 = up (ahead). Player forward is -z (atan2(dx,dz) of
      // -forward ⇒ subtract yaw and flip into screen space).
      const screen = a.worldAngle - yaw + Math.PI
      a.el.style.transform = `rotate(${screen}rad)`
      a.el.style.opacity = String(Math.min(1, (a.until - now) / (ARROW_TTL_MS * 0.6)))
    }
  }

  private pushArrow(worldAngle: number): void {
    const el = document.createElement('div')
    el.className = 'bb-dmg-arrow'
    el.innerHTML = `<i></i>`
    this.arrowsEl.appendChild(el)
    this.arrows.push({ el, worldAngle, until: performance.now() + ARROW_TTL_MS })
  }

  private pushFeed(text: string, highlight: boolean): void {
    const line = document.createElement('div')
    line.className = `bb-feed-line${highlight ? ' bb-feed-me' : ''}`
    line.textContent = text
    this.feedEl.prepend(line)
    while (this.feedEl.children.length > 5) this.feedEl.lastElementChild?.remove()
    setTimeout(() => {
      line.classList.add('bb-feed-out')
      setTimeout(() => line.remove(), 400)
    }, FEED_TTL_MS)
  }

  private renderBoard(): void {
    const local = this.ctx.localId()
    const rows = [...this.ctx.players()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id)
    this.boardEl.innerHTML = `
      <div class="bb-board-title">Scoreboard</div>
      <table><thead><tr><th>player</th><th>K</th><th>D</th><th>HP</th></tr></thead><tbody>
      ${rows
        .map(
          (p) =>
            `<tr class="${p.id === local ? 'bb-board-me' : ''}${p.alive ? '' : ' bb-board-dead'}">` +
            `<td>${this.ctx.name(p.id)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.alive ? p.hp : '—'}</td></tr>`,
        )
        .join('')}
      </tbody></table>`
  }

  dispose(): void {
    removeEventListener('keydown', this.onKey)
    removeEventListener('keyup', this.onKey)
    this.el.remove()
  }
}
