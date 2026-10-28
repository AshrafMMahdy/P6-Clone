// Edits that reach every P6 field and table (set_fields as Global Change, add_row, delete_rows), the dictionary deletes,
// and activities moved and copied between projects: what a P6 user can change, the agent can change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { validateXer } from '../core/xer/validate.ts';
import { SAMPLES_DIR } from './helpers.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); return r.results as any[]; };
const bad = (db: Db, ops: unknown[], re: RegExp) => { const r = applyOps(db, ops); assert.equal(r.ok, false); assert.match(r.error!.message, re); };
const load = () => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'CfC.xer')))).db;
const task = (db: Db, code: string, pid?: string) => rows(db, 'TASK').find((t) => t.task_code === code && (!pid || t.proj_id === pid))!;
const fatal = (db: Db) => validateXer(parseXer(writeXer(db, { version: '' } as any)).db).filter((f) => f.severity === 'fatal');

test('set_fields: one activity, P6 values checked; every row a where picks (Global Change) with expressions', () => {
  const db = load(), [first] = rows(db, 'TASK');
  ok(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: first.task_code }, fields: { duration_type: 'DT_FixedDrtn', complete_pct_type: 'CP_Phys', suspend_date: '2010-08-02 08:00', resume_date: '2010-08-09' } }]);
  const t = task(db, first.task_code);
  assert.deepEqual([t.duration_type, t.complete_pct_type, t.suspend_date, t.resume_date], ['DT_FixedDrtn', 'CP_Phys', '2010-08-02 08:00', '2010-08-09 00:00']);
  bad(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: first.task_code }, fields: { duration_type: 'fixed' } }], /takes DT_FixedDUR2, DT_FixedDrtn/);
  bad(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: first.task_code }, fields: { task_id: '9' } }], /key/);
  bad(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: first.task_code }, fields: { clndr_id: '999999' } }], /no CALENDAR row/);
  bad(db, [{ op: 'set_fields', table: 'TASK', fields: { duration_type: 'DT_FixedDrtn' } }], /all: true/);
  bad(db, [{ op: 'set_fields', table: 'TASK', where: { task_code: first.task_code }, fields: { nope_field: 1 } }], /No field "nope_field"/);
  // Global Change: every activity longer than 40 hours gets 10% more, its name a prefix
  const long = rows(db, 'TASK').filter((x) => Number(x.target_drtn_hr_cnt) > 40).map((x) => [x.task_code, Number(x.target_drtn_hr_cnt), x.task_name] as const);
  assert.ok(long.length > 5);
  const [r] = ok(db, [{ op: 'set_fields', table: 'TASK', where: { target_drtn_hr_cnt: { op: '>', value: 40 } }, fields: { target_drtn_hr_cnt: { multiply: 1.1 }, task_name: { prefix: 'L-' } } }]);
  assert.equal(r.matched, long.length);
  for (const [c, h, n] of long) { const x = task(db, c); assert.equal(Number(x.target_drtn_hr_cnt), Math.round(h * 1.1 * 1e6) / 1e6); assert.equal(x.task_name, `L-${n}`); }
  // a project's status and defaults, a WBS's status
  ok(db, [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { def_duration_type: 'DT_FixedDUR2' } }, { op: 'set_fields', table: 'PROJWBS', where: { proj_node_flag: 'N' }, fields: { status_code: 'WS_Open' } }]);
  assert.ok(rows(db, 'PROJWBS').filter((w) => w.proj_node_flag === 'N').every((w) => w.status_code === 'WS_Open'));
  assert.deepEqual(fatal(db), []);
  // one undo-able change: a refused operation later in the list leaves nothing changed
  const before = task(db, first.task_code).task_name;
  bad(db, [{ op: 'set_fields', table: 'TASK', all: true, fields: { task_name: 'X' } }, { op: 'set_fields', table: 'TASK', all: true, fields: { duration_type: 'bad' } }], /takes/);
  assert.equal(task(db, first.task_code).task_name, before);
});

test('add_row and delete_rows: any P6 table, refused while something points at a row', () => {
  const db = load();
  ok(db, [{ op: 'add_resource', id: 'CRANE', type: 'nonlabor' }]);
  const rid = rows(db, 'RSRC').find((r) => r.rsrc_short_name === 'CRANE')!.rsrc_id;
  const [a] = ok(db, [{ op: 'add_row', table: 'RSRCRATE', fields: { rsrc_id: rid, start_date: '2011-01-01', cost_per_qty: 250, max_qty_per_hr: 1 } }]);
  assert.ok(a.rsrc_rate_id);
  assert.equal(rows(db, 'RSRCRATE').find((r) => r.rsrc_rate_id === a.rsrc_rate_id)!.cost_per_qty, '250');
  bad(db, [{ op: 'add_row', table: 'RSRCRATE', fields: { rsrc_id: '987654' } }], /no RSRC row/);
  // a calendar in use cannot just go; a rate row nothing points at can
  const used = rows(db, 'TASK')[0].clndr_id;
  bad(db, [{ op: 'delete_rows', table: 'CALENDAR', where: { clndr_id: used } }], /point at these CALENDAR rows/);
  assert.deepEqual(ok(db, [{ op: 'delete_rows', table: 'RSRCRATE', where: { rsrc_rate_id: a.rsrc_rate_id } }])[0], { table: 'RSRCRATE', deleted: 1 });
});

