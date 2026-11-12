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
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { rows, type Db } from '../core/db.ts';
import { dbToLines } from '../core/db-file.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeWhiqFields } from '../core/analysis/whiq-fields.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { runMonteCarlo } from '../core/risk/montecarlo.ts';
import { config, sessions, setRoots } from '../mcp/runtime.ts';
import { reasonerModelPath } from '../core/analysis/hrmRuntime.ts';
import { replaceDb, setUi, mutate, getDb, getDbVersion, getUi } from '../renderer/store.ts';
import { startToolRun, stampNow, taskIdLookup } from '../renderer/views/toolRun.ts';
import { afterCrash, afterOptimize, applyResult } from '../renderer/views/applyResult.ts';
import { answerOf, cancelRun, endedAnswer, makeRunDir, matchesCancel, removeLeftBehind, removeRunDir, refused } from '../main/analysis-run-control.ts';
import { addRisk, linkActivity } from '../core/risk/register.ts';
import { fmtDate } from '../renderer/model.ts';
import { criticalityCell, impactText, priorityShown, probabilityText, riskRowText, sensitivityText, stdDevText, staleReason, changedSince, wasCancelled, betweenCount, crashArgs, crashStopped, errorText, floatPathsArgs, lintArgs, lintStopped, monteCarloArgs, monteCarloResult, monteCarloStopped, optimizeArgs, levelInProposedOrder, optimizeNotes, OPTIMIZE_ADVICE, refusal, type ToolAnswer } from '../renderer/views/toolAnswers.ts';

setRoots(null, tmpdir());
config.screens = true; // (this file plays the app's screens: the Export's child process sets it, main/analysis-export.ts)
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
  const args = monteCarloArgs({ iterations: 20100, seed: 7, riskEvents: 'pre' });
  assert.equal(args.iterations, 20100, 'as typed: no floor, no cap');
  const out = ok(await run('monte_carlo', { handle: h, ...args }));
  const screen = monteCarloResult(out, (c) => ({ taskId: `id-${c}`, projId: 'p' }));
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
  const screen = monteCarloResult(out, () => null);
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
  assert.match(OPTIMIZE_ADVICE, /^Review the biggest changes before applying; Undo takes the apply back\. Apply makes the new durations current .*WHIQ original duration \(d\).*WHIQ run <N> duration \(d\).*WHIQ duration change \(d\), WHIQ change note and WHIQ leveling rank\.$/);
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
  const screen = monteCarloResult(out, (c) => ({ taskId: `id-${c}`, projId: 'p' }));
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
  // the bars: the engine's whole-day histogram, bin for bin (the screens' process, config.screens); an agent's call has 20 equal bars
  assert.deepEqual(screen.histogram, engine.histogram.map((b) => ({ start: b.start, end: b.end, count: b.count, cumPct: b.cumPct })));
  config.screens = false;
  try { assert.equal(ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11 })).histogram.length, 20); } finally { config.screens = true; }
  // the tornado: the engine's list, in its order
  assert.deepEqual(screen.sensitivity.map((x) => [x.code, x.rho]), engine.sensitivity.map((x) => [x.code, x.rho]));
  // the S-curve: the engine's own points (a point for each finish, thinned), not one made from the bars
  assert.equal(screen.cumulative.length, engine.cumulative.length);
  assert.deepEqual(screen.cumulative.map((p) => [p.t, p.pct]), engine.cumulative.map((p) => [Math.round(p.t), p.pct]));
  assert.ok(screen.cumulative.length > screen.histogram.length, 'smoother than the bars');
  // the answer's rows are the export's table's columns; the screens' process lists every activity, an agent's call 25 (here 4 activities: all)
  const few = ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11 }));
  assert.equal(few.criticality.length, engine.activities.length);
  assert.equal(few.criticality[0].critical_pct, Math.round(few.criticality[0].critical_pct * 100) / 100, 'the answer’s percent is to 2 decimals');
  const dir = mkdtempSync(join(tmpdir(), 'p6-crit-'));
  const ex = ok(await run('monte_carlo', { handle: np.handle, iterations: 700, seed: 11, export: dir }));
  const whole = JSON.parse((await import('node:fs')).readFileSync(ex.exported.files[0].path, 'utf8'));
  for (const e of engine.activities) assert.equal(whole.criticality.find((x: { id: string }) => x.id === e.code).critical_pct, e.criticality, 'the export keeps the exact value');
  assert.deepEqual(Object.keys(few.criticality[0]), ['id', 'name', 'milestone', 'critical_pct', 'deterministic_finish', 'mean_finish', 'p50_finish', 'p80_finish', 'sensitivity', 'min_remaining_hours', 'mean_remaining_hours', 'max_remaining_hours']);
});

