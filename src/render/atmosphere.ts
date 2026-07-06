/**
 * T30/T58 — analytic sky + aerial-perspective fog + day/night cycle (TSL,
 * render-only V6).
 *
 * One shared parameter set drives both views of the atmosphere (sky dome and
 * surface fog) AND the scene lights: sun/moon direction, palette colors,
 * exposure. WorldRenderer computes a CycleState once per frame from the sim
 * tick (render READS tick, never writes — V6) and applies it to the sky
 * uniforms, the CSM light, the hemisphere light and the cloud tint, so sky,
 * fog and lighting can never disagree about where the sun is (atmosphere
 * skill contract: one sun direction, one palette).
 *
 * Time model (T58): time-of-day derives purely from sim.tick — deterministic
 * and multiplayer-synced for free. Default cycle = 20 min real time per 24 h
 * day, starting at 15:00 (the golden afternoon the smoke gate expects; the
 * 15:00 sun direction matches the old static (85,62,38) light within a few
 * degrees). A fixed-time override + cycle length are exposed as plain fields
 * for dev settings.
 *
 * Sky features: vertical gradient with sun-side warmth (boosted through the
 * dawn/dusk bands), HDR sun disc + two-scale glow (wide glow swells near the
 * horizon), moon disc that brightens at night, and a cheap procedural star
 * field (hashed cells on the view direction, subtle twinkle) that fades in
 * with nightfall.
 */
import { Color, Vector3, type Scene } from 'three/webgpu'
import {
  float,
  fog,
  hash,
  mix,
  positionView,
  positionWorld,
  positionWorldDirection,
  smoothstep,
  step,
  time,
  uniform,
  vec3,
} from 'three/tsl'

// ---------------------------------------------------------------------------
// T58 day cycle — time + celestial orbit + palette (pure math, CPU-side)
// ---------------------------------------------------------------------------

/** sim tick rate (Hz) — FixedStepDriver steps the sim at 60 Hz (V2) */
const TICK_HZ = 60
/** orbit tilt from the zenith axis: noon elevation = 90° − tilt */
const SUN_TILT = (32 * Math.PI) / 180
/** moon: near-antipodal, phase-shifted so the pair never overlaps exactly */
const MOON_TILT = (24 * Math.PI) / 180
const MOON_PHASE = Math.PI + 0.35

export class DayCycle {
  /** real seconds per full 24 h day (default 20 min) */
  cycleLengthSec = 1200
  /** time of day at tick 0, hours (default 15:00 — golden afternoon) */
  timeOfDayOffsetHours = 15
  /** T65 settings: freeze the clock at a fixed hour (null = tick-driven) */
  overrideHours: number | null = null
  /** T65 settings: cycle speed multiplier (1 = cycleLengthSec per day) */
  speedMultiplier = 1

  /** time of day (hours 0..24) for a sim tick — deterministic (V2 via tick) */
  hoursAt(tick: number): number {
    const h =
      this.overrideHours ??
      this.timeOfDayOffsetHours +
        (tick / TICK_HZ) * (24 / this.cycleLengthSec) * this.speedMultiplier
    return ((h % 24) + 24) % 24
  }

  /**
   * T65 — change the cycle speed live WITHOUT jumping the clock: hoursAt is a
   * pure function of tick (deterministic), so a raw multiplier write would
   * teleport the time; this rebases the offset so hoursAt(atTick) is
   * continuous across the change. (WorldRenderer.setCycleSpeed passes the
   * current tick for you.)
   */
  setSpeed(multiplier: number, atTick: number): void {
    if (this.overrideHours === null) {
      const now = this.hoursAt(atTick)
      this.speedMultiplier = multiplier
      const drift = (atTick / TICK_HZ) * (24 / this.cycleLengthSec) * multiplier
      this.timeOfDayOffsetHours = (((now - drift) % 24) + 24) % 24
    } else {
      this.speedMultiplier = multiplier
    }
  }
}

/** everything the renderer needs for one frame of the cycle */
export interface CycleState {
  hours: number
  sunDir: Vector3
  moonDir: Vector3
  /** 0..1 weights of the palette bands */
  dayF: number
  duskF: number
  nightF: number
  /** the one shadow-casting DirectionalLight (sun by day, moon by night) */
  lightDir: Vector3
  lightColor: Color
  lightIntensity: number
  moonIsLight: boolean
  hemiSky: Color
  hemiGround: Color
  hemiIntensity: number
  /** renderer.toneMappingExposure — mild lift so night reads, never black */
  exposure: number
  /** 0 day → 1 night: how "on" the street lamps are (B25: OFF in daylight) */
  lampFactor: number
  /** multiplier on emissive materials (lamp 13) — 0 by day, ~3.2 at night */
  lampBoost: number
  cloudLit: Color
  cloudShade: Color
  // sky palette
  zenith: Color
  horizon: Color
  horizonWarm: Color
  ground: Color
  sunColor: Color
  /** sun disc/glow visibility + wide-glow swell near the horizon */
  sunVis: number
  glowWide: number
  /** moon disc + glow strength (brightens at night) */
  moonDisc: number
  moonGlow: number
  starVis: number
}

