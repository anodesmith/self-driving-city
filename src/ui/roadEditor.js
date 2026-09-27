import { CONFIG } from '../config.js';

/**
 * Interactive road builder.
 *
 * Roads snap to a grid: while dragging, every grid cell the cursor enters
 * becomes a junction and is linked to the previous one. That guarantees a
 * connected, planar network no matter how messy the drag, and the cars keep
 * driving on it the moment it is rebuilt.
 */
export class RoadEditor {
  constructor(sim, renderer, hooks = {}) {
    this.sim = sim;
    this.renderer = renderer;
    this.hooks = hooks;
    this.active = false;
    this.tool = 'draw';
    this.cell = 90;
    this.hover = null;
    this.dragging = false;
    this.lastCell = null;
    this.pending = 0;
    this.preview = [];
    this.bind();
  }

  bind() {
    const canvas = this.renderer.canvas;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    canvas.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });
  }

  setActive(on) {
    this.active = on;
    this.dragging = false;
    this.preview = [];
    this.lastCell = null;
    this.renderer.canvas.style.cursor = on ? 'crosshair' : 'default';
    if (!on) this.commit();
  }

  pointer(e) {
    const rect = this.renderer.canvas.getBoundingClientRect();
    return this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  cellAt(x, y) {
    return { c: Math.round(x / this.cell), r: Math.round(y / this.cell) };
  }

  cellCentre(cell) {
    return { x: cell.c * this.cell, y: cell.r * this.cell };
  }

  onDown(e) {
    if (!this.active) return;
    const p = this.pointer(e);
    const cell = this.cellAt(p.x, p.y);
    if (e.button === 2 || this.tool === 'erase') {
      this.eraseAt(p);
      this.dragging = true;
      return;
    }
    this.dragging = true;
    this.lastCell = null;
    this.extendTo(cell);
  }

  onMove(e) {
    if (!this.active) return;
    const p = this.pointer(e);
    this.hover = p;
    if (!this.dragging) return;
    this.extendTo(this.cellAt(p.x, p.y));
  }

  onUp() {
    if (!this.active) return;
    this.dragging = false;
    this.commit();
  }

  nodeAtCell(cell) {
    if (!cell) return null;
    const p = this.cellCentre(cell);
    return this.sim.world.findNodeAt(p.x, p.y, this.cell * 0.5);
  }

  /**
   * Extend the road being drawn to `cell`.
   *
   * The new junction goes at the cell centre, but if the segment runs close to
   * a junction that already exists we join that one instead — so drawing across
   * the city connects to it rather than being refused.
   */
  extendTo(cell) {
    if (!cell) return;
    if (this.lastCell && cell.c === this.lastCell.c && cell.r === this.lastCell.r) return;
    const world = this.sim.world;
    const point = this.cellCentre(cell);
    const anchor = this.nodeAtCell(this.lastCell);
    const fromX = anchor ? anchor.x : point.x;
    const fromY = anchor ? anchor.y : point.y;

    let node = anchor ? world.findNodeNearSegment(fromX, fromY, point.x, point.y, [anchor.id], this.cell * 0.55)
      : world.findNodeAt(point.x, point.y, this.cell * 0.5);

    if (!node) node = world.addNode(point.x, point.y);
    if (anchor && anchor !== node) world.addEdge(anchor.id, node.id, { force: true });

    this.lastCell = cell;
    this.preview.push(point);
    this.pending++;
    world.touch();
    world.rebuild();
  }

  eraseAt(p) {
    const world = this.sim.world;
    const node = world.findNodeAt(p.x, p.y, this.cell * 0.5);
    if (node) {
      world.removeNode(node.id);
    } else {
      const edge = nearestEdge(world, p, this.cell * 0.4);
      if (edge) world.removeEdge(edge.a.id, edge.b.id);
    }
    world.rebuild();
    this.pending++;
  }
  commit() {
    if (!this.pending) return;
    const n = this.pending;
    this.pending = 0;
    this.preview = [];
    this.sim.onWorldEdited();
    this.hooks.onChange && this.hooks.onChange(n);
  }

  /** Called by the renderer to draw the in-progress road. */
  draw(ctx) {
    if (!this.active) return;
    if (this.preview.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(125,220,255,0.9)';
      ctx.lineWidth = CONFIG.road.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.preview.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();
    }
    if (this.hover && !this.dragging) {
      const c = this.cellCentre(this.cellAt(this.hover.x, this.hover.y));
      ctx.save();
      ctx.strokeStyle = this.tool === 'erase' ? 'rgba(255,120,120,0.8)' : 'rgba(125,220,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(c.x - this.cell / 2, c.y - this.cell / 2, this.cell, this.cell);
      ctx.restore();
    }
  }
}

function nearestEdge(world, p, maxDist) {
  let best = null;
  let bestD = maxDist;
  for (const e of world.edges) {
    const d = pointSegDist(p.x, p.y, e.a.x, e.a.y, e.b.x, e.b.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
