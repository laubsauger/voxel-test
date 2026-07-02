/**
 * T26 — join snapshot (V3). Serializes full sim state to an ArrayBuffer such
 * that deserializing into a fresh Sim reproduces the exact hashSim value —
 * then both sims step identically from the same command stream.
 *
 * Format (little-endian):
 *   header:  u32 magic 'VXSN', u16 version, u16 sectionCount
 *   section: u8 idLen, ascii id, u32 byteLen, payload
 *
 * Built-in sections: 'core' (tick, prng state, nextEntityId) and 'chunks'
 * (sparse chunk store, RLE for dense chunks; empty/uniform chunks are 2 bytes
 * each). EXTENSIBLE: physics/water/entity state lives in other tracks and is
 * not in ChunkStore — those owners register their own sections via
 * registerSection(id, { serialize, deserialize }). Sections are written in
 * registration order; an unknown section id on deserialize fails loud (V10):
 * it means the joiner is missing a system the host serialized.
 *
 * Restoring writes sim state directly — this is the one sanctioned non-command
 * mutation path (a state transplant, validated by hash equality), used only
 * for late join before the sim starts stepping.
 */
import type { Sim } from '../sim/loop'
import { ChunkKind, CHUNK_COUNT, CHUNK_VOL } from '../world/chunks'

export const SNAPSHOT_MAGIC = 0x4e535856 // 'VXSN' little-endian
export const SNAPSHOT_VERSION = 1

export interface SnapshotSection {
  serialize(sim: Sim): Uint8Array
  deserialize(sim: Sim, data: Uint8Array): void
}

// -- byte plumbing -----------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(1024)
  private len = 0

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  u8(v: number): void {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }

  u16(v: number): void {
    this.ensure(2)
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >>> 8) & 0xff
  }

  u32(v: number): void {
    this.ensure(4)
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >>> 8) & 0xff
    this.buf[this.len++] = (v >>> 16) & 0xff
    this.buf[this.len++] = (v >>> 24) & 0xff
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length)
    this.buf.set(data, this.len)
    this.len += data.length
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

class ByteReader {
  private pos = 0

  constructor(private readonly buf: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('snapshot: truncated buffer') // V10
  }

  u8(): number {
    this.need(1)
    return this.buf[this.pos++]
  }

  u16(): number {
    this.need(2)
    return this.buf[this.pos++] | (this.buf[this.pos++] << 8)
  }

  u32(): number {
    this.need(4)
    return (
      (this.buf[this.pos++] | (this.buf[this.pos++] << 8) | (this.buf[this.pos++] << 16) | (this.buf[this.pos++] << 24)) >>>
      0
    )
  }

  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.bytes(n))
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }
}

// -- RLE codec ---------------------------------------------------------------

/**
 * Byte-run RLE: repeated triples (u16 LE runLength, u8 value). Dense but
 * mostly-uniform chunks collapse to a handful of runs.
 */
export function rleEncode(data: Uint8Array): Uint8Array {
  const runs: number[] = [] // flat [len, value, ...]
  let i = 0
  while (i < data.length) {
    const v = data[i]
    let j = i + 1
    while (j < data.length && data[j] === v && j - i < 0xffff) j++
    runs.push(j - i, v)
    i = j
  }
  const out = new Uint8Array((runs.length / 2) * 3)
  let o = 0
  for (let k = 0; k < runs.length; k += 2) {
    out[o++] = runs[k] & 0xff
    out[o++] = (runs[k] >>> 8) & 0xff
    out[o++] = runs[k + 1]
  }
  return out
}

export function rleDecode(data: Uint8Array, expectedLen: number): Uint8Array {
  if (data.length % 3 !== 0) throw new Error('rle: corrupt stream (length not a multiple of 3)') // V10
  const out = new Uint8Array(expectedLen)
  let o = 0
  for (let i = 0; i < data.length; i += 3) {
    const len = data[i] | (data[i + 1] << 8)
    if (o + len > expectedLen) throw new Error('rle: decoded past expected length') // V10
    out.fill(data[i + 2], o, o + len)
    o += len
  }
  if (o !== expectedLen) throw new Error(`rle: decoded ${o}B, expected ${expectedLen}B`) // V10
  return out
}

// -- built-in sections -------------------------------------------------------

const coreSection: SnapshotSection = {
  serialize(sim) {
    const w = new ByteWriter()
    w.u32(sim.tick)
    w.u32(sim.prng.state)
    w.u32(sim.nextEntityId)
    return w.finish()
  },
  deserialize(sim, data) {
    const r = new ByteReader(data)
    sim.tick = r.u32()
    sim.prng.state = r.u32()
    sim.nextEntityId = r.u32()
  },
}

const enum DenseMode {
  Raw = 0,
  Rle = 1,
}

