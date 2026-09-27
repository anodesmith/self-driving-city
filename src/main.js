import { CONFIG, CONFIG_DEFAULTS } from './config.js';
import { Simulation } from './sim/simulation.js';
import { Renderer } from './render/renderer.js';
import { Minimap, Chart } from './render/overlays.js';
import { RoadEditor } from './ui/roadEditor.js';
import { button, slider, select, checkbox, el } from './ui/controls.js';
import { clamp } from './core/math.js';
import { pruneOrphans } from './world/cityGenerator.js';

Object.assign(CONFIG, structuredClone(CONFIG_DEFAULTS));

const canvas = document.getElementById('view');
const sim = new Simulation(CONFIG, CONFIG.seed + Math.floor(Math.random() * 100000));
const renderer = new Renderer(canvas, sim);
const minimap = new Minimap(document.getElementById('minimap'), sim);
const chart = new Chart(document.getElementById('chart'));
const statsEl = document.getElementById('stats');
const genFill = document.getElementById('genbar-fill');
const genLabel = document.getElementById('genbar-label');
const toastEl = document.getElementById('toast');

const view = {
  focus: null,
  focusMode: 'leader',
  showSensors: true,
  showLanes: true,
  showGoals: true,
  showTerrain: true,
  showReadout: true,
  onlyLeader: false,
  camera: renderer.camera,
};

const editor = new RoadEditor(sim, renderer, {
  onChange: (n) => {
    toast(`${n} road ${n === 1 ? 'piece' : 'pieces'} built — cars are learning on your network`);
    view.focus = sim.focusAgent(view.focusMode);
  },
});

let speed = 4;
let pretraining = false;
let assist = 0;

// Exposed so the simulation can be driven and inspected from the console.
window.selfDriving = {
  sim,
  renderer,
  minimap,
  chart,
  view,
  editor,
  CONFIG,
  tick,
  finishPretraining,
  get pretraining() { return pretraining; },
  get speed() { return speed; },
  set speed(v) { speed = v; },
};

// --------------------------------------------------------------------- boot ---

view.focus = sim.focusAgent('leader');
if (view.focus) {
  renderer.camera.x = view.focus.car.x;
  renderer.camera.y = view.focus.car.y;
}
buildUI();
showHelp();
requestAnimationFrame(loop);

// ----------------------------------------------------------------- main loop ---

let lastTime = performance.now();

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  tick(dt);
  requestAnimationFrame(loop);
}

/** One step of simulation plus one repaint. */
function tick(dt) {
  if (pretraining) {
    if (sim.pretrainer.pump(10)) finishPretraining();
    paintPretrainProgress();
  } else {
    sim.update(dt, sim.paused ? 0 : speed);
  }

  view.focus = view.focusMode === 'free' ? view.focus : sim.focusAgent(view.focusMode);
  if (view.focusMode === 'overview') renderer.frameWorld();
  else renderer.follow(view.focus ? view.focus.car : null, dt);

  renderer.render(view);
  editor.draw(renderer.ctx);
  minimap.render(view);
  chart.render(sim.evolution.history, sim.evolution.championFitness === -Infinity ? 0 : sim.evolution.championFitness);
  paintStats();
}

function paintStats() {
  const s = sim.stats();
  const pre = pretraining ? sim.pretrainer.progress : 0;
  if (pretraining) {
    genFill.style.right = `${(1 - pre) * 100}%`;
    genLabel.textContent = `learning from the expert… ${Math.round(pre * 100)}%`;
  } else {
    const p = clamp(s.genTime / s.episodeTime, 0, 1);
    genFill.style.right = `${(1 - p) * 100}%`;
    const trial = sim.trial + 1;
    genLabel.textContent = sim.trialStats && sim.trialStats.length
      ? `gen ${s.generation} · run ${trial}/${CONFIG.evolution.trials}`
      : `gen ${s.generation}`;
  }

  statsEl.replaceChildren(
    stat('gen', s.generation, 'accent'),
    stat('best', s.best.toFixed(0)),
    stat('champion', s.champion.toFixed(0), 'warm'),
    stat('avg', s.avg.toFixed(0)),
    stat('cars', `${s.onRoad}/${s.live}`),
    stat('speed', s.avgSpeed.toFixed(0)),
    stat('roads', `${s.nodes}j ${s.lanes}l`),
  );
}

