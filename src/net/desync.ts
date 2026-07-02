/**
 * T27 — desync detector (V10). Every `interval` ticks each peer computes
 * hashSim and sends it to the host; the host compares all hashes for that
 * checkpoint tick. On mismatch it broadcasts a desync notice to every peer
 * and raises the event locally. Failure is LOUD: if no handler is wired,
 * the detector throws — the integrator must wire onDesync to a fullscreen
 * error overlay (see INTEGRATION-net.md).
 *
 * Read-only with respect to the sim (V1/V6): computes hashes, never mutates.
 */
import type { Sim } from '../sim/loop'
import { hashSim } from '../sim/hash'
import type { Channel, Wire } from './channel'

export const DEFAULT_HASH_INTERVAL = 30 // ticks (~0.5s at 60Hz)

export interface DesyncEvent {
  tick: number
  /** all reported hashes for the checkpoint, playerId → hash */
  hashes: { playerId: number; hash: number }[]
}

interface HashMsg {
  t: 'dd/hash'
  playerId: number
  tick: number
  hash: number
}

interface DesyncMsg {
  t: 'dd/desync'
  tick: number
  hashes: { playerId: number; hash: number }[]
}

function parseDesync(raw: Wire): HashMsg | DesyncMsg | null {
  if (typeof raw !== 'string') return null
  const msg = JSON.parse(raw) as { t?: unknown }
  if (typeof msg.t !== 'string' || !msg.t.startsWith('dd/')) return null
  if (msg.t !== 'dd/hash' && msg.t !== 'dd/desync') {
    throw new Error(`desync: unknown message type '${msg.t}'`) // V10
  }
  return msg as HashMsg | DesyncMsg
}

function fire(handlers: ((e: DesyncEvent) => void)[], e: DesyncEvent): void {
  if (handlers.length === 0) {
    // V10: an unwired detector must never fail silently
    throw new Error(
      `DESYNC at tick ${e.tick}: peers disagree on sim state (${e.hashes
        .map((h) => `p${h.playerId}=${h.hash.toString(16)}`)
        .join(', ')}). No onDesync handler wired — surface this to the user.`,
    )
  }
  for (const cb of handlers) cb(e)
}

/**
 * Client-side reporter. Call afterStep() after every sim step (e.g. via
 * LockstepNode.onStep). Listens for the host's desync broadcast.
 */
export class DesyncReporter {
  private readonly handlers: ((e: DesyncEvent) => void)[] = []

  constructor(
    private readonly sim: Sim,
    private readonly playerId: number,
    private readonly channel: Channel,
    readonly interval: number = DEFAULT_HASH_INTERVAL,
  ) {
    channel.onMessage((raw) => {
      const msg = parseDesync(raw)
      if (!msg) return
      if (msg.t !== 'dd/desync') throw new Error(`desync reporter: unexpected '${msg.t}' from host`) // V10
      fire(this.handlers, { tick: msg.tick, hashes: msg.hashes })
    })
  }

  /** V10: wire this to the UI error overlay */
  onDesync(cb: (e: DesyncEvent) => void): void {
    this.handlers.push(cb)
  }

  afterStep(): void {
    if (this.sim.tick % this.interval !== 0) return
    const msg: HashMsg = { t: 'dd/hash', playerId: this.playerId, tick: this.sim.tick, hash: hashSim(this.sim) }
    this.channel.send(JSON.stringify(msg))
  }
}

/**
 * Host-side detector. Owns the host's own hash reporting (afterStep) and
 * collects peers' hashes. All players agree ⇒ checkpoint verified; any
 * mismatch ⇒ broadcast + local event.
 */
export class DesyncDetectorHost {
  /** last checkpoint tick where all peers agreed — for UI ("sync ok @ tick N") */
  lastVerifiedTick = -1

  private readonly handlers: ((e: DesyncEvent) => void)[] = []
  private readonly peers: { playerId: number; channel: Channel }[] = []
  private readonly playerIds = new Set<number>()
  /** checkpoint tick -> playerId -> hash */
  private readonly pending = new Map<number, Map<number, number>>()

  constructor(
    private readonly sim: Sim,
    private readonly hostPlayerId = 1,
    readonly interval: number = DEFAULT_HASH_INTERVAL,
  ) {
    this.playerIds.add(hostPlayerId)
  }

  addPeer(playerId: number, channel: Channel): void {
    if (this.playerIds.has(playerId)) throw new Error(`desync: duplicate playerId ${playerId}`)
    this.playerIds.add(playerId)
    this.peers.push({ playerId, channel })
    channel.onMessage((raw) => {
      const msg = parseDesync(raw)
      if (!msg) return
      if (msg.t !== 'dd/hash') throw new Error(`desync host: unexpected '${msg.t}' from peer`) // V10
      if (msg.playerId !== playerId) throw new Error(`desync host: peer ${playerId} reported as ${msg.playerId}`) // V10
      this.record(msg.playerId, msg.tick, msg.hash)
    })
  }

  /** V10: wire this to the UI error overlay */
  onDesync(cb: (e: DesyncEvent) => void): void {
    this.handlers.push(cb)
  }

  /** call after every host sim step (e.g. via LockstepNode.onStep) */
  afterStep(): void {
    if (this.sim.tick % this.interval !== 0) return
    this.record(this.hostPlayerId, this.sim.tick, hashSim(this.sim))
  }

  private record(playerId: number, tick: number, hash: number): void {
    let checkpoint = this.pending.get(tick)
    if (!checkpoint) {
      checkpoint = new Map()
      this.pending.set(tick, checkpoint)
    }
    checkpoint.set(playerId, hash)
    if (checkpoint.size < this.playerIds.size) return

    this.pending.delete(tick)
    const hashes = [...checkpoint.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pid, h]) => ({ playerId: pid, hash: h }))
    const agreed = hashes.every((h) => h.hash === hashes[0].hash)
    if (agreed) {
      if (tick > this.lastVerifiedTick) this.lastVerifiedTick = tick
      return
    }

    // V10: LOUD. Broadcast to every peer, then raise locally.
    const notice: DesyncMsg = { t: 'dd/desync', tick, hashes }
    const raw = JSON.stringify(notice)
    for (const peer of this.peers) peer.channel.send(raw)
    fire(this.handlers, { tick, hashes })
  }
}
