/**
 * T30 — analytic sky + aerial-perspective fog (TSL, render-only V6).
 *
 * One shared parameter set drives both views of the atmosphere (sky dome and
 * surface fog): sun direction, horizon/zenith colors. The sun disc aligns
 * with the CSM DirectionalLight — WorldRenderer passes the same direction it
 * lights with. A full LUT atmosphere is overkill for a 100×100m arena; this
 * is a gradient + sun/moon analytic sky with warm horizon scatter.
 *
 * Static golden-afternoon mood by default, but sun elevation/azimuth are
 * runtime parameters (setSunDirection) so a day cycle can drive it later.
 */
import { Color, Vector3, type Scene } from 'three/webgpu'
import {
  float,
  fog,
  mix,
  positionView,
  positionWorld,
  positionWorldDirection,
  smoothstep,
  uniform,
} from 'three/tsl'

export interface Atmosphere {
  /** assign to scene.backgroundNode */
  backgroundNode: NonNullable<Scene['backgroundNode']>
  /** assign to scene.fogNode — distance+height aerial tint toward horizon */
  fogNode: NonNullable<Scene['fogNode']>
  /** update sun (and derived moon) direction — call when the light moves */
  setSunDirection: (dir: Vector3) => void
}

/** ground plane height (m) fog density falls off from — suburb sits ~3-6m */
const FOG_BASE_Y = 5
/** height falloff scale (m): fog thins with altitude */
const FOG_HEIGHT_SCALE = 22
/** distance range (m) for the aerial tint ramp */
const FOG_NEAR = 40
const FOG_FAR = 420
/** max fog blend — subtle aerial perspective, never soup */
const FOG_MAX = 0.38

export function createAtmosphere(sunDir: Vector3): Atmosphere {
  const sun = uniform(sunDir.clone().normalize())
  // moon opposite-ish: mirrored around the zenith, offset so it's not
  // exactly antipodal (which would put it below the horizon)
  const moon = uniform(computeMoonDir(sunDir))

  // palette (golden late afternoon) — linear-space colors
  const zenith = uniform(new Color(0x2c5d9e)) // deep blue overhead
  const horizon = uniform(new Color(0xb8cfe0)) // pale blue-grey at horizon
  const horizonWarm = uniform(new Color(0xffc98f)) // sun-side warmth
  const ground = uniform(new Color(0x5e6a78)) // below-horizon haze
  const sunColor = uniform(new Color(0xfff2d8))
  const moonColor = uniform(new Color(0xdfe8f5))

  const dir = positionWorldDirection.normalize()
  const y = dir.y

  // vertical gradient: fast horizon→zenith transition low in the sky
  const upness = y.max(0).pow(0.55)
  // sun-side horizon warmth: strongest looking along the sun azimuth, fades
  // with altitude; keeps the anti-sun side cool
  const toSun = dir.dot(sun)
  const warmth = toSun.mul(0.5).add(0.5).pow(2.2).mul(y.abs().oneMinus().pow(2.5))
  const horizonCol = mix(horizon, horizonWarm, warmth)
  const gradient = mix(horizonCol, zenith, upness)

  // sun disc (angular radius ~0.6°) + two-scale scatter glow (HDR: the disc
  // feeds bloom hard, the glow feeds it gently)
  const cosSun = toSun.clamp(-1, 1)
  const disc = smoothstep(0.99989, 0.99997, cosSun)
  const glowNear = cosSun.max(0).pow(600).mul(1.6)
  const glowWide = cosSun.max(0).pow(24).mul(0.22)
  const sunTerm = sunColor.mul(disc.mul(26).add(glowNear).add(glowWide))

  // moon: smaller, dimmer disc with a whisper of glow
  const cosMoon = dir.dot(moon).clamp(-1, 1)
  const moonDisc = smoothstep(0.999935, 0.999985, cosMoon)
  const moonGlow = cosMoon.max(0).pow(1400).mul(0.35)
  const moonTerm = moonColor.mul(moonDisc.mul(2.2).add(moonGlow))

  const sky = gradient.add(sunTerm).add(moonTerm)

  // below the horizon: settle into ground haze (background sphere shows a
  // few degrees below eye level from rooftops)
  const backgroundNode = mix(sky, ground, smoothstep(0.0, -0.12, y))

  // aerial perspective on geometry: distance ramp × height falloff, tinted
  // toward the (slightly warm) horizon so fog and sky meet seamlessly
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
    setSunDirection: (d: Vector3) => {
      sun.value.copy(d).normalize()
      moon.value.copy(computeMoonDir(d))
    },
  }
}

function computeMoonDir(sunDir: Vector3): Vector3 {
  const d = sunDir.clone().normalize()
  // reflect azimuth, keep a pleasant elevation; nudge sideways so the pair
  // doesn't sit on one great circle through the zenith
  const m = new Vector3(-d.x, Math.max(0.35, d.y * 0.75), -d.z)
  m.x += 0.25
  return m.normalize()
}
