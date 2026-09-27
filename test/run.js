/**
 * Runs the whole check suite and summarises it.
 *
 *   node test/run.js
 *
 * 1. the generated road network must be drivable, on several seeds
 * 2. hand-built roads must be drivable too (what the road editor produces)
 * 3. the population must actually get better at driving
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const steps = [
  { name: 'road network is drivable (8 seeds)', file: 'validate-world.js', args: ['--all'] },
  { name: 'hand-built roads are drivable', file: 'custom-roads.js', args: [] },
  { name: 'cars learn to drive', file: 'learn.js', args: ['12', '32', '2', '12'] },
];

const run = (file, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(here, file), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n[1m── ${step.name}[0m\n`);
  const { code, out } = await run(step.file, step.args);
  process.stdout.write(out);
  if (code !== 0) {
    failed++;
    process.stdout.write(`[31m  FAILED[0m\n`);
  } else {
    process.stdout.write(`[32m  passed[0m\n`);
  }
}

process.stdout.write(failed ? `\n[31m${failed} check(s) failed[0m\n` : '\n[32mall checks passed[0m\n');
process.exit(failed ? 1 : 0);
