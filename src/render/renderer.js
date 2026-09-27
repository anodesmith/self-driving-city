import { CONFIG } from '../config.js';
import { TAU, clamp, lerp } from '../core/math.js';
import { rand } from '../core/rng.js';

const PAL = CONFIG.palette;

/** Cached geometry so the road network is only rebuilt when it changes. */
class RoadLayer {
  constructor() {
    this.version = -1;
    this.edges = [];
  }

  build(world) {
    if (this.version === world.version) return;
    this.version = world.version;
    this.edges = [];
    const half = world.halfRoad;
    for (const edge of world.edges) {
      const centre = new Path2D();
      centre.moveTo(edge.a.x, edge.a.y);
      centre.lineTo(edge.b.x, edge.b.y);
      const ux = (edge.b.x - edge.a.x) / edge.length;
      const uy = (edge.b.y - edge.a.y) / edge.length;
      const nx = uy * half;
      const ny = -ux * half;
      const left = new Path2D();
      left.moveTo(edge.a.x + nx, edge.a.y + ny);
      left.lineTo(edge.b.x + nx, edge.b.y + ny);
      const right = new Path2D();
      right.moveTo(edge.a.x - nx, edge.a.y - ny);
      right.lineTo(edge.b.x - nx, edge.b.y - ny);
      const centreLine = new Path2D();
      centreLine.moveTo(edge.a.x, edge.a.y);
      centreLine.lineTo(edge.b.x, edge.b.y);
      this.edges.push({ edge, centre, left, right, centreLine });
    }
  }
}

