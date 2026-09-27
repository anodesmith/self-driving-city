import { clamp, dist, angleDiff, smoothstep } from '../core/math.js';

/**
 * Goal-directed routing over the directed lane graph.
 *
 * For every goal junction we compute a cost-to-go field with a backwards
 * Dijkstra, then the next lane is simply the cheapest continuation. Fields are
 * cached per goal so a whole population shares the work.
 */
export class Navigator {
  constructor(world) {
    this.world = world;
    this.fields = new Map();
    this.turnPenalty = 55;
  }

  invalidate() {
    this.fields.clear();
  }

  fieldFor(goalNodeId) {
    let field = this.fields.get(goalNodeId);
    if (field) return field;
    const world = this.world;
    const lanes = world.lanes;
    const value = new Float32Array(lanes.length).fill(Infinity);

    // Seed: lanes that arrive at the goal are worth 0 from their end.
    for (const lane of lanes) if (lane.to.id === goalNodeId) value[lane.id] = 0;

    // Backwards Dijkstra over lanes: relaxing lane -> next in decreasing cost.
    const heap = new MinHeap();
    for (const lane of lanes) if (value[lane.id] === 0) heap.push(lane.id, 0);
    while (heap.size) {
      const { key: laneId, cost } = heap.pop();
      if (cost > value[laneId]) continue;
      const lane = lanes[laneId];
      for (const prev of world.lanesToNode.get(lane.from.id) || []) {
        if (prev.to !== lane.from) continue;
        const step = this.turnCost(prev, lane) + lane.length;
        const next = value[laneId] + step;
        if (next < value[prev.id] - 0.01) {
          value[prev.id] = next;
          heap.push(prev.id, next);
        }
      }
    }

    this.fields.set(goalNodeId, value);
    return value;
  }

  turnCost(from, to) {
    const turn = Math.abs(angleDiff(Math.atan2(from.dirY, from.dirX), Math.atan2(to.dirY, to.dirX)));
    return this.turnPenalty + turn * 90;
  }

  /**
   * Cheapest lane to take after finishing `lane` on the way to `goalNodeId`.
   * `heading` biases the choice towards the exit the car is already committed
   * to, so it does not swerve across an intersection to satisfy the route.
   */
  pickNext(lane, goalNodeId, heading = null) {
    if (!lane.next.length) return null;
    const value = this.fieldFor(goalNodeId);
    const want = heading === null ? Math.atan2(lane.dirY, lane.dirX) : heading;
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of lane.next) {
      const v = value[candidate.id];
      const route = Number.isFinite(v) ? 1 / (1 + v / 350) : 0.05;
      const turn = Math.abs(angleDiff(want, Math.atan2(candidate.dirY, candidate.dirX)));
      const score = route - turn * 0.9;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, val) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop() {
    const key = this.keys[0];
    const val = this.vals[0];
    const lastKey = this.keys.pop();
    const lastVal = this.vals.pop();
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.vals.length && this.vals[l] < this.vals[m]) m = l;
        if (r < this.vals.length && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return { key, val };
  }

