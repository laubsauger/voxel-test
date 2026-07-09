/**
 * T105 — WP7 Bombay Beach playa dressing east of the berm: the postcard shots
 * (docs/research/bombay-beach.md §1.3, §1.5 on-the-beach list, §3 WP7, §4
 * vibe items 2/3/9). Runs AFTER stampBombay_art (which owns textSign/star/
 * creature) — this module stamps only the beach-side zone.art kinds:
 * swingSet, buriedTrailer[], pilingRow, dock, lodestar — plus the waterline
 * band (fish-bone speckle intensification, beached boat hulk, salt-scum line).
 *
 * Discipline:
 * - V18: nothing here may rise above the berm crest walk level (g+h-1 = the
 *   reveal line) EXCEPT the Lodestar — the horizon landmark east of the berm
 *   is allowed (iconic) to poke above it. Buried ruins are hard-capped.
 * - No floaters: every above-surface voxel connects down through its own
 *   structure into the ground (the collapse system fells true floaters at
 *   scale) — the half-buried helper prunes ragged-drop orphans with a
 *   ground-anchored flood before writing anything.
 * - V2: hash3-only variation (no Prng stream, no transcendentals — tilt is a
 *   fixed-point integer shear); ground probes read the store AFTER terrain in
 *   stampBombay's fixed order, so double-stamps are write-identical.
 */
import type { ChunkStore } from '../../../world/chunks'
import { hash3 } from '../stamper'
import {
  MAT_AIR,
  MAT_ART_PINK,
  MAT_ART_RED,
  MAT_ART_TEAL,
  MAT_BONE_SHELL,
  MAT_CHAR,
  MAT_GALV_METAL,
  MAT_GLASS,
  MAT_METAL,
  MAT_PLASTER,
  MAT_PLAYA_MUD,
  MAT_RUST,
  MAT_SALT_CRUST,
  MAT_WOOD,
} from '../../materials'
import type { BombayArt, BombayZone, Layout } from '../layout'

const NB6: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/** highest solid y in a column (terrain stamps before playa, so this sees the
 * real grade); layout.groundY-1 on a bare store (unit-test fallback) */
function surfTop(store: ChunkStore, g: number, x: number, z: number): number {
  for (let y = g + 59; y >= 2; y--) {
    if (store.getVoxel(x, y, z) !== MAT_AIR) return y
  }
  return g - 1
}

/** position-hash uniform in [0,1) */
const h01 = (a: number, b: number, c: number, s: number): number => hash3(a, b, c, s) / 0x100000000

/** playa terrain-surface family (safe to overprint with bone speckle) */
const terrFam = (m: number): boolean => m === MAT_SALT_CRUST || m === MAT_PLAYA_MUD || m === MAT_BONE_SHELL

/** keep-out box for the buried-ruin placer (|dx|<rx && |dz|<rz collides) */
interface KeepBox { x: number; z: number; rx: number; rz: number }

export function stampBombay_playa(store: ChunkStore, layout: Layout, zone: BombayZone): void {
  const g = layout.groundY
  const swing = zone.art.find((a) => a.kind === 'swingSet')
  const lode = zone.art.find((a) => a.kind === 'lodestar')
  const row = zone.art.find((a) => a.kind === 'pilingRow')
  const dock = zone.art.find((a) => a.kind === 'dock')
  const trailers = zone.art.filter((a) => a.kind === 'buriedTrailer')

  // waterline band first — structures then overprint the speckle, never vice versa
  stampWaterline(store, layout, zone, dock)

  // buried ruins keep clear of the swing set's isolation ring (its WHOLE point
  // is being alone mid-playa), the Lodestar footprint, the piling/dock lines
  // and the ramp-exit two-tracks (they must stay drivable)
  const keep: KeepBox[] = []
  if (swing) keep.push({ x: swing.x, z: swing.z, rx: 100, rz: 100 })
  if (lode) keep.push({ x: lode.x, z: lode.z, rx: 120, rz: 120 })
  if (row) {
    const len = row.len ?? 600
    keep.push({ x: row.x + (len >> 1), z: row.z, rx: (len >> 1) + 30, rz: 48 })
  }
  if (dock) {
    const len = dock.len ?? 140
    keep.push({ x: dock.x + (len >> 1), z: dock.z, rx: (len >> 1) + 30, rz: 40 })
  }
  for (const r of zone.berm.ramps) {
    keep.push({ x: zone.playa.x0 + 80, z: r.z, rx: 90, rz: (r.w >> 1) + 28 })
  }
  for (const t of trailers) {
    const [tx, tz] = placeRuin(zone, t, keep)
    stampBuriedRuin(store, g, t, tx, tz)
  }

  if (row) stampPilingRow(store, g, row)
  if (dock) stampDock(store, g, zone, dock)
  if (lode) stampLodestar(store, g, lode)
  if (swing) stampSwingSet(store, g, swing)
}

