import { CommandQueue, type Command, type Op } from './commands'
import { Prng } from './prng'
import { ChunkStore } from '../world/chunks'
import type { SimEvent } from './events'

export const TICK_RATE = 60
export const TICK_MS = 1000 / TICK_RATE
export const DT = 1 / TICK_RATE

export type OpHandler<K extends Op['kind'] = Op['kind']> = (
  sim: Sim,
  cmd: Command & { op: Extract<Op, { kind: K }> },
) => void

export type System = (sim: Sim) => void

const EMPTY_EVENTS: SimEvent[] = []

/**
 * Authoritative deterministic sim (V1, V2). Advances only via step().
 * No wall-clock, no ambient randomness — Prng only. All mutations enter as commands.
 */
export class Sim {
  tick = 0
  nextEntityId = 1
  /** T86/V17 — true in lockstep MP sessions, set identically on every peer
   *  BEFORE tick 0 (so branching on it is deterministic). Ops use it to pick
   *  SP-only behaviour that would desync under MP — e.g. LOCAL rubble may
   *  occlude shots' world edits only when no peers exist. */
  lockstep = false
  readonly prng: Prng
  readonly world = new ChunkStore()
  readonly queue = new CommandQueue()
  private readonly handlers = new Map<Op['kind'], OpHandler>()
  private readonly systems: System[] = []

  constructor(seed: number) {
    this.prng = new Prng(seed)
  }

  allocEntityId(): number {
    return this.nextEntityId++ // V8: deterministic counter, part of sim state
  }

  /**
   * T53/T55 — sim → render event outbox. Sim appends during op handling /
   * systems; render drains once per frame after the tick(s). Same one-way
   * handoff as ChunkStore.dirty → phys.drainRemesh (V6). NOT sim state:
   * never read by sim logic, never hashed (V3 unaffected).
   */
  private readonly events: SimEvent[] = []

  emit(ev: SimEvent): void {
    this.events.push(ev)
  }

  /** render-side drain — returns and clears all pending events */
  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return EMPTY_EVENTS
    const out = this.events.slice()
    this.events.length = 0
    return out
  }

  onOp<K extends Op['kind']>(kind: K, handler: OpHandler<K>): void {
    if (this.handlers.has(kind)) throw new Error(`duplicate handler for op '${kind}'`)
    this.handlers.set(kind, handler as unknown as OpHandler)
  }

  addSystem(system: System): void {
    this.systems.push(system)
  }

  step(): void {
    for (const cmd of this.queue.drain(this.tick)) {
      const handler = this.handlers.get(cmd.op.kind)
      // V10: unknown op = loud failure, never silent skip
      if (!handler) throw new Error(`no handler for op '${cmd.op.kind}' at tick ${this.tick}`)
      handler(this, cmd)
    }
    for (const system of this.systems) system(this)
    this.tick++
  }
}

/**
 * Fixed-step driver (V11). Caller feeds elapsed wall time; sim never reads
 * clocks itself. Render interpolates with `alpha`.
 */
export class FixedStepDriver {
  private accumulator = 0
  /**
   * cap per advance() so a stall doesn't spiral (still deterministic: ticks,
   * not time, are authoritative). T97 — 10→3: the T94 attribution showed the
   * worst destruction frames (75-83ms) were CATCH-UP COMPOUNDING, not the
   * blast itself — one ~25ms edit tick put the driver behind, the next frame
   * replayed the debt (each replayed tick carrying its own debris/stress
   * work), fell further behind, and the spiral only broke at the cap. 3 = one
   * real tick + two catch-ups per frame; beyond that the accumulator DROPS
   * (sim time slips a few ms under sustained overload instead of freezing the
   * frame). SP only — the MP LockstepDriver has its own advance (lockstep can
   * never drop ticks).
   */
  maxStepsPerAdvance = 3

  advance(elapsedMs: number, sim: Sim): number {
    this.accumulator += elapsedMs
    let steps = 0
    while (this.accumulator >= TICK_MS && steps < this.maxStepsPerAdvance) {
      sim.step()
      this.accumulator -= TICK_MS
      steps++
    }
    if (steps === this.maxStepsPerAdvance) this.accumulator = 0
    return steps
  }

  get alpha(): number {
    return this.accumulator / TICK_MS
  }
}
