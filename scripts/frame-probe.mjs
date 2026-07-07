#!/usr/bin/env node
/**
 * T63 — CDP frame-time probe (B23: destruction stutter).
 *
 * Boots ?boot=game&seed=1337 (smoke.mjs pattern), waits for the world to
 * settle, then instruments the live page WITHOUT source changes: dynamic
 * `import()` of the same Vite module URLs the app uses returns the same
 * module instances, so we wrap prototype methods with timers and capture the
 * live Sim via PhysicsWorld.prototype.tick's `sim` argument. Digs/bombs are
 * injected through sim.queue — the exact same command path the tools use (V1).
 *
 * Phases: idle → 6 single digs (1.2 s apart) → 1 bomb (explode r=14 power=4).
 * Reports per-phase p50/p95/p99/max frame time, per-label main-thread
 * attribution, and a breakdown of the worst frames.
 *
 * Usage: node scripts/frame-probe.mjs [--headed]
 */
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.PROBE_PORT ?? 5800 + (process.pid % 500))
const HEADED = process.argv.includes('--headed')

const note = (msg) => console.log(`[probe] ${msg}`)
const die = (msg) => {
  console.error(`[probe] FATAL: ${msg}`)
  process.exit(1)
}

// -- vite dev server -----------------------------------------------------------
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const viteDead = new Promise((resolve) => vite.on('exit', resolve))
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('vite did not start in 15s')), 15000)
  vite.stdout.on('data', (d) => {
    if (String(d).includes('Local:')) {
      clearTimeout(timeout)
      resolve()
    }
  })
  vite.stderr.on('data', (d) => process.stderr.write(d))
  viteDead.then(() => reject(new Error('vite exited early')))
}).catch((e) => die(e.message))
note(`vite up on :${PORT}`)

