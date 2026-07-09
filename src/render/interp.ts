/**
 * T99 — render-side transform interpolation for rideable entities. The sim
 * steps at a fixed 60 Hz; frames land anywhere between ticks. Reading raw
 * tick transforms makes fast vehicles/planes (and their chase camera)
 * shudder whenever frame and tick rates beat. Entities that carry a
 * previous-tick snapshot (DynamicBody.prev*, written at the top of
 * phys.tick) get lerped by the accumulator alpha; entities without one
 * fall back to the raw transform. Quaternions use nlerp — per-tick deltas
 * are tiny, slerp precision is wasted here.
 *
 * Render-only (V6): reads sim state, never writes it. Never feeds hashes.
 */
import type { DynamicBody } from '../sim/iphysics'

export interface LerpedTransform {
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export function lerpTransform(e: DynamicBody, alpha: number, out: LerpedTransform): LerpedTransform {
  if (e.prevPx === undefined || alpha >= 1) {
    out.px = e.px; out.py = e.py; out.pz = e.pz
    out.qx = e.qx; out.qy = e.qy; out.qz = e.qz; out.qw = e.qw
    return out
  }
  const t = alpha < 0 ? 0 : alpha
  out.px = e.prevPx! + (e.px - e.prevPx!) * t
  out.py = e.prevPy! + (e.py - e.prevPy!) * t
  out.pz = e.prevPz! + (e.pz - e.prevPz!) * t
  // nlerp with hemisphere correction
  let bx = e.qx, by = e.qy, bz = e.qz, bw = e.qw
  const dot = e.prevQx! * bx + e.prevQy! * by + e.prevQz! * bz + e.prevQw! * bw
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw }
  let qx = e.prevQx! + (bx - e.prevQx!) * t
  let qy = e.prevQy! + (by - e.prevQy!) * t
  let qz = e.prevQz! + (bz - e.prevQz!) * t
  let qw = e.prevQw! + (bw - e.prevQw!) * t
  const len = Math.hypot(qx, qy, qz, qw) || 1
  out.qx = qx / len; out.qy = qy / len; out.qz = qz / len; out.qw = qw / len
  return out
}
