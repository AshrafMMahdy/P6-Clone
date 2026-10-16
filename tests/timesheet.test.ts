import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, Row } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import {
  applyApprovedTimesheets, approve, createPeriods, deletePeriodError, listPeriods, pendingApprovedEntries, periodTimesheets, reject, setHours,
  setLineComplete, statusError, submit, timesheetFor, timesheetLines, validateHours,
} from '../core/timesheet/timesheet.ts';

const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });
const MON = parseP6Date('2026-10-19')!; // a Monday

function fixture(): Db {
  return { tables: {
    PROJECT: tbl('PROJECT', [{ proj_id: '1', proj_short_name: 'P1', clndr_id: '', last_recalc_date: '2026-10-19 08:00' }]),
    RSRC: tbl('RSRC', [{ rsrc_id: '10', rsrc_short_name: 'CARP', rsrc_name: 'Carpenter', rsrc_type: 'RT_Labor' }, { rsrc_id: '11', rsrc_short_name: 'ELEC', rsrc_name: 'Electrician', rsrc_type: 'RT_Labor' }]),
    RSRCRATE: tbl('RSRCRATE', [{ rsrc_rate_id: '1', rsrc_id: '10', cost_per_qty: '100', start_date: '' }, { rsrc_rate_id: '2', rsrc_id: '11', cost_per_qty: '50', start_date: '' }]),
    TASK: tbl('TASK', [
      // A: week 1, units % complete, 5 days
      { task_id: '1', proj_id: '1', task_code: 'A1000', task_name: 'Formwork', task_type: 'TT_Task', complete_pct_type: 'CP_Units', duration_type: 'DT_FixedDUR2', status_code: 'TK_NotStart',
        target_drtn_hr_cnt: '40', remain_drtn_hr_cnt: '40', act_start_date: '', act_end_date: '', clndr_id: '', rsrc_id: '10',
        target_start_date: '2026-10-19 08:00', target_end_date: '2026-10-23 17:00', early_start_date: '2026-10-19 08:00', early_end_date: '2026-10-23 17:00' },
      // B: week 2 only
      { task_id: '2', proj_id: '1', task_code: 'A1010', task_name: 'Rebar', task_type: 'TT_Task', complete_pct_type: 'CP_Drtn', duration_type: 'DT_FixedDUR2', status_code: 'TK_NotStart',
        target_drtn_hr_cnt: '40', remain_drtn_hr_cnt: '40', act_start_date: '', act_end_date: '', clndr_id: '',
        target_start_date: '2026-10-26 08:00', target_end_date: '2026-10-30 17:00', early_start_date: '2026-10-26 08:00', early_end_date: '2026-10-30 17:00' },
    ]),
    TASKRSRC: tbl('TASKRSRC', [
      { taskrsrc_id: '100', task_id: '1', proj_id: '1', rsrc_id: '10', rsrc_type: 'RT_Labor', cost_qty_link_flag: 'Y', target_qty: '40', remain_qty: '40', act_reg_qty: '0', act_ot_qty: '0',
        target_qty_per_hr: '1', remain_qty_per_hr: '1', cost_per_qty: '100', target_cost: '4000', remain_cost: '4000', act_reg_cost: '0', act_ot_cost: '0', act_start_date: '', act_end_date: '', rate_type: 'COST_PER_QTY', cost_per_qty_source_type: 'ST_Rsrc' },
      { taskrsrc_id: '101', task_id: '2', proj_id: '1', rsrc_id: '10', rsrc_type: 'RT_Labor', cost_qty_link_flag: 'Y', target_qty: '40', remain_qty: '40', act_reg_qty: '0', act_ot_qty: '0',
        target_qty_per_hr: '1', remain_qty_per_hr: '1', cost_per_qty: '100', target_cost: '4000', remain_cost: '4000', act_reg_cost: '0', act_ot_cost: '0', act_start_date: '', act_end_date: '', rate_type: 'COST_PER_QTY', cost_per_qty_source_type: 'ST_Rsrc' },
      { taskrsrc_id: '102', task_id: '1', proj_id: '1', rsrc_id: '11', rsrc_type: 'RT_Labor', cost_qty_link_flag: 'Y', target_qty: '20', remain_qty: '20', act_reg_qty: '0', act_ot_qty: '0',
        target_qty_per_hr: '0.5', remain_qty_per_hr: '0.5', cost_per_qty: '50', target_cost: '1000', remain_cost: '1000', act_reg_cost: '0', act_ot_cost: '0', act_start_date: '', act_end_date: '', rate_type: 'COST_PER_QTY', cost_per_qty_source_type: 'ST_Rsrc' },
    ]),
  } };
}

function withPeriods(): Db {
  const db = fixture();
  createPeriods(db, MON, 2);
  return db;
}