/** the WHIQ fields of a project: label, activity, value */
const whiq = (d: Db) => {
  const label = new Map(rows(d, 'UDFTYPE').map((u) => [u.udf_type_id, u.udf_type_label])), code = new Map(rows(d, 'TASK').map((t) => [t.task_id, t.task_code]));
  return rows(d, 'UDFVALUE').filter((v) => String(label.get(v.udf_type_id)).startsWith('WHIQ')).map((v) => `${label.get(v.udf_type_id)}|${code.get(v.fk_id)}|${v.udf_number || v.udf_text}`).sort();
};

test('Optimize: Apply works on any schedule (the answer has the whole placement order, 130 activities here) and the project it makes has the dates of the tool’s apply: true', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const np = (await run('new_project', { id: 'OPA', start: '2026-06-01' })).out as any;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 12 }];
  for (let i = 0; i < 130; i++) ops.push({ op: 'add_activity', id: `T${i}`, name: `T${i}`, duration_days: 2 + (i % 5) }, { op: 'assign_resource', activity: `T${i}`, resource: 'civil', units_per_day: 16 });
  for (let i = 0; i < 130; i += 3) if (i + 3 < 130) ops.push({ op: 'add_relationship', pred: `T${i}`, succ: `T${i + 3}` });
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  const db = sessions.get(np.handle)!.db, screenDb = structuredClone(db), ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const args = optimizeArgs({}, 3, 5);
  const out = ok(await run('optimize_schedule', { handle: np.handle, ...args, field_data: true }));
  assert.ok(out.leveled_activities === 130 && out.priority_total === 130);
  assert.equal(out.priority.length, 130, 'the whole order: more than 100, so Apply is not disabled');
  // the panel's Apply (applyAndSchedule: the proposal's ops, F9, then the leveling in the order, then the assignment dates), on its copy
  assert.ok(applyOps(screenDb, out.ops, { hoursPerDay: 8 }).ok);
  assert.ok(scheduleProjects(screenDb, ids, {}).ok);
  writeWhiqFields(screenDb, out.field_data, { hoursPerDay: 8 });
  levelInProposedOrder(screenDb, ids, out.priority);
  syncAssignmentDates(screenDb);
  // the tool's own apply, the same seed
  const applied = ok(await run('optimize_schedule', { handle: np.handle, ...args, apply: true }));
  assert.equal(applied.applied, true);
  const dates = (d: typeof db) => rows(d, 'TASK').map((t) => [t.task_code, t.early_start_date, t.early_end_date, t.remain_drtn_hr_cnt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(dates(screenDb), dates(db), 'the same dates as the tool’s apply');
  assert.deepEqual(whiq(screenDb), whiq(db), 'the same WHIQ fields and values as the tool’s apply');
  assert.equal(whiq(db).length, 130, 'a rank on each leveled activity');
});

test('Optimize: the screen’s Apply writes the run rule through writeWhiqFields, a second Apply is run 2 as the tool’s is, and a schedule in progress is refused in the tool’s words', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const h = await chain(6);
  const db = sessions.get(h)!.db, screenDb = structuredClone(db), ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const screenApply = (out: any) => { assert.ok(applyOps(screenDb, out.ops, { hoursPerDay: 8 }).ok); assert.ok(scheduleProjects(screenDb, ids, {}).ok); writeWhiqFields(screenDb, out.field_data, { hoursPerDay: 8 }); syncAssignmentDates(screenDb); };
  // the shared function: Apply’s after-step is writeWhiqFields, and the answer asks for the run rule
  assert.match(readFileSync(new URL('../renderer/views/applyResult.ts', import.meta.url), 'utf8'), /afterOptimize[^]*writeWhiqFields\(d, res\.field_data!/);
  for (const crash of [[{ id: 'L1', crash_days: 6, crash_cost: 10 }, { id: 'L2', crash_days: 7, crash_cost: 10 }], [{ id: 'L1', crash_days: 4, crash_cost: 10 }, { id: 'L3', crash_days: 8, crash_cost: 10 }]]) {
    const args = { seed: 1, samples: 3, activities: crash };
    const out = ok(await run('optimize_schedule', { handle: h, ...args, field_data: true }));
    assert.equal(out.field_data.reasoner, undefined, 'one rule for every apply: field_data carries no rule flag');
    screenApply(out);
    assert.equal(ok(await run('optimize_schedule', { handle: h, ...args, apply: true })).applied, true);
    assert.deepEqual(whiq(screenDb), whiq(db), 'the screen’s Apply and the tool’s apply leave the same fields');
  }
  assert.ok(whiq(db).some((x) => x.startsWith('WHIQ run 1 duration (d)|L1|')), 'the second apply is run 2');
  // a schedule in progress: the panel’s run shows the tool’s refusal as text
  ok(await run('edit', { handle: h, operations: [{ op: 'update_activity', id: 'L5', actual_start: '2026-03-02' }] }));
  const why = refusal(await run('optimize_schedule', { handle: h, ...optimizeArgs({}, 3, 1), field_data: true }));
  assert.match(why!, /nothing was run\. The schedule is in progress \(1 activity has actual dates or progress\), and the schedule reasoner plans only work that has not started\./);
  assert.match(why!, /crash_schedule.*level_resources/);
});