let browser
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--use-angle=metal',
      '--no-first-run',
      '--window-size=1280,800',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => console.error(`[probe] pageerror: ${e}`))

  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  })

  await page.waitForFunction(
    () => /fps/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 30000 },
  )
  note('render loop alive')
  await page.waitForFunction(
    () => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 90000 },
  )
  note(`settled: ${await page.evaluate(() => document.getElementById('hud').textContent)}`)
  await new Promise((r) => setTimeout(r, 2000))

  // -- instrumentation (page side) --------------------------------------------
  await page.evaluate(async () => {
    const P = (window.__prof = {
      phase: 'warmup',
      frames: [],
      acc: {},
      counts: {},
      longtasks: [],
      events: [], // { t, phase, what }
      seq: 500000,
      sim: null,
      phys: null,
    })

    const wrap = (proto, name, label, hook) => {
      const orig = proto[name]
      if (typeof orig !== 'function') throw new Error(`probe: no method ${label}.${name}`)
      proto[name] = function (...args) {
        if (hook) hook(this, args)
        const t0 = performance.now()
        const r = orig.apply(this, args)
        const dt = performance.now() - t0
        P.acc[label] = (P.acc[label] || 0) + dt
        P.counts[label] = (P.counts[label] || 0) + 1
        // slow-call log: attribute long tasks to exact calls
        if (dt > 4) P.events.push({ t: t0, phase: P.phase, what: `SLOW ${label} ${dt.toFixed(1)}ms` })
        return r
      }
    }

    const loopMod = await import('/src/sim/loop.ts')
    const physMod = await import('/src/sim/physics.ts')
    const cmmMod = await import('/src/render/chunk-mesh-manager.ts')
    const schedMod = await import('/src/render/remesh-scheduler.ts')
    const wrMod = await import('/src/render/world-renderer.ts')
    const bodyMod = await import('/src/render/body-meshes.ts')
    const waterMod = await import('/src/render/water/surface.ts')
    const visMod = await import('/src/render/player-visuals.ts')
    const partMod = await import('/src/render/particles.ts')

    wrap(loopMod.FixedStepDriver.prototype, 'advance', 'driver.advance')
    wrap(wrMod.WorldRenderer.prototype, 'update', 'world.update')
    wrap(waterMod.WaterSurface.prototype, 'update', 'water.update')
    wrap(visMod.PlayerVisuals.prototype, 'update', 'visuals.update')
    wrap(partMod.DebrisParticles.prototype, 'burst', 'particles.burst')
    wrap(loopMod.Sim.prototype, 'step', 'sim.step')
    wrap(physMod.PhysicsWorld.prototype, 'tick', 'phys.tick', (self, args) => {
      P.phys = self
      P.sim = args[0]
    })
    wrap(physMod.PhysicsWorld.prototype, 'structuralPass', 'phys.structuralPass')
    wrap(physMod.PhysicsWorld.prototype, 'rebuildChunkBody', 'phys.rebuildChunkBody')
    wrap(physMod.PhysicsWorld.prototype, 'buildBoxesShape', 'phys.buildBoxesShape')
    wrap(physMod.PhysicsWorld.prototype, 'extractIsland', 'phys.extractIsland')
    wrap(cmmMod.ChunkMeshManager.prototype, 'update', 'chunks.update')
    wrap(cmmMod.ChunkMeshManager.prototype, 'buildRegion', 'chunks.buildRegion')
    wrap(cmmMod.ChunkMeshManager.prototype, 'applyResult', 'chunks.applyResult')
    wrap(schedMod.RemeshScheduler.prototype, 'take', 'sched.take')
    wrap(wrMod.WorldRenderer.prototype, 'render', 'world.render')
    wrap(bodyMod.BodyMeshes.prototype, 'update', 'bodies.update')
    // T94 — post-Box3D probe round: debris layer + debris render + LOD + water CA
    const debrisMod = await import('/src/sim/debris.ts')
    const dmMod = await import('/src/render/debris-meshes.ts')
    const lodMod = await import('/src/render/lod-manager.ts')
    const waterSimMod = await import('/src/sim/water/water-sim.ts')
    wrap(debrisMod.DebrisLayer.prototype, 'step', 'debris.step')
    wrap(dmMod.DebrisMeshes.prototype, 'update', 'debrisMeshes.update')
    wrap(lodMod.LodManager.prototype, 'update', 'lod.update')
    wrap(waterSimMod.WaterSim.prototype, 'step', 'waterSim.step')

    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          P.longtasks.push({ start: e.startTime, dur: e.duration, phase: P.phase })
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      /* longtask unsupported — frame deltas still tell the story */
    }

    // per-frame collector: game's rAF callback registered first, so by the
    // time this runs the frame's sim tick + world update already accumulated
    let prev = performance.now()
    let prevHeap = performance.memory ? performance.memory.usedJSHeapSize : 0
    const loop = (t) => {
      const d = t - prev
      prev = t
      const heap = performance.memory ? performance.memory.usedJSHeapSize : 0
      // heap DROP between frames = GC ran (MB, negative)
      const heapDelta = (heap - prevHeap) / 1048576
      prevHeap = heap
      P.frames.push({ t, d, phase: P.phase, acc: P.acc, counts: P.counts, heapDelta })
      P.acc = {}
      P.counts = {}
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  note('instrumentation installed')

  // wait until the sim instance is captured (next phys.tick)
  await page.waitForFunction(() => window.__prof.sim !== null, { timeout: 5000 })

  const setPhase = (phase) => page.evaluate((p) => void (window.__prof.phase = p), phase)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // -- phase: idle -------------------------------------------------------------
  await setPhase('idle')
  await sleep(5000)

  // -- phase: digs -------------------------------------------------------------
  await setPhase('dig')
  for (let i = 0; i < 6; i++) {
    await page.evaluate((i) => {
      const P = window.__prof
      const w = P.sim.world
      // surface dig near the suburb center, new spot each time
      const x = 500 + i * 10
      const z = 508
      let y = -1
      for (let yy = 511; yy >= 0; yy--) {
        if (w.getVoxel(x, yy, z) !== 0) {
          y = yy
          break
        }
      }
      if (y < 0) throw new Error(`probe: no surface at ${x},${z}`)
      P.events.push({ t: performance.now(), phase: P.phase, what: `dig@${x},${y},${z}` })
      P.sim.queue.push({
        tick: P.sim.tick,
        playerId: 1,
        seq: P.seq++,
        op: { kind: 'dig', x, y, z, r: 4 },
      })
    }, i)
    await sleep(1200)
  }

  // -- phase: bomb -------------------------------------------------------------
  await setPhase('bomb')
  await page.evaluate(() => {
    const P = window.__prof
    const w = P.sim.world
    const x = 540
    const z = 540
    let y = -1
    for (let yy = 511; yy >= 0; yy--) {
      if (w.getVoxel(x, yy, z) !== 0) {
        y = yy
        break
      }
    }
    if (y < 0) throw new Error('probe: no surface for bomb')
    P.events.push({ t: performance.now(), phase: P.phase, what: `explode@${x},${y},${z}` })
    P.sim.queue.push({
      tick: P.sim.tick,
      playerId: 1,
      seq: P.seq++,
      op: { kind: 'explode', x, y, z, r: 14, power: 4 },
    })
  })
  await sleep(6000)

  // -- collect -----------------------------------------------------------------
  const data = await page.evaluate(() => ({
    frames: window.__prof.frames,
    longtasks: window.__prof.longtasks,
    events: window.__prof.events,
    bodies: window.__prof.phys ? window.__prof.phys.bodies.size : -1,
  }))

  // -- report ------------------------------------------------------------------
  const pct = (arr, p) => {
    if (arr.length === 0) return NaN
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  }
  const fmt = (v) => (Number.isNaN(v) ? '—' : v.toFixed(2))

  console.log(`\n=== frame-time by phase (ms) — bodies at end: ${data.bodies} ===`)
  console.log('phase | frames | p50 | p95 | p99 | max')
  for (const phase of ['idle', 'dig', 'bomb']) {
    const ds = data.frames.filter((f) => f.phase === phase).map((f) => f.d)
    console.log(
      `${phase} | ${ds.length} | ${fmt(pct(ds, 50))} | ${fmt(pct(ds, 95))} | ${fmt(pct(ds, 99))} | ${fmt(Math.max(...ds))}`,
    )
  }

  console.log('\n=== attribution: total instrumented ms per phase (count) ===')
  for (const phase of ['idle', 'dig', 'bomb']) {
    const frames = data.frames.filter((f) => f.phase === phase)
    const total = {}
    const counts = {}
    for (const f of frames) {
      for (const [k, v] of Object.entries(f.acc)) total[k] = (total[k] || 0) + v
      for (const [k, v] of Object.entries(f.counts)) counts[k] = (counts[k] || 0) + v
    }
    console.log(`--- ${phase} ---`)
    for (const [k, v] of Object.entries(total).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v.toFixed(2)} ms (${counts[k]} calls)`)
    }
  }

  console.log('\n=== worst frames per phase (top 4, with breakdown) ===')
  for (const phase of ['idle', 'dig', 'bomb']) {
    const frames = data.frames
      .filter((f) => f.phase === phase)
      .sort((a, b) => b.d - a.d)
      .slice(0, 4)
    console.log(`--- ${phase} ---`)
    for (const f of frames) {
      const parts = Object.entries(f.acc)
        .sort((a, b) => b[1] - a[1])
        .filter(([, v]) => v > 0.05)
        .map(([k, v]) => `${k}=${v.toFixed(2)}${f.counts[k] > 1 ? `×${f.counts[k]}` : ''}`)
        .join(' ')
      console.log(`  ${f.d.toFixed(2)} ms @${f.t.toFixed(0)} heapΔ=${f.heapDelta.toFixed(1)}MB | ${parts}`)
    }
  }

  if (data.longtasks.length) {
    console.log('\n=== long tasks (>50ms) ===')
    for (const lt of data.longtasks) {
      console.log(`  ${lt.phase}: ${lt.dur.toFixed(0)} ms @${lt.start.toFixed(0)}`)
    }
  } else {
    console.log('\n(no >50ms long tasks recorded)')
  }
  console.log('\n=== events ===')
  for (const e of data.events) console.log(`  ${e.phase} @${e.t.toFixed(0)}: ${e.what}`)
} catch (e) {
  die(`harness error: ${e.stack ?? e.message}`)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
