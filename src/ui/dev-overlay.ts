/**
 * T32 — profiling: three r185's built-in Inspector addon (profiler, FPS,
 * renderer stats, scene inspection) + a small renderer.info summary line and
 * the classic hud stats line as supplements.
 * Enabled by ?dev=1 (I.boot) or the Dev settings toggle (I.settings).
 * Render-layer only (V6) — reads renderer counters, never sim state.
 */
import { Inspector } from 'three/addons/inspector/Inspector.js'
import type { Game } from '../game'

export class DevOverlay {
  private inspector: Inspector | null = null
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
      this.inspector?.hide()
      if (this.panel) this.panel.style.display = 'none'
    }
  }

  private mount(): void {
    if (this.panel) {
      this.panel.style.display = ''
      this.inspector?.show()
      return
    }
    this.panel = document.createElement('div')
    this.panel.className = 'bb-dev-panel'
    document.body.appendChild(this.panel)

    try {
      this.inspector = new Inspector()
      this.game.renderer.inspector = this.inspector
      // the renderer only calls inspector.init() during its own init — we
      // attach after boot, so mount the inspector UI explicitly (idempotent:
      // it only appends its domElement if not already parented)
      this.inspector.init()
    } catch (e) {
      console.warn('[dev] three Inspector init failed:', e)
      this.inspector = null
    }
  }

  private frame(dt: number): void {
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
