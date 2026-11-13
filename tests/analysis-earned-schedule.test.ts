// SPI(t) as real Earned Schedule (Lipke) in progress_curves' totals, and the units: duration basis for a schedule with neither costs nor resource units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { CurvesRefused, progressCurves } from '../core/analysis/curves.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { project, type Built } from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots(); // (result files go to the run's temporary folder; the samples are copied there before they are opened)

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.ok(r.ok, JSON.stringify(r.error)); };
const resched = (b: Built, dd: string) => assert.ok(scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date(`${dd} 00:00`)! }).ok);

/** Three activities on a 7-day 24-hour calendar (a working day = a calendar day), planned from Monday 2 March 2026:
 *    A 7 days (2 - 9 Mar), B 7 days after A (9 - 16 Mar), C 14 days after B (16 - 30 Mar); with costs 700, 700 and 1400 (BAC 2800) or without.
 *  A baseline is saved, then at the data date Monday 23 March: A and B are complete (on time) and C started on time and is 25 % complete.
 *  Weekly periods (Monday to Monday). */
function build(o: { costs: boolean }): Built {
  const b = project('ES3', [{ id: 'A', duration_days: 7 }, { id: 'B', duration_days: 7, predecessors: ['A'] }, { id: 'C', duration_days: 14, predecessors: ['B'] }], {
    start: '2026-03-02', ops: o.costs ? [{ op: 'add_resource', id: 'R', price_per_unit: 1, units_per_day: 1 },
      { op: 'assign_resource', activity: 'A', resource: 'R', budgeted_cost: 700 }, { op: 'assign_resource', activity: 'B', resource: 'R', budgeted_cost: 700 }, { op: 'assign_resource', activity: 'C', resource: 'R', budgeted_cost: 1400 }] : [] });
  ok(b.db, [{ op: 'save_baseline', name: 'BL', assign_as: 'project' },
    { op: 'update_activity', id: 'A', actual_start: '2026-03-02 00:00', actual_finish: '2026-03-09 00:00' },
    { op: 'update_activity', id: 'B', actual_start: '2026-03-09 00:00', actual_finish: '2026-03-16 00:00' },
    { op: 'update_activity', id: 'C', actual_start: '2026-03-16 00:00', percent_complete: 25 }]);
  resched(b, '2026-03-23');
  return b;
}
const near = (a: number | null, b: number, what: string, eps = 1e-9) => assert.ok(a != null && Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);

test('Earned Schedule by hand on three activities (cost basis): ES 2.5 weeks, AT 3, SPI(t) 0.833, SV(t) -0.5', () => {
  // Planned value per week: A 700 in week 1 (2-9 Mar), B 700 in week 2 (9-16), C 1400 over weeks 3 and 4 (16-30): 700 each. Cumulative PV at the end of each week: 700, 1400, 2100, 2800.
  // Earned value at the data date (23 Mar): A 700 + B 700 + C 25 % of 1400 = 350 -> 1750. 1750 is passed in week 3 (16-23 Mar), after 1400 at its start: 1400 + 700 x 0.5 = 1750.
  // ES = 2 whole weeks + (1750 - 1400) / 700 = 2 + 0.5 = 2.5 weeks, at 16 Mar + 3.5 days = 19 Mar 12:00. AT = 2 Mar to 23 Mar = 3 weeks (21 days).
  // SPI(t) = 2.5 / 3 = 0.833; SV(t) = 2.5 - 3 = -0.5 weeks = 17.5 - 21 = -3.5 working days (a 7-day calendar). PD = 2 - 30 Mar = 4 weeks.
  const b = build({ costs: true });
  const c = progressCurves(b.db, [b.projId], { period: 'week' });
  assert.equal(c.baseline, 'BL');
  assert.equal(c.totals.bac, 2800);
  assert.equal(c.totals.ev, 1750);
  near(c.totals.es, 2.5, 'ES'); near(c.totals.at, 3, 'AT'); near(c.totals.pd, 4, 'PD');
  near(c.totals.spi_t, 0.833, 'SPI(t)', 1e-9); near(c.totals.sv_t, -0.5, 'SV(t)');
  assert.equal(c.totals.es_date, '2026-03-19', 'the date at which the plan had earned 1750 (12:00 on the 19th)');
  near(c.totals.es_days, 17.5, 'ES in working days'); near(c.totals.at_days, 21, 'AT in working days'); near(c.totals.sv_t_days, -3.5, 'SV(t) in working days');
  assert.equal((c.totals as any).es_note, undefined);
  // cost-based SPI at the data date, the same data: EV 1750 over PV 2100 (to the end of the week of the data date)
  assert.equal(c.totals.spi, Math.round((1750 / 2100) * 100) / 100);
});