test('Crashing: the panel’s Apply on a copy leaves the WHIQ fields and values of the tool’s apply: true', async () => {
  const h = await chain(6);
  const db = sessions.get(h)!.db, screenDb = structuredClone(db), ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const args = { target_days: 40 };
  const out = ok(await run('crash_schedule', { handle: h, ...args, field_data: true }));
  assert.ok(out.ops.length > 0 && out.field_data.changes.length > 0);
  assert.equal(ok(await run('crash_schedule', { handle: h, ...args })).field_data, undefined, 'only when asked');
  assert.ok(applyOps(screenDb, out.ops, { hoursPerDay: 8 }).ok);
  assert.ok(scheduleProjects(screenDb, ids, {}).ok);
  writeWhiqFields(screenDb, out.field_data, { hoursPerDay: 8 });
  syncAssignmentDates(screenDb);
  assert.equal(ok(await run('crash_schedule', { handle: h, ...args, apply: true })).applied, true);
  assert.deepEqual(whiq(screenDb), whiq(db));
  assert.ok(whiq(db).some((x) => x.startsWith('WHIQ duration change (d)|')));
  // a field of another type refuses in words, nothing written
  const bad = structuredClone(screenDb);
  assert.ok(applyOps(bad, [{ op: 'delete_udf', udf: 'WHIQ change note' }, { op: 'add_udf', name: 'WHIQ change note', data_type: 'number' }], {}).ok);
  assert.throws(() => writeWhiqFields(bad, out.field_data, {}), /"WHIQ change note" of type number/);
});

// ================================================================ round 2b, second re-check: the screens run as the tool, on the open projects, and say what they hold
/** What the window's main process does for a panel's run, with the real child: the saved database (the store's, as saveNow would write it), the
 *  request with the run's scope, and the child's answer read as main/analysis-run-control.ts reads it. */
const calls: { tool: string; args: Record<string, unknown>; parts?: { scope?: string[] }; id?: string }[] = [];
const cancels: unknown[] = [];
async function childRun(tool: string, args: Record<string, unknown>, hoursPerDay: number, parts?: { scope?: string[] }, keepWork?: boolean, id?: string): Promise<ToolAnswer> {
  calls.push({ tool, args, parts, id });
  const dir = mkdtempSync(join(tmpdir(), 'screens-run-'));
  writeFileSync(join(dir, 'database.json'), dbToLines(getDb(), {}).join('\n') + '\n');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'main', 'analysis-export.ts')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } });
  const lines: string[] = [], err: Buffer[] = [];
  child.stderr.on('data', (b) => err.push(b));
  child.stdin.end(`${JSON.stringify({ file: join(dir, 'database.json'), tool, args, hoursPerDay, ...parts, ...(keepWork ? { progress: true } : {}) })}\n`);
  const closed = new Promise<number | null>((res) => child.on('close', res));
  for await (const line of createInterface({ input: child.stdout })) if (line.trim() && !line.startsWith('{"progress":')) lines.push(line);
  return answerOf(lines, await closed, Buffer.concat(err).toString('utf8'));
}
(globalThis as any).window = { p6: { saveDb: async () => true, analysisRun: childRun, analysisCancel: async (o: unknown) => { cancels.push(o); return true; }, onAnalysisProgress: () => () => {} } };
const openOnly = (db: Db, names: string[]) => { replaceDb(structuredClone(db)); const ids = rows(getDb(), 'PROJECT').filter((p) => names.includes(p.proj_short_name)).map((p) => p.proj_id); setUi({ openProjects: ids }); return ids; };
const nameOf = (id: string) => rows(getDb(), 'PROJECT').find((p) => p.proj_id === id)!.proj_short_name as string;

