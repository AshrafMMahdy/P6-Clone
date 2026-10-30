// Assignments as P6 has them: the same resource on an activity more than once (named by nth), role assignments with no
// resource (assign_role, assigned_role), removal taking what hangs on an assignment with it (UDF values, period
// actuals, assignment codes, the primary resource), indicator UDFs, and the Excel round trip of all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, table, type Db } from '../core/db.ts';
import { applyImport, exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const fail = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, false); return r.error!.message; };

function build(): Db {
  const db = { tables: {} } as Db;
  ok(db, [
    { op: 'add_project', id: 'P', start: '2026-01-05' },
    { op: 'add_resource', id: 'LAB', price_per_unit: 10 }, { op: 'add_role', id: 'ENG', name: 'Engineer' },
    { op: 'add_activity', id: 'A', name: 'Pour', duration_days: 10 },
    { op: 'assign_resource', activity: 'A', resource: 'LAB', units: 40 },
    { op: 'assign_resource', activity: 'A', resource: 'LAB', units: 20, allow_duplicate: true },
    { op: 'assign_role', activity: 'A', role: 'ENG', units: 8 },
  ]);
  return db;
}
const asg = (db: Db) => rows(db, 'TASKRSRC').map((a) => [a.rsrc_id ? 'LAB' : 'ENG', Number(a.target_qty)]);

test('the same resource twice: nth names one; without it, refused; a role assignment by assigned_role', () => {
  const db = build();
  assert.deepEqual(asg(db), [['LAB', 40], ['LAB', 20], ['ENG', 8]]);
  assert.match(fail(db, [{ op: 'update_assignment', activity: 'A', resource: 'LAB', units: 5 }]), /assigned to A 2 times; give nth/);
  ok(db, [{ op: 'update_assignment', activity: 'A', resource: 'LAB', nth: 2, units: 25 }, { op: 'update_assignment', activity: 'A', assigned_role: 'ENG', units: 16 }]);
  assert.deepEqual(asg(db), [['LAB', 40], ['LAB', 25], ['ENG', 16]]);
  assert.match(fail(db, [{ op: 'update_assignment', activity: 'A', resource: 'LAB', nth: 3, units: 1 }]), /nth 3 is not one of them/);
  // a role assignment is priced by the role's rate
  ok(db, [{ op: 'add_row', table: 'ROLERATE', fields: { role_id: rows(db, 'ROLES')[0].role_id, cost_per_qty: 50 } }, { op: 'update_assignment', activity: 'A', assigned_role: 'ENG', units: 10 }]);
  assert.equal(Number(rows(db, 'TASKRSRC').find((a) => !a.rsrc_id)!.target_cost), 500);
  ok(db, [{ op: 'unassign_resource', activity: 'A', resource: 'LAB', nth: 1 }, { op: 'unassign_resource', activity: 'A', assigned_role: 'ENG' }]);
  assert.deepEqual(asg(db), [['LAB', 25]]);
});

test('removing an assignment takes its UDF values, period actuals, codes and primary resource with it', () => {
  const db = build();
  ok(db, [
    { op: 'unassign_resource', activity: 'A', resource: 'LAB', nth: 2 },
    { op: 'add_udf', name: 'Crew', subject: 'assignment' },
    { op: 'set_udf', activity: 'A', resource: 'LAB', udf: 'Crew', value: 'C1' },
    { op: 'update_activity', id: 'A', primary_resource: 'LAB' },
  ]);
  table(db, 'TRSRCFIN').rows.push({ fin_dates_id: '1', taskrsrc_id: rows(db, 'TASKRSRC')[0].taskrsrc_id, task_id: rows(db, 'TASK')[0].task_id, proj_id: rows(db, 'PROJECT')[0].proj_id, act_qty: '5', act_cost: '50' });
  assert.equal(rows(db, 'UDFVALUE').length, 1);
  ok(db, [{ op: 'delete_resource', id: 'LAB', clear_references: true }]);
  assert.equal(rows(db, 'UDFVALUE').length, 0, 'the assignment UDF value went with it');
  assert.equal(rows(db, 'TRSRCFIN').length, 0, 'its period actuals too');
  assert.equal(rows(db, 'TASK')[0].rsrc_id, '', 'the primary resource is cleared');
});

test('indicator UDF: P6 icon codes only', () => {
  const db = build();
  ok(db, [{ op: 'add_udf', name: 'Status light' }, { op: 'set_fields', table: 'UDFTYPE', where: { udf_type_label: 'Status light' }, fields: { logical_data_type: 'FT_STATICTYPE' } }]);
  ok(db, [{ op: 'set_udf', activity: 'A', udf: 'Status light', value: 'udf_g3' }]);
  assert.equal(rows(db, 'UDFVALUE')[0].udf_text, 'UDF_G3');
  assert.match(fail(db, [{ op: 'set_udf', activity: 'A', udf: 'Status light', value: 'red' }]), /icon codes UDF_G0 to UDF_G4/);
});

test('Excel: duplicates, role assignments and indicator UDFs round-trip; edits reach the right assignment', async () => {
  const db = build();
  ok(db, [{ op: 'add_udf', name: 'Light' }, { op: 'set_fields', table: 'UDFTYPE', where: { udf_type_label: 'Light' }, fields: { logical_data_type: 'FT_STATICTYPE' } }, { op: 'set_udf', activity: 'A', udf: 'Light', value: 'UDF_G2' }]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, [pid], 8, false, { columns: { TASK: ['*'], TASKRSRC: ['*'] } })));
  const same = planImport(db, sheets, 'P');
  assert.equal(same.ops.length, 0, JSON.stringify(same.ops).slice(0, 400));
  // second LAB row's units, the role row's units, the indicator, and one more LAB row added
  const T = sheets.find((s) => s.name === 'TASKRSRC')!, head = T.rows[0].map(String), at = (f: string) => head.indexOf(f);
  const data = T.rows.slice(2);
  const lab2 = data.filter((r) => r[at('rsrc_id')] === 'LAB')[1], eng = data.find((r) => !r[at('rsrc_id')])!;
  lab2[at('target_qty')] = 30; eng[at('target_qty')] = 12;
  const extra = [...lab2]; extra[at('target_qty')] = 7; T.rows.push(extra);
  const TS = sheets.find((s) => s.name === 'TASK')!, th = TS.rows[0].map(String);
  TS.rows[2][th.findIndex((f) => f.startsWith('user_field_'))] = 'UDF_G4';
  const plan = planImport(db, sheets, 'P');
  const res = applyImport(db, plan, { calendarDays: true });
  assert.deepEqual(res.refused, []);
  assert.deepEqual(asg(db), [['LAB', 40], ['LAB', 30], ['ENG', 12], ['LAB', 7]]);
  assert.equal(rows(db, 'UDFVALUE').find((v) => v.udf_text.startsWith('UDF_G'))!.udf_text, 'UDF_G4');
});
