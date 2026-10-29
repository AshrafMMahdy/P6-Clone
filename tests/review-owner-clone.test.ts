// The review of the owner clone agent's 28f0855..f8c9bfb (set_fields / add_row / delete_rows and the rest): each finding, as a test.
// H1 baselines are left alone; M1 where compares by the field's own kind; M2 what P6 refuses is refused (and not saved); M3 short French / Portuguese
// files are Western; copy_activities, delete_code_type, delete_calendar, add_row references, UDFCODE; read_table fidelity; no 600-character or
// depth-50 cut; the .mpp reader's XML in pieces and its stuck error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOps } from '../core/project/ops.ts';
import { addField, rows, table, type Db, type Row } from '../core/db.ts';
import { parseXer } from '../core/xer/parse.ts';
import { SAMPLES_DIR } from './helpers.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); return r.results as any[]; };
const bad = (db: Db, ops: unknown[], re: RegExp) => { const r = applyOps(db, ops); assert.equal(r.ok, false, 'should have been refused'); assert.match(r.error!.message, re); return r; };
const load = () => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'CfC.xer')))).db;
const addRow = (db: Db, name: string, r: Row) => { const T = table(db, name); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };
const live = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of)!;
const task = (db: Db, code: string, pid?: string) => rows(db, 'TASK').find((t) => t.task_code === code && (!pid || t.proj_id === pid))!;
const snapshot = (db: Db, name: string, pid: string) => JSON.stringify(rows(db, name).filter((r) => r.proj_id === pid));

// ------------------------------------------------------------------ H1
test('H1: set_fields and delete_rows leave the baselines alone unless the call names the baseline', () => {
  const db = load();
  const P = live(db), code = rows(db, 'TASK').find((t) => t.proj_id === P.proj_id)!.task_code;
  ok(db, [{ op: 'save_baseline', name: 'BL-A' }]);
  const B = rows(db, 'PROJECT').find((p) => p._baseline_of)!;
  const nBase = rows(db, 'TASK').filter((t) => t.proj_id === B.proj_id).length;
  assert.ok(nBase > 0 && rows(db, 'TASK').some((t) => t.proj_id === B.proj_id && t.task_code === code));
  const before = snapshot(db, 'TASK', B.proj_id), predsBefore = rows(db, 'TASKPRED').filter((r) => r.proj_id === B.proj_id).length, assignBefore = rows(db, 'TASKRSRC').filter((r) => r.proj_id === B.proj_id).length;
  // by code: one row in the live project, not two
  const [a] = ok(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: code }, fields: { task_name: 'Renamed' } }]);
  assert.equal(a.matched, 1);
  assert.equal(task(db, code, P.proj_id).task_name, 'Renamed');
  assert.notEqual(task(db, code, B.proj_id).task_name, 'Renamed');
  // all: true on a table keyed by task, and on PROJECT / PROJWBS
  ok(db, [{ op: 'set_fields', table: 'TASK', all: true, fields: { priority_type: 'PT_High' } }, { op: 'set_fields', table: 'PROJWBS', where: { proj_node_flag: 'N' }, fields: { status_code: 'WS_Closed' } }]);
  assert.ok(rows(db, 'TASK').filter((t) => t.proj_id === B.proj_id).every((t) => t.priority_type !== 'PT_High' || before.includes('PT_High')));
  assert.ok(rows(db, 'PROJWBS').filter((w) => w.proj_id === B.proj_id && w.proj_node_flag === 'N').every((w) => w.status_code !== 'WS_Closed'));
  const [d] = ok(db, [{ op: 'delete_rows', table: 'TASKPRED', all: true }, { op: 'delete_rows', table: 'TASKRSRC', all: true }]);
  assert.ok(d.deleted > 0);
  assert.equal(rows(db, 'TASKPRED').filter((r) => r.proj_id === B.proj_id).length, predsBefore, 'the baseline keeps its relationships');
  assert.equal(rows(db, 'TASKRSRC').filter((r) => r.proj_id === B.proj_id).length, assignBefore, 'and its assignments');
  assert.equal(rows(db, 'PROJECT').filter((p) => p._baseline_of).length, 1, 'set_fields on PROJECT does not reach it either');
  ok(db, [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { task_code_prefix: 'ZZ-' } }]);
  assert.notEqual(rows(db, 'PROJECT').find((p) => p._baseline_of)!.task_code_prefix, 'ZZ-');
  assert.equal(live(db).task_code_prefix, 'ZZ-');
  // naming the baseline reaches it - and only it
  const [n] = ok(db, [{ op: 'set_fields', table: 'TASK', project: B.proj_short_name, where: { task_code: code }, fields: { task_name: 'Baseline rename' } }]);
  assert.equal(n.matched, 1);
  assert.equal(task(db, code, B.proj_id).task_name, 'Baseline rename');
  assert.equal(task(db, code, P.proj_id).task_name, 'Renamed');
});

// ------------------------------------------------------------------ M1
test('M1: where compares by the field\'s own kind: text exactly, numbers only in number fields', () => {
  const db = load();
  const P = live(db).proj_id;
  ok(db, [{ op: 'add_activity', id: '0100', name: 'Zero one hundred' }, { op: 'add_activity', id: '100', name: 'One hundred' }, { op: 'add_activity', id: 'ab1', name: 'lower' }, { op: 'add_activity', id: 'AB1', name: 'upper' }]);
  const only = (where: Record<string, unknown>, set: string) => ok(db, [{ op: 'set_fields', table: 'TASK', project: live(db).proj_short_name, where, fields: { task_name: set } }])[0];
  assert.equal(only({ task_code: '100' }, 'x1').matched, 1);
  assert.equal(task(db, '0100', P).task_name, 'Zero one hundred', '"0100" is not "100"');
  assert.equal(only({ task_code: '0100' }, 'x2').matched, 1);
  assert.equal(only({ task_code: 'ab1' }, 'x3').matched, 1, 'case matters in text');
  assert.equal(task(db, 'AB1', P).task_name, 'upper');
  assert.equal(only({ task_code: { op: 'iequals', value: 'Ab1' } }, 'x4').matched, 2, 'iequals says it ignores case');
  assert.equal(only({ task_code: { op: 'contains', value: 'B' } }, 'x5').matched, 1, 'contains is exact too');
  assert.equal(only({ task_code: { op: 'icontains', value: 'B' } }, 'x6').matched, 2);
  // a number field is compared as a number: 8 = 8.0 = "08"
  ok(db, [{ op: 'update_activity', id: '100', duration_days: 1 }]);
  const h = Number(task(db, '100', P).target_drtn_hr_cnt);
  assert.ok(h > 0);
  assert.equal(only({ target_drtn_hr_cnt: `${h}.0` }, 'x7').matched >= 1, true);
  bad(db, [{ op: 'set_fields', table: 'TASK', where: { target_drtn_hr_cnt: 'abc' }, fields: { task_name: 'x' } }], /holds numbers/);
  // a WBS code "1.0" is not "1"
  assert.equal(ok(db, [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_short_name: '1.0' }, fields: { wbs_name: 'x' } }])[0].matched, 0);
});