/** P (A 10 d, B 5 d, S 2 d, milestone M) with estimates, and copies of it, whose A is made longer: Activity IDs shared by the projects. */
async function projects(copies: string[], resource = false) {
  const np = (await run('new_project', { id: 'P', start: '2026-03-02' })).out as any;
  const est = (project?: string) => [
    { op: 'set_estimates', ...(project ? { project } : {}), activity: 'A', min_days: 8, most_likely_days: 10, max_days: 20 }, { op: 'set_estimates', ...(project ? { project } : {}), activity: 'B', min_days: 4, most_likely_days: 5, max_days: 9 },
    { op: 'set_estimates', ...(project ? { project } : {}), activity: 'S', min_days: 1, most_likely_days: 2, max_days: 4 }];
  ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: [
    ...(resource ? [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 4 }] : []),
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_activity', id: 'S', name: 'Side', duration_days: 2 },
    { op: 'add_activity', id: 'M', name: 'Milestone', duration_days: 0, type: 'finish_milestone' }, { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'S', succ: 'M' },
    ...(resource ? ['A', 'B', 'S'].map((a) => ({ op: 'assign_resource', activity: a, resource: 'civil', units_per_day: 16 })) : []), ...est()] }));
  for (const [i, c] of copies.entries()) ok(await run('edit', { handle: np.handle, owner_key: np.owner_key, operations: [{ op: 'copy_project', from: 'P', id: c }, { op: 'update_activity', project: c, id: 'A', duration_days: 14 + i * 3 }, ...est(c)] }));
  ok(await run('schedule', { handle: np.handle, owner_key: np.owner_key }));
  return { h: np.handle as string, db: sessions.get(np.handle)!.db };
}

test('B-H2: with 2 of 3 projects open the run covers exactly those two (the scope), as the tool on those two does, and no project argument is given', async () => {
  const { db } = await projects(['Q', 'R']);
  const ids = openOnly(db, ['P', 'Q']);
  const args = monteCarloArgs({ iterations: 300, seed: 5, riskEvents: 'pre' });
  assert.equal('project' in args, false, 'the screen gives no project argument');
  const r = await startToolRun('monte_carlo', args, { keepWork: true }).done;
  const out = ok(r);
  assert.deepEqual(calls.at(-1)!.parts, { scope: ids }, 'the open projects are the scope of the run');
  assert.deepEqual([...new Set(out.criticality.map((x: any) => x.project))].sort(), ['P', 'Q'], 'rows of the two open projects only, each naming its project');
  const engine = await runMonteCarlo(getDb(), ids, { iterations: 300, seed: 5, riskEvents: 'pre' });
  assert.equal(out.criticality.length, engine.activities.length);
  const screen = monteCarloResult(out, taskIdLookup());
  assert.equal(screen.percentiles.P50, Math.round(engine.percentiles.P50)); assert.equal(screen.max, Math.round(engine.max));
  for (const e of engine.activities) assert.equal(screen.activities.find((a: any) => a.taskId === e.taskId)!.criticality, e.criticality, `${e.code} in ${nameOf(e.projId)}`);
  assert.deepEqual(r.stamp.projects, ids, 'the result is stamped with the projects it was run on');
});

test('B-H1: Apply of a result refuses, as text, when the project changed since the run (the edit made while it ran stays), and applies when it did not', async () => {
  const h = await chain(6);
  const ids = openOnly(sessions.get(h)!.db, ['CH']);
  const run1 = await startToolRun('crash_schedule', { target_days: 40, field_data: true }, { keepWork: true }).done;
  const out = ok(run1);
  assert.ok(out.ops.some((o: any) => o.id === 'L0'), 'the proposal changes L0 from its old 10 d');
  // the user edits L0 from 10 d to 20 d while the run goes
  mutate('edit L0', (d) => { assert.ok(applyOps(d, [{ op: 'update_activity', id: 'L0', duration_days: 20 }], { hoursPerDay: 8 }).ok); });
  const hours = () => rows(getDb(), 'TASK').find((t) => t.task_code === 'L0')!.target_drtn_hr_cnt;
  const version = getDbVersion();
  const why = applyResult(run1.stamp, 'Crash schedule', out.ops, afterCrash(out, run1.stamp));
  assert.equal(why, 'The project changed since this run: run it again.');
  assert.equal(hours(), '160', 'the user’s 20 d is not undone');
  assert.equal(getDbVersion(), version, 'nothing was written');
  assert.equal(rows(getDb(), 'UDFVALUE').length, 0, 'no WHIQ field was written');
  // the open projects differ: refused too
  assert.equal(staleReason({ dbVersion: 1, projects: ['a', 'b'] }, { dbVersion: 1, projects: ['a'] }), 'The project changed since this run: run it again.');
  assert.equal(changedSince({ dbVersion: 1, projects: ['a'] }, { dbVersion: 1, projects: ['a'] }), false);
  // run again on the new state: its result applies
  const run2 = await startToolRun('crash_schedule', { target_days: 40, field_data: true }, { keepWork: true }).done;
  const out2 = ok(run2);
  assert.equal(applyResult(run2.stamp, 'Crash schedule', out2.ops, afterCrash(out2, run2.stamp)), null);
  assert.ok(rows(getDb(), 'UDFVALUE').length > 0, 'applied, with the WHIQ fields');
  assert.deepEqual(getUi().openProjects, ids);
});

