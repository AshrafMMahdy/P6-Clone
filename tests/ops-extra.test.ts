import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { runTool } from '../core/query/tools.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { getEstimates } from '../core/risk/montecarlo.ts';
import { readRaw } from '../renderer/io.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLES_DIR } from './helpers.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); return r.results; };
const bad = (db: Db, ops: unknown[], re: RegExp) => { const r = applyOps(db, ops); assert.equal(r.ok, false); assert.match(r.error!.message, re); };

function base(): Db {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'P1', start: '2026-03-02' },
    { op: 'add_wbs', code: 'A' }, { op: 'add_wbs', code: 'B' }, { op: 'add_wbs', code: 'A1', parent: 'A' },
    { op: 'add_activity', id: 'T1', name: 'One', wbs: 'A1', duration_days: 5 },
    { op: 'add_resource', id: 'LAB', units_per_day: 8 },
    { op: 'assign_resource', activity: 'T1', resource: 'LAB' },
  ]);
  return db;
}

test('ops: WBS rename and move, refusing a move under itself', () => {
  const db = base();
  ok(db, [{ op: 'update_wbs', code: 'A1', new_code: 'X1', name: 'Moved', parent: 'B' }]);
  const w = rows(db, 'PROJWBS').find((x) => x.wbs_short_name === 'X1')!;
  assert.equal(rows(db, 'PROJWBS').find((x) => x.wbs_id === w.parent_wbs_id)!.wbs_short_name, 'B');
  bad(db, [{ op: 'update_wbs', code: 'B', parent: 'B.X1' }], /under itself/);
});

test('ops: activity, project and resource codes, assignment replaces per type', () => {
  const db = base();
  ok(db, [
    { op: 'add_code_type', name: 'Phase', values: [{ code: 'DES', name: 'Design' }, { code: 'CON', name: 'Construction' }] },
    { op: 'add_code_value', type: 'Phase', code: 'CON.F1', parent: 'CON' },
    { op: 'assign_code', activity: 'T1', type: 'Phase', value: 'DES' },
    { op: 'assign_code', activity: 'T1', type: 'Phase', value: 'CON' },
    { op: 'add_code_type', name: 'Region', subject: 'project', values: [{ code: 'GCC' }] },
    { op: 'assign_code', project: 'P1', type: 'Region', value: 'GCC' },
    { op: 'add_code_type', name: 'Trade', subject: 'resource', values: [{ code: 'CIV' }] },
    { op: 'assign_code', resource: 'LAB', type: 'Trade', value: 'CIV' },
  ]);
  assert.equal(rows(db, 'TASKACTV').length, 1);
  assert.equal(rows(db, 'ACTVCODE').find((c) => c.actv_code_id === rows(db, 'TASKACTV')[0].actv_code_id)!.short_name, 'CON');
  assert.equal(rows(db, 'PROJPCAT').length, 1);
  assert.equal(rows(db, 'RSRCRCAT').length, 1);
  bad(db, [{ op: 'assign_code', activity: 'T1', type: 'Phase', value: 'NOPE' }], /No value "NOPE"/);
  ok(db, [{ op: 'assign_code', activity: 'T1', type: 'Phase', value: '' }]);
  assert.equal(rows(db, 'TASKACTV').length, 0);
});

test('ops: a code value longer than its type allows (default 20, max_length up to 60) is refused, never cut', () => {
  const db = base();
  const v = (n: number) => 'V'.repeat(n);
  ok(db, [{ op: 'add_code_type', name: 'Short', values: [{ code: v(20) }] }, { op: 'add_code_type', name: 'Long', max_length: 60, values: [{ code: v(60) }] }, { op: 'add_code_type', name: 'Area', subject: 'resource', max_length: 30 }]);
  bad(db, [{ op: 'add_code_value', type: 'Short', code: v(21) }], new RegExp(`Code value "${v(21)}" is 21 characters; code type "Short" allows 20 .*max_length can be up to 60.*Nothing was cut`));
  bad(db, [{ op: 'add_code_value', type: 'Long', code: v(61) }], /is 61 characters; code type "Long" allows 60/);
  bad(db, [{ op: 'add_code_value', type: 'Area', subject: 'resource', code: v(31) }], /allows 30/);
  bad(db, [{ op: 'add_code_type', name: 'Huge', max_length: 61 }], /max_length 61 is more than P6 allows for a code value \(60\)/);
  ok(db, [{ op: 'add_code_value', type: 'Area', subject: 'resource', code: v(30) }]);
  // a type read from a file without a length still holds at most 60
  rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === 'Long')!.actv_short_len = '';
  bad(db, [{ op: 'add_code_value', type: 'Long', code: v(61) + 'X' }], /allows 60/);
  assert.deepEqual(rows(db, 'ACTVCODE').map((c) => c.short_name.length), [20, 60]);
});

