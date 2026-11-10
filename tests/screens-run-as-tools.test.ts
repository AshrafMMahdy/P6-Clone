// The Extensions screens that run their MCP tool off the window (Monte Carlo in the Risks window and in Extensions, Crashing, Lint, Float
// paths, Optimize; 4L-13 round 2b): the screen sends the tool's own arguments, shows the tool's answer and its refusals in the tool's
// words, and a cancel shows what the tool kept. Each panel's call is built here with the functions the panel uses
// (renderer/views/toolAnswers.ts) and compared with the tool's answer; the child process the app runs the tool in (main/analysis-export.ts)
// is run for real, with its progress lines and its "cancel" line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { rows } from '../core/db.ts';
import { dbToLines } from '../core/db-file.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { runMonteCarlo } from '../core/risk/montecarlo.ts';
import { sessions, setRoots } from '../mcp/runtime.ts';
import { reasonerModelPath } from '../core/analysis/hrmRuntime.ts';
import { betweenCount, crashArgs, crashStopped, errorText, floatPathsArgs, lintArgs, lintStopped, monteCarloArgs, monteCarloResult, monteCarloStopped, optimizeArgs, levelInProposedOrder, optimizeNotes, OPTIMIZE_ADVICE, refusal, type ToolAnswer } from '../renderer/views/toolAnswers.ts';

setRoots(null, tmpdir());
const { callTool } = await import('../mcp/server.ts');
/** the tool's answer as the child gives it to the screen */
const run = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal, progress?: (done: number, total: number, message: string) => void): Promise<ToolAnswer> => callTool(tool, args, undefined, signal, progress) as Promise<ToolAnswer>;
const ok = (r: ToolAnswer) => { assert.equal(r.isError, false, JSON.stringify(r.out).slice(0, 400)); return r.out; };

/** A project P: A (10 d) then B (5 d), both with a three-point estimate, scheduled. */
async function mcProject() {
  const np = (await run('new_project', { id: 'P', start: '2026-03-02' })).out as any;
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: [
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' },
    { op: 'set_estimates', activity: 'A', min_days: 8, most_likely_days: 10, max_days: 20 }, { op: 'set_estimates', activity: 'B', min_days: 4, most_likely_days: 5, max_days: 9 },
  ] }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  return { h: np.handle as string, db: sessions.get(np.handle)!.db };
}

test('Monte Carlo: past the old 20,000 the screen sends the iterations as typed and shows the tool’s answer, the engine’s own for that seed', async () => {
  const { h, db } = await mcProject();
  const ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  // the panel's call with 25,000 iterations (the screens refused above 20,000), the project argument as the Export's
  const args = monteCarloArgs({ iterations: 20100, seed: 7, riskEvents: 'pre', project: { project: 'P' } });
  assert.equal(args.iterations, 20100, 'as typed: no floor, no cap');
  const out = ok(await run('monte_carlo', { handle: h, ...args }));
  const screen = monteCarloResult(out, (c) => `id-${c}`);
  const engine = await runMonteCarlo(db, ids, { iterations: 20100, seed: 7, riskEvents: 'pre' });
  assert.equal(screen.iterations, 20100); assert.equal(screen.seed, 7);
  for (const k of ['P10', 'P50', 'P80', 'P90'] as const) assert.equal(screen.percentiles[k], Math.round(engine.percentiles[k]), k);
  assert.equal(screen.min, Math.round(engine.min)); assert.equal(screen.max, Math.round(engine.max));
  assert.equal(screen.deterministicFinish, Math.round(engine.deterministicFinish));
  assert.ok(Math.abs(screen.probDeterministic - engine.probDeterministic) <= 0.0005 + 1e-9);
  assert.equal(screen.activities.length, engine.activities.length, 'top 0: every activity, as the screen always listed');
  assert.equal(screen.activities[0].taskId, 'id-' + out.criticality[0].id, 'a click goes to the activity by its row');
  assert.ok(screen.histogram.length >= 1 && screen.histogram.length <= 40);
  assert.equal(screen.histogram.reduce((n, b) => n + b.count, 0), 20100, 'the chart’s bars hold every iteration');
  assert.equal(monteCarloStopped(out), null, 'a complete run says nothing of stopping');
});

