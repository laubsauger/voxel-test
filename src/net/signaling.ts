/**
 * T24 — client-side signaling + WebRTC pairing (I.net). Thin adapter layer:
 * everything here touches browser-only APIs (WebSocket, RTCPeerConnection)
 * and is therefore NOT imported by unit tests. All logic worth testing lives
 * behind the Channel interface (channel.ts) or in server/rooms.mjs.
 *
 * Topology: star. The host creates a room and opens one reliable-ordered
 * RTCDataChannel per joining peer. Clients connect to the host only.
 */
import type { Channel, Wire } from './channel'

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const DATA_CHANNEL_LABEL = 'lockstep'

/** Thin Channel adapter over a reliable-ordered RTCDataChannel. */
export class DataChannelAdapter implements Channel {
  private readonly listeners: ((msg: Wire) => void)[] = []

  constructor(private readonly dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer'
    dc.onmessage = (e: MessageEvent) => {
      for (const cb of this.listeners) cb(e.data as Wire)
    }
  }

  send(msg: Wire): void {
    if (typeof msg === 'string') this.dc.send(msg)
    else this.dc.send(msg)
  }

  onMessage(cb: (msg: Wire) => void): void {
    this.listeners.push(cb)
  }
}

export interface SignalingOptions {
  iceServers?: RTCIceServer[]
}

interface ServerMsg {
  t: string
  [key: string]: unknown
}

/**
 * Connection to the signaling server (server/signal.mjs). One instance per
 * session; discard after WebRTC channels are up (handshake only).
 */
export class SignalingClient {
  selfId = 0
  /** V10: transport failures surface loud — integrator wires this to the UI */
  onError: (err: Error) => void = (err) => {
    throw err
  }
  onPeerLeft: (peerId: number) => void = () => {}

  private readonly iceServers: RTCIceServer[]
  private readonly peerConnections = new Map<number, RTCPeerConnection>()
  private signalHandler: ((from: number, data: SignalPayload) => void) | null = null
  private peerJoinedHandler: ((peerId: number) => void) | null = null
  private readonly waiters = new Map<string, (msg: ServerMsg) => void>()

  private constructor(
    private readonly ws: WebSocket,
    opts: SignalingOptions,
  ) {
    this.iceServers = opts.iceServers ?? DEFAULT_ICE
    ws.onmessage = (e) => this.dispatch(JSON.parse(String(e.data)) as ServerMsg)
    ws.onclose = () => {
      // fine after setup; loud only if something still waits on the server
      if (this.waiters.size > 0) this.onError(new Error('signaling connection closed'))
    }
  }

  static connect(url: string, opts: SignalingOptions = {}): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onerror = () => reject(new Error(`signaling: cannot reach ${url}`))
      const client = new SignalingClient(ws, opts)
      client.expect('welcome').then((msg) => {
        client.selfId = msg.selfId as number
        resolve(client)
      })
    })
  }

  /**
   * Host flow: create a room, get a join code. For every peer that joins,
   * open an RTCPeerConnection + DataChannel and hand the ready Channel to
   * `onPeer`. playerId assignment happens above this layer (see
   * INTEGRATION-net.md) — this reports signaling peerIds.
   */
  async hostRoom(onPeer: (peerId: number, channel: Channel) => void): Promise<string> {
    const created = this.expect('created')
    this.send({ t: 'create' })
    const code = (await created).code as string

    this.peerJoinedHandler = (peerId) => {
      void this.offerTo(peerId)
        .then((channel) => onPeer(peerId, channel))
        .catch((err: Error) => this.onError(err))
    }
    return code
  }

  /** Client flow: join by code, wait for the host's offer, return the open channel. */
  async joinRoom(code: string): Promise<{ hostId: number; channel: Channel }> {
    const joined = this.expect('joined')
    this.send({ t: 'join', code })
    const hostId = (await joined).hostId as number
    const channel = await this.answerFrom(hostId)
    return { hostId, channel }
  }

  // -- WebRTC plumbing -------------------------------------------------------

  private async offerTo(peerId: number): Promise<Channel> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peerConnections.set(peerId, pc)
    // reliable + ordered is the RTCDataChannel default — exactly what lockstep needs
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL)
    this.wireIce(pc, peerId)

    const open = new Promise<Channel>((resolve, reject) => {
      dc.onopen = () => resolve(new DataChannelAdapter(dc))
      dc.onerror = () => reject(new Error(`data channel to peer ${peerId} failed`))
    })

    this.onSignalFrom(peerId, pc)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.send({ t: 'signal', to: peerId, data: { sdp: pc.localDescription } })
    return open
  }

  private answerFrom(hostId: number): Promise<Channel> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peerConnections.set(hostId, pc)
    this.wireIce(pc, hostId)

    return new Promise<Channel>((resolve, reject) => {
      pc.ondatachannel = (e) => {
        const dc = e.channel
        dc.onopen = () => resolve(new DataChannelAdapter(dc))
        dc.onerror = () => reject(new Error('data channel to host failed'))
      }
      this.signalHandler = (from, data) => {
        if (from !== hostId) return
        void this.applySignal(pc, data, /*answer*/ true).catch(reject)
      }
    })
  }

  private wireIce(pc: RTCPeerConnection, peerId: number): void {
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: 'signal', to: peerId, data: { ice: e.candidate.toJSON() } })
    }
  }

  private onSignalFrom(peerId: number, pc: RTCPeerConnection): void {
    const prev = this.signalHandler
    this.signalHandler = (from, data) => {
      if (from === peerId) void this.applySignal(pc, data, false).catch((e: Error) => this.onError(e))
      else prev?.(from, data)
    }
  }

  private async applySignal(pc: RTCPeerConnection, data: SignalPayload, answer: boolean): Promise<void> {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp)
      if (answer && data.sdp.type === 'offer') {
        const a = await pc.createAnswer()
        await pc.setLocalDescription(a)
        // `to` resolved by finding the pc's peer id
        for (const [peerId, candidate] of this.peerConnections) {
          if (candidate === pc) this.send({ t: 'signal', to: peerId, data: { sdp: pc.localDescription } })
        }
      }
    }
    if (data.ice) await pc.addIceCandidate(data.ice)
  }

  // -- server message plumbing ----------------------------------------------

  private send(msg: object): void {
    this.ws.send(JSON.stringify(msg))
  }

  private expect(t: string): Promise<ServerMsg> {
    return new Promise((resolve) => this.waiters.set(t, resolve))
  }

  private dispatch(msg: ServerMsg): void {
    const waiter = this.waiters.get(msg.t)
    if (waiter) {
      this.waiters.delete(msg.t)
      waiter(msg)
      return
    }
    switch (msg.t) {
      case 'signal':
        this.signalHandler?.(msg.from as number, msg.data as SignalPayload)
        break
      case 'peer-joined':
        this.peerJoinedHandler?.(msg.peerId as number)
        break
      case 'peer-left':
        this.onPeerLeft(msg.peerId as number)
        break
      case 'room-closed':
        this.onError(new Error('host left — session closed')) // V10
        break
      case 'error':
        this.onError(new Error(`signaling: ${String(msg.message)}`)) // V10
        break
      default:
        this.onError(new Error(`signaling: unknown message '${msg.t}'`)) // V10
    }
  }

  close(): void {
    this.ws.close()
  }
}

interface SignalPayload {
  sdp?: RTCSessionDescriptionInit
  ice?: RTCIceCandidateInit
}
