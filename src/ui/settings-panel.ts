/**
 * T34 — settings screens: tabbed panel bound to the SettingsStore.
 * Every control writes through store.set → persists to localStorage and
 * notifies subscribers (main.ts wires those to live apply hooks). V6: the
 * panel never touches sim state.
 */
import { SettingsStore, type SettingsPath } from './settings-store'
import { bootUrl, type BootConfig } from './boot-params'
import type { FullscreenControl } from './fullscreen'

type TabId = 'graphics' | 'audio' | 'controls' | 'gameplay' | 'dev'

const TABS: { id: TabId; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'dev', label: 'Dev' },
]

const KEYBINDS: [string, string][] = [
  ['Move', 'W A S D'],
  ['Jump', 'Space'],
  ['Sprint', 'Shift'],
  ['Crouch', 'Ctrl / C'],
  ['Tools', '1 – 4 / Wheel'],
  ['Use tool', 'Mouse 1'],
  ['Camera fp/tp', 'V'],
  ['Fly mode', 'F'],
  ['Fly up / down', 'E / Q'],
  ['Cinematic — hide UI', 'H'],
  ['Pause', 'Esc'],
]

export class SettingsPanel {
  private readonly el: HTMLElement
  private readonly body: HTMLElement
  private readonly tabs = new Map<TabId, HTMLElement>()
  private active: TabId = 'graphics'
  /** live-state subscription of the current tab (fullscreen toggle) */
  private tabUnsub: (() => void) | null = null
  onClose: (() => void) | null = null

  constructor(
    root: HTMLElement,
    private readonly store: SettingsStore,
    private readonly boot: BootConfig,
    /** T52 — fullscreen is transient, bound live (never persisted) */
    private readonly fullscreen?: FullscreenControl,
  ) {
    this.el = document.createElement('div')
    this.el.className = 'bb-screen bb-settings bb-leave'
    this.el.innerHTML = `
      <div class="bb-set-panel">
        <div class="bb-set-rail">
          <div class="bb-set-rail-title">Settings</div>
          <button class="bb-set-close"><span class="bb-kbd">Esc</span> Back</button>
        </div>
        <div class="bb-set-body"></div>
      </div>`
    const rail = this.el.querySelector('.bb-set-rail')!
    const closeBtn = this.el.querySelector('.bb-set-close')!
    for (const tab of TABS) {
      const b = document.createElement('button')
      b.className = 'bb-set-tab'
      b.textContent = tab.label
      b.addEventListener('click', () => this.showTab(tab.id))
      rail.insertBefore(b, closeBtn)
      this.tabs.set(tab.id, b)
    }
    this.body = this.el.querySelector('.bb-set-body') as HTMLElement
    closeBtn.addEventListener('click', () => this.onClose?.())
    root.appendChild(this.el)
    // gfx.* dials live-apply through the renderer's __bbGfx debug handle:
    // the panel has no Game reference and main.ts wiring is preset-only.
    // store.set (persistence) happens in the control as usual; this forwards
    // the change to the live WorldRenderer when one exists.
    store.subscribe('*', (path, value) => {
      if (!path.startsWith('gfx.')) return
      const gfx = (globalThis as { __bbGfx?: { apply(p: Record<string, unknown>): void } }).__bbGfx
      gfx?.apply({ [path.slice('gfx.'.length)]: value })
    })
    this.showTab('graphics')
  }

  get visible(): boolean {
    return !this.el.classList.contains('bb-leave')
  }

  show(): void {
    this.el.classList.remove('bb-leave')
    this.showTab(this.active)
  }

  hide(): void {
    this.el.classList.add('bb-leave')
  }

  private showTab(id: TabId): void {
    this.active = id
    this.tabUnsub?.()
    this.tabUnsub = null
    for (const [tid, el] of this.tabs) el.classList.toggle('bb-active', tid === id)
    this.body.replaceChildren()
    this[id]()
  }

  // ---- controls -------------------------------------------------------------

  private row(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
    const row = document.createElement('div')
    row.className = 'bb-set-row'
    const l = document.createElement('label')
    l.textContent = label
    row.append(l, control)
    if (value) row.append(value)
    this.body.appendChild(row)
    return row
  }

  private section(title: string): void {
    const el = document.createElement('div')
    el.className = 'bb-set-section-title'
    el.textContent = title
    this.body.appendChild(el)
  }