test('ops: UDFs, notebook, cost accounts and expenses, steps, estimates', () => {
  const db = base();
  ok(db, [
    { op: 'add_udf', name: 'Risk Score', data_type: 'number' },
    { op: 'set_udf', udf: 'Risk Score', activity: 'T1', value: 7.5 },
    { op: 'add_udf', name: 'Permit Date', data_type: 'start_date' },
    { op: 'set_udf', udf: 'Permit Date', activity: 'T1', value: '2026-04-01' },
    { op: 'set_notebook', activity: 'T1', text: 'Check <soil>\nreport' },
    { op: 'add_cost_account', id: '100', name: 'Materials' },
    { op: 'add_expense', activity: 'T1', name: 'Rebar', account: '100', units: 10, price_per_unit: 50, actual_cost: 100 },
    { op: 'add_step', activity: 'T1', name: 'Excavate', weight: 2, percent_complete: 50 },
    { op: 'add_step', activity: 'T1', name: 'Pour' },
    { op: 'set_estimates', activity: 'T1', min_days: 4, most_likely_days: 5, max_days: 9, distribution: 'betapert' },
  ]);
  const v = rows(db, 'UDFVALUE');
  assert.equal(v.length, 2);
  assert.equal(Number(v.find((x) => x.udf_number)!.udf_number), 7.5);
  assert.match(v.find((x) => x.udf_date)!.udf_date, /^2026-04-01/);
  assert.equal(rows(db, 'TASKMEMO')[0].task_memo, '<HTML><BODY>Check &lt;soil><br>report</BODY></HTML>');
  const c = rows(db, 'PROJCOST')[0];
  assert.deepEqual([Number(c.target_cost), Number(c.act_cost), Number(c.remain_cost)], [500, 100, 400]);
  assert.equal(rows(db, 'TASKPROC').length, 2);
  const e = getEstimates(db).get(rows(db, 'TASK')[0].task_id)!;
  assert.deepEqual([e.min, e.ml, e.max, e.dist], [32, 40, 72, 'betapert']);
  bad(db, [{ op: 'set_estimates', activity: 'T1', min_days: 9, max_days: 2 }], /more than max_days/);
  bad(db, [{ op: 'set_udf', udf: 'Risk Score', activity: 'T1', value: 'high' }], /must be a number/);
  ok(db, [{ op: 'update_expense', activity: 'T1', name: 'Rebar', budgeted_cost: 800 }, { op: 'delete_step', activity: 'T1', name: 'Pour' }, { op: 'set_notebook', activity: 'T1', text: '' }]);
  assert.equal(Number(rows(db, 'PROJCOST')[0].remain_cost), 700);
  assert.equal(rows(db, 'TASKPROC').length, 1);
  assert.equal(rows(db, 'TASKMEMO').length, 0);
});

