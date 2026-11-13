import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { crashSchedule } from '../core/analysis/crash.ts';
import { evaluateBatch } from '../core/analysis/batch.ts';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';
import { sampleCopy } from './helpers.ts';

// kept runs (4L-13) go to the write root: the test's temp folder, never the folder the tests run in
setRoots(null, tmpdir());

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
  assert.ok(def.ok && def.stop === 'SUCCESS' && def.notes.some((n) => /^No crash data given: each open activity may lose up to \d+% of its remaining duration/.test(n)), JSON.stringify(def.ok && def.notes));
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
  const o = await call('open_file', { path: sampleCopy('cairo alex-road.xer') });
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
  assert.ok(ld.notes.some((w) => /^Ignored: ld_per_day \(it needs target_finish/.test(w)), JSON.stringify(ld.notes));
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

test('platform review 2: crash ops name the project (replayable in a multi-project file); default crashing on JWM keeps going', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'N1', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' }] });
  await call('schedule', { handle: h, owner_key });
  // a kept TIA adds a second project with the same Activity IDs
  assert.equal((await call('tia', { handle: h, owner_key, fragnet: [{ op: 'add_activity', id: 'X', name: 'X', duration_days: 1 }], keep: true })).err, false);
  const c = await call('crash_schedule', { handle: h, owner_key, project: 'N1', target_days: 2, apply: true });
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 300));
  assert.ok(c.d.ops.every((o: any) => o.project === 'N1'));
  assert.equal((await call('edit', { handle: h, owner_key, operations: c.d.ops })).err, false, 'the returned ops replay through edit');
  // JWM, no crash data: it used to gain 1 of 20 days and stop (a holiday on a successor's calendar hid a driving link)
  const jwm = await sample('Copy of JWM - Baseline Programme Rev 05A.xer');
  const jp = rows(jwm, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  scheduleProjects(jwm, jp);
  const r = await crashSchedule(jwm, jp, { targetDays: 20 });
  assert.ok(r.ok);
  assert.ok(r.days_gained >= 10, `gained ${r.days_gained}`);
  assert.ok(r.steps.length > 5);
});

test('crash: with no max_steps it runs to its natural end (past 100 steps); a max_steps given still stops it with CAP', async () => {
  const db: Db = { tables: {} };
  const ops: any[] = [{ op: 'add_project', id: 'LG', start: '2026-03-02' }];
  const n = 130;
  for (let i = 0; i < n; i++) { ops.push({ op: 'add_activity', id: `L${i}`, name: `L${i}`, duration_days: 10 }); if (i) ops.push({ op: 'add_relationship', pred: `L${i - 1}`, succ: `L${i}` }); }
  assert.ok(applyOps(db, ops, { calendarDays: true }).ok);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  // every activity may lose 30% (3 d): the chain needs one step per activity to gain 390 days
  const all = await crashSchedule(db, [pid], { targetDays: 390 });
  assert.ok(all.ok);
  assert.equal(all.stop, 'SUCCESS');
  assert.ok(all.steps.length > 100, `${all.steps.length} steps`);
  const capped = await crashSchedule(db, [pid], { targetDays: 390, maxSteps: 7 });
  assert.ok(capped.ok);
  assert.equal(capped.stop, 'CAP');
  assert.equal(capped.steps.length, 7);
  // nothing to gain more than the crash room: it ends on its own as EXHAUSTED, again with no cap
  const room = await crashSchedule(db, [pid], { targetDays: 5000 });
  assert.ok(room.ok);
  assert.equal(room.stop, 'EXHAUSTED');
});

/** A chain of n activities of 10 days: with no crash data every one may lose 3 days, one step each. */
const chain = (n: number) => {
  const db: Db = { tables: {} };
  const ops: any[] = [{ op: 'add_project', id: 'CH', start: '2026-03-02' }];
  for (let i = 0; i < n; i++) { ops.push({ op: 'add_activity', id: `L${i}`, name: `L${i}`, duration_days: 10 }); if (i) ops.push({ op: 'add_relationship', pred: `L${i - 1}`, succ: `L${i}` }); }
  assert.ok(applyOps(db, ops, { calendarDays: true }).ok);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  return { db, pid, ops };
};
const cancelled = () => Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' });

