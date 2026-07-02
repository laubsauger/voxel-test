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
    ground: '#e6e4d8',
    lot: '#dfe3d0',
    building: '#d0ccbb',
    buildingShade: '#b6b19d',
    label: 'SUBURBIA',
  },
  rowhouse: {
    ground: '#e9dfcc',
    lot: '#e3d7c0',
    building: '#d4c5a8',
    buildingShade: '#b9a988',
    label: 'ROWHOUSES',
  },
  commercial: {
    ground: '#e0e3e7',
    lot: '#d8dce1',
    building: '#c3c9d1',
    buildingShade: '#a3abb6',
    label: 'DOWNTOWN',
  },
  park: {
    ground: '#cde4c2',
    lot: '#c5dfb8',
    building: '#b2cfa2',
    buildingShade: '#93b781',
    label: 'THE PARK',
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
  default: { fill: '#ffffff', casing: '#cfccc0', casingPx: 1.5, centerLine: false },
  arterial: { fill: '#fdf6df', casing: '#c9c3ae', casingPx: 2, centerLine: true },
}

export function roadStyle(kind: string | undefined): RoadStyle {
  return (kind && ROAD_STYLES[kind]) || ROAD_STYLES.default
}

/** non-district palette entries */
export const MAP_INK = {
  sidewalk: '#eeece2',
  driveway: '#e6e3d8',
  path: '#efece0',
  parking: '#dddcd4',
  parkingStroke: '#c8c7bd',
  waterFill: '#a4cee6',
  waterStroke: '#7db3d2',
  tree: '#a9cd94',
  treeAlpha: 0.55,
  label: '#8f9382',
  centerLine: '#e5ddba',
  /** void beyond the world edge (matches HUD glass) */
  void: '#10141a',
} as const
