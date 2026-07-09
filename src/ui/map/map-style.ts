/**
 * T70 — map visual language: "surveyor's plat". A calm Google-Maps-light
 * paper document; the game's safety-amber is reserved for the player layer so
 * "you" always pops against the paper.
 *
 * District styling is table-driven by kind STRING — unknown kinds (T50 may
 * add 'hood', 'beach', ...) resolve to a sane default instead of throwing.
 */

export interface DistrictStyle {
  /** ground/paper tint for the district area */
  ground: string
  /** private-lot / parcel tint (slightly greener or denser than ground) */
  lot: string
  /** building footprint fill */
  building: string
  /** soft drop shade under footprints (2.5D hint) */
  buildingShade: string
  /** small-caps map label */
  label: string
}

export const DISTRICT_STYLES: Record<string, DistrictStyle> = {
  suburban: {
    ground: '#e3e0d2',
    lot: '#dae0c8',
    building: '#bdb499',
    buildingShade: '#94896c',
    label: 'SUBURBIA',
  },
  rowhouse: {
    ground: '#e7dcc6',
    lot: '#e0d3b8',
    building: '#c2ad85',
    buildingShade: '#9c855c',
    label: 'ROWHOUSES',
  },
  commercial: {
    ground: '#dfe2e6',
    lot: '#d5dade',
    building: '#a9b2c0',
    buildingShade: '#7e8a9c',
    label: 'DOWNTOWN',
  },
  park: {
    ground: '#cbe2bf',
    lot: '#c1dcb2',
    building: '#9cbe89',
    buildingShade: '#779c62',
    label: 'THE PARK',
  },
  beach: {
    ground: '#eadcae',
    lot: '#e7d59a',
    building: '#c7a96c',
    buildingShade: '#a4854e',
    label: 'BEACH',
  },
  desert: {
    ground: '#e8d4a0',
    lot: '#e0c88c',
    building: '#c9b075',
    buildingShade: '#a68a52',
    label: 'TRAILER PARK',
  },
  airport: {
    ground: '#d8d8d2',
    lot: '#cecec8',
    building: '#b4b4ae',
    buildingShade: '#8a8a84',
    label: 'AIRFIELD',
  },
  // T107 — Bombay Beach town: sun-bleached paper, warmer + lighter than
  // suburbia (research §3 WP9: everything reads bleached-bone neutral).
  bombay: {
    ground: '#efe9d8',
    lot: '#e9e0c9',
    building: '#c6bba1',
    buildingShade: '#9f9276',
    label: 'BOMBAY BEACH',
  },
  // T107 — the shore/playa district: salt-white ground with a faint
  // grey-green water-edge tint on lots/structures (the dead-sea side).
  bombayBeach: {
    ground: '#f2efe3',
    lot: '#e8ecdf',
    building: '#c6cab9',
    buildingShade: '#9aa090',
    label: 'THE PLAYA',
  },
}

const DEFAULT_STYLE: DistrictStyle = DISTRICT_STYLES.suburban

/** unknown kind → default suburban paper + kind name as label */
export function districtStyle(kind: string): DistrictStyle {
  const s = DISTRICT_STYLES[kind]
  if (s) return s
  return { ...DEFAULT_STYLE, label: kind.toUpperCase().replace(/[-_]/g, ' ') }
}

/** road rendering per kind string ('default' when roads carry no kind) */
export interface RoadStyle {
  fill: string
  casing: string
  /** casing width, base-canvas px */
  casingPx: number
  /** dashed amber-free center line (arterials only) */
  centerLine: boolean
}

export const ROAD_STYLES: Record<string, RoadStyle> = {
  default: { fill: '#fdfcf7', casing: '#aca489', casingPx: 4, centerLine: false },
  arterial: { fill: '#fdf3d5', casing: '#a29a7e', casingPx: 4.5, centerLine: true },
  // T107 — bombay street kinds (layout BombayStreet.kind): cracked asphalt
  // reads faded grey-brown, dirt alleys read dusty tan — never clean white.
  'asphalt-cracked': { fill: '#d4ccbc', casing: '#9c917c', casingPx: 4, centerLine: false },
  dirt: { fill: '#e0d4b4', casing: '#b0a17e', casingPx: 3.5, centerLine: false },
}

export function roadStyle(kind: string | undefined): RoadStyle {
  return (kind && ROAD_STYLES[kind]) || ROAD_STYLES.default
}

/** non-district palette entries */
export const MAP_INK = {
  sidewalk: '#d9d6c4',
  driveway: '#d8d4c2',
  path: '#e9e6d6',
  parking: '#d9d8cd',
  parkingStroke: '#c2c1b4',
  waterFill: '#92c4e2',
  waterStroke: '#63a0c6',
  oceanFill: '#78b5d8',
  sandFill: '#efe0ad',
  boardwalk: '#b98b5e',
  tree: '#9cc487',
  treeAlpha: 0.55,
  label: '#7e8371',
  /** white halo behind labels (Google-style legibility over roads) */
  labelHalo: '#f2f0e6',
  centerLine: '#e3d9ac',
  /** void beyond the world edge (matches HUD glass) */
  void: '#10141a',
} as const
