import { describe, expect, it } from 'vitest'
import { MAX_ROOM_SIZE, RoomManager, makeCodeGen, type Outbound } from '../server/rooms.mjs'

// T24 (I.net): the signaling server is a dumb relay — rooms by join code,
// SDP/ICE forwarding, nothing else. The room state machine is extracted from
// the ws wiring precisely so this behavior is testable without sockets.

let codeCounter = 0
const fixedCodes = () => `CODE${String(codeCounter++).padStart(2, '0')}`

function setup(): { mgr: RoomManager; code: string } {
  codeCounter = 0
  const mgr = new RoomManager(fixedCodes)
  mgr.connect(1)
  const out = mgr.handleMessage(1, { t: 'create' })
  return { mgr, code: out[0].msg.code as string }
}

const msgsTo = (out: Outbound[], id: number) => out.filter((o) => o.to === id).map((o) => o.msg)

describe('RoomManager (T24, I.net)', () => {
  it('welcomes clients with their id on connect', () => {
    const mgr = new RoomManager(fixedCodes)
    expect(mgr.connect(7)).toEqual([{ to: 7, msg: { t: 'welcome', selfId: 7 } }])
  })

  it('create returns a room code to the host', () => {
    const { code } = setup()
    expect(code).toMatch(/^CODE\d\d$/)
  })

  it('generated codes use the unambiguous alphabet at the right length', () => {
    const gen = makeCodeGen(() => 0.5)
    expect(gen()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })

  it('join notifies joiner (with hostId) and host (with peerId)', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    const out = mgr.handleMessage(2, { t: 'join', code })
    expect(msgsTo(out, 2)).toEqual([{ t: 'joined', code, selfId: 2, hostId: 1 }])
    expect(msgsTo(out, 1)).toEqual([{ t: 'peer-joined', peerId: 2 }])
  })

  it('join is case-insensitive on the code', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    const out = mgr.handleMessage(2, { t: 'join', code: code.toLowerCase() })
    expect(out[0].msg.t).toBe('joined')
  })

  it('join with unknown code errors', () => {
    const { mgr } = setup()
    mgr.connect(2)
    const out = mgr.handleMessage(2, { t: 'join', code: 'NOPE99' })
    expect(msgsTo(out, 2)[0].t).toBe('error')
  })

  it(`rooms cap at ${MAX_ROOM_SIZE} members (co-op 2-4)`, () => {
    const { mgr, code } = setup()
    for (let id = 2; id <= MAX_ROOM_SIZE; id++) {
      mgr.connect(id)
      expect(mgr.handleMessage(id, { t: 'join', code })[0].msg.t).toBe('joined')
    }
    mgr.connect(99)
    const out = mgr.handleMessage(99, { t: 'join', code })
    expect(out[0].msg.t).toBe('error')
    expect(out[0].msg.message).toMatch(/full/)
  })

  it('create while already in a room errors', () => {
    const { mgr } = setup()
    expect(mgr.handleMessage(1, { t: 'create' })[0].msg.t).toBe('error')
  })

  it('relays signal payloads verbatim within a room, stamping `from`', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    mgr.handleMessage(2, { t: 'join', code })
    const payload = { sdp: { type: 'offer', sdp: 'v=0...' } }
    const out = mgr.handleMessage(1, { t: 'signal', to: 2, data: payload })
    expect(out).toEqual([{ to: 2, msg: { t: 'signal', from: 1, data: payload } }])
  })

  it('refuses to relay to a client outside the room', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    mgr.handleMessage(2, { t: 'join', code })
    mgr.connect(3) // connected, but never joined
    const out = mgr.handleMessage(1, { t: 'signal', to: 3, data: {} })
    expect(msgsTo(out, 1)[0].t).toBe('error')
  })

  it('signal while not in a room errors', () => {
    const mgr = new RoomManager(fixedCodes)
    mgr.connect(5)
    expect(mgr.handleMessage(5, { t: 'signal', to: 1, data: {} })[0].msg.t).toBe('error')
  })

  it('member disconnect notifies remaining members with peer-left', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    mgr.connect(3)
    mgr.handleMessage(2, { t: 'join', code })
    mgr.handleMessage(3, { t: 'join', code })
    const out = mgr.disconnect(2)
    expect(out).toContainEqual({ to: 1, msg: { t: 'peer-left', peerId: 2 } })
    expect(out).toContainEqual({ to: 3, msg: { t: 'peer-left', peerId: 2 } })
  })

  it('host disconnect closes the room and frees the code', () => {
    const { mgr, code } = setup()
    mgr.connect(2)
    mgr.handleMessage(2, { t: 'join', code })
    const out = mgr.disconnect(1)
    expect(out).toEqual([{ to: 2, msg: { t: 'room-closed', code } }])
    // room is gone: rejoining the dead code fails …
    mgr.connect(3)
    expect(mgr.handleMessage(3, { t: 'join', code })[0].msg.t).toBe('error')
    // … and the orphaned member may host a new room
    expect(mgr.handleMessage(2, { t: 'create' })[0].msg.t).toBe('created')
  })

  it('malformed and unknown messages error instead of crashing', () => {
    const mgr = new RoomManager(fixedCodes)
    mgr.connect(1)
    expect(mgr.handleMessage(1, null)[0].msg.t).toBe('error')
    expect(mgr.handleMessage(1, { t: 'hack' })[0].msg.t).toBe('error')
    expect(mgr.handleMessage(1, 'garbage')[0].msg.t).toBe('error')
  })

  it('exhausted code space fails loud instead of looping forever', () => {
    const mgr = new RoomManager(() => 'SAME00')
    mgr.connect(1)
    mgr.connect(2)
    expect(mgr.handleMessage(1, { t: 'create' })[0].msg.t).toBe('created')
    expect(mgr.handleMessage(2, { t: 'create' })[0].msg.t).toBe('error')
  })
})
