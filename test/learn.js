/**
 * Learning check: the scripted teacher sets the bar, behaviour cloning gets a
 * first population near it, and evolution has to beat it.
 *
 *   node test/learn.js [generations] [population] [trials] [traffic]
 */
import { CONFIG, CONFIG_DEFAULTS } from '../src/config.js';
import { Simulation } from '../src/sim/simulation.js';
import { Pretrainer } from '../src/sim/pretrain.js';
import { mean } from '../src/core/math.js';

const generations = Number(process.argv[2] || 16);
const population = Number(process.argv[3] || 40);
const trials = Number(process.argv[4] || CONFIG.evolution.trials);
const traffic = Number(process.argv[5] ?? 14);

Object.assign(CONFIG, structuredClone(CONFIG_DEFAULTS));
CONFIG.evolution.population = population;
CONFIG.evolution.trials = trials;
CONFIG.traffic.count = traffic;
console.log(`population ${population}, runs per generation ${trials}, traffic ${traffic}\n`);

function run(sim, count) {
  const curve = [];
  for (let g = 0; g < count; g++) {
    const start = sim.evolution.generation;
    while (sim.evolution.generation === start) sim.step(CONFIG.sim.dt);
    curve.push(sim.lastResult);
  }
  return curve;
}

function report(label, curve) {
  console.log(label);
  console.log('  gen   best      avg     champion   goals   dist(km)  how the runs ended');
  curve.forEach((r, i) => {
    const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `  ${String(i).padStart(3)}  ${r.best.toFixed(1).padStart(8)}  ${r.avg.toFixed(1).padStart(8)}  ` +
      `${r.champion.toFixed(1).padStart(9)}  ${r.avgGoals.toFixed(2).padStart(5)}  ` +
      `${(r.avgDistance / 1000).toFixed(2).padStart(9)}  ${reasons}`,
    );
  });
  console.log('');
}

// ------------------------------------------------------------ 1. the teacher ---
const teacherSim = new Simulation(CONFIG, CONFIG.seed);
teacherSim.assist = 1;
const teacherCurve = run(teacherSim, 3);
const teacherScore = mean(teacherCurve.map((r) => r.best));
const teacherAvgDistance = mean(teacherCurve.map((r) => r.avgDistance));
console.log(`scripted teacher: best ${teacherCurve.map((r) => r.best.toFixed(0)).join(', ')}`);
console.log(`  average ${teacherScore.toFixed(0)} fitness, ${(teacherAvgDistance / 1000).toFixed(2)}km per run\n`);

// ------------------------------------------ 2. clone the teacher, then evolve ---
const sim = new Simulation(CONFIG, CONFIG.seed);
const pre = new Pretrainer(sim.world, sim.navigator, CONFIG, sim.rng.fork(3));
const t0 = Date.now();
while (!pre.pump(40));
console.log(`behaviour cloning: ${Date.now() - t0}ms over ${pre.inputs.length} expert frames, loss ${pre.loss.toFixed(4)}\n`);

sim.evolution.seed();
sim.evolution.inject(pre.genome, Math.max(4, Math.floor(population * 0.3)));
sim.reseedPopulation();
const curve = run(sim, generations);
report('evolution on top of the cloned teacher:', curve);

const first = curve[0].best;
const best = Math.max(...curve.map((r) => r.best));
const champion = sim.evolution.championFitness;
const avgStart = mean(curve.slice(0, 2).map((r) => r.avg));
const avgEnd = mean(curve.slice(-2).map((r) => r.avg));

console.log(`  first generation best ${first.toFixed(0)}, best ever ${best.toFixed(0)}`);
console.log(`  population average ${avgStart.toFixed(0)} -> ${avgEnd.toFixed(0)}`);
console.log(`  champion ${champion.toFixed(0)} against the teacher's ${teacherScore.toFixed(0)}`);

// The population average is the honest signal: the per-generation best jumps
// around because each generation is a fresh sample of the same benchmark.
const learned = avgEnd > avgStart + 15;
const beatTeacher = champion > teacherScore;
console.log(`\n${learned ? 'OK' : 'PROBLEM'}: the population average ${learned ? 'improved' : 'did not improve'}`
  + `${beatTeacher ? ', and the champion beat the scripted teacher' : ''}`);
if (!learned) process.exitCode = 1;
