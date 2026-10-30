import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { rows } from '../core/db.ts';
import { readXlsx, writeXlsx, unzip } from '../core/excel/xlsx.ts';
import { applyImport, exportSheets, planImport, templateColumns } from '../core/excel/p6sheets.ts';
import { applyOps } from '../core/project/ops.ts';
import { SAMPLES_DIR } from './helpers.ts';

const load = () => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;

test('xlsx round trip keeps text, numbers, dates and unicode; the file is a valid zip workbook', async () => {
  const bytes = await writeXlsx([{ name: 'S1', rows: [['a', 1.5, new Date(Date.UTC(2027, 2, 1, 8, 0))], [null, 'Tower «A» & <B>', 'مبنى']], boldRows: 1 }]);
  const files = await unzip(bytes);
  assert.ok(files.has('xl/workbook.xml') && files.has('xl/worksheets/sheet1.xml') && files.has('[Content_Types].xml'));
  const [s] = await readXlsx(bytes);
  assert.equal(s.name, 'S1');
  assert.equal(s.rows[0][0], 'a'); assert.equal(s.rows[0][1], 1.5);
  assert.equal((s.rows[0][2] as Date).toISOString(), '2027-03-01T08:00:00.000Z');
  assert.equal(s.rows[1][1], 'Tower «A» & <B>'); assert.equal(s.rows[1][2], 'مبنى');
});

test('P6-style export re-imported unchanged plans nothing; edits become exactly the matching operations', async () => {
  const db = load();
  const p = rows(db, 'PROJECT')[0];
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, [p.proj_id])));
  assert.deepEqual(sheets.map((s) => s.name), ['TASK', 'TASKPRED', 'PROJCOST', 'RSRC', 'TASKRSRC', 'USERDATA']);
  const task = sheets[0];
  assert.equal(task.rows[0][1], 'task_code'); assert.equal(task.rows[1][1], 'Activity ID');
  assert.equal(task.rows.length - 2, rows(db, 'TASK').length);
  const none = planImport(db, sheets, p.proj_short_name);
  assert.deepEqual(none.warnings, []);
  assert.equal(none.ops.length, 0, JSON.stringify(none.ops.slice(0, 3)));
  // edit: a duration, a new activity, a deleted activity, a new relationship
  const col = (f: string) => task.rows[0].indexOf(f);
  const a2410 = task.rows.find((r) => r[col('task_code')] === 'A2410')!;
  a2410[col('target_drtn_hr_cnt')] = 30;
  const victim = task.rows.find((r) => r[col('task_code')] === 'A1320')!;
  victim[col('delete_record_flag')] = 'Y';
  const fresh = Array(task.rows[0].length).fill(null); fresh[col('task_code')] = 'X9000'; fresh[col('task_name')] = 'Added in Excel'; fresh[col('target_drtn_hr_cnt')] = 4;
  task.rows.push(fresh);
  sheets[1].rows.push([null, 'A2410', null, 'X9000', 'SS', 2, null]);
  const plan = planImport(db, sheets, p.proj_short_name);
  assert.deepEqual(plan.summary, { activitiesAdded: 1, activitiesUpdated: 1, activitiesDeleted: 1, relationshipsAdded: 1, relationshipsUpdated: 0, relationshipsDeleted: 0, expensesAdded: 0, expensesUpdated: 0, expensesDeleted: 0, resourcesAdded: 0, resourcesUpdated: 0, assignmentsAdded: 0, assignmentsUpdated: 0, assignmentsDeleted: 0, unchanged: plan.summary.unchanged });
  const r = applyOps(db, plan.ops);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const t = new Map(rows(db, 'TASK').map((x) => [x.task_code, x]));
  assert.equal(Number(t.get('A2410')!.target_drtn_hr_cnt), 240);
  assert.ok(t.has('X9000') && !t.has('A1320'));
  assert.ok(rows(db, 'TASKPRED').some((x) => x.pred_task_id === t.get('A2410')!.task_id && x.task_id === t.get('X9000')!.task_id && x.pred_type === 'PR_SS' && Number(x.lag_hr_cnt) === 16));
});

