import { clamp } from '../core/math.js';
import { proximity, RAY_ANGLES, RAY_COUNT } from './sensors.js';

/**
 * A scripted driver: pure-pursuit steering, curvature-aware speed control and a
 * keep-your-distance rule for whatever is in front.
 *
 * It drives the teacher car, the civilian traffic and the demonstration runs
 * used for cloning, so all three behave like competent drivers and the traffic
 * cannot deadlock into a permanent jam in front of a learner.
 *
 * `opts.speedLimit` caps the target speed.
 */
export function expertControl(car, follower, rayHits, world, opts = {}) {
  const laneWidth = world.laneWidth;
  const pursuit = follower.headingError;
  const speedLimit = opts.speedLimit ?? world.cfg.car.maxSpeed * 0.44;

  // --- steering -----------------------------------------------------------
  // Positive steer turns towards +heading (clockwise on screen). The lateral
  // term has to push back towards the centreline, hence the minus sign.
  const lateralTerm = -clamp(follower.lateral / laneWidth, -2, 2) * 0.45;
  const steer = clamp(pursuit * 1.7 + lateralTerm - car.yawRate * 0.2, -1, 1);

  // --- speed target -------------------------------------------------------
  // Every term saturates, so no single one can drive the target to zero. In
  // particular the cross-track term must not scale with distance: a car that
  // has run off the road would otherwise be told to stop, and a stopped car has
  // no steering authority, so it could never get back on.
  let targetSpeed = speedLimit;
  targetSpeed -= 130 * Math.min(1, Math.abs(pursuit) / 0.9);
  targetSpeed -= 120 * Math.abs(follower.curvature);
  targetSpeed -= 14 * Math.min(1, Math.abs(follower.lateral) / laneWidth);

  // --- other cars ---------------------------------------------------------
  // Only cars count here, never the roadside. The road is 58px wide and the
  // ray fan is 116 degrees, so the rays at +/-19 degrees always hit the verge a
  // car's length ahead; braking for those would pin every car to a crawl.
  // Cornering speed is handled by the curvature term above, which is derived
  // from the map rather than from whatever happens to be nearby.
  let front = 0;
  let flank = 0;
  for (let i = 0; i < RAY_COUNT; i++) {
    if (rayHits[i].kind !== 2) continue;
    const a = Math.abs(RAY_ANGLES[i]);
    const p = proximity(rayHits[i].t);
    if (a <= 0.55) front = Math.max(front, p);
    else if (a < 1.3) flank = Math.max(flank, p);
  }
  // Hyperbolic rays mean this reaches zero while a gap still remains.
  if (front > 0.28) targetSpeed = Math.min(targetSpeed, Math.max(0, (0.52 - front) * 300));
  if (flank > 0.5) targetSpeed = Math.min(targetSpeed, Math.max(0, (0.5 - flank) * 260));

  targetSpeed = clamp(targetSpeed, 0, speedLimit);

  // --- throttle / brake ---------------------------------------------------
  // Gentle gain with a coast deadband: a hard P controller on a car whose brake
  // is twice as strong as its engine just buzzes between full gas and full stop.
  const error = targetSpeed - car.speed;
  let throttle = Math.abs(error) < 7 ? 0 : clamp(error * 0.16, -1, 1);

  // Steering authority comes from rolling forward, so a car that is pointing
  // the wrong way has to creep even when it would rather stop, otherwise it
  // deadlocks at a standstill with the wheels already turned.
  if (Math.abs(pursuit) > 0.5 && car.speed < 45 && front < 0.5) {
    throttle = Math.max(throttle, 0.32);
  }
  return { steer, throttle, targetSpeed, front, flank };
}