export function createCycleState(): CycleState {
  return {
    hours: 0,
    sunDir: new Vector3(0, 1, 0),
    moonDir: new Vector3(0, -1, 0),
    dayF: 1,
    duskF: 0,
    nightF: 0,
    lightDir: new Vector3(0, 1, 0),
    lightColor: new Color(),
    lightIntensity: 0,
    moonIsLight: false,
    hemiSky: new Color(),
    hemiGround: new Color(),
    hemiIntensity: 0,
    exposure: 1,
    lampFactor: 0,
    lampBoost: 0,
    cloudLit: new Color(),
    cloudShade: new Color(),
    zenith: new Color(),
    horizon: new Color(),
    horizonWarm: new Color(),
    ground: new Color(),
    sunColor: new Color(),
    sunVis: 1,
    glowWide: 0.22,
    moonDisc: 2.2,
    moonGlow: 0.35,
    starVis: 0,
  }
}

/** palette anchors, blended sequentially night → dusk → golden → day */
const PAL = {
  night: {
    zenith: 0x040816,
    horizon: 0x0e1728,
    horizonWarm: 0x1b2742,
    ground: 0x04060a,
    sun: 0x223052,
    hemiSky: 0x1c2a4a,
    hemiGround: 0x11141c,
    cloudLit: 0x46536e,
    cloudShade: 0x141a28,
  },
  dusk: {
    zenith: 0x142352,
    horizon: 0x6e4a58,
    horizonWarm: 0xff6a35,
    ground: 0x2a2731,
    sun: 0xff7d3d,
    hemiSky: 0x51557e,
    hemiGround: 0x3d3230,
    cloudLit: 0xe8967a,
    cloudShade: 0x4b4258,
  },
  golden: {
    zenith: 0x28558f,
    horizon: 0xd9bda0,
    horizonWarm: 0xffb066,
    ground: 0x4e5361,
    sun: 0xffd9a0,
    hemiSky: 0x93a9cf,
    hemiGround: 0x8a755a,
    cloudLit: 0xfff0dc,
    cloudShade: 0xc0aab0,
  },
  day: {
    zenith: 0x2c5d9e,
    horizon: 0xb8cfe0,
    horizonWarm: 0xffc98f,
    ground: 0x5e6a78,
    sun: 0xfff2d8,
    hemiSky: 0xa9c6ea,
    hemiGround: 0x8f7d62,
    cloudLit: 0xffffff,
    cloudShade: 0xc4d2e4,
  },
} as const

const _pa = new Color()
const _pb = new Color()

function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** tilted-circle orbit: hour angle around the tilt axis, noon = highest */
function orbitDir(hours: number, tilt: number, phase: number, out: Vector3): Vector3 {
  const a = ((hours - 12) / 24) * Math.PI * 2 + phase
  return out.set(Math.sin(a), Math.cos(a) * Math.cos(tilt), Math.cos(a) * Math.sin(tilt))
}

/**
 * Full cycle state for a time of day. Pure + deterministic (same hours ⇒
 * same state); writes into `out` (no per-frame allocations).
 */
