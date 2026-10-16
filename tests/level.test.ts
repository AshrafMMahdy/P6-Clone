import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { levelResources } from '../core/level/level.ts';
import { assignResource, recalcAssignment } from '../core/resource/assign.ts';
import type { Db, Row } from '../core/db.ts';

const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()((0||0(s|08:00|f|16:00)())))(0||4()((0||0(s|08:00|f|16:00)())))(0||5()((0||0(s|08:00|f|16:00)())))(0||6()((0||0(s|08:00|f|16:00)())))(0||7()())))(0||Exceptions()())))';
const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });

function db2(): Db {
  const task = (id: string, code: string): Row => ({ task_id: id, proj_id: '1', wbs_id: '10', clndr_id: '1', task_code: code, task_type: 'TT_Task', duration_type: 'DT_FixedDUR2', target_drtn_hr_cnt: '16', remain_drtn_hr_cnt: '16', act_start_date: '', act_end_date: '', priority_type: 'PT_Normal' });
  return { tables: {
    PROJECT: tbl('PROJECT', [{ proj_id: '1', proj_short_name: 'P', clndr_id: '1', plan_start_date: '2024-01-08 00:00', last_recalc_date: '2024-01-08 00:00' }]),
    CALENDAR: tbl('CALENDAR', [{ clndr_id: '1', default_flag: 'Y', clndr_name: 'Std', clndr_data: CAL }]),
    PROJWBS: tbl('PROJWBS', [{ wbs_id: '10', proj_id: '1', parent_wbs_id: '', proj_node_flag: 'Y' }]),
    RSRC: tbl('RSRC', [{ rsrc_id: '7', rsrc_short_name: 'CREW', rsrc_name: 'Crew', rsrc_type: 'RT_Labor', def_qty_per_hr: '1', max_qty_per_hr: '1' }]),
    RSRCRATE: tbl('RSRCRATE', [{ rsrc_rate_id: '1', rsrc_id: '7', start_date: '', cost_per_qty: '50', max_qty_per_hr: '1' }]),
    TASK: tbl('TASK', [task('100', 'A'), task('101', 'B')]),
    TASKPRED: tbl('TASKPRED', []),
  } };
}

test('two parallel activities sharing a one-unit resource are serialised', () => {
  const db = db2();
  scheduleProjects(db, ['1']);
  for (const t of db.tables.TASK.rows) assignResource(db, t, '7');
  const a = db.tables.TASKRSRC.rows[0];
  assert.equal(a.target_qty, '16');
  assert.equal(a.target_cost, '800');
  const r = levelResources(db, ['1'], {});
  assert.equal(r.delayed, 1);
  const [A, B] = db.tables.TASK.rows;
  assert.equal(A.early_start_date, '2024-01-08 08:00');
  assert.equal(B.early_start_date, '2024-01-10 08:00');
  assert.match(r.log, /delayed/);
});

test('fixed units: changing units changes duration; fixed duration: changes units/time', () => {
  const db = db2();
  const t = db.tables.TASK.rows[0];
  const a = assignResource(db, t, '7');
  recalcAssignment(db, t, a, 'target_qty', 32);
  assert.equal(t.target_drtn_hr_cnt, '16');
  assert.equal(a.target_qty_per_hr, '2');
  t.duration_type = 'DT_FixedQty';
  recalcAssignment(db, t, a, 'target_qty', 64);
  assert.equal(t.target_drtn_hr_cnt, '32');
  assert.equal(a.target_cost, '3200');
});
