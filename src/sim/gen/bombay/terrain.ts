/**
 * T100 — Bombay Beach terrain: seaward terraces, flood berm, salt playa, sea
 * basin (research §1.2-1.4, §3 WP2). Runs in the stampScene bombay slot AFTER
 * city roads, so every surface here overwrites the grid inside the zone; the
 * other bombay stampers (streets/lots/civic/art) stamp ON these surfaces.
 *
 * Height plan (g = layout.groundY = town WEST-edge street grade, the datum):
 * - town ground: sand + dirt patches, falls east in 1-vox terraces. FALL_TOWN
 *   (10) is spent INSIDE the street grid — every street top stays g-1-10 = 37,
 *   strictly ABOVE the sea surface (sea.y1 = 36, V18 "look down") — the rest
 *   of FALL_TOTAL (24) drops between the last street band and the berm foot.
 *   Step boundaries snap clear of the N-S street bands (center ± 40, + the
 *   5th-St bend offset) so no street straddles a step mid-band.
 * - berm: trapezoid dike on zone.berm, crest x follows the jittered crest
 *   polyline. Crest WALK level = g + h (40 above the datum street grade, not
 *   the local fallen grade — V18 needs crest > every street surface + eye 17,
 *   and 40-24 alone is not enough). Dirt body, sand face wash, sparse concrete
 *   riprap on the seaward face; 3 ramp cut-throughs (saddle crest-16, tent
 *   sides at ≤RAMP_GRADE=2 vox/step → walkable + drivable 1:2).
 * - playa: g-2 at the berm foot → sea.y1 at the waterline (rim EXACTLY sea.y1
 *   for the last RIM_W columns: water at sea.y1 can never step west onto it).
 *   Salt crust 2 vox over playa mud, cracked-mud patches (mud through crust),
 *   bone-shell speckle densifying at the old waterline (sea.x0 - 180), ±1
 *   hummocks (flat in the ramp exit corridors — the two-tracks keep driving).
 * - sea: basin carved to sea.y0, mud floor + mud shore shelf. The WATER fill
 *   is stampScene's via the returned seaFill box (V9 — the CA owns the mass);
 *   this module only shapes the basin. No-flood: rim = sea.y1, ramp saddles
 *   g+23, crest g+39 — every westward path out of the box is solid ≥ surface.
 */
import type { ChunkStore } from '../../../world/chunks'
import type { Box, BombayZone, Layout } from '../layout'
import { hash3, valueNoise } from '../stamper'
import {
  MAT_AIR,
  MAT_BONE_SHELL,
  MAT_CONCRETE,
  MAT_DIRT,
  MAT_PLAYA_MUD,
  MAT_SALT_CRUST,
  MAT_SAND,
} from '../../materials'

const FALL_TOWN = 10 // terrace drop spent inside the street grid (street tops stay above sea.y1)
const FALL_TOTAL = 24 // west edge → berm foot, 2.4 m (spec 20-30 vox)
const RAMP_CUT = 16 // crest lowered this much at a ramp centre (saddle still ≫ eye line)
const RAMP_GRADE = 2 // max vox per step on ramp tents (1:2 — drivable)
const RAMP_TOE = 45 // ramp tents may run this far west of the strip (flared approach)
const RIM_W = 40 // waterline columns pinned to sea.y1 (containment rim)
const SHELF_W = 80 // underwater mud shore shelf width
const CORRIDOR_E = 120 // ramp two-track continues flat this far onto the playa
const OLD_WL_OFF = 180 // old waterline mark, west of today's water (recession)
const SKY = 12 // carve air to g+SKY (wipes old city surface/roads/markings)

/** step-boundary x positions (ascending). FALL_TOWN evenly across the street
 * grid, the rest evenly between the last street band and the berm foot; each
 * snapped out of the N-S street bands so a street never straddles a step. */
function terraceBounds(zone: BombayZone): number[] {
  const x0 = zone.town.x0
  const xEnd = zone.berm.strip.x0 - 1
  // forbidden bands: every z-axis street/alley/spur, center ± 40 (+ bend)
  const bands: [number, number][] = []
  for (const s of [...zone.streets, ...zone.alleys, zone.spur]) {
    if (s.axis !== 'z') continue
    bands.push([s.center - 40, s.center + 40 + (s.bend ? Math.max(0, s.bend.offset) : 0)])
  }
  const knee = Math.max(...bands.map((b) => b[1])) + 6 // east edge of the street grid
  const snap = (b: number): number => {
    for (let guard = 0; guard < 8; guard++) {
      const hit = bands.find(([lo, hi]) => b >= lo && b <= hi)
      if (!hit) break
      b = b - hit[0] < hit[1] - b ? hit[0] - 1 : hit[1] + 1
    }
    return b
  }
  const out: number[] = []
  for (let i = 1; i <= FALL_TOWN; i++) out.push(snap(x0 + Math.round((i * (knee - x0)) / (FALL_TOWN + 1))))
  const rest = FALL_TOTAL - FALL_TOWN
  for (let i = 1; i <= rest; i++) out.push(knee + Math.round((i * (xEnd - knee)) / (rest + 1)))
  return out.sort((a, b) => a - b)
}

