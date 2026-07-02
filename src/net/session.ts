/**
 * T71 — session/lobby protocol (I.net). Sits above the WebRTC channel and
 * below the game: playerId assignment, lobby roster, synchronized session
 * start, readiness barrier, ping.
 *
 * Message namespace 'ss/*' — shares the one reliable-ordered DataChannel with
 * lockstep ('ls/*') and desync ('dd/*'); each component ignores foreign
 * traffic (INTEGRATION-net.md).
 *
 * Why a readiness barrier: Game.create takes seconds (world stamp, Jolt,
 * meshing) and DataChannelAdapter does NOT buffer for unregistered listeners.
 * If the host called LockstepHost.start() while a guest was still building
 * its Game, the first bundles would be dropped on the floor and the guest
 * would stall at tick 0 forever. So: host sends 'ss/start', every peer builds
 * its Game AND registers all lockstep/desync listeners, then reports
 * 'ss/ready'; only when every peer is ready does the host open the tick
 * stream. All logic here is transport-agnostic (MockChannel-testable).
 */
import type { Channel, Wire } from './channel'
import { DEFAULT_INPUT_DELAY } from './lockstep'

export const MAX_PLAYERS = 4 // co-op 2-4 (§G)
export const HOST_PLAYER_ID = 1

export interface SessionPlayer {
  playerId: number
  name: string
}

export interface HelloMsg {
  t: 'ss/hello'
  playerId: number
  seed: number
  inputDelay: number
}
interface LobbyMsg {
  t: 'ss/lobby'
  players: SessionPlayer[]
}
interface StartMsg {
  t: 'ss/start'
}
interface ReadyMsg {
  t: 'ss/ready'
  playerId: number
}
interface PingMsg {
  t: 'ss/ping'
  n: number
}
interface PongMsg {
  t: 'ss/pong'
  n: number
}

type SessionMsg = HelloMsg | LobbyMsg | StartMsg | ReadyMsg | PingMsg | PongMsg

const SESSION_TYPES = new Set(['ss/hello', 'ss/lobby', 'ss/start', 'ss/ready', 'ss/ping', 'ss/pong'])

function parseSession(raw: Wire): SessionMsg | null {
  if (typeof raw !== 'string') return null
  const msg = JSON.parse(raw) as { t?: unknown }
  if (typeof msg.t !== 'string' || !msg.t.startsWith('ss/')) return null
  if (!SESSION_TYPES.has(msg.t)) throw new Error(`session: unknown message type '${msg.t}'`) // V10
  return msg as SessionMsg
}

export const playerName = (playerId: number): string =>
  playerId === HOST_PLAYER_ID ? 'P1 · HOST' : `P${playerId}`

export type HostLobbyState = 'lobby' | 'starting' | 'running'

/**
 * Host-side session: owns playerId assignment (2..4, join order) and the
 * start/ready barrier. One instance per hosted session.
 */
export class HostLobby {
  state: HostLobbyState = 'lobby'
  private readonly peers: { playerId: number; channel: Channel }[] = []
  private readonly ready = new Set<number>()
  private nextPlayerId = HOST_PLAYER_ID + 1

  /** roster changed (join/leave) */
  onChange: (players: SessionPlayer[]) => void = () => {}
  /** every guest built its game and wired lockstep — host may open the tick stream */
  onAllReady: () => void = () => {}
  /** pong received (host→guest pings are symmetric; host measures per peer) */
  onPong: (playerId: number, n: number) => void = () => {}

  constructor(
    readonly seed: number,
    readonly inputDelay: number = DEFAULT_INPUT_DELAY,
  ) {}

  get players(): SessionPlayer[] {
    return [
      { playerId: HOST_PLAYER_ID, name: playerName(HOST_PLAYER_ID) },
      ...this.peers.map((p) => ({ playerId: p.playerId, name: playerName(p.playerId) })),
    ]
  }

  /** peer channels with their assigned playerIds (lockstep/desync wiring) */
  get peerChannels(): readonly { playerId: number; channel: Channel }[] {
    return this.peers
  }

