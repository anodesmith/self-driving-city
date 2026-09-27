import { CONFIG } from '../config.js';
import { RoadWorld } from '../world/roadWorld.js';
import { generateCity } from '../world/cityGenerator.js';
import { makeRng } from '../core/rng.js';
import { Navigator } from './navigation.js';
import { Evolution } from './evolution.js';
import { Pretrainer } from './pretrain.js';
import { Agent, TrafficCar } from './agent.js';
import { mean } from '../core/math.js';

/**
 * Owns the world, the population of learner cars and the civilian traffic, and
 * advances everything with a fixed timestep. No DOM access: the same class runs
 * in the browser and inside the headless Node test.
 */
export class Simulation {
  constructor(cfg = CONFIG, seed = cfg.seed) {
    this.cfg = cfg;
    this.rng = makeRng(seed);
    this.world = new RoadWorld(cfg);
    this.navigator = new Navigator(this.world);
    this.evolution = new Evolution(cfg, this.rng.fork(7));
    this.pretrainer = new Pretrainer(this.world, this.navigator, cfg, this.rng.fork(11));

    this.agents = [];
    this.traffic = [];
    this.time = 0;
    this.generationTime = 0;
    this.trial = 0;
    this.scenarioBase = (seed ^ 0x5f3759df) >>> 0;
    this.eventRng = makeRng((seed ^ 0x1a2b3c4d) >>> 0);
    this.accFitness = new Float32Array(0);
    this.trialStats = [];
    this.paused = false;
    this.assist = 0;
    this.accumulator = 0;
    this.lastResult = null;
    this.events = [];
    this.newWorld(seed);
  }

  // ------------------------------------------------------------------ world ---

  newWorld(seed = this.cfg.seed) {
    this.rng = makeRng(seed);
    generateCity(this.rng, this.cfg, this.world);
    this.navigator.invalidate();
    this.reseedPopulation(); // also lays out the traffic for trial 0
    this.time = 0;
    this.generationTime = 0;
    this.trial = 0;
    this.events = [`New city generated (seed ${seed})`];
  }

  /**
   * Move a jammed civilian car somewhere else.
   *
   * Traffic that stops dead blocks a lane for whoever is behind it, which would
   * make a learner's score depend on the traffic rather than on its driving.
   * Recycling keeps the city flowing and the benchmark fair.
   */
  recycleTraffic(t, rng) {
    const lanes = this.world.lanes;
    if (!lanes.length) return;
    const starts = this.agents.filter((a) => !a.ended).map((a) => a.car);
    const clearance = this.cfg.car.radius * 2 + 55;
    for (let attempt = 0; attempt < 8; attempt++) {
      const lane = lanes[rng.int(0, lanes.length - 1)];
      if (!t.placeOn(lane, rng, 0.1, 0.8)) continue;
      if (starts.some((c) => Math.hypot(c.x - t.car.x, c.y - t.car.y) < clearance)) continue;
      t.stuckTime = 0;
      return;
    }
    t.place(rng);
  }

  /** Called after the road editor changes the network. */
  onWorldEdited() {
    this.world.rebuild();
    this.navigator.invalidate();
    this.trial = 0;
    this.reseedPopulation();
    this.log(`Roads updated: ${this.world.stats.lanes} lanes`);
  }

  reseedPopulation() {
    const size = this.cfg.evolution.population;
    if (!this.evolution.population.length) this.evolution.seed(null);
    if (!this.world.lanes.length) {
      this.agents = [];
      this.evolution.setPopulationSize(size);
      return;
    }
    this.evolution.setPopulationSize(size);
    while (this.agents.length < size) {
      this.agents.push(new Agent(this.world, this.navigator, this.evolution.brain, this.agents.length));
    }
    this.agents.length = size;
    this.agents.forEach((agent, i) => agent.loadGenome(this.evolution.population[i]));
    this.restartGeneration();
  }

