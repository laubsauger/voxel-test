/**
 * T24/T25 — transport abstraction. All core net logic (lockstep, desync,
 * snapshot framing) speaks only this interface. WebRTC specifics live in a
 * thin adapter (signaling.ts) that unit tests never import — tests use
 * MockChannel pairs (RTCPeerConnection does not exist in the vitest node env).
 */

export type Wire = string | ArrayBuffer

export interface Channel {
  send(msg: Wire): void
  /** register a listener; multiple listeners allowed (lockstep + desync share a channel) */
  onMessage(cb: (msg: Wire) => void): void
}

/**
 * In-memory channel endpoint for tests. FIFO, reliable, ordered — same
 * contract as a reliable-ordered RTCDataChannel. Delivery is synchronous
 * unless the *receiving* endpoint is paused (stall/latency simulation).
 */
export class MockChannel implements Channel {
  private peer!: MockChannel
  private readonly listeners: ((msg: Wire) => void)[] = []
  private readonly inbox: Wire[] = []
  private paused = false
  /** V10: loud failure if a single message exceeds this (DataChannel budget) */
  maxBytes = Infinity
  sentCount = 0

  static pair(): [MockChannel, MockChannel] {
    const a = new MockChannel()
    const b = new MockChannel()
    a.peer = b
    b.peer = a
    return [a, b]
  }

  send(msg: Wire): void {
    const size = typeof msg === 'string' ? msg.length : msg.byteLength
    if (size > this.maxBytes) {
      throw new Error(`MockChannel: message of ${size}B exceeds limit ${this.maxBytes}B`)
    }
    this.sentCount++
    this.peer.inbox.push(msg)
    this.peer.drain()
  }

  onMessage(cb: (msg: Wire) => void): void {
    this.listeners.push(cb)
  }

  /** stop delivering inbound messages (they queue) — simulates a stalled link */
  pause(): void {
    this.paused = true
  }

  /** resume delivery, flushing everything queued while paused */
  resume(): void {
    this.paused = false
    this.drain()
  }

  private drain(): void {
    while (!this.paused && this.inbox.length > 0) {
      const msg = this.inbox.shift()!
      for (const cb of this.listeners) cb(msg)
    }
  }
}