/** deterministic nudge out of the keep-out boxes (V2: pure geometry, no rng) */
function placeRuin(zone: BombayZone, t: BombayArt, keep: KeepBox[]): [number, number] {
  const p = zone.playa
  const tx = Math.min(Math.max(t.x, p.x0 + 24), p.x0 + 300)
  let tz = Math.min(Math.max(t.z, p.z0 + 40), p.z1 - 40)
  for (let guard = 0; guard < 6; guard++) {
    const hit = keep.find((k) => Math.abs(tx - k.x) < k.rx && Math.abs(tz - k.z) < k.rz)
    if (!hit) break
    tz = tz < hit.z ? hit.z - hit.rz - 24 : hit.z + hit.rz + 24
  }
  return [tx, Math.min(Math.max(tz, p.z0 + 40), p.z1 - 40)]
}

// ---------------------------------------------------------------------------
// Half-buried tilted trailer/house ruin — THE half-buried stamp helper (WP7).
// Hollow galv/plaster shell ~40×20×16, whole-voxel integer shear per length
// slice (tiltDeg 45 → 1:1), sunk 30-70% below the playa surface, ~40% ragged
// drop on the exposed part, then a ground-anchored flood prune so nothing
// floats. 1-vox bone salt-crust lip where the shell breaks the surface.
// ---------------------------------------------------------------------------
function stampBuriedRuin(store: ChunkStore, g: number, a: BombayArt, tx: number, tz: number): void {
  const s = a.seed >>> 0
  const L = 36 + (hash3(1, 2, 3, s) % 8) // length 36..43
  const W = 18 + (hash3(2, 3, 4, s) % 4) // width 18..21
  const H = 16
  const alongX = a.rot % 2 === 0
  const tilt = a.tiltDeg ?? 12
  const S = tilt >= 40 ? 256 : tilt * 5 // fixed-point shear: dy = (li*S)>>8 ≈ li*tan(tilt)
  const shellMat = hash3(3, 4, 5, s) % 3 === 0 ? MAT_PLASTER : MAT_GALV_METAL

  const rx0 = alongX ? tx - (L >> 1) : tx - (W >> 1)
  const rz0 = alongX ? tz - (W >> 1) : tz - (L >> 1)
  const rx1 = rx0 + (alongX ? L : W) - 1
  const rz1 = rz0 + (alongX ? W : L) - 1

  // pre-stamp surface map (grown 1 for the salt lip ring) — probing after our
  // own writes would see the shell, not the ground
  const sw = rx1 - rx0 + 3
  const surf = new Int16Array(sw * (rz1 - rz0 + 3))
  const sAt = (x: number, z: number): number => surf[(z - rz0 + 1) * sw + (x - rx0 + 1)]
  for (let z = rz0 - 1; z <= rz1 + 1; z++) {
    for (let x = rx0 - 1; x <= rx1 + 1; x++) surf[(z - rz0 + 1) * sw + (x - rx0 + 1)] = surfTop(store, g, x, z)
  }

  // sink 30-70% of the shell height below the local surface; then hard-cap the
  // high end below the berm crest walk level (V18: never block the reveal)
  const frac = 0.3 + 0.4 * ((hash3(4, 5, 6, s) % 1000) / 1000)
  let base = sAt(tx, tz) - Math.round(H * frac)
  const topMax = base + H - 1 + (((L - 1) * S) >> 8)
  const cap = g + 34 // crest walk level is g+39 — keep 5 vox of air under the reveal line
  if (topMax > cap) base -= topMax - cap

  // collect the hollow-shell cells, ragged-drop ~40% of the exposed part
  interface Cell { x: number; y: number; z: number }
  const cells = new Map<string, Cell>()
  const anchors: string[] = []
  for (let li = 0; li < L; li++) {
    const lift = (li * S) >> 8
    for (let wi = 0; wi < W; wi++) {
      const x = alongX ? rx0 + li : rx0 + wi
      const z = alongX ? rz0 + wi : rz0 + li
      const st = sAt(x, z)
      for (let hi = 0; hi < H; hi++) {
        if (li !== 0 && li !== L - 1 && wi !== 0 && wi !== W - 1 && hi !== 0 && hi !== H - 1) continue
        const y = base + hi + lift
        if (y > st && h01(x, y, z, s ^ 0x7a11ed) < 0.38) continue // ragged drop
        const k = `${x},${y},${z}`
        cells.set(k, { x, y, z })
        if (y <= st + 1) anchors.push(k) // buried or resting directly on the ground
      }
    }
  }
  // ground flood: prune whatever the ragged drop disconnected (no floaters —
  // the collapse system would fell them on the first damage tick)
  const reach = new Set<string>(anchors)
  const stack = anchors.slice()
  while (stack.length > 0) {
    const c = cells.get(stack.pop()!)!
    for (const [dx, dy, dz] of NB6) {
      const nk = `${c.x + dx},${c.y + dy},${c.z + dz}`
      if (cells.has(nk) && !reach.has(nk)) {
        reach.add(nk)
        stack.push(nk)
      }
    }
  }
  const colHit = new Set<string>()
  for (const k of reach) {
    const c = cells.get(k)!
    const m = h01(c.x, c.y ^ 5, c.z, s ^ 0x275757) < 0.12 ? MAT_RUST : shellMat // rust streaks
    store.setVoxel(c.x, c.y, c.z, m)
    if (Math.abs(c.y - sAt(c.x, c.z)) <= 1) colHit.add(`${c.x},${c.z}`)
  }
  // salt-crust lip: 1-vox bone ring on the ground around the surface break
  for (let z = rz0 - 1; z <= rz1 + 1; z++) {
    for (let x = rx0 - 1; x <= rx1 + 1; x++) {
      if (colHit.has(`${x},${z}`)) continue
      let edge = false
      for (let dz = -1; dz <= 1 && !edge; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx !== 0 || dz !== 0) && colHit.has(`${x + dx},${z + dz}`)) {
            edge = true
            break
          }
        }
      }
      if (!edge) continue
      const st = sAt(x, z)
      if (terrFam(store.getVoxel(x, st, z))) store.setVoxel(x, st, z, MAT_BONE_SHELL)
    }
  }
}