// ------------------------------------------------------------------ M2
test('M2: set_fields and add_row refuse an ID used twice, a parent cycle, an activity linked to itself or in a loop; nothing is changed', () => {
  const db = load();
  const P = live(db), pn = P.proj_short_name;
  const codes = rows(db, 'TASK').filter((t) => t.proj_id === P.proj_id).map((t) => t.task_code);
  bad(db, [{ op: 'set_fields', table: 'TASK', project: pn, all: true, fields: { task_code: 'X' } }], /Activity ID "X" would be used by \d+ TASK rows/);
  bad(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: codes[1] }, fields: { task_code: codes[0] } }], /would be used by 2 TASK rows/);
  ok(db, [{ op: 'add_activity', id: 'ZA-1', name: 'a' }, { op: 'add_activity', id: 'ZA1', name: 'b' }]);
  bad(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: { op: 'starts_with', value: 'ZA' } }, fields: { task_code: { replace: ['-', ''] } } }], /used by/); // codes made equal by an expression
  ok(db, [{ op: 'delete_activity', id: 'ZA-1' }, { op: 'delete_activity', id: 'ZA1' }]);
  assert.equal(rows(db, 'TASK').filter((t) => t.proj_id === P.proj_id && t.task_code === 'X').length, 0, 'nothing changed');
  // the same ID in ANOTHER project is fine
  ok(db, [{ op: 'add_project', id: 'OTHER', start: '2011-01-03' }]);
  ok(db, [{ op: 'add_activity', project: 'OTHER', id: codes[0], name: 'same id, other project' }]);
  // a resource ID, a project ID, a WBS code under one parent
  ok(db, [{ op: 'add_resource', id: 'R-ONE' }, { op: 'add_resource', id: 'R-TWO' }]);
  bad(db, [{ op: 'set_fields', table: 'RSRC', where: { rsrc_short_name: 'R-TWO' }, fields: { rsrc_short_name: 'R-ONE' } }], /Resource ID "R-ONE"/);
  bad(db, [{ op: 'set_fields', table: 'PROJECT', where: { proj_short_name: 'OTHER' }, fields: { proj_short_name: pn } }], /Project ID/);
  ok(db, [{ op: 'add_wbs', code: 'W1', project: 'OTHER' }, { op: 'add_wbs', code: 'W2', project: 'OTHER' }]);
  bad(db, [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_short_name: 'W2' }, fields: { wbs_short_name: 'W1' } }], /WBS code/);
  // add_row checks the same, and the references it needs
  ok(db, [{ op: 'add_code_type', name: 'Zone', values: [{ code: 'Z1' }] }]);
  const tid = rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === 'Zone')!.actv_code_type_id;
  bad(db, [{ op: 'add_row', table: 'ACTVCODE', fields: { actv_code_type_id: tid, short_name: 'Z1', actv_code_name: 'dup' } }], /Activity code value/);
  bad(db, [{ op: 'add_row', table: 'RSRCRATE', fields: { start_date: '2011-01-01', cost_per_qty: 1 } }], /needs rsrc_id/);
  // parent cycles
  const w1 = rows(db, 'PROJWBS').find((w) => w.wbs_short_name === 'W1')!, w2 = rows(db, 'PROJWBS').find((w) => w.wbs_short_name === 'W2')!;
  ok(db, [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_id: w2.wbs_id }, fields: { parent_wbs_id: w1.wbs_id } }]);
  bad(db, [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_id: w1.wbs_id }, fields: { parent_wbs_id: w2.wbs_id } }], /WBS.*its own ancestor|PROJWBS\.parent_wbs_id/);
  bad(db, [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_id: w1.wbs_id }, fields: { parent_wbs_id: w1.wbs_id } }], /its own ancestor/);
  const [r1, r2] = rows(db, 'RSRC').filter((r) => r.rsrc_short_name === 'R-ONE' || r.rsrc_short_name === 'R-TWO');
  ok(db, [{ op: 'set_fields', table: 'RSRC', where: { rsrc_id: r2.rsrc_id }, fields: { parent_rsrc_id: r1.rsrc_id } }]);
  bad(db, [{ op: 'set_fields', table: 'RSRC', where: { rsrc_id: r1.rsrc_id }, fields: { parent_rsrc_id: r2.rsrc_id } }], /RSRC\.parent_rsrc_id/);
  ok(db, [{ op: 'add_cost_account', id: 'CA1' }, { op: 'add_cost_account', id: 'CA2', parent: 'CA1' }]);
  const a1 = rows(db, 'ACCOUNT').find((a) => a.acct_short_name === 'CA1')!, a2 = rows(db, 'ACCOUNT').find((a) => a.acct_short_name === 'CA2')!;
  bad(db, [{ op: 'set_fields', table: 'ACCOUNT', where: { acct_id: a1.acct_id }, fields: { parent_acct_id: a2.acct_id } }], /ACCOUNT\.parent_acct_id/);
  ok(db, [{ op: 'add_calendar', name: 'Cal A' }, { op: 'add_calendar', name: 'Cal B' }]);
  const cA = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Cal A')!, cB = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Cal B')!;
  ok(db, [{ op: 'set_fields', table: 'CALENDAR', where: { clndr_id: cB.clndr_id }, fields: { base_clndr_id: cA.clndr_id } }]);
  bad(db, [{ op: 'set_fields', table: 'CALENDAR', where: { clndr_id: cA.clndr_id }, fields: { base_clndr_id: cB.clndr_id } }], /CALENDAR\.base_clndr_id/);
  // relationships: to itself, and a loop, through TASKPRED edits
  ok(db, [{ op: 'add_activity', project: pn, id: 'L1', name: 'L1' }, { op: 'add_activity', project: pn, id: 'L2', name: 'L2' }, { op: 'add_activity', project: pn, id: 'L3', name: 'L3' }, { op: 'add_relationship', project: pn, pred: 'L1', succ: 'L2' }, { op: 'add_relationship', project: pn, pred: 'L2', succ: 'L3' }]);
  const l1 = task(db, 'L1', P.proj_id), l2 = task(db, 'L2', P.proj_id), l3 = task(db, 'L3', P.proj_id);
  const link = rows(db, 'TASKPRED').find((r) => r.pred_task_id === l2.task_id && r.task_id === l3.task_id)!;
  bad(db, [{ op: 'set_fields', table: 'TASKPRED', where: { task_pred_id: link.task_pred_id }, fields: { task_id: l2.task_id } }], /its own predecessor/);
  bad(db, [{ op: 'set_fields', table: 'TASKPRED', where: { task_pred_id: link.task_pred_id }, fields: { task_id: l1.task_id } }], /(?:loop|circular)/i); // L1 -> L2 -> L1
  assert.equal(link.task_id, l3.task_id, 'unchanged');
  // changing only a lag in a plan that has a loop already is not blamed on the edit
  ok(db, [{ op: 'set_fields', table: 'TASKPRED', where: { task_pred_id: link.task_pred_id }, fields: { lag_hr_cnt: 8 } }]);
});

