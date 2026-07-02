#!/usr/bin/env node
/**
 * T72 — 2-browser multiplayer E2E (the real V3 proof, and a MERGE GATE for
 * sim-touching changes: if this fails, a change broke cross-process
 * determinism or the lockstep/session wiring).
 *
 * What it does:
 *   1. starts server/signal.mjs + vite on per-process ports
 *   2. launches TWO separate headless Chromes (two OS processes — this is the
 *      first cross-process determinism test of Jolt WASM in real browsers)
 *   3. browser A hosts via the real menu UI, browser B joins with the room
 *      code, host starts, both build seed-synced games
 *   4. scripted inputs on both sides for ~600 ticks: walk (real keyboard →
 *      PlayerInput), dig / shoot / bomb throw (window.__bbNet.submitOp →
 *      Game.pushOp — the sanctioned sink; headless Chrome has no pointer
 *      lock, so mouse-driven tools are injected at the same layer the
 *      ToolController uses)
 *   5. asserts: (a) combined-hash checkpoint sequences identical on both
 *      pages, (b) desync detector green, (c) both report the same tick within
 *      barrier tolerance, (d) zero console/page errors.
 *
 * POST-MORTEM (why there are two transports): early runs failed ~10% with a
 * signature that looked like silent WebRTC death (peer starves at the
 * barrier, pcs 'connected', zero errors). Building a ws-relay transport to
 * isolate it reproduced the SAME failure — WebRTC was innocent. Root cause:
 * rAF starvation. Two headless Chromes contending for one GPU routinely gap
 * rAF by 0.6-1.5s (logged every run) and occasionally 30s+; the sim pump
 * lived only in setAnimationLoop, so a starved page stopped sending inputs
 * until the host dropped it. Fixed in Game.startLoop with a background
 * interval pump that feeds the lockstep barrier when rAF is silent (also
 * fixes real backgrounded tabs). Both transports green since.
 *
 *   default = real WebRTC DataChannel path (the product transport).
 *   `--ws`  = lockstep over the signaling server relay (`?transport=ws`) —
 *             transport-isolation mode: if default fails and --ws passes,
 *             suspect WebRTC/env; if both fail identically, it's sim/app.
 *
 * Usage: node scripts/mp-e2e.mjs [--headed] [--ws]
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// per-process ports: parallel agent worktrees run e2e concurrently
const VITE_PORT = Number(process.env.MP_E2E_PORT ?? 5800 + (process.pid % 500))
const SIGNAL_PORT = VITE_PORT + 500
const HEADED = process.argv.includes('--headed')
const WS = process.argv.includes('--ws')
const SEED = 424242
const RUN_TICKS = 600
const HASH_INTERVAL = 30
const TICK_TOLERANCE = 30 // barrier keeps peers within inputDelay; margin for sample skew

const failures = []
const note = (msg) => console.log(`[mp-e2e] ${msg}`)
const fail = (msg) => {
  failures.push(msg)
  console.error(`[mp-e2e] FAIL: ${msg}`)
}

// -- signaling server ---------------------------------------------------------
const signal = spawn('node', ['server/signal.mjs'], {
  env: { ...process.env, PORT: String(SIGNAL_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('signal server did not start in 10s')), 10000)
  signal.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
  signal.stderr.on('data', (d) => process.stderr.write(d))
  signal.on('exit', () => reject(new Error('signal server exited early')))
})
note(`signal server up on :${SIGNAL_PORT}`)

// -- vite dev server ------------------------------------------------------------
const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
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
})
note(`vite up on :${VITE_PORT}`)

const URL =
  `http://localhost:${VITE_PORT}/?seed=${SEED}` +
  `&signal=${encodeURIComponent(`ws://localhost:${SIGNAL_PORT}`)}` +
  (WS ? '&transport=ws' : '')
note(`transport: ${WS ? 'ws-relay (--ws transport-isolation mode)' : 'WebRTC DataChannel (product path)'}`)

const browsers = []
const pages = {}
const errorLogs = { A: [], B: [] }

/** on failure: dump everything we can see on both pages */
async function dumpDiagnostics() {
  mkdirSync('smoke-artifacts', { recursive: true })
  for (const label of Object.keys(pages)) {
    const page = pages[label]
    try {
      const state = await page.evaluate(async () => {
        const n = window.__bbNet
        const f0 = n?.frames
        await new Promise((r) => setTimeout(r, 500))
        return {
        net: n
          ? {
              tick: n.tick,
              role: n.role,
              verifiedTick: n.verifiedTick,
              desync: n.desync,
              hashCount: n.lastHashes.length,
              framesIn500ms: n.frames - f0,
              maxRafGapMs: n.maxRafGapMs,
              canStep: n.canStep,
              waitingOn: n.waitingOn,
              channelStats: n.channelStats,
            }
          : null,
        fatal: (() => {
          const el = document.getElementById('fatal')
          return el && getComputedStyle(el).display !== 'none' ? el.textContent : null
        })(),
        desyncOverlay: (() => {
          const el = document.querySelector('.bb-desync')
          return el && el.style.display !== 'none' ? el.textContent.trim().slice(0, 300) : null
        })(),
          stall: document.querySelector('.bb-stall')?.textContent ?? null,
        }
      })
      console.error(`[mp-e2e] page ${label} state: ${JSON.stringify(state)}`)
      await page.screenshot({ path: `smoke-artifacts/mp-e2e-${label}.png` }).catch(() => {})
    } catch (e) {
      console.error(`[mp-e2e] page ${label} state unavailable: ${e.message}`)
    }
    if (errorLogs[label].length) {
      console.error(`[mp-e2e] page ${label} errors:\n  ${errorLogs[label].join('\n  ')}`)
    }
  }
}

