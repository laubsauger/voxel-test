/**
 * Local multiplayer playtest harness. Launches TWO real Chrome windows
 * (separate processes) side by side with background-throttling DISABLED, so two
 * clients on one machine stay at 60Hz even when a window isn't focused — the
 * lockstep barrier doesn't stall on a throttled peer. Auto-drives host + join to
 * the lobby, then hands control to you: press START in the HOST window and play.
 *
 * Usage: npm run mp-local  (Ctrl+C to quit — closes both windows + the dev server)
 *
 * NOTE: this is the *testing* fix (disable throttling). The product fix for a
 * genuinely backgrounded tab is the hidden-tab heartbeat in net/lockstep.ts.
 */
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.MP_LOCAL_PORT ?? 5700 + (process.pid % 300))
const SEED = Number(process.env.MP_LOCAL_SEED ?? 424242)
const note = (m) => console.log(`[mp-local] ${m}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start in 15s')), 15000)
  vite.stdout.on('data', (d) => String(d).includes('Local:') && (clearTimeout(t), resolve()))
  vite.stderr.on('data', (d) => process.stderr.write(d))
})
const URL = `http://localhost:${PORT}/?seed=${SEED}`
note(`dev server: ${URL}`)

const browsers = []
async function launch(label, xOffset) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // real visible windows — that's the point
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--use-angle=metal',
      '--no-first-run',
      `--window-size=900,720`,
      `--window-position=${xOffset},60`,
      // the whole reason two local clients work: keep both at 60Hz unfocused
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  })
  browsers.push(browser)
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 700 })
  page.on('console', (m) => m.type() === 'warning' && m.text().startsWith('[net]') && note(`${label} ${m.text()}`))
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
  return page
}

const waitVisible = (page, sel, timeout = 90000) =>
  page.waitForFunction(
    (s) => {
      const el = document.querySelector(s)
      if (!el) return false
      let n = el
      while (n instanceof Element) { if (n.classList.contains('bb-leave')) return false; n = n.parentElement }
      return true
    },
    { timeout },
    sel,
  )

async function cleanup() {
  note('shutting down…')
  await Promise.all(browsers.map((b) => b.close().catch(() => {})))
  vite.kill()
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

try {
  note('launching two Chrome windows…')
  const [host, guest] = await Promise.all([launch('HOST', 40), launch('GUEST', 960)])

  note('HOST: creating room…')
  await waitVisible(host, '.bb-menu [data-act="host"]')
  await host.click('.bb-menu [data-act="host"]')
  await host.waitForFunction(
    () => /^[A-Z2-9]{6}$/.test(document.querySelector('[data-mp="code"]')?.textContent ?? ''),
    { timeout: 30000 },
  )
  const code = await host.$eval('[data-mp="code"]', (el) => el.textContent.trim())
  note(`room code: ${code}`)

  note('GUEST: joining…')
  await waitVisible(guest, '.bb-menu [data-act="join"]')
  await guest.click('.bb-menu [data-act="join"]')
  await guest.waitForSelector('[data-mp="code-input"]', { timeout: 15000 })
  await guest.type('[data-mp="code-input"]', code)
  await guest.click('[data-mp="join"]')

  await Promise.all(
    [host, guest].map((p) =>
      p.waitForFunction(() => document.querySelectorAll('.bb-mp-player:not(.bb-mp-slot-open)').length >= 2, {
        timeout: 30000,
      }),
    ),
  )
  note('')
  note('  ✅ Both in the lobby. Now:')
  note('     1. Click the HOST window → press START SESSION')
  note('     2. Click each window to take control (pointer lock), WASD to move')
  note('     3. Both windows stay at 60Hz even unfocused (throttling disabled)')
  note('')
  note('  Ctrl+C here to quit.')
  await new Promise(() => {}) // hold open until Ctrl+C
} catch (e) {
  note(`ERROR: ${e.message}`)
  await cleanup()
}