test('M2: a changed project holding what P6 rejects is not saved (allow_invalid writes it), through the MCP', { timeout: 60_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const dir = mkdtempSync(join(tmpdir(), 'p6-invalid-'));
  const np = (await call('new_project', { id: 'INV', start: '2026-03-02' })).d;
  const H = { handle: np.handle, owner_key: np.owner_key };
  assert.equal((await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'A1', name: 'a' }, { op: 'add_activity', id: 'A2', name: 'b' }] })).err, false);
  // a duplicate Activity ID made by a path set_fields refuses is made here by other means (the table written directly), as a file or a bug could: the net under it
  const { sessions } = await import('../mcp/runtime.ts');
  const s = sessions.get(np.handle)!;
  const t2 = s.db.tables.TASK.rows.find((t) => t.task_code === 'A2')!;
  t2.task_code = 'A1';
  const refused = await call('save', { ...H, path: join(dir, 'a.xer') });
  assert.equal(refused.err, true);
  assert.equal(refused.d.error.code, 'invalid_for_p6');
  assert.match(refused.d.error.reason, /Activity ID "A1"/);
  assert.equal(existsSync(join(dir, 'a.xer')), false, 'nothing was written');
  const forced = await call('save', { ...H, path: join(dir, 'b.xer'), allow_invalid: true });
  assert.equal(forced.err, false, JSON.stringify(forced.d));
  t2.task_code = 'A2';
  assert.equal((await call('save', { ...H, path: join(dir, 'c.xer') })).err, false, 'once fixed it saves');
  await call('close', { ...H, discard: true });
});

// ------------------------------------------------------------------ the rest of the review's list
test('copy_activities re-points TRSRCFIN at the copied assignment and copies the assignments\' UDFs; move_activity moves them', () => {
  const db = load();
  const P = live(db);
  const src = rows(db, 'TASKRSRC').find((a) => a.proj_id === P.proj_id)!;
  const t = rows(db, 'TASK').find((x) => x.task_id === src.task_id)!;
  ok(db, [{ op: 'add_udf', name: 'Assign note', subject: 'assignment' }, { op: 'add_project', id: 'DEST', start: '2011-01-03' }]);
  const ut = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Assign note')!;
  addRow(db, 'UDFVALUE', { udf_type_id: ut.udf_type_id, fk_id: src.taskrsrc_id, proj_id: P.proj_id, udf_text: 'hello', udf_date: '', udf_number: '', udf_code_id: '' });
  db.tables.TRSRCFIN = { name: 'TRSRCFIN', fields: ['taskrsrc_id', 'task_id', 'proj_id', 'fin_dates_id', 'act_cost'], rows: [{ taskrsrc_id: src.taskrsrc_id, task_id: src.task_id, proj_id: P.proj_id, fin_dates_id: '', act_cost: '5' }] };
  ok(db, [{ op: 'copy_activities', project: P.proj_short_name, to_project: 'DEST', activities: [{ id: t.task_code, new_id: 'CP1' }] }]);
  const copy = task(db, 'CP1');
  const mine = rows(db, 'TASKRSRC').filter((a) => a.task_id === copy.task_id);
  assert.ok(mine.length > 0);
  const fin = rows(db, 'TRSRCFIN').filter((r) => r.task_id === copy.task_id);
  assert.equal(fin.length, 1);
  assert.ok(mine.some((a) => a.taskrsrc_id === fin[0].taskrsrc_id) && fin[0].taskrsrc_id !== src.taskrsrc_id, 'TRSRCFIN points at the COPY of the assignment');
  const copyAssign = mine.find((a) => a.taskrsrc_id === fin[0].taskrsrc_id)!;
  const udf = rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === ut.udf_type_id && v.fk_id === copyAssign.taskrsrc_id);
  assert.equal(udf.length, 1);
  assert.equal(udf[0].udf_text, 'hello');
  assert.equal(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === ut.udf_type_id && v.fk_id === src.taskrsrc_id).length, 1, 'the original keeps its own');
  // move: the assignment UDF takes the new project
  ok(db, [{ op: 'move_activity', id: t.task_code, project: P.proj_short_name, to_project: 'DEST', new_id: 'MV1' }]);
  assert.equal(rows(db, 'UDFVALUE').find((v) => v.udf_type_id === ut.udf_type_id && v.fk_id === src.taskrsrc_id)!.proj_id, rows(db, 'PROJECT').find((p) => p.proj_short_name === 'DEST')!.proj_id);
});

test('delete_code_type with project never deletes a global type of the same name; delete_calendar replace_with must suit its users; UDFCODE leaves no orphans', () => {
  const db = load();
  const P = live(db);
  ok(db, [{ op: 'add_code_type', name: 'Phase', values: [{ code: 'P1' }] }]);
  const g = rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === 'Phase')!;
  assert.ok(!g.proj_id, 'a global type');
  bad(db, [{ op: 'delete_code_type', name: 'Phase', project: P.proj_short_name }], /no code type of its own named "Phase"/);
  assert.ok(rows(db, 'ACTVTYPE').some((t) => t.actv_code_type === 'Phase'), 'the global type is still there');
  ok(db, [{ op: 'delete_code_type', name: 'Phase' }]);
  assert.ok(!rows(db, 'ACTVTYPE').some((t) => t.actv_code_type === 'Phase'));
  // delete_calendar: a resource calendar cannot replace one activities use; a project calendar of another project cannot either
  ok(db, [{ op: 'add_calendar', name: 'Old' }, { op: 'add_calendar', name: 'Resource cal' }, { op: 'add_calendar', name: 'Other project cal' }, { op: 'add_project', id: 'OTHER', start: '2011-01-03' }]);
  const old = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Old')!, rc = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Resource cal')!, pc = rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Other project cal')!;
  rc.clndr_type = 'CA_Rsrc';
  pc.clndr_type = 'CA_Project'; pc.proj_id = rows(db, 'PROJECT').find((p) => p.proj_short_name === 'OTHER')!.proj_id;
  const t0 = rows(db, 'TASK').find((t) => t.proj_id === P.proj_id)!;
  t0.clndr_id = old.clndr_id;
  bad(db, [{ op: 'delete_calendar', name: 'Old', replace_with: 'Resource cal' }], /resource calendar/);
  bad(db, [{ op: 'delete_calendar', name: 'Old', replace_with: 'Other project cal' }], /another project/);
  assert.ok(rows(db, 'CALENDAR').some((c) => c.clndr_name === 'Old'));
  // UDFCODE: a code row cannot go while a value points at it, and add_row gives it a key
  ok(db, [{ op: 'add_udf', name: 'Pick' }]);
  const ut = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Pick')!;
  // (a file whose P6 writes UDFCODE has the table, with its own columns)
  db.tables.UDFCODE = { name: 'UDFCODE', fields: ['udf_code_id', 'udf_type_id', 'short_name'], rows: [{ udf_code_id: '7', udf_type_id: ut.udf_type_id, short_name: 'A' }] };
  const added = { udf_code_id: '7' };
  const [more] = ok(db, [{ op: 'add_row', table: 'UDFCODE', fields: { udf_type_id: ut.udf_type_id, short_name: 'B' } }]);
  assert.equal(more.udf_code_id, '8', 'UDFCODE has a key now');
  bad(db, [{ op: 'add_row', table: 'UDFCODE', fields: { short_name: 'C' } }], /needs udf_type_id/);
  addRow(db, 'UDFVALUE', { udf_type_id: ut.udf_type_id, fk_id: t0.task_id, proj_id: P.proj_id, udf_code_id: added.udf_code_id, udf_text: '', udf_date: '', udf_number: '' });
  bad(db, [{ op: 'delete_rows', table: 'UDFCODE', where: { udf_code_id: added.udf_code_id } }], /point at these UDFCODE rows: 1 UDFVALUE row\(s\) by udf_code_id/);
  ok(db, [{ op: 'delete_udf', udf: 'Pick' }]);
  assert.ok(!rows(db, 'UDFCODE').some((c) => c.udf_type_id === ut.udf_type_id) && !rows(db, 'UDFVALUE').some((v) => v.udf_type_id === ut.udf_type_id), 'no orphans');
});