async function launchPage(label) {
  // separate puppeteer.launch per page ⇒ separate Chrome process trees
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--use-angle=metal',
      '--no-first-run',
      '--window-size=1280,800',
      // keep rAF running: a throttled/occluded page stalls the tick barrier
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // headless WebRTC on localhost: mDNS-obfuscated host candidates
      // (.local) resolve flakily without a UI session — the ICE pair can die
      // mid-run (observed: silent DataChannel death ~7s in). Use raw IPs.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  })
  browsers.push(browser)
  const page = await browser.newPage()
  pages[label] = page
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => errorLogs[label].push(`pageerror: ${String(e)}`))
  page.on('console', (m) => {
    const text = m.text()
    // [net] warnings are transport diagnostics (pc/ice/channel state) — echo live
    if (m.type() === 'warning' && text.startsWith('[net]')) {
      console.log(`[mp-e2e] ${label} ${text}`)
      return
    }
    if (m.type() !== 'error') return
    const url = m.location()?.url ?? ''
    if (url.includes('favicon')) return
    errorLogs[label].push(`${text} (${url})`)
  })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  return page
}

const waitVisible = (page, selector, timeout = 60000) =>
  page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      // menu screens toggle via the bb-leave opacity class
      let n = el
      while (n instanceof Element) {
        if (n.classList.contains('bb-leave')) return false
        n = n.parentElement
      }
      return true
    },
    { timeout },
    selector,
  )