test('ops: baselines (project baseline and BL1-BL3), listed by list_dictionaries', () => {
  const db = base();
  ok(db, [
    { op: 'save_baseline', name: 'P1 BL0', assign_as: 'project' },
    { op: 'save_baseline', name: 'P1 Rev1' },
    { op: 'assign_baseline', baseline: 'P1 Rev1', as: 'bl1' },
  ]);
  const p = rows(db, 'PROJECT').find((x) => x.proj_short_name === 'P1')!;
  const dict = runTool('list_dictionaries', { only: 'baselines' }, db, makeCtx(db, { hoursPerDay: 8 }), [], 8) as { baselines: { project_baseline: string; bl1: string; saved: unknown[] }[] };
  assert.equal(dict.baselines[0].project_baseline, 'P1 BL0');
  assert.equal(dict.baselines[0].bl1, 'P1 Rev1');
  assert.equal(dict.baselines[0].saved.length, 2);
  assert.ok(p.sum_base_proj_id);
  ok(db, [{ op: 'delete_baseline', baseline: 'P1 Rev1' }]);
  assert.equal(rows(db, 'PROJECT').find((x) => x.proj_short_name === 'P1')!._bl1, '');
  bad(db, [{ op: 'assign_baseline', baseline: 'nope' }], /No baseline "nope"/);
  // the open project's edits are not confused with the baseline copy (one T1 outside the baseline)
  ok(db, [{ op: 'update_activity', id: 'T1', duration_days: 6 }]);
});

test('ops: EPS, OBS, roles, calendar changes, assignment curve; XER keeps codes, UDFs, steps, expenses', () => {
  const db = base();
  ok(db, [
    { op: 'add_eps', id: 'CIV', name: 'Civil' }, { op: 'add_eps', id: 'ROADS', parent: 'CIV' },
    { op: 'set_project', eps: 'ROADS' },
    { op: 'add_obs', name: 'PMO' }, { op: 'add_obs', name: 'Site', parent: 'PMO' }, { op: 'update_obs', name: 'Site', new_name: 'Site Team' },
    { op: 'add_role', id: 'ENG', name: 'Engineer' }, { op: 'update_role', id: 'ENG', name: 'Site Engineer' },
    { op: 'add_calendar', name: 'Six Day' },
    { op: 'update_calendar', name: 'Six Day', new_name: '6-Day', work_week: { sat: [['08:00', '12:00'], ['13:00', '17:00']] }, holidays: ['2026-03-20'] },
    { op: 'update_assignment', activity: 'T1', resource: 'LAB', units: 60 },
    { op: 'add_code_type', name: 'Phase', values: [{ code: 'DES' }] }, { op: 'assign_code', activity: 'T1', type: 'Phase', value: 'DES' },
    { op: 'add_udf', name: 'Note', data_type: 'text' }, { op: 'set_udf', udf: 'Note', activity: 'T1', value: 'hello' },
    { op: 'add_step', activity: 'T1', name: 'S1' }, { op: 'add_expense', activity: 'T1', name: 'Hire', budgeted_cost: 10 },
  ]);
  bad(db, [{ op: 'delete_eps', id: 'CIV' }], /holds 1 project/);
  bad(db, [{ op: 'update_assignment', activity: 'T1', resource: 'LAB', curve: 'Bell' }], /No resource curve "Bell"/);
  assert.equal(Number(rows(db, 'CALENDAR').find((c) => c.clndr_name === '6-Day')!.week_hr_cnt), 48);
  assert.equal(Number(rows(db, 'TASKRSRC')[0].target_qty), 60);
  ok(db, [{ op: 'delete_role', id: 'ENG' }, { op: 'delete_obs', name: 'PMO' }]);
  assert.equal(rows(db, 'OBS').length, 0);
  const out = writeXer(db, { version: '19.12' }) as string | Uint8Array;
  const back = parseXer(typeof out === 'string' ? new TextEncoder().encode(out) : out).db;
  for (const t of ['TASKACTV', 'UDFVALUE', 'TASKPROC', 'PROJCOST']) assert.equal(rows(back, t).length, 1, t);
});

test('ops: a full WBS path wins over a short name it shares with a child (1 and 1.1, the normal P6 shape)', () => {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'P2', start: '2026-03-02' },
    { op: 'add_wbs', code: '1', name: 'Sub' }, { op: 'add_wbs', code: '1', name: 'Piling', parent: '1' }, { op: 'add_wbs', code: '2', name: 'Super' },
    { op: 'add_wbs', code: '1', name: 'Bored', parent: '1.1' },
    { op: 'add_activity', id: 'T1', name: 'Top', wbs: '1', duration_days: 1 },
    { op: 'add_activity', id: 'T2', name: 'Child', wbs: '1.1', duration_days: 1 },
    { op: 'add_activity', id: 'T3', name: 'Grandchild', wbs: '1.1.1', duration_days: 1 },
  ]);
  const W = rows(db, 'PROJWBS');
  const nameOf = (task: string) => W.find((w) => w.wbs_id === rows(db, 'TASK').find((t) => t.task_code === task)!.wbs_id)!.wbs_name;
  assert.deepEqual(['T1', 'T2', 'T3'].map(nameOf), ['Sub', 'Piling', 'Bored']);
  bad(db, [{ op: 'add_activity', id: 'T4', name: 'x', wbs: 'nope' }], /No WBS/);
});