  /** a WebRTC channel to a new guest is open — assign a playerId, send hello */
  addPeer(channel: Channel): number {
    if (this.state !== 'lobby') throw new Error('session host: peer joined after start (late join is deferred)')
    if (this.players.length >= MAX_PLAYERS) throw new Error('session host: room is full')
    const playerId = this.nextPlayerId++
    this.peers.push({ playerId, channel })
    channel.onMessage((raw) => {
      const msg = parseSession(raw)
      if (!msg) return
      switch (msg.t) {
        case 'ss/ready':
          if (msg.playerId !== playerId) {
            throw new Error(`session host: peer ${playerId} reported ready as ${msg.playerId}`) // V10
          }
          this.ready.add(playerId)
          if (this.state === 'starting' && this.peers.every((p) => this.ready.has(p.playerId))) {
            this.state = 'running'
            this.onAllReady()
          }
          break
        case 'ss/ping': // guest measures RTT to host — echo
          channel.send(JSON.stringify({ t: 'ss/pong', n: msg.n } satisfies PongMsg))
          break
        case 'ss/pong':
          this.onPong(playerId, msg.n)
          break
        default:
          throw new Error(`session host: unexpected '${msg.t}' from peer ${playerId}`) // V10
      }
    })
    const hello: HelloMsg = { t: 'ss/hello', playerId, seed: this.seed, inputDelay: this.inputDelay }
    channel.send(JSON.stringify(hello))
    this.broadcastLobby()
    this.onChange(this.players)
    return playerId
  }

  /** guest left while still in the lobby (signaling peer-left) */
  removePeer(playerId: number): void {
    if (this.state !== 'lobby') return // mid-session drops go through LockstepHost.dropPlayer
    const i = this.peers.findIndex((p) => p.playerId === playerId)
    if (i < 0) return
    this.peers.splice(i, 1)
    this.broadcastLobby()
    this.onChange(this.players)
  }

  /** host pressed START — guests begin building their games */
  start(): void {
    if (this.state !== 'lobby') throw new Error('session host: start() called twice')
    if (this.peers.length === 0) throw new Error('session host: cannot start without guests')
    this.state = 'starting'
    const raw = JSON.stringify({ t: 'ss/start' } satisfies StartMsg)
    for (const p of this.peers) p.channel.send(raw)
  }

  /** host ping to one peer (RTT display) */
  ping(playerId: number, n: number): void {
    const peer = this.peers.find((p) => p.playerId === playerId)
    peer?.channel.send(JSON.stringify({ t: 'ss/ping', n } satisfies PingMsg))
  }

  private broadcastLobby(): void {
    const raw = JSON.stringify({ t: 'ss/lobby', players: this.players } satisfies LobbyMsg)
    for (const p of this.peers) p.channel.send(raw)
  }
}

/**
 * Guest-side session: consumes hello/lobby/start, reports ready once the
 * local game + lockstep listeners are wired.
 */
export class GuestLobby {
  hello: { playerId: number; seed: number; inputDelay: number } | null = null
  players: SessionPlayer[] = []

  onHello: (hello: HelloMsg) => void = () => {}
  onChange: (players: SessionPlayer[]) => void = () => {}
  onStart: () => void = () => {}
  onPong: (n: number) => void = () => {}

  constructor(private readonly channel: Channel) {
    channel.onMessage((raw) => {
      const msg = parseSession(raw)
      if (!msg) return
      switch (msg.t) {
        case 'ss/hello':
          this.hello = { playerId: msg.playerId, seed: msg.seed, inputDelay: msg.inputDelay }
          this.onHello(msg)
          break
        case 'ss/lobby':
          this.players = msg.players
          this.onChange(msg.players)
          break
        case 'ss/start':
          this.onStart()
          break
        case 'ss/ping': // host measures RTT to us — echo
          channel.send(JSON.stringify({ t: 'ss/pong', n: msg.n } satisfies PongMsg))
          break
        case 'ss/pong':
          this.onPong(msg.n)
          break
        default:
          throw new Error(`session guest: unexpected '${msg.t}' from host`) // V10
      }
    })
  }

  /** local game built + lockstep listeners registered — tick stream may flow */
  sendReady(): void {
    if (!this.hello) throw new Error('session guest: ready before hello')
    this.channel.send(JSON.stringify({ t: 'ss/ready', playerId: this.hello.playerId } satisfies ReadyMsg))
  }

  /** guest ping to host (RTT display) */
  ping(n: number): void {
    this.channel.send(JSON.stringify({ t: 'ss/ping', n } satisfies PingMsg))
  }
}
