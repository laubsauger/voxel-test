/**
 * T26 — chunked transfer framing. RTCDataChannel messages should stay ≤16KB
 * for cross-browser reliability; snapshots are bigger. A transfer is split
 * into frames, each: u32 transferId, u32 frameIndex, u32 frameCount, payload.
 * Frames are binary (ArrayBuffer) — string traffic on the same channel
 * (lockstep/desync JSON) passes through untouched.
 */

export const MAX_FRAME_BYTES = 16 * 1024
const HEADER_BYTES = 12

/** split a payload into frames, each ≤ maxFrame bytes including header */
export function frameTransfer(payload: ArrayBuffer, transferId: number, maxFrame: number = MAX_FRAME_BYTES): ArrayBuffer[] {
  const body = maxFrame - HEADER_BYTES
  if (body <= 0) throw new Error(`framing: maxFrame ${maxFrame}B leaves no payload room`)
  const src = new Uint8Array(payload)
  const count = Math.max(1, Math.ceil(src.length / body))
  const frames: ArrayBuffer[] = []
  for (let i = 0; i < count; i++) {
    const slice = src.subarray(i * body, Math.min((i + 1) * body, src.length))
    const frame = new ArrayBuffer(HEADER_BYTES + slice.length)
    const view = new DataView(frame)
    view.setUint32(0, transferId, true)
    view.setUint32(4, i, true)
    view.setUint32(8, count, true)
    new Uint8Array(frame, HEADER_BYTES).set(slice)
    frames.push(frame)
  }
  return frames
}

interface PendingTransfer {
  count: number
  parts: (Uint8Array | null)[]
  received: number
}

/** reassembles frames (tolerates interleaved transfers and reordering) */
export class FrameAssembler {
  private readonly pending = new Map<number, PendingTransfer>()

  /** feed one frame; returns the full payload when a transfer completes, else null */
  push(frame: ArrayBuffer): ArrayBuffer | null {
    if (frame.byteLength < HEADER_BYTES) throw new Error(`framing: frame of ${frame.byteLength}B is too short`) // V10
    const view = new DataView(frame)
    const transferId = view.getUint32(0, true)
    const index = view.getUint32(4, true)
    const count = view.getUint32(8, true)

    let t = this.pending.get(transferId)
    if (!t) {
      t = { count, parts: new Array<Uint8Array | null>(count).fill(null), received: 0 }
      this.pending.set(transferId, t)
    }
    if (count !== t.count) throw new Error(`framing: transfer ${transferId} frameCount mismatch (${count} vs ${t.count})`) // V10
    if (index >= t.count) throw new Error(`framing: transfer ${transferId} frame index ${index} out of range`) // V10
    if (t.parts[index] !== null) throw new Error(`framing: transfer ${transferId} duplicate frame ${index}`) // V10

    t.parts[index] = new Uint8Array(frame, HEADER_BYTES).slice()
    t.received++
    if (t.received < t.count) return null

    this.pending.delete(transferId)
    let total = 0
    for (const p of t.parts) total += p!.length
    const out = new Uint8Array(total)
    let o = 0
    for (const p of t.parts) {
      out.set(p!, o)
      o += p!.length
    }
    return out.buffer
  }
}
