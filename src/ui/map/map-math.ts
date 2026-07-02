/**
 * T70 — map projection math. Pure, canvas-free, fully unit-tested.
 *
 * Three coordinate spaces:
 *   world meters  — player positions (phys.players px/pz), 1 voxel = 0.1 m
 *   voxel         — layout.ts rects (x,z ∈ [0, WORLD_VX/VZ))
 *   base px       — the offscreen base-map canvas (BASE_SCALE px per voxel)
 */

export const METERS_PER_VOXEL = 0.1
/** cap the base canvas edge so a 2048-voxel world still fits in one texture */
export const MAX_BASE_PX = 4096

export interface WorldDims {
  /** world size in voxels along x */
  vx: number
  /** world size in voxels along z */
  vz: number
}

/** static world↔base-canvas mapping, fixed at boot */
export class MapProjection {
  readonly dims: WorldDims
  /** base-canvas pixels per voxel */
  readonly scale: number
  readonly baseW: number
  readonly baseH: number
  /** world extent in meters */
  readonly worldMx: number
  readonly worldMz: number

  constructor(dims: WorldDims) {
    this.dims = dims
    this.scale = Math.min(2, MAX_BASE_PX / Math.max(dims.vx, dims.vz))
    this.baseW = Math.round(dims.vx * this.scale)
    this.baseH = Math.round(dims.vz * this.scale)
    this.worldMx = dims.vx * METERS_PER_VOXEL
    this.worldMz = dims.vz * METERS_PER_VOXEL
  }

  /** base px per world meter */
  get basePxPerMeter(): number {
    return this.scale / METERS_PER_VOXEL
  }

  voxelToBase(v: number): number {
    return v * this.scale
  }

  worldToBaseX(xMeters: number): number {
    return (xMeters / METERS_PER_VOXEL) * this.scale
  }

  worldToBaseZ(zMeters: number): number {
    return (zMeters / METERS_PER_VOXEL) * this.scale
  }

  baseToWorldX(px: number): number {
    return (px / this.scale) * METERS_PER_VOXEL
  }

  baseToWorldZ(px: number): number {
    return (px / this.scale) * METERS_PER_VOXEL
  }
}

/**
 * Fullscreen-map camera: world-meter center + zoom (screen px per meter).
 * Screen y grows downward = world +z (north-up: -z is up on screen).
 */
export class ViewTransform {
  cx: number
  cz: number
  pxPerMeter: number
  minPxPerMeter: number
  maxPxPerMeter: number

  constructor(cx: number, cz: number, pxPerMeter: number, minZoom = 0.5, maxZoom = 32) {
    this.cx = cx
    this.cz = cz
    this.pxPerMeter = pxPerMeter
    this.minPxPerMeter = minZoom
    this.maxPxPerMeter = maxZoom
  }

  worldToScreen(xM: number, zM: number, vw: number, vh: number): [number, number] {
    return [(xM - this.cx) * this.pxPerMeter + vw / 2, (zM - this.cz) * this.pxPerMeter + vh / 2]
  }

  screenToWorld(sx: number, sy: number, vw: number, vh: number): [number, number] {
    return [(sx - vw / 2) / this.pxPerMeter + this.cx, (sy - vh / 2) / this.pxPerMeter + this.cz]
  }

  /** drag pan by screen-pixel delta */
  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.pxPerMeter
    this.cz -= dyPx / this.pxPerMeter
  }

  /** zoom by factor keeping the world point under (sx, sy) fixed on screen */
  zoomAt(sx: number, sy: number, factor: number, vw: number, vh: number): void {
    const [wx, wz] = this.screenToWorld(sx, sy, vw, vh)
    this.pxPerMeter = Math.min(this.maxPxPerMeter, Math.max(this.minPxPerMeter, this.pxPerMeter * factor))
    // re-solve center so (wx, wz) maps back to (sx, sy)
    this.cx = wx - (sx - vw / 2) / this.pxPerMeter
    this.cz = wz - (sy - vh / 2) / this.pxPerMeter
  }

  /** keep the view center within the world bounds (with slack in meters) */
  clampCenter(worldMx: number, worldMz: number, slack = 10): void {
    this.cx = Math.min(worldMx + slack, Math.max(-slack, this.cx))
    this.cz = Math.min(worldMz + slack, Math.max(-slack, this.cz))
  }
}

/** drawImage 9-arg crop, clamped to the source canvas with proportional dest offsets */
export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/**
 * Minimap crop: a srcSpan×srcSpan window (base px) centered on (srcCx, srcCy)
 * of a baseW×baseH canvas, blitted into a destSize×destSize widget. When the
 * window hangs past the world edge the source rect is clamped and the dest
 * rect shrinks/offsets proportionally (the widget shows void past the edge).
 * Returns null when the window lies fully outside the canvas.
 */
export function cropRect(
  baseW: number,
  baseH: number,
  srcCx: number,
  srcCy: number,
  srcSpan: number,
  destSize: number,
): CropRect | null {
  const half = srcSpan / 2
  const x0 = srcCx - half
  const y0 = srcCy - half
  const cx0 = Math.max(0, x0)
  const cy0 = Math.max(0, y0)
  const cx1 = Math.min(baseW, x0 + srcSpan)
  const cy1 = Math.min(baseH, y0 + srcSpan)
  if (cx1 <= cx0 || cy1 <= cy0) return null
  const k = destSize / srcSpan
  return {
    sx: cx0,
    sy: cy0,
    sw: cx1 - cx0,
    sh: cy1 - cy0,
    dx: (cx0 - x0) * k,
    dy: (cy0 - y0) * k,
    dw: (cx1 - cx0) * k,
    dh: (cy1 - cy0) * k,
  }
}

/**
 * Player arrow rotation for a north-up map, radians clockwise from screen-up.
 *
 * Derivation (render/player-cam.ts): camera rotation is (pitch, yaw, 0, 'YXZ'),
 * so the XZ look direction is (-sin yaw, -cos yaw). On a north-up map screen-x
 * = world +x and screen-y = world +z, so screen-up is world -z. The clockwise
 * angle from screen-up to the look vector is
 *   atan2(fx, -fz) = atan2(-sin yaw, cos yaw) = -yaw.
 */
export function arrowAngle(yaw: number): number {
  return -yaw
}
