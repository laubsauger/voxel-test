/**
 * T25 — deterministic lockstep transport (V2, V3).
 *
 * Model: star, host relays and orders. Each peer, when stepping local tick T,
 * sends its local ops stamped for tick T+inputDelay to the host. The host
 * releases tick bundles strictly in order, and only once EVERY player's input
 * for that tick has arrived — including empty inputs, so every tick is
 * explicitly released. Peers advance their Sim ONLY when the bundle for
 * sim.tick is present (tick barrier). No bundle → no step → no drift.
 *
 * Transport-agnostic: everything here speaks Channel (channel.ts). The
 * WebRTC adapter is thin and lives in signaling.ts, excluded from unit tests.
 *
 * V1: this layer never mutates sim state — it only feeds sim.queue and calls
 * sim.step().
 */
import type { Command, Op } from '../sim/commands'
import type { Sim } from '../sim/loop'
import { TICK_MS } from '../sim/loop'
import type { Channel, Wire } from './channel'

export const DEFAULT_INPUT_DELAY = 3 // ticks (~50ms at 60Hz) — hides co-op RTT

export interface InputMsg {
  t: 'ls/input'
  playerId: number
  tick: number
  cmds: Command[]
}

export interface BundleMsg {
  t: 'ls/bundle'
  tick: number
  cmds: Command[]
  /**
   * T71 — players the host dropped effective THIS tick (stall timeout / peer
   * loss). From this tick on their inputs are empty on every peer identically
   * (empty-input substitution). Announced in the bundle so the substitution is
   * part of the ordered command stream — deterministic on all peers.
   */
  dropped?: number[]
}

/** parse a wire message if it belongs to the lockstep protocol, else null */
function parseLockstep(raw: Wire): InputMsg | BundleMsg | null {
  if (typeof raw !== 'string') return null // binary traffic = snapshot frames, not ours
  const msg = JSON.parse(raw) as { t?: unknown }
  if (typeof msg.t !== 'string' || !msg.t.startsWith('ls/')) return null
  if (msg.t !== 'ls/input' && msg.t !== 'ls/bundle') {
    throw new Error(`lockstep: unknown message type '${msg.t}'`) // V10
  }
  return msg as InputMsg | BundleMsg
}

/**
 * Per-peer stepping core (host and clients both own one). Holds released
 * bundles, local pending ops, and enforces the tick barrier.
 */
export class LockstepNode {
  private readonly pending: Op[] = []
  private seq = 0
  private readonly bundles = new Map<number, Command[]>()
  private readonly stepHooks: ((sim: Sim) => void)[] = []
  private readonly dropHooks: ((playerId: number, tick: number) => void)[] = []

  constructor(
    readonly sim: Sim,
    readonly playerId: number,
    private readonly sendInput: (msg: InputMsg) => void,
    readonly inputDelay: number = DEFAULT_INPUT_DELAY,
  ) {
    if (inputDelay < 1) throw new Error('lockstep: inputDelay must be >= 1')
  }

  /** queue a local op; it ships with the next step, applying at tick+inputDelay everywhere */
  submitLocal(op: Op): void {
    this.pending.push(op)
  }

  /** hook invoked after every successful sim step (desync reporting, render sync) */
  onStep(hook: (sim: Sim) => void): void {
    this.stepHooks.push(hook)
  }

  /** T71 — host announced a player drop (empty-input substitution). UI hook. */
  onPlayerDropped(hook: (playerId: number, tick: number) => void): void {
    this.dropHooks.push(hook)
  }

  receiveBundle(msg: BundleMsg): void {
    if (msg.tick < this.sim.tick || this.bundles.has(msg.tick)) {
      // V10: a re-released tick means host/protocol corruption — never ignore
      throw new Error(`lockstep: duplicate or stale bundle for tick ${msg.tick} (sim at ${this.sim.tick})`)
    }
    this.bundles.set(msg.tick, msg.cmds)
    if (msg.dropped) for (const pid of msg.dropped) for (const hook of this.dropHooks) hook(pid, msg.tick)
  }

