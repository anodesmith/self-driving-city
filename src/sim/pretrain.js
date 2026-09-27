import { CONFIG } from '../config.js';
import { Brain } from './neural.js';
import { Car } from './car.js';
import { TrafficCar } from './agent.js';
import { LaneFollower } from './navigation.js';
import { castRays, gatherInputs, makeRayBuffer, INPUT_SIZE } from './sensors.js';
import { expertControl } from './expert.js';

/**
 * Behaviour cloning of the scripted expert.
 *
 * Random expert drives are recorded as (inputs -> actions) pairs, then a small
 * network is fitted to them with Adam. The result seeds the first generation so
 * evolution starts from "roughly competent" instead of "pure noise"; the
 * population then refines whatever the teacher got wrong.
 *
 * Work happens in `pump(ms)` slices so the browser stays responsive.
 */
export class Pretrainer {
  constructor(world, navigator, cfg = CONFIG, rng) {
    this.world = world;
    this.nav = navigator;
    this.cfg = cfg;
    this.rng = rng;
    this.brain = new Brain(INPUT_SIZE, cfg.brain.hidden, 2);
    this.episodes = 12;
    this.episodeTime = 15;
    this.epochs = 24;
    this.batch = 64;
    this.learningRate = 0.015;
    this.stride = 2;
    this.trafficCount = 5;

    this.inputs = [];
    this.outputs = [];
    this.collect = 0;
    this.trainCursor = 0;
    this.epoch = 0;
    this.tick = 0;
    this.t = 0;
    this.loss = 1;
    this.state = 'idle';
    this.log = [];
  }

  start() {
    this.inputs = [];
    this.outputs = [];
    this.collect = 0;
    this.epoch = 0;
    this.trainCursor = 0;
    this.tick = 0;
    this.t = 0;
    this.loss = 1;
    // Random init matters: with all-zero weights the hidden layers emit zero
    // activations, so their gradients are zero too and training can only ever
    // learn a constant output.
    this.brain.initRandom(this.rng, 1.1);
    this.brain.resetAdam();
    this.state = 'collecting';
    this.log = [];
    this.car = new Car(this.world);
    this.follower = new LaneFollower(this.world, this.nav, this.world.lanes[0], 0);
    this.rays = makeRayBuffer();
    this.inputBuf = new Float32Array(INPUT_SIZE);
    this.batchInputs = new Array(this.batch);
    this.batchOutputs = new Array(this.batch);
    this.traffic = [];
    for (let i = 0; i < this.trafficCount; i++) {
      const t = new TrafficCar(this.world, this.nav, this.rng);
      if (t.place(this.rng)) this.traffic.push(t);
    }
  }

  get trainSteps() {
    return this.epochs * Math.ceil(this.inputs.length / this.batch);
  }

  get progress() {
    if (this.state === 'idle') return 0;
    if (this.state === 'collecting') {
      const per = (this.episodeTime * 60) / this.stride;
      return clamp01(this.collect / (per * this.episodes)) * 0.45;
    }
    if (this.state === 'training') {
      return 0.45 + clamp01(this.trainCursor / Math.max(1, this.trainSteps)) * 0.55;
    }
    return 1;
  }

  /** Do up to `ms` milliseconds of work. Returns true when finished. */
  pump(ms) {
    if (this.state === 'idle') this.start();
    const now = typeof performance !== 'undefined' ? performance.now.bind(performance) : () => Date.now();
    const deadline = now() + ms;
    let guard = 0;
    while (now() < deadline && guard++ < 20000) {
      if (this.state === 'collecting') {
        this.stepEpisode();
        if (this.collect >= this.episodes) {
          this.shuffle();
          this.state = 'training';
        }
      } else if (this.state === 'training') {
        this.trainStep();
        if (this.epoch >= this.epochs) {
          this.state = 'done';
          this.log.push(`imitation loss ${this.loss.toFixed(4)}`);
          return true;
        }
      } else {
        return true;
      }
    }
    return false;
  }

  stepEpisode() {
    const dt = this.cfg.sim.dt;
    if (this.t === 0) this.spawnEpisode();

    // Broad phase for ray casts: the expert plus a little civilian traffic, so
    // the demonstrations contain "something is in front of me" situations.
    const dyn = this.world.dynGrid;
    dyn.clear();
    dyn.insertCircle(this.car.x, this.car.y, this.car.radius, this.car);
    for (const t of this.traffic) {
      t.step(dt);
      dyn.insertCircle(t.car.x, t.car.y, t.radius, t.car);
    }

    this.follower.advance(this.car);
    this.follower.signals(this.car, this.cfg.brain);
    castRays(this.rays, this.world, this.car);
    gatherInputs(this.inputBuf, this.world, this.car, this.follower, this.rays);
    const action = expertControl(this.car, this.follower, this.rays, this.world);

    if (this.car.onRoad) {
      this.inputs.push(Float32Array.from(this.inputBuf));
      this.outputs.push(Float32Array.from([action.steer, action.throttle]));
    }
    this.tick++;

    this.car.step(dt, action);
    this.car.collide(dyn);
    this.offRoadTime = this.car.onRoad ? 0 : (this.offRoadTime || 0) + dt;
    if (this.offRoadTime > 2.5) this.t = this.episodeTime;

    this.t += dt;
    if (this.t > this.episodeTime) {
      this.t = 0;
      this.tick = 0;
      this.collect++;
    }
  }

  spawnEpisode() {
    const spot = this.world.randomLanePoint(this.rng);
    if (!spot) {
      this.collect = this.episodes;
      return;
    }
    this.follower.lane = spot.lane;
    this.follower.s = spot.s;
    this.car.reset(spot.x, spot.y, Math.atan2(spot.ty, spot.tx), this.rng.range(70, 140));
    this.follower.signals(this.car, this.cfg.brain);
    for (const t of this.traffic) if (!t.place(this.rng)) t.place(this.rng);
  }

  shuffle() {
    const n = this.inputs.length;
    for (let i = n - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      const a = this.inputs[i];
      this.inputs[i] = this.inputs[j];
      this.inputs[j] = a;
      const b = this.outputs[i];
      this.outputs[i] = this.outputs[j];
      this.outputs[j] = b;
    }
    this.log.push(`${n} expert frames collected`);
  }

  trainStep() {
    const n = this.inputs.length;
    if (n < this.batch) {
      this.state = 'done';
      return;
    }
    for (let i = 0; i < this.batch; i++) {
      this.batchInputs[i] = this.inputs[this.trainCursor + i];
      this.batchOutputs[i] = this.outputs[this.trainCursor + i];
    }
    this.brain.trainBatch(this.batchInputs, this.batchOutputs, this.batch, this.learningRate);
    this.loss = this.loss * 0.9 + this.brain.lastLoss * 0.1;

    this.trainCursor += this.batch;
    if (this.trainCursor + this.batch > n) {
      this.trainCursor = 0;
      this.epoch++;
    }
  }

  get genome() {
    return this.brain.toArray();
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
