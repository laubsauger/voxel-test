/**
 * T31 — I.boot: URL params → boot config. Pure function (unit-tested).
 *
 * `?boot=game&seed=N` skips the menu straight into gameplay — this is the
 * agent/CDP smoke path. `?dev=1` enables the dev/profiling overlay.
 * Default (no params): preloader → menu.
 */

export const DEFAULT_SEED = 1337
/** T71 — default signaling server (npm run signal listens here) */
export const DEFAULT_SIGNAL_URL = 'ws://localhost:8081'

export interface BootConfig {
  mode: 'menu' | 'game'
  seed: number
  dev: boolean
  /** T71 — signaling server URL for HOST/JOIN (I.net); `?signal=ws://...` */
  signalUrl: string
  /**
   * T72 — session transport. 'rtc' (default) = WebRTC DataChannel.
   * 'ws' = relay through the signaling server — transport-isolation
   * debugging for automated tests (`npm run mp-e2e -- --ws`), never for
   * real sessions.
   */
  transport: 'rtc' | 'ws'
}

export function parseBootParams(search: string): BootConfig {
  const params = new URLSearchParams(search)
  const rawSeed = Number(params.get('seed') ?? DEFAULT_SEED)
  const seed = (Number.isFinite(rawSeed) ? rawSeed : DEFAULT_SEED) >>> 0
  return {
    mode: params.get('boot') === 'game' ? 'game' : 'menu',
    seed,
    dev: params.get('dev') === '1',
    signalUrl: params.get('signal') ?? DEFAULT_SIGNAL_URL,
    transport: params.get('transport') === 'ws' ? 'ws' : 'rtc',
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