  /**
   * Start a fresh run for every learner.
   *
   * Conditions are deterministic: the same lanes, the same traffic layout and
   * the same goals every generation. Fitness then measures driving skill rather
   * than luck, which is what makes selection able to find real progress.
   *
   * Which lane each car starts from rotates with the generation, so a genome is
   * never permanently parked on an easy stretch while its children are judged on
   * a hard one. `newScenario()` rolls a new set of conditions to check that a
   * champion generalises rather than memorising one benchmark.
   */
  restartGeneration() {
    const lanes = this.world.lanes;

    if (this.trial === 0) {
      this.accFitness = new Float32Array(this.agents.length);
      this.trialStats = [];
    }

    if (lanes.length) {
      // Every stream is seeded from (scenario, trial, index) alone. Nothing is
      // derived from a shared generator, so one car's run cannot depend on how
      // many random numbers its rivals happened to draw first.
      const base = (this.scenarioBase + this.trial * 7919) >>> 0;
      const placeRng = makeRng(base + 17);
      const rotation = (this.evolution.generation * 7) % Math.max(1, lanes.length);
      const order = lanes.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = placeRng.int(0, i);
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
      }
      for (const agent of this.agents) {
        agent.reset();
        agent.rng = makeRng(base + 101 + agent.index * 2654435761);
        agent.placeOn(lanes[order[(agent.index + rotation) % order.length]], placeRng);
        agent.newGoal(agent.rng);
      }
    }