test('B-M6: a refused Apply (a WHIQ field of another type) is text with the reason, nothing is changed, and the result is still there to apply after the field is fixed', async () => {
  const h = await chain(6);
  openOnly(sessions.get(h)!.db, ['CH']);
  mutate('clash', (d) => { assert.ok(applyOps(d, [{ op: 'add_udf', name: 'WHIQ change note', subject: 'activity', data_type: 'number' }], {}).ok); });
  const r = await startToolRun('crash_schedule', { target_days: 40, field_data: true }, { keepWork: true }).done;
  const out = ok(r);
  const before = JSON.stringify(rows(getDb(), 'TASK').map((t) => [t.task_code, t.target_drtn_hr_cnt])), version = getDbVersion();
  const why = applyResult(r.stamp, 'Crash schedule', out.ops, afterCrash(out, r.stamp));
  assert.match(why!, /^Not applied: The project already has an activity field "WHIQ change note" of type number/);
  assert.equal(JSON.stringify(rows(getDb(), 'TASK').map((t) => [t.task_code, t.target_drtn_hr_cnt])), before, 'nothing was changed');
  assert.equal(getDbVersion(), version);
  mutate('fix', (d) => { assert.ok(applyOps(d, [{ op: 'delete_udf', udf: 'WHIQ change note' }], {}).ok); });
  const again = await startToolRun('crash_schedule', { target_days: 40, field_data: true }, { keepWork: true }).done;
  assert.equal(applyResult(again.stamp, 'Crash schedule', ok(again).ops, afterCrash(ok(again), again.stamp)), null);
});

test('B-M1: Optimize Apply on two open projects that share Activity IDs gives the dates of the tool’s apply: true', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { h, db } = await projects(['Q'], true);
  const ids = openOnly(db, ['P', 'Q']);
  const args = optimizeArgs({}, 3, 5);
  const r = await startToolRun('optimize_schedule', { ...args, field_data: true }, { keepWork: true }).done;
  const out = ok(r);
  assert.ok(out.leveled_activities > 0 && out.priority.length === out.priority_total && typeof out.priority[0] === 'object', 'the order names each activity by Activity ID and project');
  assert.deepEqual(Object.keys(out.priority[0]).sort(), ['id', 'project']);
  assert.equal(applyResult(r.stamp, 'Optimize schedule (reasoner)', out.ops, afterOptimize(out as Parameters<typeof afterOptimize>[0], r.stamp)), null);
  assert.equal(ok(await run('optimize_schedule', { handle: h, ...args, apply: true })).applied, true);
  const dates = (d: Db) => { const p = new Map(rows(d, 'PROJECT').map((x) => [x.proj_id, x.proj_short_name])); return rows(d, 'TASK').map((t) => [p.get(t.proj_id), t.task_code, t.early_start_date, t.early_end_date]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)); };
  assert.deepEqual(dates(getDb()), dates(sessions.get(h)!.db), 'the same dates as the tool’s apply, in both projects');
  // the tool's single-project answer is unchanged: the Activity IDs alone
  const one = openOnly((await projects([], true)).db, ['P']);
  assert.ok(one.length === 1);
  const o1 = ok(await startToolRun('optimize_schedule', { ...args }, { keepWork: true }).done);
  assert.equal(typeof o1.priority[0], 'string');
  void ids;
});

