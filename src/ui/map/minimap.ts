/**
 * T70 — minimap HUD widget. Bottom-right (hotbar owns bottom-center, dev
 * overlay top-left). North-up rounded-square crop of the boot-time base
 * canvas, cheap drawImage blit per frame; only the amber player arrow
 * rotates (with -yaw, see map-math.arrowAngle).
 */

import { arrowAngle, cropRect, type MapProjection } from './map-math'
import { MAP_INK } from './map-style'

/** widget size in CSS px (canvas inset 3px inside the glass frame) */
const WIDGET = 140
const CANVAS = WIDGET - 6
/** world meters visible across the widget */
const VIEW_METERS = 60

export class Minimap {
  private readonly el: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly base: HTMLCanvasElement
  private readonly proj: MapProjection
  private readonly dpr: number
  private frame = 0

  constructor(root: HTMLElement, base: HTMLCanvasElement, proj: MapProjection) {
    this.base = base
    this.proj = proj
    this.dpr = Math.min(devicePixelRatio || 1, 2)
    this.el = document.createElement('div')
    this.el.className = 'bb-minimap'
    this.el.innerHTML = `
      <div class="bb-mm-frame"><canvas></canvas></div>
      <div class="bb-mm-north">N</div>
      <div class="bb-mm-foot"><span class="bb-mm-zone">—</span><b>M · Map</b></div>`
    this.canvas = this.el.querySelector('canvas') as HTMLCanvasElement
    this.canvas.width = CANVAS * this.dpr
    this.canvas.height = CANVAS * this.dpr
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('minimap: 2d context unavailable')
    this.ctx = ctx
    root.appendChild(this.el)
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('bb-hidden', !on)
  }

  setZone(text: string): void {
    const z = this.el.querySelector('.bb-mm-zone')
    if (z) z.textContent = text
  }

  /** per-frame blit (every other frame — the base never changes, only the crop) */
  update(pxM: number, pzM: number, yaw: number): void {
    if (this.frame++ % 2 !== 0) return
    const ctx = this.ctx
    const size = CANVAS * this.dpr
    // void beyond the world edge
    ctx.globalAlpha = 1
    ctx.fillStyle = MAP_INK.void
    ctx.fillRect(0, 0, size, size)

    const span = VIEW_METERS * this.proj.basePxPerMeter
    const c = cropRect(
      this.base.width,
      this.base.height,
      this.proj.worldToBaseX(pxM),
      this.proj.worldToBaseZ(pzM),
      span,
      size,
    )
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (c) ctx.drawImage(this.base, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh)

    this.drawArrow(size / 2, size / 2, arrowAngle(yaw), this.dpr)
  }

  /** amber chevron with dark halo — readable on white roads AND paper */
  private drawArrow(x: number, y: number, angle: number, k: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    // soft halo grounds the arrow on any tint
    ctx.beginPath()
    ctx.arc(0, 0, 9 * k, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(7, 9, 13, 0.28)'
    ctx.fill()
    // chevron
    ctx.beginPath()
    ctx.moveTo(0, -6.5 * k)
    ctx.lineTo(4.6 * k, 4.6 * k)
    ctx.lineTo(0, 2.2 * k)
    ctx.lineTo(-4.6 * k, 4.6 * k)
    ctx.closePath()
    ctx.fillStyle = '#ffb03c'
    ctx.strokeStyle = 'rgba(7, 9, 13, 0.85)'
    ctx.lineWidth = 1.2 * k
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }
}
