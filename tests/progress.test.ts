import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { updateProgress, durationPct } from '../core/progress/update.ts';
import { parseP6Date } from '../core/dates.ts';
import { samples } from './helpers.ts';

test('update progress statuses activities by planned dates and reschedules from new data date', () => {
  const s = samples().find((x) => x.name === 'cairo festival city.xer')!;
  const db = parseXer(s.bytes).db;
  const projId = db.tables.PROJECT.rows[0].proj_id;
  scheduleProjects(db, [projId]);
  const dd = parseP6Date(db.tables.PROJECT.rows[0].last_recalc_date)! + 30 * 1440;
  const sum = updateProgress(db, projId, dd);
  assert.ok(sum.started > 0);
  const res = scheduleProjects(db, [projId]);
  assert.ok(res.ok);
  for (const r of db.tables.TASK.rows) {
    if (r.act_end_date) assert.equal(r.remain_drtn_hr_cnt, '0', r.task_code);
    if (r.act_start_date && !r.act_end_date) {
      assert.equal(r.status_code, 'TK_Active');
      assert.ok(parseP6Date(r.early_start_date)! >= dd, `${r.task_code} remaining work starts at or after data date`);
    }
    if (!r.act_start_date) assert.ok(parseP6Date(r.early_start_date)! >= dd, `${r.task_code} not started work is after data date`);
  }
  assert.equal(db.tables.PROJECT.rows[0].last_recalc_date.slice(0, 10), new Date(dd * 60000).toISOString().slice(0, 10));
});

test('duration percent complete', () => {
  assert.equal(durationPct({ target_drtn_hr_cnt: '80', remain_drtn_hr_cnt: '20', act_start_date: 'x', act_end_date: '' }), 75);
  assert.equal(durationPct({ target_drtn_hr_cnt: '80', remain_drtn_hr_cnt: '0', act_start_date: 'x', act_end_date: 'y' }), 100);
});
