import { describe, expect, it } from 'vitest'
import { Group } from 'three/webgpu'
import { PlayerViewmodel, SWAP_DURATION } from '../src/render/player-viewmodel'

// T49 — FP viewmodel timelines are render-only (V6) and must stay in sync
// with the body rig by consuming the SAME stride phase value.

describe('FP viewmodel (T49)', () => {
  it('swaps the shown tool only after the lower phase of the swap timeline', () => {
    const cam = new Group()
    const vm = new PlayerViewmodel(cam)
    expect(vm.shownTool).toBe('dig')
    vm.update(1 / 60, 0, 0, 'gun') // swap begins
    expect(vm.shownTool).toBe('dig') // still lowering
    // advance past the switch point (half the swap)
    for (let i = 0; i < Math.ceil((SWAP_DURATION * 0.6) / (1 / 60)); i++) {
      vm.update(1 / 60, 0, 0, 'gun')
    }
    expect(vm.shownTool).toBe('gun')
  })

  it('ignores unknown tool ids (defensive: hotbar may grow)', () => {
    const vm = new PlayerViewmodel(new Group())
    for (let i = 0; i < 60; i++) vm.update(1 / 60, 0, 0, 'jetpack')
    expect(vm.shownTool).toBe('dig')
  })

  it('bob follows the shared stride phase (same-source sync with T48)', () => {
    const vm = new PlayerViewmodel(new Group())
    // long settle at a fixed phase: bob X converges to the phase's sine
    for (let i = 0; i < 240; i++) vm.update(1 / 60, 0.25, 1, 'dig')
    const atQuarter = vm.group.position.x
    expect(atQuarter).toBeGreaterThan(0.01) // sin(2π·0.25)·0.014 ≈ 0.014
    for (let i = 0; i < 240; i++) vm.update(1 / 60, 0.75, 1, 'dig')
    expect(vm.group.position.x).toBeLessThan(-0.01) // opposite plant
  })
})