test('the duration basis: the same Earned Schedule on a file with no costs and no resources, through the same curve code', () => {
  // planned duration A 7 d, B 7 d, C 14 d spread on the baseline dates: 7 days in each of 4 weeks (cumulative 7, 14, 21, 28); earned 7 + 7 + 25 % x 14 = 17.5 days -> ES = 2 + (17.5 - 14) / 7 = 2.5 weeks
  const b = build({ costs: false });
  const c = progressCurves(b.db, [b.projId], { period: 'week', units: 'duration' });
  assert.equal(c.units, 'duration');
  assert.equal(c.totals.bac, 28);
  assert.equal(c.totals.ev, 17.5);
  assert.deepEqual(c.periods.map((p) => p.cum_pv).slice(0, 4), [7, 14, 21, 28]);
  assert.ok(c.periods.every((p) => p.cum_pv <= 28));
  assert.equal(c.periods[0].pv, 7);
  near(c.totals.es, 2.5, 'ES'); near(c.totals.at, 3, 'AT'); near(c.totals.spi_t, 0.833, 'SPI(t)'); near(c.totals.sv_t, -0.5, 'SV(t)');
  assert.equal(c.totals.es_date, '2026-03-19');
  // actual = the working time since the actual start: A 7, B 7, C 7 (16-23 Mar); remaining = C's 14 d x 75 %
  assert.equal(c.totals.ac, 21);
  assert.equal(c.totals.etc, 10.5);
  // the cost basis of the same file: no planned value, so not assessed (not 1), and the warning names the duration basis
  const cost = progressCurves(b.db, [b.projId], { period: 'week' });
  assert.equal(cost.totals.bac, 0);
  assert.equal(cost.totals.es, null);
  assert.equal(cost.totals.spi_t, null);
  assert.match(cost.notes.join(' '), /No budgeted cost in/);
  assert.ok(cost.notes.some((w) => /pass units: duration/.test(w)));
  // an activity with a baseline duration shorter than its current one: the planned duration is the baseline's
  ok(b.db, [{ op: 'update_activity', id: 'C', duration_days: 21 }]);
  assert.equal(progressCurves(b.db, [b.projId], { period: 'week', units: 'duration' }).totals.bac, 28, 'BAC follows the baseline, not the revised duration');
  // level of effort carries no planned duration of its own
  ok(b.db, [{ op: 'add_activity', id: 'L', name: 'Supervision', type: 'loe', calendar: 'D7' }]);
  const loe = rows(b.db, 'TASK').find((t) => t.task_code === 'L')!;
  loe.target_drtn_hr_cnt = '672'; loe.target_start_date = '2026-03-02 00:00'; loe.target_end_date = '2026-03-30 00:00';
  assert.equal(progressCurves(b.db, [b.projId], { period: 'week', units: 'duration' }).totals.bac, 28);
});

test('the same Earned Schedule in months: positions are periods with the share of the month elapsed', () => {
  const b = build({ costs: true });
  const c = progressCurves(b.db, [b.projId], { period: 'month' });
  // months: March (31 d) holds all of the plan (2 - 30 Mar): cumulative PV 2800 at the end of the month; EV 1750 -> t* = 2 Mar + 1750/2800 x 28 d... PV is spread by working time: linear over 2-30 Mar,
  // so 1750 is reached at 2 Mar + 17.5 d = 19 Mar 12:00 (P0 = 2 Mar, the part of the month the plan covers is 2 - 30 Mar: interpolated across that span)
  assert.equal(c.totals.es_date, '2026-03-19');
  // positions inside March: ES = (19.5 - 1) / 31 of a month from 2 Mar (1/31) -> (17.5)/31 = 0.565 ; AT = 21 / 31 = 0.677 ; PD = 28 / 31 = 0.903
  near(c.totals.es, 17.5 / 31, 'ES in months', 1e-3); near(c.totals.at, 21 / 31, 'AT in months', 1e-3); near(c.totals.pd, 28 / 31, 'PD in months', 1e-3);
  near(c.totals.spi_t, 17.5 / 21, 'SPI(t) is the same in any unit', 2e-3);
  near(c.totals.es_days, 17.5, 'days are the same in any unit');
});

