#!/usr/bin/env node
/**
 * T61/T62 water visual iteration (not a gate — scripts/smoke.mjs stays the
 * authoritative check): boots like dev-shots.mjs, walks the player to the
 * spawn-lot pool (deterministic for seed 1337: basin center ~44.2, 32.6 m;
 * spawn ~52.2, 51.2 m), then captures:
 *   1. water-calm-0/1/2.png       — calm pool (ripples/fresnel, motion check)
 *   2. water-disturb-f0..f4.png   — dug-into pool, 5 rapid frames (seam/flicker check)
 *   3. water-breach-before/after.png — wall breach + 20s drain
 *
 * Usage: node scripts/water-shots.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SHOT_PORT ?? 5900 + (process.pid % 100))
const ARTIFACTS = 'smoke-artifacts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite start timeout')), 15000)
  vite.stdout.on('data', (d) => String(d).includes('Local:') && (clearTimeout(t), resolve()))
})

let browser
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--no-first-run', '--window-size=1280,800'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => console.error('[water-shots] pageerror:', e.message))
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 90000 },
  )
  await sleep(1200)
  mkdirSync(ARTIFACTS, { recursive: true })

  // pointer lock
  await page.mouse.click(640, 400)
  await sleep(400)

  const look = (dx, dy) =>
    page.evaluate(
      ([mx, my]) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: mx, movementY: my })),
      [dx, dy],
    )
  const walk = async (key, ms) => {
    await page.keyboard.down(key)
    await sleep(ms)
    await page.keyboard.up(key)
  }
  const snap = async (name) => {
    await page.screenshot({ path: `${ARTIFACTS}/${name}.png` })
    console.log(`[water-shots] ${name}.png`)
  }

  // face the pool: spawn→pool dir ≈ (-0.395, -0.919) → yaw ≈ +0.406 rad;
  // sensitivity 0.002 rad/px, left (negative dx) = +yaw
  await look(-203, 0)
  await page.keyboard.press('Digit1') // dig tool
  await sleep(200)

  // fly (F, spectator cam): repeatable framing, and tool rays come from the
  // flying camera (T45) so we can dig into the pool from above
  await page.keyboard.press('KeyF')
  await sleep(200)
  await walk('KeyW', 1300) // ~15.6m toward the pool at 12 m/s
  await walk('KeyE', 350) // +4m altitude
  await look(0, 436) // pitch down ~50°
  await sleep(300)
  await walk('KeyW', 350) // close to ~5m from the water (edit range 9m)
  await sleep(700)

  // 1. calm pool — three frames 400ms apart (ripples should MOVE, not flicker)
  await snap('water-calm-0')
  await sleep(400)
  await snap('water-calm-1')
  await sleep(400)
  await snap('water-calm-2')

  // 2. disturb: dig into the water/pool floor at the crosshair
  for (let i = 0; i < 6; i++) {
    await page.mouse.down()
    await sleep(140)
    await page.mouse.up()
    await sleep(120)
  }
  await sleep(300)
  // 5 rapid frames — compare for transparent seams / frame-to-frame flicker
  for (let f = 0; f < 5; f++) {
    await snap(`water-disturb-f${f}`)
    await sleep(120)
  }

  // 3. drain: keep digging the pool floor into a pit, watch the level drop
  await snap('water-breach-before')
  for (let i = 0; i < 14; i++) {
    await page.mouse.down()
    await sleep(140)
    await page.mouse.up()
    await sleep(110)
  }
  await sleep(8000)
  await snap('water-breach-mid')
  await sleep(12000)
  await snap('water-breach-after')
} catch (e) {
  console.error(`[water-shots] FAIL: ${e.message}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