/** The sample with what P6's spreadsheet carries beyond the basics: an activity code, UDFs on activities, resources,
 *  assignments and expenses, an expense, a role, a cost account, an assignment code. */
function rich() {
  const db = load();
  const P = rows(db, 'PROJECT')[0].proj_short_name;
  const asg = rows(db, 'TASKRSRC')[0], res = rows(db, 'RSRC').find((x) => x.rsrc_id === asg.rsrc_id)!.rsrc_short_name, act = rows(db, 'TASK').find((t) => t.task_id === asg.task_id)!.task_code;
  const r = applyOps(db, [
    { op: 'add_code_type', name: 'Zone', values: [{ code: 'N' }, { code: 'S' }] },
    { op: 'assign_code', type: 'Zone', value: 'N', activity: 'A2410' },
    { op: 'add_udf', name: 'Package', subject: 'activity' }, { op: 'set_udf', udf: 'Package', value: 'P-01', activity: 'A2410' },
    { op: 'add_udf', name: 'Weight', subject: 'activity', data_type: 'number' }, { op: 'set_udf', udf: 'Weight', value: 2.5, activity: 'A2410' },
    { op: 'add_udf', name: 'Trade', subject: 'resource' }, { op: 'set_udf', udf: 'Trade', value: 'Civil', resource: res },
    { op: 'add_udf', name: 'Crew note', subject: 'assignment' }, { op: 'set_udf', udf: 'Crew note', value: 'night', activity: act, resource: res },
    { op: 'add_udf', name: 'PO date', subject: 'expense', data_type: 'date' },
    { op: 'add_cost_account', id: 'CA1' }, { op: 'add_role', id: 'ENG', name: 'Engineer' },
    { op: 'add_expense', activity: 'A2410', name: 'Crane hire', budgeted_cost: 1000, account: 'CA1', unit_of_measure: 'day', vendor: 'Lift Co' },
    { op: 'set_udf', udf: 'PO date', value: '2027-01-04', activity: 'A2410', expense: 'Crane hire' },
    { op: 'add_code_type', name: 'Shift', subject: 'assignment', values: [{ code: 'DAY' }, { code: 'NIGHT' }] },
    { op: 'assign_code', type: 'Shift', value: 'DAY', activity: act, resource: res },
    { op: 'add_code_type', name: 'Craft', subject: 'resource', values: [{ code: 'C1' }, { code: 'C2' }] },
    { op: 'assign_code', type: 'Craft', value: 'C1', resource: res },
  ]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  return { db, P, res, act };
}
const ALL = { TASK: ['*'], TASKPRED: ['*'], PROJCOST: ['*'], RSRC: ['*'], TASKRSRC: ['*'] };
const col = (sh: { rows: unknown[][] }, f: string) => sh.rows[0].indexOf(f);

test('every column of every sheet (codes, UDFs, expenses, assignment codes) re-imported unchanged plans nothing', async () => {
  const { db } = rich();
  const ids = [rows(db, 'PROJECT')[0].proj_id];
  const t = templateColumns(db, ids, { columns: ALL });
  assert.deepEqual(t.unknown, []);
  const fields = (s: string) => t.columns[s as 'TASK']!.map((c) => c.field);
  const zone = rows(db, 'ACTVTYPE').find((x) => x.actv_code_type === 'Zone')!;
  assert.ok(fields('TASK').includes(`actv_code_${zone.actv_code_type_id}_id`) && fields('TASK').some((f) => f.startsWith('user_field_')));
  assert.ok(fields('TASKRSRC').some((f) => f.startsWith('asgnmnt_catg_')) && fields('RSRC').some((f) => f.startsWith('rsrc_catg_')) && fields('PROJCOST').some((f) => f.startsWith('user_field_')));
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, ids, 8, false, { columns: ALL })));
  const task = sheets.find((s) => s.name === 'TASK')!;
  assert.equal(task.rows[1][col(task, 'start_date')], '(*)Start', 'a calculated column is marked as P6 marks it');
  assert.equal(task.rows[1][col(task, `actv_code_${zone.actv_code_type_id}_id`)], 'Zone');
  assert.equal(task.rows.find((r) => r[col(task, 'task_code')] === 'A2410')![col(task, `actv_code_${zone.actv_code_type_id}_id`)], 'N');
  const plan = planImport(db, sheets, rows(db, 'PROJECT')[0].proj_short_name);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.ops, [], JSON.stringify(plan.ops.slice(0, 4)));
});

