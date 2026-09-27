/**
 * World invariant check: no collision wall may cross a lane centreline, and no
 * lane may start or end inside a wall. Either violation is a place where a car
 * following the map correctly would still crash into scenery.
 *
 *   node test/validate-world.js [seed]
 *   node test/validate-world.js --all     check a spread of seeds
 */
import { CONFIG, CONFIG_DEFAULTS } from '../src/config.js';
import { Simulation } from '../src/sim/simulation.js';
import { pointSegDist } from '../src/core/math.js';

Object.assign(CONFIG, structuredClone(CONFIG_DEFAULTS));

const all = process.argv.includes('--all');
const seeds = all
  ? [1, 2, 3, 4, 5, 6, 7, 8].map((n) => n * 7919)
  : [Number(process.argv[2] || CONFIG.seed)];

let total = 0;
for (const seed of seeds) {
  const problems = check(seed);
  total += problems;
  if (all) {
    process.stdout.write(`  seed ${String(seed).padStart(6)}: ${problems ? 'blocked lanes found' : 'ok'}\n`);
  }
}

if (all) {
  process.stdout.write(total
    ? `  ${total} problem(s) across ${seeds.length} seeds\n`
    : `  all ${seeds.length} seeds produce a drivable network\n`);
  if (total) process.exitCode = 1;
}

function check(seed) {
  const sim = new Simulation(CONFIG, seed);
  const world = sim.world;
  let problems = 0;

  const closed = [];
  world.segGrid.query(0, 0, world.width, world.height, (s) => { if (!s.open) closed.push(s); });

  for (const lane of world.lanes) {
    for (let i = 1; i < lane.pts.length; i++) {
      const a = lane.pts[i - 1];
      const b = lane.pts[i];
      for (const seg of closed) {
        const near = pointSegDist((a.x + b.x) / 2, (a.y + b.y) / 2, seg.ax, seg.ay, seg.bx, seg.by);
        if (near > world.laneWidth) continue;
        if (crosses(a, b, seg) && problems++ < 3) {
          console.log(`  BLOCKED lane ${lane.id} crosses a wall at s=${a.s.toFixed(0)} of ${lane.length.toFixed(0)}`);
        }
      }
    }
  }

  for (const lane of world.lanes) {
    for (const p of [lane.pts[0], lane.pts[lane.pts.length - 1]]) {
      const hit = world.closestBoundary(p.x, p.y, 40);
      if (hit.dist < sim.cfg.car.radius && problems++ < 6) {
        console.log(`  LANE END inside a wall: lane ${lane.id} at (${p.x.toFixed(0)},${p.y.toFixed(0)})`);
      }
    }
  }

  const value = sim.navigator.fieldFor(world.lanes[world.lanes.length - 1].to.id);
  const unreachable = world.lanes.filter((l) => !Number.isFinite(value[l.id])).length;
  if (unreachable) {
    problems += unreachable;
    console.log(`  ${unreachable}/${world.lanes.length} lanes cannot reach the destination`);
  }

  if (!all) {
    console.log(`world: ${world.nodes.length} junctions, ${world.edges.length} roads, ${world.lanes.length} lanes, ${world.stats.length}px of road`);
    console.log(problems ? `${problems} problems found` : 'OK: no blocked lanes, every lane reachable');
    if (problems) process.exitCode = 1;
  }
  return problems;
}

function crosses(a, b, seg) {
  const d1 = (b.x - a.x) * (seg.ay - a.y) - (b.y - a.y) * (seg.ax - a.x);
  const d2 = (b.x - a.x) * (seg.by - a.y) - (b.y - a.y) * (seg.bx - a.x);
  const d3 = (seg.bx - seg.ax) * (a.y - seg.ay) - (seg.by - seg.ay) * (a.x - seg.ax);
  const d4 = (seg.bx - seg.ax) * (b.y - seg.ay) - (seg.by - seg.ay) * (b.x - seg.ax);
  const opposite = (p, q) => (p > 0 && q < 0) || (p < 0 && q > 0);
  return opposite(d1, d2) && opposite(d3, d4);
}