test('Monte Carlo: what the tool refuses is the text the panel shows: fewer than 10 or not whole, and a run that does not fit in memory, before anything starts', async () => {
  const { h } = await mcProject();
  for (const [n, word] of [[5, 'got 5'], [10.5, 'got 10.5'], [0, 'got 0']] as const) {
    const r = await run('monte_carlo', { handle: h, ...monteCarloArgs({ iterations: n, riskEvents: 'pre' }) });
    assert.equal(r.isError, true);
    assert.match(refusal(r)!, /iterations must be a whole number of 10 or more/); assert.ok(refusal(r)!.includes(word), refusal(r)!);
    assert.equal(refusal(r), errorText(r.out), 'the tool’s message and hint, whole');
  }
  const big = await run('monte_carlo', { handle: h, ...monteCarloArgs({ iterations: 1e12, riskEvents: 'pre' }) });
  assert.equal(big.isError, true); assert.equal(big.out.error.code, 'memory_budget', JSON.stringify(big.out.error).slice(0, 300));
  assert.match(refusal(big)!, /at most [\d,]+ iterations \(iterations\)/, 'in words, how many fit');
  assert.equal(refusal(await run('monte_carlo', { handle: h, ...monteCarloArgs({ iterations: 100, riskEvents: 'pre' }) })), null, 'a run that fits is not a refusal');
});

test('Monte Carlo: Cancel shows the iterations done (the tool’s partial answer) and they are the first of the uninterrupted run', async () => {
  const { h, db } = await mcProject();
  const ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const args = monteCarloArgs({ iterations: 400000, seed: 3, riskEvents: 'pre' });
  const abort = new AbortController();
  const r = await run('monte_carlo', { handle: h, ...args }, abort.signal, (done) => { if (done >= 1) abort.abort(); });
  const out = ok(r);
  assert.equal(out.partial, true); assert.equal(out.stopped, 'cancelled');
  assert.ok(out.iterations_done >= 1 && out.iterations_done < 400000, String(out.iterations_done));
  const line = monteCarloStopped(out)!;
  assert.equal(line, `Cancelled after ${out.iterations_done} of 400000 iterations: these results are of the ${out.iterations_done} that finished.`);
  const screen = monteCarloResult(out, () => '');
  assert.equal(screen.iterations, out.iterations_done); assert.deepEqual(screen.partial, { stopped: 'cancelled', requested: 400000 });
  const engine = await runMonteCarlo(db, ids, { iterations: out.iterations_done, seed: 3, riskEvents: 'pre' });
  assert.equal(screen.percentiles.P50, Math.round(engine.percentiles.P50), 'the statistics are of those iterations of that seed');
});

/** A chain of n activities of 10 days: with no crash data every one may lose 3 days, one step each. */
async function chain(n: number) {
  const np = (await run('new_project', { id: 'CH', start: '2026-03-02' })).out as any;
  const ops: unknown[] = [];
  for (let i = 0; i < n; i++) { ops.push({ op: 'add_activity', id: `L${i}`, name: `L${i}`, duration_days: 10 }); if (i) ops.push({ op: 'add_relationship', pred: `L${i - 1}`, succ: `L${i}` }); }
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  return np.handle as string;
}

test('Crashing: the panel’s settings are crash_schedule’s arguments (no step limit); Cancel shows the steps done, stop CANCELLED, nothing applied', async () => {
  const h = await chain(150);
  const settings = { mode: 'days' as const, days: '450', date: '', indirect: '', ld: '', pct: '30', data: { L3: { min: '5', cost: '100' }, L4: { min: '', cost: '' } } };
  const args = crashArgs(settings);
  assert.deepEqual(args, { target_days: 450, activities: [{ id: 'L3', min_days: 5, cost_per_day: 100 }], default_max_pct: 30 });
  assert.equal('max_steps' in args, false, 'the tool has no default step limit and the panel gives none');
  assert.deepEqual(crashArgs({ ...settings, mode: 'date', date: '2026-12-31T00:00', indirect: '50', ld: '20', data: {} }), { target_finish: '2026-12-31 00:00', indirect_cost_per_day: 50, ld_per_day: 20, default_max_pct: 30 });
  const progress: string[] = [], abort = new AbortController();
  const long = crashArgs({ ...settings, data: {} }); // (crash data names the only activities that may be crashed: none, so every one may lose the default 30 %)
  const r = await run('crash_schedule', { handle: h, ...long }, abort.signal, (done, _t, message) => { progress.push(message); if (done >= 3) abort.abort(); });
  const out = ok(r);
  assert.match(progress[0], /^step 1: [\d.]+ working days gained so far$/, 'the progress the screen shows is the tool’s: step n: X working days gained so far');
  assert.equal(out.stop, 'CANCELLED'); assert.equal(out.partial, true);
  assert.equal(crashStopped(out), `Cancelled after ${out.steps_done} steps: these are the steps done, and nothing was applied.`);
  assert.ok(out.steps_done >= 3 && out.steps.length === out.steps_done);
  assert.equal(crashStopped({ ...out, stop: 'TARGET' }), null);
  // the screen hides Apply for a cancelled run, as the tool applies nothing for one even when asked
  const asked = ok(await run('crash_schedule', { handle: h, ...long, apply: true }, (() => { const a = new AbortController(); setTimeout(() => a.abort(), 100); return a.signal; })()));
  if (asked.stop === 'CANCELLED') assert.equal(asked.applied, false);
});

