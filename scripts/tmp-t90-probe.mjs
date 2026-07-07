// TEMP — T90 verification: boundary-cross longtasks while driving + plane cam. Delete after.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
const PORT = Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))
mkdirSync('smoke-artifacts', { recursive: true })
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
let browser
try {
  await sleep(2500)
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu','--enable-features=WebGPU','--use-angle=metal','--window-size=1280,800'] })
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)))
  page.on('console', (m) => { if (m.text().includes('[perf]')) console.log('PERF', m.text()) })
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337&dev=1`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 120000 })
  await sleep(1500)
  await page.evaluate(() => {
    globalThis.__long = []
    new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__long.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
    globalThis.__bbDev.submitOp({ kind: 'spawn' })
  })
  await sleep(400)
  // spawn a sedan at the player + enter + drive straight for 8s (crosses many chunk boundaries)
  await page.evaluate(() => {
    globalThis.__bbDev.submitOp({ kind: 'vehicle_spawn', archetype: 'sedan0', x: 102.4, y: 1.4, z: 104.0, yaw: 0 })
  })
  await sleep(400)
  await page.evaluate(() => globalThis.__bbDev.submitOp({ kind: 'vehicle_enter' }))
  await sleep(300)
  await page.evaluate(() => { globalThis.__long.length = 0 })
  // drive: forward input ops for ~8s (input bit 1 = fwd per INPUT_FWD? use move op via keyboard instead)
  await page.mouse.click(640, 400) // pointer lock
  await sleep(600)
  await page.keyboard.down('KeyW')
  await sleep(8000)
  await page.keyboard.up('KeyW')
  const driveLong = await page.evaluate(() => globalThis.__long.filter((d) => d > 30))
  console.log('DRIVE longtasks>30ms over 8s:', JSON.stringify(driveLong))
  await page.evaluate(() => globalThis.__bbDev.submitOp({ kind: 'vehicle_exit' }))
  await sleep(400)
  // plane: spawn at player, enter, chase cam screenshot, V → FP screenshot
  await page.evaluate(() => globalThis.__bbDev.submitOp({ kind: 'aircraft_spawn', x: 103.5, y: 1.6, z: 106.0, yaw: 0 }))
  await sleep(400)
  await page.evaluate(() => globalThis.__bbDev.submitOp({ kind: 'aircraft_enter' }))
  await sleep(800)
  await page.screenshot({ path: 'smoke-artifacts/plane-chase.png' })
  await page.keyboard.press('KeyV')
  await sleep(500)
  await page.screenshot({ path: 'smoke-artifacts/plane-fp.png' })
  console.log('ERRORS:', errors.length ? errors.slice(0, 3).join(' | ') : 'none')
} catch (e) { console.error('FAIL', e?.message ?? e) } finally {
  await browser?.close().catch(() => {}); vite.kill('SIGTERM'); await sleep(400); process.exit(0)
}
