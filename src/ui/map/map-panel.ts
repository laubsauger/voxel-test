/**
 * T70 — fullscreen city map. Dark glass sheet over the game; the paper base
 * canvas floats as a document with pan (drag) + zoom (wheel-at-cursor) via
 * ViewTransform (map-math, unit-tested). Player: amber marker + view cone.
 *
 * Redraws only while open, driven by MapSystem.update() (the game frame hook
 * runs every frame, paused or not) — no rAF of its own, no redraw when shut.
 */

import { arrowAngle, ViewTransform, type MapProjection } from './map-math'
import { MAP_INK } from './map-style'

const ZOOM_MIN_FIT = 0.9 // × fit-to-screen
const ZOOM_MAX = 26 // px per meter (base is 20 px/m — slight upsample max)

export class MapPanel {
  private readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly coordsEl: HTMLElement
  private readonly scaleBarEl: HTMLElement
  private readonly scaleTextEl: HTMLElement
  private readonly base: HTMLCanvasElement
  private readonly proj: MapProjection
  private view: ViewTransform | null = null
  private dpr = 1
  private open_ = false
  private dragging = false
  private lastX = 0
  private lastY = 0
  private px = 0
  private pz = 0
  private yaw = 0
  /** camera fov (rad) for the view cone — cosmetic, fixed default */
  private readonly coneHalf = (60 / 2) * (Math.PI / 180)

  constructor(root: HTMLElement, base: HTMLCanvasElement, proj: MapProjection, seed: number) {
    this.base = base
    this.proj = proj
    this.el = document.createElement('div')
    this.el.className = 'bb-map-screen'
    this.el.innerHTML = `
      <div class="bb-map-stage"><canvas></canvas></div>
      <div class="bb-map-head">
        <div class="bb-map-title">
          <div class="bb-map-kicker">Blockburb · Survey</div>
          <div class="bb-map-word">City Map</div>
          <div class="bb-hazard"></div>
        </div>
        <div class="bb-map-meta">
          <div>seed <b>${seed}</b></div>
          <div class="bb-map-coords">x — · z —</div>
        </div>
      </div>
      <div class="bb-map-foot">
        <div class="bb-map-scale">
          <span class="bb-map-scale-text">20 m</span>
          <div class="bb-map-scale-bar"></div>
        </div>
        <div class="bb-map-hints">
          <span class="bb-key-hint"><span class="bb-kbd">Drag</span>Pan</span>
          <span class="bb-key-hint"><span class="bb-kbd">Scroll</span>Zoom</span>
          <span class="bb-key-hint"><span class="bb-kbd">M</span>Close</span>
        </div>
      </div>`
    this.canvas = this.el.querySelector('canvas') as HTMLCanvasElement
    this.coordsEl = this.el.querySelector('.bb-map-coords') as HTMLElement
    this.scaleBarEl = this.el.querySelector('.bb-map-scale-bar') as HTMLElement
    this.scaleTextEl = this.el.querySelector('.bb-map-scale-text') as HTMLElement
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('map: 2d context unavailable')
    this.ctx = ctx
    root.appendChild(this.el)
    this.bindPointer()
    addEventListener('resize', () => {
      if (this.open_) {
        this.fitCanvas()
        this.draw()
      }
    })
  }

  get isOpen(): boolean {
    return this.open_
  }

  open(): void {
    if (this.open_) return
    this.open_ = true
    this.fitCanvas()
    // start centered on the player at a readable zoom (~1/3 world visible)
    const fit = this.fitZoom()
    this.view = new ViewTransform(this.px, this.pz, Math.max(fit * 2.4, 4), fit * ZOOM_MIN_FIT, ZOOM_MAX)
    this.view.clampCenter(this.proj.worldMx, this.proj.worldMz)
    this.el.classList.add('bb-open')
    this.draw()
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    this.dragging = false
    this.el.classList.remove('bb-open')
  }

  /** per-frame from MapSystem — tracks the player, redraws while open */
  update(pxM: number, pzM: number, yaw: number): void {
    this.px = pxM
    this.pz = pzM
    this.yaw = yaw
    if (this.open_) this.draw()
  }

  // --- internals ----------------------------------------------------------------