export function computeCycleState(hours: number, out: CycleState): CycleState {
  out.hours = hours
  orbitDir(hours, SUN_TILT, 0, out.sunDir)
  orbitDir(hours, MOON_TILT, MOON_PHASE, out.moonDir)
  const s = out.sunDir.y // sin of sun elevation

  // sequential palette blend weights (each step refines the previous)
  const toDusk = smooth01(-0.22, -0.06, s) // night → dusk
  const toGolden = smooth01(-0.04, 0.12, s) // dusk → golden
  const toDay = smooth01(0.16, 0.42, s) // golden → day
  out.nightF = 1 - toDusk
  out.dayF = toDay
  // dawn/dusk band: peaks while the sun crosses the horizon
  out.duskF = toDusk * (1 - toGolden)

  const lerpPal = (key: keyof (typeof PAL)['day'], into: Color): Color => {
    into.setHex(PAL.night[key])
    into.lerp(_pa.setHex(PAL.dusk[key]), toDusk)
    into.lerp(_pa.setHex(PAL.golden[key]), toGolden)
    into.lerp(_pa.setHex(PAL.day[key]), toDay)
    return into
  }
  lerpPal('zenith', out.zenith)
  lerpPal('horizon', out.horizon)
  lerpPal('horizonWarm', out.horizonWarm)
  lerpPal('ground', out.ground)
  lerpPal('sun', out.sunColor)
  lerpPal('hemiSky', out.hemiSky)
  lerpPal('hemiGround', out.hemiGround)
  lerpPal('cloudLit', out.cloudLit)
  lerpPal('cloudShade', out.cloudShade)

  // --- the one shadow light: sun by day, moon by night (T58 choice: reusing
  // the same DirectionalLight + CSM keeps shadow-pass cost identical to the
  // static build; the direction swap happens while intensity ≈ 0, so it is
  // invisible — no second CSM, no shadow fade-out) ---------------------------
  const sunI = 3.1 * smooth01(-0.03, 0.32, s)
  const moonI = 0.5 * smooth01(0.02, 0.25, out.moonDir.y) * smooth01(-0.02, -0.14, s)
  out.moonIsLight = moonI > sunI
  if (out.moonIsLight) {
    out.lightDir.copy(out.moonDir)
    out.lightColor.setHex(0x93aade)
    out.lightIntensity = moonI
  } else {
    out.lightDir.copy(out.sunDir)
    // sun light color: near-white high, deep warm near the horizon
    out.lightColor.setHex(0xffe2ba).lerp(_pb.setHex(0xff8a45), 1 - toDay)
    out.lightIntensity = sunI
  }

  // hemisphere/ambient: dims way down at night — lamps must carry the streets
  out.hemiIntensity = 0.12 + 0.83 * smooth01(-0.1, 0.3, s)

  // mild exposure lift so night is readable-dark, not black
  out.exposure = 1 + 0.32 * out.nightF
  // lamp on-ness (B25): emissive OFF in daylight, smooth ramp through dusk,
  // full after dark — drives the material boost AND the point-light pool
  out.lampFactor = 1 - smooth01(-0.1, 0.06, s)
  out.lampBoost = 3.2 * out.lampFactor

  // sky extras
  out.sunVis = smooth01(-0.09, 0.0, s)
  out.glowWide = 0.22 + 0.5 * out.duskF + 0.25 * (1 - toDay) * toDusk
  out.moonDisc = 2.2 + 3.2 * out.nightF
  out.moonGlow = 0.35 + 0.6 * out.nightF
  out.starVis = smooth01(-0.06, -0.18, s)

  return out
}

// ---------------------------------------------------------------------------
// sky + fog nodes
// ---------------------------------------------------------------------------

export interface Atmosphere {
  /** assign to scene.backgroundNode */
  backgroundNode: NonNullable<Scene['backgroundNode']>
  /** assign to scene.fogNode — distance+height aerial tint toward horizon */
  fogNode: NonNullable<Scene['fogNode']>
  /** per-frame: sync all sky/fog uniforms to the cycle state */
  apply: (state: CycleState) => void
}

/** ground plane height (m) fog density falls off from — suburb sits ~3-6m */
const FOG_BASE_Y = 5
/** height falloff scale (m): fog thins with altitude */
const FOG_HEIGHT_SCALE = 22
/** distance range (m) for the aerial tint ramp */
const FOG_NEAR = 55
// B37 — pulled WAY in (was 720). The finite curated world ends ~256 m from
// centre and geometry only streams to ~340 m (LOD), so with far fog the hard
// world EDGE was plainly visible, especially flying up. Now aerial haze ramps to
// (near) full by the LOD horizon, dissolving the boundary into the sky.
const FOG_FAR = 330
/** max fog blend at the far edge — high so the world boundary reads as horizon
 *  haze, not a wall; the near→far smoothstep keeps the foreground crisp */
const FOG_MAX = 0.92

/** star field cell grid (cells across the unit sphere) */
const STAR_GRID = 44

