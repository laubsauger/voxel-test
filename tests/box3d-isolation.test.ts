/**
 * V14 — the Box3D spike is an ISOLATED eval sandbox. It must never couple to the
 * shipping game's authoritative systems: no Jolt physics, no sim command/tick
 * stream, no networking/lockstep, no determinism hash. If any spike source grows
 * such an import, the spike could perturb (or be perturbed by) the real game and
 * the isolation guarantee is gone. This test reads every src/spike/** source and
 * fails loud on a forbidden import specifier.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SPIKE_DIR = new URL('../src/spike', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

// forbidden import substrings — any of these appearing in an import specifier
// means the spike reached into the game's authoritative sim/net/physics layer.
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /jolt-physics/, why: 'Jolt physics — spike uses Box3D only (V14)' },
  { pattern: /['"][^'"]*sim\/physics['"]/, why: 'sim Jolt integration (V14)' },
  { pattern: /['"][^'"]*\/net\//, why: 'networking/lockstep — spike is not MP (V14)' },
  { pattern: /['"][^'"]*\/lockstep['"]/, why: 'lockstep transport (V14)' },
  { pattern: /combined-hash|\bcombinedHash\b/, why: 'determinism hash (V14)' },
  { pattern: /['"][^'"]*\/game['"]/, why: 'the shipping Game orchestrator (V14)' },
]

// import specifiers the spike is explicitly allowed to reuse (render primitives).
const IMPORT_RE = /import[^'"]*['"]([^'"]+)['"]/g

describe('V14 — Box3D spike isolation', () => {
  const files = sourceFiles(SPIKE_DIR).filter((f) => !f.endsWith('.d.ts'))

  it('has spike source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file.split('/src/')[1]} imports nothing forbidden`, () => {
      const src = readFileSync(file, 'utf8')
      const specifiers: string[] = []
      for (const m of src.matchAll(IMPORT_RE)) specifiers.push(m[1])
      for (const spec of specifiers) {
        for (const { pattern, why } of FORBIDDEN) {
          expect(pattern.test(`'${spec}'`), `${file} imports '${spec}' — ${why}`).toBe(false)
        }
      }
    })
  }

})