  private fitCanvas(): void {
    this.dpr = Math.min(devicePixelRatio || 1, 2)
    this.canvas.width = this.canvas.clientWidth * this.dpr
    this.canvas.height = this.canvas.clientHeight * this.dpr
  }

  /** zoom (px/m, CSS px) at which the whole world fits with margin */
  private fitZoom(): number {
    const vw = this.canvas.clientWidth || innerWidth
    const vh = this.canvas.clientHeight || innerHeight
    return Math.min(vw / this.proj.worldMx, vh / this.proj.worldMz) * 0.82
  }

  private bindPointer(): void {
    const c = this.canvas
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true
      this.lastX = e.clientX
      this.lastY = e.clientY
      c.setPointerCapture(e.pointerId)
      c.classList.add('bb-dragging')
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.view) return
      this.view.panBy(e.clientX - this.lastX, e.clientY - this.lastY)
      this.view.clampCenter(this.proj.worldMx, this.proj.worldMz)
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.draw()
    })
    const end = (e: PointerEvent) => {
      this.dragging = false
      c.classList.remove('bb-dragging')
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId)
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.view) return
        e.preventDefault()
        const rect = c.getBoundingClientRect()
        this.view.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0016), rect.width, rect.height)
        this.view.clampCenter(this.proj.worldMx, this.proj.worldMz)
        this.draw()
      },
      { passive: false },
    )
  }

  private draw(): void {
    const view = this.view
    if (!view) return
    const ctx = this.ctx
    const k = this.dpr
    const vw = this.canvas.clientWidth
    const vh = this.canvas.clientHeight
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    const [x0, y0] = view.worldToScreen(0, 0, vw, vh)
    const w = this.proj.worldMx * view.pxPerMeter
    const h = this.proj.worldMz * view.pxPerMeter

    // paper document floating on the glass
    ctx.save()
    ctx.scale(k, k)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
    ctx.shadowBlur = 42
    ctx.shadowOffsetY = 10
    ctx.fillStyle = MAP_INK.void
    ctx.fillRect(x0 - 1, y0 - 1, w + 2, h + 2)
    ctx.shadowColor = 'transparent'
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.base, x0, y0, w, h)

    this.drawPlayer(ctx, view, vw, vh)
    ctx.restore()

    // live readouts
    this.coordsEl.textContent = `x ${this.px.toFixed(1)} · z ${this.pz.toFixed(1)}`
    this.updateScaleBar(view)
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, view: ViewTransform, vw: number, vh: number): void {
    const [sx, sy] = view.worldToScreen(this.px, this.pz, vw, vh)
    const a = arrowAngle(this.yaw)
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(a)
    // view-direction cone
    const coneR = Math.max(26, view.pxPerMeter * 6)
    const grad = ctx.createRadialGradient(0, 0, 7, 0, 0, coneR)
    grad.addColorStop(0, 'rgba(255, 176, 60, 0.32)')
    grad.addColorStop(0.65, 'rgba(255, 176, 60, 0.1)')
    grad.addColorStop(1, 'rgba(255, 176, 60, 0)')
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, coneR, -Math.PI / 2 - this.coneHalf, -Math.PI / 2 + this.coneHalf)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
    // pulse ring + chevron marker
    ctx.beginPath()
    ctx.arc(0, 0, 10, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 176, 60, 0.5)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, -7)
    ctx.lineTo(5, 5)
    ctx.lineTo(0, 2.4)
    ctx.lineTo(-5, 5)
    ctx.closePath()
    ctx.fillStyle = '#ffb03c'
    ctx.strokeStyle = 'rgba(7, 9, 13, 0.9)'
    ctx.lineWidth = 1.4
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  /** pick a 1/2/5×10ⁿ meter length that renders 60–150 px wide */
  private updateScaleBar(view: ViewTransform): void {
    const targetPx = 100
    const raw = targetPx / view.pxPerMeter
    const pow = Math.pow(10, Math.floor(Math.log10(raw)))
    const m = [1, 2, 5, 10].map((f) => f * pow).reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a))
    this.scaleBarEl.style.width = `${m * view.pxPerMeter}px`
    this.scaleTextEl.textContent = m >= 1 ? `${m} m` : `${m * 100} cm`
  }
}