test('import updates codes, UDFs, status, % type, expenses, resources and assignments as P6 does', async () => {
  const { db, P, res, act } = rich();
  const ids = [rows(db, 'PROJECT')[0].proj_id];
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, ids, 8, false, { columns: ALL })));
  const sh = (n: string) => sheets.find((s) => s.name === n)!;
  const set = (n: string, find: (r: unknown[]) => boolean, f: string, v: unknown) => { const s = sh(n); const r = s.rows.find((x, i) => i > 1 && find(x)); assert.ok(r, `${n} row`); r![col(s, f)] = v as never; };
  const T = sh('TASK'), code = (r: unknown[]) => r[col(T, 'task_code')] === 'A2410';
  const zone = rows(db, 'ACTVTYPE').find((x) => x.actv_code_type === 'Zone')!.actv_code_type_id;
  const pkg = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Package')!.udf_type_id;
  set('TASK', code, `actv_code_${zone}_id`, 'S');
  set('TASK', code, `user_field_${pkg}`, 'P-02');
  set('TASK', code, 'complete_pct_type', 'Physical');
  set('TASK', code, 'cstr_type2', 'Finish On or Before'); set('TASK', code, 'cstr_date2', '2027-06-30');
  set('TASK', (r) => r[col(T, 'task_code')] === 'A2060', 'status_code', 'In Progress');
  set('PROJCOST', (r) => r[col(sh('PROJCOST'), 'cost_name')] === 'Crane hire', 'act_cost', 400);
  sh('PROJCOST').rows.push(Object.assign(Array(sh('PROJCOST').rows[0].length).fill(null), { [col(sh('PROJCOST'), 'task_id')]: 'A2060', [col(sh('PROJCOST'), 'cost_name')]: 'Scaffold', [col(sh('PROJCOST'), 'target_cost')]: 250 }));
  const R = sh('RSRC'), isRes = (r: unknown[]) => r[col(R, 'rsrc_short_name')] === res;
  const craft = rows(db, 'RCATTYPE').find((x) => x.rsrc_catg_type === 'Craft')!.rsrc_catg_type_id;
  set('RSRC', isRes, 'email_addr', 'crew@site.test'); set('RSRC', isRes, 'rsrc_name', 'Renamed crew'); set('RSRC', isRes, `rsrc_catg_${craft}_id`, 'C2'); set('RSRC', isRes, 'role_id', 'ENG');
  const A = sh('TASKRSRC'), isAsg = (r: unknown[]) => r[col(A, 'task_id')] === act && r[col(A, 'rsrc_id')] === res;
  const shift = rows(db, 'ASGNMNTCATTYPE').find((x) => x.asgnmnt_catg_type === 'Shift')!.asgnmnt_catg_type_id;
  set('TASKRSRC', isAsg, 'target_qty', 77); set('TASKRSRC', isAsg, 'role_id', 'ENG'); set('TASKRSRC', isAsg, 'acct_id', 'CA1'); set('TASKRSRC', isAsg, `asgnmnt_catg_${shift}_id`, 'NIGHT');
  const plan = planImport(db, sheets, P);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual([plan.summary.activitiesUpdated, plan.summary.expensesAdded, plan.summary.expensesUpdated, plan.summary.resourcesUpdated, plan.summary.assignmentsUpdated], [2, 1, 1, 1, 1]);
  const r = applyImport(db, plan);
  assert.deepEqual(r.refused, []);
  const t = rows(db, 'TASK').find((x) => x.task_code === 'A2410')!;
  const val = (type: string, fk: string, link: string, fkF: string, tF: string, vT: string, vF: string, sF: string) => { const l = rows(db, link).find((x) => x[fkF] === fk && x[tF] === type)!; return rows(db, vT).find((v) => v[vF] === l[vF])![sF]; };
  assert.equal(val(zone, t.task_id, 'TASKACTV', 'task_id', 'actv_code_type_id', 'ACTVCODE', 'actv_code_id', 'short_name'), 'S');
  assert.equal(rows(db, 'UDFVALUE').find((v) => v.udf_type_id === pkg && v.fk_id === t.task_id)!.udf_text, 'P-02');
  assert.deepEqual([t.complete_pct_type, t.cstr_type2, t.cstr_date2.slice(0, 10)], ['CP_Phys', 'CS_MEOB', '2027-06-30']);
  const started = rows(db, 'TASK').find((x) => x.task_code === 'A2060')!;
  assert.equal(started.status_code, 'TK_Active', 'In Progress with no actual date: the Start becomes the actual start');
  assert.ok(started.act_start_date);
  const costs = rows(db, 'PROJCOST');
  assert.equal(Number(costs.find((c) => c.cost_name === 'Crane hire')!.act_cost), 400);
  assert.equal(Number(costs.find((c) => c.cost_name === 'Scaffold')!.target_cost), 250);
  const rr = rows(db, 'RSRC').find((x) => x.rsrc_short_name === res)!;
  assert.deepEqual([rr.email_addr, rr.rsrc_name, rows(db, 'ROLES').find((x) => x.role_id === rr.role_id)?.role_short_name], ['crew@site.test', 'Renamed crew', 'ENG']);
  assert.equal(val(craft, rr.rsrc_id, 'RSRCRCAT', 'rsrc_id', 'rsrc_catg_type_id', 'RCATVAL', 'rsrc_catg_id', 'rsrc_catg_short_name'), 'C2');
  const a = rows(db, 'TASKRSRC').find((x) => x.rsrc_id === rr.rsrc_id && rows(db, 'TASK').find((y) => y.task_id === x.task_id)!.task_code === act)!;
  assert.equal(Number(a.target_qty), 77);
  assert.equal(rows(db, 'ROLES').find((x) => x.role_id === a.role_id)?.role_short_name, 'ENG');
  assert.equal(rows(db, 'ACCOUNT').find((x) => x.acct_id === a.acct_id)?.acct_short_name, 'CA1');
  assert.equal(val(shift, a.taskrsrc_id, 'ASGNMNTACAT', 'taskrsrc_id', 'asgnmnt_catg_type_id', 'ASGNMNTCATVAL', 'asgnmnt_catg_id', 'asgnmnt_catg_short_name'), 'NIGHT');
  // and the workbook of the result re-imports as nothing to change
  const again = await readXlsx(await writeXlsx(exportSheets(db, ids, 8, false, { columns: ALL })));
  assert.deepEqual(planImport(db, again, P).ops, []);
});

