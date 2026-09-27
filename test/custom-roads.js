/**
 * Drives a hand-built road network with the scripted expert, to check that the
 * geometry supports roads a user drew rather than roads the generator made.
 *
 *   node test/custom-roads.js
 */
import { CONFIG, CONFIG_DEFAULTS } from '../src/config.js';
import { RoadWorld } from '../src/world/roadWorld.js';
import { Navigator } from '../src/sim/navigation.js';
import { Agent, TrafficCar } from '../src/sim/agent.js';
import { makeRng } from '../src/core/rng.js';

Object.assign(CONFIG, structuredClone(CONFIG_DEFAULTS));

const world = new RoadWorld(CONFIG);
const rng = makeRng(4242);

// A wide U: two straights joined by a 90 degree bend, plus a crossroads.
const a = world.addNode(300, 400);
const b = world.addNode(1600, 400);
const c = world.addNode(1600, 1300);
const d = world.addNode(300, 1300);
world.addEdge(a.id, b.id);
world.addEdge(b.id, c.id);
world.addEdge(c.id, d.id);
const e = world.addNode(950, 850);
world.addEdge(b.id, e.id, { force: true });
world.addEdge(e.id, d.id, { force: true });
world.rebuild();

console.log(`hand-built network: ${world.nodes.length} junctions, ${world.edges.length} roads, ${world.lanes.length} lanes`);
console.log(`  every lane reachable: ${world.lanes.every((l) => l.next.length > 0)}`);

const nav = new Navigator(world);
const agents = [];
const traffic = [];
for (let i = 0; i < 24; i++) {
  const ag = new Agent(world, nav, null, i);
  ag.rng = rng;
  ag.spawn(rng);
  ag.newGoal(rng);
  agents.push(ag);
}
for (let i = 0; i < 6; i++) {
  const t = new TrafficCar(world, nav, rng);
  t.place(rng);
  traffic.push(t);
}

const expert = { on: true };
const assist = 1;
const steps = 40 * 60;
let reached = 0;
const trace = process.argv.includes('--trace');
let worst = null;
for (let i = 0; i < steps; i++) {
  for (const t of traffic) t.step(CONFIG.sim.dt);
  world.dynGrid.clear();
  for (const t of traffic) world.dynGrid.insertCircle(t.car.x, t.car.y, t.radius, t.car);
  for (const a2 of agents) a2.think(CONFIG.sim.dt, a2.rng, assist);
  for (const a2 of agents) {
    const impact = a2.car.collide(world.dynGrid);
    a2.score(CONFIG.sim.dt, impact);
  }
  for (const t of traffic) t.car.collide(world.dynGrid);
  if (trace && i % 600 === 0) {
    console.log(`  t=${(i / 60).toFixed(0)}s traffic:`);
    traffic.forEach((t, k) => {
      const f = t.follower;
      console.log(
        `    #${k} pos(${t.car.x.toFixed(0)},${t.car.y.toFixed(0)}) spd ${t.car.speed.toFixed(0).padStart(4)} ` +
        `hdg ${((t.car.heading * 180) / Math.PI).toFixed(0).padStart(5)} cruise ${t.cruise.toFixed(0)} ` +
        `err ${f.headingError.toFixed(2).padStart(5)} lane ${f.lane.id} s ${f.s.toFixed(0).padStart(4)}/${f.lane.length.toFixed(0)} ` +
        `front ${(t.rays[3] ? t.rays[3].t.toFixed(0) : '-').padStart(4)}k${t.rays[3] ? t.rays[3].kind : '-'} stuck ${t.stuckTime.toFixed(1)}`,
      );
    });
  }

  if (trace) {
    const idle = agents.filter((a2) => !a2.ended && Math.abs(a2.car.speed) < 8);
    if (idle.length && (!worst || idle[0].time < worst.time)) worst = idle[0];
    if (worst && i % 60 === 0) {
      const a2 = worst;
      const f = a2.follower;
      const b2 = world.closestBoundary(a2.car.x, a2.car.y, 60);
      let near = 1e9;
      for (const t of traffic) near = Math.min(near, Math.hypot(t.car.x - a2.car.x, t.car.y - a2.car.y));
      console.log(
        `t=${(i / 60).toFixed(0).padStart(2)} pos(${a2.car.x.toFixed(0)},${a2.car.y.toFixed(0)}) ` +
        `spd ${a2.car.speed.toFixed(0).padStart(4)} hdg ${((a2.car.heading * 180) / Math.PI).toFixed(0).padStart(5)} ` +
        `str ${a2.control.steer.toFixed(2).padStart(5)} thr ${a2.control.throttle.toFixed(2).padStart(5)} ` +
        `err ${f.headingError.toFixed(2).padStart(5)} lat ${f.lateral.toFixed(0).padStart(4)} ` +
        `lane ${f.lane.id} s ${f.s.toFixed(0).padStart(4)}/${f.lane.length.toFixed(0)} ` +
        `wall ${b2.dist.toFixed(0).padStart(3)} traffic ${near.toFixed(0).padStart(4)} ` +
        `onRoad ${a2.car.onRoad ? 'y' : 'n'} dist ${a2.distance.toFixed(0)}`,
      );
    }
  }
  void expert;
}

const dists = agents.map((a2) => a2.distance);
const reasons = {};
for (const a2 of agents) reasons[a2.endReason || 'running'] = (reasons[a2.endReason || 'running'] || 0) + 1;
reached = agents.reduce((s, a2) => s + a2.goalsReached, 0);
const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
const onRoad = agents.filter((a2) => a2.car.onRoad).length;

console.log(`\nexpert on the hand-built network after ${steps / 60}s:`);
console.log(`  average distance ${avg.toFixed(0)}px, destinations reached ${reached}, still on road ${onRoad}/${agents.length}`);
console.log(`  end reasons ${JSON.stringify(reasons)}`);
console.log(`  distances: ${dists.map((d) => d.toFixed(0)).join(' ')}`);

const ok = avg > 900 && reached >= 4;
console.log(`\n${ok ? 'OK: the scripted driver handles hand-built roads' : 'PROBLEM: the driver cannot get around this network'}`);
if (!ok) process.exitCode = 1;