test('a finished project: SPI(t) = PD / AT stays below 1 where cost-based SPI returns to 1', () => {
  const b = build({ costs: true });
  // C finishes late, on 6 April (the plan said 30 March); data date 7 April; everything earned
  ok(b.db, [{ op: 'update_activity', id: 'C', actual_finish: '2026-04-06 00:00', percent_complete: 100 }]);
  resched(b, '2026-04-07');
  const c = progressCurves(b.db, [b.projId], { period: 'week' });
  assert.equal(c.totals.ev, 2800);
  assert.equal(c.totals.spi, 1, 'cost-based SPI: everything earned against everything planned');
  near(c.totals.es, 4, 'ES = the planned duration'); near(c.totals.at, 36 / 7, 'AT: 2 Mar to 7 Apr = 36 days = 5.143 weeks', 1e-3);
  near(c.totals.spi_t, 4 / (36 / 7), 'SPI(t)', 1e-3);
  assert.ok(c.totals.spi_t! < 1);
  assert.ok(c.totals.sv_t! < 0);
  assert.equal(c.totals.es_date, '2026-03-30');
  near(c.totals.sv_t_days, 28 - 36, 'SV(t) in working days');
});

test('not assessed, with the reason and never 1: no data date, no planned value, no planned dates, a window that cuts the curve, no time passed', () => {
  const na = (c: ReturnType<typeof progressCurves>, re: RegExp) => {
    for (const k of ['es', 'at', 'pd', 'spi_t', 'sv_t', 'es_date', 'es_days', 'at_days', 'sv_t_days'] as const) assert.equal(c.totals[k], null, k);
    assert.match(c.notes.join(' '), re);
  };
  // no data date
  const nd = build({ costs: false });
  for (const p of rows(nd.db, 'PROJECT')) p.last_recalc_date = '';
  na(progressCurves(nd.db, [nd.projId], { period: 'week', units: 'duration' }), /no data date/);
  // planned value 0: hours with no resources, cost with no costs
  const b = build({ costs: false });
  na(progressCurves(b.db, [b.projId], { period: 'week', units: 'hours' }), /No budgeted units in/);
  na(progressCurves(b.db, [b.projId], { period: 'week' }), /No budgeted cost in/);
  // no planned curve: the activities have durations but no planned dates (no baseline in this file either)
  const nb = project('NODATES', [{ id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A'] }], { start: '2026-03-02', dataDate: '2026-03-09' });
  for (const t of rows(nb.db, 'TASK')) for (const f of ['target_start_date', 'target_end_date', 'early_start_date', 'early_end_date']) t[f] = '';
  na(progressCurves(nb.db, [nb.projId], { period: 'week', units: 'duration' }), /no planned curve/);
  // an empty project
  const empty = project('EMPTY', [], { start: '2026-03-02' });
  na(progressCurves(empty.db, [empty.projId], { units: 'duration' }), /No planned duration in/);
  // from/to cut the planned curve
  const cut = build({ costs: false });
  na(progressCurves(cut.db, [cut.projId], { period: 'week', units: 'duration', from: parseP6Date('2026-03-16 00:00')!, to: parseP6Date('2026-03-30 00:00')! }), /window cuts the planned curve/);
  // the data date is the planned start: nothing has passed
  const start = build({ costs: false });
  resched(start, '2026-03-02');
  for (const t of rows(start.db, 'TASK')) { t.act_start_date = ''; t.act_end_date = ''; t.remain_drtn_hr_cnt = t.target_drtn_hr_cnt; }
  na(progressCurves(start.db, [start.projId], { period: 'week', units: 'duration' }), /not after the planned start/);
  // everything not started and the data date after the start: ES 0, AT > 0: SPI(t) is 0, a real answer
  const behind = project('BEHIND', [{ id: 'A', duration_days: 7 }, { id: 'B', duration_days: 7, predecessors: ['A'] }], { start: '2026-03-02' });
  ok(behind.db, [{ op: 'save_baseline', name: 'BL', assign_as: 'project' }]);
  resched(behind, '2026-03-09');
  const c0 = progressCurves(behind.db, [behind.projId], { period: 'week', units: 'duration' });
  assert.equal(c0.totals.ev, 0);
  assert.equal(c0.totals.es, 0);
  assert.equal(c0.totals.spi_t, 0);
  near(c0.totals.sv_t, -1, 'a week behind');
});

test('the basis follows the plan when the file has no baseline, and says so', () => {
  const b = build({ costs: false });
  for (const p of rows(b.db, 'PROJECT')) p.sum_base_proj_id = '';
  for (const p of rows(b.db, 'PROJECT').filter((x) => x._baseline_of)) p._baseline_of = 'GONE';
  const c = progressCurves(b.db, [b.projId], { period: 'week', units: 'duration' });
  assert.equal(c.baseline, null);
  assert.equal((c.totals as any).es_note, undefined);
  assert.ok(c.totals.es != null && c.totals.es <= c.totals.pd!);
});

test('real samples with progress: ES within the planned span, SPI(t) = ES / AT, days and dates consistent', () => {
  for (const [name, units] of [['129 trial.xer', 'duration'], ['129 trial.xer', 'hours'], ['cairo alex-road.xer', 'duration'], ['cairo alex-road.xer', 'cost']] as const) {
    const db = readXerFile(sampleCopy(name)).db;
    const ids = rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
    const c = progressCurves(db, ids, { period: 'month', units });
    const t = c.totals, label = `${name} ${units}`;
    assert.ok(c.data_date, label);
    assert.ok(t.es != null && t.at != null && t.pd != null && t.spi_t != null && t.sv_t != null, `${label}: ${c.notes.join(' ')}`);
    assert.ok(t.es >= 0 && t.es <= t.pd + 1e-9, `${label}: ES ${t.es} within the planned duration ${t.pd}`);
    assert.ok(t.at > 0, label);
    assert.ok(Math.abs(t.spi_t - t.es / t.at) < 0.002, `${label}: SPI(t) ${t.spi_t} = ES ${t.es} / AT ${t.at}`);
    assert.ok(Math.abs(t.sv_t - (t.es - t.at)) < 0.002, `${label}: SV(t)`);
    assert.ok(t.es_days != null && t.at_days != null && t.es_days <= t.at_days + 1e-9 === t.es <= t.at + 1e-9, `${label}: days and periods agree on ahead or behind`);
    assert.ok(t.es_date! <= c.data_date!.slice(0, 10) || t.es > t.at, label);
  }
  // 129 trial names a project baseline the file does not hold (it was exported without it): the file's own budget and dates stand in, as with no baseline assigned (the budget read as 0 before,
  // and the cost basis as "no budgeted cost"). The budget, from the rows: the budgeted cost of the project's assignments and expenses.
  const db = readXerFile(sampleCopy('129 trial.xer')).db;
  const p = rows(db, 'PROJECT').filter((x) => !x._baseline_of);
  assert.ok(p[0].sum_base_proj_id && !rows(db, 'PROJECT').some((x) => x.proj_id === p[0].sum_base_proj_id));
  const mine = new Set(rows(db, 'TASK').filter((t) => t.proj_id === p[0].proj_id).map((t) => t.task_id));
  const budget = rows(db, 'TASKRSRC').filter((a) => mine.has(a.task_id)).reduce((s, a) => s + Number(a.target_cost || 0), 0) + rows(db, 'PROJCOST').filter((e) => mine.has(e.task_id)).reduce((s, e) => s + Number(e.target_cost || 0), 0);
  assert.ok(budget > 0);
  const cost = progressCurves(db, p.map((x) => x.proj_id), { units: 'cost' });
  assert.ok(Math.abs(cost.totals.bac - budget) < 1, `${cost.totals.bac} is the file's budget ${budget}`);
  assert.ok(cost.totals.spi_t != null && cost.totals.spi_t > 0);
  assert.doesNotMatch(cost.notes.join(' '), /No budgeted cost in/);
  assert.match(cost.notes.join(' '), /^The project baseline of R29BT-modefied-10 is not in this file \(the file was exported without it\): the current budget and dates were used; export the file with its baselines to measure against it\./);
});

test('through the tool: units duration is accepted, the answer and the result file carry the Earned Schedule columns, a bad units is refused', async () => {
  const { callTool, toolResult, toolsList } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const o = await call('open_file', { path: sampleCopy('129 trial.xer') });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 200));
  const r = await call('progress_curves', { handle: o.d.handle, units: 'duration', period: 'month' });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.units, 'duration');
  assert.ok(r.d.totals.es > 0 && r.d.totals.spi_t > 0);
  const totalsCsv = r.d.exported.files.find((f: any) => f.path.endsWith('-totals.csv'));
  const lines = readFileSync(totalsCsv.path, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines[0], 'units,data_date,bac,pv,ev,ac,etc,eac,vac,spi,cpi,tcpi,es,at,pd,spi_t,sv_t,es_date,es_days,at_days,sv_t_days');
  assert.equal(lines.length, 2);
  const bad = await call('progress_curves', { handle: o.d.handle, units: 'weeks' });
  assert.equal(bad.err, true);
  assert.equal(bad.d.error.message, 'units must be cost, hours or duration.');
  const desc = String((toolsList() as any[]).find((t) => t.name === 'progress_curves').description);
  for (const w of ['Earned Schedule (Lipke)', 'es = the time at which the cumulative planned value equals the earned value now', 'spi_t = es / at', 'sv_t = es - at', 'SPI(t) stays meaningful to the end of a project', 'units: cost (default), hours (resource units) or duration']) assert.ok(desc.includes(w), w);
});

