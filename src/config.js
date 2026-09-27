// Every tunable knob of the world, the cars, the brains and the evolution loop.
// Values here are what the UI sliders write into at runtime.

export const CONFIG = {
  seed: 20260927,

  world: {
    width: 3000,
    height: 2000,
    cell: 380,        // generator grid pitch
    fill: 0.78,       // fraction of grid cells that become junctions
    edgeChance: 0.82, // chance two neighbouring junctions are linked
    diagonal: 0.16,   // chance of a diagonal shortcut
    avenueChance: 0.5,// long cross-town avenues per junction
    jitter: 0.34,     // junction offset inside its cell (0..0.5)
  },

  road: {
    width: 58,        // total asphalt width
    lanesPerDir: 1,   // lanes per direction
    sampleSpacing: 11,
    junctionPad: 1.15, // multiplier on road width used to open up intersections
  },

  car: {
    length: 36,
    width: 18,
    radius: 13,       // collision circle
    wheelBase: 23,
    maxSteer: 0.62,   // radians at full lock
    maxSpeed: 430,    // px/s
    accel: 300,       // px/s^2
    brake: 620,
    drag: 0.55,
    rolling: 0.9,
    grassDrag: 3.2,   // extra drag multiplier off-road
    crashSpeed: 70,   // above this a wall hit counts as a crash
  },

  brain: {
    rayCount: 7,
    raySpread: 116,   // degrees between the outermost rays
    rayRange: 205,    // px
    rayNormK: 34,     // hyperbolic normalisation constant
    lookaheadMin: 48,
    lookaheadGain: 0.95,
    lookaheadMax: 190,
    cornerBlend: 120, // px over which the aim eases onto the next lane
    hidden: [22, 12],
    pretrain: true,
  },

  evolution: {
    population: 64,
    elite: 8,
    trials: 2,          // runs per genome per generation; averages out luck
    collideWithLearners: false,
    mutationRate: 0.15,
    mutationSigma: 0.09,   // base step; each child scales it log-normally
    bigMutationChance: 0.03,
    crossoverRate: 0.85,
    blendCrossover: true,
    episodeTime: 26,  // simulated seconds per evaluation
    maxOffroad: 2.2,
    maxCrashes: 3,
    maxStuck: 5,      // seconds below walking pace before the run is called off
    goalReward: 140,
    goalInterval: 520, // metres of progress before a fresh destination
  },

  traffic: {
    count: 18,
    speedMin: 70,
    speedMax: 125,
  },

  sim: {
    dt: 1 / 60,
    maxStepsPerFrame: 40,
  },

  render: {
    zoom: 0.85,
    followRate: 4.5,
  },

  palette: {
    grass: '#1d2b1f',
    grassAlt: '#223323',
    asphalt: '#3a3f47',
    asphaltEdge: '#262a30',
    laneLine: 'rgba(236,238,240,0.5)',
    centreLine: 'rgba(240,200,90,0.75)',
    kerb: '#4a5058',
    goal: '#7ddcff',
    start: '#ff9f43',
    carBody: '#e8ecf1',
    carGlass: '#2b3a4a',
    traffic: '#8f9aa8',
  },
};

export const CONFIG_DEFAULTS = structuredClone(CONFIG);
