import { generateLayout } from './src/sim/gen/layout.ts'
const L = generateLayout(12345)
const xRoads = [...new Set(L.roads.filter(r=>r.axis==='x').map(r=>r.center))].sort((a,b)=>a-b)
console.log('x-road centers:', xRoads)
console.log('num x-roads:', xRoads.length)
console.log('gaps:', xRoads.slice(1).map((c,i)=>c-xRoads[i]))
const kinds:Record<string,number>={}
for(const d of L.districts) kinds[d.kind]=(kinds[d.kind]||0)+1
console.log('district counts:', kinds, 'total', L.districts.length)