// ---------------------------------------------------------------------------
// Swing set — "The Water Ain't That Bad, It's Just Salty": 2 galv A-frames
// (2×2 legs, ~34 tall) + a 24-span top bar, two 1-vox char seats on 1×1 rust
// chains hanging to ~8 above the crust. ALONE mid-playa — the recession
// marker (research §1.5, vibe #3). Isolation is enforced by the ruin placer.
// ---------------------------------------------------------------------------
function stampSwingSet(store: ChunkStore, g: number, a: BombayArt): void {
  const sx = a.x
  const sz = a.z
  const gy = surfTop(store, g, sx, sz) + 1
  const H = 34 // apex height; the bar is the top 2 vox
  const z0 = sz - 12
  const z1 = sz + 11 // bar spans 24
  for (let dy = 0; dy < H - 2; dy++) {
    const dx = Math.round((10 * (H - 2 - dy)) / (H - 2)) // A-frame splay 10 → 0
    for (const fz of [z0, z1 - 1]) {
      store.fillBox(sx - dx - 1, gy + dy, fz, sx - dx, gy + dy, fz + 1, MAT_GALV_METAL)
      store.fillBox(sx + dx, gy + dy, fz, sx + dx + 1, gy + dy, fz + 1, MAT_GALV_METAL)
    }
  }
  store.fillBox(sx - 1, gy + H - 2, z0, sx, gy + H - 1, z1, MAT_GALV_METAL) // top bar
  for (const fz of [z0, z1 - 1]) {
    // weld the feet 2 vox into the crust
    store.fillBox(sx - 11, gy - 2, fz, sx - 10, gy - 1, fz + 1, MAT_GALV_METAL)
    store.fillBox(sx + 10, gy - 2, fz, sx + 11, gy - 1, fz + 1, MAT_GALV_METAL)
  }
  for (const cz of [sz - 4, sz + 3]) {
    store.fillBox(sx, gy + 9, cz, sx, gy + H - 3, cz, MAT_RUST) // 1×1 chain off the bar
    store.setVoxel(sx, gy + 8, cz, MAT_CHAR) // char seat ~8 above the ground
  }
}

