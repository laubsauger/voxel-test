import { describe, expect, it } from 'vitest'
import { MockChannel } from '../src/net/channel'
import { GuestLobby, HostLobby, MAX_PLAYERS, playerName } from '../src/net/session'

// T71 — lobby/session state machine. WHY: the start sequence is a readiness
// barrier — if the host opened the lockstep tick stream before every guest
// had built its Game and registered channel listeners, the first bundles
// would be silently dropped (DataChannel has no replay) and that guest would
// stall at tick 0 forever. These tests encode that ordering contract, plus
// playerId assignment (host = 1, guests 2.., join order — the sim identity).

function pair() {
  const [hostSide, guestSide] = MockChannel.pair()
  return { hostSide, guestSide, guest: new GuestLobby(guestSide) }
}

describe('session lobby (T71, I.net)', () => {
  it('assigns playerIds 2.. in join order and ships seed+inputDelay in the hello', () => {
    const host = new HostLobby(1337, 3)
    const a = pair()
    const b = pair()
    expect(host.addPeer(a.hostSide)).toBe(2)
    expect(host.addPeer(b.hostSide)).toBe(3)
    expect(a.guest.hello).toEqual({ playerId: 2, seed: 1337, inputDelay: 3 })
    expect(b.guest.hello).toEqual({ playerId: 3, seed: 1337, inputDelay: 3 })
  })

  it('broadcasts the roster to every guest on join and leave', () => {
    const host = new HostLobby(1, 3)
    const a = pair()
    const b = pair()
    host.addPeer(a.hostSide)
    host.addPeer(b.hostSide)
    expect(a.guest.players.map((p) => p.playerId)).toEqual([1, 2, 3])
    host.removePeer(3)
    expect(a.guest.players.map((p) => p.playerId)).toEqual([1, 2])
    expect(host.players.map((p) => p.name)).toEqual([playerName(1), playerName(2)])
  })

  it('start → guests get ss/start; onAllReady fires only after EVERY guest is ready', () => {
    const host = new HostLobby(1, 3)
    const a = pair()
    const b = pair()
    host.addPeer(a.hostSide)
    host.addPeer(b.hostSide)

    let started = { a: false, b: false }
    a.guest.onStart = () => (started.a = true)
    b.guest.onStart = () => (started.b = true)
    let allReady = false
    host.onAllReady = () => (allReady = true)

    host.start()
    expect(started).toEqual({ a: true, b: true })
    expect(host.state).toBe('starting')

    a.guest.sendReady()
    expect(allReady).toBe(false) // b hasn't built its game yet — tick stream must wait
    b.guest.sendReady()
    expect(allReady).toBe(true)
    expect(host.state).toBe('running')
  })

  it('rejects joins after start (late join explicitly deferred) and over-capacity rooms', () => {
    const host = new HostLobby(1, 3)
    const a = pair()
    host.addPeer(a.hostSide)
    host.start()
    expect(() => host.addPeer(pair().hostSide)).toThrow(/late join/)

    const full = new HostLobby(1, 3)
    for (let i = 0; i < MAX_PLAYERS - 1; i++) full.addPeer(pair().hostSide)
    expect(() => full.addPeer(pair().hostSide)).toThrow(/full/)
  })

  it('cannot start an empty lobby or start twice', () => {
    const host = new HostLobby(1, 3)
    expect(() => host.start()).toThrow(/without guests/)
    host.addPeer(pair().hostSide)
    host.start()
    expect(() => host.start()).toThrow(/twice/)
  })

  it('guest cannot report ready before the hello arrived', () => {
    const [, guestSide] = MockChannel.pair()
    const guest = new GuestLobby(guestSide)
    expect(() => guest.sendReady()).toThrow(/before hello/)
  })

  it('ping/pong round-trips both directions and ignores foreign (ls/, dd/) traffic', () => {
    const host = new HostLobby(1, 3)
    const a = pair()
    host.addPeer(a.hostSide)

    const hostPongs: [number, number][] = []
    host.onPong = (pid, n) => hostPongs.push([pid, n])
    host.ping(2, 41)
    expect(hostPongs).toEqual([[2, 41]]) // guest echoed synchronously

    const guestPongs: number[] = []
    a.guest.onPong = (n) => guestPongs.push(n)
    a.guest.ping(7)
    expect(guestPongs).toEqual([7]) // host echoed

    // lockstep/desync traffic on the shared channel is not session traffic
    expect(() => a.hostSide.send(JSON.stringify({ t: 'ls/bundle', tick: 0, cmds: [] }))).not.toThrow()
    expect(() => a.guestSide.send(JSON.stringify({ t: 'dd/hash', playerId: 2, tick: 0, hash: 1 }))).not.toThrow()
  })
})
