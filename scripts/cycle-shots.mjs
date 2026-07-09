#!/usr/bin/env node
/**
 * T58 throwaway visual harness (NOT a gate — smoke.mjs is the gate).
 * Boots the game via CDP like smoke.mjs, then steps the day cycle through
 * fixed times via the window.__bbCycle dev handle and screenshots each,
 * recording fps + renderer.info draw counts (culling audit).
 *
 * Usage: node scripts/cycle-shots.mjs [--headed]
 * Artifacts: smoke-artifacts/cycle-<label>.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT ?? 5600 + (process.pid % 300))
const HEADED = process.argv.includes('--headed')
const ARTIFACTS = 'smoke-artifacts'

const TIMES = [
  { label: 'noon', hours: 12.0 },
  { label: 'golden', hours: 17.3 },
  { label: 'dusk', hours: 18.35 },
  { label: 'night', hours: 23.5 },
]

const note = (msg) => console.log(`[cycle] ${msg}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite timeout')), 15000)
  vite.stdout.on('data', (d) => {
    if (String(d).includes('Local:')) {
      clearTimeout(t)
      resolve()
    }
  })
})
note(`vite :${PORT}`)

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
  page.on('pageerror', (e) => note(`PAGEERROR: ${e}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !String(m.location()?.url ?? '').includes('favicon'))
      note(`CONSOLE ERROR: ${m.text()}`)
  })

  await page.goto(`http://localhost:${PORT}/?boot=game&world=full&seed=1337`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  })
  await page.waitForFunction(
    () => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 90000 },
  )
  note('world settled')
  await new Promise((r) => setTimeout(r, 1500))

  mkdirSync(ARTIFACTS, { recursive: true })

  const readFps = () =>
    page.evaluate(() => Number(/(\d+) fps/.exec(document.getElementById('hud')?.textContent ?? '')?.[1] ?? 0))

  for (const t of TIMES) {
    await page.evaluate((h) => window.__bbCycle.setOverride(h), t.hours)
    await new Promise((r) => setTimeout(r, 2500)) // light easing + fps counter
    const fps = await readFps()
    const probe = await page.evaluate(() => ({
      hours: window.__bbCycle.hours,
      lamps: window.__bbCycle.lampCount(),
      draws: window.__bbCycle.info.render.drawCalls,
      tris: window.__bbCycle.info.render.triangles,
      intensity: window.__bbCycle.state.lightIntensity,
      moon: window.__bbCycle.state.moonIsLight,
    }))
    await page.screenshot({ path: `${ARTIFACTS}/cycle-${t.label}.png` })
    note(
      `${t.label} (${t.hours}h): fps=${fps} draws=${probe.draws} tris=${probe.tris} ` +
        `lightI=${probe.intensity.toFixed(2)} moon=${probe.moon} lamps=${probe.lamps}`,
    )
  }

  // --- culling audit: draw counts looking at scene center vs straight up ----
  // real gameplay path: pointer-lock the canvas, pitch up via mouse deltas
  await page.evaluate(() => window.__bbCycle.setOverride(12))
  await page.mouse.click(640, 400) // take control (pointer lock)
  await new Promise((r) => setTimeout(r, 800))
  const readInfo = () =>
    page.evaluate(() => ({
      draws: window.__bbCycle.info.render.drawCalls,
      tris: window.__bbCycle.info.render.triangles,
      regions: window.__bbCycle.regionCount(),
    }))
  const level = await readInfo()
  note(`culling: level view draws=${level.draws} tris=${level.tris} regions=${level.regions}`)
  // synthetic pointer-locked look: PlayerInput reads movementX/Y off document
  // mousemove while the canvas holds pointer lock (real input path otherwise)
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementY: -2500 }))
  })
  await new Promise((r) => setTimeout(r, 600))
  const up = await readInfo()
  await page.screenshot({ path: `${ARTIFACTS}/cycle-lookup.png` })
  note(`culling: sky view draws=${up.draws} tris=${up.tris}`)

  // isolate the shadow-pass share: main pass only (throwaway toggle)
  await page.evaluate(() => (window.__bbCycle.sun.castShadow = false))
  await new Promise((r) => setTimeout(r, 400))
  const upNoShadow = await readInfo()
  note(`culling: sky view NO-shadow draws=${upNoShadow.draws} tris=${upNoShadow.tris}`)
  // pitch back to level: from the +1.55 clamp, +1.55/0.002 = 775 counts
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { movementY: 775 }))
  })
  await new Promise((r) => setTimeout(r, 400))
  const levelNoShadow = await readInfo()
  note(`culling: level view NO-shadow draws=${levelNoShadow.draws} tris=${levelNoShadow.tris}`)
  await page.evaluate(() => (window.__bbCycle.sun.castShadow = true))
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
note('done')
