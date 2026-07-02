/**
 * T70 — base-map renderer. Two halves, deliberately split for testability:
 *
 *   buildMapCommands(layout, dims)  — PURE: layout → ordered draw-command
 *                                     list (JSON-serializable, unit-tested)
 *   executeCommands / createBaseMap — thin canvas executor (not unit-tested;
 *                                     node has no canvas)
 *
 * The base map is generated ONCE at boot into an offscreen canvas; minimap
 * and fullscreen map only blit from it — never a per-frame redraw.
 */

import { MapProjection, type WorldDims } from './map-math'
import { MAP_INK, districtStyle, roadStyle } from './map-style'

// --- structural layout view -------------------------------------------------
// Accepts today's sim/gen/layout.ts Layout and stays tolerant of T50 fields
// (districts, ponds, parking, park paths) — everything beyond roads is optional.

export interface MapRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface MapLayout {
  roads: { asphalt: MapRect; sidewalks: [MapRect, MapRect]; kind?: string }[]
  lots?: { rect: MapRect }[]
  houses?: { rect: MapRect; ell?: MapRect | null; driveway?: MapRect; path?: MapRect }[]
  pools?: { basin: { x0: number; z0: number; x1: number; z1: number } }[]
  trees?: { x: number; z: number; canopyR: number }[]
  /** T50 forward-compat — all optional, table-driven styling by kind string */
  districts?: { kind: string; rect: MapRect; name?: string }[]
  ponds?: { rect: MapRect }[]
  parking?: { rect: MapRect }[]
  parkPaths?: { rect: MapRect }[]
  buildings?: { rect: MapRect; kind?: string }[]
}

// --- draw commands ------------------------------------------------------------

export type DrawCmd =
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: string; alpha?: number }
  | {
      op: 'rrect'
      x: number
      y: number
      w: number
      h: number
      r: number
      fill?: string
      stroke?: string
      lineWidth?: number
      alpha?: number
    }
  | { op: 'circle'; x: number; y: number; r: number; fill: string; alpha?: number }
  | { op: 'dash'; x0: number; y0: number; x1: number; y1: number; color: string; width: number; dash: [number, number] }
  | { op: 'label'; x: number; y: number; text: string; size: number; color: string; tracking: number }

export interface MapCommandList {
  width: number
  height: number
  cmds: DrawCmd[]
}

// --- pure generation ------------------------------------------------------------

/** inclusive voxel rect → base-px rect */
function px(proj: MapProjection, r: MapRect): { x: number; y: number; w: number; h: number } {
  const x = proj.voxelToBase(r.x0)
  const y = proj.voxelToBase(r.z0)
  return { x, y, w: proj.voxelToBase(r.x1 + 1) - x, h: proj.voxelToBase(r.z1 + 1) - y }
}