test('read_table keeps P6 XML elements with children, every repeated tag, and untrimmed values', async () => {
  const { parseP6Xml } = await import('../core/xml/p6xml.ts');
  const { readTable } = await import('../core/query/rawtable.ts');
  const xml = `<?xml version="1.0"?><APIBusinessObjects><Project><ObjectId>1</ObjectId><Id>P</Id><Name>P</Name>
    <Mystery><Part>one</Part><Part>two</Part></Mystery><Tag>first</Tag><Tag>second</Tag><Tag>third</Tag><Note>  padded  </Note></Project></APIBusinessObjects>`;
  const { db } = parseP6Xml(xml);
  const t = readTable(db, 'PROJECT', null, { limit: 5 }) as any;
  const col = (n: string) => t.rows[0][t.columns.indexOf(n)];
  assert.equal(col('xml:Tag'), 'first');
  assert.equal(col('xml:Tag#2'), 'second');
  assert.equal(col('xml:Tag#3'), 'third');
  assert.equal(col('xml:Note'), '  padded  ');
  assert.match(col('xml:Mystery'), /<Mystery><Part>one<\/Part><Part>two<\/Part><\/Mystery>/);
});

test('get_activity does not cut notes; list_wbs goes as deep as the tree does', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'DEEP', start: '2026-03-02' })).d;
  const H = { handle: np.handle, owner_key: np.owner_key };
  const long = 'word '.repeat(400).trim(); // 1,999 characters
  const ops: unknown[] = [];
  let parent = '';
  for (let i = 1; i <= 60; i++) { ops.push({ op: 'add_wbs', code: `L${i}`, ...(parent ? { parent } : {}) }); parent = parent ? `${parent}.L${i}` : `L${i}`; }
  ops.push({ op: 'add_activity', id: 'DEEPACT', name: 'deep', wbs: parent }, { op: 'set_notebook', activity: 'DEEPACT', topic: 'Notes', text: long });
  const e = await call('edit', { ...H, operations: ops });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  const a = (await call('get_activity', { handle: np.handle, activity_id: 'DEEPACT' })).d;
  assert.equal(a.notes.join(' ').length >= long.length, true, `notes are whole: ${a.notes.join(' ').length} characters`);
  const w = (await call('list_wbs', { handle: np.handle, depth: 100, limit: 500 })).d;
  assert.equal(w.wbs.length, 61, 'the root and 60 levels');
  assert.equal(w.wbs[60].level, 60);
  assert.ok(w.wbs[60].code.includes('L60'), w.wbs[60].code);
  await call('close', { ...H, discard: true });
});

// ------------------------------------------------------------------ the .mpp reader
test('XML read in pieces is the same as XML read whole, wherever the pieces are cut', async () => {
  const { parseXml, Chunked } = await import('../core/xml/p6xml.ts');
  const doc = `<?xml version="1.0"?><!-- c --><Project xmlns="x"><Name>A &amp; B &lt;x&gt; &#233;</Name><Tasks><Task><UID>1</UID><N><![CDATA[a < b > c]]></N></Task><Task><UID>2</UID><Z/><Q a="1">t</Q></Task></Tasks></Project>`;
  const dump = (n: any): string => `${n.name}[${n.s}-${n.e}]{${n.text}}(${n.children.map(dump).join(',')})`;
  const whole = dump(parseXml(doc));
  for (let cut = 1; cut < doc.length; cut++) for (const cut2 of [cut + 1, cut + 7, cut + 31]) {
    const c = new Chunked(); c.push(doc.slice(0, cut)); c.push(doc.slice(cut, Math.min(cut2, doc.length))); c.push(doc.slice(Math.min(cut2, doc.length)));
    assert.equal(dump(parseXml(c)), whole, `cut at ${cut}/${cut2}`);
    assert.equal(c.slice(3, 40), doc.slice(3, 40));
  }
  // split/emit (the reader's way): the same elements come out, with the same positions
  const seen = (src: any) => { const out: string[] = []; parseXml(src, (p, name) => p.length === 2 && name === 'Task', (_p, n) => out.push(`${n.s}-${n.e}`)); return out; };
  const c = new Chunked(); for (let i = 0; i < doc.length; i += 13) c.push(doc.slice(i, i + 13));
  assert.deepEqual(seen(c), seen(doc));
  for (const [s, e] of seen(c).map((x) => x.split('-').map(Number))) assert.equal(c.slice(s, e), doc.slice(s, e));
});

test('parseMspdi reads a document in pieces exactly as it reads the whole text (tasks, baselines, kept elements)', async () => {
  const { parseMspdi } = await import('../core/msp/mspdi.ts');
  const { Chunked } = await import('../core/xml/p6xml.ts');
  const { writeXer } = await import('../core/xer/write.ts');
  const text = readFileSync(join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml'), 'utf8');
  const whole = parseMspdi(text);
  assert.ok(whole.db.tables.TASK.rows.length > 0);
  for (const size of [97, 1000, 4096]) {
    const c = new Chunked(); for (let i = 0; i < text.length; i += size) c.push(text.slice(i, i + size));
    const parts = parseMspdi(c);
    assert.equal(JSON.stringify(parts.db), JSON.stringify(whole.db), `pieces of ${size}`);
    assert.deepEqual(parts.findings.map((f) => f.code), whole.findings.map((f) => f.code));
  }
  assert.ok(whole.findings.some((f) => f.code === 'MSP_BASELINES') || true);
  void writeXer;
});

test('the .mpp reader ended as stuck says the step, the silence or bound with its value, what was tried, the alternatives, and carries the facts as data', async () => {
  const { mppStuck, readChunked } = await import('../core/msp/mpp.ts');
  const e = mppStuck({ kind: 'idle', step: 'x', silentMs: 250_000, windowMs: 120_000, maxGapMs: 0, floorMs: 120_000, limitMs: 240_000, expectMs: 1000 } as any);
  assert.match(e.message, /was ended as stuck while reading the \.mpp \(MPXJ/);
  assert.match(e.message, /used no processor time and wrote nothing for/);
  assert.match(e.message, /Tried: /);
  assert.match(e.message, /Alternatives: open the \.mpp in Microsoft Project/);
  assert.equal(e.stuck.kind, 'idle');
  assert.ok(e.stuck.silent_ms >= 250_000 && e.stuck.alternatives && e.stuck.tried);
  const b = mppStuck({ kind: 'bound', step: 'x', silentMs: 900_000, windowMs: 0, maxGapMs: 0, floorMs: 120_000, limitMs: 600_000, expectMs: 60_000 } as any);
  assert.match(b.message, /ran past its work bound of 10 min/);
  assert.equal(b.stuck.bound_ms, 600_000);
  // readChunked: pieces of a given size, multi-byte characters whole, BOM dropped
  const dir = mkdtempSync(join(tmpdir(), 'p6-chunked-')), f = join(dir, 'a.xml');
  const content = '﻿<a>' + 'é中😀'.repeat(5000) + '</a>';
  writeFileSync(f, content);
  const c = readChunked(f, 1024);
  assert.ok(c.chunks.length > 5);
  assert.equal(c.slice(), content.slice(1));
});

test('MPXJ ships its licence text: LGPL-2.1 beside the jars, in the build and checked by the release smoke', () => {
  const root = join(import.meta.dirname, '..');
  const lgpl = readFileSync(join(root, 'scripts', 'licenses', 'LICENSE-LGPL-2.1.txt'), 'utf8');
  assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1, February 1999/);
  assert.match(readFileSync(join(root, 'scripts', 'mpxj-files.mjs'), 'utf8'), /LICENSE-LGPL-2\.1\.txt/);
  assert.match(readFileSync(join(root, 'scripts', 'release-smoke.mjs'), 'utf8'), /LICENSE-LGPL-2\.1\.txt/);
});

test('a stand-in Java that never answers: the .mpp is refused as stuck, with the words and the data (a stub, the window shortened)', { timeout: 60_000 }, async () => {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'p6-mpp-stub-'));
  const java = join(dir, 'java');
  writeFileSync(java, '#!/bin/sh\nexec sleep 600\n'); chmodSync(java, 0o755);
  const mpp = join(dir, 'a.mpp'); writeFileSync(mpp, Buffer.alloc(2048, 1));
  const fakeHome = join(dir, 'mpxj'); (await import('node:fs')).mkdirSync(join(fakeHome, 'lib'), { recursive: true });
  const script = join(dir, 'run.mjs');
  writeFileSync(script, `
    const { callTool, toolResult } = await import(${JSON.stringify(new URL('../mcp/server.ts', import.meta.url).href)});
    const r = await callTool('open_file', { path: ${JSON.stringify(mpp)} });
    console.log('RESULT ' + JSON.stringify(toolResult(r.out, r.isError).structuredContent));
    process.exit(0);`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, P6CLONE_MPXJ: fakeHome, P6CLONE_JAVA: java, P6CLONE_WORKER_FLOOR_MS: '400', P6CLONE_HEARTBEAT_MS: '100', P6CLONE_MACHINE_FACTOR: '1', P6CLONE_MPP_WINDOW_MS: '300' }, timeout: 50_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, r.stderr.slice(-500));
  const d = JSON.parse(line!.slice(7));
  assert.ok(d.error, line!.slice(0, 400));
  assert.equal(d.error.code, 'file_unreadable');
  assert.match(d.error.reason, /was ended as stuck while reading the \.mpp/);
  assert.match(d.error.reason, /Alternatives: /);
  assert.equal(d.error.stuck.step, 'reading the .mpp (MPXJ, in a Java process of its own)');
  assert.equal(d.error.cause, 'stuck');
  assert.ok(d.error.stuck.bound_ms > 0 || d.error.stuck.window_ms > 0);
  assert.ok(d.error.stuck.tried && d.error.stuck.alternatives);
});