test('createPeriods makes consecutive weekly periods and skips overlaps', () => {
  const db = fixture();
  const made = createPeriods(db, MON + 600, 3); // time of day is ignored
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((p) => [p.start_date, p.end_date]), [
    ['2026-10-19 00:00', '2026-10-25 00:00'], ['2026-10-26 00:00', '2026-11-01 00:00'], ['2026-11-02 00:00', '2026-11-08 00:00']]);
  assert.deepEqual(made.map((p) => p.ts_id), ['1', '2', '3']);
  const again = createPeriods(db, parseP6Date('2026-11-02')!, 2);
  assert.equal(again.length, 1, 'the overlapping first period is skipped');
  assert.equal(again[0].start_date, '2026-11-09 00:00');
  assert.equal(listPeriods(db).length, 4);
  assert.throws(() => createPeriods(db, MON, 0));
  const fortnight = createPeriods(fixture(), MON, 1, 14)[0];
  assert.equal(fortnight.end_date, '2026-11-01 00:00');
});

test('timesheetFor creates the header with one line per assignment active in the period', () => {
  const db = withPeriods();
  assert.equal(timesheetLines(db, '10', '1').length, 1, 'preview without creating');
  assert.equal(db.tables.TIMESHT, undefined);
  const h = timesheetFor(db, '10', '1');
  assert.equal(h.status_code, 'TS_Active');
  assert.equal(timesheetFor(db, '10', '1'), h, 'not created twice');
  const lines = timesheetLines(db, '10', '1');
  assert.deepEqual(lines.map((l) => l.task?.task_code), ['A1000']);
  assert.deepEqual(timesheetLines(db, '10', '2').map((l) => l.task?.task_code), ['A1010']);
  assert.throws(() => timesheetFor(db, '99', '1'), /Resource/);
  assert.throws(() => timesheetFor(db, '10', '99'), /period/);
  assert.match(deletePeriodError(db, '1') ?? '', /cannot be deleted/);
  assert.equal(deletePeriodError(db, '2'), null);
});

test('setHours enters regular and overtime hours per day with validation', () => {
  const db = withPeriods();
  setHours(db, '1', '100', 0, 8);
  setHours(db, '1', '100', 1, 6);
  setHours(db, '1', '100', 1, 2, true);
  setHours(db, '1', '100', parseP6Date('2026-10-21 10:00')!, 7); // a time inside the period also works
  let l = timesheetLines(db, '10', '1')[0];
  assert.deepEqual(l.hours, [8, 6, 7, 0, 0, 0, 0]);
  assert.deepEqual(l.ot, [0, 2, 0, 0, 0, 0, 0]);
  assert.equal(l.total, 21);
  assert.equal(l.otTotal, 2);
  assert.equal(db.tables.RSRCHOUR.rows.length, 3);
  assert.equal(db.tables.RSRCHOUR.rows[0].workdate, '2026-10-19 00:00');
  setHours(db, '1', '100', 2, 0);
  assert.equal(db.tables.RSRCHOUR.rows.length, 2, 'zero hours remove the entry');
  l = timesheetLines(db, '10', '1')[0];
  assert.equal(l.total, 14);
  assert.throws(() => setHours(db, '1', '100', 0, -1), /zero or greater/);
  assert.throws(() => setHours(db, '1', '100', 7, 4), /outside/);
  assert.throws(() => setHours(db, '1', '100', 0, 17, true), /24/);
  assert.match(validateHours(db, '1', '100', 0, 25) ?? '', /24/);
  assert.equal(validateHours(db, '1', '100', 0, 10), null);
  // a line for an assignment not active in the period can still be added (activity added to the timesheet)
  setHours(db, '1', '101', 4, 3);
  assert.deepEqual(timesheetLines(db, '10', '1').map((l2) => l2.task?.task_code), ['A1000', 'A1010']);
});

test('status workflow: submit, approve, reject, read-only after approval', () => {
  const db = withPeriods();
  setHours(db, '1', '100', 0, 8);
  assert.match(statusError(db, '1', '10', 'TS_Approve') ?? '', /Only submitted/);
  assert.throws(() => approve(db, '1', '10'), /Only submitted/);
  assert.throws(() => reject(db, '1', '11'), /not created/);
  submit(db, '1', '10', { at: MON + 1000 });
  assert.equal(timesheetFor(db, '10', '1').status_code, 'TS_Submit');
  assert.equal(db.tables.RSRCHOUR.rows[0].status, 'TS_Submit');
  assert.throws(() => setHours(db, '1', '100', 1, 8), /Submitted/);
  assert.throws(() => submit(db, '1', '10'), /already/);
  reject(db, '1', '10', { note: 'Wrong activity', at: MON + 2000 });
  const h = timesheetFor(db, '10', '1');
  assert.equal(h.status_code, 'TS_Reject');
  assert.match(h.ts_notes, /Rejected: Wrong activity/);
  setHours(db, '1', '100', 1, 8); // rejected timesheets can be corrected
  submit(db, '1', '10');
  approve(db, '1', '10', { at: MON + 3000 });
  assert.equal(h.status_code, 'TS_Approve');
  assert.equal(h.status_date, '2026-10-21 02:00');
  assert.throws(() => setHours(db, '1', '100', 2, 8), /Approved/);
  assert.throws(() => setLineComplete(db, '1', '100', true), /Approved/);
  assert.throws(() => reject(db, '1', '10'), /Only submitted/);
  assert.throws(() => submit(db, '1', '10'), /already approved/);
  const info = periodTimesheets(db, '1');
  assert.equal(info.length, 1);
  assert.equal(info[0].hours, 16);
});

