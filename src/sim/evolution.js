import { CONFIG } from '../config.js';
import { Brain, crossover, mutate, randomGenome } from './neural.js';
import { INPUT_SIZE } from './sensors.js';
import { mean } from '../core/math.js';

/**
 * Neuroevolution. Each genome is a flat Float32Array of network weights.
 * Selection is tournament based, elites survive untouched, and the rest are
 * children produced by blending two parents plus gaussian noise.
 */
export class Evolution {
  constructor(cfg = CONFIG, rng) {
    this.cfg = cfg;
    this.rng = rng;
    this.brain = new Brain(INPUT_SIZE, cfg.brain.hidden, 2);
    this.population = [];
    this.fitness = [];
    this.history = [];
    this.generation = 0;
    this.best = null;
    this.bestFitness = -Infinity;
    this.champion = null;
    this.championFitness = -Infinity;
    this.recentBest = [];
    this.totalSteps = 0;
  }

  get size() {
    return this.population.length;
  }

  /** Fill the population with random weights (or clones of a seed genome). */
  seed(seedGenome = null) {
    this.population = [];
    for (let i = 0; i < this.cfg.evolution.population; i++) {
      const g = seedGenome ? Float32Array.from(seedGenome) : randomGenome(this.brain, this.rng, 1.4);
      if (!seedGenome) {
        // Prior: a car wants to move. Without this, roughly half of all random
        // genomes have a permanently negative throttle, sit still for the whole
        // episode and score nothing — so evolution has to rediscover "press the
        // accelerator" before it can learn anything else. Braking is the easier
        // skill to learn from scratch.
        this.brain.setOutputBias(1, 0.7);
        this.brain.toArrayInto(g);
        mutate(g, this.rng, 0.25, 0.5, 0.03);
      }
      this.population.push(g);
    }
    this.generation = 0;
    this.best = seedGenome ? Float32Array.from(seedGenome) : Float32Array.from(this.population[0]);
    this.champion = Float32Array.from(this.population[0]);
    this.bestFitness = -Infinity;
    this.championFitness = -Infinity;
    this.history = [];
    this.recentBest = [];
  }

  /** Mix an extra genome (e.g. the cloned expert) into the starting pool. */
  inject(genome, copies = 4) {
    for (let i = 0; i < copies && i < this.population.length; i++) {
      const g = Float32Array.from(genome);
      mutate(g, this.rng, 0.08, 0.3, 0.02);
      this.population[i] = g;
    }
  }

  setPopulationSize(n) {
    const target = Math.max(4, Math.floor(n));
    while (this.population.length > target) this.population.pop();
    while (this.population.length < target) {
      const parent = this.population.length ? this.pickParent() : null;
      this.population.push(parent ? mutate(Float32Array.from(parent), this.rng, 0.2, 0.6, 0.05) : randomGenome(this.brain, this.rng));
    }
  }

  pickParent() {
    const size = this.population.length;
    let best = null;
    let bestFit = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = this.rng.int(0, size - 1);
      if (this.fitness[i] > bestFit) {
        bestFit = this.fitness[i];
        best = this.population[i];
      }
    }
    return best;
  }

  /** Record the results of a finished generation and breed the next one. */
  nextGeneration(fitness) {
    const ev = this.cfg.evolution;
    this.fitness = fitness.slice();
    this.totalSteps++;

    const order = fitness
      .map((f, i) => ({ f, i }))
      .sort((a, b) => b.f - a.f);

    const best = order[0];
    const bestFit = best ? best.f : 0;
    const avg = mean(fitness);
    const worst = order.length ? order[order.length - 1].f : 0;
    const eliteCount = Math.min(ev.elite, order.length);

    if (bestFit > this.championFitness) {
      this.championFitness = bestFit;
      this.champion = Float32Array.from(this.population[best.i]);
    }
    if (bestFit > this.bestFitness) {
      this.bestFitness = bestFit;
      this.best = Float32Array.from(this.population[best.i]);
    }
    this.recentBest.push(bestFit);
    if (this.recentBest.length > 12) this.recentBest.shift();

    this.history.push({ gen: this.generation + 1, best: bestFit, avg, worst });

    // --- breed ------------------------------------------------------------
    // Elites keep the population slot they already occupy. Slots are the
    // evaluation tracks (spawn point, route, traffic), so moving a genome to a
    // different slot would change its score and make progress look like noise.
    const size = this.population.length;
    const next = new Array(size).fill(null);
    for (let e = 0; e < eliteCount; e++) {
      const i = order[e].i;
      next[i] = Float32Array.from(this.population[i]);
    }

    const free = [];
    for (let i = 0; i < size; i++) if (!next[i]) free.push(i);

    const parents = order.map((o) => this.population[o.i]);
    for (const slot of free) {
      const a = this.selectByRank(order);
      const b = this.selectByRank(order);
      let child;
      if (this.rng.chance(ev.crossoverRate)) child = crossover(parents[a], parents[b], this.rng, ev.blendCrossover);
      else child = Float32Array.from(parents[a]);
      mutate(child, this.rng, ev.mutationRate, ev.mutationSigma, ev.bigMutationChance);
      next[slot] = child;
    }

    this.population = next;
    this.generation++;
    return { best: bestFit, avg, worst, champion: this.championFitness };
  }

  /** Rank-biased pick: better genomes are picked more often. */
  selectByRank(order) {
    const n = order.length;
    const roll = this.rng.next();
    const idx = Math.floor(Math.pow(roll, 2.2) * n);
    return Math.min(idx, n - 1);
  }

  get improvement() {
    if (this.history.length < 2) return 0;
    const a = this.history[0].best;
    const b = this.history[this.history.length - 1].best;
    if (!a) return 0;
    return (b - a) / Math.abs(a);
  }
}