function stat(label, value, cls) {
  const d = el('div', `stat${cls ? ` ${cls}` : ''}`);
  d.append(el('b', null, value), el('span', null, label));
  return d;
}

let toastTimer = 0;
function toast(text, ms = 2600) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// ----------------------------------------------------------------- pretrain ---

function startPretraining() {
  pretraining = true;
  sim.paused = true;
  sim.pretrainer.start();
  document.getElementById('btn-pretrain').disabled = true;
  document.getElementById('learn-note').textContent =
    'Recording expert drives and fitting a network to them…';
}

function paintPretrainProgress() {
  const pre = sim.pretrainer;
  document.getElementById('learn-note').textContent = pre.state === 'collecting'
    ? `Recording expert demonstrations (${pre.inputs.length} frames)…`
    : `Fitting the cloned network (epoch ${pre.epoch}/${pre.epochs}, loss ${pre.loss.toFixed(3)})…`;
}

function finishPretraining() {
  const pre = sim.pretrainer;
  sim.evolution.seed();
  sim.evolution.inject(pre.genome, Math.max(4, Math.floor(CONFIG.evolution.population * 0.3)));
  sim.reseedPopulation();
  pretraining = false;
  sim.paused = false;
  document.getElementById('btn-pretrain').disabled = false;
  document.getElementById('learn-note').textContent =
    `Cloned the expert from ${pre.inputs.length} frames (loss ${pre.loss.toFixed(3)}). The population starts from this and evolves beyond it.`;
  toast('Population seeded with the cloned expert');
}

if (CONFIG.brain.pretrain) startPretraining();

// ----------------------------------------------------------------------- UI ---

