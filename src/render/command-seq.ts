/**
 * Shared per-client command seq allocator. PlayerInput (move commands) and
 * the tool controller (dig/place/shoot/explode) both draw from this counter
 * so (playerId, seq) never collides in the CommandQueue's deterministic
 * drain order. Render-layer only — seq is client-local, not sim state.
 */
let seq = 0

export function nextSeq(): number {
  return seq++
}