test('xer: a saved project carries no EPS table (P6 keeps the EPS in its database), and validates without findings', async () => {
  const db: Db = { tables: {} };
  ok(db, [{ op: 'add_project', id: 'P3', start: '2026-03-02' }, { op: 'add_eps', id: 'CIV', name: 'Civil' }, { op: 'set_project', eps: 'CIV' }, { op: 'add_activity', id: 'T1', name: 'One', duration_days: 2 }]);
  const out = writeXer(db, { version: '19.12' });
  const text = new TextDecoder().decode(out);
  assert.ok(!/^%T\tEPS/m.test(text));
  const { validateXer } = await import('../core/xer/validate.ts');
  const findings = validateXer(parseXer(out).db);
  assert.ok(!findings.some((f) => f.code === 'TABLE_UNKNOWN'), JSON.stringify(findings));
});

test('ops: remaining in hours, and costs entered on an assignment kept as entered (P6: the units/price link off)', () => {
  const db = base();
  ok(db, [{ op: 'update_activity', id: 'T1', remaining_hours: 27 }]);
  assert.equal(Number(rows(db, 'TASK').find((t) => t.task_code === 'T1')!.remain_drtn_hr_cnt), 27);
  ok(db, [{ op: 'update_assignment', activity: 'T1', resource: 'LAB', units: 40, budgeted_cost: 9000, actual_cost: 2500 }]);
  const a = rows(db, 'TASKRSRC')[0];
  assert.deepEqual([a.cost_qty_link_flag, Number(a.target_cost), Number(a.act_reg_cost), Number(a.remain_cost)], ['N', 9000, 2500, 6500]);
  ok(db, [{ op: 'add_activity', id: 'T9', name: 'Nine', duration_hours: 18 }, { op: 'assign_resource', activity: 'T9', resource: 'LAB', units: 18, actual_units: 6, budgeted_cost: 540 }]);
  const b = rows(db, 'TASKRSRC').find((x) => x.task_id === rows(db, 'TASK').find((t) => t.task_code === 'T9')!.task_id)!;
  assert.deepEqual([Number(b.act_reg_qty), Number(b.remain_qty), Number(b.target_cost)], [6, 12, 540]);
});

