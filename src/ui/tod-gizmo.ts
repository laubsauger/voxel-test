/**
 * B37 — in-game time-of-day gizmo. A miniature sky arc with the sun/moon riding
 * it at the real elevation, a live clock, and slick controls to scrub the time
 * and pause/resume the day/night cycle without opening the settings menu.
 *
 * Read-only on the render cycle state (V6): reads WorldRenderer.sky each frame
 * for the marker + clock. Controls write the SAME settings paths the menu uses
 * (dev.timeOfDay, dev.cycleSpeed), so the existing live-apply wiring drives the
 * cycle — no second source of truth.
 */
import type { CycleState } from '../render/atmosphere'
import type { SettingsStore } from './settings-store'

const NS = 'http://www.w3.org/2000/svg'

/** HH:MM from fractional hours */
function clockText(hours: number): string {
  const h = ((Math.floor(hours) % 24) + 24) % 24
  const m = Math.floor((hours % 1) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export class TodGizmo {
  readonly el: HTMLElement
  private readonly marker: SVGCircleElement
  private readonly glow: SVGCircleElement
  private readonly clock: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private lastSpeed = 1 // remembered so ▶ resumes at the prior rate

  constructor(
    private readonly sky: () => Readonly<CycleState>,
    private readonly store: SettingsStore,
  ) {
    const el = document.createElement('div')
    el.className = 'bb-tod'
    el.innerHTML = `
      <svg class="bb-tod-arc" viewBox="0 0 120 60" aria-hidden="true">
        <line x1="6" y1="52" x2="114" y2="52" class="bb-tod-horizon"/>
        <path d="M10 52 A 50 50 0 0 1 110 52" class="bb-tod-path"/>
        <circle class="bb-tod-glow" r="7"/>
        <circle class="bb-tod-marker" r="4"/>
      </svg>
      <div class="bb-tod-row">
        <button class="bb-tod-play" title="Pause / resume the day-night cycle">⏸</button>
        <span class="bb-tod-clock">--:--</span>
        <button class="bb-tod-live" title="Resume the automatic live cycle">LIVE</button>
      </div>`
    this.el = el
    this.marker = el.querySelector('.bb-tod-marker')!
    this.glow = el.querySelector('.bb-tod-glow')!
    this.clock = el.querySelector('.bb-tod-clock')!
    this.playBtn = el.querySelector('.bb-tod-play')!

    // scrub: drag anywhere on the arc → set the fixed time by horizontal position
    const svg = el.querySelector('.bb-tod-arc') as SVGSVGElement
    const scrubTo = (clientX: number): void => {
      const r = svg.getBoundingClientRect()
      const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
      this.store.set('dev.timeOfDay', Math.round(t * 24 * 4) / 4) // quarter-hour steps, pins the time
    }
    let scrubbing = false
    svg.addEventListener('pointerdown', (e) => {
      scrubbing = true
      svg.setPointerCapture(e.pointerId)
      scrubTo(e.clientX)
    })
    svg.addEventListener('pointermove', (e) => scrubbing && scrubTo(e.clientX))
    svg.addEventListener('pointerup', () => (scrubbing = false))

    this.playBtn.addEventListener('click', () => {
      const cur = this.store.get('dev.cycleSpeed')
      if (cur > 0) {
        this.lastSpeed = cur
        this.store.set('dev.cycleSpeed', 0)
      } else {
        this.store.set('dev.cycleSpeed', this.lastSpeed)
      }
    })
    // LIVE: clear the fixed-time override so the cycle advances on its own again
    el.querySelector('.bb-tod-live')!.addEventListener('click', () => {
      this.store.set('dev.timeOfDay', -1)
      if (this.store.get('dev.cycleSpeed') === 0) this.store.set('dev.cycleSpeed', this.lastSpeed)
    })
  }

  /** per-frame: ride the marker along the arc at the sun/moon's real elevation */
  update(): void {
    const s = this.sky()
    const hours = ((s.hours % 24) + 24) % 24
    this.clock.textContent = clockText(hours)
    // horizontal sweep by hour (0h left → 24h right); vertical by real elevation.
    const up = s.sunDir.y >= 0 ? s.sunDir : s.moonDir // whichever body is above the horizon
    const cx = 10 + (hours / 24) * 100
    const cy = 52 - Math.max(0, up.y) * 46 // y up = higher on the arc
    for (const c of [this.marker, this.glow]) {
      c.setAttribute('cx', cx.toFixed(1))
      c.setAttribute('cy', cy.toFixed(1))
    }
    const isSun = s.sunDir.y >= 0
    this.marker.classList.toggle('bb-tod-sun', isSun)
    this.marker.classList.toggle('bb-tod-moon', !isSun)
    this.glow.style.opacity = String(0.25 + 0.35 * Math.max(0, up.y))
    // reflect pause state on the button
    this.playBtn.textContent = this.store.get('dev.cycleSpeed') > 0 ? '⏸' : '▶'
    const override = this.store.get('dev.timeOfDay') >= 0
    this.el.classList.toggle('bb-tod-fixed', override)
  }
}
