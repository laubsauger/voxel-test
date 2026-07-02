import { describe, expect, it } from 'vitest'
import { Sim } from '../src/sim/loop'
import { hashSim } from '../src/sim/hash'
import { registerEditOps } from '../src/sim/edit-ops'
import type { Command } from '../src/sim/commands'
import { SnapshotCodec, rleDecode, rleEncode, type SnapshotSection } from '../src/net/snapshot'
import { FrameAssembler, MAX_FRAME_BYTES, frameTransfer } from '../src/net/framing'
import { MockChannel } from '../src/net/channel'
import { Prng } from '../src/sim/prng'
import { CHUNK_COUNT } from '../src/world/chunks'

// T26 (V3): a restored snapshot must be hash-identical to the source sim —
// otherwise a late joiner starts desynced by construction.

function buildEditedSim(): Sim {
  const sim = new Sim(777)
  registerEditOps(sim)
  sim.world.fillBox(0, 0, 0, 1023, 63, 1023, 2) // ground slab
  sim.world.fillBox(100, 64, 100, 140, 90, 140, 5) // a "house"
  const cmds: Command[] = [
    { tick: 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 120, y: 70, z: 100, r: 6 } },
    { tick: 2, playerId: 2, seq: 0, op: { kind: 'place', x: 200, y: 66, z: 200, r: 5, mat: 7 } },
    { tick: 4, playerId: 1, seq: 1, op: { kind: 'dig', x: 50, y: 62, z: 50, r: 10 } },
  ]
  for (const c of cmds) sim.queue.push(c)
  for (let i = 0; i < 6; i++) sim.step()
  sim.prng.nextU32() // consumed randomness must survive the round-trip
  sim.allocEntityId()
  return sim
}

describe('snapshot round-trip (T26, V3)', () => {
  it('restore into a fresh Sim reproduces hashSim exactly', () => {
    const source = buildEditedSim()
    const codec = new SnapshotCodec()
    const buf = codec.serialize(source)

    const fresh = new Sim(0) // wrong seed on purpose — snapshot must overwrite it
    codec.deserialize(fresh, buf)
    expect(hashSim(fresh)).toBe(hashSim(source))
    expect(fresh.tick).toBe(source.tick)
    expect(fresh.nextEntityId).toBe(source.nextEntityId)
  })

  it('after restore, both sims step identically on the same commands', () => {
    const source = buildEditedSim()
    const codec = new SnapshotCodec()
    const fresh = new Sim(0)
    codec.deserialize(fresh, codec.serialize(source))
    registerEditOps(fresh)

    const tick = source.tick + 1
    const cmd: Command = { tick, playerId: 2, seq: 5, op: { kind: 'dig', x: 130, y: 80, z: 120, r: 7 } }
    source.queue.push(cmd)
    fresh.queue.push(structuredClone(cmd))
    for (let i = 0; i < 5; i++) {
      source.step()
      fresh.step()
      expect(hashSim(fresh)).toBe(hashSim(source))
    }
  })

  it('restore marks touched chunks dirty so the renderer re-meshes', () => {
    const source = buildEditedSim()
    const codec = new SnapshotCodec()
    const fresh = new Sim(0)
    codec.deserialize(fresh, codec.serialize(source))
    expect(fresh.world.drainDirty().length).toBeGreaterThan(0)
  })

  it('uniform world compresses tiny (empty/uniform chunks are 2 bytes)', () => {
    const sim = new Sim(1)
    sim.world.fillBox(0, 0, 0, 1023, 511, 1023, 3) // every chunk uniform
    const buf = new SnapshotCodec().serialize(sim)
    // CHUNK_COUNT * 2B + headers — nowhere near the ~3GB dense equivalent
    // (T50: 98304 chunks now; the invariant stays 2B per non-dense chunk)
    expect(buf.byteLength).toBeLessThan(CHUNK_COUNT * 2 + 8192)
  })

  it('rejects snapshots with unknown sections — loud, never skipped (V10)', () => {
    const source = buildEditedSim()
    const sender = new SnapshotCodec()
    sender.registerSection('phys', {
      serialize: () => new Uint8Array([1, 2, 3]),
      deserialize: () => {},
    })
    const buf = sender.serialize(source)
    const receiver = new SnapshotCodec() // 'phys' not registered here
    expect(() => receiver.deserialize(new Sim(0), buf)).toThrow(/unknown section 'phys'/)
  })

  it('rejects snapshots missing a locally-registered section (V10)', () => {
    const buf = new SnapshotCodec().serialize(buildEditedSim())
    const receiver = new SnapshotCodec()
    receiver.registerSection('water', { serialize: () => new Uint8Array(0), deserialize: () => {} })
    expect(() => receiver.deserialize(new Sim(0), buf)).toThrow(/missing/)
  })

  it('registered sections round-trip their payload (physics/water contract)', () => {
    let restored: Uint8Array | null = null
    const section: SnapshotSection = {
      serialize: () => new Uint8Array([9, 8, 7, 6]),
      deserialize: (_sim, data) => {
        restored = data.slice()
      },
    }
    const codec = new SnapshotCodec()
    codec.registerSection('phys', section)
    codec.deserialize(new Sim(0), codec.serialize(buildEditedSim()))
    expect([...restored!]).toEqual([9, 8, 7, 6])
  })

  it('rejects duplicate section registration and corrupt headers (V10)', () => {
    const codec = new SnapshotCodec()
    expect(() => codec.registerSection('core', { serialize: () => new Uint8Array(0), deserialize: () => {} })).toThrow(
      /duplicate/,
    )
    expect(() => codec.deserialize(new Sim(0), new Uint8Array([1, 2, 3, 4]).buffer)).toThrow(/magic|truncated/)
  })
})

