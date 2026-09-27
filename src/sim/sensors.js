import { CONFIG } from '../config.js';
import { clamp, DEG } from '../core/math.js';

const cfg = CONFIG.brain;

export const RAY_COUNT = cfg.rayCount;
export const RAY_ANGLES = buildAngles(RAY_COUNT, cfg.raySpread * DEG);

/** Extra non-ray inputs appended after the ray block. */
const EXTRA = 7;
export const INPUT_SIZE = 1 + RAY_COUNT * 2 + EXTRA;

export const INPUT_LAYOUT = {
  bias: 0,
  ray: 1,
  extra: 1 + RAY_COUNT * 2,
};

function buildAngles(count, spread) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = count === 1 ? 0 : -spread / 2 + (spread * i) / (count - 1);
  }
  return out;
}

/** Hyperbolic proximity so both "a wall 10px away" and "clear for 200px" are readable. */
export function proximity(distance, range = cfg.rayRange, k = cfg.rayNormK) {
  return 1 / (1 + Math.max(0, distance) / k);
}

/**
 * Fill `out` with the network's input vector for a car.
 *
 *   [0]                     constant bias
 *   [1 + i*2]               ray i proximity (0..1)
 *   [2 + i*2]               ray i hit kind 0..1  (1 = another car)
 *   [-7] speed / maxSpeed
 *   [-6] heading error to the lane lookahead point
 *   [-5] lateral offset from the lane centre
 *   [-4] upcoming curvature
 *   [-3] junction proximity
 *   [-2] forward speed along the lane
 *   [-1] distance to the destination
 */
export function gatherInputs(out, world, car, follower, rayHits) {
  const b = cfg;
  out[0] = 1;

  for (let i = 0; i < RAY_COUNT; i++) {
    const hit = rayHits[i];
    out[1 + i * 2] = proximity(hit.t, b.rayRange);
    out[2 + i * 2] = hit.kind === 2 ? 1 : 0;
  }

  const e = INPUT_LAYOUT.extra;
  out[e + 0] = clamp(car.speed / world.cfg.car.maxSpeed, -1, 1);
  out[e + 1] = clamp(follower.headingError / (Math.PI / 2), -1, 1);
  out[e + 2] = clamp(follower.lateral / world.halfRoad, -1, 1);
  out[e + 3] = clamp(follower.curvature, -1, 1);
  out[e + 4] = follower.junctionAhead;
  out[e + 5] = clamp((car.speed * Math.cos(follower.headingError)) / world.cfg.car.maxSpeed, -1, 1);
  out[e + 6] = clamp(follower.goalDistance / 2000, 0, 1);
  return out;
}

/** Cast the sensor fan from the car's centre. */
export function castRays(out, world, car) {
  const range = cfg.rayRange;
  for (let i = 0; i < RAY_COUNT; i++) {
    const a = car.heading + RAY_ANGLES[i];
    out[i] = world.castRay(car.x, car.y, Math.cos(a), Math.sin(a), range, car);
  }
  return out;
}

export function makeRayBuffer() {
  return Array.from({ length: RAY_COUNT }, () => ({ t: cfg.rayRange, kind: 0 }));
}