test('B-M2: the Risks rows, milestones and tornado are found by Activity ID and project: two projects sharing IDs are different rows, and an activity deleted since the run is not clickable', async () => {
  const { db } = await projects(['Q']);
  openOnly(db, ['P', 'Q']);
  const r = await startToolRun('monte_carlo', monteCarloArgs({ iterations: 300, seed: 9, riskEvents: 'pre' }), { keepWork: true }).done;
  const res = monteCarloResult(ok(r), taskIdLookup());
  type Row = { taskId: string; code: string; project: string };
  const check = (list: Row[], what: string) => {
    assert.ok(list.length > 0, what);
    for (const x of list) { const t = rows(getDb(), 'TASK').find((y) => y.task_id === x.taskId)!; assert.ok(t, `${what} ${x.code}/${x.project} has its row`); assert.deepEqual([t.task_code, nameOf(t.proj_id)], [x.code, x.project], what); }
    assert.equal(new Set(list.map((x) => `${x.project}|${x.code}`)).size, list.length, `${what}: one row for each activity of each project`);
    assert.equal(new Set(list.map((x) => x.taskId)).size, list.length, `${what}: distinct rows`);
  };
  check(res.activities as unknown as Row[], 'grid'); check(res.milestones as unknown as Row[], 'milestones'); check(res.sensitivity as unknown as Row[], 'tornado');
  assert.deepEqual((res.activities as unknown as Row[]).filter((a) => a.code === 'A').map((a) => a.project).sort(), ['P', 'Q']);
  // Q's A is deleted after the run: the pair is not there; P's A is
  mutate('delete', (d) => { assert.ok(applyOps(d, [{ op: 'delete_activity', project: 'Q', id: 'A' }], { hoursPerDay: 8 }).ok); });
  const find = taskIdLookup();
  assert.equal(find('A', 'Q'), null, 'shown, not clickable');
  assert.ok(find('A', 'P'));
});

test('B-M3: the Risks page shows what master showed for the same seeded run: deviation, percentiles, probability, every grid cell, risk impact and the 50 % class', async () => {
  const { h, db } = await projects([]);
  const P = rows(db, 'PROJECT')[0].proj_id, task = (c: string) => rows(db, 'TASK').find((t) => t.task_code === c)!.task_id;
  const risk = addRisk(db, P, { risk_name: 'Late steel', status_code: 'RS_Open', pre_prob_pct: '44.49', pre_sched_impact_hr_cnt: '10' });
  assert.equal(typeof linkActivity(db, risk.proj_risk_id, task('A')), 'object');
  const ids = openOnly(db, ['P']);
  const engine = await runMonteCarlo(getDb(), ids, { iterations: 700, seed: 11, riskEvents: 'pre' });
  const r = await startToolRun('monte_carlo', monteCarloArgs({ iterations: 700, seed: 11, riskEvents: 'pre' }), { keepWork: true }).done;
  const out = ok(r), screen = monteCarloResult(out, taskIdLookup()), hpd = 8;
  assert.ok(engine.risks.length === 1 && Math.round(engine.stdDevDays * 10) / 10 !== engine.stdDevDays, 'the engine’s figures have more than the answer’s rounded digits');
  // master's formatting, from the engine's own result (git show master:renderer/views/RiskView.tsx: r2, days, Math.round(...), toFixed(2))
  const mr2 = (n: number) => String(Math.round(n * 100) / 100), mdays = (x: number, hp: number) => mr2(x / hp);
  assert.equal(stdDevText(screen), `${mr2(engine.stdDevDays)} calendar days`);
  assert.equal(probabilityText(screen), `${Math.round(engine.probDeterministic * 100)}%`);
  const prefs = { hoursPerDay: 8, dateFormat: 'yyyy-mm-dd' as const, showTime: true, durationDecimals: 0 };
  for (const k of ['P10', 'P50', 'P80', 'P90'] as const) assert.equal(fmtDate(screen.percentiles[k], prefs), fmtDate(engine.percentiles[k], prefs), k);
  for (const [a, b] of [[screen.mean, engine.mean], [screen.min, engine.min], [screen.max, engine.max], [screen.deterministicFinish, engine.deterministicFinish]]) assert.equal(fmtDate(a, prefs), fmtDate(b, prefs));
  assert.deepEqual(screen.risks.map((x) => riskRowText(x, hpd)), engine.risks.map((x) => ({ probability: `${Math.round(x.probability * 100)}%`, impact: mdays(x.hours, hpd), activities: x.activities, occurred: `${Math.round(x.triggeredPct)}%` })));
  assert.equal(riskRowText(screen.risks[0], hpd).impact, '1.25', '10 hours of 8: 1.25 d, not 1.3');
  assert.equal(impactText(10, 12), '0.83', 'with 12 hours to the day');
  assert.equal(riskRowText(screen.risks[0], hpd).probability, '44%', '44.49 % is 44, not 45');
  assert.equal(screen.activities.length, engine.activities.length);
  for (const e of engine.activities) {
    const g = screen.activities.find((x) => x.taskId === e.taskId)!, cell = criticalityCell(g);
    assert.deepEqual([cell.text, cell.critical, cell.bar, sensitivityText(g.sensitivity), g.minDur, g.meanDur, g.maxDur], [`${Math.round(e.criticality)}%`, e.criticality >= 50, `${e.criticality}%`, e.sensitivity == null ? '' : e.sensitivity.toFixed(2), e.minDur, e.meanDur, e.maxDur], e.code);
    assert.deepEqual([fmtDate(g.deterministicFinish, prefs), fmtDate(g.p50Finish, prefs), fmtDate(g.p80Finish, prefs)], [fmtDate(e.deterministicFinish, prefs), fmtDate(e.p50Finish, prefs), fmtDate(e.p80Finish, prefs)], e.code);
  }
  assert.deepEqual(screen.sensitivity.map((s) => [s.code, s.rho.toFixed(2), s.rho.toFixed(3)]), engine.sensitivity.map((s) => [s.code, s.rho.toFixed(2), s.rho.toFixed(3)]), 'the tornado, in the engine’s order');
  // the agent's default answer stays rounded as it was
  const plain = ok(await run('monte_carlo', { handle: h, iterations: 700, seed: 11 }));
  assert.equal(plain.exact, undefined); assert.equal(plain.finish.std_dev_days, Math.round(engine.stdDevDays * 10) / 10);
});

