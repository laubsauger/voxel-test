/**
 * T70 — map projection math. WHY these tests: the map is only trustworthy if
 * a world position always lands on the same map pixel and back (player marker
 * accuracy), pan/zoom never drifts the point under the cursor (Google-Maps
 * feel), and the minimap crop stays glued to the world edge instead of
 * smearing (drawImage with out-of-bounds source is undefined behavior).
 */
import { describe, expect, it } from 'vitest'
import {
  MapProjection,
  ViewTransform,
  arrowAngle,
  cropRect,
  METERS_PER_VOXEL,
  MAX_BASE_PX,
} from '../src/ui/map/map-math'

describe('MapProjection', () => {
  it('world meters ↔ base px round-trips exactly', () => {
    const proj = new MapProjection({ vx: 1024, vz: 1024 })
    for (const m of [0, 0.05, 12.34, 51.2, 102.4]) {
      expect(proj.baseToWorldX(proj.worldToBaseX(m))).toBeCloseTo(m, 10)
      expect(proj.baseToWorldZ(proj.worldToBaseZ(m))).toBeCloseTo(m, 10)
    }
  })

  it('voxel and meter projections agree (1 voxel = 0.1 m)', () => {
    const proj = new MapProjection({ vx: 1024, vz: 1024 })
    expect(proj.voxelToBase(512)).toBeCloseTo(proj.worldToBaseX(512 * METERS_PER_VOXEL), 10)
  })

  it('caps the base canvas for expanded worlds (T50: 2048 voxels)', () => {
    const proj = new MapProjection({ vx: 2048, vz: 2048 })
    expect(proj.baseW).toBeLessThanOrEqual(MAX_BASE_PX)
    expect(proj.baseH).toBeLessThanOrEqual(MAX_BASE_PX)
    // small worlds keep the full 2 px/voxel detail
    expect(new MapProjection({ vx: 1024, vz: 1024 }).scale).toBe(2)
  })

  it('non-square worlds project each axis independently', () => {
    const proj = new MapProjection({ vx: 2048, vz: 1024 })
    expect(proj.baseW / proj.baseH).toBeCloseTo(2, 10)
  })
})

describe('ViewTransform (fullscreen pan/zoom)', () => {
  const VW = 1280
  const VH = 800

  it('worldToScreen ↔ screenToWorld round-trips', () => {
    const v = new ViewTransform(51.2, 51.2, 8)
    const [sx, sy] = v.worldToScreen(30.5, 77.25, VW, VH)
    const [wx, wz] = v.screenToWorld(sx, sy, VW, VH)
    expect(wx).toBeCloseTo(30.5, 10)
    expect(wz).toBeCloseTo(77.25, 10)
  })

  it('view center maps to the screen center (north-up, +z = down)', () => {
    const v = new ViewTransform(10, 20, 4)
    expect(v.worldToScreen(10, 20, VW, VH)).toEqual([VW / 2, VH / 2])
    // a point north of center (-z) must appear ABOVE center
    const [, sy] = v.worldToScreen(10, 15, VW, VH)
    expect(sy).toBeLessThan(VH / 2)
  })

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const v = new ViewTransform(51.2, 51.2, 6)
    const cursor: [number, number] = [973, 121]
    const before = v.screenToWorld(...cursor, VW, VH)
    v.zoomAt(...cursor, 1.7, VW, VH)
    const after = v.screenToWorld(...cursor, VW, VH)
    expect(after[0]).toBeCloseTo(before[0], 9)
    expect(after[1]).toBeCloseTo(before[1], 9)
  })

  it('zoom clamps to min/max and still re-anchors the cursor point', () => {
    const v = new ViewTransform(51.2, 51.2, 6, 2, 12)
    v.zoomAt(100, 100, 100, VW, VH) // would blow past max
    expect(v.pxPerMeter).toBe(12)
    v.zoomAt(100, 100, 1e-6, VW, VH)
    expect(v.pxPerMeter).toBe(2)
  })

  it('panBy moves the view opposite the drag (content follows the cursor)', () => {
    const v = new ViewTransform(50, 50, 10)
    v.panBy(30, -20) // drag right+up → view center moves left+down in world
    expect(v.cx).toBeCloseTo(47, 10)
    expect(v.cz).toBeCloseTo(52, 10)
  })

  it('clampCenter keeps the camera near the world', () => {
    const v = new ViewTransform(-500, 9999, 10)
    v.clampCenter(102.4, 102.4, 10)
    expect(v.cx).toBe(-10)
    expect(v.cz).toBe(112.4)
  })
})

describe('cropRect (minimap blit window)', () => {
  it('interior window: full source, full dest', () => {
    const c = cropRect(2048, 2048, 1024, 1024, 600, 140)!
    expect(c).toEqual({ sx: 724, sy: 724, sw: 600, sh: 600, dx: 0, dy: 0, dw: 140, dh: 140 })
  })

  it('window past the -edge: source clamps, dest offsets proportionally', () => {
    const c = cropRect(2048, 2048, 100, 1024, 600, 140)!
    expect(c.sx).toBe(0)
    expect(c.sw).toBe(400) // 100 + 300
    // the missing 200 src px map to 200 * (140/600) dest px of void
    expect(c.dx).toBeCloseTo(200 * (140 / 600), 10)
    expect(c.dw).toBeCloseTo(400 * (140 / 600), 10)
    expect(c.dx + c.dw).toBeCloseTo(140, 10) // flush to the widget's far edge
  })

  it('window past the +edge clamps symmetrically', () => {
    const c = cropRect(2048, 2048, 2048, 2048, 600, 140)!
    expect(c.sx + c.sw).toBe(2048)
    expect(c.sy + c.sh).toBe(2048)
    expect(c.dx).toBe(0)
    expect(c.dw).toBeCloseTo(70, 10) // half the window hangs off
  })

  it('window fully outside → null (draw nothing, not garbage)', () => {
    expect(cropRect(2048, 2048, -400, 1024, 600, 140)).toBeNull()
  })
})

describe('arrowAngle (north-up yaw → screen rotation)', () => {
  // player-cam.ts: look XZ = (-sin yaw, -cos yaw); screen-up = world -z
  it('yaw 0 looks toward -z → arrow points up (0)', () => {
    expect(arrowAngle(0)).toBeCloseTo(0, 12)
  })
  it('yaw +π/2 looks toward -x (west) → arrow rotates counter-clockwise', () => {
    expect(arrowAngle(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 10)
  })
})
