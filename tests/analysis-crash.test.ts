import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { crashSchedule } from '../core/analysis/crash.ts';
import { evaluateBatch } from '../core/analysis/batch.ts';

// Paths S-A-B-F = 16 d, S-A-D-F = 14 d, S-C-F = 10 d. Crashing A shortens both A paths; B only the first.
function net(): { db: Db; pid: string } {
  const db: Db = { tables: {} };
  const r = applyOps(db, [
    { op: 'add_project', id: 'CR', start: '2026-03-02' },
    { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' },
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 10 },
    { op: 'add_activity', id: 'B', name: 'B', duration_days: 6 },
    { op: 'add_activity', id: 'C', name: 'C', duration_days: 10 },
    { op: 'add_activity', id: 'D', name: 'D', duration_days: 4 },
    { op: 'add_activity', id: 'F', name: 'Finish', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'S', succ: 'A' }, { op: 'add_relationship', pred: 'S', succ: 'C' },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'A', succ: 'D' },
    { op: 'add_relationship', pred: 'B', succ: 'F' }, { op: 'add_relationship', pred: 'C', succ: 'F' }, { op: 'add_relationship', pred: 'D', succ: 'F' },
  ], { calendarDays: true });
  assert.ok(r.ok, JSON.stringify(r.error));
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  return { db, pid };
}

test('crash: cheapest cut, step sized to the next near-critical path, then a cut set across parallel paths', async () => {
  const { db, pid } = net();
  const before = JSON.stringify(db);
  const r = await crashSchedule(db, [pid], {
    targetDays: 5,
    activities: [{ id: 'A', min_days: 7, cost_per_day: 300 }, { id: 'B', min_days: 3, cost_per_day: 100 }, { id: 'D', min_days: 2, cost_per_day: 50 }],
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.stringify(db), before, 'nothing is kept');
  assert.equal(r.stop, 'SUCCESS');
  assert.equal(r.days_gained, 5);
  // step 1: B alone (100/d) for 2 d, until A-D-F (14 d) is critical too
  assert.deepEqual(r.steps[0].activities.map((a) => a.id), ['B']);
  assert.equal(r.steps[0].days_gained, 2);
  // then both A paths are critical: B+D (150/d) beats A (300/d)
  assert.deepEqual(r.steps[1].activities.map((a) => a.id).sort(), ['B', 'D']);
  // B is down to 3 d after 3 more days; then only A can shorten both paths
  assert.ok(r.steps.some((s) => s.activities.length === 1 && s.activities[0].id === 'A'));
  assert.equal(r.direct_cost, 2 * 100 + 1 * 150 + 2 * 300);
  assert.ok(r.ops.every((o) => o.op === 'update_activity'));
});

test('crash: exhausted, already met, least total cost, no data defaults', async () => {
  const { db, pid } = net();
  const ex = await crashSchedule(db, [pid], { targetDays: 10, activities: [{ id: 'B', min_days: 4, cost_per_day: 10 }] });
  assert.ok(ex.ok);
  assert.equal(ex.stop, 'EXHAUSTED');
  assert.equal(ex.days_gained, 2);
  const met = await crashSchedule(db, [pid], { targetFinish: '2027-01-01' });
  assert.ok(met.ok && met.stop === 'ALREADY_MET');
  // indirect 120/d: B (100) pays, B+D (150) does not
  const opt = await crashSchedule(db, [pid], { indirectPerDay: 120, activities: [{ id: 'A', min_days: 7, cost_per_day: 300 }, { id: 'B', min_days: 3, cost_per_day: 100 }, { id: 'D', min_days: 2, cost_per_day: 50 }] });
  assert.ok(opt.ok);
  assert.equal(opt.stop, 'SUCCESS');
  assert.equal(opt.days_gained, 2);
  assert.equal(opt.total_cost, 200 - 240);
  const def = await crashSchedule(db, [pid], { targetDays: 2 });
  assert.ok(def.ok && def.stop === 'SUCCESS' && def.note);
  assert.equal((await crashSchedule(db, [pid], {})).ok, false);
});

test('evaluate_batch: many scenarios, base once, nothing kept, errors per scenario', async () => {
  const { db, pid } = net();
  const before = JSON.stringify(db);
  const r = await evaluateBatch(db, [pid], [
    { name: 'B shorter', overrides: [{ op: 'update_activity', id: 'B', duration_days: 3 }] },
    { name: 'C longer', overrides: [{ op: 'update_activity', id: 'C', duration_days: 20 }] },
    { name: 'bad', overrides: [{ op: 'update_activity', id: 'NOPE', duration_days: 3 }] },
  ]);
  assert.ok(r.ok);
  assert.equal(JSON.stringify(db), before);
  const by = Object.fromEntries(r.scenarios.map((s) => [s.name, s]));
  assert.equal(by['B shorter'].finish_delta_days, -2);
  assert.equal(by['C longer'].finish_delta_days, 4);
  assert.ok(by['C longer'].became_critical!.includes('C'));
  assert.equal(by.bad.ok, false);
  assert.equal(r.best, 'B shorter');
  assert.ok(by['B shorter'].changed!.some((c) => c.id === 'B'));
});

test('MCP evaluate_batch and crash_schedule (apply is one undoable change)', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const { join } = await import('node:path');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const o = await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo alex-road.xer') });
  assert.equal(o.err, false, JSON.stringify(o.d));
  const h = o.d.handle;
  const { readFileSync } = await import('node:fs');
  const xer = join(import.meta.dirname, '..', 'Sample XERs', 'cairo alex-road.xer');
  const id = (await import('../renderer/io.ts')).readRaw(new Uint8Array(readFileSync(xer)), 'xer').db.tables.TASK.rows.find((t) => t.task_type === 'TT_Task')!.task_code;
  const b = await call('evaluate_batch', { handle: h, scenarios: [{ name: 'one', overrides: [{ op: 'update_activity', id, duration_days: 1 }] }, { name: 'bad', overrides: [{ op: 'nope' }] }] });
  assert.equal(b.err, false, JSON.stringify(b.d));
  assert.equal(b.d.scenarios.length, 2);
  assert.equal(b.d.scenarios[1].ok, false);
  assert.equal((await call('evaluate_batch', { handle: h, scenarios: [] })).d.error.code, 'bad_input');
  const c = await call('crash_schedule', { handle: h, target_days: 5, apply: true });
  assert.equal(c.err, false, JSON.stringify(c.d));
  assert.equal(c.d.stop, 'SUCCESS');
  assert.equal(c.d.applied, true);
  const again = await call('crash_schedule', { handle: h, target_finish: c.d.finish });
  assert.equal(again.d.stop, 'ALREADY_MET', 'the crashed durations were kept and rescheduled');
  assert.equal((await call('crash_schedule', { handle: h })).d.error.code, 'bad_input');
});

