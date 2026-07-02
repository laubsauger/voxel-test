import { describe, expect, it } from 'vitest'
import { FullscreenControl, fullscreenAction, type FullscreenDoc } from '../src/ui/fullscreen'

// T52 — fullscreen is TRANSIENT browser state: the user can leave via Esc or
// F11 behind our back. WHY these tests exist: the control must never cache a
// stale flag — truth always comes from document.fullscreenElement, and every
// bound toggle re-syncs on fullscreenchange. Persisting fullscreen (or
// trusting a cached bool) would show an untruthful toggle after Esc.

class FakeDoc implements FullscreenDoc {
  fullscreenElement: unknown = null
  requests = 0
  exits = 0
  private listeners: (() => void)[] = []
  documentElement = {
    requestFullscreen: (): Promise<void> => {
      this.requests++
      this.fullscreenElement = this.documentElement
      this.fire()
      return Promise.resolve()
    },
  }
  exitFullscreen(): Promise<void> {
    this.exits++
    this.fullscreenElement = null
    this.fire()
    return Promise.resolve()
  }
  addEventListener(_type: 'fullscreenchange', fn: () => void): void {
    this.listeners.push(fn)
  }
  /** simulate the browser flipping state (Esc / F11 — no toggle() involved) */
  browserSet(el: unknown): void {
    this.fullscreenElement = el
    this.fire()
  }
  private fire(): void {
    for (const fn of this.listeners) fn()
  }
}

describe('fullscreenAction (pure)', () => {
  it('requests when inactive, exits when active', () => {
    expect(fullscreenAction(false)).toBe('request')
    expect(fullscreenAction(true)).toBe('exit')
  })
})

describe('FullscreenControl (T52 state tracking)', () => {
  it('active mirrors the live document, never a cached flag', () => {
    const doc = new FakeDoc()
    const fs = new FullscreenControl(doc)
    expect(fs.active).toBe(false)
    doc.browserSet({}) // browser entered fullscreen without us
    expect(fs.active).toBe(true)
    doc.browserSet(null) // user pressed Esc — no toggle() call
    expect(fs.active).toBe(false)
  })

  it('toggle requests fullscreen when inactive and exits when active', () => {
    const doc = new FakeDoc()
    const fs = new FullscreenControl(doc)
    fs.toggle()
    expect(doc.requests).toBe(1)
    expect(fs.active).toBe(true)
    fs.toggle()
    expect(doc.exits).toBe(1)
    expect(fs.active).toBe(false)
  })

  it('onChange fires for browser-initiated changes (toggle buttons stay truthful)', () => {
    const doc = new FakeDoc()
    const fs = new FullscreenControl(doc)
    const seen: boolean[] = []
    fs.onChange((on) => seen.push(on))
    doc.browserSet({}) // e.g. F11
    doc.browserSet(null) // e.g. Esc
    expect(seen).toEqual([true, false])
  })

  it('unsubscribe stops notifications', () => {
    const doc = new FakeDoc()
    const fs = new FullscreenControl(doc)
    const seen: boolean[] = []
    const off = fs.onChange((on) => seen.push(on))
    off()
    doc.browserSet({})
    expect(seen).toEqual([])
  })
})
