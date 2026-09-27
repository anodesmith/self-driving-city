// Small math helpers shared by the simulation and the renderer.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const sqr = (v) => v * v;

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
export function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angle from `from` to `to`. */
export const angleDiff = (from, to) => wrapAngle(to - from);

export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** Squared distance from point p to segment ab. */
export function pointSegDistSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

export const pointSegDist = (px, py, ax, ay, bx, by) =>
  Math.sqrt(pointSegDistSq(px, py, ax, ay, bx, by));

/**
 * Ray (ox,oy) + t*(dx,dy) versus segment (ax,ay)->(bx,by).
 * Returns t >= 0 when the ray hits the segment, otherwise -1.
 */
export function raySegment(ox, oy, dx, dy, ax, ay, bx, by) {
  const sx = bx - ax;
  const sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (denom > -1e-9 && denom < 1e-9) return -1;
  const qx = ax - ox;
  const qy = ay - oy;
  const t = (qx * sy - qy * sx) / denom;
  if (t < 0) return -1;
  const u = (qx * dy - qy * dx) / denom;
  return u >= 0 && u <= 1 ? t : -1;
}

/** Ray versus circle; returns the nearest positive hit distance or -1. */
export function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const mx = ox - cx;
  const my = oy - cy;
  const b = mx * dx + my * dy;
  const c = mx * mx + my * my - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = 0;
  return t;
}

/** Evenly spaced samples along a polyline. */
export function resample(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg < 1e-6) continue;
    let travelled = spacing - carry;
    while (travelled <= seg) {
      const t = travelled / seg;
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
      travelled += spacing;
    }
    carry = seg - (travelled - spacing);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail.x, tail.y, last.x, last.y) > spacing * 0.35) out.push({ x: last.x, y: last.y });
  return out;
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  return total;
}

export function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
