import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunks'
import { PlayerCam, TP_BOOM_LENGTH, voxelRayDistance } from '../src/render/player-cam'

// T23 — the third-person boom must never put the camera inside a wall.
// The camera is render-layer state; it reads world voxels but writes nothing (V6).

describe('third-person camera (T23, V6)', () => {
  it('voxel ray reports free distance up to the cap in open air', () => {
    const w = new ChunkStore()
    expect(voxelRayDistance(w, 50, 20, 50, 0, 0, 1, TP_BOOM_LENGTH)).toBe(TP_BOOM_LENGTH)
  })

  it('voxel ray stops short of a wall', () => {
    const w = new ChunkStore()
    // wall at z = 52m (voxel z = 520)
    w.fillBox(490, 190, 520, 510, 210, 522, 6)
    const d = voxelRayDistance(w, 50, 20, 50, 0, 0, 1, TP_BOOM_LENGTH)
    expect(d).toBeLessThan(2.0) // wall is 2m away
    expect(d).toBeGreaterThan(1.5)
  })

  it('toggle flips between fp and tp; tp boom retracts near walls', () => {
    const w = new ChunkStore()
    w.fillBox(0, 0, 0, 1023, 7, 1023, 3) // ground
    const cam = new PlayerCam(16 / 9)
    const player = {
      px: 51.2,
      py: 0.8,
      pz: 51.2,
      yaw: 0,
      pitch: 0,
    }
    // fp: camera at the eye
    cam.update(player as never, w)
    expect(cam.camera.position.z).toBeCloseTo(51.2, 5)

    cam.toggle()
    expect(cam.mode).toBe('tp')
    cam.update(player as never, w)
    // yaw 0 → boom extends +z behind the player, full length in open air (minus margin)
    expect(cam.camera.position.z).toBeGreaterThan(51.2 + 2.5)

    // wall right behind the player → boom retracts
    w.fillBox(500, 8, 522, 524, 40, 524, 6)
    cam.update(player as never, w)
    expect(cam.camera.position.z).toBeLessThan(51.2 + 1.3)

    cam.toggle()
    expect(cam.mode).toBe('fp')
  })
})