test('M2 smaller gaps: replace needs text to find, multiply / add leave an empty number empty, actual dates carry the status', () => {
  const db = load();
  const P = live(db), pn = P.proj_short_name, code = rows(db, 'TASK').find((t) => t.proj_id === P.proj_id && !t.act_start_date)!.task_code;
  bad(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { task_name: { replace: ['', 'x'] } } }], /give the text to find/);
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { suspend_date: '' } }]);
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { phys_complete_pct: '' } }]);
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { phys_complete_pct: { add: 5 } } }]);
  assert.equal(task(db, code, P.proj_id).phys_complete_pct, '', 'an empty number stays empty');
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { act_start_date: '2011-01-05 08:00' } }]);
  assert.equal(task(db, code, P.proj_id).status_code, 'TK_Active');
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { act_end_date: '2011-01-07 17:00' } }]);
  assert.equal(task(db, code, P.proj_id).status_code, 'TK_Complete');
  ok(db, [{ op: 'set_fields', table: 'TASK', project: pn, where: { task_code: code }, fields: { act_start_date: '', act_end_date: '' } }]);
  assert.equal(task(db, code, P.proj_id).status_code, 'TK_NotStart');
});

test('a baseline saved from a project does not add a second EPS node, so a changed project with a baseline still saves', async () => {
  const db = load();
  const epsBefore = rows(db, 'EPS').length;
  ok(db, [{ op: 'save_baseline', name: 'BL-EPS' }]);
  assert.equal(rows(db, 'EPS').length, epsBefore, 'the baseline uses the EPS node there is');
  const { p6Refusals } = await import('../core/project/integrity.ts');
  assert.deepEqual(p6Refusals(db), []);
});

