import { CONFIG } from '../config.js';
import { Car } from './car.js';
import { LaneFollower } from './navigation.js';
import { Brain } from './neural.js';
import { castRays, gatherInputs, makeRayBuffer, INPUT_SIZE } from './sensors.js';
import { expertControl } from './expert.js';
import { clamp } from '../core/math.js';

/**
 * One learner: a car, the lane it is following, its brain and its score.
 * This class is deliberately DOM-free so the headless test can run it in Node.
 */
export class Agent {
  constructor(world, navigator, brain, index) {
    this.world = world;
    this.nav = navigator;
    // Each car needs its own network: sharing one would mean the whole
    // population drives with whichever genome was loaded last.
    this.brain = brain ? brain.clone() : new Brain(INPUT_SIZE, CONFIG.brain.hidden, 2);
    this.genome = null;
    this.index = index;
    this.car = new Car(world);
    this.follower = new LaneFollower(world, navigator, world.lanes[0], 0);
    this.rays = makeRayBuffer();
    this.inputs = new Float32Array(INPUT_SIZE);
    this.control = { steer: 0, throttle: 0 };
    this.bestProgress = 0;
    this.reset();
  }

  loadGenome(genome) {
    this.brain.fromArray(genome);
    this.genome = genome;
  }

  /** Place the car on a given lane, at a random point along it. */
  placeOn(lane, rng, minS = 0.1, maxS = 0.85) {
    if (!lane) return false;
    const from = Math.min(lane.length * minS, lane.length - 30);
    const to = Math.max(from, lane.length * maxS);
    const s = rng.range(from, to);
    const spot = this.world.sampleLane(lane, s);
    this.follower.lane = lane;
    this.follower.s = s;
    this.follower.curvature = 0;
    this.follower.smoothSpeed = 0;
    this.car.reset(spot.x, spot.y, Math.atan2(spot.ty, spot.tx), rng.range(60, 130));
    this.follower.signals(this.car, CONFIG.brain);
    return true;
  }

  /** Place the car on a random lane heading somewhere plausible. */
  spawn(rng) {
    this.rng = rng;
    const spot = this.world.randomLanePoint(rng);
    if (!spot) return false;
    this.follower.lane = spot.lane;
    this.follower.s = spot.s;
    this.follower.curvature = 0;
    this.follower.smoothSpeed = 0;
    this.car.reset(spot.x, spot.y, Math.atan2(spot.ty, spot.tx), rng.range(60, 130));
    this.follower.signals(this.car, CONFIG.brain);
    return true;
  }

  reset() {
    this.time = 0;
    this.fitness = 0;
    this.offroadTime = 0;
    this.stuckTime = 0;
    this.crashes = 0;
    this.goalsReached = 0;
    this.progress = 0;
    this.topSpeed = 0;
    this.lateralSum = 0;
    this.distance = 0;
    this.ended = false;
    this.endReason = '';
    this.prevX = this.car.x;
    this.prevY = this.car.y;
  }

  newGoal(rng) {
    const node = this.world.randomJunction(rng);
    if (node) this.follower.setGoal(node);
  }

  /** Sense, decide and move. Collisions are resolved later by the simulation. */
  think(dt, rng, assist = 0) {
    const car = this.car;
    const follower = this.follower;

    if (!follower.goal) this.newGoal(rng);
    follower.advance(car);
    follower.signals(car, CONFIG.brain);
    castRays(this.rays, this.world, car);
    gatherInputs(this.inputs, this.world, car, follower, this.rays);

    const out = this.brain.forward(this.inputs);
    let steer = out[0];
    let throttle = out[1];
    if (!Number.isFinite(steer) || !Number.isFinite(throttle)) {
      steer = 0;
      throttle = 0;
    }

    if (assist > 0) {
      const teacher = expertControl(car, follower, this.rays, this.world);
      steer = steer * (1 - assist) + teacher.steer * assist;
      throttle = throttle * (1 - assist) + teacher.throttle * assist;
    }

    this.control.steer = clamp(steer, -1, 1);
    this.control.throttle = clamp(throttle, -1, 1);
    this.prevX = car.x;
    this.prevY = car.y;
    car.step(dt, this.control);
  }

