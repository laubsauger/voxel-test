import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// SECURITY (I.audio): the ElevenLabs key lives ONLY in .env.dev (gitignored)
// and is used ONLY by the offline node pipeline. It must never reach client
// code or generated artifacts. This test keeps it out forever.
//
// Patterns are built dynamically so this test file can't flag itself.
const KEY_PATTERN = new RegExp('sk_' + '[a-zA-Z0-9]{16,}')
const PROVIDER_ENV = ['ELEVEN', 'LABS'].join('') // client code must never reference the provider/env

const ROOT = path.resolve(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('API key never leaks (I.audio security)', () => {
  const srcFiles = walk(path.join(ROOT, 'src'))

  it('no secret-key pattern anywhere under src/**', () => {
    for (const f of srcFiles) {
      const text = readFileSync(f, 'latin1')
      expect(KEY_PATTERN.test(text), `key-like string in ${path.relative(ROOT, f)}`).toBe(false)
    }
  })

  it('client code (src/**/*.ts) never references the provider or its env var', () => {
    for (const f of srcFiles.filter((f) => /\.(ts|js|mjs)$/.test(f))) {
      const text = readFileSync(f, 'utf8').toUpperCase()
      expect(text.includes(PROVIDER_ENV), `provider reference in ${path.relative(ROOT, f)}`).toBe(false)
    }
  })

  it('generated manifest contains no key pattern or provider reference', () => {
    const text = readFileSync(path.join(ROOT, 'public/audio/manifest.json'), 'utf8')
    expect(KEY_PATTERN.test(text)).toBe(false)
    expect(text.toUpperCase().includes(PROVIDER_ENV)).toBe(false)
  })

  it('client audio sources fetch only local asset paths, never the API host', () => {
    for (const f of srcFiles.filter((f) => f.includes(`${path.sep}audio${path.sep}`) && f.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8')
      expect(text.includes('api.elevenlabs.io'), `API host in ${path.relative(ROOT, f)}`).toBe(false)
    }
  })
})
