/**
 * T31 — I.boot: URL params → boot config. Pure function (unit-tested).
 *
 * `?boot=game&seed=N` skips the menu straight into gameplay — this is the
 * agent/CDP smoke path. `?dev=1` enables the dev/profiling overlay.
 * Default (no params): preloader → menu.
 */

export const DEFAULT_SEED = 1337

export interface BootConfig {
  mode: 'menu' | 'game'
  seed: number
  dev: boolean
}

export function parseBootParams(search: string): BootConfig {
  const params = new URLSearchParams(search)
  const rawSeed = Number(params.get('seed') ?? DEFAULT_SEED)
  const seed = (Number.isFinite(rawSeed) ? rawSeed : DEFAULT_SEED) >>> 0
  return {
    mode: params.get('boot') === 'game' ? 'game' : 'menu',
    seed,
    dev: params.get('dev') === '1',
  }
}

/** boot URL for the current config — dev settings' "copy boot URL" */
export function bootUrl(origin: string, cfg: BootConfig): string {
  const p = new URLSearchParams()
  p.set('boot', 'game')
  p.set('seed', String(cfg.seed))
  if (cfg.dev) p.set('dev', '1')
  return `${origin}/?${p.toString()}`
}
