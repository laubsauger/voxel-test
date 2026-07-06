/** TEMP — verify host copy-on-click + join paste-button (headed: clipboard
 * needs a focused window). Deleted after use. */
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.MP_E2E_PORT ?? 5800 + (process.pid % 500))
const note = (m) => console.log(`[clip-test] ${m}`)

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite timeout')), 15000)
  vite.stdout.on('data', (d) => String(d).includes('Local:') && (clearTimeout(t), resolve()))
  vite.stderr.on('data', (d) => process.stderr.write(d))
})
const origin = `http://localhost:${PORT}`
const URL = `${origin}/?seed=424242`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--no-first-run', '--window-size=1280,800'],
})
await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write'])

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

let pass = { copy: false, paste: false }
try {
  // --- host copy-on-click ---
  const host = await browser.newPage()
  await host.setViewport({ width: 1280, height: 800 })
  await host.goto(URL, { waitUntil: 'domcontentloaded' })
  await host.bringToFront()
  await waitVisible(host, '.bb-menu [data-act="host"]')
  await host.click('.bb-menu [data-act="host"]')
  await host.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.querySelector('[data-mp="code"]')?.textContent ?? ''), { timeout: 30000 })
  const code = await host.$eval('[data-mp="code"]', (el) => el.textContent.trim())
  note(`host code: ${code}`)
  await host.bringToFront()
  await host.click('[data-mp="code"]')
  await new Promise((r) => setTimeout(r, 400))
  const clip = await host.evaluate(() => navigator.clipboard.readText())
  const label = await host.$eval('[data-mp="code-label"]', (el) => el.textContent)
  pass.copy = clip === code && /copied/i.test(label)
  note(`clicked code → clipboard="${clip}" label="${label}" → ${pass.copy ? 'PASS' : 'FAIL'}`)

  // --- join paste-button (messy clipboard: lowercase + spaces) ---
  const join = await browser.newPage()
  await join.setViewport({ width: 1280, height: 800 })
  await join.goto(URL, { waitUntil: 'domcontentloaded' })
  await join.bringToFront()
  await waitVisible(join, '.bb-menu [data-act="join"]')
  await join.click('.bb-menu [data-act="join"]')
  await join.waitForSelector('[data-mp="code-input"]', { timeout: 15000 })
  await join.evaluate((c) => navigator.clipboard.writeText(`  ${c.toLowerCase()} `), code)
  await join.click('[data-mp="paste"]')
  await new Promise((r) => setTimeout(r, 400))
  const inputVal = await join.$eval('[data-mp="code-input"]', (el) => el.value)
  pass.paste = inputVal === code
  note(`paste (messy clipboard) → input="${inputVal}" (expected "${code}") → ${pass.paste ? 'PASS' : 'FAIL'}`)
} catch (e) {
  note(`ERROR: ${e.message}`)
} finally {
  await browser.close().catch(() => {})
  vite.kill()
  const ok = pass.copy && pass.paste
  note(ok ? 'ALL PASS' : `FAIL (copy=${pass.copy} paste=${pass.paste})`)
  process.exit(ok ? 0 : 1)
}
