import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadUsage } from '../core/resource/usage.ts';
import { parseP6Date } from '../core/dates.ts';
import type { Db, Row } from '../core/db.ts';

const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()((0||0(s|08:00|f|16:00)())))(0||4()((0||0(s|08:00|f|16:00)())))(0||5()((0||0(s|08:00|f|16:00)())))(0||6()((0||0(s|08:00|f|16:00)())))(0||7()())))(0||Exceptions()())))';
const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });
const d = (s: string) => parseP6Date(s)!;
const round = (xs: number[]) => xs.map((x) => Math.round(x * 1e6) / 1e6);

function db(asgs: Partial<Row>[], o: { dataDate?: string; maxRate?: string } = {}): Db {
  const task: Row = { task_id: '100', proj_id: '1', wbs_id: '10', clndr_id: '1', task_code: 'A', task_type: 'TT_Task', act_start_date: '', act_end_date: '', early_start_date: '2024-01-08 08:00', early_end_date: '2024-01-09 16:00' };
  return { tables: {
    PROJECT: tbl('PROJECT', [{ proj_id: '1', proj_short_name: 'P', clndr_id: '1', plan_start_date: '2024-01-08 00:00', last_recalc_date: o.dataDate ?? '2024-01-08 00:00' }]),
    CALENDAR: tbl('CALENDAR', [{ clndr_id: '1', default_flag: 'Y', clndr_name: 'Std', clndr_data: CAL }]),
    RSRC: tbl('RSRC', [{ rsrc_id: '7', rsrc_short_name: 'CREW', rsrc_name: 'Crew', rsrc_type: 'RT_Labor', clndr_id: '1', def_qty_per_hr: '1', max_qty_per_hr: '1' }]),
    RSRCRATE: tbl('RSRCRATE', [{ rsrc_rate_id: '1', rsrc_id: '7', start_date: '', cost_per_qty: '50', max_qty_per_hr: o.maxRate ?? '1' }]),
    TASK: tbl('TASK', [task]),
    TASKRSRC: tbl('TASKRSRC', asgs.map((a, i) => ({ taskrsrc_id: String(i + 1), task_id: '100', proj_id: '1', rsrc_id: '7', remain_qty: '0', target_qty: '0', act_reg_qty: '0', act_ot_qty: '0', act_start_date: '', act_end_date: '', restart_date: '', reend_date: '', ...a } as Row))),
  } };
}

test('16 h over 2 workdays gives 8 h per day', () => {
  const r = spreadUsage(db([{ remain_qty: '16', target_qty: '16', restart_date: '2024-01-08 08:00', reend_date: '2024-01-09 16:00' }]), ['1'], { start: d('2024-01-08 00:00'), end: d('2024-01-11 00:00'), bucket: 'day' });
  assert.deepEqual(r.buckets, [d('2024-01-08 00:00'), d('2024-01-09 00:00'), d('2024-01-10 00:00')]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(round(r.rows[0].remaining), [8, 8, 0]);
  assert.deepEqual(r.rows[0].actual, [0, 0, 0]);
});

test('falls back to activity remaining dates when the assignment has none', () => {
  const r = spreadUsage(db([{ remain_qty: '16' }]), ['1'], { start: d('2024-01-08 00:00'), end: d('2024-01-10 00:00'), bucket: 'day' });
  assert.deepEqual(round(r.rows[0].remaining), [8, 8]);
});

test('weekly buckets start Monday and sum correctly', () => {
  // Thu 11 Jan 08:00 .. Tue 16 Jan 16:00 = 4 workdays, 32 h
  const r = spreadUsage(db([{ remain_qty: '32', restart_date: '2024-01-11 08:00', reend_date: '2024-01-16 16:00' }]), ['1'], { start: d('2024-01-10 00:00'), end: d('2024-01-20 00:00'), bucket: 'week' });
  assert.deepEqual(r.buckets, [d('2024-01-08 00:00'), d('2024-01-15 00:00')]);
  assert.deepEqual(round(r.rows[0].remaining), [16, 16]);
  assert.equal(r.rows[0].remaining.reduce((a, b) => a + b, 0), 32);
  assert.deepEqual(round(r.rows[0].capacity), [40, 40]);
  const m = spreadUsage(db([{ remain_qty: '32', restart_date: '2024-01-30 08:00', reend_date: '2024-02-02 16:00' }]), ['1'], { start: d('2024-01-15 00:00'), end: d('2024-02-15 00:00'), bucket: 'month' });
  assert.deepEqual(m.buckets, [d('2024-01-01 00:00'), d('2024-02-01 00:00')]);
  assert.deepEqual(round(m.rows[0].remaining), [16, 16]);
});

test('actual vs remaining split at the data date', () => {
  const r = spreadUsage(db([{ act_reg_qty: '12', act_ot_qty: '4', remain_qty: '8', act_start_date: '2024-01-08 08:00', restart_date: '2024-01-10 08:00', reend_date: '2024-01-10 16:00' }], { dataDate: '2024-01-10 08:00' }),
    ['1'], { start: d('2024-01-08 00:00'), end: d('2024-01-11 00:00'), bucket: 'day' });
  assert.deepEqual(round(r.rows[0].actual), [8, 8, 0]);
  assert.deepEqual(round(r.rows[0].remaining), [0, 0, 8]);
});

test('capacity follows the resource calendar (0 on weekends) and max units/time', () => {
  const r = spreadUsage(db([{ remain_qty: '16', restart_date: '2024-01-08 08:00', reend_date: '2024-01-09 16:00' }], { maxRate: '2' }), ['1'], { start: d('2024-01-08 00:00'), end: d('2024-01-15 00:00'), bucket: 'day' });
  assert.deepEqual(round(r.rows[0].capacity), [16, 16, 16, 16, 16, 0, 0]);
  const only = spreadUsage(db([]), ['1'], { start: d('2024-01-13 00:00'), end: d('2024-01-16 00:00'), bucket: 'day', rsrcId: '7' });
  assert.deepEqual(round(only.rows[0].capacity), [0, 0, 8]);
});
