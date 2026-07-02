/**
 * T31 — boot preloader. Real progress stages (no fake bar): each stage maps
 * to an actual boot phase reported by Game.create's onStage callback.
 */
import type { StageId } from '../game'

const STAGES: { id: StageId; label: string }[] = [
  { id: 'world', label: 'Building world' },
  { id: 'physics', label: 'Waking physics' },
  { id: 'renderer', label: 'Priming renderer' },
  { id: 'meshing', label: 'Meshing suburb' },
]

export class Preloader {
  private readonly el: HTMLElement
  private readonly rows = new Map<StageId, HTMLElement>()
  private readonly bar: HTMLElement
  private current: StageId | null = null

  constructor(root: HTMLElement, seed: number) {
    this.el = document.createElement('div')
    this.el.className = 'bb-screen bb-preloader'
    this.el.innerHTML = `
      <div class="bb-pre-inner">
        <div class="bb-logo">
          <span class="bb-logo-kicker">Demolition Sandbox</span>
          <span class="bb-logo-word">BLOCK<em>BURB</em></span>
          <span class="bb-hazard"></span>
        </div>
        <div class="bb-pre-stages"></div>
        <div class="bb-pre-bar"><div class="bb-pre-bar-fill"></div></div>
      </div>`
    const list = this.el.querySelector('.bb-pre-stages')!
    for (const s of STAGES) {
      const row = document.createElement('div')
      row.className = 'bb-pre-stage'
      row.innerHTML = `<span class="bb-pre-dot"></span><span>${s.label}</span><span class="bb-pre-note"></span>`
      list.appendChild(row)
      this.rows.set(s.id, row)
    }
    const note = this.el.querySelector('.bb-pre-note') as HTMLElement
    note.textContent = `seed ${seed}`
    this.bar = this.el.querySelector('.bb-pre-bar-fill') as HTMLElement
    root.appendChild(this.el)
  }

  /** mark a boot phase active (previous ones complete) */
  stage(id: StageId): void {
    if (this.current) this.rows.get(this.current)?.classList.replace('bb-active', 'bb-done')
    this.current = id
    this.rows.get(id)?.classList.add('bb-active')
    const i = STAGES.findIndex((s) => s.id === id)
    this.bar.style.width = `${(i / STAGES.length) * 100}%`
  }

  /** all phases done → fade out and remove */
  done(): Promise<void> {
    if (this.current) this.rows.get(this.current)?.classList.replace('bb-active', 'bb-done')
    this.bar.style.width = '100%'
    return new Promise((resolve) => {
      setTimeout(() => {
        this.el.classList.add('bb-leave')
        setTimeout(() => {
          this.el.remove()
          resolve()
        }, 450)
      }, 350)
    })
  }
}
