// Deterministic RNG so a given seed always builds the same city and the same
// evaluation episodes can be replayed.

export function makeRng(seed = 1) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    next,
    /** Uniform float in [lo, hi). */
    range: (lo, hi) => lo + next() * (hi - lo),
    /** Uniform integer in [lo, hi]. */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    /** Standard normal via Box-Muller. */
    gauss: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
    },
    fork: (salt) => makeRng((Math.imul(state ^ salt, 0x9e3779b1) ^ (seed + salt)) >>> 0),
  };
  return rng;
}

/** Shared stream for cosmetic randomness (rendering, traffic). */
export const rand = makeRng(0xc0ffee);