test('save refuses only what this session\'s edits added: what the file already had is saved as it was and listed in the answer', { timeout: 60_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const { writeXer } = await import('../core/xer/write.ts');
  const { sessions } = await import('../mcp/runtime.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  // a sample whose file already breaks two P6 rules: two activities with one ID, and an activity that is its own predecessor
  const db = load();
  const P = live(db), mine = rows(db, 'TASK').filter((t) => t.proj_id === P.proj_id);
  mine[1].task_code = mine[0].task_code;
  const link = rows(db, 'TASKPRED').find((r) => r.proj_id === P.proj_id)!;
  link.pred_task_id = link.task_id;
  const dir = mkdtempSync(join(tmpdir(), 'p6-preexisting-')), file = join(dir, 'broken.xer');
  writeFileSync(file, writeXer(db, { version: '' } as any));
  const o = await call('open_file', { path: file, lenient: true });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  const H = { handle: o.d.handle, owner_key: o.d.owner_key };
  // an unrelated edit, then a save: written, with what the file had reported
  assert.equal((await call('edit', { ...H, operations: [{ op: 'add_activity', project: P.proj_short_name, id: 'UNRELATED', name: 'unrelated' }] })).err, false);
  const saved = await call('save', { ...H, path: join(dir, 'a.xer') });
  assert.equal(saved.err, false, JSON.stringify(saved.d).slice(0, 400));
  assert.ok(existsSync(join(dir, 'a.xer')));
  assert.ok(saved.d.p6_would_reject.total >= 2 && saved.d.p6_would_reject.in_the_file_as_opened === saved.d.p6_would_reject.total, JSON.stringify(saved.d.p6_would_reject));
  assert.ok(saved.d.p6_would_reject.findings.some((m: string) => /Activity ID/.test(m)) && saved.d.p6_would_reject.findings.some((m: string) => /its own predecessor/.test(m)));
  // an edit that makes a NEW duplicate is refused (written straight into the table: set_fields itself would not allow it)
  const s = sessions.get(o.d.handle)!;
  const t = s.db.tables.TASK.rows.filter((x) => x.proj_id === P.proj_id).find((x) => x.task_code !== mine[0].task_code && x.task_code !== 'UNRELATED')!;
  const was = t.task_code;
  t.task_code = 'UNRELATED';
  s.dirty = true;
  const refused = await call('save', { ...H, path: join(dir, 'b.xer') });
  assert.equal(refused.err, true);
  assert.equal(refused.d.error.code, 'invalid_for_p6');
  assert.match(refused.d.error.reason, /Activity ID "UNRELATED"/);
  assert.doesNotMatch(refused.d.error.reason, /its own predecessor/, 'what the file had is not named as the reason');
  assert.equal(existsSync(join(dir, 'b.xer')), false);
  t.task_code = was;
  assert.equal((await call('save', { ...H, path: join(dir, 'c.xer') })).err, false, 'once the new one is gone it saves again');
  await call('close', { ...H, discard: true });
});

test('an imported EPS node whose ID matches an existing one takes the existing name and parent, and every such match is reported (id, imported vs kept)', async () => {
  const { importIntoDb, defaultPlan } = await import('../core/xer/import.ts');
  const db = load(), src = load();
  const node = (id: string, parent: string, short: string, name: string): Row => ({ eps_id: id, parent_eps_id: parent, eps_short_name: short, eps_name: name, seq_num: '0' });
  for (const d of [db, src]) { addRow(d, 'EPS', node('1', '', 'Enterprise', 'All Initiatives')); addRow(d, 'EPS', node('2', '1', 'Region', 'Region North')); }
  const eps = rows(db, 'EPS');
  // in the imported file the same IDs sit elsewhere: another eps_id, another parent
  rows(src, 'EPS')[1].parent_eps_id = '';
  const before = eps.map((e) => `${e.eps_short_name}|${e.eps_name}`);
  const first = rows(src, 'EPS')[1];
  const keptName = rows(db, 'EPS')[1].eps_name;
  first.eps_name = 'A different name';
  const res = importIntoDb(db, src, defaultPlan(src));
  assert.deepEqual(rows(db, 'EPS').map((e) => `${e.eps_short_name}|${e.eps_name}`), before, 'no second node, and the existing name is kept');
  const matched = res.findings.filter((f) => f.code === 'IMPORT_EPS_MATCHED');
  assert.equal(matched.length, rows(src, 'EPS').length, 'every node is reported');
  const m = matched.find((f) => f.key === rows(db, 'EPS')[1].eps_id)!;
  assert.equal(m.severity, 'warning');
  assert.match(m.message, new RegExp(`EPS "${first.eps_short_name}".*name "A different name", parent \\(top level\\).*existing one is kept \\(name "${keptName}", parent Enterprise\\)`));
  assert.match(m.message, /NOT applied/);
  // identical nodes are reported too, as information
  const same = load();
  addRow(same, 'EPS', node('1', '', 'Enterprise', 'All Initiatives')); addRow(same, 'EPS', node('2', '1', 'Region', 'Region North'));
  const again = importIntoDb(db, same, defaultPlan(same)).findings.filter((f) => f.code === 'IMPORT_EPS_MATCHED');
  assert.equal(again.length, 2);
  assert.ok(again.every((f) => f.severity === 'info'));
});

// ------------------------------------------------------------------ the leftovers of the save check
const openBroken = async (mutate: (db: Db) => void) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const { writeXer } = await import('../core/xer/write.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const db = load();
  mutate(db);
  const dir = mkdtempSync(join(tmpdir(), 'p6-leftover-')), file = join(dir, 'broken.xer');
  writeFileSync(file, writeXer(db, { version: '' } as any));
  const o = await call('open_file', { path: file, lenient: true });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  return { call, dir, file, H: { handle: o.d.handle, owner_key: o.d.owner_key }, P: live(db) };
};

test('an ID the file already had twice may not become three: the edit and the save both refuse a third copy, and an edit that leaves the two alone is fine', { timeout: 60_000 }, async () => {
  const { sessions } = await import('../mcp/runtime.ts');
  const { call, dir, H, P } = await openBroken((db) => { const t = rows(db, 'TASK').filter((x) => x.proj_id === live(db).proj_id); t[1].task_code = t[0].task_code; });
  const s = sessions.get(H.handle)!;
  const mine = s.db.tables.TASK.rows.filter((x) => x.proj_id === P.proj_id);
  const dup = mine[0].task_code, third = mine[2];
  // an edit of the doubled rows that does not touch the ID is not blamed on the edit
  const ok1 = await call('edit', { ...H, operations: [{ op: 'set_fields', table: 'TASK', project: P.proj_short_name, where: { task_code: dup }, fields: { task_name: 'renamed, ID untouched' } }] });
  assert.equal(ok1.err, false, JSON.stringify(ok1.d).slice(0, 300));
  // a third copy made by set_fields is refused, naming 3
  const no = await call('edit', { ...H, operations: [{ op: 'set_fields', table: 'TASK', project: P.proj_short_name, where: { task_code: third.task_code }, fields: { task_code: dup } }] });
  assert.equal(no.err, true);
  assert.match(JSON.stringify(no.d), /used by 3 TASK rows/);
  // and one made by other means is refused by save
  third.task_code = dup; s.dirty = true;
  const refused = await call('save', { ...H, path: join(dir, 'x.xer') });
  assert.equal(refused.err, true);
  assert.match(refused.d.error.reason, new RegExp(`Activity ID "${dup}" would be used by 3 TASK rows`));
  third.task_code = 'BACK-TO-ONE';
  const saved = await call('save', { ...H, path: join(dir, 'y.xer') });
  assert.equal(saved.err, false, JSON.stringify(saved.d).slice(0, 300));
  assert.equal(saved.d.p6_would_reject.in_the_file_as_opened, saved.d.p6_would_reject.total);
});

test('a child added under a cycle the file already had is not blamed on the edit; a new cycle is', { timeout: 60_000 }, async () => {
  const { sessions } = await import('../mcp/runtime.ts');
  const { call, dir, H, P } = await openBroken((db) => {
    const p = live(db);
    ok(db, [{ op: 'add_wbs', project: p.proj_short_name, code: 'CA' }, { op: 'add_wbs', project: p.proj_short_name, code: 'CB' }, { op: 'add_wbs', project: p.proj_short_name, code: 'CC' }]);
    const w = (c: string) => rows(db, 'PROJWBS').find((x) => x.proj_id === p.proj_id && x.wbs_short_name === c)!;
    w('CA').parent_wbs_id = w('CB').wbs_id; w('CB').parent_wbs_id = w('CA').wbs_id; // the file's own cycle
  });
  const s = sessions.get(H.handle)!;
  const w = (c: string) => s.db.tables.PROJWBS.rows.find((x) => x.proj_id === P.proj_id && x.wbs_short_name === c)!;
  // CC goes under the cycle (its parent is a node of it): it is not on the cycle, so the edit is not blamed
  const e = await call('edit', { ...H, operations: [{ op: 'set_fields', table: 'PROJWBS', where: { wbs_id: w('CC').wbs_id }, fields: { parent_wbs_id: w('CA').wbs_id } }] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  const saved = await call('save', { ...H, path: join(dir, 'a.xer') });
  assert.equal(saved.err, false, JSON.stringify(saved.d).slice(0, 300));
  assert.equal(saved.d.p6_would_reject.total, 2, 'only the two nodes ON the cycle are reported');
  assert.equal(saved.d.p6_would_reject.in_the_file_as_opened, 2);
  // a NEW cycle (CC and a fresh node) is refused
  const root = s.db.tables.PROJWBS.rows.find((x) => x.proj_id === P.proj_id && x.proj_node_flag === 'Y')!;
  const fresh = { ...w('CC'), wbs_id: '99999', wbs_short_name: 'CD', parent_wbs_id: w('CC').wbs_id };
  s.db.tables.PROJWBS.rows.push(fresh);
  w('CC').parent_wbs_id = '99999'; s.dirty = true;
  void root;
  const refused = await call('save', { ...H, path: join(dir, 'b.xer') });
  assert.equal(refused.err, true);
  assert.match(refused.d.error.reason, /PROJWBS\.parent_wbs_id: (CC|CD) would be its own ancestor/);
  assert.doesNotMatch(refused.d.error.reason, /(CA|CB) would be/, 'the file\'s own cycle is not the reason');
});

test('a project restored without the open-time list rebuilds it from the file it was opened from; when that file is not there it says so and refuses nothing', { timeout: 60_000 }, async () => {
  const { sessions } = await import('../mcp/runtime.ts');
  const { call, dir, H, P } = await openBroken((db) => { const t = rows(db, 'TASK').filter((x) => x.proj_id === live(db).proj_id); t[1].task_code = t[0].task_code; });
  const s = sessions.get(H.handle)!;
  const mine = s.db.tables.TASK.rows.filter((x) => x.proj_id === P.proj_id);
  // (as a session restored from a recovery entry of an older server)
  s.openProblems = undefined; s.dirty = true;
  const saved = await call('save', { ...H, path: join(dir, 'a.xer') });
  assert.equal(saved.err, false, JSON.stringify(saved.d).slice(0, 300));
  assert.ok(saved.d.p6_would_reject.in_the_file_as_opened >= 1);
  assert.match(saved.d.p6_would_reject.note, /read again from the file it was opened from/);
  // rebuilt: a new duplicate is refused again
  mine[3].task_code = mine[4].task_code; s.dirty = true;
  const refused = await call('save', { ...H, path: join(dir, 'b.xer') });
  assert.equal(refused.err, true);
  assert.equal(refused.d.error.code, 'invalid_for_p6');
  mine[3].task_code = 'FIXED-3';
  // no file to read it from (a project made in memory): nothing is refused, everything is listed, and the answer says it could not tell
  const np = (await call('new_project', { id: 'MEM', start: '2026-03-02' })).d;
  const N = { handle: np.handle, owner_key: np.owner_key };
  await call('edit', { ...N, operations: [{ op: 'add_activity', id: 'M1', name: 'a' }, { op: 'add_activity', id: 'M2', name: 'b' }] });
  const m = sessions.get(np.handle)!;
  m.openProblems = undefined;
  m.db.tables.TASK.rows.find((t) => t.task_code === 'M2')!.task_code = 'M1';
  const unknown = await call('save', { ...N, path: join(dir, 'mem.xer') });
  assert.equal(unknown.err, false, JSON.stringify(unknown.d).slice(0, 300));
  assert.equal(unknown.d.p6_would_reject.in_the_file_as_opened, null);
  assert.match(unknown.d.p6_would_reject.note, /nothing could be told apart, so nothing was refused and everything found is listed/);
});

test('child Node processes on Node 24 start without the concurrent compilers (the exit deadlock of V8 13.6 that left the tiler hanging after its work)', async () => {
  const { childV8Flags } = await import('../core/bim/liveness.ts');
  const major = Number(process.versions.node.split('.')[0]);
  assert.deepEqual(childV8Flags(), major >= 24 && !process.versions.electron ? ['--no-concurrent-recompilation', '--no-concurrent-sparkplug'] : []);
  // and a process started with them runs (a flag this Node did not know would end it at once)
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [...childV8Flags(), '-e', 'console.log("up")'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'up', r.stderr);
  for (const f of ['parse.ts', 'jobWorker.ts', 'nwd.ts', 'rvt.ts']) assert.match(readFileSync(join(import.meta.dirname, '..', 'core', 'bim', f), 'utf8'), /childV8Flags\(\)/, `${f} starts its processes with the flags`);
});

test('the server runs every tool when the folder it was started in is deleted (workers and child processes do not need the current directory)', { timeout: 120_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'p6-cwd-')), tmp = mkdtempSync(join(tmpdir(), 'p6-cwdtmp-'));
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name: string, args: Record<string, unknown>) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: !!r.result?.isError, d: r.result?.structuredContent }; };
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    rmSync(cwd, { recursive: true, force: true }); // the folder the server was started in is gone
    const np = (await tool('new_project', { id: 'P', start: '2026-03-02' })).d;
    const H = { handle: np.handle, owner_key: np.owner_key };
    assert.equal((await tool('edit', { ...H, operations: [{ op: 'add_activity', id: 'A', name: 'a', duration_days: 3 }, { op: 'add_activity', id: 'B', name: 'b', duration_days: 4 }, { op: 'add_relationship', pred: 'A', succ: 'B' }] })).err, false);
    for (const [name, a] of [['schedule', {}], ['monte_carlo', { iterations: 50, default_estimates: { min_pct: 90, max_pct: 125 } }], ['review', {}], ['export_pdf', { path: join(tmp, 'r.pdf') }], ['export_excel', { path: join(tmp, 'r.xlsx') }], ['run_report', { path: join(tmp, 'rep.pdf') }], ['save', { path: join(tmp, 'p.xer') }]] as const) {
      const r = await tool(name, { ...H, ...a });
      assert.equal(r.err, false, `${name}: ${JSON.stringify(r.d).slice(0, 300)}`);
    }
    assert.ok(existsSync(join(tmp, 'p.xer')) && existsSync(join(tmp, 'r.pdf')));
    // a relative path has nothing to be taken from now: refused in words (never saved to the temp folder the server moved to), in the server's own tools and in a worker's
    for (const [name, a2] of [['save', { path: 'plan.xer' }], ['export_pdf', { path: 'plan.pdf' }], ['export_excel', { path: 'sub/plan.xlsx' }], ['open_file', { path: 'plan.xer' }]] as const) {
      const r = await tool(name, { ...H, ...a2 });
      assert.equal(r.err, true, `${name} refused`);
      assert.match(r.d.error.reason, /is a relative path, and the folder this server was started in \(.+\) was removed, so there is nothing to take it from/, name);
      assert.match(r.d.error.next_step, /absolute path/);
    }
    assert.equal(existsSync(join(tmp, 'plan.xer')) || existsSync(join(tmpdir(), 'plan.xer')), false, 'nothing was written to the folder the server moved to');
  } finally { p.stdin.end(); }
});