// ---------------------------------------------------------------------------
// Salt-rimed piling stumps — 2×2 wood posts marching seaward off the E-St
// axis, heights 6 → 2, each capped 1 vox of bone-shell rime. Staggered ±5-7
// around the axis so the ramp-exit two-track threads between them.
// ---------------------------------------------------------------------------
function stampPilingRow(store: ChunkStore, g: number, a: BombayArt): void {
  const len = a.len ?? 600
  const N = Math.max(10, Math.min(14, Math.round(len / 50)))
  for (let i = 0; i < N; i++) {
    const x = a.x + Math.round((i * len) / (N - 1))
    const z = a.z + (i % 2 === 0 ? -1 : 1) * (5 + (hash3(i, 11, a.x, a.seed) % 3))
    const st = surfTop(store, g, x, z)
    const h = 6 - Math.round((4 * i) / (N - 1)) // 6 → 2 shrinking seaward
    store.fillBox(x, st - 2, z, x + 1, st + h - 1, z + 1, MAT_WOOD)
    store.fillBox(x, st + h, z, x + 1, st + h, z + 1, MAT_BONE_SHELL) // salt-rime cap
  }
}

// ---------------------------------------------------------------------------
// Derelict dock — wood post pairs + partial galv deck reaching the water off
// the piling row's shore end: full deck over the 3 shore bays, one collapsed
// plate shearing down into the playa (2-thick per step — stays welded), bare
// posts beyond (research §1.3 "derelict dock off E Street").
// ---------------------------------------------------------------------------
function stampDock(store: ChunkStore, g: number, zone: BombayZone, a: BombayArt): void {
  const len = a.len ?? 140
  const yD = zone.sea.y1 + 6 // deck clear of the scum line
  const zL = a.z - 6
  const zR = a.z + 5 // 12-vox wide frame
  const posts: number[] = []
  for (let px = 0; px + 20 <= len; px += 24) posts.push(px)
  posts.push(len - 2)
  for (const px of posts) {
    for (const pz of [zL, zR - 1]) {
      const st = surfTop(store, g, a.x + px, pz)
      store.fillBox(a.x + px, st - 2, pz, a.x + px + 1, yD - 1, pz + 1, MAT_WOOD)
    }
  }
  const FULL = 3 // intact shore bays
  for (let b = 0; b < FULL && b + 1 < posts.length; b++) {
    store.fillBox(a.x + posts[b], yD, zL, a.x + posts[b + 1] + 1, yD, zR, MAT_GALV_METAL)
  }
  if (FULL + 1 < posts.length) {
    // the collapsed bay: plate shears 1 down per 2 out until it digs in
    const x0 = a.x + posts[FULL]
    const x1 = a.x + posts[FULL + 1] + 1
    for (let x = x0; x <= x1; x++) {
      const y = yD - ((x - x0) >> 1)
      const st = surfTop(store, g, x, a.z)
      if (y - 1 <= st) {
        store.fillBox(x, Math.max(st - 1, y - 1), a.z - 6, x, y, zR, MAT_GALV_METAL)
        break // nose has dug into the playa
      }
      store.fillBox(x, y - 1, zL, x, y, zR, MAT_GALV_METAL)
    }
  }
}