test('ops: build_baseline from given values; baselines go through XER as PROJECT rows with orig_proj_id', () => {
  const db = base();
  ok(db, [{ op: 'add_activity', id: 'T2', name: 'Two', wbs: 'B', duration_days: 3 }, { op: 'add_relationship', pred: 'T1', succ: 'T2' }, { op: 'add_expense', activity: 'T2', name: 'Fee', budgeted_cost: 50 }]);
  const r = applyOps(db, [{ op: 'build_baseline', name: 'P1 Contract', activities: [
    { activity: 'T1', start: '2026-02-02', finish: '2026-02-06 17:00', duration_days: 5, cost: 1200 },
    { activity: 'T2', start: '2026-02-09', finish: '2026-02-11 17:00', cost: 300 },
    { activity: 'GONE', start: '2026-02-09' },
  ] }]);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(r.results[0], { baseline: 'P1 Contract', of: 'P1', activities_set: 2, assigned_as: 'project' });
  assert.match(r.warnings![0], /activities\[2\] skipped: No activity "GONE"/);
  const check = (d: Db, label: string) => {
    const ctx = makeCtx(d, { hoursPerDay: 8 });
    const t1 = runTool('get_activity', { activity_id: 'T1' }, d, ctx, [], 8) as { baseline_start: string; baseline_finish: string };
    assert.deepEqual([t1.baseline_start, t1.baseline_finish], ['2026-02-02 00:00', '2026-02-06 17:00'], label);
    const ev = runTool('earned_value', {}, d, ctx, [], 8) as { projects: { has_baseline: boolean; totals: { bac: number } }[] };
    assert.deepEqual([ev.projects.length, ev.projects[0].has_baseline, ev.projects[0].totals.bac], [1, true, 1500], label);
    const dict = runTool('list_dictionaries', { only: 'baselines' }, d, ctx, [], 8) as { baselines: { project_baseline: string; saved: { name: string }[] }[] };
    assert.deepEqual([dict.baselines.length, dict.baselines[0].project_baseline, dict.baselines[0].saved.map((s) => s.name)], [1, 'P1 Contract', ['P1 Contract']], label);
  };
  check(db, 'in memory');
  const xer = writeXer(db, { version: '19.12' });
  const back = readRaw(xer, 'xer').db;
  const P = rows(back, 'PROJECT');
  const cur = P.find((p) => p.proj_short_name === 'P1')!, bl = P.find((p) => p.proj_short_name === 'P1 Contract')!;
  assert.deepEqual([bl.orig_proj_id, bl._baseline_of, cur.sum_base_proj_id, cur.orig_proj_id], [cur.proj_id, cur.proj_id, bl.proj_id, '']);
  check(back, 'after XER');
  // a baseline in a file written elsewhere (orig_proj_id) is a baseline, not a second project
  const tower = readRaw(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'Tower-A.xer'))), 'xer').db;
  assert.deepEqual(rows(tower, 'PROJECT').map((p) => [p.proj_short_name, p._baseline_of ?? '']), [['TOWER-A', ''], ['TOWER-A-BL1', '10']]);
  bad(db, [{ op: 'build_baseline', name: 'P1 Contract', activities: [] }], /already exists/);
});

test('ops: resource curves (21 buckets totalling 100) on assign_resource and update_assignment, kept in XER', () => {
  const db = base();
  const bell = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9, 8, 7, 5, 3, 2, 1, 0, 0];
  ok(db, [{ op: 'add_resource_curve', name: 'Bell', values: bell }, { op: 'add_resource_curve', name: 'Flat', values: Array(21).fill(100 / 21) },
    { op: 'add_activity', id: 'T2', name: 'Two', duration_days: 4 }, { op: 'assign_resource', activity: 'T2', resource: 'LAB', curve: 'bell' }]);
  const curv = (code: string) => rows(db, 'RSRCCURVDATA').find((c) => c.curv_id === rows(db, 'TASKRSRC').find((a) => a.task_id === rows(db, 'TASK').find((t) => t.task_code === code)!.task_id)!.curv_id)?.curv_name;
  assert.equal(curv('T2'), 'Bell');
  ok(db, [{ op: 'update_assignment', activity: 'T1', resource: 'LAB', curve: 'Flat' }]);
  assert.equal(curv('T1'), 'Flat');
  bad(db, [{ op: 'add_resource_curve', name: 'Short', values: [100] }], /21 percentages/);
  bad(db, [{ op: 'add_resource_curve', name: 'Over', values: bell.map((x) => x * 2) }], /total 200; P6 needs them to total 100/);
  bad(db, [{ op: 'add_resource_curve', name: 'bell', values: bell }], /already exists/);
  bad(db, [{ op: 'assign_resource', activity: 'T2', resource: 'LAB', curve: 'Nope' }], /already assigned|No resource curve/);
  const back = parseXer(writeXer(db, { version: '19.12' })).db;
  const b = rows(back, 'RSRCCURVDATA').find((c) => c.curv_name === 'Bell')!;
  assert.deepEqual(Array.from({ length: 21 }, (_, i) => Number(b[`pct_usage_${i}`])), bell);
  assert.equal(rows(back, 'TASKRSRC').filter((a) => a.curv_id === b.curv_id).length, 1);
});