test('a row P6 would refuse is skipped and logged; the rest is applied in one step', async () => {
  const db = load();
  const P = rows(db, 'PROJECT')[0].proj_short_name;
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, [rows(db, 'PROJECT')[0].proj_id])));
  const T = sheets[0];
  T.rows.find((r) => r[col(T, 'task_code')] === 'A1320')![col(T, 'target_drtn_hr_cnt')] = 5; // a milestone given a duration
  T.rows.find((r) => r[col(T, 'task_code')] === 'A2410')![col(T, 'target_drtn_hr_cnt')] = 31;
  const fresh = Array(T.rows[0].length).fill(null); fresh[col(T, 'task_code')] = 'X1'; fresh[col(T, 'task_name')] = 'Added'; fresh[col(T, 'target_drtn_hr_cnt')] = 2;
  T.rows.push(fresh);
  sheets[1].rows.push([null, 'A1320', null, 'X1', 'FS', 0, null], [null, 'X1', null, 'NOPE', 'FS', 0, null]);
  const plan = planImport(db, sheets, P);
  const r = applyImport(db, plan);
  assert.equal(r.refused.length, 2, JSON.stringify(r.refused));
  assert.deepEqual(r.refused.map((x) => [x.sheet, x.row]), [['TASK', T.rows.findIndex((x) => x[col(T, 'task_code')] === 'A1320') + 1], ['TASKPRED', sheets[1].rows.length]]);
  assert.match(r.refused[0].message, /milestone/i);
  const t = new Map(rows(db, 'TASK').map((x) => [x.task_code, x]));
  assert.equal(Number(t.get('A2410')!.target_drtn_hr_cnt), 248);
  assert.equal(Number(t.get('A1320')!.target_drtn_hr_cnt), 0);
  assert.ok(t.has('X1') && rows(db, 'TASKPRED').some((p) => p.pred_task_id === t.get('A1320')!.task_id && p.task_id === t.get('X1')!.task_id));
});

