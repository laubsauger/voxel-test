/**
 * T28 — in-game HUD: hotbar (4 tools), crosshair, hitmarker, damage vignette,
 * fly-mode chip (T45). Pure DOM overlay, render layer only (V6) — all sim
 * mutation goes through the tool controller's command pushes.
 */

export type ToolId = 'dig' | 'build' | 'gun' | 'bomb' | 'rocket' | 'tnt'

export interface ToolDef {
  id: ToolId
  label: string
  icon: string
}

export const TOOLS: ToolDef[] = [
  {
    id: 'dig',
    label: 'Dig',
    icon: '<path d="M2 22v-5l5-5 5 5-5 5z"/><path d="M9.5 14.5L16 8"/><path d="m17 2 5 5-.5.5a3.53 3.53 0 0 1-5 0 3.53 3.53 0 0 1 0-5L17 2"/>',
  },
  {
    id: 'build',
    label: 'Build',
    icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12v9M12 12l8-4.5M12 12L4 7.5"/>',
  },
  {
    id: 'gun',
    label: 'Gun',
    icon: '<path d="M3 7h18v5h-8.2l-1.3 5H6.8l1.3-5H4a1 1 0 0 1-1-1z"/><path d="M17.5 12v2.5H15"/><path d="M21 7V5"/>',
  },
  {
    id: 'bomb',
    label: 'Bomb',
    icon: '<circle cx="10.5" cy="14" r="6"/><path d="M14 9.5l2.2-2.2M16.5 7c.6-1.6 1.4-2.4 3.5-2.5M19 7.5l1 1M20.5 4l1-1"/>',
  },
  {
    id: 'rocket',
    label: 'Rocket',
    icon: '<path d="M12 2c2.8 1.8 4.5 4.9 4.5 8.5 0 2.4-.8 4.4-1.7 6H9.2c-.9-1.6-1.7-3.6-1.7-6C7.5 6.9 9.2 3.8 12 2z"/><circle cx="12" cy="9" r="1.6"/><path d="M9.2 16.5 6.5 20l2.7-1.2M14.8 16.5 17.5 20l-2.7-1.2M12 16.5V21"/>',
  },
  {
    id: 'tnt',
    label: 'TNT',
    icon: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M4 13h16"/><path d="M12 9V5m0 0 2.5-2M12 5 9.5 3"/>',
  },
]

export interface HudPrompt {
  hotkey: string
  action: string
}

export class Hud {
  private readonly el: HTMLElement
  private readonly slots: HTMLElement[] = []
  private readonly crosshair: HTMLElement
  private readonly hitmarkerEl: HTMLElement
  private readonly damageEl: HTMLElement
  private readonly flyChip: HTMLElement
  private readonly lockHint: HTMLElement
  selected = 0
  /** T52 — fires when the selected tool actually changes (hotbar switch sound) */
  onSelect: ((tool: ToolDef) => void) | null = null

  constructor(root: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'bb-hud bb-hidden'
    this.el.innerHTML = `
      <div class="bb-damage"></div>
      <div class="bb-crosshair">
        <span class="bb-ch-tick bb-ch-t"></span><span class="bb-ch-tick bb-ch-b"></span>
        <span class="bb-ch-tick bb-ch-l"></span><span class="bb-ch-tick bb-ch-r"></span>
        <span class="bb-ch-dot"></span>
      </div>
      <div class="bb-hitmarker"><span></span><span></span><span></span><span></span></div>
      <div class="bb-fly-chip">Fly</div>
      <div class="bb-prompt-chip"></div>
      <div class="bb-lock-hint">Click to take control</div>
      <div class="bb-hotbar"></div>`
    const hotbar = this.el.querySelector('.bb-hotbar')!
    TOOLS.forEach((tool, i) => {
      const slot = document.createElement('div')
      slot.className = 'bb-slot'
      slot.innerHTML = `
        <span class="bb-slot-key">${i + 1}</span>
        <span class="bb-slot-label">${tool.label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">${tool.icon}</svg>`
      hotbar.appendChild(slot)
      this.slots.push(slot)
    })
    this.crosshair = this.el.querySelector('.bb-crosshair') as HTMLElement
    this.hitmarkerEl = this.el.querySelector('.bb-hitmarker') as HTMLElement
    this.damageEl = this.el.querySelector('.bb-damage') as HTMLElement
    this.flyChip = this.el.querySelector('.bb-fly-chip') as HTMLElement
    this.promptChip = this.el.querySelector('.bb-prompt-chip') as HTMLElement
    this.lockHint = this.el.querySelector('.bb-lock-hint') as HTMLElement
    root.appendChild(this.el)
    this.select(0)
  }

  show(): void {
    this.el.classList.remove('bb-hidden')
  }

  hide(): void {
    this.el.classList.add('bb-hidden')
  }

  select(i: number): void {
    const next = ((i % TOOLS.length) + TOOLS.length) % TOOLS.length
    const changed = next !== this.selected
    this.selected = next
    this.slots.forEach((s, n) => s.classList.toggle('bb-selected', n === this.selected))
    if (changed) this.onSelect?.(this.tool)
  }

  get tool(): ToolDef {
    return TOOLS[this.selected]
  }

  /** brief crosshair kick on fire */
  pulseCrosshair(): void {
    this.crosshair.classList.remove('bb-fire')
    void this.crosshair.offsetWidth // restart transition
    this.crosshair.classList.add('bb-fire')
    setTimeout(() => this.crosshair.classList.remove('bb-fire'), 130)
  }

  /** hitmarker flash — confirmed voxel hit */
  hitmarker(): void {
    this.hitmarkerEl.classList.remove('bb-hit')
    void this.hitmarkerEl.offsetWidth
    this.hitmarkerEl.classList.add('bb-hit')
  }

  /** screen-edge flash on player damage (T28 — fed by Game.onPlayerDamaged) */
  damageFlash(): void {
    this.damageEl.classList.remove('bb-hit')
    void this.damageEl.offsetWidth
    this.damageEl.classList.add('bb-hit')
  }

  private promptChip!: HTMLElement
  private promptText = ''

  /** contextual action prompt (`Enter` + action); null hides */
  setPrompt(prompt: HudPrompt | string | null): void {
    const t = typeof prompt === 'string' ? prompt : prompt ? `${prompt.hotkey}|${prompt.action}` : ''
    if (t === this.promptText) return
    this.promptText = t
    if (typeof prompt === 'object' && prompt !== null) {
      this.promptChip.innerHTML = `<span class="bb-prompt-key"></span><span class="bb-prompt-action"></span>`
      ;(this.promptChip.querySelector('.bb-prompt-key') as HTMLElement).textContent = prompt.hotkey
      ;(this.promptChip.querySelector('.bb-prompt-action') as HTMLElement).textContent = prompt.action
    } else {
      this.promptChip.textContent = prompt ?? ''
    }
    this.promptChip.classList.toggle('bb-on', t !== '')
  }

  setFly(on: boolean): void {
    this.flyChip.classList.toggle('bb-on', on)
  }

  /** "click to take control" hint (boot=game path before pointer lock) */
  setLockHint(on: boolean): void {
    this.lockHint.style.display = on ? '' : 'none'
  }
}
