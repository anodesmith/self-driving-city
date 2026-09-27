import { CONFIG } from '../config.js';
import { clamp } from '../core/math.js';

/**
 * A tiny fully connected network. The whole genome is a flat Float32Array so
 * evolution is just array arithmetic: no object churn, easy to copy.
 *
 *   input -> tanh -> hidden... -> tanh -> outputs
 */
export class Brain {
  constructor(inputSize, hidden = CONFIG.brain.hidden, outputSize = 2) {
    this.inputSize = inputSize;
    this.hidden = hidden.slice();
    this.outputSize = outputSize;
    this.sizes = [inputSize, ...hidden, outputSize];
    this.weights = [];
    this.biases = [];
    let total = 0;
    for (let i = 0; i < this.sizes.length - 1; i++) {
      const n = this.sizes[i] * this.sizes[i + 1] + this.sizes[i + 1];
      this.weights.push(new Float32Array(this.sizes[i] * this.sizes[i + 1]));
      this.biases.push(new Float32Array(this.sizes[i + 1]));
      total += n;
    }
    this.size = total;
    this.activations = this.sizes.map((n) => new Float32Array(n));
    this.gw = this.weights.map((w) => new Float32Array(w.length));
    this.gb = this.biases.map((b) => new Float32Array(b.length));
    this.gradFlat = new Float32Array(this.size);
    this.lastLoss = 0;
    this.m = null;
    this.v = null;
  }

  resetAdam() {
    this.m = this.weights.map((w) => new Float32Array(w.length));
    this.v = this.weights.map((w) => new Float32Array(w.length));
    this.mb = this.biases.map((b) => new Float32Array(b.length));
    this.vb = this.biases.map((b) => new Float32Array(b.length));
    this.t = 0;
  }

  initRandom(rng, scale = 1.4) {
    for (const w of this.weights) {
      const sd = scale / Math.sqrt(w.length);
      for (let i = 0; i < w.length; i++) w[i] = rng.gauss() * sd;
    }
    for (const b of this.biases) b.fill(0);
  }

  /** Forward pass. `input` must have inputSize entries. Returns the output array. */
  forward(input) {
    const acts = this.activations;
    acts[0].set(input);
    for (let layer = 0; layer < this.weights.length; layer++) {
      const w = this.weights[layer];
      const b = this.biases[layer];
      const inA = acts[layer];
      const outA = acts[layer + 1];
      const nIn = this.sizes[layer];
      const nOut = this.sizes[layer + 1];
      for (let o = 0; o < nOut; o++) {
        let sum = b[o];
        const base = o * nIn;
        for (let i = 0; i < nIn; i++) sum += w[base + i] * inA[i];
        outA[o] = Math.tanh(sum);
      }
    }
    return acts[this.activations.length - 1];
  }

  /** Set one of the output-layer biases, e.g. a prior "always wants to move". */
  setOutputBias(index, value) {
    const b = this.biases[this.biases.length - 1];
    if (index >= 0 && index < b.length) b[index] = value;
    return this;
  }

  copyFrom(other) {
    this.weights.forEach((w, i) => w.set(other.weights[i]));
    this.biases.forEach((b, i) => b.set(other.biases[i]));
    return this;
  }

  clone() {
    const b = new Brain(this.inputSize, this.hidden, this.outputSize);
    return b.copyFrom(this);
  }

  toArray() {
    const out = new Float32Array(this.size);
    this.toArrayInto(out);
    return out;
  }

  toArrayInto(out) {
    let o = 0;
    for (const w of this.weights) {
      out.set(w, o);
      o += w.length;
    }
    for (const b of this.biases) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }

  fromArray(arr) {
    let o = 0;
    for (const w of this.weights) { w.set(arr.subarray(o, o + w.length)); o += w.length; }
    for (const b of this.biases) { b.set(arr.subarray(o, o + b.length)); o += b.length; }
    return this;
  }

  /** Mean squared error of the current output against `target`. */
  loss(input, target) {
    const out = this.forward(input);
    let err = 0;
    for (let i = 0; i < this.outputSize; i++) {
      const d = out[i] - target[i];
      err += d * d;
    }
    return err / this.outputSize;
  }

