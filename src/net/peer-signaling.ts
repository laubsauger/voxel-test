/**
 * PeerJS-backed signaling — drop-in alternative to SignalingClient (signaling.ts)
 * that needs NO self-hosted server. Uses the PeerJS cloud broker (wss) for
 * rendezvous, so HOST/JOIN works straight from the static GitHub Pages deploy.
 *
 * Same public surface as SignalingClient (the `Signaling` interface): main.ts
 * picks this backend when boot.signalUrl is not a ws:// URL. Everything above
 * the Channel (session/lockstep/desync) is untouched.
 *
 * Topology: unchanged — star. The join code IS the host's PeerJS id
 * (PREFIX + code); guests peer.connect() to it. STUN-only NAT traversal (same
 * as before) — symmetric-NAT peers still fail; acceptable for now.
 */
import Peer from 'peerjs'
import type { DataConnection, PeerError, PeerOptions } from 'peerjs'
import type { Channel, Wire } from './channel'
import type { Signaling, Transport } from './signaling'

/** shared broker namespace prefix — reduces id collisions on the public cloud */
const PREFIX = 'bbvox'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I (matches server/rooms.mjs)
const CODE_LENGTH = 6
const HOST_ID = 1 // guests always talk to exactly one peer: the host

/** raw pass-through: strings stay strings, ArrayBuffers stay ArrayBuffers (Wire) */
const CONNECT_OPTS = { reliable: true, serialization: 'raw' } as const

function genCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

/**
 * boot.signalUrl → PeerJS broker options.
 *   'peerjs' / ''            → public cloud (0.peerjs.com, wss)
 *   'peerjs://host:port/path'  → custom PeerServer (insecure)
 *   'peerjss://host:port/path' → custom PeerServer (wss)
 */
function brokerOptions(url: string): PeerOptions {
  if (url === 'peerjs' || url === '') return {}
  const m = /^peerjs(s)?:\/\/([^:/]+)(?::(\d+))?(\/.*)?$/.exec(url)
  if (!m) return {}
  return { host: m[2], port: m[3] ? Number(m[3]) : undefined, path: m[4] ?? '/', secure: Boolean(m[1]) }
}

/** Channel over a PeerJS DataConnection. Mirrors DataChannelAdapter's diagnostic surface. */
class PeerChannelAdapter implements Channel {
  private readonly listeners: ((msg: Wire) => void)[] = []
  private readonly closeListeners: (() => void)[] = []
  sent = 0
  received = 0

  get bufferedAmount(): number {
    return this.conn.dataChannel?.bufferedAmount ?? 0
  }

  get readyState(): RTCDataChannelState {
    return this.conn.open ? 'open' : 'closed'
  }

  constructor(private readonly conn: DataConnection) {
    conn.on('data', (data) => {
      this.received++
      for (const cb of this.listeners) cb(data as Wire)
    })
    // T71 parity — transport death is a session event, never silent (V10)
    conn.on('close', () => {
      console.warn(`[net] peer connection '${conn.connectionId}' closed`)
      for (const cb of this.closeListeners) cb()
    })
    conn.on('error', (e) => console.warn('[net] peer connection error:', e))
  }

  send(msg: Wire): void {
    this.sent++
    this.conn.send(msg)
  }

  onMessage(cb: (msg: Wire) => void): void {
    this.listeners.push(cb)
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb)
  }
}

/**
 * Connection to the PeerJS broker. One instance per session. connect() opens a
 * peer to verify the broker early (matches SignalingClient's connect-can-fail
 * UX); the guest path reuses it, the host path swaps in a code-named peer.
 */
export class PeerSignalingClient implements Signaling {
  selfId = 0
  onError: (err: Error) => void = (err) => {
    throw err
  }
  onPeerLeft: (peerId: number) => void = () => {}

  private nextPeerId = HOST_ID + 1
  private readonly peerIds = new Map<DataConnection, number>()

  private constructor(
    private peer: Peer,
    private readonly opts: PeerOptions,
  ) {}

  static connect(url: string): Promise<PeerSignalingClient> {
    const opts = brokerOptions(url)
    return new Promise((resolve, reject) => {
      const peer = new Peer(opts) // random id — a probe that verifies the broker
      const client = new PeerSignalingClient(peer, opts)
      let settled = false
      peer.on('open', () => {
        settled = true
        client.selfId = HOST_ID + 1
        // hand routine errors to the integrator now that setup succeeded (V10)
        peer.on('error', (e: PeerError<string>) => client.onError(new Error(`peerjs: ${e.type}`)))
        resolve(client)
      })
      peer.on('error', (e: PeerError<string>) => {
        if (settled) return
        settled = true
        reject(new Error(`peerjs: cannot reach broker (${e.type})`))
      })
    })
  }

  /**
   * Host: claim a code (= our PeerJS id), retrying on the rare collision. Every
   * guest that connects gets a numbered peerId + open Channel via onPeer.
   * playerId assignment happens above this layer (session.ts).
   */
  async hostRoom(onPeer: (peerId: number, channel: Channel) => void, _transport: Transport = 'rtc'): Promise<string> {
    this.peer.destroy() // the probe peer had a random id — we need id == code
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = genCode()
      const peer = new Peer(PREFIX + code, this.opts)
      const claimed = await new Promise<boolean>((resolve) => {
        let settled = false
        peer.on('open', () => {
          if (settled) return
          settled = true
          resolve(true)
        })
        peer.on('error', (e: PeerError<string>) => {
          if (settled) return
          settled = true
          if (e.type === 'unavailable-id') {
            peer.destroy()
            resolve(false) // code taken — try another
          } else {
            this.onError(new Error(`peerjs: ${e.type}`))
            resolve(false)
          }
        })
      })
      if (!claimed) continue
      this.peer = peer
      this.selfId = HOST_ID
      peer.on('error', (e: PeerError<string>) => this.onError(new Error(`peerjs: ${e.type}`)))
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          const peerId = this.nextPeerId++
          this.peerIds.set(conn, peerId)
          onPeer(peerId, new PeerChannelAdapter(conn))
        })
        conn.on('close', () => {
          const peerId = this.peerIds.get(conn)
          if (peerId === undefined) return
          this.peerIds.delete(conn)
          this.onPeerLeft(peerId)
        })
        conn.on('error', (e) => console.warn('[net] host peer connection error:', e))
      })
      return code
    }
    throw new Error('peerjs: could not allocate a room code')
  }

  /**
   * Guest: connect to the host by code. A bad/absent code surfaces via onError
   * (broker emits 'peer-unavailable'); the returned promise then stays pending —
   * same contract as SignalingClient.joinRoom (see main.ts join flow).
   */
  async joinRoom(code: string, _transport: Transport = 'rtc'): Promise<{ hostId: number; channel: Channel }> {
    const target = PREFIX + code.toUpperCase()
    return new Promise((resolve) => {
      const conn = this.peer.connect(target, CONNECT_OPTS)
      conn.on('open', () => resolve({ hostId: HOST_ID, channel: new PeerChannelAdapter(conn) }))
      conn.on('error', (e) => this.onError(new Error(`peerjs: connection failed (${e.type})`)))
      // 'peer-unavailable' (unknown code) fires on the peer, routed to onError above.
    })
  }

  close(): void {
    this.peer.destroy()
  }
}