  /** true when the barrier for the current tick is open */
  get canStep(): boolean {
    return this.bundles.has(this.sim.tick)
  }

  /**
   * Advance exactly one tick if its bundle has arrived. Returns false at the
   * tick barrier (bundle missing) — the sim then simply waits; ticks, not
   * wall time, are authoritative (V2).
   */
  tryStep(): boolean {
    const tick = this.sim.tick
    const cmds = this.bundles.get(tick)
    if (!cmds) return false // tick barrier
    this.bundles.delete(tick)

    // ship local input for the future tick — sent EVERY step, even when empty,
    // so the host can release every tick explicitly
    const target = tick + this.inputDelay
    const stamped: Command[] = this.pending.map((op) => ({
      tick: target,
      playerId: this.playerId,
      seq: this.seq++,
      op,
    }))
    this.pending.length = 0
    this.sendInput({ t: 'ls/input', playerId: this.playerId, tick: target, cmds: stamped })

    for (const c of cmds) this.sim.queue.push(c) // V1: transport only feeds the queue
    this.sim.step()
    for (const hook of this.stepHooks) hook(this.sim)
    return true
  }
}

/**
 * Host role: collects every player's input per tick, releases ordered bundles
 * to all peers (and to its own node). The host is also a player.
 */
export class LockstepHost {
  readonly node: LockstepNode
  private peers: { playerId: number; channel: Channel }[] = []
  private readonly playerIds = new Set<number>()
  /** T71 — players dropped mid-session (stall timeout); their late traffic is ignored */
  private readonly droppedIds = new Set<number>()
  /** drops not yet announced in a released bundle */
  private pendingDropAnnounce: number[] = []
  /** tick -> playerId -> stamped commands */
  private readonly collectors = new Map<number, Map<number, Command[]>>()
  private nextRelease = 0
  private started = false

  constructor(sim: Sim, hostPlayerId = 1, inputDelay: number = DEFAULT_INPUT_DELAY) {
    this.playerIds.add(hostPlayerId)
    this.node = new LockstepNode(sim, hostPlayerId, (msg) => this.receiveInput(msg), inputDelay)
  }

  /** register a peer before start(). Late join needs the snapshot flow (T26). */
  addPeer(playerId: number, channel: Channel): void {
    if (this.started) throw new Error('lockstep host: addPeer after start — late join requires snapshot transfer')
    if (this.playerIds.has(playerId)) throw new Error(`lockstep host: duplicate playerId ${playerId}`)
    this.playerIds.add(playerId)
    this.peers.push({ playerId, channel })
    channel.onMessage((raw) => {
      if (this.droppedIds.has(playerId)) return // T71: dropped peer, late traffic is void
      const msg = parseLockstep(raw)
      if (!msg) return
      if (msg.t !== 'ls/input') throw new Error(`lockstep host: unexpected '${msg.t}' from peer`) // V10
      if (msg.playerId !== playerId) {
        throw new Error(`lockstep host: peer ${playerId} sent input claiming playerId ${msg.playerId}`) // V10
      }
      this.receiveInput(msg)
    })
  }

  /**
   * T71 — drop a stalled/disconnected player mid-session. Deterministic
   * empty-input substitution: the host stops waiting for (and discards any
   * buffered) input from that player, so every bundle from the next released
   * tick on simply carries no commands for them — identical on all peers.
   * The drop is announced in that bundle (BundleMsg.dropped).
   */
  dropPlayer(playerId: number): void {
    if (playerId === this.node.playerId) throw new Error('lockstep host: cannot drop the host')
    if (!this.playerIds.has(playerId) || this.droppedIds.has(playerId)) return
    this.playerIds.delete(playerId)
    this.droppedIds.add(playerId)
    this.peers = this.peers.filter((p) => p.playerId !== playerId)
    for (const collector of this.collectors.values()) collector.delete(playerId)
    this.pendingDropAnnounce.push(playerId)
    this.tryRelease()
  }