test('crash: a cancellation between steps answers the steps done (CANCELLED, partial), the first of an uninterrupted run; one before the first step is the cancellation; the total is unknown without max_steps', async () => {
  const { db, pid } = chain(40);
  const before = JSON.stringify(db);
  const full = await crashSchedule(db, [pid], { targetDays: 120 });
  assert.ok(full.ok); assert.equal(full.stop, 'SUCCESS'); assert.ok(full.steps.length > 20);
  const seen: [number, number, string][] = [];
  const cut = await crashSchedule(db, [pid], { targetDays: 120, tick: async (done, total, message) => { seen.push([done, total, message]); if (done === 7) throw cancelled(); } });
  assert.ok(cut.ok);
  assert.equal(cut.stop, 'CANCELLED'); assert.equal((cut as any).partial, true); assert.equal((cut as any).steps_done, 7);
  assert.deepEqual(cut.steps, full.steps.slice(0, 7), 'the steps done are the first steps of the uninterrupted run');
  assert.equal(cut.changes.length, 7); assert.equal(cut.ops.length, 7);
  assert.ok(cut.days_gained > 0 && cut.days_gained < full.days_gained, 'what was gained so far');
  assert.equal(cut.finish, cut.steps.at(-1)!.finish);
  assert.ok(cut.notes.includes('Cancelled after 7 steps: the result covers those only.'), JSON.stringify(cut.notes));
  assert.equal((cut as any).note, undefined);
  assert.equal(JSON.stringify(db), before, 'the project is the same');
  // progress: the step about to run, and a total of 0 (unknown), never "n-1 of n"
  assert.deepEqual(seen.slice(0, 2).map(([d, t]) => [d, t]), [[0, 0], [1, 0]]);
  assert.match(seen[2][2], /^step 3: [\d.]+ working days gained so far$/);
  // with max_steps the total is that
  const capped: [number, number, string][] = [];
  await crashSchedule(db, [pid], { targetDays: 120, maxSteps: 9, tick: async (done, total, message) => { capped.push([done, total, message]); } });
  assert.deepEqual(capped[0].slice(0, 2), [0, 9]); assert.match(capped[3][2], /^step 4 of at most 9:/);
  // cancelled before the first step: nothing to answer, the cancellation as it was
  await assert.rejects(crashSchedule(db, [pid], { targetDays: 120, tick: async () => { throw cancelled(); } }), (e: any) => e.code === 'cancelled');
  // another error from the tick is not taken for a cancellation
  await assert.rejects(crashSchedule(db, [pid], { targetDays: 120, tick: async (done) => { if (done === 3) throw new Error('boom'); } }), /boom/);
  assert.equal(JSON.stringify(db), before, 'and every run left the project as it was');
});

test('MCP crash_schedule: cancelled mid-crashing it answers the steps done, applies nothing even with apply: true, and max_steps is a whole number', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal, progress?: (d: number, t: number, m: string) => void) => { const r = await callTool(name, args, undefined, signal, progress); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'CRC', start: '2026-03-02' })).d;
  const { ops } = chain(150);
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops.slice(1).map((o: any) => ({ ...o })) });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const args = { handle: np.handle, target_days: 450, apply: true };
  // cancelled by the first progress report that comes after a few steps (reports are 250 ms apart: the run is long enough to get there)
  const abort = new AbortController(), totals: number[] = [];
  const r = await call('crash_schedule', args, abort.signal, (done, total) => { totals.push(total); if (done >= 3) abort.abort(); });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.stop, 'CANCELLED'); assert.equal(r.d.partial, true);
  assert.ok(r.d.steps_done >= 3 && r.d.steps_done < 150, String(r.d.steps_done));
  assert.equal(r.d.steps.length, r.d.steps_done); assert.equal(r.d.ops.length, r.d.steps_done);
  assert.equal(r.d.applied, false);
  assert.ok(r.d.notes.some((n: string) => /^Cancelled after \d+ steps: the result covers those only\.$/.test(n)), JSON.stringify(r.d.notes)); assert.ok(r.d.notes.includes('Not applied: a cancelled run changes nothing in the project; the ops are the changes of the steps done.')); assert.equal(r.d.note, undefined);
  assert.ok(totals.length >= 2 && totals.every((t) => t === 0), `progress had no total: ${totals}`);
  assert.equal((await call('get_activity', { handle: np.handle, activity_id: 'L0' })).d.orig_days, 10, 'the project is not changed');
  // the same call run through: applied
  const done = await call('crash_schedule', { handle: np.handle, target_days: 20, apply: true });
  assert.equal(done.d.stop, 'SUCCESS'); assert.equal(done.d.applied, true);
  assert.ok((await call('get_activity', { handle: np.handle, activity_id: 'L0' })).d.orig_days < 10, 'a finished run applied');
  // max_steps: a whole number, refused naming it before any work; 0 stops at once (CAP), it is not "no cap"
  for (const max_steps of [-1, 2.5, Number.NaN, Infinity, '3', true]) {
    const bad = await call('crash_schedule', { handle: np.handle, target_days: 5, max_steps });
    assert.equal(bad.d.error?.code, 'bad_input', `max_steps ${String(max_steps)}`);
    assert.match(bad.d.error.message, /^max_steps must be a whole number of 0 or more/);
  }
  assert.equal((await call('crash_schedule', { handle: np.handle, target_days: 5, max_steps: 0 })).d.stop, 'CAP');
});