  swap(a, b) {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

/**
 * Per-car state that keeps a car pinned to a lane: which lane it is on, how far
 * along it, and the guidance signals derived from that.
 */
export class LaneFollower {
  constructor(world, navigator, lane, s) {
    this.world = world;
    this.nav = navigator;
    this.lane = lane;
    this.s = s;
    this.goal = null;
    this.lateral = 0;
    this.headingError = 0;
    this.curvature = 0;
    this.junctionAhead = 0;
    this.distanceToEnd = 0;
    this.resyncs = 0;
    this.smoothSpeed = 0;
    this.lookaheadPoint = { x: 0, y: 0, tx: 1, ty: 0 };
    this.lookaheadDist = 0;
    this.goalDistance = 0;
  }

  setGoal(node) {
    this.goal = node;
  }

  goalId() {
    return this.goal ? this.goal.id : this.lane.to.id;
  }

  /**
   * Keep the car anchored to its lane.
   *
   * `s` is always the projection of the car onto the lane rather than an
   * integrated value, which makes the tracker self-correcting: a car that
   * spins, reverses or gets knocked sideways re-derives its own position
   * instead of drifting further and further out of sync with the map.
   */
  advance(car) {
    const world = this.world;
    const lane = this.lane;
    const p0 = lane.pts[0];
    const proj = (car.x - p0.x) * lane.dirX + (car.y - p0.y) * lane.dirY;

    if (proj > lane.length) {
      const next = this.nav.pickNext(lane, this.goalId(), car.heading);
      if (next) {
        this.lane = next;
        // Re-project onto the new lane from its own start. Carrying the old
        // projection over would be wrong by up to the size of the junction
        // whenever the road turns, which can leave the target behind the car.
        const q0 = next.pts[0];
        const moved = (car.x - q0.x) * next.dirX + (car.y - q0.y) * next.dirY;
        this.s = clamp(moved, 0, next.length);
      } else {
        this.s = lane.length;
      }
      return;
    }

    if (proj < 0) {
      // Reversed off the start of the lane (a spin, or a U-turn): fall back to
      // whatever piece of road the car is physically sitting on.
      const sample = world.nearestLaneSample(car.x, car.y);
      if (sample) {
        this.lane = sample.lane;
        this.s = sample.s;
        this.resyncs++;
        return;
      }
      this.s = 0;
      return;
    }

    this.s = proj;
  }

  /** Walk `distance` along the current route, following junctions as needed. */
  lookAhead(distance) {
    const world = this.world;
    let lane = this.lane;
    let s = this.s;
    let left = distance;
    let hops = 0;
    let p = world.sampleLane(lane, s);
    while (left > 0 && hops < 5) {
      const remain = lane.length - s;
      if (left <= remain) {
        p = world.sampleLane(lane, s + left);
        left = 0;
      } else {
        left -= remain;
        const next = this.nav.pickNext(lane, this.goalId(), null);
        if (!next) {
          p = world.sampleLane(lane, lane.length);
          left = 0;
          break;
        }
        lane = next;
        s = 0;
        hops++;
        p = world.sampleLane(lane, 0);
      }
    }
    return p;
  }

  /** Guidance signals for the brain and for the scripted expert. */
  signals(car, cfg) {
    const world = this.world;
    const here = world.sampleLane(this.lane, this.s);
    const remaining = this.lane.length - this.s;

    // Lookahead is driven by a smoothed speed, otherwise the controller and the
    // lookahead chase each other and the whole car starts oscillating.
    this.smoothSpeed += (Math.abs(car.speed) - this.smoothSpeed) * 0.12;

    // Pure pursuit must not aim past the end of the lane: a target point around
    // the corner makes the car brake and spin instead of driving into the junction.
    const want = cfg.lookaheadMin + this.smoothSpeed * cfg.lookaheadGain;
    const look = clamp(want, cfg.lookaheadMin, cfg.lookaheadMax);
    const ahead = this.lookAhead(Math.min(look, remaining + 45));
    const beyond = this.lookAhead(Math.min(look + 90, remaining + 150));

    const aimHere = Math.atan2(ahead.y - car.y, ahead.x - car.x);
    const aimBeyond = Math.atan2(beyond.y - ahead.y, beyond.x - ahead.x);

    // Sharpness of the road just ahead, measured on the raw route rather than
    // the blended aim, so it stays a reliable corner warning. Smoothed, because
    // it is a property of the map, not of the car.
    const turn = angleDiff(aimHere, aimBeyond);
    this.curvature += (clamp(turn / (Math.PI / 2), -1, 1) - this.curvature) * 0.15;

    // Ease the aim onto the next lane as the junction approaches. Snapping the
    // target 90 degrees sideways at the node is what makes cars run wide.
    let desired = aimHere;
    if (remaining < look + cfg.cornerBlend) {
      const next = this.nav.pickNext(this.lane, this.goalId(), null);
      if (next) {
        const nAhead = world.sampleLane(next, Math.min(look, next.length));
        const nextAim = Math.atan2(nAhead.y - car.y, nAhead.x - car.x);
        const w = smoothstep(clamp(1 - (remaining - look * 0.4) / cfg.cornerBlend, 0, 1));
        desired = aimHere + angleDiff(aimHere, nextAim) * w;
        this.aheadLane = next;
      }
    }

    this.headingError = angleDiff(car.heading, desired);

    // Signed offset from the lane centre. Screen coordinates are y-down, so a
    // positive value means the car sits to the right of the centreline.
    this.lateral = -here.ty * (car.x - here.x) + here.tx * (car.y - here.y);

    this.distanceToEnd = Math.max(0, remaining);
    this.junctionAhead = clamp(1 - remaining / 140, 0, 1);

    this.lookaheadPoint = ahead;
    this.lookaheadDist = look;
    this.goalDistance = this.goal ? dist(here.x, here.y, this.goal.x, this.goal.y) : 0;
    return this;
  }
}