describe('RLE codec (T26)', () => {
  it('round-trips arbitrary data exactly', () => {
    const prng = new Prng(99)
    const data = new Uint8Array(32768)
    for (let i = 0; i < data.length; i++) data[i] = prng.nextInt(4) === 0 ? prng.nextInt(256) : 2
    expect([...rleDecode(rleEncode(data), data.length)]).toEqual([...data])
  })

  it('uniform 32KB chunk collapses to a few bytes', () => {
    const data = new Uint8Array(32768).fill(7)
    const rle = rleEncode(data)
    expect(rle.length).toBe(3) // one run: (len u16, value u8)
    expect([...rleDecode(rle, 32768)]).toEqual([...data])
  })

  it('handles runs longer than u16 max', () => {
    const data = new Uint8Array(70000).fill(1)
    const rle = rleEncode(data)
    expect(rleDecode(rle, 70000).every((v) => v === 1)).toBe(true)
  })

  it('fails loud on corrupt streams (V10)', () => {
    expect(() => rleDecode(new Uint8Array([1, 0]), 10)).toThrow(/corrupt/)
    expect(() => rleDecode(new Uint8Array([5, 0, 1]), 3)).toThrow(/past expected/)
    expect(() => rleDecode(new Uint8Array([2, 0, 1]), 10)).toThrow(/expected 10B/)
  })
})

describe('transfer framing (T26)', () => {
  function randomPayload(bytes: number): ArrayBuffer {
    const prng = new Prng(bytes)
    const data = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) data[i] = prng.nextInt(256)
    return data.buffer
  }

  it('round-trips a large payload over a 16KB-limited channel', () => {
    const payload = randomPayload(100_000)
    const [a, b] = MockChannel.pair()
    b.maxBytes = MAX_FRAME_BYTES // receiving side enforces the DataChannel budget on a's sends
    a.maxBytes = MAX_FRAME_BYTES

    const assembler = new FrameAssembler()
    let result: ArrayBuffer | null = null
    b.onMessage((msg) => {
      if (typeof msg === 'string') return
      const done = assembler.push(msg)
      if (done) result = done
    })
    for (const frame of frameTransfer(payload, 1)) a.send(frame)

    expect(result).not.toBeNull()
    expect([...new Uint8Array(result!)]).toEqual([...new Uint8Array(payload)])
    expect(a.sentCount).toBe(Math.ceil(100_000 / (MAX_FRAME_BYTES - 12)))
  })

  it('every frame fits the 16KB budget', () => {
    for (const frame of frameTransfer(randomPayload(200_000), 2)) {
      expect(frame.byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    }
  })

  it('reassembles out-of-order and interleaved transfers', () => {
    const p1 = randomPayload(40_000)
    const p2 = randomPayload(35_000)
    const f1 = frameTransfer(p1, 10)
    const f2 = frameTransfer(p2, 11)
    const assembler = new FrameAssembler()
    const done: ArrayBuffer[] = []
    const interleaved = [f1[2], f2[0], f1[0], f2[2], f1[1], f2[1]]
    for (const f of interleaved) {
      const r = assembler.push(f)
      if (r) done.push(r)
    }
    expect(done).toHaveLength(2)
    expect([...new Uint8Array(done[0])]).toEqual([...new Uint8Array(p1)])
    expect([...new Uint8Array(done[1])]).toEqual([...new Uint8Array(p2)])
  })

  it('tiny and empty payloads are single frames', () => {
    expect(frameTransfer(new ArrayBuffer(0), 3)).toHaveLength(1)
    const assembler = new FrameAssembler()
    expect(assembler.push(frameTransfer(new ArrayBuffer(0), 3)[0])!.byteLength).toBe(0)
  })

  it('duplicate/inconsistent frames fail loud (V10)', () => {
    const frames = frameTransfer(randomPayload(50_000), 4)
    const assembler = new FrameAssembler()
    assembler.push(frames[0])
    expect(() => assembler.push(frames[0])).toThrow(/duplicate/)
  })

  it('snapshot survives framed transfer end-to-end', () => {
    const source = buildBig()
    const codec = new SnapshotCodec()
    const [a, b] = MockChannel.pair()
    a.maxBytes = MAX_FRAME_BYTES
    const assembler = new FrameAssembler()
    const fresh = new Sim(0)
    let restored = false
    b.onMessage((msg) => {
      if (typeof msg === 'string') return
      const buf = assembler.push(msg)
      if (buf) {
        codec.deserialize(fresh, buf)
        restored = true
      }
    })
    for (const frame of frameTransfer(codec.serialize(source), 42)) a.send(frame)
    expect(restored).toBe(true)
    expect(hashSim(fresh)).toBe(hashSim(source))

    function buildBig(): Sim {
      const sim = new Sim(31337)
      registerEditOps(sim)
      sim.world.fillBox(0, 0, 0, 1023, 63, 1023, 2)
      // punch holes so plenty of chunks realize dense (multi-frame snapshot)
      for (let i = 0; i < 20; i++) {
        sim.world.stampSphere(60 + i * 45, 63, 60 + i * 40, 6, 0)
      }
      return sim
    }
  })
})
