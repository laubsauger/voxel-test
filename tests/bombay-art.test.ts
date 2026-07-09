/**
 * T104 — Bombay Beach in-grid art installation stamps (V2 determinism, V19
 * chroma placement). Stamps stampBombay_art alone on a bare store (ground
 * falls back to layout.groundY), then checks each installation's voxel
 * signature inside its zone rect.
 */
import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { generateLayout, type BombayZone, type Layout, type Rect } from '../src/sim/gen/layout'
import { stampBombay_art } from '../src/sim/gen/bombay/art'
import {
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_ART_YELLOW,
  MAT_CHAR,
  MAT_GALV_METAL,
  MAT_OPERA_BLUE,
  MAT_PLASTER,
  MAT_RUST,
} from '../src/sim/materials'

const ART_POPS = [MAT_ART_RED, MAT_ART_YELLOW, MAT_ART_TEAL, MAT_ART_PINK]
const CHROMA = [...ART_POPS, MAT_OPERA_BLUE]

let cache: { store: ChunkStore; layout: Layout; zone: BombayZone } | null = null
function stamped(): { store: ChunkStore; layout: Layout; zone: BombayZone } {
  if (!cache) {
    const layout = generateLayout(7)
    const zone = layout.bombay
    if (!zone) throw new Error('seed 7: bombay zone missing')
    const store = new ChunkStore()
    stampBombay_art(store, layout, zone)
    cache = { store, layout, zone }
  }
  return cache
}

function rectOf(zone: BombayZone, kind: string): Rect {
  const l = zone.landmarks.find((m) => m.kind === kind)
  if (!l) throw new Error(`landmark ${kind} missing`)
  return l.rect
}

/** 6-connected flood-fill clusters inside rect × [y0,y1]. sameMat: voxels
 * only join when they share a material id (TV boxes); otherwise any listed
 * mat coheses (car hulks). */
function clusters(
  store: ChunkStore,
  r: Rect,
  y0: number,
  y1: number,
  mats: number[],
  sameMat: boolean,
): { mat: number; cells: [number, number, number][] }[] {
  const inMats = new Set(mats)
  const seen = new Set<string>()
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const out: { mat: number; cells: [number, number, number][] }[] = []
  for (let x = r.x0; x <= r.x1; x++) {
    for (let z = r.z0; z <= r.z1; z++) {
      for (let y = y0; y <= y1; y++) {
        const m = store.getVoxel(x, y, z)
        if (!inMats.has(m) || seen.has(key(x, y, z))) continue
        const cells: [number, number, number][] = []
        const stack: [number, number, number][] = [[x, y, z]]
        seen.add(key(x, y, z))
        while (stack.length > 0) {
          const [cx, cy, cz] = stack.pop()!
          cells.push([cx, cy, cz])
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const nx = cx + dx, ny = cy + dy, nz = cz + dz
            if (nx < r.x0 || nx > r.x1 || nz < r.z0 || nz > r.z1 || ny < y0 || ny > y1) continue
            if (seen.has(key(nx, ny, nz))) continue
            const nm = store.getVoxel(nx, ny, nz)
            if (!inMats.has(nm) || (sameMat && nm !== m)) continue
            seen.add(key(nx, ny, nz))
            stack.push([nx, ny, nz])
          }
        }
        out.push({ mat: m, cells })
      }
    }
  }
  return out
}