// ---------------------------------------------------------------------------
// Lodestar — nose-down plane sculpture, ~13 m of rust on metal legs: tapered
// solid fuselage (nose buried ~10), swept galv wing plates, twin-fin tail up
// high, 3 leg struts, glass-flower art-pop cluster at the buried cockpit rim.
// The ONE playa piece allowed above the berm crest line (V18 horizon icon).
// Built procedurally — the Cessna grid (stampPlane) is for spawnable planes.
// ---------------------------------------------------------------------------
function stampLodestar(store: ChunkStore, g: number, a: BombayArt): void {
  const lx = a.x
  const lz = a.z
  const st = surfTop(store, g, lx, lz)
  const yNose = st - 10 // nose buried
  const FUS = 132
  // half-width: nose 1 → cabin 6 → tail 4
  const hwAt = (k: number): number =>
    k < 45 ? 1 + Math.round((5 * k) / 45) : k < 92 ? 6 : 6 - Math.round((2 * (k - 92)) / 39)
  for (let k = 0; k < FUS; k++) {
    const hw = hwAt(k)
    store.fillBox(lx - hw, yNose + k, lz - hw, lx + hw, yNose + k, lz + hw, MAT_RUST)
  }
  // swept galv wing plates (2-thick, 1-step lifts/sweeps keep them welded)
  const yW = yNose + 42
  for (let d = 1; d <= 32; d++) {
    const lift = d >> 2
    const sweep = d >> 1
    const chord = 14 - (d >> 2)
    for (const sgn of [-1, 1]) {
      const z = lz + sgn * (6 + d)
      store.fillBox(lx - 4 + sweep, yW + lift, z, lx - 4 + sweep + chord - 1, yW + 1 + lift, z, MAT_GALV_METAL)
    }
  }
  // tail: stabilizer plates + the Lodestar's twin fins, up high
  const yS = yNose + FUS - 7
  for (let d = 1; d <= 14; d++) {
    const lift = d >> 2
    for (const sgn of [-1, 1]) {
      const x = lx + sgn * (4 + d)
      store.fillBox(x, yS + lift, lz - 2, x, yS + 1 + lift, lz + 2, MAT_RUST)
    }
  }
  for (const sgn of [-1, 1]) {
    const fx = lx + sgn * 17
    store.fillBox(fx - 1, yS + 2, lz - 1, fx + 1, yS + 15, lz, MAT_RUST)
  }
  // 3 metal leg struts from the lower hull down to the crust (2×2, ≤1 vox of
  // drift per step — every step overlaps the last, welded top and bottom)
  const yL = yNose + 40
  for (const [ox, oz] of [[22, 0], [-16, 16], [-16, -16]] as const) {
    const gEnd = surfTop(store, g, lx + ox, lz + oz)
    const denom = Math.max(1, yL - gEnd)
    for (let sN = 0; sN <= denom; sN++) {
      const cx = lx + Math.round((ox * sN) / denom)
      const cz = lz + Math.round((oz * sN) / denom)
      store.fillBox(cx, yL - sN, cz, cx + 1, yL - sN, cz + 1, MAT_METAL)
    }
  }
  // glass-flower cluster at the buried cockpit rim (sanctioned art pop, V19)
  store.setVoxel(lx + 3, st + 1, lz + 3, MAT_ART_PINK)
  store.setVoxel(lx + 4, st + 1, lz + 3, MAT_ART_TEAL)
  store.setVoxel(lx + 3, st + 1, lz + 4, MAT_ART_RED)
  store.setVoxel(lx + 4, st + 1, lz + 4, MAT_GLASS)
  store.setVoxel(lx + 3, st + 2, lz + 3, MAT_GLASS)
}