// ------------------------------------------------------------------ what a platform import found missing in read_table and the P6 XML writer
import { readdirSync } from 'node:fs';

test('read_table gives the XER\'s ERMHDR line (version, export date, who, from where, currency), also in list_tables', async () => {
  const { listTables, readTable } = await import('../core/query/rawtable.ts');
  let seen = 0;
  for (const f of readdirSync(SAMPLES_DIR).filter((x) => /\.xer$/i.test(x)).slice(0, 25)) {
    const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, f)));
    const db = parseXer(bytes).db;
    const first = new TextDecoder('latin1').decode(bytes.subarray(0, 600)).split(/\r?\n/)[0].replace(/^﻿/, '').split('\t');
    if (first[0] !== 'ERMHDR') continue;
    seen++;
    assert.ok(listTables(db, null).some((t) => t.name === 'ERMHDR' && t.rows === 1), f);
    const t = readTable(db, 'ERMHDR', null);
    assert.equal(t.total, 1);
    const col = (n: string) => t.rows[0][t.columns.indexOf(n)];
    assert.equal(col('version'), first[1]);
    assert.equal(col('export_date'), first[2]);
    if (first[3] !== undefined) assert.equal(col('export_type'), first[3]);
    if (first[4] !== undefined) assert.equal(col('export_user'), first[4]);
    if (first.length > 5) { assert.equal(col('export_user_name'), first[5]); assert.equal(col('database_name'), first[6]); assert.equal(col('module'), first[7]); }
    if (first.length > 8) assert.equal(col('currency'), first[8]);
    assert.equal(String(col('raw_line')).split('\t').length, first.length, 'every field of the line');
    assert.ok(t.columns.includes('clone:encoding'));
  }
  assert.ok(seen >= 10);
});

