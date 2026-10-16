import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveOf, cumulative, shareBetween } from '../core/resource/curve.ts';
import { spreadUsage } from '../core/resource/usage.ts';
import { parseP6Date } from '../core/dates.ts';
import type { Db, Row } from '../core/db.ts';

const pts = (a: number[]) => Object.fromEntries(a.map((v, i) => [`pct_usage_${i}`, String(v)]));
const FRONT = { curv_id: '12', curv_name: 'Front Loaded', ...pts([0, ...Array(10).fill(6.5), ...Array(10).fill(3.5)]) };
const ATSTART = { curv_id: '63', curv_name: 'At Start', ...pts([100, ...Array(20).fill(0)]) };
const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()((0||0(s|08:00|f|16:00)())))(0||4()((0||0(s|08:00|f|16:00)())))(0||5()((0||0(s|08:00|f|16:00)())))(0||6()((0||0(s|08:00|f|16:00)())))(0||7()())))(0||Exceptions()())))';
const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });

test('curve maths', () => {
  const c = curveOf(FRONT)!;
  assert.equal(cumulative(c, 0.5), 0.65);
  assert.equal(cumulative(c, 1), 1);
  assert.ok(Math.abs(shareBetween(c, 0.5, 1) - 0.35) < 1e-9);
  assert.equal(shareBetween(curveOf(ATSTART), 0, 0.01), 1);
  assert.equal(shareBetween(null, 0.25, 0.75), 0.5);
});

test('usage follows the assignment curve', () => {
  const asg = (curv: string): Db => ({ tables: {
    PROJECT: tbl('PROJECT', [{ proj_id: '1', clndr_id: '1', last_recalc_date: '2024-01-08 00:00' }]),
    CALENDAR: tbl('CALENDAR', [{ clndr_id: '1', default_flag: 'Y', clndr_name: 'Std', clndr_data: CAL }]),
    TASK: tbl('TASK', [{ task_id: '1', proj_id: '1', clndr_id: '1', early_start_date: '2024-01-08 08:00', early_end_date: '2024-01-19 16:00' }]),
    RSRC: tbl('RSRC', [{ rsrc_id: '7', rsrc_short_name: 'R', rsrc_type: 'RT_Labor', clndr_id: '1' }]),
    RSRCCURVDATA: tbl('RSRCCURVDATA', [FRONT, ATSTART]),
    TASKRSRC: tbl('TASKRSRC', [{ taskrsrc_id: '1', task_id: '1', proj_id: '1', rsrc_id: '7', remain_qty: '80', restart_date: '2024-01-08 08:00', reend_date: '2024-01-19 16:00', curv_id: curv }]),
  } });
  const range = { start: parseP6Date('2024-01-08')!, end: parseP6Date('2024-01-22')!, bucket: 'week' as const };
  const lin = spreadUsage(asg(''), ['1'], range).rows[0].remaining;
  assert.deepEqual(lin.map((x) => Math.round(x * 100) / 100), [40, 40]);
  const front = spreadUsage(asg('12'), ['1'], range).rows[0].remaining;
  assert.deepEqual(front.map((x) => Math.round(x * 100) / 100), [52, 28]);
  const start = spreadUsage(asg('63'), ['1'], range).rows[0].remaining;
  assert.deepEqual(start.map((x) => Math.round(x * 100) / 100), [80, 0]);
});
