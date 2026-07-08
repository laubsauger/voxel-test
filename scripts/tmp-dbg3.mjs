// TEMP — watch the cascade flushes (deleted after)
import { Sim } from '../src/sim/loop.ts'
import { registerEditOps } from '../src/sim/edit-ops.ts'
import { createPhysics, loadJolt, STRESS_INTERVAL } from '../src/sim/physics.ts'
import { CoarseSupport } from '../src/sim/coarse-support.ts'

const of = CoarseSupport.prototype.findFloating
CoarseSupport.prototype.findFloating = function (s) {
  const r = of.call(this, s)
  console.log(`    findFloating(seed=${s}) ncx=${this.ncx} ncz=${this.ncz} -> ${r ? 'FLOATING' : 'null'}${r && !s ? ' touchesSide=' + this.floatingTouchesSide() : ''}`)
  return r
}
const oc = CoarseSupport.prototype.collectFloatingVoxels
CoarseSupport.prototype.collectFloatingVoxels = function (w, b) {
  const r = oc.call(this, w, b)
  console.log(`    collect -> ${r ? r.voxels.length + ' trunc=' + r.truncated : 'null'}`)
  return r
}

await loadJolt()
const sim = new Sim(1)
registerEditOps(sim)
sim.world.fillBox(0, 0, 0, 63, 7, 63, 3)
sim.world.fillBox(0, 0, 0, 260, 3, 260, 3)
sim.world.fillBox(126, 4, 126, 129, 40, 129, 5)
sim.world.fillBox(30, 41, 30, 229, 44, 229, 5)
const phys = await createPhysics(sim)
sim.step()
for (let i = 0; i < STRESS_INTERVAL * 3; i++) sim.step()
sim.queue.push({ tick: sim.tick + 1, playerId: 1, seq: 0, op: { kind: 'dig', x: 127, y: 20, z: 127, r: 6 } })
for (let i = 0; i < 120; i++) {
  const t = sim.tick
  if (t % 6 === 0) console.log(`tick ${t}:`)
  sim.step()
}
let rem = 0
for (let z = 30; z <= 229; z += 8) for (let x = 30; x <= 229; x += 8) if (sim.world.getVoxel(x, 42, z) !== 0) rem++
console.log('final slab samples remaining:', rem)
phys.dispose()
