#!/usr/bin/env node
/**
 * Dev screenshot helper (render-quality iteration, T29/T30/T39): boots vite +
 * headless Chrome like scripts/smoke.mjs, waits for the world to settle, then
 * drives the player (pointer-lock look + WASD walk) through a list of moves
 * and screenshots each stop into smoke-artifacts/.
 *
 * Usage: node scripts/dev-shots.mjs
 * (Not part of any gate — scripts/smoke.mjs stays the authoritative check.)
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SHOT_PORT ?? 5800 + (process.pid % 100))
const ARTIFACTS = 'smoke-artifacts'

/** each shot: look (dx,dy in pointer-lock px), walk (keys+ms), then snap */
// look deltas in pointer-lock px (sensitivity 0.002 rad/px → 785px ≈ 90°)
const SHOTS = [
  { name: 'shot-sky-up', look: [0, -700], walk: null },
  { name: 'shot-sun', look: [-785, 420], walk: null }, // 90° left, ~30° above horizon
  { name: 'shot-wall-close', look: [1130, 380], walk: ['KeyW', 5200] }, // ~45° off street, walk into a wall
]

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
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 90000 },
  )
  await new Promise((r) => setTimeout(r, 1200))
  mkdirSync(ARTIFACTS, { recursive: true })

  // pointer lock
  await page.mouse.click(640, 400)
  await new Promise((r) => setTimeout(r, 400))

  for (const shot of SHOTS) {
    const [dx, dy] = shot.look
    // synthetic mousemove with movementX/Y — avoids puppeteer's absolute
    // coords clamping at screen edges under pointer lock
    await page.evaluate(
      ([mx, my]) => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { movementX: mx, movementY: my }),
        )
      },
      [dx, dy],
    )
    if (shot.walk) {
      const [key, ms] = shot.walk
      await page.keyboard.down(key)
      await new Promise((r) => setTimeout(r, ms))
      await page.keyboard.up(key)
    }
    await new Promise((r) => setTimeout(r, 600))
    await page.screenshot({ path: `${ARTIFACTS}/${shot.name}.png` })
    console.log(`[shots] ${shot.name}.png`)
  }
} catch (e) {
  console.error(`[shots] FAIL: ${e.message}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
