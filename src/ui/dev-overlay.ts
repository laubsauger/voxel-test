/**
 * T32 — profiling overlay: stats-gl (fps/cpu/gpu) + renderer.info panel
 * (draw calls, triangles, geometries, textures) + the classic hud stats line.
 * Enabled by ?dev=1 (I.boot) or the Dev settings toggle (I.settings).
 * Render-layer only (V6) — reads renderer counters, never sim state.
 */
import Stats from 'stats-gl'
import type { Game } from '../game'

export class DevOverlay {
  private stats: Stats | null = null
  private panel: HTMLElement | null = null
  private enabled = false
  private accum = 0
  private removeHook: (() => void) | null = null

  constructor(private readonly game: Game) {}

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    document.getElementById('hud')?.classList.toggle('bb-dev-on', on)
    if (on) {
      this.mount()
      this.removeHook = this.game.addFrameHook((dt) => this.frame(dt))
    } else {
      this.removeHook?.()
      this.removeHook = null
      if (this.stats) this.stats.dom.style.display = 'none'
      if (this.panel) this.panel.style.display = 'none'
    }
  }

  private mount(): void {
    if (this.panel) {
      this.panel.style.display = ''
      if (this.stats) this.stats.dom.style.display = ''
      return
    }
    this.panel = document.createElement('div')
    this.panel.className = 'bb-dev-panel'
    document.body.appendChild(this.panel)

    try {
      this.stats = new Stats({ trackGPU: true, horizontal: true })
      // stats-gl supports WebGPURenderer via init()
      void this.stats.init(this.game.renderer)
      document.body.appendChild(this.stats.dom)
      this.stats.dom.style.cssText = 'position:fixed;top:10px;right:10px;left:auto;z-index:30;'
    } catch (e) {
      console.warn('[dev] stats-gl init failed:', e)
      this.stats = null
    }
  }

  private frame(dt: number): void {
    this.stats?.update()
    this.accum += dt
    if (this.accum < 0.5 || !this.panel) return
    this.accum = 0
    const info = this.game.renderer.info
    const r = info.render
    const m = info.memory
    this.panel.innerHTML =
      `<b>renderer</b>\n` +
      `draws     ${r.drawCalls}\n` +
      `tris      ${r.triangles.toLocaleString()}\n` +
      `geoms     ${m.geometries}\n` +
      `textures  ${m.textures}`
  }
}
