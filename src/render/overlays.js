/** Whole-city overview with live car dots and the current viewport. */
export class Minimap {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.version = -1;
    this.roads = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
  }

  build() {
    const world = this.sim.world;
    if (this.version === world.version) return;
    this.version = world.version;
    const path = new Path2D();
    for (const e of world.edges) {
      path.moveTo(e.a.x, e.a.y);
      path.lineTo(e.b.x, e.b.y);
    }
    this.roads = path;
    this.scale = Math.min(this.w / world.width, this.h / world.height);
    this.ox = (this.w - world.width * this.scale) / 2;
    this.oy = (this.h - world.height * this.scale) / 2;
  }

  render(view) {
    const { ctx, sim } = this;
    const world = sim.world;
    this.build();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(12,18,14,0.9)';
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);
    ctx.strokeStyle = 'rgba(150,160,175,0.55)';
    ctx.lineWidth = Math.max(2, world.halfRoad * 0.9);
    ctx.lineCap = 'round';
    ctx.stroke(this.roads);
    ctx.restore();

    const dot = (x, y, r, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(this.ox + x * this.scale, this.oy + y * this.scale, r, 0, Math.PI * 2);
      ctx.fill();
    };

    for (const t of sim.traffic) dot(t.car.x, t.car.y, 1.6, 'rgba(160,170,185,0.8)');
    for (const a of sim.agents) {
      if (a.ended) continue;
      const t = Math.max(0, Math.min(1, a.fitness / 260));
      dot(a.car.x, a.car.y, 2.1, `hsl(${4 + t * 141} 65% 55%)`);
    }
    if (view && view.focus) {
      const f = view.focus;
      dot(f.car.x, f.car.y, 3.4, '#ffd166');
      if (view.camera) {
        const c = view.camera;
        const halfW = (this.w / this.scale) * 0.5;
        const halfH = (this.h / this.scale) * 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          this.ox + (c.x - halfW) * this.scale,
          this.oy + (c.y - halfH) * this.scale,
          (halfW * 2) * this.scale,
          (halfH * 2) * this.scale,
        );
      }
    }
  }
}

/** Fitness history: champion, generation best and population average. */
export class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
  }

  render(history, champion) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(10,14,20,0.9)';
    ctx.fillRect(0, 0, this.w, this.h);

    const pad = { l: 30, r: 6, t: 8, b: 16 };
    const plotW = this.w - pad.l - pad.r;
    const plotH = this.h - pad.t - pad.b;

    if (!history.length) {
      ctx.fillStyle = 'rgba(200,210,225,0.4)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('waiting for the first generation…', pad.l, this.h / 2);
      return;
    }

    const n = history.length;
    let lo = 0;
    let hi = 0;
    for (const h of history) {
      hi = Math.max(hi, h.best, h.avg);
      lo = Math.min(lo, h.avg);
    }
    hi = Math.max(hi, champion || 0) * 1.12 || 1;
    lo = Math.min(lo, -10);
    const span = Math.max(1e-6, hi - lo);
    const x = (i) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => pad.t + plotH - ((v - lo) / span) * plotH;

    // zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(0));
    ctx.lineTo(pad.l + plotW, y(0));
    ctx.stroke();

    const line = (values, colour, width) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.beginPath();
      values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.stroke();
    };

    line(history.map((h) => h.avg), 'rgba(120,150,190,0.6)', 1.2);
    line(history.map((h) => h.best), '#7ddcff', 1.8);

    if (champion) {
      ctx.strokeStyle = 'rgba(255,209,102,0.9)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(pad.l, y(champion));
      ctx.lineTo(pad.l + plotW, y(champion));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = 'rgba(200,210,225,0.55)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(Math.round(hi), 2, pad.t + 7);
    ctx.fillText(Math.round(lo), 2, pad.t + plotH);
    ctx.fillText(`gen ${n}`, pad.l, this.h - 4);
    ctx.fillStyle = '#7ddcff';
    ctx.fillText('best', pad.l + 34, this.h - 4);
    ctx.fillStyle = 'rgba(120,150,190,0.9)';
    ctx.fillText('avg', pad.l + 60, this.h - 4);
    ctx.fillStyle = 'rgba(255,209,102,0.9)';
    ctx.fillText('champion', pad.l + 82, this.h - 4);
  }
}