test('B-M4: a second Cancel, while the first has not stopped the run, ends the child’s process tree and says the run was ended and its work was not kept; no timer', async () => {
  // a child that never answers: it ignores its stdin
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>((res) => child.on('close', () => res()));
  const target = { askToStop: () => { if (!child.stdin?.writable) return false; child.stdin.write('cancel\n'); return true; }, end: () => { child.kill('SIGKILL'); } };
  const run = { cancelled: false, keepWork: true, ended: false };
  assert.equal(cancelRun(run, target), 'asked');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'the first Cancel only asked: the child still runs');
  assert.equal(cancelRun(run, target), 'ended');
  await closed;
  assert.equal(run.ended, true); assert.equal(child.signalCode, 'SIGKILL');
  assert.match(endedAnswer('monte_carlo').out.error.message, /was ended.*its work was not kept/);
  assert.equal(endedAnswer('monte_carlo').out.error.code, 'cancelled');
  // before the child exists the Cancel is a flag; a run that keeps nothing is ended by the first Cancel
  const early = { cancelled: false, keepWork: true, ended: false };
  assert.equal(cancelRun(early, null), 'flagged'); assert.equal(early.cancelled, true);
  let ended = 0;
  assert.equal(cancelRun({ cancelled: false, keepWork: false, ended: false }, { askToStop: () => true, end: () => { ended++; } }), 'ended'); assert.equal(ended, 1);
});

test('B-M5: the folders a run leaves in the temp folder are removed when the app quits (now) and at the next start, by the process that made them, not by age', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p6tmp-'));
  const dead = spawn(process.execPath, ['-e', '0']); await new Promise((r) => dead.on('close', r));
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const mk = (name: string) => { const p = join(tmp, name); mkdirSync(p); writeFileSync(join(p, 'database.json'), '{}'); return p; };
    const left = mk(`p6export-${dead.pid}-abc123`), other = mk(`p6export-${live.pid}-def456`), mine = makeRunDir(tmp, process.pid), old = mk('p6export-Zx81aQ'), unrelated = mk('something-else');
    writeFileSync(join(mine, 'database.json'), '{}');
    assert.match(mine, new RegExp(`p6export-${process.pid}-`), 'the name says which process made it');
    const gone = removeLeftBehind(tmp);
    assert.deepEqual(gone.sort(), [`p6export-${dead.pid}-abc123`, 'p6export-Zx81aQ'].sort());
    assert.equal(existsSync(left), false); assert.equal(existsSync(old), false);
    assert.equal(existsSync(other), true, 'a run of a process that is still running is not touched'); assert.equal(existsSync(mine), true, 'nor is this process’s own'); assert.equal(existsSync(unrelated), true);
    // quitting: the folder is removed at once, synchronously
    assert.equal(removeRunDir(mine), true); assert.equal(existsSync(mine), false);
  } finally { live.kill('SIGKILL'); }
});