test('Tower-A (a small real file with progress), duration basis in weeks: Earned Schedule worked out by hand from the file\'s rows', () => {
  // rows (project 10, data date Wed 1 Apr 2026 08:00; its baseline TOWER-A-BL1 is the project 11 held in the file):
  //   A1010 Site 5-Day (8 h): baseline 40 h = 5 d, Mon 2 Mar 08:00 - Fri 6 Mar 17:00; complete.        A1020 Night Shift 7-Day (10 h): baseline 80 h = 8 d, Sat 7 Mar 07:00 - Sat 14 Mar 18:00; 40 %.
  //   A1030 and M1000 are not in the baseline: their own planned values (A1030 80 h = 10 d, Thu 19 Mar - Wed 1 Apr; M1000 none).
  // BAC = 5 + 8 + 10 = 23 days. Earned = 5 (A1010) + 0.4 x 8 (A1020) = 8.2 days.
  // Planned value per week (Monday weeks): A1010 5 d in the week of 2 Mar; A1020 2 d on Sat 7 and Sun 8 Mar (week of 2 Mar) and 6 d on 9 - 14 Mar (week of 9 Mar); A1030 2 d on 19 - 20 Mar (week of 16 Mar),
  // 5 d in the week of 23 Mar, 3 d on 30 - 31 Mar and 1 Apr. So 7, 6, 2, 5, 3: cumulative 7, 13, 15, 20, 23.
  // 8.2 is passed in the week of 9 Mar (cumulative 7 before it, 6 in it): ES = 9 Mar + (8.2 - 7) / 6 of the week's span, 9 Mar - 16 Mar (7 days) = 9 Mar + 1.4 d = Tue 10 Mar 09:36.
  // In weeks from the planned start (2 Mar 08:00 = 8 h of 168 into the week): ES = 1 + 1.4 / 7 - 8 / 168 = 1.15238; AT (to 1 Apr 08:00: week 4 + 2 d 8 h of 7 d = 4 + 56 / 168) = 4.33333 - 0.04762 = 4.28571;
  // PD (to the planned finish Wed 1 Apr 17:00 = 4 + 65 / 168) = 4.33929; SPI(t) = 1.15238 / 4.28571 = 0.26889; SV(t) = 1.15238 - 4.28571 = -3.13333.
  // In working days of the project calendar (Site 5-Day, 8 h): from 2 Mar 08:00 to 10 Mar 09:36 = 5 + 1 + 1.6 / 8 = 6.2 d; to 1 Apr 08:00 = 4 weeks of 5 + 2 = 22 d; SV(t) = 6.2 - 22 = -15.8 d.
  const db = readXerFile(sampleCopy('Tower-A.xer')).db;
  rows(db, 'PROJECT').find((p) => !p._baseline_of)!.sum_base_proj_id = '11'; // TOWER-A-BL1 assigned as the project baseline (a baseline only saved in the file is not picked)
  const c = progressCurves(db, rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id), { period: 'week', units: 'duration' });
  assert.equal(c.baseline, 'TOWER-A-BL1');
  assert.equal(c.totals.bac, 23);
  assert.equal(c.totals.ev, 8.2);
  assert.deepEqual(c.periods.map((p) => p.cum_pv).slice(0, 5), [7, 13, 15, 20, 23]);
  near(c.totals.es, 1 + 1.4 / 7 - 8 / 168, 'ES', 5e-4); near(c.totals.at, 4 + 56 / 168 - 8 / 168, 'AT', 5e-4); near(c.totals.pd, 4 + 65 / 168 - 8 / 168, 'PD', 5e-4);
  near(c.totals.spi_t, 0.269, 'SPI(t)', 5e-4); near(c.totals.sv_t, -3.133, 'SV(t)', 5e-4);
  assert.equal(c.totals.es_date, '2026-03-10');
  near(c.totals.es_days, 6.2, 'ES in working days', 5e-4); near(c.totals.at_days, 22, 'AT in working days'); near(c.totals.sv_t_days, -15.8, 'SV(t) in working days', 5e-4);
});