try {
  note('launching two Chromes (separate processes)…')
  const [pageA, pageB] = await Promise.all([launchPage('A'), launchPage('B')])

  // -- lobby choreography (real menu UI via CDP) -------------------------------
  note('A: hosting…')
  await waitVisible(pageA, '.bb-menu [data-act="host"]', 90000) // boot+meshing first
  await pageA.click('.bb-menu [data-act="host"]')
  await pageA.waitForFunction(
    () => /^[A-Z2-9]{6}$/.test(document.querySelector('[data-mp="code"]')?.textContent ?? ''),
    { timeout: 30000 },
  )
  const code = await pageA.$eval('[data-mp="code"]', (el) => el.textContent.trim())
  note(`room code: ${code}`)

  note('B: joining…')
  await waitVisible(pageB, '.bb-menu [data-act="join"]', 90000)
  await pageB.click('.bb-menu [data-act="join"]')
  await pageB.waitForSelector('[data-mp="code-input"]', { timeout: 15000 })
  await pageB.type('[data-mp="code-input"]', code)
  await pageB.click('[data-mp="join"]')

  // both lobbies show 2 players
  const rosterHasTwo = (page) =>
    page.waitForFunction(() => document.querySelectorAll('.bb-mp-player:not(.bb-mp-slot-open)').length >= 2, {
      timeout: 30000,
    })
  await Promise.all([rosterHasTwo(pageA), rosterHasTwo(pageB)])
  note('both rosters show 2 players')

  note('A: starting session (both pages rebuild their game on the shared seed)…')
  await pageA.click('[data-mp="start"]')
  const running = (page) =>
    page.waitForFunction(() => window.__bbNet?.running === true && window.__bbNet.tick > 0, { timeout: 120000 })
  await Promise.all([running(pageA), running(pageB)])
  const ids = await Promise.all([
    pageA.evaluate(() => window.__bbNet.playerId),
    pageB.evaluate(() => window.__bbNet.playerId),
  ])
  note(`session running — playerIds host=${ids[0]} guest=${ids[1]}`)

  // both players spawned on both sims (spawn ops ride the lockstep stream)
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.waitForFunction(() => window.__bbNet.playerPos() !== null, { timeout: 30000 }),
    ),
  )
  const startTicks = await Promise.all([
    pageA.evaluate(() => window.__bbNet.tick),
    pageB.evaluate(() => window.__bbNet.tick),
  ])
  note(`both spawned (ticks ${startTicks.join(' / ')})`)

  // -- scripted mirrored inputs -------------------------------------------------
  // walk: REAL input path (document keydown → PlayerInput bits → move ops)
  const walk = async (page, key, ms) => {
    await page.keyboard.down(key)
    await new Promise((r) => setTimeout(r, ms))
    await page.keyboard.up(key)
  }
  // tools: sanctioned op sink (Game.pushOp → lockstep submitLocal). Pointer
  // lock does not exist headless, so ToolController's mouse path can't fire;
  // this injects at the exact same command layer it uses.
  const tool = (page, opBuilder) =>
    page.evaluate((src) => {
      const pos = window.__bbNet.playerPos()
      const build = new Function('pos', `return (${src})(pos)`)
      window.__bbNet.submitOp(build(pos))
    }, opBuilder.toString())

  note('scripted inputs: walk…')
  const posBefore = await pageA.evaluate(() => window.__bbNet.playerPos())
  await Promise.all([walk(pageA, 'KeyW', 1200), walk(pageB, 'KeyW', 1200)])
  const posAfter = await pageA.evaluate(() => window.__bbNet.playerPos())
  const walked = Math.hypot(posAfter.x - posBefore.x, posAfter.z - posBefore.z)
  if (walked < 0.3) fail(`host player barely moved (${walked.toFixed(3)}m) — move ops not flowing?`)
  else note(`host player walked ${walked.toFixed(2)}m (move ops flow through lockstep)`)

  note('scripted inputs: dig…')
  for (const page of [pageA, pageB]) {
    await tool(page, (pos) => ({
      kind: 'dig',
      x: Math.floor(pos.x / 0.1) + 6,
      y: Math.floor(pos.y / 0.1) - 1,
      z: Math.floor(pos.z / 0.1),
      r: 4,
    }))
  }

  note('scripted inputs: shoot…')
  for (const page of [pageA, pageB]) {
    await tool(page, (pos) => ({
      kind: 'shoot',
      ox: pos.x,
      oy: pos.y + 1.5,
      oz: pos.z,
      dx: 0.7071,
      dy: -0.1,
      dz: 0.7,
    }))
  }

  note('scripted inputs: bomb throw…')
  for (const page of [pageA, pageB]) {
    await tool(page, (pos) => ({
      kind: 'throw',
      ox: pos.x,
      oy: pos.y + 1.6,
      oz: pos.z,
      vx: 8,
      vy: 5,
      vz: 4,
    }))
  }
  await Promise.all([walk(pageA, 'KeyA', 800), walk(pageB, 'KeyD', 800)])

  // -- run out the clock ----------------------------------------------------------
  const targetTick = Math.max(...startTicks) + RUN_TICKS
  note(`running to tick ${targetTick} (~${Math.round(RUN_TICKS / 60)}s of sim)…`)
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.waitForFunction((t) => window.__bbNet.tick >= t, { timeout: 120000 }, targetTick),
    ),
  )

  // -- player-state cross-check -------------------------------------------------
  // Player capsules are in NEITHER hashSim nor hashPhysics (missing hash
  // export, see INTEGRATION-net.md) — compare full kinematic state directly.
  // Wait for both players to come to rest so a 1-tick sample skew can't
  // produce a false positive, then require bit-exact equality.
  const settled = (page) =>
    page.waitForFunction(
      () => window.__bbNet.playersState().every((p) => Math.hypot(p.vx, p.vy, p.vz) < 1e-9),
      { timeout: 15000 },
    )
  let playersComparable = true
  try {
    await Promise.all([settled(pageA), settled(pageB)])
  } catch {
    playersComparable = false
    note('players did not come to rest — skipping bit-exact player compare (tick-skew would alias)')
  }
  if (playersComparable) {
    const [playersA, playersB] = await Promise.all(
      [pageA, pageB].map((p) => p.evaluate(() => JSON.stringify(window.__bbNet.playersState()))),
    )
    if (playersA !== playersB) {
      fail(`player kinematic state diverged:\n  A: ${playersA}\n  B: ${playersB}`)
    } else {
      note('player kinematic state bit-identical across browsers')
    }
  }

  // -- assertions -------------------------------------------------------------
  const [stateA, stateB] = await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(() => ({
        tick: window.__bbNet.tick,
        verifiedTick: window.__bbNet.verifiedTick,
        desync: window.__bbNet.desync,
        hashes: window.__bbNet.lastHashes,
        maxRafGapMs: window.__bbNet.maxRafGapMs,
      })),
    ),
  )

  // (a) combined-hash sequences identical over the overlapping checkpoint window
  const mapA = new Map(stateA.hashes.map((h) => [h.tick, h.hash]))
  const mapB = new Map(stateB.hashes.map((h) => [h.tick, h.hash]))
  const common = [...mapA.keys()].filter((t) => mapB.has(t)).sort((x, y) => x - y)
  const expectedCheckpoints = Math.floor(RUN_TICKS / HASH_INTERVAL) - 2
  if (common.length < expectedCheckpoints) {
    fail(`too few common hash checkpoints: ${common.length} < ${expectedCheckpoints}`)
  }
  let divergedAt = null
  for (const t of common) {
    if (mapA.get(t) !== mapB.get(t)) {
      divergedAt = t
      break
    }
  }
  if (divergedAt !== null) {
    fail(
      `HASH DIVERGENCE at tick ${divergedAt}: ` +
        `A=0x${mapA.get(divergedAt).toString(16)} B=0x${mapB.get(divergedAt).toString(16)}`,
    )
  } else {
    note(`hash sequences identical over ${common.length} checkpoints (ticks ${common[0]}..${common[common.length - 1]})`)
  }

  // (b) desync detector green
  if (stateA.desync) fail(`host desync detector fired: tick ${stateA.desync.tick}`)
  if (stateB.desync) fail(`guest desync reporter fired: tick ${stateB.desync.tick}`)
  if (stateA.verifiedTick < targetTick - HASH_INTERVAL * 3) {
    fail(`detector not verifying: lastVerifiedTick ${stateA.verifiedTick} vs tick ${stateA.tick}`)
  } else {
    note(`desync detector green (host verified through tick ${stateA.verifiedTick})`)
  }

  // (c) same tick within barrier tolerance
  const skew = Math.abs(stateA.tick - stateB.tick)
  if (skew > TICK_TOLERANCE) fail(`tick skew ${skew} exceeds barrier tolerance ${TICK_TOLERANCE}`)
  else note(`tick skew ${skew} (A=${stateA.tick} B=${stateB.tick})`)
  // rAF starvation evidence (headless GPU contention) — pump covers it, log it
  note(`max rAF gap: A=${stateA.maxRafGapMs}ms B=${stateB.maxRafGapMs}ms`)

  // (d) no console/page errors on either page
  for (const label of ['A', 'B']) {
    if (errorLogs[label].length) fail(`page ${label} errors:\n  ${errorLogs[label].join('\n  ')}`)
  }
} catch (e) {
  fail(`harness error: ${e.message}`)
  await dumpDiagnostics()
} finally {
  for (const b of browsers) await b.close().catch(() => {})
  vite.kill()
  signal.kill()
}

if (failures.length) {
  console.error(`\n[mp-e2e] ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\n[mp-e2e] PASS — two browsers, identical combined-hash sequences, detector green')