// ---------------------------------------------------------------------------
// Waterline band — fish-skeleton speckle intensifying toward the water (bone
// singles + 3-vox spine runs, surface-voxel replacement only: nothing can
// float), the 1-vox salt-scum line tracing the water edge at sea level, and
// one listing beached boat hulk (research §1.4 scum foam lines, vibe #9).
// ---------------------------------------------------------------------------
function stampWaterline(store: ChunkStore, layout: Layout, zone: BombayZone, dock: BombayArt | undefined): void {
  const g = layout.groundY
  const sea = zone.sea
  const s = (layout.seed ^ 0x9a17a5) >>> 0
  const xb0 = sea.x0 - 150
  const xb1 = sea.x0 - 2
  const boneTop = (x: number, z: number): void => {
    for (let y = g + 8; y >= 2; y--) {
      const m = store.getVoxel(x, y, z)
      if (m === MAT_AIR) continue
      if (terrFam(m)) store.setVoxel(x, y, z, MAT_BONE_SHELL)
      return
    }
  }
  for (let z = zone.playa.z0; z <= zone.playa.z1; z++) {
    // salt-scum line: 1-vox bone trace on the containment rim at sea level
    const xi = sea.x0 - 1 - (hash3(z, 1, 0, s) & 1)
    if (store.getVoxel(xi, sea.y1, z) !== MAT_AIR && store.getVoxel(xi, sea.y1 + 1, z) === MAT_AIR) {
      store.setVoxel(xi, sea.y1, z, MAT_BONE_SHELL)
    }
    for (let x = xb0; x <= xb1; x++) {
      const r = h01(x, 6, z, s)
      const p = 0.02 + (0.1 * (x - xb0)) / (xb1 - xb0) // densifies toward the water
      if (r < p) {
        boneTop(x, z)
      } else if (r < p + 0.005) {
        // tiny fish spine: 3-vox run along the shore
        boneTop(x, z)
        boneTop(x, z + 1)
        boneTop(x, z + 2)
      }
    }
  }
  stampBoatHulk(store, g, zone, dock)
}

/** beached boat hulk: wood shell listing to port, sunk 2 vox, rust scabs */
function stampBoatHulk(store: ChunkStore, g: number, zone: BombayZone, dock: BombayArt | undefined): void {
  const bz = (dock ? dock.z : zone.playa.z0 + 900) + 210
  const bx = zone.sea.x0 - 58
  const yb = surfTop(store, g, bx, bz) - 2
  store.fillBox(bx - 6, yb, bz - 18, bx + 5, yb + 1, bz + 17, MAT_WOOD) // bilge slab
  store.fillBox(bx - 6, yb + 2, bz - 18, bx - 5, yb + 9, bz + 17, MAT_WOOD) // high (listing) side
  store.fillBox(bx + 4, yb + 2, bz - 18, bx + 5, yb + 5, bz + 17, MAT_WOOD) // low side
  store.fillBox(bx - 6, yb + 2, bz - 18, bx + 5, yb + 6, bz - 16, MAT_WOOD) // stern
  store.fillBox(bx - 6, yb + 2, bz + 15, bx + 5, yb + 7, bz + 17, MAT_WOOD) // bow
  for (let x = bx - 6; x <= bx + 5; x++) {
    for (let z = bz - 18; z <= bz + 17; z++) {
      for (let y = yb; y <= yb + 9; y++) {
        if (store.getVoxel(x, y, z) === MAT_WOOD && h01(x, y, z, 0xb0a7 ^ zone.sea.x0) < 0.15) {
          store.setVoxel(x, y, z, MAT_RUST)
        }
      }
    }
  }
}