test('ops: WBS elements addressed by wbs_id (returned by add_wbs); siblings with one code are refused as in P6', () => {
  const db = base();
  ok(db, [{ op: 'add_project', id: 'P2', start: '2026-03-02' }]);
  const [x, y] = ok(db, [{ op: 'add_wbs', project: 'P1', code: 'L1', parent: 'A' }, { op: 'add_wbs', project: 'P1', code: 'L1', parent: 'B' }]) as { wbs: string; wbs_id: string }[];
  bad(db, [{ op: 'add_wbs', project: 'P1', code: 'L1', parent: 'A' }], /WBS "L1" already exists there/);
  assert.ok(x.wbs_id && y.wbs_id && x.wbs_id !== y.wbs_id);
  // no "project" needed: the wbs_id says which project; the short name "L1" alone would be ambiguous
  ok(db, [{ op: 'add_activity', id: 'X1', name: 'In A/L1', wbs: `wbs_id:${x.wbs_id}` }, { op: 'add_activity', id: 'Y1', name: 'In B/L1', wbs: `wbs_id:${y.wbs_id}` },
    { op: 'add_wbs', code: 'L2', parent: `wbs_id:${y.wbs_id}` }, { op: 'update_wbs', code: `wbs_id:${x.wbs_id}`, name: 'Renamed' }]);
  const t = (c: string) => rows(db, 'TASK').find((r) => r.task_code === c)!;
  assert.deepEqual([t('X1').wbs_id, t('Y1').wbs_id], [x.wbs_id, y.wbs_id]);
  ok(db, [{ op: 'update_activity', project: 'P1', id: 'X1', wbs: `wbs_id:${y.wbs_id}` }]);
  assert.equal(t('X1').wbs_id, y.wbs_id);
  assert.equal(rows(db, 'PROJWBS').find((w) => w.wbs_id === x.wbs_id)!.wbs_name, 'Renamed');
  bad(db, [{ op: 'add_activity', name: 'Z', wbs: 'wbs_id:999999' }], /Several projects|No WBS element with wbs_id 999999/);
  const list = runTool('list_wbs', { project: 'P1', depth: 3 }, db, makeCtx(db, { hoursPerDay: 8 }), [], 8) as { wbs: { code: string; wbs_id: string }[] };
  assert.ok(list.wbs.some((w) => w.code === 'B.L1' && w.wbs_id === y.wbs_id));
});

test('ops: days are hours of the activity\'s own calendar (lags: the predecessor\'s); max_units_per_hour', () => {
  const db = base();
  ok(db, [{ op: 'add_calendar', name: 'Ten', work_week: { mon: [['07:00', '17:00']], tue: [['07:00', '17:00']], wed: [['07:00', '17:00']], thu: [['07:00', '17:00']], fri: [['07:00', '17:00']] } },
    { op: 'add_activity', id: 'T10', name: 'Ten-hour', calendar: 'Ten', duration_days: 2 },
    { op: 'add_relationship', pred: 'T10', succ: 'T1', lag_days: 1 },
    { op: 'add_resource', id: 'CR', max_units_per_hour: 0.5 }]);
  const t = (c: string) => rows(db, 'TASK').find((r) => r.task_code === c)!;
  assert.equal(t('T10').target_drtn_hr_cnt, '20');
  assert.equal(rows(db, 'TASKPRED')[0].lag_hr_cnt, '10');
  ok(db, [{ op: 'update_activity', id: 'T1', calendar: 'Ten', duration_days: 3, }, { op: 'update_activity', id: 'T10', remaining_days: 1 }]);
  assert.deepEqual([t('T1').target_drtn_hr_cnt, t('T10').remain_drtn_hr_cnt], ['30', '10']);
  ok(db, [{ op: 'set_estimates', activity: 'T10', min_days: 1, max_days: 3 }]);
  assert.deepEqual([getEstimates(db).get(t('T10').task_id)!.min, getEstimates(db).get(t('T10').task_id)!.max], [10, 30]);
  // an 8-hour calendar is unchanged
  ok(db, [{ op: 'add_activity', id: 'T8', name: 'Eight', duration_days: 2 }]);
  assert.equal(t('T8').target_drtn_hr_cnt, '16');
  const cr = rows(db, 'RSRC').find((r) => r.rsrc_short_name === 'CR')!;
  assert.equal(rows(db, 'RSRCRATE').find((r) => r.rsrc_id === cr.rsrc_id)!.max_qty_per_hr, '0.5');
});
