import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// V2: Math.random / Date.now / performance.now are banned in sim code.
// Static scan — catches violations any track agent might introduce.
const SIM_DIRS = ['src/sim', 'src/world']
const BANNED = [/Math\.random/, /Date\.now/, /performance\.now/, /new Date\(\)/]

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
}

describe('sim purity (V2)', () => {
  for (const dir of SIM_DIRS) {
    it(`${dir} contains no wall-clock or Math.random`, () => {
      for (const file of tsFiles(dir)) {
        const src = readFileSync(file, 'utf8')
        for (const pattern of BANNED) {
          expect(src, `${file} violates V2: ${pattern}`).not.toMatch(pattern)
        }
      }
    })
  }
})