  /**
   * Backpropagate a mini batch into this.gw / this.gb and return the loss.
   * Kept separate from the optimiser so gradients can be checked in isolation.
   */
  computeGradients(inputs, targets, count) {
    const L = this.weights.length;
    for (let layer = 0; layer < L; layer++) {
      this.gw[layer].fill(0);
      this.gb[layer].fill(0);
    }
    if (!this.deltas) this.deltas = this.sizes.map((n) => new Float32Array(n));
    const deltas = this.deltas;

    let loss = 0;
    for (let s = 0; s < count; s++) {
      const out = this.forward(inputs[s]);
      const target = targets[s];

      // Output layer delta, and how wrong we are.
      const last = deltas[L];
      for (let o = 0; o < this.outputSize; o++) {
        const a = out[o];
        const d = a - target[o];
        loss += d * d;
        last[o] = d * (1 - a * a);
      }

      // Walk backwards, accumulating gradients layer by layer.
      for (let layer = L - 1; layer >= 0; layer--) {
        const delta = deltas[layer + 1];
        const prev = this.activations[layer];
        const nIn = this.sizes[layer];
        const nOut = this.sizes[layer + 1];
        const gw = this.gw[layer];
        const gb = this.gb[layer];
        for (let o = 0; o < nOut; o++) {
          const d = delta[o];
          if (d === 0) continue;
          gb[o] += d;
          const base = o * nIn;
          for (let i = 0; i < nIn; i++) gw[base + i] += d * prev[i];
        }
        if (layer > 0) {
          const cur = deltas[layer];
          cur.fill(0);
          const w = this.weights[layer];
          for (let o = 0; o < nOut; o++) {
            const d = delta[o];
            if (d === 0) continue;
            const base = o * nIn;
            for (let i = 0; i < nIn; i++) cur[i] += w[base + i] * d;
          }
          for (let i = 0; i < nIn; i++) cur[i] *= 1 - prev[i] * prev[i];
        }
      }
    }

    this.lastLoss = loss / count;
    if (this.gradFlat) {
      // Same layout as toArray(): all weight blocks, then all bias blocks.
      let o = 0;
      for (let layer = 0; layer < L; layer++) {
        const g = this.gw[layer];
        for (let i = 0; i < g.length; i++) this.gradFlat[o++] = g[i] / count;
      }
      for (let layer = 0; layer < L; layer++) {
        const g = this.gb[layer];
        for (let i = 0; i < g.length; i++) this.gradFlat[o++] = g[i] / count;
      }
    }
    return this.lastLoss;
  }

  /**
   * One Adam step on a mini batch (real backprop through the tanh layers).
   * Used to clone the scripted expert before evolution takes over, so the first
   * generation is not pure noise.
   */
  trainBatch(inputs, targets, count, lr) {
    if (!this.m) this.resetAdam();
    this.computeGradients(inputs, targets, count);
    this.t++;
    const b1 = 0.9;
    const b2 = 0.999;
    const eps = 1e-8;
    const bc1 = 1 - Math.pow(b1, this.t);
    const bc2 = 1 - Math.pow(b2, this.t);
    const L = this.weights.length;

    for (let layer = 0; layer < L; layer++) {
      const w = this.weights[layer];
      const b = this.biases[layer];
      const gw = this.gw[layer];
      const gb = this.gb[layer];
      const mw = this.m[layer];
      const vw = this.v[layer];
      const mb = this.mb[layer];
      const vb = this.vb[layer];
      for (let i = 0; i < w.length; i++) {
        const g = gw[i];
        mw[i] = b1 * mw[i] + (1 - b1) * g;
        vw[i] = b2 * vw[i] + (1 - b2) * g * g;
        w[i] -= (lr * (mw[i] / bc1)) / (Math.sqrt(vw[i] / bc2) + eps);
        if (w[i] > 12) w[i] = 12;
        else if (w[i] < -12) w[i] = -12;
      }
      for (let i = 0; i < b.length; i++) {
        const g = gb[i];
        mb[i] = b1 * mb[i] + (1 - b1) * g;
        vb[i] = b2 * vb[i] + (1 - b2) * g * g;
        b[i] -= (lr * (mb[i] / bc1)) / (Math.sqrt(vb[i] / bc2) + eps);
      }
    }
    return this.lastLoss;
  }
}

// ------------------------------------------------------------------ genomes ---

export function randomGenome(brain, rng, scale = 1.4) {
  brain.initRandom(rng, scale);
  return brain.toArray();
}

export function crossover(a, b, rng, blend = true) {
  const out = new Float32Array(a.length);
  if (!blend) {
    for (let i = 0; i < out.length; i++) out[i] = rng.chance(0.5) ? a[i] : b[i];
    return out;
  }
  // Uniform crossover, but each gene from the second parent is blended in with
  // a random alpha so children can interpolate between the two strategies.
  const alpha = 0.25 + rng.next() * 0.5;
  for (let i = 0; i < out.length; i++) {
    if (rng.chance(0.5)) out[i] = rng.chance(0.5) ? a[i] : b[i];
    else out[i] = alpha * a[i] + (1 - alpha) * b[i];
  }
  return out;
}

/**
 * Gaussian mutation with a self-adaptive step size.
 *
 * Every child draws its own sigma from a log-normal distribution, so the
 * population always contains both small careful steps and the occasional large
 * jump. One fixed sigma either never escapes a local optimum or wrecks every
 * good genome it touches.
 */
export function mutate(genome, rng, rate, sigma, bigChance = 0) {
  let s = sigma * Math.exp(rng.gauss() * 0.3);
  if (s < sigma * 0.15) s = sigma * 0.15;
  else if (s > sigma * 6) s = sigma * 6;
  for (let i = 0; i < genome.length; i++) {
    if (rng.chance(bigChance)) genome[i] += rng.gauss() * s * 5;
    else if (rng.chance(rate)) genome[i] += rng.gauss() * s;
    genome[i] = clamp(genome[i], -8, 8);
  }
  return genome;
}
