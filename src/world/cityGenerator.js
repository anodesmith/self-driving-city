import { CONFIG } from '../config.js';
import { RoadWorld } from './roadWorld.js';
import { dist2 } from '../core/math.js';

/**
 * Builds a road network that reads like a city rather than a web of highways.
 *
 * Junctions are scattered over a jittered grid, neighbouring junctions are
 * linked into blocks, a few diagonal avenues and long straights are added for
 * character, and any resulting pieces are stitched into one connected network.
 * Every road is planarity-checked as it is added, so roads only ever meet at
 * junctions and never cross without one.
 */
export function generateCity(rng, cfg = CONFIG, world = new RoadWorld(cfg)) {
  world.clear();
  const { width, height, cell, fill, edgeChance, diagonal, avenueChance, jitter } = cfg.world;
  const cols = Math.max(3, Math.floor(width / cell));
  const rows = Math.max(3, Math.floor(height / cell));
  const cellW = width / cols;
  const cellH = height / rows;
  const margin = cfg.road.width * 1.8;

  const occupied = new Map();
  const cx = (c) => c * cellW + cellW / 2;
  const cy = (r) => r * cellH + cellH / 2;
  const key = (c, r) => `${c},${r}`;

  // --- junctions ----------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!rng.chance(fill)) continue;
      const x = cx(c) + (rng.next() - 0.5) * jitter * cellW;
      const y = cy(r) + (rng.next() - 0.5) * jitter * cellH;
      if (x < margin || x > width - margin || y < margin || y > height - margin) continue;
      occupied.set(key(c, r), world.addNode(x, y));
    }
  }
  // Never leave a tiny network: seed a minimum spread if the dice were unkind.
  if (occupied.size < 8) {
    for (let r = 0; r < rows && occupied.size < 10; r += Math.max(1, rows - 2)) {
      for (let c = 0; c < cols; c += Math.max(1, cols - 2)) {
        if (!occupied.has(key(c, r))) occupied.set(key(c, r), world.addNode(cx(c), cy(r)));
      }
    }
  }

  const at = (c, r) => occupied.get(key(c, r));
  const link = (a, b) => (a && b ? world.addEdge(a.id, b.id) : null);

  // --- street grid --------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const here = at(c, r);
      if (!here) continue;
      if (c + 1 < cols && rng.chance(edgeChance)) link(here, at(c + 1, r));
      if (r + 1 < rows && rng.chance(edgeChance)) link(here, at(c, r + 1));
      if (c + 1 < cols && r + 1 < rows && rng.chance(diagonal)) link(here, at(c + 1, r + 1));
      if (c > 0 && r + 1 < rows && rng.chance(diagonal * 0.6)) link(here, at(c - 1, r + 1));
    }
  }

  // --- long avenues for character ----------------------------------------
  const nodes = [...occupied.values()];
  const avenues = Math.round(nodes.length * avenueChance);
  for (let i = 0; i < avenues; i++) {
    const a = nodes[rng.int(0, nodes.length - 1)];
    const b = nodes[rng.int(0, nodes.length - 1)];
    if (a === b) continue;
    if (!world.canAddRoad(a.x, a.y, b.x, b.y, [a.id, b.id])) continue;
    world.addEdge(a.id, b.id);
  }

  // --- one connected network ---------------------------------------------
  stitch(world);

  // A ring road on the boundary gives long uninterrupted runs.
  if (rng.chance(0.6)) {
    for (let r = 0; r < rows; r++) link(at(0, r), at(0, r + 1));
    for (let c = 0; c < cols; c++) link(at(c, 0), at(c + 1, 0));
  }

  world.rebuild();
  return world;
}

/** Connect separate road components with the shortest links that stay planar. */
function stitch(world) {
  for (let pass = 0; pass < 12; pass++) {
    const parts = components(world);
    if (parts.length <= 1) break;
    parts.sort((a, b) => b.length - a.length);
    const main = parts[0];
    for (let i = 1; i < parts.length; i++) {
      let best = null;
      let bestD = Infinity;
      for (const a of main) {
        for (const b of parts[i]) {
          const d = dist2(a.x, a.y, b.x, b.y);
          if (d >= bestD) continue;
          if (!world.canAddRoad(a.x, a.y, b.x, b.y, [a.id, b.id])) continue;
          bestD = d;
          best = [a, b];
        }
      }
      if (best) {
        world.addEdge(best[0].id, best[1].id);
        main.push(best[1]);
      }
    }
  }
}

function components(world) {
  const seen = new Set();
  const out = [];
  for (const n of world.nodes) {
    if (seen.has(n.id)) continue;
    const group = [];
    const stack = [n];
    seen.add(n.id);
    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      for (const e of cur.edges) {
        const other = e.a === cur ? e.b : e.a;
        if (!seen.has(other.id)) {
          seen.add(other.id);
          stack.push(other);
        }
      }
    }
    out.push(group);
  }
  return out.filter((g) => g.length);
}

/** Removes junctions that ended up with no roads (can happen after editing). */
export function pruneOrphans(world, minDegree = 1) {
  for (const node of [...world.nodes]) {
    if (node.degree < minDegree) world.removeNode(node.id);
  }
  world.rebuild();
  return world;
}
