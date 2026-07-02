/**
 * T70 — MapSystem facade: the single class the coordinator wires (see
 * INTEGRATION-map.md — 3 lines in main.ts). Owns the boot-time base canvas,
 * the minimap widget and the fullscreen panel. Render layer only (V6):
 * reads player state, never touches the sim.
 */

import './map.css'
import { MapProjection, type WorldDims } from './map-math'
import { buildMapCommands, createBaseMap, executeCommands, type MapLayout } from './map-render'
import { districtStyle } from './map-style'
import { Minimap } from './minimap'
import { MapPanel } from './map-panel'

export type { MapLayout, WorldDims }

export class MapSystem {
  private readonly layout: MapLayout
  private readonly proj: MapProjection
  private readonly base: HTMLCanvasElement
  private minimap: Minimap | null = null
  private panel: MapPanel | null = null
  private readonly seed: number
  /** fired after the fullscreen map closes (coordinator may re-lock pointer) */
  onClose: (() => void) | null = null

  constructor(layout: MapLayout & { seed?: number }, dims: WorldDims) {
    this.layout = layout
    this.seed = layout.seed ?? 0
    this.proj = new MapProjection(dims)
    // deterministic base map, drawn exactly once at boot…
    this.base = createBaseMap(layout, dims)
    // …plus one re-execute when Chakra Petch lands, so district labels never
    // stay baked in the fallback font (same commands — still deterministic)
    document.fonts?.ready.then(() => {
      const ctx = this.base.getContext('2d')
      if (ctx) executeCommands(ctx, buildMapCommands(layout, dims))
    })
  }

  /** true while the fullscreen map is up — main.ts's pointerlockchange
   *  handler consults this so losing pointer lock to the map ≠ pause */
  get isOpen(): boolean {
    return this.panel?.isOpen ?? false
  }

  /** mount both widgets into the UI root (#ui-root) */
  attach(root: HTMLElement): void {
    this.minimap = new Minimap(root, this.base, this.proj)
    this.panel = new MapPanel(root, this.base, this.proj, this.seed)
    this.minimap.setZone(districtStyle(this.zoneKindAt()).label)
    // Escape closes the map. Capture phase + stopImmediatePropagation so the
    // pause-menu Esc handler in main.ts never sees it while the map is open.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape' && this.isOpen) {
          e.stopImmediatePropagation()
          e.preventDefault()
          this.closeFullscreen()
        }
      },
      { capture: true },
    )
  }

  /** per-frame (from Game.addFrameHook): player position in METERS + yaw rad */
  update(pxMeters: number, pzMeters: number, yaw: number): void {
    this.minimap?.update(pxMeters, pzMeters, yaw)
    this.panel?.update(pxMeters, pzMeters, yaw)
    this.lastX = pxMeters
    this.lastZ = pzMeters
    // zone chip refresh is cheap but pointless per-frame — every ~0.75 s
    if (this.zoneTick++ % 45 === 0) {
      this.minimap?.setZone(districtStyle(this.zoneKindAt(pxMeters, pzMeters)).label)
    }
  }

  private lastX = 0
  private lastZ = 0
  private zoneTick = 0

  toggleFullscreen(): void {
    if (!this.panel) return
    if (this.panel.isOpen) this.closeFullscreen()
    else {
      this.panel.open()
      // free the mouse for pan/zoom; main.ts consults isOpen so this does
      // NOT open the pause menu (see INTEGRATION-map.md)
      if (document.pointerLockElement) document.exitPointerLock()
    }
  }

  /** hide/show the minimap with menu/orbit state (optional wiring) */
  setVisible(on: boolean): void {
    this.minimap?.setVisible(on)
    if (!on) this.closeFullscreen()
  }

  private closeFullscreen(): void {
    if (!this.panel?.isOpen) return
    this.panel.close()
    this.minimap?.setZone(districtStyle(this.zoneKindAt(this.lastX, this.lastZ)).label)
    this.onClose?.()
  }

  /** district kind under a world position (meters) — minimap zone chip */
  private zoneKindAt(xM = 0, zM = 0): string {
    const vx = xM / 0.1
    const vz = zM / 0.1
    const districts = this.layout.districts
    if (!districts || districts.length === 0) return 'suburban'
    for (let i = districts.length - 1; i >= 0; i--) {
      const d = districts[i]
      if (vx >= d.rect.x0 && vx <= d.rect.x1 && vz >= d.rect.z0 && vz <= d.rect.z1) return d.kind
    }
    return districts[0].kind
  }
}
