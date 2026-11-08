// A job that shows no progress is never stopped for it; the agent is told. Once per job, when the silence first passes the job's OWN
// longest gap (or, before it has shown one, its step's measured expected time) — the measured value itself, no multiplier — a
// `no_progress` pulse wakes the agent with the facts. After that only when the agent asks (job_status wake_after_s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askWake, noteSilence, onJobPulse, startJob } from '../mcp/runtime.ts';
import { unitWatch, watchReport, type Silence } from '../core/bim/liveness.ts';

const pulses: Record<string, any>[] = [];
onJobPulse((v) => { pulses.push(v as Record<string, any>); });
const wakes = () => pulses.filter((p) => p.event === 'no_progress');
const silence = (o: Partial<Silence>): Silence => ({ step: 'meshing products', done: 40, total: 100, silentMs: 0, lastProgressAt: Date.now(), maxGapMs: 0, expectMs: 0, usingCpu: true, cpuMs: 4800, ...o });

test('the wake fires once, when the silence passes the job\'s own longest gap; never again unless the agent asks', () => {
  pulses.length = 0;
  const job = startJob('evaluate_batch', 'h1', new Promise(() => {}));
  noteSilence(job, silence({ silentMs: 9_000, maxGapMs: 10_000 }));
  assert.equal(wakes().length, 0, 'not yet slower than the job has been');
  noteSilence(job, silence({ silentMs: 11_000, maxGapMs: 10_000 }));
  assert.equal(wakes().length, 1);
  const w = wakes()[0];
  assert.equal(w.job_id, job.id);
  assert.equal(w.no_progress.longest_gap_before_s, 10);
  assert.equal(w.no_progress.silent_s, 11);
  assert.equal(w.no_progress.using_cpu, true);
  assert.match(w.no_progress.note, /not stopped/);
  assert.ok(!('result' in w));
  noteSilence(job, silence({ silentMs: 600_000, maxGapMs: 10_000 }));
  assert.equal(wakes().length, 1, 'once per job: the agent decides after that');
});

test('the agent\'s wake_after_s: woken again once the silence passes what it asked, counted from when it asked', () => {
  pulses.length = 0;
  const job = startJob('render_4d', 'h2', new Promise(() => {}));
  noteSilence(job, silence({ silentMs: 20_000, maxGapMs: 5_000 }));
  assert.equal(wakes().length, 1);
  askWake(job, 30);
  noteSilence(job, silence({ silentMs: 40_000, maxGapMs: 5_000, lastProgressAt: Date.now() - 40_000 }));
  assert.equal(wakes().length, 1, '30 s after it asked have not passed');
  job.wakeAfter!.at -= 31_000;   // 31 s later
  noteSilence(job, silence({ silentMs: 71_000, maxGapMs: 5_000, lastProgressAt: Date.now() - 71_000 }));
  assert.equal(wakes().length, 2);
  assert.equal(wakes()[1].no_progress.asked_after_s, 30);
  noteSilence(job, silence({ silentMs: 900_000, maxGapMs: 5_000, lastProgressAt: Date.now() - 900_000 }));
  assert.equal(wakes().length, 2, 'one wake per ask');
});

test('before any gap is shown, the step\'s measured expected time is the record; with neither, no automatic wake', () => {
  pulses.length = 0;
  const job = startJob('open_model', 'h3', new Promise(() => {}));
  noteSilence(job, silence({ step: 'reading the IFC (web-ifc OpenModel)', silentMs: 50_000, expectMs: 60_000, usingCpu: true }));
  assert.equal(wakes().length, 0);
  noteSilence(job, silence({ step: 'reading the IFC (web-ifc OpenModel)', silentMs: 61_000, expectMs: 60_000, usingCpu: true }));
  assert.equal(wakes().length, 1);
  assert.equal(wakes()[0].no_progress.expected_s, 60);
  const job2 = startJob('schedule', 'h4', new Promise(() => {}));
  noteSilence(job2, silence({ silentMs: 10_000_000, maxGapMs: 0, expectMs: 0 }));
  assert.equal(wakes().length, 1, 'nothing measured to compare with: the agent can still ask (wake_after_s)');
});

test('a watch reports each silent window with the job\'s longest gap and whether it uses the processor (spinning: never stopped)', async () => {
  const seen: Silence[] = [];
  let cpu = 0, stuck = false;
  const w = watchReport.run({ line: () => {}, silence: (x) => { seen.push(x); } }, () => unitWatch({ step: 'drawing frames', windowMs: 100, cpu: async () => (cpu += 50), onStuck: () => { stuck = true; } }));
  w.beat(1, 10); await new Promise((r) => setTimeout(r, 30)); w.beat(2, 10); await new Promise((r) => setTimeout(r, 60)); w.beat(3, 10);
  await new Promise((r) => setTimeout(r, 650));   // spinning: the processor works, no frame
  w.stop();
  assert.equal(stuck, false, 'a watch whose work uses the processor never ends it');
  assert.ok(seen.length >= 3, `${seen.length} silent windows reported`);
  const last = seen.at(-1)!;
  assert.equal(last.usingCpu, true);
  assert.ok(last.maxGapMs >= 50 && last.maxGapMs < 400, `longest gap ${last.maxGapMs}`);
  assert.equal(last.done, 3);
  assert.ok(last.silentMs > last.maxGapMs);
});