test('a template picks sheets and columns; P6\'s required columns stay; unknown names are reported', () => {
  const { db } = rich();
  const ids = [rows(db, 'PROJECT')[0].proj_id];
  const t = templateColumns(db, ids, { sheets: ['TASK', 'Expenses', 'NOPE'], columns: { TASK: ['task_name', 'user_field_*', 'bogus'] } });
  assert.deepEqual(Object.keys(t.columns), ['TASK', 'PROJCOST']);
  assert.deepEqual(t.unknown, ['NOPE', 'TASK.bogus']);
  const f = t.columns.TASK!.map((c) => c.field);
  for (const req of ['proj_id', 'task_code', 'status_code', 'wbs_id', 'delete_record_flag']) assert.ok(f.includes(req), req);
  assert.ok(f.includes('task_name') && f.filter((x) => x.startsWith('user_field_')).length === 2 && !f.includes('target_drtn_hr_cnt'));
  const sheets = exportSheets(db, ids, 8, false, { sheets: ['TASK', 'Expenses'], columns: { TASK: ['task_name'] } });
  assert.deepEqual(sheets.map((s) => s.name), ['TASK', 'PROJCOST', 'USERDATA']);
  // a workbook the clone wrote before act_qty: Actual Units read from act_reg_qty
  const old = [{ name: 'TASKRSRC', rows: [['task_id', 'rsrc_id', 'act_reg_qty'], ['Activity ID', 'Resource ID', 'Actual Units'], [rows(db, 'TASK').find((x) => x.task_id === rows(db, 'TASKRSRC')[0].task_id)!.task_code, rows(db, 'RSRC').find((x) => x.rsrc_id === rows(db, 'TASKRSRC')[0].rsrc_id)!.rsrc_short_name, 3]] }];
  const plan = planImport(db, old, rows(db, 'PROJECT')[0].proj_short_name);
  assert.equal(plan.ops.find((o) => o.op === 'update_assignment')?.actual_units, 3 - Number(rows(db, 'TASKRSRC')[0].act_ot_qty || 0));
});

