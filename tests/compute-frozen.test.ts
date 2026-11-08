// A compute worker (evaluate_batch, monte_carlo) is ended after a cancel only when FROZEN: no progress and no processor time of its own
// thread for two windows in a row (the platform's rule). Its processor time is the thread's own (Worker.cpuUsage) — a thread that spins
// in one long scenario is working, a thread blocked waiting is not. If it is ended, the rows it had sent out as each finished are the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { FROM_KEPT, threadCpu } from '../mcp/compute.ts';
import { unitWatch, type StuckInfo } from '../core/bim/liveness.ts';
import { parseP6Date } from '../core/dates.ts';

const SRC = `const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  if (m === 'spin') { const t = Date.now(); while (Date.now() - t < 1500) { /* one long scenario: the thread works, no row yet */ } parentPort.postMessage('done'); }
  else { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); parentPort.postMessage('done'); }   // blocked: no processor time
});`;

test('the thread\'s own processor time: a worker spinning in one long step is never ended; one blocked waiting is ended as frozen', { skip: !threadCpu(new Worker('0', { eval: true })) && 'Worker.cpuUsage is not offered by this Node' }, async () => {
  for (const [what, frozen] of [['spin', false], ['wait', true]] as const) {
    const w = new Worker(SRC, { eval: true });
    const stuck: StuckInfo[] = [];
    const watch = unitWatch({ step: `one scenario (${what})`, windowMs: 300, cpu: threadCpu(w), onStuck: (i) => stuck.push(i) });
    await new Promise((r) => setTimeout(r, 100));
    w.postMessage(what);
    await new Promise((r) => w.once('message', r));
    watch.stop(); await w.terminate();
    assert.equal(stuck.length > 0, frozen, `${what}: ${JSON.stringify(stuck)}`);
    if (frozen) assert.equal(stuck[0].kind, 'idle');
  }
});

test('ended after a cancel: the rows it had sent out are the answer (evaluate_batch: the scenarios; monte_carlo: the finish dates of its iterations)', () => {
  const rows = [{ name: 'A', ok: true, finish: '2026-06-01 17:00' }, { name: 'B', ok: false, error: 'x' }];
  const b = FROM_KEPT.evaluate_batch(rows, { scenarios: [{}, {}, {}, {}] }) as Record<string, any>;
  assert.deepEqual([b.partial, b.stopped, b.scenarios_done, b.scenarios_requested, b.scenarios.length], [true, 'cancelled', 2, 4, 2]);
  const day = 86_400_000, t0 = parseP6Date('2026-06-01 17:00')!;
  const finishes = Array.from({ length: 10 }, (_, i) => t0 + i * day);
  const m = FROM_KEPT.monte_carlo([...finishes].reverse(), { iterations: 1000 }) as Record<string, any>;
  assert.deepEqual([m.partial, m.stopped, m.iterations_done, m.iterations_requested], [true, 'cancelled', 10, 1000]);
  assert.equal(parseP6Date(m.finish.min), finishes[0]);
  assert.equal(parseP6Date(m.finish.max), finishes[9]);
  assert.equal(parseP6Date(m.finish.P10), finishes[0]);
  assert.equal(parseP6Date(m.finish.P50), finishes[4]);
  assert.equal(parseP6Date(m.finish.P90), finishes[8]);
  assert.match(m.note, /10 iterations it had finished/);
});