test('Lint: the panel’s call simulates every critical ladder (the tool’s default); Cancel shows the checks finished and how many simulations were done', async () => {
  const np = (await run('new_project', { id: 'LTS', start: '2026-03-02' })).out as any;
  const ops: unknown[] = [{ op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' }, { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' }];
  let prev = 'S';
  for (let k = 0; k < 160; k++) for (let n = 1; n <= 4; n++) { const id = `L${k}_${n}`; ops.push({ op: 'add_activity', id, name: `Zone ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))} pour ${n}`, duration_days: 5 }, { op: 'add_relationship', pred: prev, succ: id, type: 'FS' }); prev = id; }
  ops.push({ op: 'add_relationship', pred: prev, succ: 'H' });
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  assert.deepEqual(lintArgs({ project: 'LTS' }, 'p6'), { project: 'LTS', profile: 'p6' }, 'no simulate argument: the tool simulates every critical ladder');
  const abort = new AbortController();
  const out = ok(await run('lint', { handle: np.handle, ...lintArgs({}, 'p6'), checks: ['fs_overlap'] }, abort.signal, (done) => { if (done >= 1) abort.abort(); }));
  const c = out.checks.find((x: any) => x.id === 'fs_overlap');
  assert.equal(out.partial, true); assert.equal(out.stopped, 'cancelled');
  assert.ok(c.ladders_simulated >= 1 && c.ladders_simulated < 160, String(c.ladders_simulated));
  assert.equal(lintStopped(out), `Cancelled: the checks finished are shown; of the 160 critical ladders to simulate, ${c.ladders_simulated} were done (the rest have no days saved).`);
  assert.equal(lintStopped({ checks: [] }), null);
});

test('Float paths: the panel’s call is float_paths’ with between; "the longest N of TOTAL", and a loop or a missing activity is the tool’s error text', async () => {
  const np = (await run('new_project', { id: 'FP', start: '2026-03-02' })).out as any;
  const ops: unknown[] = [{ op: 'add_activity', id: 'S', name: 'S', duration_days: 1 }];
  let prev = 'S';
  for (let i = 1; i <= 6; i++) ops.push({ op: 'add_activity', id: `a${i}`, name: 'a', duration_days: 1 }, { op: 'add_activity', id: `b${i}`, name: 'b', duration_days: 2 }, { op: 'add_activity', id: `J${i}`, name: 'J', duration_days: 1 }, { op: 'add_relationship', pred: prev, succ: `a${i}` }, { op: 'add_relationship', pred: prev, succ: `b${i}` }, { op: 'add_relationship', pred: `a${i}`, succ: `J${i}` }, { op: 'add_relationship', pred: `b${i}`, succ: `J${i}` }), prev = `J${i}`;
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  const args = floatPathsArgs({ count: 5, method: 'free_float', nearDays: 10, between: { from: 'S', to: prev, max: 10 } }, { project: 'FP' });
  assert.deepEqual(args, { project: 'FP', count: 5, method: 'free_float', near_critical_days: 10, between: { from: 'S', to: prev, max: 10 } });
  const out = ok(await run('float_paths', { handle: np.handle, ...args }));
  assert.equal(out.between.paths.length, 10); assert.equal(out.between.paths_total, 64);
  assert.equal(betweenCount(out.between), 'the longest 10 of 64');
  assert.equal(betweenCount({ paths: Array(5), paths_total: (2n ** 150n).toString() }), `the longest 5 of ${2n ** 150n}`, 'a total beyond 2^53 is the decimal string, as the tool gives it');
  // what the panel used to refuse in its own words is the tool's: the answer is text in the panel
  const none = await run('float_paths', { handle: np.handle, ...floatPathsArgs({ method: 'free_float', nearDays: 10, between: { from: 'S', to: '' } }, {}) });
  assert.equal(none.isError, true); assert.match(refusal(none)!, /between/i);
  const missing = await run('float_paths', { handle: np.handle, ...floatPathsArgs({ endActivity: 'NOPE', method: 'free_float', nearDays: 10 }, {}) });
  assert.match(refusal(missing)!, /No activity "NOPE"/);
});

