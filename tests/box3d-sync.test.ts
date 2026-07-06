/**
 * V15 — each dynamic Box3D body maps 1:1 to exactly one render mesh, and after a
 * physics step the render transform is a faithful copy of the body transform (no
 * drift, no shared/aliased handle). The spike's render sync loop lives in
 * main-spike (needs a WebGPU canvas), but the CONTRACT it depends on is pure
 * physics + the bridge — which is render-free and runs headless in Node. This
 * test exercises that contract: distinct handles per body, finite transforms,
 * unique ids, and copy-fidelity against a mesh proxy across steps.
 *
 * Why it matters: if two bodies ever shared an id (map collision) or a handle's
 * position()/rotation() returned stale/NaN data, the visible meshes would smear,
 * freeze, or teleport — the exact failure V15 exists to forbid.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SpikeWorld } from '../src/spike/box3d-bridge'

// mesh proxy: the minimal shape main-spike's sync writes into (position+quat)
interface MeshProxy {
  pos: { x: number; y: number; z: number }
  quat: { x: number; y: number; z: number; w: number }
}

describe('V15 — Box3D body ↔ mesh 1:1 sync', () => {
  let world: SpikeWorld

  beforeAll(async () => {
    world = await SpikeWorld.create({ continuous: true, gravity: { x: 0, y: -9.81, z: 0 } })
    // static floor so dropped bodies settle rather than fall forever
    world.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 50, y: 0.5, z: 50 })
  })

  it('one distinct handle per spawned body, unique ids', () => {
    const before = world.dynamics.length
    const a = world.spawnDynamicBox({ x: 0, y: 5, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 })
    const b = world.spawnDynamicSphere({ x: 2, y: 6, z: 0 }, 0.4)
    expect(world.dynamics.length).toBe(before + 2)
    expect(a.id).not.toBe(b.id)
    expect(a.body).not.toBe(b.body)
    // ids are unique across the whole set (map-key safety)
    const ids = new Set(world.dynamics.map((h) => h.id))
    expect(ids.size).toBe(world.dynamics.length)
  })

  it('sync copies each body transform 1:1 into its own mesh proxy, no aliasing', () => {
    // build a fresh batch and a proxy map keyed by handle id (mirrors main-spike)
    const handles = [
      world.spawnDynamicBox({ x: -1, y: 7, z: 1 }, { x: 0.4, y: 0.4, z: 0.4 }),
      world.spawnDynamicBox({ x: 1.5, y: 8, z: -1 }, { x: 0.4, y: 0.4, z: 0.4 }),
      world.spawnDynamicSphere({ x: 0, y: 9, z: 0 }, 0.3),
    ]
    const proxies = new Map<number, MeshProxy>()
    for (const h of handles)
      proxies.set(h.id, { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } })

    const sync = (): void => {
      for (const h of world.dynamics) {
        const m = proxies.get(h.id)
        if (!m) continue
        const p = h.position()
        const r = h.rotation()
        m.pos = { x: p.x, y: p.y, z: p.z }
        m.quat = { x: r.x, y: r.y, z: r.z, w: r.w }
      }
    }

    for (let i = 0; i < 60; i++) {
      world.step(1 / 60, 4)
      sync()
    }

    for (const h of handles) {
      const m = proxies.get(h.id)!
      const p = h.position()
      // proxy exactly equals the body it is bound to (faithful copy)
      expect(m.pos.x).toBe(p.x)
      expect(m.pos.y).toBe(p.y)
      expect(m.pos.z).toBe(p.z)
      // finite, and fell under gravity but did not tunnel through the floor
      expect(Number.isFinite(p.y)).toBe(true)
      expect(p.y).toBeGreaterThan(-1)
      expect(p.y).toBeLessThan(9)
    }

    // proxies did not collapse onto one shared position (no aliasing)
    const ys = handles.map((h) => proxies.get(h.id)!.pos.y)
    expect(new Set(ys.map((y) => y.toFixed(3))).size).toBeGreaterThan(1)
  })

  it('gravity sign is downward (world matches game convention)', () => {
    expect(world.world.getGravity().y).toBeLessThan(0)
  })
})
