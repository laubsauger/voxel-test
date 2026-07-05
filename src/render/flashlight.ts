/**
 * T75 — handheld flashlight (render-only, V6: pure light cosmetics, the sim
 * never sees it).
 *
 * One warm SpotLight (~3000 K) anchored to the camera with a slight
 * right-down offset — reads as carried in the right hand, not a headlamp.
 * The spot TARGET is a critically-lagged spring toward a point ahead of the
 * camera, so quick looks make the beam swing and settle with a handheld
 * feel while the source stays glued to the hand. castShadow OFF v1
 * (budget: zero extra shadow passes; one extra forward light when on).
 *
 * Wiring (documented, NOT applied here — see src/render/INTEGRATION-polish.md):
 *   const flashlight = new Flashlight(cam.camera); scene.add(flashlight.group)
 *   flashlight.update(dt)                                   // per render frame
 *   // main.ts keydown: if (e.code === 'KeyL') flashlight.toggle()
 */
import { Group, Object3D, SpotLight, Vector3 } from 'three/webgpu'

/** warm ~3000 K tungsten tint */
const COLOR = 0xffb46b
/** beam reach (m) */
const RANGE = 25
/** outer cone half-angle (rad ~24°) — a handheld hotspot, not a floodlight */
const ANGLE = 0.42
/** inner→outer softness (0 hard spot .. 1 all falloff) */
const PENUMBRA = 0.45
/** gentler than physical decay so the far end of the beam still reads */
const DECAY = 1.25
/** on-intensity (WebGPU physical-ish units; lamp pool runs 5.5 @ 13 m) */
const INTENSITY = 140
/** hand anchor in camera space (right, down, forward). Forward is pushed
 * past the FP viewmodel arm/tool (~0.5 m) so the near-apex falloff doesn't
 * blow the arm out in an orange hotspot (probe round 1 finding). */
const OFFSET = new Vector3(0.26, -0.34, -0.55)
/** how far ahead of the camera the beam wants to aim (m) */
const AIM_AHEAD = 18
/** target spring stiffness (1/s) — lower = lazier swing */
const AIM_LAG = 7
/** intensity ease (1/s) — soft click-on/off instead of a hard pop */
const FADE_RATE = 14

export class Flashlight {
  /** add this to the scene (holds the light + its target) */
  readonly group = new Group()
  readonly light: SpotLight
  private readonly camera: Object3D
  private on = false
  private intensity = 0
  // scratch — zero per-frame allocation
  private readonly _aim = new Vector3()
  private readonly _fwd = new Vector3()

  constructor(camera: Object3D) {
    this.camera = camera
    this.light = new SpotLight(COLOR, 0, RANGE, ANGLE, PENUMBRA, DECAY)
    this.light.castShadow = false // v1 budget: no extra shadow pass
    // B31 — NEVER toggle .visible at runtime: in WebGPU the visible-light
    // COUNT is part of every lit material's pipeline key, so flicking it forces
    // a full shader recompile (hard hitch). Stay permanently counted; the
    // toggle drives intensity to 0 instead. Same rule for muzzle + lamp lights.
    this.light.visible = true
    this.group.add(this.light)
    this.group.add(this.light.target)
    this.pose(1) // start converged on the camera, not at the origin
  }

  /** current toggle state */
  get isOn(): boolean {
    return this.on
  }

  /** flip on/off; returns the new state (main.ts 'KeyL' handler calls this) */
  toggle(): boolean {
    this.setOn(!this.on)
    return this.on
  }

  setOn(on: boolean): void {
    this.on = on
  }

  /** per render frame; dt = render delta seconds */
  update(dt: number): void {
    // intensity ease toward the toggle state (soft click). Light stays visible
    // (counted) always — see constructor; we clamp intensity to 0 when off.
    const target = this.on ? INTENSITY : 0
    this.intensity += (target - this.intensity) * Math.min(1, dt * FADE_RATE)
    if (!this.on && this.intensity < 0.5) this.intensity = 0
    this.light.intensity = this.intensity
    if (this.intensity <= 0) return // skip the per-frame pose while fully dark
    this.pose(1 - Math.exp(-AIM_LAG * dt))
  }

  /** k = target spring blend for this step (1 = snap) */
  private pose(k: number): void {
    // hand anchor rides the camera rigidly (offset rotated into world space)
    this.light.position.copy(OFFSET).applyQuaternion(this.camera.quaternion).add(this.camera.position)
    // beam target springs toward the point AIM_AHEAD along the camera forward
    this.camera.getWorldDirection(this._fwd)
    this._aim.copy(this.camera.position).addScaledVector(this._fwd, AIM_AHEAD)
    this.light.target.position.lerp(this._aim, Math.min(1, k))
  }

  dispose(): void {
    this.light.dispose()
    this.group.clear()
  }
}
