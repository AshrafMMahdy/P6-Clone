// Review of 790c700..8b33035 (select, financial periods, Excel, assignments): each test failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, expandSelects } from '../core/project/ops.ts';
import { parseXer } from '../core/xer/parse.ts';
import { importIntoDb, defaultPlan } from '../core/xer/import.ts';
import { rows, type Db } from '../core/db.ts';
import { lobGuard } from '../core/lob/view.ts';
import { LOB_UDF } from '../core/lob/expand.ts';
import { SAMPLES_DIR } from './helpers.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const small = (n: number): Db => {
  const db = { tables: {} } as Db;
  ok(db, [{ op: 'add_project', id: 'P', start: '2026-01-05' }, { op: 'add_wbs', code: 'W' }, ...Array.from({ length: n }, (_, i) => ({ op: 'add_activity', id: `A${1000 + i}`, name: `Act ${i}`, wbs: 'W', duration_days: 5 }))]);
  return db;
};

test('select by an indicator UDF reads its icon code (udf_text); empty: true no longer picks the activities that have one', () => {
  const db = small(4);
  ok(db, [{ op: 'add_udf', name: 'Flag' }]);
  rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Flag')!.logical_data_type = 'FT_STATICTYPE'; // an indicator UDF, as P6 files and the Excel import hold
  ok(db, [{ op: 'set_udf', udf: 'Flag', activity: 'A1000', value: 'UDF_G1' }, { op: 'set_udf', udf: 'Flag', activity: 'A1001', value: 'UDF_G3' }]);
  const r = ok(db, [{ op: 'update_activity', priority: 'high', select: { udf: { udf: 'Flag', value: 'udf_g1' } } }]);
  assert.equal((r.results[0] as any).selected, 1);
  // a delete of the activities without a flag must not take the flagged ones
  const d = ok(db, [{ op: 'delete_activity', select: { udf: { udf: 'Flag', empty: true } } }]);
  assert.equal((d.results[0] as any).deleted, 2);
  assert.deepEqual(rows(db, 'TASK').map((t) => t.task_code).sort(), ['A1000', 'A1001']);
});

test('select over 6,000 activities: add_expense, add_step, update_step and unassign_resource stay linear (they were quadratic: 100 s+ on 11,000)', () => {
  const db = small(6000);
  ok(db, [{ op: 'add_resource', id: 'LAB' }, { op: 'assign_resource', resource: 'LAB', units: 8, select: {} }]);
  const time = (ops: unknown[]) => { const s = performance.now(); ok(db, ops); return performance.now() - s; };
  const ms = {
    add_expense: time([{ op: 'add_expense', name: 'E', budgeted_cost: 10, select: {} }]),
    update_expense: time([{ op: 'update_expense', name: 'E', budgeted_cost: 20, select: {} }]),
    add_step: time([{ op: 'add_step', name: 'S', select: {} }]),
    update_step: time([{ op: 'update_step', name: 'S', weight: 2, select: {} }]),
    update_activity: time([{ op: 'update_activity', duration_days: 3, select: {} }]),
    unassign_resource: time([{ op: 'unassign_resource', resource: 'LAB', select: {} }]),
  };
  assert.equal(rows(db, 'PROJCOST').length, 6000);
  assert.equal(new Set(rows(db, 'TASKPROC').map((s) => s.proc_id)).size, 6000, 'step ids unique');
  assert.equal(rows(db, 'TASKRSRC').length, 0);
  for (const [k, v] of Object.entries(ms)) assert.ok(v < 8000, `${k}: ${Math.round(v)} ms`);
});