test('Optimize: the panel’s call is optimize_schedule’s; the table, "the first 25 of N", the windows and the notes are the tool’s answer, each shown only when there', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const np = (await run('new_project', { id: 'OPT', start: '2026-06-01' })).out as any;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 4 }];
  for (const [id, d] of [['A', 4], ['B', 6], ['C', 5], ['D', 7], ['E', 3]] as const) ops.push({ op: 'add_activity', id, name: id, duration_days: d }, { op: 'assign_resource', activity: id, resource: 'civil', units_per_day: 16 });
  ops.push({ op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'C', succ: 'D' });
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  const args = optimizeArgs({ project: 'OPT' }, 20, 1);
  assert.deepEqual(args, { project: 'OPT', samples: 20, seed: 1, max_priority: 0 }, 'the whole placement order, which Apply levels in');
  const out = ok(await run('optimize_schedule', { handle: np.handle, ...args }));
  const n = optimizeNotes(out);
  assert.equal(out.biggest_changes_total, out.biggest_changes.length);
  assert.equal(n.changes, out.biggest_changes_total ? `Biggest changes against CPM: all ${out.biggest_changes_total}` : null);
  assert.equal(n.windows, null, 'one window: nothing said');
  assert.deepEqual(n.notes, [out.note, out.partial_note, out.over_limit_note].filter(Boolean).sort((a, b) => [out.over_limit_note, out.partial_note, out.note].indexOf(a) - [out.over_limit_note, out.partial_note, out.note].indexOf(b)), 'the notes the answer has, in the panel’s order');
  for (const c of out.biggest_changes) for (const k of ['id', 'name', 'cpm_start', 'cpm_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days']) assert.ok(k in c, `${k} is in each row of the table`);
  assert.match(OPTIMIZE_ADVICE, /^Review the biggest changes before applying; Undo takes the apply back\.$/);
  assert.equal(out.order, undefined, 'the placement order is listed as priority (here all of it: max_priority 0), not as the engine’s order');
  assert.equal(out.priority.length, out.priority_total);
});

test('Optimize notes: the first N of the total, the windows of 512, and each note only when the answer has it', () => {
  const rowsOf = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `A${i}` }));
  const a = optimizeNotes({ biggest_changes: rowsOf(25), biggest_changes_total: 11425, model_windows: 23, over_limit_note: '3 activities need more.', partial_note: 'Cancelled in the final pass.', note: 'No crash data was given.' });
  assert.equal(a.changes, 'Biggest changes against CPM: the first 25 of 11425');
  assert.equal(a.windows, 'read in 23 windows of 512 activities');
  assert.deepEqual(a.notes, ['3 activities need more.', 'Cancelled in the final pass.', 'No crash data was given.']);
  const b = optimizeNotes({ biggest_changes: [], biggest_changes_total: 0, model_windows: 1 });
  assert.deepEqual(b, { changes: null, windows: null, notes: [] });
});

// ---------------------------------------------------------------- the child process the app runs the tool in
test('the app’s child process (main/analysis-export.ts): progress comes as lines, a "cancel" line stops the tool at its next step and the answer is the partial one', async () => {
  const h = await chain(150);
  const dir = mkdtempSync(join(tmpdir(), 'screens-child-'));
  writeFileSync(join(dir, 'database.json'), dbToLines(sessions.get(h)!.db, {}).join('\n') + '\n');
  const request = { file: join(dir, 'database.json'), tool: 'crash_schedule', args: { target_days: 450 }, hoursPerDay: 8, progress: true };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'main', 'analysis-export.ts')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } });
  const progress: any[] = [], answer: string[] = [];
  let sentCancel = false;
  child.stdin.write(`${JSON.stringify(request)}\n`); // (the app keeps stdin open for a run that keeps its work)
  const closed = new Promise<number | null>((res) => child.on('close', res));
  const err: Buffer[] = []; child.stderr.on('data', (b) => err.push(b));
  for await (const line of createInterface({ input: child.stdout })) {
    if (line.startsWith('{"progress":')) { progress.push(JSON.parse(line).progress); if (!sentCancel && progress.length >= 3) { sentCancel = true; child.stdin.write('cancel\n'); } } else if (line.trim()) answer.push(line);
  }
  await closed;
  assert.ok(answer.length === 1, `one answer line (${Buffer.concat(err).toString().slice(-400)})`);
  const r = JSON.parse(answer[0]) as ToolAnswer;
  assert.ok(progress.length >= 1 && progress.every((p) => typeof p.message === 'string'), 'the tool’s progress, line by line');
  assert.equal(sentCancel, progress.length >= 3, 'cancel was sent once the run was going');
  if (sentCancel) { assert.equal(ok(r).stop, 'CANCELLED'); assert.equal(r.out.partial, true); assert.ok(r.out.steps_done >= 1); }
  else assert.ok(ok(r).steps.length >= 1, 'a run that ended before 3 progress lines is the whole answer');
});

