#!/usr/bin/env node
/**
 * Dev probe (T50/B19 verification) — boots the game like smoke.mjs, then
 * enters fly mode (F) and steers the spectator cam via synthetic pointer-lock
 * input to capture aerial shots: villa pool (water visibility), skyline.
 * NOT a gate — a visual iteration tool. Artifacts: smoke-artifacts/shot-*.png
 *
 * Usage: node scripts/world-shot.mjs [--headed]
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT ?? 5800 + (process.pid % 400))
const HEADED = process.argv.includes('--headed')
const ARTIFACTS = 'smoke-artifacts'
const note = (msg) => console.log(`[shot] ${msg}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite timeout')), 15000)
  vite.stdout.on('data', (d) => String(d).includes('Local:') && (clearTimeout(t), resolve()))
})
note(`vite :${PORT}`)

let browser
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--no-first-run', '--window-size=1280,800'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, { waitUntil: 'domcontentloaded', timeout: 15000 })

  await page.waitForFunction(() => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 240000 })
  note('settled')
  await new Promise((r) => setTimeout(r, 2500)) // let water CA fill pools

  mkdirSync(ARTIFACTS, { recursive: true })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const hold = async (key, ms) => {
    await page.keyboard.down(key)
    await sleep(ms)
    await page.keyboard.up(key)
  }
  // Headless pointer-lock movement is synthesized from cursor POSITION
  // deltas, so look budget = viewport travel from the click point. One lock
  // session, one continuous path — no resets (they'd cancel the deltas).
  // yaw -= dx*0.002, pitch -= dy*0.002 (no invert).
  await page.mouse.move(920, 4)
  await page.mouse.click(920, 4) // take control → pointer lock at top edge
  await sleep(500)
  await page.keyboard.press('KeyF') // fly/spectator
  await sleep(200)

  // shot 1: yaw +0.56 toward the villa (SW), fly over it, pitch hard down
  await page.mouse.move(640, 4, { steps: 12 }) // dx -280 → yaw +0.56
  await hold('KeyW', 1700) // ~20 m horizontal
  await hold('KeyE', 2100) // ~25 m up
  await page.mouse.move(640, 700, { steps: 16 }) // dy +696 → pitch −1.39
  await sleep(700)
  await page.screenshot({ path: `${ARTIFACTS}/shot-villa.png` })
  note('shot-villa.png')

  // shot 1b: drop low beside the pool, shallow angle — waterline visible
  await hold('KeyQ', 1500) // descend ~18 m
  await page.mouse.move(680, 420, { steps: 12 }) // pitch back to ~−0.83
  await hold('KeyW', 400)
  await sleep(700)
  await page.screenshot({ path: `${ARTIFACTS}/shot-pool.png` })
  note('shot-pool.png')
  await page.mouse.move(640, 700, { steps: 8 }) // restore the path anchor

  // shot 2: pitch back to horizon + yaw −1.27 → net −0.71 ≈ facing NE — the
  // commercial quarter skyline across the core
  await page.mouse.move(1276, 4, { steps: 16 })
  await hold('KeyE', 800)
  await sleep(700)
  await page.screenshot({ path: `${ARTIFACTS}/shot-skyline.png` })
  note('shot-skyline.png')

  // shot 3: climb high, pitch down again — town overview
  await page.keyboard.down('ShiftLeft')
  await hold('KeyE', 2200)
  await page.keyboard.up('ShiftLeft')
  await page.mouse.move(1276, 620, { steps: 16 }) // pitch −1.23
  await sleep(700)
  await page.screenshot({ path: `${ARTIFACTS}/shot-overview.png` })
  note('shot-overview.png')

  // shot 4: park district — fresh page (fresh pointer-lock look budget),
  // climb high and drift due south (S at yaw 0), then look straight down
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForFunction(() => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 240000 })
  await sleep(1500)
  await page.mouse.move(640, 4)
  await page.mouse.click(640, 4)
  await sleep(500)
  await page.keyboard.press('KeyF')
  await sleep(200)
  await page.keyboard.down('ShiftLeft')
  await hold('KeyE', 2400) // ~95 m up
  await hold('KeyS', 1800) // ~70 m due south → over the park band
  await page.keyboard.up('ShiftLeft')
  await page.mouse.move(640, 780, { steps: 16 }) // pitch −1.55 (straight down)
  await sleep(700)
  await page.screenshot({ path: `${ARTIFACTS}/shot-park.png` })
  note('shot-park.png')

  const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '')
  note(`hud: ${hud}`)
} catch (e) {
  console.error(`[shot] error: ${e.message}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