test('MCP crash_schedule: a cancel that lands after the last step applies nothing and answers CANCELLED; a cancelled crash job is cancelled, not done', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => { const r = await callTool(name, args, undefined, signal); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'CRL', start: '2026-03-02' })).d;
  const { ops } = chain(6);
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops.slice(1) })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const args = { handle: np.handle, target_days: 4 };
  // count the checkpoints (each yields with setImmediate, seen by its stack) of a run that is not applied, then cancel at the one more that comes just before the change
  const real = globalThis.setImmediate;
  let count = 0, abortAt = Infinity;
  const abort = new AbortController();
  (globalThis as any).setImmediate = (fn: any, ...rest: any[]) => { if (new Error().stack!.includes('checkpoint') && ++count >= abortAt) abort.abort(); return real(fn, ...rest); };
  process.env.P6CLONE_COMPUTE_WORKERS = '0'; // in this process, where the checkpoints can be counted
  try {
    const plain = await call('crash_schedule', args);
    assert.equal(plain.d.stop, 'SUCCESS'); assert.ok(plain.d.steps.length >= 1);
    abortAt = count + 1; count = 0;
    const r = await call('crash_schedule', { ...args, apply: true }, abort.signal);
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.stop, 'CANCELLED'); assert.equal(r.d.partial, true); assert.equal(r.d.stopped, 'cancelled');
    assert.equal(r.d.applied, false);
    assert.equal(r.d.steps.length, plain.d.steps.length, 'the steps done are the answer');
    assert.ok(r.d.notes.some((n: string) => /^Cancelled after \d+ steps: the result covers those only\.$/.test(n)), JSON.stringify(r.d.notes)); assert.ok(r.d.notes.includes('Not applied: a cancelled run changes nothing in the project; the ops are the changes of the steps done.'));
  } finally { (globalThis as any).setImmediate = real; delete process.env.P6CLONE_COMPUTE_WORKERS; }
  assert.equal((await call('get_activity', { handle: np.handle, activity_id: 'L0' })).d.orig_days, 10, 'the project is not changed');
  // as a job: cancelled part-way with steps done, the job reads cancelled
  const big = (await call('new_project', { id: 'CRJ', start: '2026-03-02' })).d;
  assert.equal((await call('edit', { handle: big.handle, owner_key: big.owner_key, operations: chain(150).ops.slice(1) })).err, false);
  await call('schedule', { handle: big.handle, owner_key: big.owner_key });
  const job = (await call('crash_schedule', { handle: big.handle, target_days: 450, async: true })).d.job_id;
  assert.ok(job);
  let view = (await call('job_status', { job_id: job })).d;
  for (let k = 0; k < 500 && view.status === 'running' && !/step (\d{2,}|[3-9])\b/.test(String(view.progress ?? '')); k++) { await new Promise((r) => setTimeout(r, 5)); view = (await call('job_status', { job_id: job })).d; }
  await call('cancel_job', { job_id: job });
  view = (await call('job_status', { job_id: job, wait_seconds: 10 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
  assert.equal(view.result?.stop, 'CANCELLED');
});
