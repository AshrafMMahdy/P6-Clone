import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { runTool } from '../core/query/tools.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { getEstimates } from '../core/risk/montecarlo.ts';

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
