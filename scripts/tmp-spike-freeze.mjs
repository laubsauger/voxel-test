// TEMP — visual check: freeze keeps shape (no scatter), shoot rubble breaks it.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
const PORT = Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync('smoke-artifacts', { recursive: true })
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
let browser
try {
  await sleep(2500)
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--window-size=1280,800'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
  await page.goto(`http://localhost:${PORT}/box3d-spike.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => /tick\s+\d/.test(document.getElementById('hud')?.textContent ?? ''), { timeout: 30000 })
  await sleep(1500)

  // collapse the target building directly (marching blasts down its column)
  await page.evaluate(async () => {
    const t = globalThis.__spike.target
    for (let i = 0; i < 6; i++) { globalThis.__spike.explode(t.vx, Math.max(6, t.vy - i * 4), t.vz, 10, 9); await new Promise(r => setTimeout(r, 120)) }
  })
  await sleep(4500) // let it collapse + settle + FREEZE
  const s1 = await page.evaluate(() => ({ bodies: globalThis.__spike.phys.bodies.size, ...globalThis.__spike.prof() }))
  console.log('after collapse+freeze:', JSON.stringify({ bodies: s1.bodies, structuralMs: s1.structuralMs.toFixed(1), stepMs: s1.stepMs.toFixed(1), renderMs: s1.renderMs.toFixed(1) }))
  await page.screenshot({ path: 'smoke-artifacts/freeze-rubble.png' })

  // now shoot the rubble pile — it should react/break, not be ignored
  const b0 = s1.bodies
  await page.evaluate(() => {
    const bs = [...globalThis.__spike.phys.bodies.values()]
    const b = bs[Math.floor(bs.length / 2)]
    if (b) globalThis.__spike.explode(Math.round(b.px / 0.1), Math.round(b.py / 0.1), Math.round(b.pz / 0.1), 6, 9)
  })
  await sleep(2500)
  const s2 = await page.evaluate(() => globalThis.__spike.phys.bodies.size)
  console.log('shoot rubble: bodies', b0, '->', s2, ' (changed =', b0 !== s2, ')')
  await page.screenshot({ path: 'smoke-artifacts/freeze-shot.png' })
  console.log('ERRORS:', errors.length ? errors.join('|') : 'none')
} catch (e) { console.error('FAIL', e?.message ?? e) } finally {
  await browser?.close().catch(() => {}); vite.kill('SIGTERM'); await sleep(400); process.exit(0)
}
