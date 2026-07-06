// CPU profile at spawn — attribute the frame-time to JS functions (CDP Profiler).
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT ?? 5300 + (process.pid % 500))
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('vite timeout')), 20000); vite.stdout.on('data', d => String(d).includes('Local:') && (clearTimeout(t), res())) })
const sleep = ms => new Promise(r=>setTimeout(r,ms))
let browser
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ['--enable-unsafe-webgpu','--enable-features=WebGPU','--use-angle=metal','--no-first-run','--window-size=1920,1080'], defaultViewport: null })
  const page = (await browser.pages())[0] ?? await browser.newPage()
  await page.goto(`http://localhost:${PORT}/?boot=game&seed=1337`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  process.stdout.write(`viewport ${JSON.stringify(await page.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})))}\n`)
  // wait for spawn bubble meshed
  for (let i=0;i<80;i++){ await sleep(1000); const h=await page.evaluate(()=>document.getElementById('hud')?.textContent??'').catch(()=>''); const m=h.match(/pending (\d+)/); if(m && +m[1]===0){ process.stdout.write(`settled: ${h}\n`); break } }
  await sleep(2000)
  const client = await page.target().createCDPSession()
  await client.send('Profiler.enable')
  await client.send('Profiler.setSamplingInterval', { interval: 200 }) // 200us
  await client.send('Profiler.start')
  await sleep(5000) // profile 5s of steady state
  const { profile } = await client.send('Profiler.stop')
  // aggregate self time per (functionName@url:line)
  const nodes = new Map(profile.nodes.map(n=>[n.id, n]))
  const self = new Map()
  const dt = profile.timeDeltas, samples = profile.samples
  for (let i=0;i<samples.length;i++){ const n = nodes.get(samples[i]); if(!n) continue; const cf=n.callFrame; const key = `${cf.functionName||'(anon)'} ${cf.url.split('/').slice(-1)[0]}:${cf.lineNumber}`; self.set(key, (self.get(key)||0) + (dt[i]||0)) }
  const total = [...self.values()].reduce((a,b)=>a+b,0)
  const top = [...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,22)
  process.stdout.write(`\n=== CPU self-time over ${(total/1000).toFixed(0)}ms sampled (top functions) ===\n`)
  for (const [k,v] of top) process.stdout.write(`${(v/1000).toFixed(1).padStart(7)}ms ${(100*v/total).toFixed(1).padStart(5)}%  ${k}\n`)
  const hud = await page.evaluate(()=>document.getElementById('hud')?.textContent??'').catch(()=>'')
  process.stdout.write(`\nHUD: ${hud}\n`)
} catch(e){ process.stdout.write('ERR '+e.message+'\n') } finally { await browser?.close().catch(()=>{}); vite.kill() }
