import { CONFIG } from '../config.js';
import { SpatialGrid, castWorldRay } from './spatial.js';
import { clamp, dist, dist2, pointSegDistSq, resample, wrapAngle } from '../core/math.js';

/**
 * Proper (interior) intersection test for two segments.
 * The signs must be strictly opposite, so segments that merely touch at a
 * shared junction do not count as crossing.
 */
function segmentsProperlyCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d2 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  const d3 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d4 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  const opposite = (p, q) => (p > 0 && q < 0) || (p < 0 && q > 0);
  return opposite(d1, d2) && opposite(d3, d4);
}

const cross = (ux, uy, vx, vy) => ux * vy - uy * vx;

/**
 * A road network made of junctions (nodes) and straight road segments (edges).
 * From the edges we derive:
 *   - directed lanes (one set per travel direction, right-hand traffic)
 *   - lane connections through junctions, used for navigation
 *   - boundary segments used for ray-cast sensors and collisions
 *   - a spatial index for "which lane am I on?" queries
 */
export class RoadWorld {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.width = cfg.world.width;
    this.height = cfg.world.height;
    this.nodes = [];
    this.edges = [];
    this.lanes = [];
    this.lanesFromNode = new Map();
    this.lanesToNode = new Map();
    this.segGrid = new SpatialGrid(90);
    this.laneGrid = new SpatialGrid(110);
    this.dynGrid = new SpatialGrid(110);
    this.dynGrid.queryCache = new Set();
    this.pads = new Map();
    this.version = 0;
    this.nextNodeId = 0;
    this.dirty = true;
    this.stats = { nodes: 0, edges: 0, lanes: 0, length: 0 };
  }

  get laneWidth() {
    return this.cfg.road.width / (2 * this.cfg.road.lanesPerDir);
  }

  get halfRoad() {
    return this.cfg.road.width / 2;
  }

  get junctionRadius() {
    return this.cfg.road.width * this.cfg.road.junctionPad;
  }

  addNode(x, y) {
    // Ids are monotonic and never reused, so anything holding a junction
    // reference stays valid even after deletions.
    const node = { id: this.nextNodeId++, x, y, degree: 0, edges: [] };
    this.nodes.push(node);
    this.touch();
    return node;
  }

  findNodeAt(x, y, r = 26) {
    let best = null;
    let bestD = r * r;
    for (const n of this.nodes) {
      const d = dist2(n.x, n.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** Closest junction to a segment, ignoring the given ids. Used by the editor. */
  findNodeNearSegment(ax, ay, bx, by, ignoreIds = [], r = 40) {
    let best = null;
    let bestD = r * r;
    for (const n of this.nodes) {
      if (ignoreIds.includes(n.id)) continue;
      const d = pointSegDistSq(n.x, n.y, ax, ay, bx, by);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * Add a road between two junctions.
   *
   * Roads that cross without meeting would drop a collision wall straight
   * across a lane, so the generator keeps the network planar. The road editor
   * passes `force` because openLaneObstructions() opens the wall at any lane
   * crossing, which makes a crossroads drivable even without a junction there.
   */
  addEdge(aId, bId, opts = {}) {
    if (aId === bId) return null;
    const key = aId < bId ? `${aId}-${bId}` : `${bId}-${aId}`;
    for (const e of this.edges) if (e.key === key) return e;
    const a = this.nodes[aId];
    const b = this.nodes[bId];
    if (!a || !b) return null;
    const length = dist(a.x, a.y, b.x, b.y);
    if (length < 40) return null;
    if (!opts.force && !this.canAddRoad(a.x, a.y, b.x, b.y, [aId, bId])) return null;

    const edge = { id: this.edges.length, key, a, b, length, width: this.cfg.road.width };
    this.edges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
    a.degree++;
    b.degree++;
    this.touch();
    return edge;
  }

  /**
   * Non-mutating test: could a road be laid from (ax,ay) to (bx,by)?
   * Used by the generator to try a junction before committing to it.
   */
  canAddRoad(ax, ay, bx, by, ignoreNodeIds = []) {
    const clearance = this.halfRoad * 2.6;
    const c2 = clearance * clearance;
    for (const n of this.nodes) {
      if (ignoreNodeIds.includes(n.id)) continue;
      if (pointSegDistSq(n.x, n.y, ax, ay, bx, by) < c2) return false;
    }
    for (const e of this.edges) {
      if (segmentsProperlyCross(ax, ay, bx, by, e.a.x, e.a.y, e.b.x, e.b.y)) return false;
    }
    return true;
  }

  removeNode(id) {
    const index = this.nodes.findIndex((n) => n.id === id);
    if (index < 0) return;
    const node = this.nodes[index];
    const doomed = new Set(node.edges);
    for (const other of this.nodes) other.edges = other.edges.filter((e) => !doomed.has(e));
    this.edges = this.edges.filter((e) => !doomed.has(e));
    this.edges.forEach((e, i) => { e.id = i; });
    this.nodes.splice(index, 1);
    this.touch();
  }

  removeEdge(aId, bId) {
    const key = aId < bId ? `${aId}-${bId}` : `${bId}-${aId}`;
    const edge = this.edges.find((e) => e.key === key);
    if (!edge) return;
    edge.a.edges = edge.a.edges.filter((e) => e !== edge);
    edge.b.edges = edge.b.edges.filter((e) => e !== edge);
    edge.a.degree--;
    edge.b.degree--;
    this.edges = this.edges.filter((e) => e !== edge);
    this.edges.forEach((e, i) => { e.id = i; });
    this.touch();
  }

  clear() {
    this.nodes = [];
    this.edges = [];
    this.nextNodeId = 0;
    this.touch();
  }

  touch() {
    this.dirty = true;
  }

  /** Rebuild every derived structure. Cheap enough to call on every edit. */
  rebuild() {
    if (!this.dirty) return;
    this.dirty = false;
    this.buildLanes();
    this.buildBoundaries();
    this.buildLaneIndex();
    this.pads = this.pads || new Map();
    this.version++;
    this.stats = {
      nodes: this.nodes.length,
      edges: this.edges.length,
      lanes: this.lanes.length,
      length: Math.round(this.edges.reduce((s, e) => s + e.length, 0)),
    };
  }

  // ---------------------------------------------------------------- lanes ---

  buildLanes() {
    this.lanes = [];
    this.lanesFromNode = new Map();
    this.lanesToNode = new Map();
    const { lanesPerDir } = this.cfg.road;
    const offsetStep = this.laneWidth;
    for (const edge of this.edges) {
      const ux = (edge.b.x - edge.a.x) / edge.length;
      const uy = (edge.b.y - edge.a.y) / edge.length;
      for (let dir = 0; dir < 2; dir++) {
        // dir 0: a -> b, dir 1: b -> a
        const from = dir === 0 ? edge.a : edge.b;
        const to = dir === 0 ? edge.b : edge.a;
        const dx = dir === 0 ? ux : -ux;
        const dy = dir === 0 ? uy : -uy;
        // Right-hand traffic: the right side of travel is (dy, -dx).
        const rx = dy;
        const ry = -dx;
        for (let l = 0; l < lanesPerDir; l++) {
          const off = (l + 0.5) * offsetStep;
          const sx = from.x + rx * off;
          const sy = from.y + ry * off;
          const ex = to.x + rx * off;
          const ey = to.y + ry * off;
          const pts = resample([{ x: sx, y: sy }, { x: ex, y: ey }], this.cfg.road.sampleSpacing);
          const lane = {
            id: this.lanes.length,
            edge,
            index: l,
            from,
            to,
            pts,
            length: 0,
            dirX: dx,
            dirY: dy,
            next: [],
          };
          let acc = 0;
          pts[0].s = 0;
          for (let i = 1; i < pts.length; i++) {
            acc += dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
            pts[i].s = acc;
          }
          lane.length = acc;
          this.lanes.push(lane);
        }
      }
    }

    for (const lane of this.lanes) {
      if (!this.lanesFromNode.has(lane.from.id)) this.lanesFromNode.set(lane.from.id, []);
      if (!this.lanesToNode.has(lane.to.id)) this.lanesToNode.set(lane.to.id, []);
      this.lanesFromNode.get(lane.from.id).push(lane);
      this.lanesToNode.get(lane.to.id).push(lane);
    }

    for (const lane of this.lanes) {
      lane.next = this.connectionsAt(lane.to, lane);
    }
  }

  /** All lanes leaving `node`, excluding a U-turn unless it is a dead end. */
  connectionsAt(node, fromLane) {
    const out = [];
    const options = this.lanesFromNode.get(node.id) || [];
    for (const lane of options) {
      if (fromLane && lane.edge === fromLane.edge && options.length > 1) continue;
      out.push(lane);
    }
    return out.length ? out : options;
  }

  // ----------------------------------------------------------- boundaries ---

  /**
   * How far the collision walls have to be pulled back where `edge` meets
   * `node`.
   *
   * A lane centreline sits laneWidth/2 inside the centreline, so it crosses the
   * *other* road's wall before the two walls meet. For two lines meeting at an
   * angle, that crossing is (d1 + d2) / (2 sin(angle/2)) away from the junction,
   * plus a margin for the sampling granularity. A dead end needs a little room
   * so a car can turn around; a straight-through needs none.
   */
  junctionPad(node, edge) {
    const entry = this.pads.get(node.id);
    if (!entry) return this.halfRoad;
    const pad = entry.byEdge.get(edge);
    return pad === undefined ? this.halfRoad : pad;
  }

  computePads() {
    this.pads = new Map();
    const laneOffset = this.laneWidth * 0.5;
    const margin = this.cfg.road.sampleSpacing * 1.6;
    for (const node of this.nodes) {
      const byEdge = new Map();
      let max = 0;
      for (const edge of node.edges) {
        let pad = this.halfRoad * (node.degree <= 1 ? 1.2 : 1);
        for (const other of node.edges) {
          if (other === edge) continue;
          const a = edge.a === node ? edge.b : edge.a;
          const b = other.a === node ? other.b : other.a;
          const angle = Math.abs(wrapAngle(
            Math.atan2(a.y - node.y, a.x - node.x) - Math.atan2(b.y - node.y, b.x - node.x),
          ));
          const turn = Math.PI - angle; // 0 = straight through, PI = folded back
          if (turn < 0.25) continue;
          const s = Math.sin(clamp(turn / 2, 0.12, 1.5));
          pad = Math.max(pad, (this.halfRoad + laneOffset) / (2 * s) + margin);
        }
        if (node.degree >= 3) pad = Math.max(pad, this.junctionRadius);
        pad = Math.min(pad, 220);
        byEdge.set(edge, pad);
        max = Math.max(max, pad);
      }
      this.pads.set(node.id, { byEdge, max });
    }
  }

  buildBoundaries() {
    this.segGrid.clear();
    const half = this.halfRoad;
    const spacing = this.cfg.road.sampleSpacing;
    this.computePads();

    const emit = (ax, ay, bx, by, open, edge) => {
      const seg = { ax, ay, bx, by, open, edge };
      this.segGrid.insertAABB(
        Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by),
        seg,
      );
      return seg;
    };

    for (const edge of this.edges) {
      const count = Math.max(2, Math.ceil(edge.length / spacing));
      for (let side = -1; side <= 1; side += 2) {
        let prev = null;
        for (let i = 0; i <= count; i++) {
          const t = i / count;
          const x = edge.a.x + (edge.b.x - edge.a.x) * t + (edge.b.y - edge.a.y) / edge.length * half * side;
          const y = edge.a.y + (edge.b.y - edge.a.y) * t - (edge.b.x - edge.a.x) / edge.length * half * side;
          if (prev) {
            // Distance-to-segment, not distance-to-midpoint: a segment that
            // straddles the edge of a junction opening must open entirely, or
            // a lane can still clip the leftover stub.
            const open = this.nearJunction(prev.x, prev.y, x, y, edge);
            emit(prev.x, prev.y, x, y, open, edge);
          }
          prev = { x, y };
        }
      }
    }

    // World border keeps cars from wandering off into empty space forever.
    const w = this.width;
    const h = this.height;
    emit(0, 0, w, 0, false, null);
    emit(w, 0, w, h, false, null);
    emit(w, h, 0, h, false, null);
    emit(0, h, 0, 0, false, null);

    this.openLaneObstructions();
  }

  /**
   * Safety net for the geometry: never leave a collision wall standing in the
   * path of a lane. The analytic junction pads handle ordinary crossings; this
   * exact pass covers awkward shapes the generator or the road editor can
   * produce, such as hairpin bends.
   *
   * It only opens walls that a lane genuinely crosses or ends against, so the
   * walls of the road the lane belongs to stay solid.
   */
  openLaneObstructions() {
    const radius = this.cfg.car.radius + 2;

    for (const lane of this.lanes) {
      for (let i = 1; i < lane.pts.length; i++) {
        const a = lane.pts[i - 1];
        const b = lane.pts[i];
        this.segGrid.query(
          Math.min(a.x, b.x) - 1, Math.min(a.y, b.y) - 1,
          Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1,
          (seg) => {
            if (seg.open || !seg.edge) return;
            if (segmentsProperlyCross(a.x, a.y, b.x, b.y, seg.ax, seg.ay, seg.bx, seg.by)) this.openSegment(seg);
          },
        );
      }

      // A lane that starts or ends jammed against a wall is un-drivable.
      for (const p of [lane.pts[0], lane.pts[lane.pts.length - 1]]) {
        this.segGrid.queryRadius(p.x, p.y, radius, (seg) => {
          if (seg.open || !seg.edge) return;
          if (pointSegDistSq(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by) < radius * radius) this.openSegment(seg);
        });
      }
    }
  }

  openSegment(seg) {
    seg.open = true;
    for (const node of [seg.edge.a, seg.edge.b]) {
      const entry = this.pads.get(node.id);
      if (!entry) continue;
      entry.max = Math.max(entry.max, this.laneWidth * 1.5);
    }
  }

  /** True when a boundary segment falls inside a junction's drivable opening. */
  nearJunction(ax, ay, bx = ax, by = ay, edge = null) {
    if (!this.pads || !edge) return false;
    for (const node of [edge.a, edge.b]) {
      const entry = this.pads.get(node.id);
      if (!entry) continue;
      const pad = entry.byEdge.get(edge);
      if (!pad || pad <= this.halfRoad) continue;
      if (pointSegDistSq(node.x, node.y, ax, ay, bx, by) < pad * pad) return true;
    }
    return false;
  }

  /** True when a point falls inside any junction's drivable opening. */
  inJunction(x, y) {
    if (!this.pads) return false;
    for (const n of this.nodes) {
      const entry = this.pads.get(n.id);
      if (!entry || !entry.max) continue;
      if (dist2(n.x, n.y, x, y) < entry.max * entry.max) return true;
    }
    return false;
  }

  // ---------------------------------------------------------- lane lookup ---

  buildLaneIndex() {
    this.laneGrid.clear();
    for (const lane of this.lanes) {
      for (const p of lane.pts) {
        this.laneGrid.insertPoint(p.x, p.y, { lane, s: p.s, x: p.x, y: p.y });
      }
    }
  }

  /** Closest lane sample to a world point, or null when the world has no lanes. */
  nearestLaneSample(x, y, maxRings = 6) {
    const cell = this.laneGrid.cell;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = null;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (ring > 0 && Math.abs(gx - cx) !== ring && Math.abs(gy - cy) !== ring) continue;
          const bucket = this.laneGrid.bucketAt(gx, gy);
          if (!bucket) continue;
          for (const s of bucket) {
            const d = dist2(x, y, s.x, s.y);
            if (d < bestD) {
              bestD = d;
              best = s;
            }
          }
        }
      }
      // A hit in this ring is close enough that a wider search cannot win by much.
      if (best && bestD < ring * cell * 0.75) break;
    }
    return best;
  }

  /** Point + unit tangent at arc-length `s` along a lane. */
  sampleLane(lane, s) {
    const pts = lane.pts;
    const sc = clamp(s, 0, lane.length);
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].s <= sc) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[Math.min(lo + 1, pts.length - 1)];
    const segLen = Math.max(1e-6, b.s - a.s);
    const t = clamp((sc - a.s) / segLen, 0, 1);
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      tx: lane.dirX,
      ty: lane.dirY,
    };
  }

  /** Follow a lane forward by `distance`, hopping through junctions as needed. */
  lookahead(lane, s, distance) {
    let curLane = lane;
    let curS = s;
    let left = distance;
    let hops = 0;
    let p = this.sampleLane(curLane, curS);
    while (left > 0 && hops < 4) {
      const remain = curLane.length - curS;
      if (left <= remain) {
        p = this.sampleLane(curLane, curS + left);
        left = 0;
      } else {
        left -= remain;
        const nexts = curLane.next;
        if (!nexts.length) {
          p = this.sampleLane(curLane, curLane.length);
          left = 0;
          break;
        }
        curLane = nexts[0];
        curS = 0;
        hops++;
        p = this.sampleLane(curLane, 0);
      }
    }
    return p;
  }

  isOnRoad(x, y) {
    const sample = this.nearestLaneSample(x, y);
    if (sample && dist2(x, y, sample.x, sample.y) <= this.halfRoad * this.halfRoad * 1.05) return true;
    return this.inJunction(x, y);
  }

  // ----------------------------------------------------------- collision ---

  castRay(x, y, dx, dy, range, self = null) {
    return castWorldRay(this, x, y, dx, dy, range, this.dynGrid, self);
  }

  /** Nearest static boundary within `r` of a point (used for car collisions). */
  boundaryDistance(x, y, r) {
    return this.closestBoundary(x, y, r).dist;
  }

  /** Nearest boundary point within `r`, as { dist, px, py } (dist = Infinity if none). */
  closestBoundary(x, y, r) {
    let best = Infinity;
    let px = 0;
    let py = 0;
    const r2 = r * r;
    this.segGrid.queryRadius(x, y, r, (seg) => {
      if (seg.open) return;
      const dx = seg.bx - seg.ax;
      const dy = seg.by - seg.ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 1e-9 ? ((x - seg.ax) * dx + (y - seg.ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = seg.ax + dx * t;
      const cy = seg.ay + dy * t;
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 < best) {
        best = d2;
        px = cx;
        py = cy;
      }
    });
    return best === Infinity ? { dist: Infinity, px, py } : { dist: Math.sqrt(Math.min(best, r2)), px, py };
  }

  // ------------------------------------------------------------- picking ---

  randomLanePoint(rng) {
    if (!this.lanes.length) return null;
    const lane = this.lanes[rng.int(0, this.lanes.length - 1)];
    const s = rng.range(Math.min(40, lane.length * 0.3), lane.length * 0.85);
    const p = this.sampleLane(lane, s);
    return { ...p, lane, s };
  }

  randomJunction(rng) {
    if (!this.nodes.length) return null;
    return this.nodes[rng.int(0, this.nodes.length - 1)];
  }

  graph() {
    // Adjacency for the connectivity check used by the generator and editor.
    return this.nodes.map((n) => n.edges.map((e) => (e.a === n ? e.b.id : e.a.id)));
  }
}