  private seg<T extends string>(options: [T, string][], path: SettingsPath): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'bb-seg'
    const sync = () => {
      const cur = this.store.get(path) as string
      wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('bb-active', b.dataset.v === cur))
    }
    for (const [value, label] of options) {
      const b = document.createElement('button')
      b.dataset.v = value
      b.textContent = label
      b.addEventListener('click', () => {
        this.store.set(path, value as never)
        sync()
      })
      wrap.appendChild(b)
    }
    sync()
    return wrap
  }

  private slider(
    path: SettingsPath,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string = (v) => String(v),
  ): [HTMLElement, HTMLElement] {
    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'bb-slider'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    const value = document.createElement('span')
    value.className = 'bb-set-value'
    const sync = () => {
      const v = this.store.get(path) as number
      input.value = String(v)
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`)
      value.textContent = fmt(v)
    }
    input.addEventListener('input', () => {
      this.store.set(path, Number(input.value) as never)
      sync()
    })
    sync()
    return [input, value]
  }

  private toggle(path: SettingsPath): HTMLElement {
    const b = document.createElement('button')
    b.className = 'bb-toggle'
    const sync = () => b.classList.toggle('bb-on', this.store.get(path) as boolean)
    b.addEventListener('click', () => {
      this.store.set(path, !(this.store.get(path) as boolean) as never)
      sync()
    })
    sync()
    return b
  }

  // ---- tabs -----------------------------------------------------------------

  private graphics(): void {
    this.section('Presentation')
    this.row(
      'Quality preset',
      this.seg(
        [
          ['low', 'Low'],
          ['medium', 'Med'],
          ['high', 'High'],
        ],
        'graphics.quality',
      ),
    )
    const [fov, fovV] = this.slider('graphics.fov', 60, 110, 1, (v) => `${v}°`)
    this.row('Field of view', fov, fovV)
    if (this.fullscreen) {
      // live toggle bound to the real document state (transient — not persisted)
      const fs = this.fullscreen
      const b = document.createElement('button')
      b.className = 'bb-toggle'
      const sync = () => b.classList.toggle('bb-on', fs.active)
      b.addEventListener('click', () => fs.toggle())
      this.tabUnsub = fs.onChange(sync)
      sync()
      this.row('Fullscreen', b)
    }
    // ---- advanced per-pass dials (settings.gfx.*, live via __bbGfx) --------
    this.section('Advanced — per-pass dials')
    this.row('Shadows', this.toggle('gfx.shadows'))
    this.row(
      'Shadow map',
      this.seg(
        [
          ['auto', 'Auto'],
          ['1024', '1k'],
          ['2048', '2k'],
          ['4096', '4k'],
        ],
        'gfx.shadowMapSize',
      ),
    )
    this.row(
      'Cascades',
      this.seg(
        [
          ['1', '1'],
          ['2', '2'],
          ['3', '3'],
        ],
        'gfx.cascades',
      ),
    )
    this.row('Ambient occlusion', this.toggle('gfx.ao'))
    const [aoI, aoIV] = this.slider('gfx.aoIntensity', 0, 200, 5, (v) => `${v}%`)
    this.row('AO intensity', aoI, aoIV)
    const [aoR, aoRV] = this.slider('gfx.aoRadius', 25, 200, 5, (v) => `${v}%`)
    this.row('AO radius', aoR, aoRV)
    this.row('Bloom', this.toggle('gfx.bloom'))
    this.row('FXAA', this.toggle('gfx.fxaa'))
    this.row('Clouds', this.toggle('gfx.clouds'))
    const [rs, rsV] = this.slider('gfx.renderScale', 50, 200, 5, (v) => `${v}%`)
    this.row('Render scale', rs, rsV)
    this.row('Textures', this.toggle('gfx.textures'))
    const note = document.createElement('div')
    note.className = 'bb-set-section-title'
    note.textContent =
      'Preset maps resolution + shadows live · advanced dials apply live within the preset (textures on next boot)'
    this.body.appendChild(note)
  }

  private audio(): void {
    this.section('Volume')
    for (const [path, label] of [
      ['audio.master', 'Master'],
      ['audio.music', 'Music'],
      ['audio.sfx', 'Effects'],
    ] as [SettingsPath, string][]) {
      const [s, v] = this.slider(path, 0, 100, 1)
      this.row(label, s, v)
    }
    // T52 — same flag the quick-access mute buttons flip (stays consistent)
    this.row('Mute all', this.toggle('audio.muted'))
  }

  private controls(): void {
    this.section('Mouse')
    const [sens, sensV] = this.slider('controls.sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2))
    this.row('Sensitivity', sens, sensV)
    this.row('Invert Y', this.toggle('controls.invertY'))
    this.section('Keybinds')
    const grid = document.createElement('div')
    grid.className = 'bb-binds'
    for (const [action, keys] of KEYBINDS) {
      const b = document.createElement('div')
      b.className = 'bb-bind'
      b.innerHTML = `<span>${action}</span><span class="bb-kbd">${keys}</span>`
      grid.appendChild(b)
    }
    this.body.appendChild(grid)
  }

  private gameplay(): void {
    this.section('Camera')
    this.row(
      'Default view',
      this.seg(
        [
          ['fp', 'First person'],
          ['tp', 'Third person'],
        ],
        'gameplay.camera',
      ),
    )
  }

  private dev(): void {
    this.section('Profiling')
    this.row('Profiling overlay', this.toggle('dev.profiling'))
    this.section('Time of day') // T65 — drives the T58 day/night cycle live
    {
      const [input, value] = this.slider('dev.timeOfDay', -1, 24, 0.25, (v) =>
        v < 0 ? 'live cycle' : `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
      )
      this.row('Time', input, value)
      const [speed, speedVal] = this.slider('dev.cycleSpeed', 0, 8, 0.25, (v) =>
        v === 0 ? 'paused' : `${v}×`,
      )
      this.row('Cycle speed', speed, speedVal)
    }
    this.section('Scene')
    const seed = document.createElement('span')
    seed.className = 'bb-set-value'
    seed.textContent = String(this.boot.seed)
    this.row('Seed', seed)
    const copy = document.createElement('button')
    copy.className = 'bb-btn'
    copy.textContent = 'Copy boot URL'
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(bootUrl(location.origin, this.boot))
      copy.textContent = 'Copied'
      copy.classList.add('bb-flash')
      setTimeout(() => {
        copy.textContent = 'Copy boot URL'
        copy.classList.remove('bb-flash')
      }, 1200)
    })
    this.row('Boot straight to game', copy)
  }
}
