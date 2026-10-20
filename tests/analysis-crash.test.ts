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

test('crash: cheapest cut, step sized to the next near-critical path, then a cut set across parallel paths', () => {
  const { db, pid } = net();
  const before = JSON.stringify(db);
  const r = crashSchedule(db, [pid], {
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

test('crash: exhausted, already met, least total cost, no data defaults', () => {
  const { db, pid } = net();
  const ex = crashSchedule(db, [pid], { targetDays: 10, activities: [{ id: 'B', min_days: 4, cost_per_day: 10 }] });
  assert.ok(ex.ok);
  assert.equal(ex.stop, 'EXHAUSTED');
  assert.equal(ex.days_gained, 2);
  const met = crashSchedule(db, [pid], { targetFinish: '2027-01-01' });
  assert.ok(met.ok && met.stop === 'ALREADY_MET');
  // indirect 120/d: B (100) pays, B+D (150) does not
  const opt = crashSchedule(db, [pid], { indirectPerDay: 120, activities: [{ id: 'A', min_days: 7, cost_per_day: 300 }, { id: 'B', min_days: 3, cost_per_day: 100 }, { id: 'D', min_days: 2, cost_per_day: 50 }] });
  assert.ok(opt.ok);
  assert.equal(opt.stop, 'SUCCESS');
  assert.equal(opt.days_gained, 2);
  assert.equal(opt.total_cost, 200 - 240);
  const def = crashSchedule(db, [pid], { targetDays: 2 });
  assert.ok(def.ok && def.stop === 'SUCCESS' && def.note);
  assert.equal(crashSchedule(db, [pid], {}).ok, false);
});

test('evaluate_batch: many scenarios, base once, nothing kept, errors per scenario', () => {
  const { db, pid } = net();
  const before = JSON.stringify(db);
  const r = evaluateBatch(db, [pid], [
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