  /**
   * T71 — stall introspection for the waiting-banner UX: players whose input
   * for the next unreleased tick hasn't arrived. Empty while flowing.
   */
  waitingOn(): number[] {
    if (!this.started) return []
    const collector = this.collectors.get(this.nextRelease)
    return [...this.playerIds].filter((pid) => !collector?.has(pid)).sort((a, b) => a - b)
  }

  /**
   * Open the session: the first `inputDelay` ticks have no possible input
   * (nobody has stepped yet), so they are released empty immediately.
   */
  start(): void {
    if (this.started) throw new Error('lockstep host: start() called twice')
    this.started = true
    for (let t = 0; t < this.node.inputDelay; t++) this.release(t, [])
    this.tryRelease()
  }

  private receiveInput(msg: InputMsg): void {
    if (!this.playerIds.has(msg.playerId)) {
      throw new Error(`lockstep host: input from unknown playerId ${msg.playerId}`) // V10
    }
    if (this.started && msg.tick < this.nextRelease) {
      throw new Error(`lockstep host: input for already-released tick ${msg.tick}`) // V10
    }
    let collector = this.collectors.get(msg.tick)
    if (!collector) {
      collector = new Map()
      this.collectors.set(msg.tick, collector)
    }
    if (collector.has(msg.playerId)) {
      throw new Error(`lockstep host: duplicate input from player ${msg.playerId} for tick ${msg.tick}`) // V10
    }
    collector.set(msg.playerId, msg.cmds)
    this.tryRelease()
  }

  /** release ticks strictly in order, only when every player's input arrived */
  private tryRelease(): void {
    if (!this.started) return
    for (;;) {
      const collector = this.collectors.get(this.nextRelease)
      if (!collector || collector.size < this.playerIds.size) return
      this.collectors.delete(this.nextRelease)
      const cmds = [...collector.values()]
        .flat()
        .sort((a, b) => a.playerId - b.playerId || a.seq - b.seq)
      this.release(this.nextRelease, cmds)
    }
  }

  private release(tick: number, cmds: Command[]): void {
    const msg: BundleMsg = { t: 'ls/bundle', tick, cmds }
    if (this.pendingDropAnnounce.length > 0) {
      msg.dropped = this.pendingDropAnnounce
      this.pendingDropAnnounce = []
    }
    const raw = JSON.stringify(msg)
    for (const peer of this.peers) peer.channel.send(raw)
    this.node.receiveBundle(msg)
    this.nextRelease = tick + 1
  }
}

/** Client role: sends inputs to the host, receives ordered bundles. */
export class LockstepClient {
  readonly node: LockstepNode

  constructor(sim: Sim, playerId: number, channel: Channel, inputDelay: number = DEFAULT_INPUT_DELAY) {
    this.node = new LockstepNode(sim, playerId, (msg) => channel.send(JSON.stringify(msg)), inputDelay)
    channel.onMessage((raw) => {
      const msg = parseLockstep(raw)
      if (!msg) return
      if (msg.t !== 'ls/bundle') throw new Error(`lockstep client: unexpected '${msg.t}' from host`) // V10
      this.node.receiveBundle(msg)
    })
  }
}

/**
 * Fixed-step driver for lockstep sessions (V11). Same accumulator contract as
 * sim/loop.ts FixedStepDriver, but defers to the tick barrier: when the
 * bundle for the current tick is missing, time is held (capped) instead of
 * stepping — the sim waits, it never free-runs.
 */
export class LockstepDriver {
  private accumulator = 0
  maxStepsPerAdvance = 10

  advance(elapsedMs: number, node: LockstepNode): number {
    this.accumulator += elapsedMs
    let steps = 0
    while (this.accumulator >= TICK_MS && steps < this.maxStepsPerAdvance) {
      if (!node.tryStep()) break // tick barrier — resume when the bundle lands
      this.accumulator -= TICK_MS
      steps++
    }
    // cap held time so a long stall doesn't burst on release
    const cap = TICK_MS * this.maxStepsPerAdvance
    if (this.accumulator > cap) this.accumulator = cap
    return steps
  }

  get alpha(): number {
    return Math.min(this.accumulator / TICK_MS, 1)
  }
}
