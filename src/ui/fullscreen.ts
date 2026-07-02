/**
 * T52 — fullscreen control. Fullscreen is TRANSIENT browser state (the user
 * can enter/leave via F11, Esc, OS gestures), so it is never persisted; the
 * control tracks `fullscreenchange` and every bound toggle reflects the real
 * document state instead of a stored value.
 *
 * The document surface is injected behind a minimal structural type so the
 * tracking logic unit-tests in node without a DOM.
 */

export interface FullscreenDoc {
  fullscreenElement: Element | unknown | null
  documentElement: { requestFullscreen(): Promise<void> }
  exitFullscreen(): Promise<void>
  addEventListener(type: 'fullscreenchange', fn: () => void): void
}

/** pure decision: what a toggle should do given the current live state */
export function fullscreenAction(active: boolean): 'exit' | 'request' {
  return active ? 'exit' : 'request'
}

export class FullscreenControl {
  private readonly doc: FullscreenDoc
  private readonly subs = new Set<(active: boolean) => void>()

  constructor(doc: FullscreenDoc = document as unknown as FullscreenDoc) {
    this.doc = doc
    this.doc.addEventListener('fullscreenchange', () => {
      for (const fn of this.subs) fn(this.active)
    })
  }

  /** truth comes from the document, never from a cached flag */
  get active(): boolean {
    return this.doc.fullscreenElement != null
  }

  /**
   * Toggle fullscreen. The request can be rejected (no user gesture, iframe
   * policy) — state stays truthful because we only ever read the document.
   */
  toggle(): void {
    if (fullscreenAction(this.active) === 'exit') {
      void this.doc.exitFullscreen().catch(() => {})
    } else {
      void this.doc.documentElement.requestFullscreen().catch(() => {})
    }
  }

  /** subscribe to live state changes (fires on every fullscreenchange); returns unsubscribe */
  onChange(fn: (active: boolean) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}