test('the app’s child process: an Export (the request, then stdin ended, no progress) is not taken for a cancel and answers whole, as it did before', async () => {
  const h = await chain(5);
  const dir = mkdtempSync(join(tmpdir(), 'screens-child-'));
  writeFileSync(join(dir, 'database.json'), dbToLines(sessions.get(h)!.db, {}).join('\n') + '\n');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'main', 'analysis-export.ts')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } });
  const out: Buffer[] = []; child.stdout.on('data', (b) => out.push(b));
  const closed = new Promise((res) => child.on('close', res));
  child.stdin.end(JSON.stringify({ file: join(dir, 'database.json'), tool: 'crash_schedule', args: { target_days: 6 }, hoursPerDay: 8 }));
  await closed;
  const text = Buffer.concat(out).toString('utf8');
  assert.equal(text.includes('"progress"'), false, 'no progress lines unless asked');
  const r = JSON.parse(text) as ToolAnswer;
  assert.equal(ok(r).stop !== 'CANCELLED', true); assert.ok(r.out.steps.length >= 1);
});

test('Monte Carlo: the Risks grid and the S-curve read from the tool’s answer every column and point the engine’s result gave, on a seeded run (the page looks as before)', async () => {
  const np = (await run('new_project', { id: 'G', start: '2026-03-02' })).out as any;
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: [
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_activity', id: 'S', name: 'Side', duration_days: 2 },
    { op: 'add_activity', id: 'M', name: 'Milestone', duration_days: 0, type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'S', succ: 'M' },
    { op: 'set_estimates', activity: 'A', min_days: 8, most_likely_days: 10, max_days: 20 }, { op: 'set_estimates', activity: 'B', min_days: 4, most_likely_days: 5, max_days: 9 }, { op: 'set_estimates', activity: 'S', min_days: 1, most_likely_days: 2, max_days: 4 },
  ] }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  const db = sessions.get(np.handle)!.db, ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const out = ok(await run('monte_carlo', { handle: np.handle, ...monteCarloArgs({ iterations: 700, seed: 11, riskEvents: 'pre' }) }));
  const screen = monteCarloResult(out, (c) => `id-${c}`);
  const engine = await runMonteCarlo(db, ids, { iterations: 700, seed: 11, riskEvents: 'pre' });
  assert.equal(screen.activities.length, engine.activities.length);
  const min = (v: number | null) => (v == null ? null : Math.round(v)); // (the tool's dates are to the minute)
  for (const e of engine.activities) {
    const g = screen.activities.find((x) => x.code === e.code)!;
    assert.ok(g, e.code);
    assert.deepEqual([g.name, g.milestone, g.sensitivity, g.minDur, g.meanDur, g.maxDur], [e.name, e.milestone, e.sensitivity, e.minDur, e.meanDur, e.maxDur], `${e.code}: name, milestone, sensitivity and the remaining hours are the engine's`);
    assert.ok(Math.abs(g.criticality - e.criticality) <= 0.005 + 1e-9, `${e.code}: raw criticality within 0.005`);
    // what the grid shows of it: the whole percent, the bar's class
    assert.deepEqual([Math.round(g.criticality), g.criticality >= 50], [Math.round(e.criticality), e.criticality >= 50], `${e.code}: the grid shows the same`);
    assert.deepEqual([g.deterministicFinish, g.meanFinish, g.p50Finish, g.p80Finish], [min(e.deterministicFinish), min(e.meanFinish), min(e.p50Finish), min(e.p80Finish)], `${e.code}: the finish columns`);
  }
  assert.ok(screen.activities.some((a) => a.milestone && a.criticality === 0), 'a milestone with no criticality is flagged, so the grid leaves it out as before');
  assert.ok(screen.activities.some((a) => a.maxDur > 0) && screen.activities.some((a) => a.p50Finish != null));
  // the bars: the engine's whole-day histogram, bin for bin (histogram: "days"), and the same call with no option keeps `buckets`
  assert.deepEqual(screen.histogram, engine.histogram.map((b) => ({ start: b.start, end: b.end, count: b.count, cumPct: b.cumPct })));
  const equal = ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11, buckets: 7 }));
  assert.equal(equal.histogram.length, 7);
  const { monteCarloCounts } = await import('../mcp/workset.ts');
  assert.equal(monteCarloCounts({ histogram: 'days', buckets: 9000 }).buckets, 40, 'the reservation counts the day bins like buckets');
  assert.equal((await run('monte_carlo', { handle: np.handle, iterations: 700, histogram: 'weeks' })).out.error.code, 'bad_input');
  // the tornado: the engine's list, in its order
  assert.deepEqual(screen.sensitivity.map((x) => [x.code, x.rho]), engine.sensitivity.map((x) => [x.code, x.rho]));
  // the S-curve: the engine's own points (a point for each finish, thinned), not one made from the bars
  assert.equal(screen.cumulative.length, engine.cumulative.length);
  assert.deepEqual(screen.cumulative.map((p) => [p.t, p.pct]), engine.cumulative.map((p) => [Math.round(p.t), p.pct]));
  assert.ok(screen.cumulative.length > screen.histogram.length, 'smoother than the bars');
  // the answer's rows are the export's table's columns, and `top` still decides how many are listed
  const few = ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11, top: 2 }));
  assert.equal(few.criticality.length, 2); assert.equal(few.criticality_total, engine.activities.length);
  assert.equal(few.criticality[0].critical_pct, Math.round(few.criticality[0].critical_pct * 100) / 100, 'the answer’s percent is to 2 decimals');
  const dir = mkdtempSync(join(tmpdir(), 'p6-crit-'));
  const ex = ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11, export: dir }));
  const whole = JSON.parse((await import('node:fs')).readFileSync(ex.exported.files[0].path, 'utf8'));
  for (const e of engine.activities) assert.equal(whole.criticality.find((x: { id: string }) => x.id === e.code).critical_pct, e.criticality, 'the export keeps the exact value');
  assert.deepEqual(Object.keys(few.criticality[0]), ['id', 'name', 'milestone', 'critical_pct', 'deterministic_finish', 'mean_finish', 'p50_finish', 'p80_finish', 'sensitivity', 'min_remaining_hours', 'mean_remaining_hours', 'max_remaining_hours']);
});