export function buildMapCommands(layout: MapLayout, dims: WorldDims): MapCommandList {
  const proj = new MapProjection(dims)
  const s = proj.scale
  const cmds: DrawCmd[] = []
  const W = proj.baseW
  const H = proj.baseH

  const districts = layout.districts ?? [
    { kind: 'suburban', rect: { x0: 0, z0: 0, x1: dims.vx - 1, z1: dims.vz - 1 } },
  ]

  // 1 — paper ground: default tint, then per-district tints
  cmds.push({ op: 'rect', x: 0, y: 0, w: W, h: H, fill: districtStyle(districts[0].kind).ground })
  for (const d of districts) {
    const r = px(proj, d.rect)
    cmds.push({ op: 'rect', ...r, fill: districtStyle(d.kind).ground })
  }

  // district lookup for lot/building tinting (voxel-space point test)
  const styleAt = (vx: number, vz: number) => {
    for (let i = districts.length - 1; i >= 0; i--) {
      const d = districts[i]
      if (vx >= d.rect.x0 && vx <= d.rect.x1 && vz >= d.rect.z0 && vz <= d.rect.z1) {
        return districtStyle(d.kind)
      }
    }
    return districtStyle(districts[0].kind)
  }
  const rectStyle = (r: MapRect) => styleAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)

  // 2 — parcels (soft, slightly greener than ground)
  for (const lot of layout.lots ?? []) {
    const r = px(proj, lot.rect)
    cmds.push({ op: 'rrect', ...r, r: 3 * s, fill: rectStyle(lot.rect).lot })
  }

  // 3 — park paths (under roads, over parcels)
  for (const p of layout.parkPaths ?? []) {
    cmds.push({ op: 'rrect', ...px(proj, p.rect), r: 1.5 * s, fill: MAP_INK.path })
  }

  // 4 — sidewalks, then ALL road casings, then ALL road fills (casing-under-
  // fill ordering makes intersections merge seamlessly, Google-style)
  for (const road of layout.roads) {
    for (const sw of road.sidewalks) cmds.push({ op: 'rect', ...px(proj, sw), fill: MAP_INK.sidewalk })
  }
  for (const road of layout.roads) {
    const st = roadStyle(road.kind)
    const r = px(proj, road.asphalt)
    cmds.push({
      op: 'rect',
      x: r.x - st.casingPx,
      y: r.y - st.casingPx,
      w: r.w + st.casingPx * 2,
      h: r.h + st.casingPx * 2,
      fill: st.casing,
    })
  }
  for (const road of layout.roads) {
    cmds.push({ op: 'rect', ...px(proj, road.asphalt), fill: roadStyle(road.kind).fill })
  }
  for (const road of layout.roads) {
    const st = roadStyle(road.kind)
    if (!st.centerLine) continue
    const r = px(proj, road.asphalt)
    const horiz = r.w >= r.h
    cmds.push({
      op: 'dash',
      x0: horiz ? r.x : r.x + r.w / 2,
      y0: horiz ? r.y + r.h / 2 : r.y,
      x1: horiz ? r.x + r.w : r.x + r.w / 2,
      y1: horiz ? r.y + r.h / 2 : r.y + r.h,
      color: MAP_INK.centerLine,
      width: 1.5 * s,
      dash: [6 * s, 5 * s],
    })
  }

  // 5 — driveways + garden paths + parking aprons
  for (const h of layout.houses ?? []) {
    if (h.driveway) cmds.push({ op: 'rect', ...px(proj, h.driveway), fill: MAP_INK.driveway })
    if (h.path) cmds.push({ op: 'rect', ...px(proj, h.path), fill: MAP_INK.path })
  }
  for (const p of layout.parking ?? []) {
    cmds.push({
      op: 'rrect',
      ...px(proj, p.rect),
      r: 2 * s,
      fill: MAP_INK.parking,
      stroke: MAP_INK.parkingStroke,
      lineWidth: 1,
    })
  }

  // 6 — water: pools + ponds, blue with a soft shoreline stroke
  for (const pool of layout.pools ?? []) {
    const r = px(proj, pool.basin)
    cmds.push({
      op: 'rrect',
      ...r,
      r: Math.min(3 * s, r.w / 2, r.h / 2),
      fill: MAP_INK.waterFill,
      stroke: MAP_INK.waterStroke,
      lineWidth: 1,
    })
  }
  for (const pond of layout.ponds ?? []) {
    const r = px(proj, pond.rect)
    cmds.push({
      op: 'rrect',
      ...r,
      r: Math.min(8 * s, r.w / 2, r.h / 2),
      fill: MAP_INK.waterFill,
      stroke: MAP_INK.waterStroke,
      lineWidth: 1,
    })
  }

  // 7 — building footprints: 1px drop shade + rounded fill (2.5D hint).
  // House + optional L-extension share one fill so the junction is invisible.
  const shade = 1.2 * s
  const footprint = (r: MapRect, corner: number) => {
    const st = rectStyle(r)
    const b = px(proj, r)
    cmds.push({ op: 'rrect', x: b.x + shade * 0.4, y: b.y + shade, w: b.w, h: b.h, r: corner, fill: st.buildingShade, alpha: 0.5 })
    cmds.push({ op: 'rrect', ...b, r: corner, fill: st.building, stroke: st.buildingShade, lineWidth: 1 })
  }
  for (const h of layout.houses ?? []) {
    if (h.ell) footprint(h.ell, 2 * s)
    footprint(h.rect, 2.5 * s)
  }
  for (const b of layout.buildings ?? []) footprint(b.rect, 2 * s)

  // 8 — tree canopies (soft translucent dots; life without noise)
  for (const t of layout.trees ?? []) {
    cmds.push({
      op: 'circle',
      x: proj.voxelToBase(t.x + 0.5),
      y: proj.voxelToBase(t.z + 0.5),
      r: Math.max(1.5, t.canopyR * s * 0.9),
      fill: MAP_INK.tree,
      alpha: MAP_INK.treeAlpha,
    })
  }

  // 9 — district labels: small caps, letterspaced, centered per district
  for (const d of districts) {
    const st = districtStyle(d.kind)
    const r = px(proj, d.rect)
    cmds.push({
      op: 'label',
      x: r.x + r.w / 2,
      y: r.y + r.h / 2,
      text: d.name ?? st.label,
      size: Math.max(14, Math.min(26, r.w * 0.045)),
      color: MAP_INK.label,
      tracking: 0.32,
    })
  }

  return { width: W, height: H, cmds }
}