export function createAtmosphere(initial: CycleState): Atmosphere {
  const sun = uniform(initial.sunDir.clone())
  const moon = uniform(initial.moonDir.clone())

  // palette uniforms — CPU-lerped per frame from the cycle keyframes
  const zenith = uniform(initial.zenith.clone())
  const horizon = uniform(initial.horizon.clone())
  const horizonWarm = uniform(initial.horizonWarm.clone())
  const ground = uniform(initial.ground.clone())
  const sunColor = uniform(initial.sunColor.clone())
  const moonColor = uniform(new Color(0xdfe8f5))
  const sunVis = uniform(initial.sunVis)
  const glowWideStrength = uniform(initial.glowWide)
  const moonDiscStrength = uniform(initial.moonDisc)
  const moonGlowStrength = uniform(initial.moonGlow)
  const warmthBoost = uniform(1)
  const starVis = uniform(initial.starVis)

  const dir = positionWorldDirection.normalize()
  const y = dir.y

  // vertical gradient: fast horizon→zenith transition low in the sky
  const upness = y.max(0).pow(0.55)
  // sun-side horizon warmth: strongest looking along the sun azimuth, fades
  // with altitude; keeps the anti-sun side cool. warmthBoost widens the band
  // through dawn/dusk (T58 sky interest).
  const toSun = dir.dot(sun)
  const warmth = toSun
    .mul(0.5)
    .add(0.5)
    .pow(2.2)
    .mul(y.abs().oneMinus().pow(2.5))
    .mul(warmthBoost)
    .clamp(0, 1)
  const horizonCol = mix(horizon, horizonWarm, warmth)
  const gradient = mix(horizonCol, zenith, upness)

  // sun disc (angular radius ~0.6°) + two-scale scatter glow (HDR: the disc
  // feeds bloom hard, the glow feeds it gently). sunVis fades the whole term
  // out as the sun sinks; the wide glow swells near the horizon (sunset blaze).
  const cosSun = toSun.clamp(-1, 1)
  const disc = smoothstep(0.99989, 0.99997, cosSun)
  const glowNear = cosSun.max(0).pow(600).mul(1.6)
  const glowWide = cosSun.max(0).pow(24).mul(glowWideStrength)
  const sunTerm = sunColor.mul(disc.mul(26).add(glowNear).add(glowWide)).mul(sunVis)

  // moon: smaller disc, dim by day, bright silver at night
  const cosMoon = dir.dot(moon).clamp(-1, 1)
  const moonDisc = smoothstep(0.999935, 0.999985, cosMoon)
  const moonGlow = cosMoon.max(0).pow(1400).mul(moonGlowStrength)
  const moonTerm = moonColor.mul(moonDisc.mul(moonDiscStrength).add(moonGlow))

  // procedural star field (T58): hash the view direction into cells; a few
  // percent of cells hold one star, offset within its cell so the grid never
  // reads. Subtle twinkle via the render clock (visual-only, V6-safe). Fades
  // in with nightfall, out toward the horizon haze.
  const sp = dir.mul(STAR_GRID)
  const cell = sp.floor()
  const h1 = hash(cell.dot(vec3(127.1, 311.7, 74.7)))
  const h2 = hash(cell.dot(vec3(269.5, 183.3, 246.1)))
  const h3 = hash(cell.dot(vec3(113.5, 271.9, 124.6)))
  const local = sp.fract().sub(vec3(h2.mul(0.6).add(0.2), h3.mul(0.6).add(0.2), 0.5))
  const starCore = smoothstep(0.16, 0.02, local.length())
  const starLum = step(0.94, h1).mul(h1.sub(0.94).div(0.06)) // ~6% of cells lit, varied brightness
  const twinkle = time.mul(h2.mul(3).add(1.5)).add(h3.mul(40)).sin().mul(0.3).add(0.7)
  const starTerm = vec3(0.9, 0.95, 1.1).mul(
    starCore.mul(starLum).mul(twinkle).mul(starVis).mul(smoothstep(0.02, 0.22, y)).mul(1.4),
  )

  const sky = gradient.add(sunTerm).add(moonTerm).add(starTerm)

  // below the horizon: settle into ground haze (background sphere shows a
  // few degrees below eye level from rooftops)
  const backgroundNode = mix(sky, ground, smoothstep(0.0, -0.12, y))

  // aerial perspective on geometry: distance ramp × height falloff, tinted
  // toward the (slightly warm) horizon so fog and sky meet seamlessly —
  // the fog reuses the SAME palette uniforms, so it tracks the cycle for free
  const dist = positionView.z.negate()
  const distFactor = smoothstep(float(FOG_NEAR), float(FOG_FAR), dist)
  const heightFactor = positionWorld.y
    .sub(FOG_BASE_Y)
    .max(0)
    .div(FOG_HEIGHT_SCALE)
    .negate()
    .exp()
  // constant gentle warmth in the haze tint keeps fog and sun-side sky close
  const fogColor = mix(horizon, horizonWarm, float(0.18))
  const fogNode = fog(fogColor, distFactor.mul(heightFactor).mul(FOG_MAX))

  return {
    backgroundNode,
    fogNode,
    apply: (state: CycleState) => {
      sun.value.copy(state.sunDir)
      moon.value.copy(state.moonDir)
      zenith.value.copy(state.zenith)
      horizon.value.copy(state.horizon)
      horizonWarm.value.copy(state.horizonWarm)
      ground.value.copy(state.ground)
      sunColor.value.copy(state.sunColor)
      sunVis.value = state.sunVis
      glowWideStrength.value = state.glowWide
      moonDiscStrength.value = state.moonDisc
      moonGlowStrength.value = state.moonGlow
      warmthBoost.value = 1 + 1.6 * state.duskF
      starVis.value = state.starVis
    },
  }
}