test('assignment codes are kept in an XER as P6 writes them (ASGNMNTCATTYPE, ASGNMNTCATVAL, ASGNMNTACAT) and go with a deleted activity', () => {
  const { db, act } = rich();
  const text = new TextDecoder().decode(writeXer(db, { version: '22.12', projIds: [rows(db, 'PROJECT')[0].proj_id] }));
  const at = (t: string) => text.indexOf(`%T\t${t}\n`) >= 0 ? text.indexOf(`%T\t${t}\n`) : text.indexOf(`%T\t${t}\r\n`);
  assert.ok(at('ASGNMNTCATTYPE') >= 0 && at('ASGNMNTCATTYPE') < at('ASGNMNTCATVAL') && at('ASGNMNTCATVAL') < at('PROJECT') && at('ASGNMNTACAT') > at('TASKRSRC'), 'in P6\'s table order');
  const back = parseXer(new TextEncoder().encode(text)).db;
  assert.equal(rows(back, 'ASGNMNTACAT').length, 1);
  assert.equal(applyOps(db, [{ op: 'delete_activity', id: act }]).ok, true);
  assert.equal(rows(db, 'ASGNMNTACAT').length, 0, 'the deleted assignment\'s codes go with it');
  assert.equal(applyOps(db, [{ op: 'delete_expense', activity: 'A2410', name: 'Crane hire' }]).ok, true);
  const po = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'PO date')!.udf_type_id;
  assert.ok(!rows(db, 'UDFVALUE').some((v) => v.udf_type_id === po), 'a deleted expense\'s UDF values go with it');
});

test('MCP: export_excel describe / sheets / columns, import_excel skips a refused row and applies the rest as one undo step', { timeout: 120_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const dir = mkdtempSync(join(tmpdir(), 'xl-mcp-'));
  copyFileSync(join(SAMPLES_DIR, 'cairo festival city.xer'), join(dir, 'c.xer'));
  const o = (await call('open_file', { path: join(dir, 'c.xer') })).d, H = { handle: o.handle, owner_key: o.owner_key };
  const desc = (await call('export_excel', { ...H, describe: true })).d;
  assert.deepEqual(Object.keys(desc.sheets), ['TASK', 'TASKPRED', 'PROJCOST', 'RSRC', 'TASKRSRC']);
  assert.ok(desc.sheets.TASK.columns.some((c: any) => c.field === 'task_code' && c.required) && desc.sheets.TASK.columns.some((c: any) => c.field.startsWith('actv_code_')));
  const x = (await call('export_excel', { ...H, path: join(dir, 'a.xlsx'), sheets: ['TASK'], columns: { TASK: ['task_name', 'target_drtn_hr_cnt', 'nope'] } })).d;
  assert.deepEqual(x.sheets, ['TASK']);
  assert.deepEqual(x.unknown_columns, ['TASK.nope']);
  const sheets = await readXlsx(new Uint8Array(readFileSync(join(dir, 'a.xlsx'))));
  const T = sheets[0];
  assert.deepEqual(T.rows[0], ['proj_id', 'task_code', 'status_code', 'wbs_id', 'task_name', 'target_drtn_hr_cnt', 'delete_record_flag']);
  T.rows.find((r) => r[1] === 'A1320')![5] = 5; // a milestone: refused
  T.rows.find((r) => r[1] === 'A2410')![5] = 33;
  writeFileSync(join(dir, 'b.xlsx'), await writeXlsx(sheets));
  const imp = (await call('import_excel', { ...H, path: join(dir, 'b.xlsx') })).d;
  assert.equal(imp.applied, true, JSON.stringify(imp));
  assert.deepEqual(imp.refused.map((r: any) => [r.sheet, r.op]), [['TASK', 'update_activity']]);
  assert.equal((await call('get_activity', { ...H, activity_id: 'A2410' })).d.orig_days, 33);
  await call('undo', H);
  assert.notEqual((await call('get_activity', { ...H, activity_id: 'A2410' })).d.orig_days, 33, 'one undo takes the import back');
  await call('close', { ...H, discard: true });
});


test('a 32,000-relationship programme re-imports unchanged in seconds (relationships matched by an index, not a scan)', async () => {
  const db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'Copy of JWM - Baseline Programme Rev 05A.xer')))).db;
  const p = rows(db, 'PROJECT').find((x) => !x._baseline_of)!;
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, [p.proj_id], 8, true)));
  const t0 = Date.now();
  const plan = planImport(db, sheets, p.proj_short_name, 8, true);
  assert.equal(plan.ops.length, 0, JSON.stringify(plan.ops.slice(0, 3)));
  assert.ok(Date.now() - t0 < 5000, `planned in ${Date.now() - t0} ms`);
});
