#!/usr/bin/env node
/**
 * CDP smoke test — real Chrome, real WebGPU, no extension.
 * Boots vite dev server, drives Chrome via puppeteer-core (CDP),
 * fails loud on: fatal overlay, page errors, console errors,
 * missing WebGPU, or a stalled render loop (fps HUD never appears).
 *
 * Usage: npm run smoke [-- --headed]
 * Artifacts: smoke-artifacts/screenshot.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { PNG } from 'pngjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 5199
const HEADED = process.argv.includes('--headed')
const ARTIFACTS = 'smoke-artifacts'

const failures = []
const note = (msg) => console.log(`[smoke] ${msg}`)
const fail = (msg) => {
  failures.push(msg)
  console.error(`[smoke] FAIL: ${msg}`)
}

// -- vite dev server ---------------------------------------------------------
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
})
note(`vite up on :${PORT}`)

let browser
try {
  // -- chrome via CDP --------------------------------------------------------
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

  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const url = m.location()?.url ?? ''
    if (url.includes('favicon')) return
    consoleErrors.push(`${m.text()} (${url})`)
  })

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 15000 })

  // WebGPU actually available in this Chrome?
  const gpu = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return 'no navigator.gpu'
    const adapter = await navigator.gpu.requestAdapter().catch((e) => null)
    return adapter ? 'ok' : 'no adapter'
  })
  if (gpu !== 'ok') fail(`WebGPU unavailable in test Chrome: ${gpu}`)
  else note('WebGPU adapter ok')

  // Render loop alive = fps HUD text shows up.
  const hudAlive = await page
    .waitForFunction(() => /fps/.test(document.getElementById('hud')?.textContent ?? ''), {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false)
  if (!hudAlive) fail('render loop never reported fps (HUD empty after 20s)')
  else note(`hud: ${await page.evaluate(() => document.getElementById('hud').textContent)}`)

  // Fatal overlay visible?
  const fatalText = await page.evaluate(() => {
    const el = document.getElementById('fatal')
    return el && getComputedStyle(el).display !== 'none' ? el.textContent : null
  })
  if (fatalText) fail(`fatal overlay: ${fatalText}`)

  // Give it a couple seconds of runtime to shake out async errors, then screenshot.
  await new Promise((r) => setTimeout(r, 3000))
  mkdirSync(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: `${ARTIFACTS}/screenshot.png` })
  note(`screenshot → ${ARTIFACTS}/screenshot.png`)

  // Screenshot not just a blank frame? Analyze the PNG itself — reading back
  // a WebGPU canvas via 2d drawImage returns blank (frame already presented).
  const png = PNG.sync.read(readFileSync(`${ARTIFACTS}/screenshot.png`))
  let min = 255
  let max = 0
  for (let i = 0; i < png.data.length; i += 16) {
    const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3
    if (l < min) min = l
    if (l > max) max = l
  }
  const spread = max - min
  if (spread < 8) fail(`screenshot looks blank (luma spread ${spread})`)
  else note(`screenshot luma spread ${spread} — rendering something`)

  if (pageErrors.length) fail(`page errors:\n  ${pageErrors.join('\n  ')}`)
  if (consoleErrors.length) fail(`console errors:\n  ${consoleErrors.join('\n  ')}`)
} catch (e) {
  fail(`harness error: ${e.message}`)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}

if (failures.length) {
  console.error(`\n[smoke] ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\n[smoke] PASS')