  /** Score the step, and end the episode if the run is over. */
  score(dt, impact) {
    const car = this.car;
    const ev = CONFIG.evolution;
    this.time += dt;

    const dx = car.x - this.prevX;
    const dy = car.y - this.prevY;
    this.distance += Math.hypot(dx, dy);

    // Progress is measured along the lane, so a reversing car earns nothing.
    const forward = car.speed * Math.cos(this.follower.headingError);
    this.progress += forward * dt;
    this.fitness += forward * dt * 0.06;
    this.fitness += dt * 0.5;
    this.fitness -= Math.abs(car.yawRate) * dt * 0.55;

    if (!car.onRoad) {
      this.offroadTime += dt;
      this.fitness -= dt * 22;
    } else {
      this.offroadTime = Math.max(0, this.offroadTime - dt * 0.5);
    }

    if (impact > CONFIG.car.crashSpeed) {
      this.crashes++;
      this.fitness -= 30;
    }

    if (Math.abs(car.speed) < 6) this.stuckTime += dt;
    else this.stuckTime = 0;

    if (this.follower.goal && this.follower.goalDistance < 45) {
      this.goalsReached++;
      this.fitness += ev.goalReward;
      this.newGoal(this.rng);
    }

    if (this.offroadTime > ev.maxOffroad) return this.end('offroad');
    if (this.crashes > ev.maxCrashes) return this.end('crash');
    if (this.stuckTime > ev.maxStuck) return this.end('stuck');
    if (this.time > ev.episodeTime) return this.end('timeout');
    return false;
  }

  end(reason) {
    if (this.ended) return true;
    this.ended = true;
    this.endReason = reason;
    return true;
  }
}

/**
 * Civilian traffic. It follows the lanes with the same scripted driver as the
 * teacher, so it never becomes a permanent obstacle, and it is immovable to
 * learners so a learner's score depends on its own driving.
 */
export class TrafficCar {
  constructor(world, navigator, rng) {
    this.world = world;
    this.nav = navigator;
    this.car = new Car(world);
    this.car.pushable = false;
    this.follower = new LaneFollower(world, navigator, world.lanes[0], 0);
    this.rays = makeRayBuffer();
    this.cruise = rng ? rng.range(CONFIG.traffic.speedMin, CONFIG.traffic.speedMax) : 90;
    this.age = 0;
    this.stuckTime = 0;
    this.radius = CONFIG.car.radius;
  }

  place(rng) {
    const spot = this.world.randomLanePoint(rng);
    if (!spot) return false;
    this.follower.lane = spot.lane;
    this.follower.s = spot.s;
    this.follower.curvature = 0;
    this.follower.smoothSpeed = 0;
    this.car.reset(spot.x, spot.y, Math.atan2(spot.ty, spot.tx), this.cruise);
    this.follower.signals(this.car, CONFIG.brain);
    this.age = 0;
    this.stuckTime = 0;
    return true;
  }

  /** Put this car on a specific lane, partway along it. */
  placeOn(lane, rng, minS = 0.1, maxS = 0.85) {
    if (!lane) return false;
    const from = Math.min(lane.length * minS, Math.max(0, lane.length - 30));
    const to = Math.max(from, lane.length * maxS);
    const s = rng.range(from, to);
    const spot = this.world.sampleLane(lane, s);
    this.follower.lane = lane;
    this.follower.s = s;
    this.follower.curvature = 0;
    this.follower.smoothSpeed = 0;
    this.car.reset(spot.x, spot.y, Math.atan2(spot.ty, spot.tx), this.cruise);
    this.follower.signals(this.car, CONFIG.brain);
    this.age = 0;
    this.stuckTime = 0;
    return true;
  }

  step(dt) {
    const car = this.car;
    this.age += dt;
    this.follower.advance(car);
    this.follower.signals(car, CONFIG.brain);
    castRays(this.rays, this.world, car);

    const control = expertControl(car, this.follower, this.rays, this.world, { speedLimit: this.cruise });
    car.step(dt, control);

    // A car that has not moved for a few seconds is blocking a lane; tell the
    // simulation to put it somewhere else rather than let it jam the city.
    if (Math.abs(car.speed) < 5) this.stuckTime += dt;
    else this.stuckTime = 0;
    return this.stuckTime > 3.5;
  }
}
