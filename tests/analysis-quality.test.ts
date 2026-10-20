import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { checkSchedule } from '../core/analysis/checkSchedule.ts';
import { dcma14 } from '../core/analysis/dcma.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); };
const ids = (c: { activities: { id: string }[] }) => c.activities.map((a) => a.id);
const pid = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
const sched = (db: Db) => { const r = scheduleProjects(db, [pid(db)]); assert.ok(r.ok, r.log); };

/** S -> A -> D (60 d) -> H is the critical path; the others each break one rule. */
function build(): Db {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'Q', start: '2026-03-02' },
    { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' },
    { op: 'add_activity', id: 'A', name: 'Design', duration_days: 5 },
    { op: 'add_activity', id: 'B', name: 'Procure', duration_days: 10 },
    { op: 'add_activity', id: 'C', name: 'Fabricate', duration_days: 3 },
    { op: 'add_activity', id: 'D', name: 'Build', duration_days: 60 },
    { op: 'add_activity', id: 'E', name: 'Loose end', duration_days: 4 },
    { op: 'add_activity', id: 'F', name: 'Only FF in', duration_days: 2 },
    { op: 'add_activity', id: 'G', name: 'Fixed start', duration_days: 3, constraint: { type: 'mandatory_start', date: '2026-03-30' } },
    { op: 'add_activity', id: 'X', name: 'Only SS out', duration_days: 2 },
    { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'S', succ: 'A' },
    { op: 'add_relationship', pred: 'A', succ: 'B', lag_days: 2 },
    { op: 'add_relationship', pred: 'B', succ: 'C', type: 'SS' },
    { op: 'add_relationship', pred: 'C', succ: 'H' },
    { op: 'add_relationship', pred: 'A', succ: 'D' },
    { op: 'add_relationship', pred: 'D', succ: 'H' },
    { op: 'add_relationship', pred: 'A', succ: 'E' },
    { op: 'add_relationship', pred: 'A', succ: 'F', type: 'FF' },
    { op: 'add_relationship', pred: 'F', succ: 'H' },
    { op: 'add_relationship', pred: 'B', succ: 'G', lag_days: -1 },
    { op: 'add_relationship', pred: 'G', succ: 'H' },
    { op: 'add_relationship', pred: 'A', succ: 'X' },
    { op: 'add_relationship', pred: 'X', succ: 'H', type: 'SS' },
  ]);
  sched(db);
  return db;
}

test('Check Schedule: each of the 14 P6 Professional checks finds the activities or links that break it', () => {
  const db = build();
  const r = checkSchedule(db);
  const c = (id: string) => r.checks.find((x) => x.id === id)!;
  assert.equal(r.checks.length, 14);
  assert.deepEqual(ids(c('logic')), ['E']);
  assert.deepEqual(ids(c('negative_lags')), ['B -> G']);
  assert.deepEqual(ids(c('lags')), ['A -> B']);
  assert.deepEqual(ids(c('relationship_types')).sort(), ['A -> F', 'B -> C', 'X -> H']);
  assert.deepEqual(ids(c('hard_constraints')), ['G']);
  assert.deepEqual(ids(c('large_durations')), ['D']);
  assert.equal(c('bei').result, 'not_assessed');
  assert.match(c('bei').note!, /baseline/);
  assert.equal(r.threshold_hours, 352);
  // targets follow P6's defaults and can be overridden
  assert.deepEqual(c('logic').threshold, { op: '<', value: 5, source: 'P6 default (Oracle Check Schedule docs)' });
  const o = checkSchedule(db, { checks: ['logic'], targets: { logic: 20 } });
  assert.equal(o.checks.length, 1);
  assert.equal(o.checks[0].threshold!.source, 'override');
  assert.equal(o.checks[0].result, 'pass');
});

test('DCMA 14: populations, the critical path test, CPLI decision tree, missed tasks and BEI against the baseline', () => {
  const db = build();
  let r = dcma14(db);
  const c = (id: string) => r.checks.find((x) => x.id === id)!;
  assert.equal(r.checks.length, 14);
  assert.deepEqual(ids(c('logic')), ['E']);
  assert.deepEqual(ids(c('leads')), ['B -> G']);
  assert.deepEqual(ids(c('hard_constraints')), ['G']);
  assert.deepEqual(ids(c('high_duration')), ['D']);
  assert.equal(c('critical_path_test').result, 'pass', c('critical_path_test').note ?? '');
  assert.equal(c('critical_path_test').metric, 600);
  assert.equal(c('missed_tasks').result, 'not_assessed');
  assert.equal(c('bei').result, 'not_assessed');
  // the project's data date and finish did not change (the test ran on a scratch copy)
  const fin = rows(db, 'TASK').find((t) => t.task_code === 'H')!.early_end_date;
  dcma14(db);
  assert.equal(rows(db, 'TASK').find((t) => t.task_code === 'H')!.early_end_date, fin);
  assert.equal(c('cpli').result, 'not_assessed', 'no contract finish and no baseline');

  // baseline, then a late Design: missed task, BEI below 0.95, CPLI against the Must Finish By date and the baseline
  ok(db, [{ op: 'save_baseline', name: 'Q BL', assign_as: 'project' }, { op: 'set_project', must_finish_by: '2026-07-31' }]);
  ok(db, [{ op: 'update_activity', id: 'S', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-02 08:00' }, { op: 'update_activity', id: 'A', actual_start: '2026-03-02 08:00', remaining_days: 4 }, { op: 'set_project', data_date: '2026-03-16' }]);
  sched(db);
  r = dcma14(db);
  // Design and everything baselined to finish by 16 March behind it (Fabricate, Loose end, Only FF in, Only SS out)
  assert.deepEqual(ids(c('missed_tasks')).sort(), ['A', 'C', 'E', 'F', 'X']);
  assert.equal(c('missed_tasks').denominator, 5);
  assert.equal(c('bei').result, 'fail');
  assert.equal(c('bei').metric, 0);
  assert.deepEqual(ids(c('bei')).sort(), ['A', 'C', 'E', 'F', 'X']);
  const cp = c('cpli');
  assert.equal((cp.detail as { decided_by: string }).decided_by, 'contract');
  assert.ok((cp.detail as { against_baseline: unknown }).against_baseline, 'the baseline figure is reported beside the contract one');
  assert.ok(cp.metric! > 0);
  // profiles and overrides carry their source
  r = dcma14(db, { profile: 'strict', thresholds: { logic: 50 } });
  assert.equal(c('logic').threshold!.source, 'override');
  assert.equal(c('lags').threshold!.value, 3);
  assert.equal(c('lags').threshold!.source, 'Strict');
});

test('DCMA critical path test fails when a constraint absorbs the delay', () => {
  const db = build();
  // the finish milestone held by a mandatory finish: a delay upstream no longer moves the project finish
  ok(db, [{ op: 'update_activity', id: 'H', constraint: { type: 'mandatory_finish', date: '2026-06-30' } }]);
  sched(db);
  const r = dcma14(db, { cptActivity: 'A' });
  const t = r.checks.find((x) => x.id === 'critical_path_test')!;
  assert.equal(t.result, 'fail', t.note ?? '');
});