test('projects with different data dates: the call is refused before anything is computed, naming each Project ID with its data date and the next step; one project, or projects that share a data date, work as before', () => {
  const db = readXerFile(sampleCopy('Enppi.xer')).db;
  const ps = rows(db, 'PROJECT').filter((p) => !p._baseline_of), all = ps.map((p) => p.proj_id);
  assert.equal(new Set(ps.map((p) => p.last_recalc_date)).size, 2, 'the two projects of Enppi have different data dates');
  // the whole file, on every basis (it used to answer SPI(t) 2.826 and SPI 5.01, pv, ac, eac, vac and tcpi at the wrong date)
  for (const units of ['cost', 'hours', 'duration'] as const) assert.throws(() => progressCurves(db, all, { period: 'month', units }), (e: unknown) => e instanceof CurvesRefused
    && e.message === 'Refused: Master Rev.F-N-4 and 4229 update 2-6-12 have different data dates (2011-11-30, 2012-06-02).' && e.next === 'Pass project: Master Rev.F-N-4, 4229 update 2-6-12 (one project at a time).', units);
  // the project alone: its own figures (SPI(t) 1.035)
  const one = progressCurves(db, [ps[1].proj_id], { period: 'month', units: 'duration' });
  near(one.totals.spi_t, 1.035, 'SPI(t) of the project alone', 5e-4); near(one.totals.spi, 1.06, 'SPI at the data date (it was 0.91 by month, 1.05 by week)', 5e-3); assert.equal(progressCurves(db, [ps[1].proj_id], { period: 'week', units: 'duration' }).totals.spi, one.totals.spi); assert.equal(one.notes.some((x) => /different data dates/.test(x)), false);
  // the same data date on both: assessed, as today (and no warning about dates)
  ps[0].last_recalc_date = ps[1].last_recalc_date;
  const same = progressCurves(db, all, { period: 'month', units: 'duration' });
  assert.ok(same.totals.spi_t != null && same.totals.spi != null && same.totals.cpi != null);
  assert.equal(same.notes.some((x) => /different data dates/.test(x)), false);
  // a project with no data date next to one with: different, refused, the missing one named
  ps[0].last_recalc_date = '';
  assert.throws(() => progressCurves(db, all, { period: 'month', units: 'duration' }), /Master Rev\.F-N-4 and 4229 update 2-6-12 have different data dates \(none, 2012-06-02\)/);
});

