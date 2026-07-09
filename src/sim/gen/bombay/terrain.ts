/**
 * T100 stub — filled by the WP2 agent. Terrain + berm + playa + sea.
 * Returns the sea waterFill box (threaded into stampScene's waterFills).
 */
import type { ChunkStore } from '../../../world/chunks'
import type { Box, BombayZone, Layout } from '../layout'

export function stampBombay_terrain(store: ChunkStore, layout: Layout, zone: BombayZone): { seaFill: Box | null } {
  void store; void layout; void zone // stub — WP agent implements
  return { seaFill: null }
}
