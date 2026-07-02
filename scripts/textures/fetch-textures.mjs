#!/usr/bin/env node
/**
 * T29 — fetch CC0 PBR texture sets from ambientcg.com and process them into
 * public/textures/<mat>/{albedo,normal,roughness,ao}.jpg for the runtime
 * texture-array builder (src/render/texture-arrays.ts).
 *
 * Idempotent: a material dir that already has all its expected maps is
 * skipped. No npm deps — plain fetch + system `unzip` via child_process.
 * Zips land in a temp dir and are NOT committed; only processed jpgs are.
 *
 * Usage: node scripts/textures/fetch-textures.mjs [--force]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'public', 'textures')
const FORCE = process.argv.includes('--force')

/**
 * material name (== dir name, == I.mat name in src/sim/materials.ts) →
 * ambientcg asset id. 1K-JPG variant. All CC0.
 */
const SETS = {
  dirt: 'Ground047',
  grass: 'Grass001',
  asphalt: 'Asphalt010',
  concrete: 'Concrete034',
  brick: 'Bricks059',
  wood: 'Planks012',
  plaster: 'Plaster001',
  metal: 'Metal032',
  rooftile: 'RoofingTiles013A',
}

/** ambientcg map suffix → our output name. AO is optional per asset. */
const MAPS = [
  { suffix: 'Color', out: 'albedo.jpg', required: true },
  { suffix: 'NormalGL', out: 'normal.jpg', required: true },
  { suffix: 'Roughness', out: 'roughness.jpg', required: true },
  { suffix: 'AmbientOcclusion', out: 'ao.jpg', required: false },
]

const findFile = (dir, suffix) => {
  for (const f of readdirSync(dir, { recursive: true })) {
    if (String(f).endsWith(`_${suffix}.jpg`)) return join(dir, String(f))
  }
  return null
}

/**
 * Recompress a jpg in place (payload budget <25MB; ambientcg 1K jpgs ship
 * near-lossless ~2MB normals). Uses macOS `sips`; skipped when unavailable —
 * budget check at the end still fails loud if the payload lands oversize.
 */
const recompress = (file, quality) => {
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), file, '--out', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let failures = 0
const attribution = []

for (const [mat, assetId] of Object.entries(SETS)) {
  const matDir = join(OUT, mat)
  const have = MAPS.filter((m) => m.required).every((m) => existsSync(join(matDir, m.out)))
  attribution.push({ mat, assetId })
  if (have && !FORCE) {
    console.log(`[textures] ${mat} (${assetId}) — already present, skipping`)
    continue
  }

  const url = `https://ambientcg.com/get?file=${assetId}_1K-JPG.zip`
  console.log(`[textures] ${mat} ← ${url}`)
  const tmp = mkdtempSync(join(tmpdir(), `acg-${assetId}-`))
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const zipPath = join(tmp, `${assetId}.zip`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', tmp])

    mkdirSync(matDir, { recursive: true })
    for (const m of MAPS) {
      const src = findFile(tmp, m.suffix)
      if (!src) {
        if (m.required) throw new Error(`${assetId}: missing ${m.suffix} map in zip`)
        console.log(`[textures]   ${mat}: no ${m.suffix} map (ok, optional)`)
        continue
      }
      const dst = join(matDir, m.out)
      cpSync(src, dst)
      // albedo keeps more quality; data maps (normal/rough/ao) compress harder
      const squeezed = recompress(dst, m.out === 'albedo.jpg' ? 78 : 70)
      const kb = (statSync(dst).size / 1024).toFixed(0)
      console.log(`[textures]   ${m.out} ${kb} KB${squeezed ? '' : ' (sips unavailable, uncompressed)'}`)
    }
  } catch (e) {
    failures++
    console.error(`[textures] FAIL ${mat} (${assetId}): ${e.message}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// license/provenance note (CC0 — attribution optional but classy)
mkdirSync(OUT, { recursive: true })
writeFileSync(
  join(OUT, 'ATTRIBUTION.md'),
  `# Texture attribution

PBR texture sets from [ambientCG](https://ambientcg.com), licensed under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
(public domain — attribution not required, given gladly).

Downloaded at 1K JPG resolution via \`scripts/textures/fetch-textures.mjs\`
and renamed to \`{albedo,normal,roughness,ao}.jpg\` per material
(normal maps are the OpenGL-convention \`NormalGL\` variant).

| material (I.mat name) | ambientCG asset |
|---|---|
${attribution.map(({ mat, assetId }) => `| ${mat} | [${assetId}](https://ambientcg.com/view?id=${assetId}) |`).join('\n')}
`,
)

const total = readdirSync(OUT, { recursive: true })
  .map((f) => join(OUT, String(f)))
  .filter((f) => statSync(f).isFile())
  .reduce((a, f) => a + statSync(f).size, 0)
console.log(`[textures] total payload ${(total / 1024 / 1024).toFixed(1)} MB`)

if (total > 25 * 1024 * 1024) {
  failures++
  console.error('[textures] FAIL: payload exceeds the 25MB budget (T29)')
}
if (failures > 0) {
  console.error(`[textures] ${failures} set(s) failed`)
  process.exit(1)
}
console.log('[textures] done')