test('the MCP LOB guard sees through select, link_activities and renumber_activities', () => {
  const db = small(3);
  ok(db, [{ op: 'add_udf', name: LOB_UDF.task, data_type: 'text' }, { op: 'set_udf', udf: LOB_UDF.task, activity: 'A1001', value: 'CS' }]);
  const guard = (ops: unknown[]) => lobGuard(db, expandSelects(db, ops));
  assert.match(String(guard([{ op: 'update_activity', duration_days: 2, select: {} }])), /A1001 is set by the LOB plan/);
  assert.match(String(guard([{ op: 'delete_activity', select: { ids: ['A1001'] } }])), /set by the LOB plan/);
  assert.match(String(guard([{ op: 'renumber_activities', prefix: 'Z', select: {} }])), /set by the LOB plan/);
  assert.equal(guard([{ op: 'update_activity', duration_days: 2, select: { ids: ['A1000', 'A1002'] } }]), null, 'the others are free');
  assert.equal(guard([{ op: 'update_activity', notes: 'x', select: { wbs: 'NOPE' } }]), null, 'a select the edit refuses is left to the edit');
});

test('store_period_performance and set_period_actuals agree on a role assignment (labor): editing one assignment does not move the activity by the role\'s units', () => {
  const db = { tables: {} } as Db;
  ok(db, [
    { op: 'add_project', id: 'P', start: '2026-01-05' }, { op: 'add_resource', id: 'LAB', type: 'labor' }, { op: 'add_role', id: 'ENG', name: 'Engineer' },
    { op: 'add_activity', id: 'A', name: 'Dig', duration_days: 20 },
    { op: 'assign_resource', activity: 'A', resource: 'LAB', units: 160 }, { op: 'assign_role', activity: 'A', role: 'ENG', units: 80 },
    { op: 'set_fields', table: 'PROJECT', where: { proj_short_name: 'P' }, fields: { act_this_per_link_flag: 'Y' } },
    { op: 'update_activity', id: 'A', actual_start: '2026-01-05' },
    { op: 'update_assignment', activity: 'A', resource: 'LAB', actual_units: 40 }, { op: 'update_assignment', activity: 'A', assigned_role: 'ENG', actual_units: 10 },
    { op: 'add_financial_periods', from: '2026-01-01', to: '2026-01-31' },
  ]);
  ok(db, [{ op: 'store_period_performance', period: '2026-01-01' }]);
  const tf = () => rows(db, 'TASKFIN')[0];
  assert.equal(Number(tf().act_work_qty), 50, 'the role assignment\'s actual units are labor units of the period');
  ok(db, [{ op: 'set_period_actuals', activity: 'A', resource: 'LAB', period: '2026-01-01', values: { units: 40 } }]);
  assert.equal(Number(tf().act_work_qty), 50, 'the same value set again changes nothing');
});

test('periods from a file without calendars stay with their calendar when another calendar becomes the default', () => {
  const db = { tables: {} } as Db;
  ok(db, [{ op: 'add_project', id: 'GC', start: '2007-01-01' }, { op: 'add_financial_period_calendar', name: 'Monthly' }]);
  // a P6 file from before calendars (FINDATES with no fintmpl_id), imported into it
  const src = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo alex-road.xer')))).db;
  const { projIds: [pid] } = importIntoDb(db, src, defaultPlan(src));
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid)!;
  const monthly = rows(db, 'FINTMPL')[0].fintmpl_id;
  assert.equal(p.fintmpl_id, monthly);
  ok(db, [{ op: 'add_financial_period_calendar', name: 'Weekly', default: true }]);
  assert.ok(rows(db, 'FINDATES').length > 0 && rows(db, 'FINDATES').every((f) => f.fintmpl_id === monthly), 'the imported periods are still Monthly\'s');
  // and a period without a calendar of its own made by hand: kept by the old default too
  rows(db, 'FINDATES').push({ fin_dates_id: '99999', fin_dates_name: 'loose', start_date: '2030-01-01 00:00', end_date: '2030-01-31 00:00', fintmpl_id: '' });
  ok(db, [{ op: 'update_financial_period_calendar', name: 'Monthly', default: true }]);
  assert.equal(rows(db, 'FINDATES').find((f) => f.fin_dates_name === 'loose')!.fintmpl_id, rows(db, 'FINTMPL').find((c) => c.fintmpl_name === 'Weekly')!.fintmpl_id);
});
