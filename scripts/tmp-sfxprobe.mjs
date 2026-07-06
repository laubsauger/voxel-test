/** TEMP — capture which SFX fire on fly-toggle + jump. Deleted after use. */
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.MP_E2E_PORT ?? 5800 + (process.pid % 500))
const note = (m) => console.log(`[probe] ${m}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite timeout')), 15000)
  vite.stdout.on('data', (d) => String(d).includes('Local:') && (clearTimeout(t), resolve()))
  vite.stderr.on('data', (d) => process.stderr.write(d))
})
const URL = `http://localhost:${PORT}/?boot=game&seed=1337`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const sfx = []
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[sfxprobe]')) { sfx.push(t); note(t) } })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForFunction(() => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 90000 })
  // unlock audio with a real gesture (click canvas → pointer lock)
  await page.mouse.click(640, 400)
  await new Promise((r) => setTimeout(r, 800))

  note('--- pressing Space (jump) ---')
  await page.keyboard.press('Space')
  await new Promise((r) => setTimeout(r, 1500))

  note('--- toggling fly ON (KeyF) ---')
  await page.keyboard.press('KeyF')
  await new Promise((r) => setTimeout(r, 1200))
  note('--- toggling fly OFF (KeyF) ---')
  await page.keyboard.press('KeyF')
  await new Promise((r) => setTimeout(r, 1500))

  note('--- fly ON again + move up then off (land) ---')
  await page.keyboard.press('KeyF')
  await page.keyboard.down('KeyE'); await new Promise((r) => setTimeout(r, 500)); await page.keyboard.up('KeyE')
  await new Promise((r) => setTimeout(r, 500))
  await page.keyboard.press('KeyF')
  await new Promise((r) => setTimeout(r, 1800))

  note(`=== captured ${sfx.length} sfx events ===`)
} catch (e) {
  note(`ERROR: ${e.message}`)
} finally {
  await browser.close().catch(() => {})
  vite.kill()
}
