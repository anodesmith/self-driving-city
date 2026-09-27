/** Uniform bucket grid used for broad-phase queries (segments, samples, cars). */
export class SpatialGrid {
  constructor(cell = 96) {
    this.cell = cell;
    this.map = new Map();
  }

  clear() {
    this.map.clear();
  }

  key(cx, cy) {
    return cx * 73856093 ^ cy * 19349663;
  }

  insertAt(cx, cy, item) {
    const k = this.key(cx, cy);
    const bucket = this.map.get(k);
    if (bucket) bucket.push(item);
    else this.map.set(k, [item]);
  }

  /** Insert an item, covering every cell its bounding box touches. */
  insertAABB(minX, minY, maxX, maxY, item) {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const y0 = Math.floor(minY / c);
    const y1 = Math.floor(maxY / c);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) this.insertAt(cx, cy, item);
  }

  insertPoint(x, y, item) {
    this.insertAt(Math.floor(x / this.cell), Math.floor(y / this.cell), item);
  }

  insertCircle(x, y, r, item) {
    this.insertAABB(x - r, y - r, x + r, y + r, item);
  }

  bucketAt(cx, cy) {
    return this.map.get(this.key(cx, cy));
  }

  /** Visit every item stored in the cells overlapping the given box. */
  query(minX, minY, maxX, maxY, visit) {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const y0 = Math.floor(minY / c);
    const y1 = Math.floor(maxY / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.bucketAt(cx, cy);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) visit(bucket[i]);
      }
    }
  }

  queryRadius(x, y, r, visit) {
    this.query(x - r, y - r, x + r, y + r, visit);
  }
}

/**
 * Cast a ray against the static boundary segments of the world.
 * `self` is skipped, so a car never senses its own body as an obstacle.
 * Returns { t, kind } where kind 1 = road edge, 2 = car, 0 = nothing.
 */
export function castWorldRay(world, ox, oy, dx, dy, maxRange, dyn = null, self = null) {
  let bestT = maxRange;
  let kind = 0;

  const ex = ox + dx * maxRange;
  const ey = oy + dy * maxRange;
  const minX = Math.min(ox, ex);
  const maxX = Math.max(ox, ex);
  const minY = Math.min(oy, ey);
  const maxY = Math.max(oy, ey);

  world.segGrid.query(minX, minY, maxX, maxY, (seg) => {
    if (seg.open) return;
    const t = raySegLocal(ox, oy, dx, dy, seg);
    if (t >= 0 && t < bestT) {
      bestT = t;
      kind = 1;
    }
  });

  if (dyn) {
    const seen = dyn.queryCache;
    dyn.query(minX, minY, maxX, maxY, (actor) => {
      if (actor === self || seen.has(actor)) return;
      seen.add(actor);
      const t = rayCircleLocal(ox, oy, dx, dy, actor);
      if (t >= 0 && t < bestT) {
        bestT = t;
        kind = 2;
      }
    });
    seen.clear();
  }

  return { t: bestT, kind };
}

function raySegLocal(ox, oy, dx, dy, seg) {
  const sx = seg.bx - seg.ax;
  const sy = seg.by - seg.ay;
  const denom = dx * sy - dy * sx;
  if (denom > -1e-9 && denom < 1e-9) return -1;
  const qx = seg.ax - ox;
  const qy = seg.ay - oy;
  const t = (qx * sy - qy * sx) / denom;
  if (t < 0) return -1;
  const u = (qx * dy - qy * dx) / denom;
  return u >= 0 && u <= 1 ? t : -1;
}

/**
 * Ray versus circle. Returns the distance at which the ray leaves the circle.
 * A ray that starts inside a circle (which is the normal case for a car sensing
 * its own body) reports the far side, not a hit at zero distance.
 */
function rayCircleLocal(ox, oy, dx, dy, actor) {
  const mx = ox - actor.x;
  const my = oy - actor.y;
  const b = mx * dx + my * dy;
  const c = mx * mx + my * my - actor.r * actor.r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  if (c > 0 && b > 0) return -1; // pointing away from the circle
  const sq = Math.sqrt(disc);
  const near = -b - sq;
  const far = -b + sq;
  if (near >= 0) return near;
  return far >= 0 ? far : -1;
}
