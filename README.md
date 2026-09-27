# Self-driving city

A virtual world in plain JavaScript where cars learn to drive on the roads you
built. No frameworks, no build step, no dependencies — open it and it runs.

Every car is a small neural network. It can only see a fan of range-finder rays
and a few signals about the lane it is in, and it can only choose steering and
throttle. Nobody tells it how to drive: a population of them is scored on how far
it gets, and the winners reproduce. Watch the blue line in the panel climb and
the cars visibly get out of each other's way.

```
npm start          # serves it at http://localhost:5173
npm test           # checks the road network, the teacher, and that learning works
```

There is nothing to install. `npm start` just runs a 50-line static file server
(ES modules need `http://`, not `file://`).

## What you are looking at

**The world** is a road network of *junctions* joined by *roads*. Each road is
split into directed *lanes* — one per direction, right-hand traffic — and the
lanes are linked through junctions into a graph. Routing is solved for you: each
car is given a destination and a backwards Dijkstra pass over the lane graph
decides where to go next. What the cars have to learn is *driving*, not
navigation.

**The cars** are 22→22→12→2 tanh networks, about 800 weights each. Inputs:

| input | what it is |
| --- | --- |
| 7 × 2 | range-finder rays: proximity, and whether the hit was a car or a wall |
| speed | signed, normalised by the car's top speed |
| heading error | angle to a pure-pursuit point on the lane ahead |
| lateral offset | signed distance from the lane centreline |
| curvature | how sharply the road turns just ahead |
| junction proximity | how close the next junction is |
| forward speed | velocity projected onto the lane |
| goal distance | to the destination |

Outputs are steering and throttle in −1…1. That is the entire interface. No
speed limit, no racing line, no hand-written behaviour beyond the physics.

**The learning** is neuroevolution. Each generation every genome is scored on
distance driven along its lane, minus penalties for leaving the road and
crashing, plus a bonus for arriving anywhere. The top few survive untouched; the
rest are blended and mutated, each child drawing its own mutation step size from
a log-normal distribution.

**The teacher** is a scripted driver (pure pursuit plus a speed target). It
exists for two reasons: you can switch it on and watch a competent driver for
comparison, and at start-up the app records its drives and fits a network to them
by behaviour cloning. That gives generation zero a population that already drives
roughly, and evolution spends its time getting *better* rather than rediscovering
that the accelerator exists.

## Things worth trying

- **Press E and draw roads.** Drag on the map; roads snap to a grid so whatever
  you draw stays connected, and the cars keep learning on it. Right-drag erases.
- **Press T** to hand a car over to the scripted teacher and compare.
- **Press O** for the whole-city view, **F** to jump between cars, **H** for help.
- **New scenario** re-rolls the benchmark. If the champion keeps its score on
  fresh spawns and traffic, it learned to drive rather than memorising one run.
- Watch the population average (grey) climb, not just the best (blue). The
  champion line is a running maximum over noisy samples; the average is the
  honest measure of progress.

## How the evaluation works

Getting a learning loop to work is mostly about making the score mean something.
Four things turned this from noise into progress:

- **One world, many cars.** Learners never collide with each other, and civilian
  traffic is immovable to them. Otherwise fitness measures who got rammed.
- **Deterministic conditions.** The same lanes, traffic and goals every run, so a
  genome's score is reproducible and two genomes are comparable.
- **Independent randomness.** Every car seeds its generator from
  `(scenario, trial, index)`. Nothing derives from a shared stream, so one car's
  route choices never depend on how many goals its rivals reached.
- **Rotating start slots.** Which lane a car starts from rotates each generation,
  so no genome is permanently parked on an easy stretch while its children are
  judged on a hard one.

A generation costs about 2.5 seconds of compute for 64 cars × 2 runs, so the
default speed of 4× runs a generation roughly every seven seconds.

## Layout

```
index.html            the page
server.js             dependency-free static server
src/
  main.js             wiring: loop, controls, keyboard
  config.js           every tunable number
  core/               math helpers, seeded RNG
  world/
    roadWorld.js      junctions, roads, lanes, collision walls, spatial index
    cityGenerator.js  grows a planar street grid
    spatial.js        uniform grid, ray casting
  sim/
    simulation.js     world + population + traffic, fixed timestep
    car.js            kinematic bicycle model and collisions
    agent.js          one learner: car + lane follower + brain + score
    navigation.js     lane tracking and goal-directed routing
    sensors.js        the network's input vector
    expert.js         the scripted teacher
    neural.js         MLP, backprop with Adam, genome operators
    evolution.js      selection, elitism, breeding
    pretrain.js       behaviour cloning of the teacher
  render/             canvas renderer, minimap, fitness chart
  ui/                 control panel, road editor, styles
test/                 headless checks (they run the real simulation)
```

The simulation core never touches the DOM, which is why the same code runs in
Node under `npm test`.

## Tests

`npm test` runs three things:

1. **Road network is drivable** — for eight seeds, no collision wall may cross a
   lane centreline and every lane must reach every other. This invariant is what
   `openLaneObstructions()` maintains: junction openings are derived from the
   local geometry, and anything a lane genuinely runs into is opened.
2. **Hand-built roads are drivable** — a U-shaped network with crossroads, built
   by hand the way the road editor builds one, driven by the teacher.
3. **Cars learn to drive** — clone the teacher, evolve, and assert that the
   population average improves and the champion beats the teacher.
