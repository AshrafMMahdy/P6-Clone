// The Windows failure of "slowly but steadily…" (owner's PC, under load): reading a process's processor time (PowerShell) can take
// longer than a window. Progress made while it is read must count — a job that progresses steadily is never judged frozen because
// its ticks fell while the watcher was reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitWatch, type StuckInfo } from '../core/bim/liveness.ts';

test('progress made while the processor time is being read counts (a slow reading never makes a steady job look frozen)', async () => {
  const windowMs = 200;
  let stuck: StuckInfo | null = null, n = 0;
  // a reading that takes longer than a window and shows no processor time (a job that waits between its steps)
  const slowCpu = () => new Promise<number>((r) => setTimeout(() => r(0), windowMs * 1.75));
  const w = unitWatch({ onStuck: (i) => { stuck = i; }, cpu: slowCpu, windowMs });
  const t = setInterval(() => w.beat(++n), windowMs * 0.9);   // one tick a window, steady: most fall while the reading runs
  await new Promise((r) => setTimeout(r, windowMs * 15));
  clearInterval(t); w.stop();
  assert.equal(stuck, null, `a steady job was judged frozen: ${JSON.stringify(stuck)}`);
  assert.ok(n >= 10);
});

test('…and a job that stops progressing is still judged frozen with the same slow reading', async () => {
  const windowMs = 200;
  let stuck: StuckInfo | null = null;
  const slowCpu = () => new Promise<number>((r) => setTimeout(() => r(0), windowMs * 1.5));
  const w = unitWatch({ onStuck: (i) => { stuck = i; }, cpu: slowCpu, windowMs });
  w.beat(1);
  for (let i = 0; i < 40 && !stuck; i++) await new Promise((r) => setTimeout(r, windowMs / 2));
  w.stop();
  assert.equal((stuck as StuckInfo | null)?.kind, 'idle', JSON.stringify(stuck));
});