test('dictionary deletes: code type, UDF, cost account, calendar (refused while used, unless replaced), resource curve', () => {
  const db = load();
  const t0 = rows(db, 'TASK')[0].task_code;
  ok(db, [
    { op: 'add_code_type', name: 'Zone', values: [{ code: 'Z1' }, { code: 'Z2' }] }, { op: 'assign_code', type: 'Zone', value: 'Z1', activity: t0 },
    { op: 'add_udf', name: 'Risk note' }, { op: 'set_udf', udf: 'Risk note', value: 'x', activity: t0 },
    { op: 'add_cost_account', id: 'CA1' }, { op: 'add_cost_account', id: 'CA2', parent: 'CA1' }, { op: 'add_expense', activity: t0, name: 'Hire', account: 'CA1', budgeted_cost: 10 },
    { op: 'add_calendar', name: 'Night' }, { op: 'update_activity', id: t0, calendar: 'Night' },
    { op: 'add_resource_curve', name: 'Front', values: [10, ...Array(20).fill(4.5)] },
  ]);
  ok(db, [{ op: 'delete_code_type', name: 'Zone' }, { op: 'delete_udf', udf: 'Risk note' }, { op: 'delete_cost_account', id: 'CA1' }, { op: 'delete_resource_curve', name: 'Front' }]);
  assert.ok(!rows(db, 'ACTVTYPE').some((x) => x.actv_code_type === 'Zone') && !rows(db, 'ACTVCODE').some((x) => x.short_name === 'Z1'));
  assert.ok(!rows(db, 'UDFTYPE').some((x) => x.udf_type_label === 'Risk note'));
  assert.equal(rows(db, 'ACCOUNT').find((x) => x.acct_short_name === 'CA2')!.parent_acct_id, '');
  assert.equal(rows(db, 'PROJCOST').find((x) => x.cost_name === 'Hire')!.acct_id, '');
  bad(db, [{ op: 'delete_calendar', name: 'Night' }], /in use: 1 TASK/);
  const dflt = rows(db, 'CALENDAR').find((c) => c.default_flag === 'Y')!;
  bad(db, [{ op: 'delete_calendar', name: dflt.clndr_name }], /default calendar/);
  ok(db, [{ op: 'delete_calendar', name: 'Night', replace_with: dflt.clndr_name }]);
  assert.equal(task(db, t0).clndr_id, dflt.clndr_id);
  assert.deepEqual(fatal(db), []);
});

test('move_activity and copy_activities between projects, with what belongs to them and the logic among the copies', () => {
  const db = load();
  const P = rows(db, 'PROJECT')[0];
  ok(db, [{ op: 'add_project', id: 'NEW', start: '2010-07-01' }]);
  const N = rows(db, 'PROJECT').find((p) => p.proj_short_name === 'NEW')!;
  const links = rows(db, 'TASKPRED').filter((r) => r.proj_id === P.proj_id && r.pred_proj_id === P.proj_id);
  const [l] = links;
  const pred = rows(db, 'TASK').find((t) => t.task_id === l.pred_task_id)!, succ = rows(db, 'TASK').find((t) => t.task_id === l.task_id)!;
  const [c] = ok(db, [{ op: 'copy_activities', project: P.proj_short_name, to_project: 'NEW', activities: [{ id: pred.task_code, new_id: 'C1' }, { id: succ.task_code, new_id: 'C2' }] }]);
  assert.deepEqual(c, { copied: ['C1', 'C2'], relationships: rows(db, 'TASKPRED').filter((r) => r.pred_task_id === pred.task_id && r.task_id === succ.task_id).length });
  const c1 = task(db, 'C1', N.proj_id), c2 = task(db, 'C2', N.proj_id);
  assert.ok(rows(db, 'TASKPRED').some((r) => r.pred_task_id === c1.task_id && r.task_id === c2.task_id && r.proj_id === N.proj_id));
  assert.equal(rows(db, 'TASKRSRC').filter((r) => r.task_id === c1.task_id).length, rows(db, 'TASKRSRC').filter((r) => r.task_id === pred.task_id).length);
  // move: the activity and its rows go; its relationships stay, now between projects
  ok(db, [{ op: 'move_activity', id: succ.task_code, project: P.proj_short_name, to_project: 'NEW', new_id: 'M1' }]);
  const m = task(db, 'M1', N.proj_id);
  assert.equal(m.task_id, succ.task_id);
  assert.ok(rows(db, 'TASKRSRC').filter((r) => r.task_id === m.task_id).every((r) => r.proj_id === N.proj_id));
  assert.ok(rows(db, 'TASKPRED').filter((r) => r.task_id === m.task_id).every((r) => r.proj_id === N.proj_id));
  bad(db, [{ op: 'move_activity', id: 'M1', project: 'NEW', to_project: 'NEW' }], /already/);
  assert.deepEqual(fatal(db), []);
});

test('through the MCP: the edit tool takes the new operations; read_table shows the change', { timeout: 120_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'CfC.xer') });
  const H = { handle: o.d.handle, owner_key: o.d.owner_key };
  const e = await call('edit', { ...H, operations: [{ op: 'set_fields', table: 'TASK', all: true, fields: { duration_type: 'DT_FixedDrtn' } }] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  const t = (await call('read_table', { handle: H.handle, table: 'TASK', columns: ['duration_type'] })).d;
  assert.ok(t.rows.every((r: string[]) => r[0] === 'DT_FixedDrtn'));
  await call('close', { ...H, discard: true });
});