const sample = async (f: string) => { const { readFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { detectFormat, readRaw } = await import('../renderer/io.ts'); const p = join(import.meta.dirname, '..', 'Sample XERs', f), b = new Uint8Array(readFileSync(p)); return readRaw(b, detectFormat(p, b)).db; };

test('crash on real files: Polaris Rev0 after F9 (assignments follow the crash), JWM through an LOE (matches evaluate)', async () => {
  const { syncAssignmentDates } = await import('../core/resource/assign.ts');
  const { evaluate } = await import('../core/query/evaluate.ts');
  // Polaris: F9 gives every assignment the activity's dates; crashed activities used to keep that span and hold their
  // late start back, so steps paid for days they did not gain (361 and 360 crashed 13 d for 1 d)
  const pol = await sample('Polaris_DC1_Baseline_Rev0.xer');
  const pp = rows(pol, 'PROJECT')[0].proj_id;
  scheduleProjects(pol, [pp]); syncAssignmentDates(pol);
  const acts = rows(pol, 'TASK').filter((t) => t.task_type === 'TT_Task' && !t.act_end_date).map((t) => ({ id: t.task_code, min_days: Math.round((Number(t.remain_drtn_hr_cnt) / 8) * 0.6), cost_per_day: 100 + (Number(t.task_id) % 7) * 100 }));
  const r = await crashSchedule(pol, [pp], { targetFinish: '2027-10-01', activities: acts });
  assert.ok(r.ok && r.stop === 'SUCCESS', JSON.stringify(r).slice(0, 300));
  for (const s of r.steps) assert.ok(Math.abs(s.days_gained - s.activities[0].days) < 0.01, `step ${s.step}: ${s.activities.map((a) => a.id).join(' ')} crashed ${s.activities[0].days} d for ${s.days_gained} d`);
  assert.ok(r.ops.every((o: any) => o.assignments_follow === true));
  // JWM: the LOE G-P-001 ends at the finish with an FF into HO-001; it used to make an uncuttable path (EXHAUSTED, 0 steps)
  const jwm = await sample('Copy of JWM - Baseline Programme Rev 05A.xer');
  const jp = rows(jwm, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  scheduleProjects(jwm, jp);
  const e = evaluate(jwm, jp, { overrides: [{ op: 'update_activity', id: 'HO-001', duration_days: 10 }] });
  assert.ok(e.ok);
  const c = await crashSchedule(jwm, jp, { targetDays: 4, activities: [{ id: 'HO-001', min_days: 10, cost_per_day: 100 }] });
  assert.ok(c.ok && c.stop === 'SUCCESS', JSON.stringify(c).slice(0, 300));
  assert.equal(c.finish, e.finish);
  assert.equal(c.days_gained, -e.finish_delta_days!);
});

test('crash: an LOE ending at the finish does not block; LDs need a contract date', async () => {
  const { db, pid } = net();
  const r = applyOps(db, [{ op: 'add_activity', id: 'PM', name: 'Project management', type: 'loe' }, { op: 'add_relationship', pred: 'S', succ: 'PM', type: 'SS' }, { op: 'add_relationship', pred: 'B', succ: 'PM', type: 'FF' }], { calendarDays: true });
  assert.ok(r.ok);
  scheduleProjects(db, [pid]);
  const c = await crashSchedule(db, [pid], { targetDays: 2 });
  assert.ok(c.ok && c.stop === 'SUCCESS' && c.days_gained === 2, JSON.stringify(c).slice(0, 300));
  const ld = await crashSchedule(db, [pid], { indirectPerDay: 10, ldPerDay: 1000, activities: [{ id: 'B', min_days: 3, cost_per_day: 100 }] });
  assert.ok(ld.ok);
  assert.equal(ld.days_gained, 0, 'without target_finish the LDs do not pay for crashing');
  assert.ok(ld.warnings.some((w) => /ld_per_day needs target_finish/.test(w)));
  assert.equal((await crashSchedule(db, [pid], { ldPerDay: 1000 })).ok, false);
});

test('MCP: long analyses report progress, stay cancellable and keep the server answering', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'LONG', start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < 60; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 3 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  const scenarios = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, overrides: [{ op: 'update_activity', id: `A${i % 60}`, duration_days: 1 + (i % 5) }] }));
  const job = (await call('evaluate_batch', { handle: np.handle, scenarios, async: true })).d.job_id;
  assert.ok(job);
  // the server answers other calls while it runs, and the job shows its progress
  const st = await call('server_status', {});
  assert.equal(st.err, false);
  let view = (await call('job_status', { job_id: job })).d;
  for (let k = 0; k < 50 && view.status === 'running' && !view.progress; k++) { await new Promise((r) => setTimeout(r, 20)); view = (await call('job_status', { job_id: job })).d; }
  assert.match(String(view.progress ?? ''), /scenario \d+ of 200/);
  await call('cancel_job', { job_id: job });
  view = (await call('job_status', { job_id: job, wait_seconds: 10 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
});

test('shutdown mid-crash: the trial durations are put back before anything is saved', async () => {
  const { rollbackRunning } = await import('../core/journal.ts');
  const { db, pid } = net();
  const before = JSON.stringify(db);
  let paused!: () => void;
  const atStep = new Promise<void>((r) => { paused = r; });
  // the run stops for good at its second step, with the first step's crash applied to the real rows
  const run = crashSchedule(db, [pid], { targetDays: 5, activities: [{ id: 'B', min_days: 3, cost_per_day: 100 }, { id: 'A', min_days: 7, cost_per_day: 300 }, { id: 'D', min_days: 2, cost_per_day: 50 }], tick: async (done) => { if (done === 1) { paused(); await new Promise(() => {}); } } });
  void run;
  await atStep;
  assert.notEqual(JSON.stringify(db), before, 'mid-run, the rows hold a trial state');
  assert.equal(rollbackRunning(), 1);
  assert.equal(JSON.stringify(db), before, 'what shutdown saves is the project as it was');
});
