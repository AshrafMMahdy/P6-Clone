import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDb, rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';

// A started before its predecessor P0 finished (out of sequence); under Retained Logic its remaining work waits for
// P0. B follows A start-to-start with a 15-day lag. P6's "Calculate start-to-start lag from" option decides where
// the lag runs from: Early Start (default) = A's remaining start, less the work already elapsed; Actual Start =
// A's actual start.
function build(flag: 'Y' | 'N') {
  const db = emptyDb();
  const r = applyOps(db, [
    { op: 'add_project', id: 'SS', start: '2027-03-01' },
    { op: 'add_activity', id: 'P0', name: 'Predecessor', duration_days: 10 },
    { op: 'add_activity', id: 'A', name: 'Started early', duration_days: 10 },
    { op: 'add_activity', id: 'B', name: 'Follows A by SS 15d', duration_days: 5 },
    { op: 'add_relationship', pred: 'P0', succ: 'A' },
    { op: 'add_relationship', pred: 'A', succ: 'B', type: 'SS', lag_days: 15 },
    { op: 'update_activity', id: 'A', actual_start: '2027-03-01 08:00', remaining_days: 5 },
    { op: 'set_project', data_date: '2027-03-15 08:00' },
  ]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const p = rows(db, 'PROJECT')[0];
  const so = rows(db, 'SCHEDOPTIONS').find((x) => x.proj_id === p.proj_id);
  assert.ok(so, 'new projects have schedule options');
  so!.sched_lag_early_start_flag = flag; so!.sched_retained_logic = 'Y'; so!.sched_progress_override = 'N';
  const res = scheduleProjects(db, [p.proj_id]);
  assert.equal(res.ok, true);
  return (code: string) => rows(db, 'TASK').find((t) => t.task_code === code)!;
}

test('SS lag from Early Start (P6 default): the lag still to run starts at the in-progress predecessor\'s remaining start', () => {
  const t = build('Y');
  assert.equal(t('P0').early_end_date.slice(0, 10), '2027-03-26');
  assert.equal(t('A').restart_date?.slice(0, 10) || t('A').early_start_date.slice(0, 10), '2027-03-29');
  assert.equal(t('B').early_start_date.slice(0, 10), '2027-04-05', '5 days still to run after A resumes on 29-Mar');
});

test('SS lag from Actual Start: the whole lag counts from the predecessor\'s actual start', () => {
  const t = build('N');
  assert.equal(t('B').early_start_date.slice(0, 10), '2027-03-22', '15 work days after the actual start on 01-Mar');
});
