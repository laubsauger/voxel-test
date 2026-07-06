// TEMP — Box3D spike boot verification (T78/T79 live). Delete after.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = 'smoke-artifacts'
mkdirSync(OUT, { recursive: true })

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`))
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

let browser
try {
  await sleep(2500)
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--use-angle=metal',
      '--window-size=1280,800',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`)
  })

  await page.goto(`http://localhost:${PORT}/box3d-spike.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // render-loop-alive gate: HUD shows the spike text
  await page.waitForFunction(
    () => /steps\s+\d/.test(document.getElementById('hud')?.textContent ?? ''),
    { timeout: 30000 },
  )
  await sleep(2500) // let drop boxes fall + settle

  // diagnostics: mesh vertex counts + bounds + reframe camera to look at scene
  const diag = await page.evaluate(() => {
    const s = globalThis.__spike
    let meshes = 0
    let verts = 0
    const box = { minx: 1e9, miny: 1e9, minz: 1e9, maxx: -1e9, maxy: -1e9, maxz: -1e9 }
    s.scene.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) {
        meshes++
        const p = o.geometry.attributes.position
        verts += p.count
        for (let i = 0; i < p.count; i++) {
          box.minx = Math.min(box.minx, p.getX(i)); box.maxx = Math.max(box.maxx, p.getX(i))
          box.miny = Math.min(box.miny, p.getY(i)); box.maxy = Math.max(box.maxy, p.getY(i))
          box.minz = Math.min(box.minz, p.getZ(i)); box.maxz = Math.max(box.maxz, p.getZ(i))
        }
      }
    })
    return { children: s.scene.children.length, meshes, verts, box, camPos: s.cam.position }
  })
  console.log('DIAG:', JSON.stringify(diag))

  // T80: exercise both collider mappings, capture counts + build time
  const greedy = await page.evaluate(() => ({ ...globalThis.__spike.stats }))
  await page.evaluate(() => globalThis.__spike.setMode('per-voxel'))
  await sleep(1500)
  const perVoxel = await page.evaluate(() => ({ ...globalThis.__spike.stats }))
  const perVoxelStep = await page.evaluate(() => globalThis.__spike.phys.profile().step)
  console.log('MAP greedy:', JSON.stringify(greedy))
  console.log('MAP per-voxel:', JSON.stringify(perVoxel), 'stepMs', perVoxelStep.toFixed(3))
  await page.evaluate(() => globalThis.__spike.setMode('greedy'))
  await sleep(1200)
  await page.screenshot({ path: `${OUT}/spike-colliders.png` })

  // T81/T82: burst spawn, verify 1:1 mesh↔body (V15) + no NaN drift
  await page.evaluate(() => globalThis.__spike.burst(24))
  await sleep(2500)
  const burst = await page.evaluate(() => {
    const s = globalThis.__spike
    const dyn = s.phys.dynamics.length
    const meshes = s.meshes.size
    let nan = 0
    for (const h of s.phys.dynamics) {
      const p = h.position()
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) nan++
    }
    return { dyn, meshes, nan, oneToOne: dyn === meshes }
  })
  console.log('BURST:', JSON.stringify(burst))
  await page.screenshot({ path: `${OUT}/spike-burst.png` })

  const hud = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '')
  const spike = await page.evaluate(() => {
    const s = globalThis.__spike
    if (!s) return null
    return {
      dyn: s.phys.dynamics.length,
      staticCount: s.phys.staticColliderCount,
      totalSolid: s.totalSolid,
      clusters: s.level.length,
      firstBoxY: s.phys.dynamics[0]?.position().y ?? null,
    }
  })

  await page.screenshot({ path: `${OUT}/spike-boot.png` })
  console.log('HUD:', JSON.stringify(hud))
  console.log('SPIKE:', JSON.stringify(spike))
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
} catch (e) {
  console.error('FAIL:', e?.message ?? e)
} finally {
  await browser?.close().catch(() => {})
  vite.kill('SIGTERM')
  await sleep(400)
  process.exit(0)
}