export class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.roads = new RoadLayer();
    this.camera = { x: 0, y: 0, zoom: CONFIG.render.zoom };
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.grass = makeGrassPattern();
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
  }

  /** Frame the whole city, used for the overview camera. */
  frameWorld() {
    const w = this.sim.world;
    const zoom = Math.min(this.width / (w.width + 120), this.height / (w.height + 120));
    this.camera.zoom = clamp(zoom, 0.12, 1.2);
    this.camera.x = w.width / 2;
    this.camera.y = w.height / 2;
  }

  follow(car, dt) {
    if (!car) return;
    const rate = CONFIG.render.followRate;
    this.camera.x = lerp(this.camera.x, car.x, 1 - Math.exp(-rate * dt));
    this.camera.y = lerp(this.camera.y, car.y, 1 - Math.exp(-rate * dt));
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.camera.x) * this.camera.zoom + this.width / 2,
      y: (y - this.camera.y) * this.camera.zoom + this.height / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.width / 2) / this.camera.zoom + this.camera.x,
      y: (y - this.height / 2) / this.camera.zoom + this.camera.y,
    };
  }

  render(view) {
    const { sim, ctx } = this;
    const world = sim.world;
    this.roads.build(world);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = PAL.grass;
    ctx.fillRect(0, 0, this.width, this.height);

    const z = this.camera.zoom;
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(z, z);
    ctx.translate(-this.camera.x, -this.camera.y);

    if (view.showTerrain !== false) this.drawGround(ctx);
    this.drawRoads(ctx);
    if (view.showLanes) this.drawRoute(ctx, view.focus);
    if (view.showGoals) this.drawGoals(ctx);
    this.drawTraffic(ctx);
    this.drawAgents(ctx, view);
    if (view.showSensors && view.focus) this.drawSensors(ctx, view.focus);
    if (view.focus) this.drawFocusRing(ctx, view.focus);

    ctx.restore();
    this.drawOverlay(ctx, view);
  }

  drawGround(ctx) {
    if (!this.grass) return;
    const w = this.sim.world;
    ctx.save();
    ctx.fillStyle = this.grass;
    ctx.fillRect(0, 0, w.width, w.height);
    ctx.restore();
  }

  drawRoads(ctx) {
    const w = this.sim.world;
    const roads = this.roads.edges;

    // Verge, then asphalt: a wider stroke underneath reads as a shoulder.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PAL.kerb;
    ctx.lineWidth = w.halfRoad * 2 + 9;
    ctx.beginPath();
    for (const r of roads) ctx.stroke(r.centre);
    ctx.stroke();

    ctx.strokeStyle = PAL.asphalt;
    ctx.lineWidth = w.halfRoad * 2;
    ctx.beginPath();
    for (const r of roads) ctx.stroke(r.centre);
    ctx.stroke();

    // Dashed centre line and solid edge lines.
    ctx.strokeStyle = PAL.laneLine;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const r of roads) {
      ctx.stroke(r.left);
      ctx.stroke(r.right);
    }
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = PAL.centreLine;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([16, 18]);
    ctx.beginPath();
    for (const r of roads) ctx.stroke(r.centreLine);
    ctx.stroke();
    ctx.restore();
  }

  drawGoals(ctx) {
    const focus = this.sim.focusAgent('leader');
    const goal = focus && focus.follower.goal;
    if (!goal) return;
    const t = (performance.now() / 1000) % 2;
    ctx.save();
    ctx.strokeStyle = PAL.goal;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.85 - t * 0.3;
    ctx.beginPath();
    ctx.arc(goal.x, goal.y, 22 + t * 10, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = PAL.goal;
    ctx.beginPath();
    ctx.arc(goal.x, goal.y, 4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Dotted preview of the route the focused car intends to take. */
  drawRoute(ctx, agent) {
    if (!agent) return;
    const follower = agent.follower;
    ctx.save();
    ctx.strokeStyle = 'rgba(125,220,255,0.75)';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([2, 9]);
    ctx.beginPath();
    let lane = follower.lane;
    let s = follower.s;
    let remaining = 460;
    let p = this.sim.world.sampleLane(lane, s);
    ctx.moveTo(p.x, p.y);
    let hops = 0;
    while (remaining > 0 && hops++ < 6) {
      const left = lane.length - s;
      if (left <= remaining) {
        s = lane.length;
        const next = follower.nav.pickNext(lane, follower.goalId(), null);
        if (!next) break;
        lane = next;
        s = 0;
        remaining -= left;
      } else {
        s += remaining;
        remaining = 0;
      }
      p = this.sim.world.sampleLane(lane, s);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawTraffic(ctx) {
    for (const car of this.sim.traffic) {
      ctx.save();
      ctx.translate(car.car.x, car.car.y);
      ctx.rotate(car.car.heading);
      ctx.fillStyle = car.car.braking ? '#c96a5a' : PAL.traffic;
      ctx.fillRect(-car.radius * 1.35, -car.radius * 0.72, car.radius * 2.7, car.radius * 1.44);
      ctx.restore();
    }
  }

  drawAgents(ctx, view) {
    const cfg = this.sim.cfg.car;
    for (const agent of this.sim.agents) {
      const c = agent.car;
      if (view.onlyLeader && agent !== view.focus && agent.ended) continue;
      drawCar(ctx, c, cfg, agentBodyColour(agent, view.focus));
    }
  }

  drawSensors(ctx, agent) {
    const rays = agent.rays;
    ctx.save();
    ctx.lineWidth = 1.4;
    for (let i = 0; i < rays.length; i++) {
      const hit = rays[i];
      const a = agent.car.heading + rayAngle(i);
      const len = Math.min(hit.t, 205);
      ctx.strokeStyle = hit.kind === 2 ? 'rgba(255,120,120,0.75)' : 'rgba(150,220,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(agent.car.x, agent.car.y);
      ctx.lineTo(agent.car.x + Math.cos(a) * len, agent.car.y + Math.sin(a) * len);
      ctx.stroke();
      if (hit.t < 205) {
        ctx.fillStyle = hit.kind === 2 ? 'rgba(255,120,120,0.9)' : 'rgba(150,220,255,0.6)';
        ctx.beginPath();
        ctx.arc(agent.car.x + Math.cos(a) * hit.t, agent.car.y + Math.sin(a) * hit.t, 2.4, 0, TAU);
        ctx.fill();
      }
    }
    // Lookahead target
    const p = agent.follower.lookaheadPoint;
    ctx.fillStyle = 'rgba(255,220,120,0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawFocusRing(ctx, agent) {
    const c = agent.car;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 26, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawOverlay(ctx, view) {
    const agent = view.focus;
    if (!agent || !view.showReadout) return;
    const p = this.worldToScreen(agent.car.x, agent.car.y);
    const lines = [
      `${Math.round(Math.abs(agent.car.speed))} px/s`,
      `fitness ${agent.fitness.toFixed(0)}`,
      `steer ${agent.control.steer.toFixed(2)}  throttle ${agent.control.throttle.toFixed(2)}`,
      agent.ended ? `finished: ${agent.endReason}` : `t ${agent.time.toFixed(1)}s`,
    ];
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const wBox = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    // Sit the readout clear of the car it belongs to.
    const x = clamp(p.x + 30, 8, this.width - wBox - 8);
    const y = clamp(p.y + 22, 8, this.height - lines.length * 15 - 20);
    ctx.fillStyle = 'rgba(10,14,18,0.82)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, x, y, wBox, lines.length * 15 + 10, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dfe6ee';
    lines.forEach((line, i) => ctx.fillText(line, x + 8, y + 17 + i * 15));
    ctx.restore();
  }
}

// ------------------------------------------------------------------ helpers ---

function drawCar(ctx, c, cfg, colour) {
  const len = cfg.length;
  const wid = cfg.width;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.heading);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRect(ctx, -len / 2 + 1.5, -wid / 2 + 2, len, wid, 5);
  ctx.fill();

  // wheels
  ctx.fillStyle = '#14181d';
  const wx = len * 0.28;
  ctx.fillRect(wx - 4, -wid / 2 - 2.2, 8, 4.4);
  ctx.fillRect(wx - 4, wid / 2 - 2.2, 8, 4.4);
  ctx.fillRect(-wx - 4, -wid / 2 - 2.2, 8, 4.4);
  ctx.fillRect(-wx - 4, wid / 2 - 2.2, 8, 4.4);

  // body
  ctx.fillStyle = colour;
  roundRect(ctx, -len / 2, -wid / 2, len, wid, 5);
  ctx.fill();

  // cabin
  ctx.fillStyle = PAL.carGlass;
  roundRect(ctx, -len * 0.12, -wid / 2 + 2.2, len * 0.42, wid - 4.4, 3);
  ctx.fill();

  // brake lights
  if (c.braking) {
    ctx.fillStyle = '#ff5a4a';
    ctx.fillRect(-len / 2, -wid / 2 + 1.2, 2.6, 3.4);
    ctx.fillRect(-len / 2, wid / 2 - 4.6, 2.6, 3.4);
  }
  ctx.restore();
}

function agentBodyColour(agent, focus) {
  if (agent === focus) return '#ffd166';
  if (agent.ended) {
    const g = 90 + Math.round(Math.min(1, Math.abs(agent.fitness) / 200) * 40);
    return `rgb(${g},${g + 6},${g + 12})`;
  }
  // Hue tracks how well the car is currently doing, so the city reads at a glance.
  const t = clamp(agent.fitness / 260, 0, 1);
  return `hsl(${lerp(4, 145, t)} 62% ${lerp(42, 60, t)}%)`;
}

function rayAngle(i) {
  const spread = CONFIG.brain.raySpread * (Math.PI / 180);
  const n = CONFIG.brain.rayCount;
  return n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A small tiling noise texture so the grass is not a flat colour. */
function makeGrassPattern() {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = PAL.grass;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 340; i++) {
    const x = rand.next() * size;
    const y = rand.next() * size;
    const a = rand.next();
    g.fillStyle = a > 0.5 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.05)';
    g.fillRect(x, y, 1 + (a > 0.93 ? 1 : 0), 1);
  }
  return g.canvas;
}
