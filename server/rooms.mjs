/**
 * T24 — signaling room state machine (I.net). Pure logic, no ws imports:
 * unit-testable, wired to WebSocket by signal.mjs. Stateless beyond room
 * membership, no game logic. Server code MAY use Math.random (not sim state).
 *
 * All methods return an array of outbound actions: { to: clientId, msg }.
 */

export const MAX_ROOM_SIZE = 4 // co-op 2-4 (§G)
export const CODE_LENGTH = 6
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

/** Join-code generator. `random` injectable for deterministic tests. */
export function makeCodeGen(random = Math.random, length = CODE_LENGTH) {
  return () =>
    Array.from({ length }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join('')
}

const err = (to, message) => ({ to, msg: { t: 'error', message } })

export class RoomManager {
  /** @param {() => string} [codeGen] */
  constructor(codeGen) {
    this.codeGen = codeGen ?? makeCodeGen()
    /** code -> { code, hostId, members: number[] } (members[0] === hostId) */
    this.rooms = new Map()
    /** clientId -> room code | null */
    this.clients = new Map()
  }

  connect(id) {
    this.clients.set(id, null)
    return [{ to: id, msg: { t: 'welcome', selfId: id } }]
  }

  handleMessage(id, msg) {
    if (!this.clients.has(id)) return []
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') {
      return [err(id, 'malformed message')]
    }
    switch (msg.t) {
      case 'create':
        return this.create(id)
      case 'join':
        return this.join(id, msg.code)
      case 'signal':
        return this.signal(id, msg)
      default:
        return [err(id, `unknown message type '${msg.t}'`)]
    }
  }

  create(id) {
    if (this.clients.get(id) !== null) return [err(id, 'already in a room')]
    let code = null
    for (let attempt = 0; attempt < 64; attempt++) {
      const candidate = this.codeGen()
      if (!this.rooms.has(candidate)) {
        code = candidate
        break
      }
    }
    if (code === null) return [err(id, 'could not allocate a room code')]
    this.rooms.set(code, { code, hostId: id, members: [id] })
    this.clients.set(id, code)
    return [{ to: id, msg: { t: 'created', code, selfId: id } }]
  }

  join(id, rawCode) {
    if (this.clients.get(id) !== null) return [err(id, 'already in a room')]
    const code = String(rawCode ?? '').toUpperCase()
    const room = this.rooms.get(code)
    if (!room) return [err(id, `room '${code}' not found`)]
    if (room.members.length >= MAX_ROOM_SIZE) return [err(id, `room '${code}' is full`)]
    const others = [...room.members]
    room.members.push(id)
    this.clients.set(id, code)
    return [
      { to: id, msg: { t: 'joined', code, selfId: id, hostId: room.hostId } },
      ...others.map((peer) => ({ to: peer, msg: { t: 'peer-joined', peerId: id } })),
    ]
  }

  /** Relay SDP offer/answer/ICE payload verbatim between members of one room. */
  signal(id, msg) {
    const code = this.clients.get(id)
    if (code === null || code === undefined) return [err(id, 'not in a room')]
    const room = this.rooms.get(code)
    const to = msg.to
    if (typeof to !== 'number' || !room.members.includes(to)) {
      return [err(id, `signal target ${to} not in room`)]
    }
    return [{ to, msg: { t: 'signal', from: id, data: msg.data } }]
  }

  disconnect(id) {
    const code = this.clients.get(id)
    this.clients.delete(id)
    if (code === null || code === undefined) return []
    const room = this.rooms.get(code)
    if (!room) return []
    room.members = room.members.filter((m) => m !== id)
    if (id === room.hostId) {
      // host gone: room dies, everyone out (host is the lockstep authority)
      this.rooms.delete(code)
      for (const m of room.members) this.clients.set(m, null)
      return room.members.map((m) => ({ to: m, msg: { t: 'room-closed', code } }))
    }
    return room.members.map((m) => ({ to: m, msg: { t: 'peer-left', peerId: id } }))
  }
}