test('B-L1: a stray line from a dependency does not make a good run "stopped without an answer": the answer is the last non-empty line', async () => {
  const ans = JSON.stringify({ isError: false, out: { fine: 1 } });
  assert.deepEqual(answerOf(['(node:1) ExperimentalWarning: something', ans], 0, '').out, { fine: 1 });
  assert.deepEqual(answerOf(['stray', 'more stray', ans], 0, '').out, { fine: 1 });
  const none = answerOf(['a stray line'], 1, 'boom');
  assert.equal(none.isError, true); assert.match(none.out.error.message, /stopped \(exit 1\) without an answer\. boom Its other output: a stray line/);
  // through the real child, with a dependency that prints a stray line to stdout
  const h = await chain(3);
  const dir = mkdtempSync(join(tmpdir(), 'screens-stray-'));
  writeFileSync(join(dir, 'database.json'), dbToLines(sessions.get(h)!.db, {}).join('\n') + '\n');
  writeFileSync(join(dir, 'stray.mjs'), "process.stdout.write('a stray line from a dependency\\n');\n");
  const child = spawn(process.execPath, ['--import', join(dir, 'stray.mjs'), join(import.meta.dirname, '..', 'main', 'analysis-export.ts')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  child.stdin.end(`${JSON.stringify({ file: join(dir, 'database.json'), tool: 'crash_schedule', args: { target_days: 4 }, hoursPerDay: 8 })}\n`);
  for await (const line of createInterface({ input: child.stdout })) if (line.trim()) lines.push(line);
  assert.ok(lines.length >= 2 && lines.some((l) => l.includes('a stray line')), 'the stray line was on stdout');
  assert.equal(ok(answerOf(lines, 0, '') as ToolAnswer).steps.length > 0, true);
});

test('B-L2: Cancel names its run by an id: two runs have two ids, and another run’s Cancel does not match', async () => {
  const h = await chain(3);
  openOnly(sessions.get(h)!.db, ['CH']);
  cancels.length = 0;
  const a = startToolRun('monte_carlo', monteCarloArgs({ iterations: 20, riskEvents: 'pre' }), { keepWork: true }), b = startToolRun('monte_carlo', monteCarloArgs({ iterations: 20, riskEvents: 'pre' }), { keepWork: true });
  a.cancel(); b.cancel();
  const [ca, cb] = cancels as { id: string }[];
  assert.ok(ca.id && cb.id && ca.id !== cb.id, 'one id for each run');
  assert.deepEqual(Object.keys(ca), ['id'], 'not by tool name');
  assert.equal(matchesCancel({ id: ca.id }, cb), false); assert.equal(matchesCancel({ id: ca.id }, ca), true); assert.equal(matchesCancel({ id: ca.id }), true, 'an Export’s Cancel (no id) is for the running job');
  await Promise.all([a.done, b.done]);
});

test('B-L3 and B-L4: a cancelled run is a status line, not a failure; Optimize lists the first 100 of N while Apply holds the whole order', () => {
  assert.equal(wasCancelled(refused('cancelled', 'The float_paths run was cancelled; nothing was changed.')), true);
  assert.equal(wasCancelled(refused('bad_input', 'No activity "X".')), false);
  assert.equal(wasCancelled({ isError: false, out: {} }), false);
  const whole = Array.from({ length: 14000 }, (_, i) => `T${i}`);
  const s = priorityShown(whole, 14000);
  assert.equal(s.heading, 'Priority (first 100 of 14000)'); assert.equal(s.entries.length, 100);
  assert.equal(priorityShown(['A', 'B'], 2).heading, 'Priority (2)');
  assert.equal(whole.length, 14000, 'the order the answer holds is not cut');
});

test('B-L5: main/preload.ts keeps its original line endings (CRLF throughout, as on master): the diff is the real lines', () => {
  const t = readFileSync(join(import.meta.dirname, '..', 'main', 'preload.ts'), 'utf8');
  const lf = (t.match(/\n/g) ?? []).length, crlf = (t.match(/\r\n/g) ?? []).length;
  assert.ok(lf > 100 && lf === crlf, `${crlf} of ${lf} line ends are CRLF`);
});

test('A-L1 and A-L5: the memory words of a Monte Carlo are of its 20 bars and its listed rows (1,000 bytes a row: 25 for an agent, every activity for the screens)', async () => {
  const { h } = await mcProject();
  const { workNeed, MC_BYTES_PER_LISTED_ROW } = await import('../mcp/workset.ts');
  const s = sessions.get(h)!;
  const n = rows(s.db, 'TASK').length;
  config.screens = false;
  try {
    const agent = workNeed('monte_carlo', { iterations: 20 }, s, () => 1e12)!;
    assert.match(agent.what, /with its result files/); assert.doesNotMatch(agent.what, /histogram/);
    config.screens = true;
    const screens = workNeed('monte_carlo', { iterations: 20 }, s, () => 1e12)!;
    assert.equal(screens.bytes - agent.bytes, (n - Math.min(25, n)) * MC_BYTES_PER_LISTED_ROW, 'the screens reserve a row for every activity, an agent for 25');
  } finally { config.screens = true; }
  assert.equal(MC_BYTES_PER_LISTED_ROW, 1000);
});
