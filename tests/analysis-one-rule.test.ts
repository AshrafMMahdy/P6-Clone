// One rule in one place, and a share judged exactly: dcma_14, check_schedule and lint judge a check on the count against its threshold, never on the share rounded for display
// (with a 0 % threshold one failing activity in a population of 2,500 used to read 0.0 and pass); the BEI and the invalid-dates rule each live in one function that every tool calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { dcma14, invalidDateFlags } from '../core/analysis/dcma.ts';
import { checkSchedule } from '../core/analysis/checkSchedule.ts';
import { decm } from '../core/analysis/decm.ts';
import { exactPct, makeScope, pct, percentCheck, baselineOf } from '../core/analysis/common.ts';
import { beiFigures } from '../core/analysis/forensic.ts';
import * as B from './benchmark-fixtures.ts';

const N = 2500;
/** 2,500 activities in a chain (2,499 links), each with a resource; then exactly one of each fault is written onto the rows */
function big() {
  const tasks: B.Source[] = Array.from({ length: N }, (_, i) => ({ id: `T${i + 1}`, duration_days: 1, ...(i ? { predecessors: [i === 4 ? `T${i}:FS-1` : `T${i}`] } : {}), ...(i + 1 === 10 ? {} : { resources: ['R'] }) }));
  const b = B.project('BIG', tasks, { resources: [{ id: 'R', max_units_per_day: 1 }], dataDate: '2026-01-05' });
  const t = (code: string) => rows(b.db, 'TASK').find((x) => x.task_code === code)!;
  t('T20').total_float_hr_cnt = '-24';
  t('T30').early_start_date = '2025-12-01 00:00'; t('T30').restart_date = '2025-12-01 00:00';
  return b;
}

test('a population of 2,500 with exactly one failing activity fails every 0 %-threshold dcma_14 check (it used to read 0.0 and pass)', () => {
  const b = big();
  const r = dcma14(b.db, { maxIds: 0, statusDate: parseP6Date('2026-01-05 00:00')! });
  const c = Object.fromEntries(r.checks.map((x) => [x.id, x]));
  for (const id of ['leads', 'negative_float', 'invalid_dates', 'resources']) {
    assert.equal(c[id].threshold!.value, 0, id);
    assert.equal(c[id].numerator, 1, `${id}: one failing activity`);
    assert.ok(c[id].denominator! >= 2499, `${id}: a population of about 2,500 (${c[id].denominator})`);
    assert.equal(c[id].result, 'fail', id);
    assert.ok(c[id].metric! > 0, `${id} never shows as 0 (${c[id].metric})`);
  }
  assert.deepEqual(c.leads.activities.map((a) => a.id), ['T4 -> T5']);
  assert.deepEqual(c.negative_float.activities.map((a) => a.id), ['T20']);
  assert.deepEqual(c.invalid_dates.activities.map((a) => a.id), ['T30']);
  assert.deepEqual(c.resources.activities.map((a) => a.id), ['T10']);
  // the same checks in decm, which always judged exactly, agree (06A506c is dcma_14's invalid dates, forecast part; its threshold is 10 %, so it passes there)
  const d = Object.fromEntries(decm(b.db, { statusDate: parseP6Date('2026-01-05 00:00')!, thresholds: { '06A506c': 0 } }).checks.map((x) => [x.id, x]));
  assert.equal(d['06A506c'].result, 'fail');
});

test('percentCheck judges the count, and shows a share that is not zero as not zero', () => {
  const found = [{ id: 'A', name: 'a' }];
  const one = percentCheck('x', 'x', found, 2068, { op: '<=', value: 0, source: 't' }, 0);
  assert.equal(one.result, 'fail');
  assert.equal(one.metric, 0.048, '1 of 2,068 is 0.048 %, not 0.0');
  assert.equal(pct(0, 2068), 0);
  assert.equal(pct(1, 8), 12.5);
  assert.equal(pct(33, 100), 33, 'a share that shows non-zero keeps the one decimal as before');
  assert.equal(pct(1, 0), null);
  // a share is judged at its exact value: 1 of 150 is 0.667 %, shown 0.7; under a "< 0.7" target it passes (the rounded 0.7 was not below 0.7)
  assert.equal(percentCheck('x', 'x', found, 150, { op: '<', value: 0.7, source: 't' }, 0).result, 'pass');
  assert.ok(exactPct(1, 150) < 0.7);
  // and a minimum: relationship types, 2 of 3 finish to start is 66.67 %, shown 66.7, and does not reach a minimum of 66.7
  const b = B.project('FS', [{ id: 'A', duration_days: 1 }, { id: 'B', duration_days: 1, predecessors: ['A'] }, { id: 'C', duration_days: 1, predecessors: ['B'] }, { id: 'D', duration_days: 1, predecessors: ['C:SS'] }]);
  const rt = dcma14(b.db, { thresholds: { relationship_types: 66.7 } }).checks.find((x) => x.id === 'relationship_types')!;
  assert.equal(rt.metric, 66.7);
  assert.equal(rt.result, 'fail', 'exactly 66.67 %');
  const cs = checkSchedule(b.db, { targets: { relationship_types: 66.7 } }).checks.find((x) => x.id === 'relationship_types')!;
  assert.equal(cs.result, 'fail');
});