    // Traffic is laid out last so it can steer clear of where the learners are
    // starting: a car parked on a learner's nose wastes the whole run.
    const starts = this.agents.map((a) => a.car);
    this.spawnTraffic(makeRng(((this.scenarioBase + this.trial * 7919) >>> 0) + 31), starts);
    this.generationTime = 0;
  }

  /** Roll a fresh benchmark: new spawn points, new traffic, new goals. */
  newScenario() {
    this.scenarioBase = (this.scenarioBase + 104729) >>> 0;
    this.log('New driving scenario');
    this.restartGeneration();
    return this.scenarioBase;
  }

  spawnTraffic(rng = this.rng.fork(555), avoid = null) {
    this.traffic = [];
    const count = this.cfg.traffic.count;
    const lanes = this.world.lanes;
    if (!lanes.length) return;
    const clearance = this.cfg.car.radius * 2 + 55;
    // Spread civilian traffic over distinct lanes so it does not pile up on one
    // road and block it for the whole run.
    const start = rng.int(0, lanes.length - 1);
    const stride = Math.max(1, Math.floor(lanes.length / Math.max(1, count)));
    for (let i = 0; i < count; i++) {
      const t = new TrafficCar(this.world, this.navigator, rng);
      t.cruise = rng.range(this.cfg.traffic.speedMin, this.cfg.traffic.speedMax);
      let placed = false;
      for (let attempt = 0; attempt < 6 && !placed; attempt++) {
        const lane = lanes[(start + (i + attempt) * stride) % lanes.length];
        if (!t.placeOn(lane, rng, 0.12 + attempt * 0.1, 0.65)) continue;
        if (avoid && avoid.some((c) => Math.hypot(c.x - t.car.x, c.y - t.car.y) < clearance)) continue;
        placed = true;
      }
      if (!placed) t.place(rng);
      this.traffic.push(t);
    }
  }

  setPopulationSize(n) {
    this.cfg.evolution.population = Math.max(4, Math.min(512, Math.floor(n)));
    const size = this.cfg.evolution.population;
    this.evolution.setPopulationSize(size);
    while (this.agents.length < size) {
      this.agents.push(new Agent(this.world, this.navigator, this.evolution.brain, this.agents.length));
    }
    this.agents.length = size;
    this.agents.forEach((agent, i) => agent.loadGenome(this.evolution.population[i]));
    this.restartGeneration();
  }

  setTrafficCount(n) {
    this.cfg.traffic.count = Math.max(0, Math.floor(n));
    this.spawnTraffic();
  }

  log(text) {
    this.events.unshift(text);
    if (this.events.length > 60) this.events.pop();
  }

  // ------------------------------------------------------------------- loop ---

  /** Advance by `dt` of simulated time. One fixed step. */
  step(dt = this.cfg.sim.dt) {
    if (!this.agents.length) return;
    const dyn = this.world.dynGrid;

    // Learners are evaluated independently: they share the roads and the
    // civilian traffic, but not each other. Otherwise fitness mostly measures
    // who got rammed by a bad driver rather than who can actually drive.
    for (const t of this.traffic) {
      if (t.step(dt)) this.recycleTraffic(t, this.eventRng);
    }
    dyn.clear();
    for (const t of this.traffic) dyn.insertCircle(t.car.x, t.car.y, t.radius, t.car);
    if (this.cfg.evolution.collideWithLearners) {
      for (const agent of this.agents) {
        if (agent.ended) continue;
        dyn.insertCircle(agent.car.x, agent.car.y, agent.car.radius, agent.car);
      }
    }

    for (const agent of this.agents) {
      if (agent.ended) continue;
      agent.think(dt, agent.rng || this.rng, this.assist);
    }

    for (const agent of this.agents) {
      if (agent.ended) continue;
      const impact = agent.car.collide(dyn);
      agent.score(dt, impact);
    }
    for (const t of this.traffic) t.car.collide(dyn);

    this.time += dt;
    this.generationTime += dt;

    if (this.generationTime > this.cfg.evolution.episodeTime + 0.5) {
      for (const agent of this.agents) if (!agent.ended) agent.end('timeout');
      this.finishGeneration();
    }
  }

  finishGeneration() {
    const trials = Math.max(1, this.cfg.evolution.trials);
    this.accFitness.forEach((v, i) => { this.accFitness[i] = v + this.agents[i].fitness; });
    this.trialStats.push({
      avgDistance: mean(this.agents.map((a) => a.distance)),
      avgGoals: mean(this.agents.map((a) => a.goalsReached)),
      reasons: this.agents.reduce((acc, a) => {
        acc[a.endReason || 'running'] = (acc[a.endReason || 'running'] || 0) + 1;
        return acc;
      }, {}),
    });

    this.trial++;
    if (this.trial < trials) {
      this.restartGeneration();
      return null;
    }
    this.trial = 0;

    const fitness = Array.from(this.accFitness, (v) => v / trials);
    const result = this.evolution.nextGeneration(fitness);
    this.lastResult = {
      ...result,
      trials,
      fitnesses: fitness,
      avgDistance: mean(this.trialStats.map((s) => s.avgDistance)),
      avgGoals: mean(this.trialStats.map((s) => s.avgGoals)),
      reasons: this.trialStats[this.trialStats.length - 1].reasons,
    };
    this.trialStats = [];
    this.agents.forEach((agent, i) => agent.loadGenome(this.evolution.population[i]));
    this.restartGeneration();
    return this.lastResult;
  }

  /** Drive `dtReal` seconds of wall time, honouring the speed multiplier. */
  update(dtReal, speedMultiplier = 1) {
    if (this.paused) return 0;
    const dt = this.cfg.sim.dt;
    this.accumulator += Math.min(dtReal, 0.1) * speedMultiplier;
    const maxSteps = this.cfg.sim.maxStepsPerFrame * Math.max(1, Math.ceil(speedMultiplier / 2));
    let steps = 0;
    while (this.accumulator >= dt && steps < maxSteps) {
      this.step(dt);
      this.accumulator -= dt;
      steps++;
    }
    if (steps >= maxSteps) this.accumulator = 0;
    return steps;
  }

  // ------------------------------------------------------------------ stats ---

  stats() {
    const live = this.agents.filter((a) => !a.ended);
    const ev = this.evolution;
    return {
      generation: ev.generation,
      best: ev.history.length ? ev.history[ev.history.length - 1].best : 0,
      avg: ev.history.length ? ev.history[ev.history.length - 1].avg : 0,
      champion: ev.championFitness === -Infinity ? 0 : ev.championFitness,
      live: live.length,
      population: this.agents.length,
      genTime: this.generationTime,
      episodeTime: this.cfg.evolution.episodeTime,
      lanes: this.world.stats.lanes,
      nodes: this.world.stats.nodes,
      roadLength: this.world.stats.length,
      traffic: this.traffic.length,
      avgSpeed: live.length ? mean(live.map((a) => a.car.speed)) : 0,
      onRoad: live.filter((a) => a.car.onRoad).length,
    };
  }

  /** The agent the camera should follow: currently the strongest alive car. */
  focusAgent(mode = 'leader') {
    if (!this.agents.length) return null;
    if (mode === 'random') return this.agents[Math.floor(Math.random() * this.agents.length)];
    if (mode === 'worst') {
      let worst = null;
      let worstF = Infinity;
      for (const a of this.agents) {
        if (a.ended) continue;
        if (a.fitness < worstF) {
          worstF = a.fitness;
          worst = a;
        }
      }
      return worst || this.agents[0];
    }
    let best = null;
    let bestScore = -Infinity;
    for (const a of this.agents) {
      if (a.ended) continue;
      const score = a.fitness + a.time * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best || this.agents[0];
  }
}