function buildUI() {
  const simC = document.getElementById('sim-controls');
  slider(simC, {
    label: 'speed', min: 1, max: 24, step: 1, value: speed,
    onChange: (v) => { speed = v; },
  });  slider(simC, {
    label: 'zoom', min: 0.25, max: 2.2, step: 0.05, value: renderer.camera.zoom,
    onChange: (v) => { renderer.camera.zoom = v; },
  });
  slider(simC, {
    label: 'traffic cars', min: 0, max: 60, step: 1, value: CONFIG.traffic.count,
    onChange: (v) => sim.setTrafficCount(v),
  });

  const learn = document.getElementById('learn-controls');
  slider(learn, {
    label: 'population', min: 8, max: 192, step: 4, value: CONFIG.evolution.population,
    onChange: (v) => sim.setPopulationSize(v),
  });
  slider(learn, {
    label: 'runs per generation', min: 1, max: 6, step: 1, value: CONFIG.evolution.trials,
    onChange: (v) => { CONFIG.evolution.trials = v; },
  });
  slider(learn, {
    label: 'episode seconds', min: 8, max: 60, step: 1, value: CONFIG.evolution.episodeTime,
    onChange: (v) => { CONFIG.evolution.episodeTime = v; },
  });
  slider(learn, {
    label: 'mutation', min: 0, max: 0.6, step: 0.01, value: CONFIG.evolution.mutationSigma,
    onChange: (v) => { CONFIG.evolution.mutationSigma = v; },
  });
  slider(learn, {
    label: 'elite kept', min: 1, max: 32, step: 1, value: CONFIG.evolution.elite,
    onChange: (v) => { CONFIG.evolution.elite = v; },
  });
  slider(learn, {
    label: 'teacher assist', min: 0, max: 1, step: 0.05, value: 0,
    onChange: (v) => {
      assist = v;
      sim.assist = v;
      document.getElementById('btn-teach').classList.toggle('on', v > 0);
    },
  });

  const viewC = document.getElementById('view-controls');
  select(viewC, {
    label: 'camera follows',
    value: 'leader',
    options: [
      { value: 'leader', label: 'current leader' },
      { value: 'random', label: 'a random car' },
      { value: 'worst', label: 'the worst car' },
      { value: 'overview', label: 'whole city' },
      { value: 'free', label: 'free (drag not bound)' },
    ],
    onChange: (v) => {
      view.focusMode = v;
      if (v === 'overview') renderer.frameWorld();
    },
  });
  checkbox(viewC, 'range-finder rays', view.showSensors, (v) => { view.showSensors = v; });
  checkbox(viewC, 'intended route', view.showLanes, (v) => { view.showLanes = v; });
  checkbox(viewC, 'destination marker', view.showGoals, (v) => { view.showGoals = v; });
  checkbox(viewC, 'car telemetry', view.showReadout, (v) => { view.showReadout = v; });
  checkbox(viewC, 'hide finished cars', view.onlyLeader, (v) => { view.onlyLeader = v; });

  button('btn-pause', 'Pause', togglePause, 'primary');
  button('btn-step', 'Step gen', () => {
    if (sim.paused) {
      const target = sim.evolution.generation + 1;
      let guard = 0;
      while (sim.evolution.generation < target && guard++ < 400000) sim.step(CONFIG.sim.dt);
      paintStats();
    }
  });
  button('btn-reset', 'New city', () => {
    sim.newWorld(CONFIG.seed + Math.floor(Math.random() * 1e6));
    renderer.frameWorld();
    view.focus = sim.focusAgent('leader');
    toast('New city generated');
  });
  button('btn-pretrain', 'Re-teach from expert', () => {
    if (!pretraining) startPretraining();
  });
  button('btn-scenario', 'New scenario', () => {
    sim.newScenario();
    toast('New benchmark: same cars, new spawns and traffic');
  });
  button('btn-teach', 'Drive the expert', () => {
    assist = assist > 0 ? 0 : 1;
    sim.assist = assist;
    document.getElementById('btn-teach').classList.toggle('on', assist > 0);
    toast(assist > 0 ? 'Teacher assist on — watch how a scripted driver behaves' : 'Back to the neural networks');
  });
  button('btn-restore', 'Restore learning', () => {
    assist = 0;
    sim.assist = 0;
    document.getElementById('btn-teach').classList.remove('on');
    toast('Assist off');
  });
  button('btn-edit', 'Build roads', () => {
    editor.setActive(!editor.active);
    document.getElementById('btn-edit').classList.toggle('on', editor.active);
    document.getElementById('edit-hint').textContent = editor.active ? 'editing' : 'press E';
    document.getElementById('edit-note').textContent = editor.active
      ? 'Drag on the map to draw. Roads snap to the grid so the network stays connected.'
      : 'Drag on the map to draw roads. Right-click or use erase to remove them.';
  });
  button('btn-clear', 'Clear', () => {
    sim.world.clear();
    sim.world.rebuild();
    sim.onWorldEdited();
    editor.commit();
    toast('All roads removed — draw some and watch them learn');
  });
  button('btn-autoroad', 'Regenerate', () => {
    pruneOrphans(sim.world);
    sim.newWorld(CONFIG.seed + Math.floor(Math.random() * 1e6));
    renderer.frameWorld();
    toast('City regenerated');
  });
  button('help-close', 'Start driving', () => { document.getElementById('help').hidden = true; });
}

function togglePause() {
  sim.paused = !sim.paused;
  const b = document.getElementById('btn-pause');
  b.textContent = sim.paused ? 'Resume' : 'Pause';
  b.classList.toggle('primary', !sim.paused);
}

function showHelp() {
  document.getElementById('help').hidden = false;
}

// ------------------------------------------------------------------ keyboard ---

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); togglePause(); break;
    case 'e': document.getElementById('btn-edit').click(); break;
    case 'f':
      view.focusMode = view.focusMode === 'random' ? 'leader' : 'random';
      toast(`Camera: ${view.focusMode}`);
      break;
    case 'o':
      view.focusMode = 'overview';
      renderer.frameWorld();
      break;
    case 'r': document.getElementById('btn-reset').click(); break;
    case 't': document.getElementById('btn-teach').click(); break;
    case 'h': document.getElementById('help').hidden = !document.getElementById('help').hidden; break;
    case '+': case '=': speed = clamp(speed + 1, 1, 24); break;
    case '-': speed = clamp(speed - 1, 1, 24); break;
    default: break;
  }
});

window.addEventListener('resize', () => {
  renderer.resize();
  minimap.resize();
  chart.resize();
});
