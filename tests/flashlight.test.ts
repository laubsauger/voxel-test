import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three/webgpu'
import { Flashlight } from '../src/render/flashlight'

// T75 — flashlight is render-only; these tests pin the TOGGLE/STATE contract
// (off by default, KeyL handler flips it, beam follows the camera with lag)
// so a refactor can't silently ship a light that boots ON or never fades out.
//
// B31 — the light is now PERMANENTLY .visible (added to the scene's light set
// once, never toggled): in WebGPU the visible-light COUNT is part of every lit
// material's pipeline key, so flicking .visible recompiled every terrain/water
// material on toggle (hard hitch). "Off" therefore means intensity 0, NOT
// visible=false — the contract these tests pin is the intensity, not .visible.

function makeCam(): PerspectiveCamera {
  const cam = new PerspectiveCamera(75, 16 / 9, 0.1, 500)
  cam.position.set(100, 8, 100)
  cam.updateMatrixWorld()
  return cam
}

describe('T75 flashlight toggle state', () => {
  it('boots OFF = zero intensity (night scenes must not glow by default)', () => {
    const fl = new Flashlight(makeCam())
    expect(fl.isOn).toBe(false)
    expect(fl.light.intensity).toBe(0) // dark via intensity, not .visible (B31)
    expect(fl.light.visible).toBe(true) // permanently counted — no recompile
  })

  it('toggle() flips state and returns the new state', () => {
    const fl = new Flashlight(makeCam())
    expect(fl.toggle()).toBe(true)
    expect(fl.isOn).toBe(true)
    expect(fl.toggle()).toBe(false)
    expect(fl.isOn).toBe(false)
  })

  it('turns on with an eased intensity ramp (visible immediately, bright soon)', () => {
    const fl = new Flashlight(makeCam())
    fl.toggle()
    fl.update(1 / 60)
    expect(fl.light.visible).toBe(true)
    expect(fl.light.intensity).toBeGreaterThan(0)
    for (let i = 0; i < 120; i++) fl.update(1 / 60) // ~2 s
    expect(fl.light.intensity).toBeGreaterThan(50) // reads as a real beam
  })

  it('fades to zero intensity after toggle off (light stays counted, B31)', () => {
    const fl = new Flashlight(makeCam())
    fl.toggle()
    for (let i = 0; i < 60; i++) fl.update(1 / 60)
    fl.toggle()
    for (let i = 0; i < 120; i++) fl.update(1 / 60)
    expect(fl.light.intensity).toBe(0) // fully dark
    expect(fl.light.visible).toBe(true) // but never removed from the light set
  })
})

describe('T75 flashlight follows the camera', () => {
  it('anchors right-and-below the camera (handheld, not a headlamp)', () => {
    const cam = makeCam()
    const fl = new Flashlight(cam)
    fl.toggle()
    fl.update(1 / 60)
    // camera looks down -z: right = +x, down = -y
    expect(fl.light.position.x).toBeGreaterThan(cam.position.x)
    expect(fl.light.position.y).toBeLessThan(cam.position.y)
    expect(fl.light.position.distanceTo(cam.position)).toBeLessThan(1)
  })

  it('beam target springs toward ahead-of-camera with lag, then converges', () => {
    const cam = makeCam()
    const fl = new Flashlight(cam)
    fl.toggle()
    for (let i = 0; i < 240; i++) fl.update(1 / 60)
    const settled = fl.light.target.position.clone()

    // snap the camera 90° right — the target must LAG (handheld sway) …
    cam.rotation.y = -Math.PI / 2
    cam.updateMatrixWorld()
    fl.update(1 / 60)
    const oneFrame = fl.light.target.position.clone()
    expect(oneFrame.distanceTo(settled)).toBeGreaterThan(0.01)

    // … and converge near the new aim point after a moment
    for (let i = 0; i < 240; i++) fl.update(1 / 60)
    const fwd = cam.getWorldDirection(settled.set(0, 0, 0))
    const aim = cam.position.clone().addScaledVector(fwd, 18)
    expect(oneFrame.distanceTo(aim)).toBeGreaterThan(fl.light.target.position.distanceTo(aim))
    expect(fl.light.target.position.distanceTo(aim)).toBeLessThan(0.5)
  })

  it('never NaNs with a zero dt', () => {
    const fl = new Flashlight(makeCam())
    fl.toggle()
    fl.update(0)
    expect(Number.isFinite(fl.light.target.position.x)).toBe(true)
    expect(Number.isFinite(fl.light.intensity)).toBe(true)
  })
})