test('Optimize: Apply works on any schedule (the answer has the whole placement order, 130 activities here) and the project it makes has the dates of the tool’s apply: true', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const np = (await run('new_project', { id: 'OPA', start: '2026-06-01' })).out as any;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 12 }];
  for (let i = 0; i < 130; i++) ops.push({ op: 'add_activity', id: `T${i}`, name: `T${i}`, duration_days: 2 + (i % 5) }, { op: 'assign_resource', activity: `T${i}`, resource: 'civil', units_per_day: 16 });
  for (let i = 0; i < 130; i += 3) if (i + 3 < 130) ops.push({ op: 'add_relationship', pred: `T${i}`, succ: `T${i + 3}` });
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  const db = sessions.get(np.handle)!.db, screenDb = structuredClone(db), ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const args = optimizeArgs({}, 3, 5);
  const out = ok(await run('optimize_schedule', { handle: np.handle, ...args }));
  assert.ok(out.leveled_activities === 130 && out.priority_total === 130);
  assert.equal(out.priority.length, 130, 'the whole order: more than 100, so Apply is not disabled');
  // the panel's Apply (applyAndSchedule: the proposal's ops, F9, then the leveling in the order, then the assignment dates), on its copy
  assert.ok(applyOps(screenDb, out.ops, { hoursPerDay: 8 }).ok);
  assert.ok(scheduleProjects(screenDb, ids, {}).ok);
  levelInProposedOrder(screenDb, ids, out.priority);
  syncAssignmentDates(screenDb);
  // the tool's own apply, the same seed
  const applied = ok(await run('optimize_schedule', { handle: np.handle, ...args, apply: true }));
  assert.equal(applied.applied, true);
  const dates = (d: typeof db) => rows(d, 'TASK').map((t) => [t.task_code, t.early_start_date, t.early_end_date, t.remain_drtn_hr_cnt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(dates(screenDb), dates(db), 'the same dates as the tool’s apply');
});