const chunksSection: SnapshotSection = {
  serialize(sim) {
    const w = new ByteWriter()
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const c = sim.world.chunkAt(i)
      if (c.kind === ChunkKind.Dense) {
        const rle = rleEncode(c.data!)
        if (rle.length < CHUNK_VOL) {
          w.u8(ChunkKind.Dense)
          w.u8(DenseMode.Rle)
          w.u32(rle.length)
          w.bytes(rle)
        } else {
          // pathological chunk: RLE would inflate, store raw
          w.u8(ChunkKind.Dense)
          w.u8(DenseMode.Raw)
          w.u32(CHUNK_VOL)
          w.bytes(c.data!)
        }
      } else {
        // empty/uniform: 2 bytes each
        w.u8(c.kind)
        w.u8(c.kind === ChunkKind.Uniform ? c.mat : 0)
      }
    }
    return w.finish()
  },
  deserialize(sim, data) {
    const r = new ByteReader(data)
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const c = sim.world.chunkAt(i)
      const wasEmpty = c.kind === ChunkKind.Empty
      const kind = r.u8() as ChunkKind
      switch (kind) {
        case ChunkKind.Empty:
          r.u8()
          c.kind = ChunkKind.Empty
          c.mat = 0
          c.data = null
          break
        case ChunkKind.Uniform:
          c.kind = ChunkKind.Uniform
          c.mat = r.u8()
          c.data = null
          break
        case ChunkKind.Dense: {
          const mode = r.u8() as DenseMode
          const len = r.u32()
          const payload = r.bytes(len)
          c.kind = ChunkKind.Dense
          c.mat = 0
          c.data = mode === DenseMode.Rle ? rleDecode(payload, CHUNK_VOL) : payload.slice()
          if (c.data.length !== CHUNK_VOL) throw new Error(`snapshot: dense chunk ${i} is ${c.data.length}B`) // V10
          break
        }
        default:
          throw new Error(`snapshot: unknown chunk kind ${kind} at index ${i}`) // V10
      }
      // renderer must re-mesh anything the restore touched
      if (!wasEmpty || c.kind !== ChunkKind.Empty) sim.world.dirty.add(i)
    }
    if (r.remaining !== 0) throw new Error(`snapshot: ${r.remaining}B trailing in chunks section`) // V10
  },
}

// -- codec -------------------------------------------------------------------

export class SnapshotCodec {
  private readonly sections = new Map<string, SnapshotSection>()

  constructor() {
    this.registerSection('core', coreSection)
    this.registerSection('chunks', chunksSection)
  }

  /**
   * Registration API for other tracks: physics ('phys'), water ('water'),
   * entities — each owner registers its section on BOTH host and joiner
   * before snapshot exchange. Ids must match exactly.
   */
  registerSection(id: string, section: SnapshotSection): void {
    if (id.length === 0 || id.length > 255) throw new Error(`snapshot: bad section id '${id}'`)
    if (this.sections.has(id)) throw new Error(`snapshot: duplicate section '${id}'`) // V10
    this.sections.set(id, section)
  }

  serialize(sim: Sim): ArrayBuffer {
    const w = new ByteWriter()
    w.u32(SNAPSHOT_MAGIC)
    w.u16(SNAPSHOT_VERSION)
    w.u16(this.sections.size)
    for (const [id, section] of this.sections) {
      const payload = section.serialize(sim)
      w.u8(id.length)
      w.ascii(id)
      w.u32(payload.length)
      w.bytes(payload)
    }
    const bytes = w.finish()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  deserialize(sim: Sim, buf: ArrayBuffer): void {
    const r = new ByteReader(new Uint8Array(buf))
    if (r.u32() !== SNAPSHOT_MAGIC) throw new Error('snapshot: bad magic') // V10
    const version = r.u16()
    if (version !== SNAPSHOT_VERSION) throw new Error(`snapshot: version ${version}, expected ${SNAPSHOT_VERSION}`) // V10
    const count = r.u16()
    const seen = new Set<string>()
    for (let s = 0; s < count; s++) {
      const id = r.ascii(r.u8())
      const payload = r.bytes(r.u32())
      const section = this.sections.get(id)
      if (!section) {
        // V10: silently skipping a system's state would guarantee a desync
        throw new Error(`snapshot: unknown section '${id}' — its owner must registerSection() before deserialize`)
      }
      section.deserialize(sim, payload)
      seen.add(id)
    }
    for (const id of this.sections.keys()) {
      if (!seen.has(id)) throw new Error(`snapshot: section '${id}' registered locally but missing from snapshot`) // V10
    }
    if (r.remaining !== 0) throw new Error(`snapshot: ${r.remaining}B trailing`) // V10
  }
}
