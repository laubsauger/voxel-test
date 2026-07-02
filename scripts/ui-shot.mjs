#!/usr/bin/env node
/**
 * UI screenshot harness (T33 design iteration) — same CDP pattern as
 * smoke.mjs. Boots vite, drives real Chrome/WebGPU, captures:
 *   smoke-artifacts/menu.png      — main menu over the live orbit scene
 *   smoke-artifacts/game-hud.png  — in-game HUD (?boot=game)
 *   smoke-artifacts/settings.png  — settings panel (graphics tab)
 *   smoke-artifacts/preloader.png — boot progress screen
 * Usage: node scripts/ui-shot.mjs [--headed]
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))
const HEADED = process.argv.includes('--headed')
const ARTIFACTS = 'smoke-artifacts'
const note = (msg) => console.log(`[ui-shot] ${msg}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('vite did not start in 15s')), 15000)
  vite.stdout.on('data', (d) => {
    if (String(d).includes('Local:')) {
      clearTimeout(timeout)
      resolve()
    }
  })
  vite.stderr.on('data', (d) => process.stderr.write(d))
})
note(`vite up on :${PORT}`)

let browser
let failed = false
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--use-angle=metal',
      '--no-first-run',
      '--window-size=1600,1000',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => {
    failed = true
    console.error(`[ui-shot] pageerror: ${e}`)
  })
  mkdirSync(ARTIFACTS, { recursive: true })

  // --- menu path (default boot) ----------------------------------------------
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bb-preloader', { timeout: 10000 })
  await new Promise((r) => setTimeout(r, 1200))
  await page.screenshot({ path: `${ARTIFACTS}/preloader.png` })
  note('preloader.png')

  await page.waitForFunction(
    () => document.querySelector('.bb-menu') && !document.querySelector('.bb-menu').classList.contains('bb-leave'),
    { timeout: 90000 },
  )
  await new Promise((r) => setTimeout(r, 1600)) // entrance animations settle
  await page.screenshot({ path: `${ARTIFACTS}/menu.png` })
  note('menu.png')

  // settings panel
  await page.click('.bb-menu-item[data-act="settings"]')
  await new Promise((r) => setTimeout(r, 700))
  await page.screenshot({ path: `${ARTIFACTS}/settings.png` })
  note('settings.png')

  // --- game path (?boot=game) --------------------------------------------------
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => /pending 0(\D|$)/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 90000 },
  )
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: `${ARTIFACTS}/game-hud.png` })
  note('game-hud.png')
} catch (e) {
  failed = true
  console.error(`[ui-shot] FAIL: ${e.message}`)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}
process.exit(failed ? 1 : 0)