/** crest x at z — clamped piecewise-linear along the jittered polyline */
function crestXAt(pts: { x: number; z: number }[], z: number): number {
  if (z <= pts[0].z) return pts[0].x
  for (let i = 1; i < pts.length; i++) {
    if (z <= pts[i].z) {
      const a = pts[i - 1]
      const b = pts[i]
      return Math.round(a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z))
    }
  }
  return pts[pts.length - 1].x
}

export function stampBombay_terrain(store: ChunkStore, layout: Layout, zone: BombayZone): { seaFill: Box | null } {
  const g = layout.groundY
  const seed = layout.seed
  const { town, berm, playa, sea } = zone
  const strip = berm.strip
  const z0 = town.z0
  const z1 = town.z1

  // ---- 1. town ground: terraced sand, west edge → berm foot ---------------
  const bounds = terraceBounds(zone)
  const gx0 = town.x0
  const gx1 = strip.x0 - 1
  const lvl = new Uint8Array(gx1 - gx0 + 1) // terrace level per x (toe floors below)
  {
    let segStart = gx0
    for (let i = 0; i <= bounds.length; i++) {
      const segEnd = i < bounds.length ? bounds[i] - 1 : gx1
      const top = g - 1 - i
      store.fillBox(segStart, top - 2, z0, segEnd, top, z1, MAT_SAND)
      store.fillBox(segStart, top + 1, z0, segEnd, g + SKY, z1, MAT_AIR) // wipe old grass/roads
      lvl.fill(i, segStart - gx0, segEnd - gx0 + 1)
      segStart = segEnd + 1
    }
    // dirt patches through the sand (playa-adjacent scrappy ground)
    const ds = (seed ^ 0x7100d1) >>> 0
    for (let z = z0; z <= z1; z++) {
      for (let x = gx0; x <= gx1; x++) {
        if (valueNoise(x, z, 31, ds) > 0.63) store.setVoxel(x, g - 1 - lvl[x - gx0], z, MAT_DIRT)
      }
    }
  }

  // ---- 2. playa: salt crust / cracked mud / bone-shell band ---------------
  {
    const rim0 = playa.x1 - (RIM_W - 1)
    const wBase = g - 2 // berm east foot grade
    const base = new Int16Array(playa.x1 - playa.x0 + 1)
    for (let x = playa.x0; x <= playa.x1; x++) {
      base[x - playa.x0] = x >= rim0 ? sea.y1 : Math.round(wBase + ((sea.y1 - wBase) * (x - playa.x0)) / (rim0 - playa.x0))
      store.fillBox(x, base[x - playa.x0] + 2, z0, x, g + SKY, z1, MAT_AIR)
    }
    const oldWL = sea.x0 - OLD_WL_OFF
    const hs = (seed ^ 0x7100b2) >>> 0 // hummocks
    const cs = (seed ^ 0x7100c3) >>> 0 // mud cracks
    const bs = (seed ^ 0x7100e4) >>> 0 // bone speckle
    for (let z = z0; z <= z1; z++) {
      const corridorRow = berm.ramps.some((r) => Math.abs(z - r.z) <= r.w >> 1)
      for (let x = playa.x0; x <= playa.x1; x++) {
        const b = base[x - playa.x0]
        const corridor = corridorRow && x <= playa.x0 + CORRIDOR_E
        const rim = x >= rim0
        let n = 0
        if (!corridor && !rim) {
          const vn = valueNoise(x, z, 17, hs)
          n = vn < 0.33 ? -1 : vn > 0.74 ? 1 : 0 // dried-mud hummocks ±1
        }
        const top = b + n
        const crack = valueNoise(x, z, 26, cs) > 0.66
        const surf = corridor ? MAT_DIRT : crack ? MAT_PLAYA_MUD : MAT_SALT_CRUST
        let topMat = surf
        if (surf === MAT_SALT_CRUST) {
          // bone-shell speckle, densifying toward the old waterline mark
          const d = (x - oldWL) / 110
          if (hash3(x, 7, z, bs) / 0xffffffff < 0.015 + 0.28 * Math.exp(-d * d)) topMat = MAT_BONE_SHELL
        }
        for (let y = b - 5; y <= b + 1; y++) {
          store.setVoxel(x, y, z, y > top ? MAT_AIR : y === top ? topMat : y === top - 1 ? surf : MAT_PLAYA_MUD)
        }
      }
    }
  }

  // ---- 3. sea basin (shape only — the water fill is stampScene's, V9) -----
  {
    store.fillBox(sea.x0, sea.y0, z0, sea.x1, g + SKY, z1, MAT_AIR) // carve out old ground
    store.fillBox(sea.x0, sea.y0 - 8, z0, sea.x1, sea.y0 - 1, z1, MAT_PLAYA_MUD) // basin floor
    for (let i = 0; i < SHELF_W; i++) {
      // shore shelf: floor eases from just under the surface down to the basin floor
      const ftop = sea.y1 - 1 - Math.round(((sea.y1 - sea.y0) * i) / (SHELF_W - 1))
      if (ftop >= sea.y0) store.fillBox(sea.x0 + i, sea.y0, z0, sea.x0 + i, ftop, z1, MAT_PLAYA_MUD)
    }
  }

  // ---- 4. berm (last — ramp toes overlay the terraces/playa) --------------
  {
    const crestTop = g + berm.h - 1 // walk level = datum street grade + h
    const cHalf = berm.crestW >> 1
    const westBase = g - 1 - FALL_TOTAL // meets the last terrace at the foot
    const eastBase = g - 2 // meets the playa west edge
    const ws = (seed ^ 0x7100f5) >>> 0 // face sand wash
    const rs = (seed ^ 0x710a06) >>> 0 // riprap
    for (let z = strip.z0; z <= strip.z1; z++) {
      const cx = crestXAt(berm.crest, z)
      const cxW = cx - cHalf
      const cxE = cx + cHalf
      // ramp saddle: full cut at the centre, cosine-eased to none at the band edge
      let saddle = crestTop
      let onRamp = false
      for (const r of berm.ramps) {
        const d = Math.abs(z - r.z) / (r.w >> 1)
        if (d <= 1) {
          onRamp = true
          saddle = crestTop - Math.round(RAMP_CUT * (0.5 + 0.5 * Math.cos(Math.PI * d)))
        }
      }
      const xLo = onRamp ? strip.x0 - RAMP_TOE : strip.x0
      for (let x = xLo; x <= strip.x1; x++) {
        const floor = x < strip.x0 ? g - 1 - lvl[x - gx0] : x < cx ? westBase : eastBase
        let top: number
        let rampSurf = false
        if (onRamp) {
          // tent profile: plateau at the saddle, sides at ≤RAMP_GRADE per step
          const tent = x < cxW ? saddle - RAMP_GRADE * (cxW - x) : x > cxE ? saddle - RAMP_GRADE * (x - cxE) : saddle
          if (tent <= floor && x < strip.x0) continue // west of the toe — terrace already stamped
          top = Math.max(tent, floor)
          rampSurf = tent >= floor
        } else {
          top =
            x < cxW
              ? Math.round(westBase + ((crestTop - westBase) * (x - strip.x0)) / (cxW - strip.x0))
              : x > cxE
                ? Math.round(crestTop + ((eastBase - crestTop) * (x - cxE)) / (strip.x1 - cxE))
                : crestTop
        }
        store.fillBox(x, top + 1, z, x, g + SKY, z, MAT_AIR) // old ground pokes out where top < g-1
        store.fillBox(x, Math.min(top, westBase - 6), z, x, top, z, MAT_DIRT)
        if (rampSurf) continue // ramp two-track stays bare dirt
        if (x >= cxW && x <= cxE) {
          // crest two-track: dirt with sparse blown sand
          if (valueNoise(x, z, 23, ws) > 0.62) store.setVoxel(x, top, z, MAT_SAND)
        } else if (x < cxW) {
          if (valueNoise(x, z, 21, ws) > 0.45) store.setVoxel(x, top, z, MAT_SAND) // town-face wash
        } else {
          if (valueNoise(x, z, 21, ws) > 0.5) store.setVoxel(x, top, z, MAT_SAND) // sea-face wash
          if (hash3(x, 3, z, rs) % 89 === 0) {
            // sparse riprap block on the seaward face
            store.fillBox(x, top, z, Math.min(x + 1, strip.x1), top + 1, Math.min(z + 1, strip.z1), MAT_CONCRETE)
          }
        }
      }
    }
  }

  return { seaFill: { ...sea } }
}