test('check_schedule judges a 0.96 % share against its "< 1" target as the exact share (it used to read 1.0 and fail)', () => {
  // 104 links with one negative lag: 1 / 104 = 0.9615 %
  const tasks: B.Source[] = Array.from({ length: 105 }, (_, i) => ({ id: `T${i + 1}`, duration_days: 1, ...(i ? { predecessors: [i === 50 ? `T${i}:FS-1` : `T${i}`] } : {}) }));
  const b = B.project('LAG', tasks);
  const c = checkSchedule(b.db, { maxIds: 0 }).checks.find((x) => x.id === 'negative_lags')!;
  assert.equal(c.numerator, 1);
  assert.equal(c.denominator, 104);
  assert.equal(c.metric, 1, 'shown to one decimal');
  assert.equal(c.result, 'pass', 'exactly 0.96 %, under 1 %');
});

test('the BEI is one function: dcma_14 (due on or before the status date) and check_schedule (due before the data date) call it, and the answers carry the same figures', () => {
  const g = B.delayed();
  const s = makeScope(g.db, { calendarDays: true });
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(g.db, p, 'project')]));
  const f = beiFigures(s, bls);
  assert.equal(f.result, 'assessed');
  if (f.result !== 'assessed') return;
  const d = dcma14(g.db, { maxIds: 0 }).checks.find((x) => x.id === 'bei')!;
  assert.deepEqual([d.metric, d.numerator, d.denominator], [f.value, f.completed, f.due]);
  assert.equal(f.exact, f.completed / f.due);
  const nothing = beiFigures(makeScope(B.cleanChain().db, { calendarDays: true }), new Map());
  assert.equal(nothing.result, 'not_assessed');
  if (nothing.result === 'not_assessed') assert.equal(nothing.reason, 'no_baseline');
});

test('the invalid-dates rule is one function: dcma_14 check 9 is its flags in one list, decm 06A506a / b / c its flags in three', () => {
  const b = big();
  const s = makeScope(b.db, { calendarDays: true, statusDate: parseP6Date('2026-01-05 00:00')! });
  const { activities, with_data_date, flagged } = invalidDateFlags(s);
  assert.equal(activities.length, N);
  assert.equal(with_data_date.length, N);
  assert.deepEqual(flagged.map((f) => [f.task.task_code, f.forecast_before, f.actual_start_after, f.actual_finish_after]), [['T30', true, false, false]]);
  // an activity with an actual date after the status date and a forecast before it is one dcma_14 offender (the actual date is the reason) and appears in decm's two checks
  const t = rows(b.db, 'TASK').find((x) => x.task_code === 'T40')!;
  t.act_start_date = '2026-03-01 08:00'; t.early_end_date = '2025-12-31 00:00'; t.reend_date = '2025-12-31 00:00';
  const r = dcma14(b.db, { maxIds: 0, statusDate: parseP6Date('2026-01-05 00:00')! }).checks.find((x) => x.id === 'invalid_dates')!;
  assert.deepEqual(r.activities.map((a) => [a.id, a.value]), [['T30', 'forecast date before the status date'], ['T40', 'actual date after the status date']]);
  assert.equal(r.denominator, N);
  const d = Object.fromEntries(decm(b.db, { statusDate: parseP6Date('2026-01-05 00:00')! }).checks.map((x) => [x.id, x]));
  assert.deepEqual(d['06A506a'].activities.map((a) => a.id), ['T40']);
  assert.deepEqual(d['06A506c'].activities.map((a) => a.id), ['T30', 'T40']);
});