test('SPI and the planned value in the totals are taken AT the data date on every basis: the same by week and by month, and the same as the cost basis; by hand', () => {
  // data date Wednesday 25 March, in the middle of a week and of a month. Planned: A 2-9 Mar, B 9-16 Mar, C 16-30 Mar (14 days). At the data date: A 7 + B 7 + C 14 x 9/14 = 9 -> PV 23 working days (the cost basis: 700 + 700 + 1400 x 9/14 = 2300).
  // Earned: A 7 + B 7 + C 25 % of 14 = 3.5 -> 17.5 (cost 1750). SPI = 17.5 / 23 = 0.76 on both. (To the end of the week of the data date, 30 Mar, the planned value would be 28 and SPI 0.63; to the end of the month 28 again.)
  const d = build({ costs: false }), c = build({ costs: true });
  resched(d, '2026-03-25'); resched(c, '2026-03-25');
  const dw = progressCurves(d.db, [d.projId], { period: 'week', units: 'duration' }), dm = progressCurves(d.db, [d.projId], { period: 'month', units: 'duration' });
  for (const x of [dw, dm]) { assert.equal(x.totals.pv, 23); assert.equal(x.totals.ev, 17.5); assert.equal(x.totals.spi, 0.76); }
  assert.equal(dw.totals.spi, dm.totals.spi);
  const cw = progressCurves(c.db, [c.projId], { period: 'week' }), cm = progressCurves(c.db, [c.projId], { period: 'month' });
  assert.equal(cw.totals.pv, 2300); assert.equal(cm.totals.pv, 2300);
  assert.equal(cw.totals.spi, dw.totals.spi, 'the cost basis and the duration basis cut the planned value the same way');
  // the curve itself still runs to the end of its periods (cum_pv 28 at the end of the last week), only the totals are at the data date
  assert.equal(dw.periods.at(-1)!.cum_pv, 28);
  // the data date at or before the planned start: nothing planned yet, SPI not assessed (never 0 from a period-end planned value)
  const e = build({ costs: false });
  resched(e, '2026-03-02');
  const early = progressCurves(e.db, [e.projId], { period: 'month', units: 'duration' });
  assert.equal(early.totals.pv, 0); assert.equal(early.totals.spi, null);
});