test('apply actuals moves approved hours into assignments and activities once', () => {
  const db = withPeriods();
  setHours(db, '1', '100', 0, 8);
  setHours(db, '1', '100', 1, 8);
  setHours(db, '1', '100', 1, 2, true);
  setHours(db, '1', '102', 1, 4); // electrician, not approved
  submit(db, '1', '10'); approve(db, '1', '10');
  submit(db, '1', '11');
  assert.equal(pendingApprovedEntries(db, ['1']).length, 2);
  assert.equal(pendingApprovedEntries(db, ['1'], parseP6Date('2026-10-20')!).length, 1, 'upTo limits the days applied');
  assert.equal(pendingApprovedEntries(db, ['2']).length, 0);

  const s = applyApprovedTimesheets(db, ['1']);
  assert.equal(s.entries, 2);
  assert.equal(s.regHours, 16);
  assert.equal(s.otHours, 2);
  assert.equal(s.timesheets, 1);
  assert.equal(s.assignments, 1);
  assert.equal(s.activitiesStarted, 1);
  assert.equal(s.activitiesCompleted, 0);
  assert.equal(s.lastWorkDay, '2026-10-20');

  const a = db.tables.TASKRSRC.rows[0], t = db.tables.TASK.rows[0];
  assert.equal(a.act_reg_qty, '16');
  assert.equal(a.act_ot_qty, '2');
  assert.equal(a.remain_qty, '22');
  assert.equal(a.act_reg_cost, '1600');
  assert.equal(a.remain_cost, '2200');
  assert.equal(a.act_start_date, '2026-10-19 08:00');
  assert.equal(t.act_start_date, '2026-10-19 08:00');
  assert.equal(t.status_code, 'TK_Active');
  assert.equal(t.act_end_date, '');
  // CP_Units: remaining duration in proportion to units: 40h x (1 - 18 / (18 + 22 + 20))
  assert.equal(Number(t.remain_drtn_hr_cnt), 28);
  assert.equal(db.tables.TASKRSRC.rows[2].act_reg_qty, '0', 'submitted (not approved) hours are not applied');
  assert.ok(db.tables.RSRCHOUR.rows.filter((e) => e.rsrc_id === '10').every((e) => e._applied_flag === 'Y'));

  const again = applyApprovedTimesheets(db, ['1']);
  assert.equal(again.entries, 0);
  assert.equal(a.act_reg_qty, '16', 'nothing applied twice');
});

test('a line flagged complete finishes the assignment and the activity of its primary resource', () => {
  const db = withPeriods();
  for (let d = 0; d < 3; d++) setHours(db, '1', '100', d, 8);
  setLineComplete(db, '1', '100', true);
  submit(db, '1', '10'); approve(db, '1', '10');
  const s = applyApprovedTimesheets(db, ['1']);
  assert.equal(s.activitiesCompleted, 1);
  const t = db.tables.TASK.rows[0];
  assert.equal(t.act_start_date, '2026-10-19 08:00');
  assert.equal(t.act_end_date, '2026-10-21 17:00');
  assert.equal(t.status_code, 'TK_Complete');
  assert.equal(t.remain_drtn_hr_cnt, '0');
  const [a, , e] = db.tables.TASKRSRC.rows;
  assert.equal(a.act_reg_qty, '24');
  assert.equal(a.remain_qty, '0');
  assert.equal(a.act_end_date, '2026-10-21 17:00');
  assert.equal(e.remain_qty, '0', 'other assignments of a finished activity have no remaining units');
  assert.equal(e.act_end_date, '2026-10-21 17:00');
  assert.equal(applyApprovedTimesheets(db, ['1']).activitiesCompleted, 0, 'complete flag applied once');
});

test('complete flag of a secondary resource finishes only its assignment', () => {
  const db = withPeriods();
  setHours(db, '1', '102', 0, 4);
  setLineComplete(db, '1', '102', true);
  submit(db, '1', '11'); approve(db, '1', '11');
  const s = applyApprovedTimesheets(db, ['1']);
  assert.equal(s.activitiesCompleted, 0);
  const e = db.tables.TASKRSRC.rows[2];
  assert.equal(e.act_end_date, '2026-10-19 17:00');
  assert.equal(e.remain_qty, '0');
  assert.equal(db.tables.TASK.rows[0].act_end_date, '');
  assert.equal(db.tables.TASK.rows[0].status_code, 'TK_Active');
});