// --- thin canvas executor -------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D

function rrectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function executeCommands(ctx: Ctx2D, list: MapCommandList): void {
  for (const c of list.cmds) {
    ctx.globalAlpha = 'alpha' in c && c.alpha !== undefined ? c.alpha : 1
    switch (c.op) {
      case 'rect':
        ctx.fillStyle = c.fill
        ctx.fillRect(c.x, c.y, c.w, c.h)
        break
      case 'rrect':
        rrectPath(ctx, c.x, c.y, c.w, c.h, c.r)
        if (c.fill) {
          ctx.fillStyle = c.fill
          ctx.fill()
        }
        if (c.stroke) {
          ctx.strokeStyle = c.stroke
          ctx.lineWidth = c.lineWidth ?? 1
          ctx.stroke()
        }
        break
      case 'circle':
        ctx.beginPath()
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2)
        ctx.fillStyle = c.fill
        ctx.fill()
        break
      case 'dash':
        ctx.beginPath()
        ctx.setLineDash(c.dash)
        ctx.moveTo(c.x0, c.y0)
        ctx.lineTo(c.x1, c.y1)
        ctx.strokeStyle = c.color
        ctx.lineWidth = c.width
        ctx.stroke()
        ctx.setLineDash([])
        break
      case 'label': {
        ctx.font = `600 ${c.size}px 'Chakra Petch', 'Avenir Next Condensed', sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        // letterSpacing is Chrome-only — fine, the game is WebGPU/Chrome-only (§C)
        ;(ctx as Ctx2D & { letterSpacing?: string }).letterSpacing = `${c.tracking}em`
        const text = c.text.toUpperCase()
        // paper-colored halo keeps labels legible over roads (Google-style)
        ctx.strokeStyle = MAP_INK.labelHalo
        ctx.lineWidth = Math.max(2, c.size / 5)
        ctx.lineJoin = 'round'
        ctx.strokeText(text, c.x, c.y)
        ctx.fillStyle = c.color
        ctx.fillText(text, c.x, c.y)
        ;(ctx as Ctx2D & { letterSpacing?: string }).letterSpacing = '0em'
        break
      }
    }
  }
  ctx.globalAlpha = 1
}

/** boot-time: layout → offscreen base canvas (drawn exactly once) */
export function createBaseMap(layout: MapLayout, dims: WorldDims): HTMLCanvasElement {
  const list = buildMapCommands(layout, dims)
  const canvas = document.createElement('canvas')
  canvas.width = list.width
  canvas.height = list.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('map: 2d context unavailable')
  executeCommands(ctx, list)
  return canvas
}