test('the duration basis says what its totals mean (basis_note); the other bases carry no such note', () => {
  const b = build({ costs: false });
  const d = progressCurves(b.db, [b.projId], { period: 'week', units: 'duration' });
  assert.equal((d as any).basis_note, undefined);
  assert.equal((d as any).basis_note, undefined);
  // the figures it describes, by hand on this file: A 7 d, B 7 d, C 14 d; earned 17.5; spent 7 + 7 + 7 = 21; remaining 10.5
  assert.deepEqual([d.totals.bac, d.totals.ev, d.totals.ac, d.totals.etc, d.totals.eac, d.totals.vac], [28, 17.5, 21, 10.5, 31.5, -3.5]);
  near(d.totals.cpi, 0.83, 'cpi = 17.5 / 21', 5e-3); near(d.totals.tcpi, (28 - 17.5) / (28 - 21), 'tcpi', 5e-3);
  assert.equal('basis_note' in progressCurves(b.db, [b.projId], { period: 'week' }), false);
  assert.equal('basis_note' in progressCurves(b.db, [b.projId], { period: 'week', units: 'hours' }), false);
});

test('the refusal for different data dates lists the Project IDs by the list rule when there are many: 25, how many more, the total', () => {
  const db = readXerFile(sampleCopy('Enppi.xer')).db;
  const first = rows(db, 'PROJECT').filter((p) => !p._baseline_of)[0], ids: string[] = [];
  for (let i = 0; i < 30; i++) { const p = { ...first, proj_id: `X${i}`, proj_short_name: `PRJ${i}`, last_recalc_date: `2026-01-${String(1 + i % 28).padStart(2, '0')} 00:00` }; db.tables.PROJECT.rows.push(p); ids.push(p.proj_id); }
  assert.throws(() => progressCurves(db, ids, { period: 'month' }), (e: unknown) => e instanceof CurvesRefused && /2026-01-25 and 5 more \(30 in total\)\)/.test(e.message) && !/PRJ25 /.test(e.message) && /pass project: PRJ0, PRJ1.*PRJ24 and 5 more \(30 in total\) \(one project at a time\)/i.test(e.next));
});
