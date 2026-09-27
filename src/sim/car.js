import { CONFIG } from '../config.js';
import { clamp, TAU } from '../core/math.js';

/**
 * Kinematic bicycle car with a collision circle. Simple, stable, and fast
 * enough to simulate a few thousand car-steps per frame.
 */
export class Car {
  constructor(world, cfg = CONFIG) {
    this.world = world;
    this.cfg = cfg.car;
    this.x = 0;
    this.y = 0;
    this.heading = 0;
    this.speed = 0;
    this.steer = 0;
    this.steerAngle = 0;
    this.yawRate = 0;
    this.onRoad = true;
    this.throttle = 0;
    this.braking = false;
    this.slip = 0;
    // Traffic can be set immovable so learners cannot shunt it: otherwise every
    // genome's score depends on the rest of the population, not just on itself.
    this.pushable = true;
  }

  get radius() {
    return this.cfg.radius;
  }

  reset(x, y, heading, speed = 0) {
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.speed = speed;
    this.steer = 0;
    this.steerAngle = 0;
    this.yawRate = 0;
    this.slip = 0;
  }

  /** @param {{steer:number, throttle:number}} control */
  step(dt, control) {
    const c = this.cfg;
    this.onRoad = this.world.isOnRoad(this.x, this.y);

    const steerTarget = control.steer * c.maxSteer;
    const steerRate = 4.2 * dt;
    this.steerAngle += clamp(steerTarget - this.steerAngle, -steerRate, steerRate);
    this.steer = control.steer;

    this.throttle = control.throttle;
    this.braking = control.throttle < -0.05;

    let accel;
    if (control.throttle >= 0) accel = c.accel * control.throttle;
    else accel = c.brake * control.throttle;

    // Reverse gear: a light brake just stops the car, you have to really ask
    // for reverse. Without this, cars creep backwards whenever they brake at
    // walking pace, which makes them look and behave like ghosts.
    if (control.throttle < 0 && this.speed < 14 && control.throttle > -0.8) accel = 0;

    if (!this.onRoad) {
      // Grass: heavy drag and a speed cap so straying off is punished but survivable.
      accel -= Math.sign(this.speed || 1) * c.grassDrag * this.speed * 0.5;
      this.speed = clamp(this.speed - Math.sign(this.speed) * 140 * dt, -90, 90);
    }

    this.speed += accel * dt;
    this.speed -= Math.sign(this.speed) * 12 * dt;              // rolling resistance
    this.speed -= 1.6 * this.speed * Math.abs(this.speed) * 1e-3 * dt; // air drag
    if (Math.abs(control.throttle) < 0.02) this.speed *= 1 - 1.2 * dt;
    this.speed = clamp(this.speed, -110, c.maxSpeed);

    this.yawRate = (this.speed / c.wheelBase) * Math.tan(this.steerAngle);
    this.heading += this.yawRate * dt;
    if (this.heading > Math.PI) this.heading -= TAU;
    else if (this.heading < -Math.PI) this.heading += TAU;

    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;
  }

  /**
   * Resolve the collision circle against road edges and other cars.
   * Returns the severity of the impact (0 = none) so the caller can penalise it.
   */
  collide(dynamics) {
    const r = this.radius;
    let impact = 0;

    const hit = this.world.closestBoundary(this.x, this.y, r + 3);
    if (hit && hit.dist < r) {
      const nx = this.x - hit.px;
      const ny = this.y - hit.py;
      const len = Math.hypot(nx, ny) || 1;
      const ux = nx / len;
      const uy = ny / len;
      this.x += ux * (r - hit.dist + 0.5);
      this.y += uy * (r - hit.dist + 0.5);
      // Bounce straight back along the direction of travel, but keep the
      // heading: spinning the car round would leave it facing the wrong way
      // with no way to recover.
      const speedMag = Math.abs(this.speed);
      impact = speedMag;
      const restitution = speedMag > this.cfg.crashSpeed ? 0.3 : 0.08;
      this.speed = -this.speed * restitution;
      this.slip = Math.min(1, speedMag / 200);
    }

    dynamics.queryRadius(this.x, this.y, r + 24, (other) => {
      if (other === this) return;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const d2 = dx * dx + dy * dy;
      const min = r + other.radius;
      if (d2 >= min * min || d2 < 1e-6) return;
      const d = Math.sqrt(d2);
      const push = (min - d) * 0.5;
      const ux = dx / d;
      const uy = dy / d;
      this.x += ux * push;
      this.y += uy * push;
      if (other.pushable) {
        other.x -= ux * push;
        other.y -= uy * push;
      }
      const closing = Math.abs(this.speed) + Math.abs(other.speed);
      if (closing > this.cfg.crashSpeed) {
        impact = Math.max(impact, closing * 0.5);
        this.speed *= 0.55;
        if (other.pushable) other.speed *= 0.55;
      } else {
        this.speed *= 0.92;
        if (other.pushable) other.speed *= 0.92;
      }
    });

    this.slip *= 0.9;
    return impact;
  }
}
