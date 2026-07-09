#!/usr/bin/env node
/**
 * T64 — vehicle visual verification (smoke pattern): boots the game via CDP,
 * dev-spawns a car (KeyG), enters it (Enter), drives into a fence/house,
 * screenshots chase cam + crash aftermath + exit.
 *
 * REQUIRES the game.ts wiring from src/sim/INTEGRATION-vehicles.md
 * (VehicleMeshes + chase cam + installVehicleDevControls + window.__bbGame
 * debug handle) — fails loud if missing.
 *
 * Usage: node scripts/vehicle-shots.mjs [--headed]
 * Artifacts: smoke-artifacts/vehicle-*.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT ?? 5400 + (process.pid % 500))
const HEADED = process.argv.includes('--headed')
const ARTIFACTS = 'smoke-artifacts'

const failures = []
const note = (msg) => console.log(`[vehicle-shots] ${msg}`)
const fail = (msg) => {
  failures.push(msg)
  console.error(`[vehicle-shots] FAIL: ${msg}`)
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
note(`vite up on :${PORT}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let browser
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--no-first-run', '--window-size=1280,800'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(`http://localhost:${PORT}/?boot=game&world=full&seed=1337&dev=1`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForFunction(() => /fps/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 30000 })
  await page
    .waitForFunction(() => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 90000 })
    .catch(() => note('meshing did not fully settle (continuing)'))
  note('game up')
  mkdirSync(ARTIFACTS, { recursive: true })

  const handle = await page.evaluate(() => typeof window.__bbGame !== 'undefined')
  if (!handle) throw new Error('window.__bbGame missing — apply the game.ts wiring from INTEGRATION-vehicles.md first')

  const state = () =>
    page.evaluate(() => {
      const g = window.__bbGame
      const p = g.phys.players.get(1)
      const v = p && p.seatedVehicle !== 0 ? g.phys.vehicles.get(p.seatedVehicle) : [...g.phys.vehicles.values()][0]
      return {
        vehicles: g.phys.vehicles.size,
        bodies: g.phys.bodies.size,
        seated: p ? p.seatedVehicle : -1,
        v: v
          ? {
              id: v.id,
              px: v.px, py: v.py, pz: v.pz,
              speed: Math.hypot(v.vx, v.vy, v.vz),
              count: v.count, initial: v.initialCount, version: v.version,
              wheelsBroken: v.wheels.filter((w) => w.broken).length,
            }
          : null,
      }
    })

  // face down the road (yaw ~ west along the crossing), then summon a car
  await page.evaluate(() => {
    window.__bbGame.input.yaw = Math.PI / 2 // face -x (down the east-west road)
  })
  await sleep(500)
  await page.keyboard.press('KeyG')
  await sleep(1200)
  let s = await state()
  if (s.vehicles < 1) fail(`dev spawn produced no vehicle (vehicles=${s.vehicles})`)
  else note(`spawned vehicle id=${s.v.id} at (${s.v.px.toFixed(1)}, ${s.v.py.toFixed(1)}, ${s.v.pz.toFixed(1)}) voxels=${s.v.count}`)
  await page.screenshot({ path: `${ARTIFACTS}/vehicle-1-spawned.png` })

  // enter — chase cam should take over
  await page.keyboard.press('Enter')
  await sleep(600)
  s = await state()
  if (s.seated === 0) fail('Enter did not seat the player')
  else note(`seated in vehicle ${s.seated}`)
  await page.screenshot({ path: `${ARTIFACTS}/vehicle-2-entered.png` })

  // drive straight down the road
  await page.keyboard.down('KeyW')
  await sleep(2200)
  s = await state()
  note(`driving: speed=${s.v ? s.v.speed.toFixed(1) : '?'} m/s`)
  if (s.v && s.v.speed < 3) fail(`car barely moving while driving (${s.v.speed.toFixed(1)} m/s)`)
  await page.screenshot({ path: `${ARTIFACTS}/vehicle-3-driving.png` })

  // veer right (KeyD = steer) off the road into fences/houses, throttle pinned
  await page.keyboard.down('KeyD')
  await sleep(450)
  await page.keyboard.up('KeyD')
  let crashed = false
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    s = await state()
    if (!s.v || s.v.version > 0) {
      crashed = true
      break
    }
  }
  // keep the throttle pinned — plow through the yard into the house wall
  await sleep(2500)
  await page.keyboard.up('KeyW')
  await sleep(700)
  s = await state()
  if (s.v) {
    note(`after crash leg: version=${s.v.version} voxels=${s.v.count}/${s.v.initial} wheelsBroken=${s.v.wheelsBroken} speed=${s.v.speed.toFixed(1)}`)
  } else {
    note(`vehicle wrecked outright: vehicles=${s.vehicles} bodies=${s.bodies} seated=${s.seated}`)
  }
  if (!crashed) fail('no chassis damage after the crash leg — car never hit anything hard')
  await page.screenshot({ path: `${ARTIFACTS}/vehicle-4-crash.png` })

  // exit — camera restores, player beside the car
  await page.keyboard.press('Enter')
  await sleep(700)
  s = await state()
  if (s.seated !== 0) fail(`exit failed (seated=${s.seated})`)
  else note('exited')
  await page.screenshot({ path: `${ARTIFACTS}/vehicle-5-exited.png` })

  if (pageErrors.length) fail(`page errors:\n  ${pageErrors.join('\n  ')}`)
} catch (e) {
  fail(`harness error: ${e.message}`)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}

if (failures.length) {
  console.error(`\n[vehicle-shots] ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\n[vehicle-shots] PASS')