describe('bombay art stamps (T104, V2/V19)', () => {
  it('drive-in: ≥8 separate rust hulks facing a white screen box at the berm end', () => {
    // WHY: the drive-in must read as ROWS of distinct car wrecks aimed at one
    // white screen — merged hulks or a missing screen kills the landmark.
    const { store, layout, zone } = stamped()
    const r = rectOf(zone, 'driveIn')
    const g = layout.groundY
    const hulks = clusters(store, r, g - 2, g + 60, [MAT_RUST], false)
    // each hulk is a real car-scale mass, not a stray voxel
    const big = hulks.filter((c) => c.cells.length > 500)
    expect(big.length, 'separate rust car hulks').toBeGreaterThanOrEqual(8)

    // white plaster box-trailer screen (60×8×30) in the berm (east) half
    let plaster = 0
    let minX = Infinity
    for (let x = r.x0; x <= r.x1; x++) {
      for (let z = r.z0; z <= r.z1; z++) {
        for (let y = g; y <= g + 60; y++) {
          if (store.getVoxel(x, y, z) === MAT_PLASTER) {
            plaster++
            minX = Math.min(minX, x)
          }
        }
      }
    }
    expect(plaster, 'screen box volume').toBeGreaterThanOrEqual(14000)
    expect(minX, 'screen sits at the berm end').toBeGreaterThan(r.x0 + (r.x1 - r.x0) / 2)
  })

  it('opera house: rect carries opera blue + ≥3 distinct art-pop ids on the facade', () => {
    // WHY: V19 — the opera house is one of the few sanctioned chroma spots;
    // the flip-flop band needs a MIX of pops, not a single accent color.
    const { store, layout, zone } = stamped()
    const r = rectOf(zone, 'operaHouse')
    const g = layout.groundY
    let blue = 0
    const pops = new Set<number>()
    for (let x = r.x0; x <= r.x1; x++) {
      for (let z = r.z0; z <= r.z1; z++) {
        for (let y = g - 2; y <= g + 40; y++) {
          const m = store.getVoxel(x, y, z)
          if (m === MAT_OPERA_BLUE) blue++
          else if (ART_POPS.includes(m)) pops.add(m)
        }
      }
    }
    expect(blue, 'opera-blue shell').toBeGreaterThan(1000)
    expect(pops.size, 'distinct art-pop ids in the speckle band').toBeGreaterThanOrEqual(3)
  })

  it('TV wall: ≥20 distinct color-block clusters, each with a char screen face', () => {
    // WHY: the TV lot reads as MANY individually painted sets — same-color
    // boxes fused together, or screens missing, and it becomes a paint blob.
    const { store, layout, zone } = stamped()
    const r = rectOf(zone, 'tvWall')
    const g = layout.groundY
    const boxes = clusters(store, r, g - 2, g + 50, CHROMA, true)
    const withScreens = boxes.filter((b) =>
      b.cells.some(([x, y, z]) =>
        [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(
          ([dx, dy, dz]) => store.getVoxel(x + dx, y + dy, z + dz) === MAT_CHAR,
        ),
      ),
    )
    expect(withScreens.length, 'painted TVs with char screens').toBeGreaterThanOrEqual(20)
    expect(boxes.length, 'box count stays in the 24-40 research band').toBeLessThanOrEqual(40)
  })

  it('da vinci fish: rust spine ≥100 vox long at pole height, on a galv pole', () => {
    // WHY: the fish is the 12 m skyline piece — a short or grounded spine
    // means the skeleton collapsed into a lump.
    const { store, layout, zone } = stamped()
    const r = rectOf(zone, 'daVinciFish')
    const g = layout.groundY
    const fx = (r.x0 + r.x1) >> 1
    const fz = (r.z0 + r.z1) >> 1
    let zMin = Infinity
    let zMax = -Infinity
    for (let z = r.z0 - 100; z <= r.z1 + 100; z++) {
      for (let y = g + 24; y <= g + 25; y++) {
        for (let x = fx - 2; x <= fx + 1; x++) {
          if (store.getVoxel(x, y, z) === MAT_RUST) {
            zMin = Math.min(zMin, z)
            zMax = Math.max(zMax, z)
          }
        }
      }
    }
    expect(zMax - zMin + 1, 'spine length at pole height').toBeGreaterThanOrEqual(100)
    expect(store.getVoxel(fx, g + 12, fz), 'galv support pole').toBe(MAT_GALV_METAL)
  })

  it('deterministic: double-stamp produces the identical write stream (V2)', () => {
    // WHY: MP lockstep + reload parity — any hash/order leak in the art
    // stamps desyncs every client at boot.
    const run = (): { h: number; n: number } => {
      const layout = generateLayout(7)
      const zone = layout.bombay
      if (!zone) throw new Error('bombay zone missing')
      const store = new ChunkStore()
      let h = 0
      let n = 0
      const mix = (v: number): void => {
        h = (Math.imul(h, 31) + (v | 0)) | 0
      }
      const origSet = store.setVoxel.bind(store)
      const origFill = store.fillBox.bind(store)
      store.setVoxel = (x, y, z, m): void => {
        mix(x); mix(y); mix(z); mix(m); n++
        origSet(x, y, z, m)
      }
      store.fillBox = (x0, y0, z0, x1, y1, z1, m): void => {
        mix(x0); mix(y0); mix(z0); mix(x1); mix(y1); mix(z1); mix(m); n++
        origFill(x0, y0, z0, x1, y1, z1, m)
      }
      stampBombay_art(store, layout, zone)
      return { h, n }
    }
    const a = run()
    const b = run()
    expect(a.n, 'art actually stamps something').toBeGreaterThan(100)
    expect(b.n).toBe(a.n)
    expect(b.h).toBe(a.h)
  })
})