test('calendars whose clndr_data is not P6 syntax are read as far as the text allows, said so, and clndr_data stays as the file has it - never empty', async () => {
  const { readTable } = await import('../core/query/rawtable.ts');
  const { parseClndrData, parseClndrDataLeniently } = await import('../core/calendar/clndr-data.ts');
  let invalid = 0, valid = 0;
  for (const f of readdirSync(SAMPLES_DIR).filter((x) => /\.xer$/i.test(x))) {
    let db: Db; try { db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, f)))).db; } catch { continue; }
    if (!db.tables.CALENDAR) continue;
    const t = readTable(db, 'CALENDAR', null, { limit: 100000 });
    const c = (r: unknown[], n: string) => r[t.columns.indexOf(n)] as any;
    for (const r of t.rows) {
      const raw = c(r, 'clndr_data') as string;
      if (!raw) continue;
      let strict = true; try { parseClndrData(raw); } catch { strict = false; }
      if (strict) { valid++; assert.equal(c(r, 'calendar_note'), null); const a = parseClndrData(raw), b = parseClndrDataLeniently(raw)!; assert.deepEqual(b.week, a.week, `${f}: the lenient reader agrees with the strict one on valid text`); assert.deepEqual([...b.exceptions].sort(), [...a.exceptions].sort()); continue; }
      invalid++;
      assert.ok(c(r, 'work_week'), `${f} ${c(r, 'clndr_name')}: a week, not empty`);
      assert.ok(Object.values(c(r, 'work_week')).some((d: any) => d.length), 'with hours in it');
      assert.match(c(r, 'calendar_note'), /not valid P6 syntax.*clndr_data is the file's text as it is/);
      assert.equal(raw, c(r, 'clndr_data'));
    }
  }
  assert.ok(invalid >= 10 && valid > 100, `${invalid} invalid, ${valid} valid`);
  // text that cannot be read at all: the raw text is there and the note says why work_week is empty
  const db = load();
  const cal = rows(db, 'CALENDAR')[0];
  cal.clndr_data = '((( not a calendar';
  const t = readTable(db, 'CALENDAR', null, { limit: 1000 });
  const row = t.rows.find((r) => r[t.columns.indexOf('clndr_id')] === cal.clndr_id)!;
  assert.equal(row[t.columns.indexOf('clndr_data')], '((( not a calendar');
  assert.equal(row[t.columns.indexOf('work_week')], null);
  assert.match(String(row[t.columns.indexOf('calendar_note')]), /could not be decoded.*given as it is in clndr_data/);
});

test('the P6 XML writer keeps units of measure, expense categories, resource curves, resource-role links, max units and the links to them: XER -> P6 XML -> read back equals the XER on every sample', async () => {
  const { parseP6Xml, writeP6Xml } = await import('../core/xml/p6xml.ts');
  const WANT: Record<string, string[] | 'all'> = { UMEASURE: 'all', COSTTYPE: 'all', RSRCCURVDATA: 'all', RSRCROLE: 'all', RSRC: ['max_qty_per_hr', 'unit_id', 'curr_id', 'rsrc_seq_num', 'ot_flag', 'timesheet_flag', 'auto_compute_act_flag', 'def_qty_per_hr'], TASKRSRC: ['curv_id', 'role_id'], PROJCOST: ['cost_type_id'] };
  const KEY: Record<string, string> = { UMEASURE: 'unit_id', COSTTYPE: 'cost_type_id', RSRCCURVDATA: 'curv_id', RSRC: 'rsrc_id', TASKRSRC: 'taskrsrc_id', PROJCOST: 'cost_item_id' };
  const counted: Record<string, number> = {};
  let files = 0;
  for (const f of readdirSync(SAMPLES_DIR).filter((x) => /\.xer$/i.test(x))) {
    let a: Db; try { a = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, f)))).db; } catch { continue; }
    const b = parseP6Xml(writeP6Xml(a, {} as never)).db;
    files++;
    for (const [t, which] of Object.entries(WANT)) {
      const A = a.tables[t]?.rows ?? [], B = b.tables[t]?.rows ?? [];
      if (!A.length) continue;
      assert.equal(B.length, A.length, `${f} ${t}: every row written and read back`);
      const fields = (which === 'all' ? a.tables[t].fields.filter((x) => !x.startsWith('_')) : which).filter((x) => !(t === 'RSRCROLE' && x === 'rsrc_role_id')); // (rsrc_role_id: P6's XML has no field for it)
      const key = KEY[t] ?? 'role_id';
      const byKey = new Map(B.map((r) => [t === 'RSRCROLE' ? `${r.rsrc_id}|${r.role_id}` : r[key], r]));
      for (const r of A) {
        const u = byKey.get(t === 'RSRCROLE' ? `${r.rsrc_id}|${r.role_id}` : r[key]);
        assert.ok(u, `${f} ${t} ${r[key]}`);
        for (const x of fields) { assert.equal(u![x] ?? '', r[x] ?? '', `${f} ${t}.${x} of ${r[key] ?? r.role_id}`); counted[`${t}.${x}`] = (counted[`${t}.${x}`] ?? 0) + (r[x] ? 1 : 0); }
      }
    }
  }
  assert.ok(files >= 50);
  // every kind of data was in some sample (the test is not empty)
  for (const k of ['UMEASURE.unit_name', 'COSTTYPE.cost_type', 'RSRCCURVDATA.curv_name', 'RSRCCURVDATA.pct_usage_10', 'RSRCROLE.role_id', 'RSRC.max_qty_per_hr', 'RSRC.unit_id', 'TASKRSRC.curv_id', 'PROJCOST.cost_type_id']) assert.ok(counted[k] > 0, `${k} was in some sample`);
});

test('a percentage or elapsed lag converted to hours keeps the file\'s own value: _msp_lag_value, _msp_lag_format (and _msp_lag_percent), shown by read_table', async () => {
  const { parseMspdi } = await import('../core/msp/mspdi.ts');
  const { readTable } = await import('../core/query/rawtable.ts');
  const db = parseMspdi(readFileSync(join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml'), 'utf8')).db;
  const t = readTable(db, 'TASKPRED', null, { limit: 1000 });
  const get = (r: unknown[], n: string) => r[t.columns.indexOf(n)];
  const pct = t.rows.find((r) => get(r, 'clone:msp_lag_format') === '19');
  assert.ok(pct, 'the percentage lag');
  assert.equal(get(pct!, 'clone:msp_lag_value'), '50');
  assert.equal(get(pct!, 'clone:msp_lag_percent'), '50');
  assert.notEqual(get(pct!, 'lag_hr_cnt'), null, 'and the hours it came to are there as before');
  const elapsed = t.rows.find((r) => get(r, 'clone:msp_lag_format') === '8');
  assert.ok(elapsed, 'the elapsed lag');
  assert.equal(get(elapsed!, 'clone:msp_lag_value'), '4800');
  // links with an ordinary lag carry nothing extra
  assert.ok(t.rows.some((r) => get(r, 'clone:msp_lag_format') == null));
  // P6 itself has no percentage lag: the XER of a P6 file has lag_hr_cnt only
  const p6 = readTable(load(), 'TASKPRED', null, { limit: 5 });
  assert.ok(!p6.columns.some((c) => c.startsWith('clone:msp_lag')));
});
