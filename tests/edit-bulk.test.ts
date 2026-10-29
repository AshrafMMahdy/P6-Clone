// Bulk edits the platform's anonymise and rates work runs on big files: update_assignment over every assignment (an
// index, not a scan per operation), clearing a project's UDF values and deleting its expenses in one operation, and
// renaming a UDF, a resource curve and an OBS description. Timed on DHBL (17,958 assignments, 22,952 UDF values,
// 6,260 expenses); each undoable, the saved file re-opened P6-valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { sessions } from '../mcp/runtime.ts';
import type { Row } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const call = async (name: string, a: Record<string, unknown>) => { const r = await callTool(name, a); return toolResult(r.out, r.isError).structuredContent as any; };
const dir = mkdtempSync(join(tmpdir(), 'p6bulk-'));
type S = { h: string; k: string };
const open = async (path: string, lenient = false): Promise<S> => { const o = await call('open_file', { path, ...(lenient ? { lenient: true } : {}) }); assert.equal(o.error, undefined); return { h: o.handle, k: o.owner_key }; };
const ok = async (s: S, operations: unknown[]) => { const r = await call('edit', { handle: s.h, owner_key: s.k, operations }); assert.equal(r.error, undefined, JSON.stringify(r.error ?? {}).slice(0, 300)); return r; };
const refused = async (s: S, operations: unknown[]) => (await call('edit', { handle: s.h, owner_key: s.k, operations })).error?.message as string;
const T = (s: S, n: string): Row[] => sessions.get(s.h)!.db.tables[n]?.rows ?? [];
const secs = async (f: () => Promise<unknown>) => { const t0 = performance.now(); await f(); return (performance.now() - t0) / 1000; };
async function savedValid(s: S, name: string) {
  const path = join(dir, name);
  assert.equal((await call('save', { handle: s.h, owner_key: s.k, path })).error, undefined);
  const r = await open(path);
  const v = await call('validate', { handle: r.h });
  assert.deepEqual([v.counts?.fatal ?? 0, v.counts?.error ?? 0], [0, 0], JSON.stringify(v).slice(0, 400));
  return r;
}

test('DHBL: update_assignment on all 17,958 assignments in a few seconds (was 200 s), undoable', { timeout: 300_000 }, async () => {
  const s = await open(join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'));
  const code = new Map(T(s, 'TASK').map((t) => [t.task_id, t.task_code])), rs = new Map(T(s, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name]));
  const seen = new Set<string>(), first = T(s, 'TASKRSRC').filter((a) => !seen.has(a.task_id + '|' + a.rsrc_id) && !!seen.add(a.task_id + '|' + a.rsrc_id));
  const before = new Map(first.map((a) => [a.taskrsrc_id, a.target_cost]));
  const ops = first.map((a) => ({ op: 'update_assignment', activity: code.get(a.task_id), resource: rs.get(a.rsrc_id), budgeted_cost: Math.round(Number(a.target_cost || 0) * 1.1 * 100) / 100 + 1 }));
  let r: any;
  const t = await secs(async () => { r = await ok(s, ops); });
  console.log(`update_assignment x${ops.length}: ${t.toFixed(2)} s`);
  assert.ok(r.applied === ops.length || new RegExp(`"applied":\\s*${ops.length}`).test(r.preview ?? ""), JSON.stringify(r).slice(0, 300)); // a 2 MB answer comes back truncated
  assert.ok(t < 20, `${t.toFixed(1)} s`);
  // each assignment got its own value (the first one of that resource on that activity, as before)
  const byId = new Map(T(s, 'TASKRSRC').map((a) => [a.taskrsrc_id, a]));
  first.slice(0, 500).forEach((a, i) => assert.equal(Number(byId.get(a.taskrsrc_id)!.target_cost), ops[i].budgeted_cost));
  await call('undo', { handle: s.h });
  assert.deepEqual(new Map(T(s, 'TASKRSRC').filter((a) => before.has(a.taskrsrc_id)).map((a) => [a.taskrsrc_id, a.target_cost])), before);
  // and with units (the duration-type rules and costs from the rates)
  const tu = await secs(() => ok(s, ops.map((o) => ({ op: o.op, activity: o.activity, resource: o.resource, units: 10 }))));
  console.log(`update_assignment units x${ops.length}: ${tu.toFixed(2)} s`);
  assert.ok(tu < 20, `${tu.toFixed(1)} s`);
  assert.ok(first.every((a) => Number(byId.get(a.taskrsrc_id)!.target_qty) === 10));
  await savedValid(s, 'dhbl-assignments.xer');
});

test('DHBL: clear_udfs and delete_expenses do in one operation what one set_udf / delete_expense per row did', { timeout: 300_000 }, async () => {
  const s = await open(join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'));
  const p = T(s, 'PROJECT')[0], proj = p.proj_short_name, code = new Map(T(s, 'TASK').map((t) => [t.task_id, t.task_code]));
  const udf = new Map(T(s, 'UDFTYPE').map((u) => [u.udf_type_id, u]));
  const values = T(s, 'UDFVALUE').length, expenses = T(s, 'PROJCOST').length;
  assert.ok(values > 20_000 && expenses > 6_000);
  // per row, as the platform did it
  const taskValues = T(s, 'UDFVALUE').filter((v) => udf.get(v.udf_type_id)!.table_name === 'TASK');
  const perUdf = await secs(() => ok(s, taskValues.map((v) => ({ op: 'set_udf', udf: udf.get(v.udf_type_id)!.udf_type_label, value: '', activity: code.get(v.fk_id), project: proj }))));
  await call('undo', { handle: s.h });
  const perExp = await secs(() => ok(s, T(s, 'PROJCOST').map((c) => ({ op: 'delete_expense', activity: code.get(c.task_id), name: c.cost_name, project: proj }))));
  await call('undo', { handle: s.h });
  // one operation each
  let cu: any, de: any;
  const bulkUdf = await secs(async () => { cu = await ok(s, [{ op: 'clear_udfs', project: proj }]); });
  const bulkExp = await secs(async () => { de = await ok(s, [{ op: 'delete_expenses', project: proj }]); });
  console.log(`set_udf x${taskValues.length}: ${perUdf.toFixed(2)} s, clear_udfs: ${bulkUdf.toFixed(2)} s; delete_expense x${expenses}: ${perExp.toFixed(2)} s, delete_expenses: ${bulkExp.toFixed(2)} s`);
  assert.ok(bulkUdf < 2 && bulkExp < 2 && bulkUdf < perUdf && bulkExp < perExp);
  assert.equal(cu.results[0].cleared, values - T(s, 'UDFVALUE').length);
  assert.equal(T(s, 'UDFVALUE').filter((v) => udf.get(v.udf_type_id)!.table_name !== 'RSRC').length, 0, 'every value of the project\'s activities, WBS, assignments and project (resource values are shared)');
  assert.deepEqual([de.results[0].deleted, T(s, 'PROJCOST').length], [expenses, 0]);
  const back = await savedValid(s, 'dhbl-cleared.xer');
  assert.deepEqual([T(back, 'PROJCOST').length, T(back, 'UDFVALUE').filter((v) => T(back, 'UDFTYPE').find((u) => u.udf_type_id === v.udf_type_id)!.table_name !== 'RSRC').length], [0, 0]);
  await call('undo', { handle: s.h }); await call('undo', { handle: s.h });
  assert.deepEqual([T(s, 'UDFVALUE').length, T(s, 'PROJCOST').length], [values, expenses]);
  // narrower: one subject, one UDF, one activity's expenses
  const subjects = new Set(T(s, 'UDFVALUE').map((v) => udf.get(v.udf_type_id)!.table_name));
  const sub = await ok(s, [{ op: 'clear_udfs', project: proj, subject: 'activity' }]);
  assert.deepEqual([sub.results[0].cleared, T(s, 'UDFVALUE').some((v) => udf.get(v.udf_type_id)!.table_name === 'TASK')], [taskValues.length, false]);
  assert.equal(T(s, 'UDFVALUE').length, values - taskValues.length, `other subjects (${[...subjects].join(', ')}) kept`);
  await call('undo', { handle: s.h });
  const one = udf.get(taskValues[0].udf_type_id)!, nOne = T(s, 'UDFVALUE').filter((v) => v.udf_type_id === one.udf_type_id).length;
  assert.equal((await ok(s, [{ op: 'clear_udfs', project: proj, udf: one.udf_type_label }])).results[0].cleared, nOne);
  assert.equal(T(s, 'UDFVALUE').length, values - nOne);
  await call('undo', { handle: s.h });
  assert.match(await refused(s, [{ op: 'clear_udfs', project: proj, udf: 'No such UDF' }]), /No UDF "No such UDF"/);
  const c0 = T(s, 'PROJCOST')[0], act = code.get(c0.task_id)!, nAct = T(s, 'PROJCOST').filter((c) => c.task_id === c0.task_id).length;
  assert.deepEqual((await ok(s, [{ op: 'delete_expenses', activity: act, project: proj }])).results[0], { activity: act, deleted: nAct });
  assert.equal(T(s, 'PROJCOST').length, expenses - nAct);
});

test('rename a UDF, a resource curve and an OBS description (cleared or renamed), each undoable', { timeout: 120_000 }, async () => {
  const s = await open(join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'));
  const u = T(s, 'UDFTYPE').find((x) => x.table_name === 'TASK')!, other = T(s, 'UDFTYPE').find((x) => x.table_name === 'TASK' && x !== u)!;
  await ok(s, [{ op: 'update_udf', udf: u.udf_type_label, new_name: 'Field A' }]);
  assert.equal(T(s, 'UDFTYPE').find((x) => x.udf_type_id === u.udf_type_id)!.udf_type_label, 'Field A');
  assert.match(await refused(s, [{ op: 'update_udf', udf: 'Field A', new_name: other.udf_type_label }]), /already exists/);
  assert.equal((await ok(s, [{ op: 'set_udf', udf: 'Field A', value: 'x', activity: T(s, 'TASK')[0].task_code }])).error, undefined, 'used by its new name');
  await call('undo', { handle: s.h }); await call('undo', { handle: s.h });
  assert.equal(T(s, 'UDFTYPE').find((x) => x.udf_type_id === u.udf_type_id)!.udf_type_label, u.udf_type_label);
  // OBS description: renamed, cleared
  const o = T(s, 'OBS')[0];
  await ok(s, [{ op: 'update_obs', name: o.obs_name, description: 'Site team' }]);
  assert.equal(T(s, 'OBS')[0].obs_descr, 'Site team');
  await ok(s, [{ op: 'update_obs', name: o.obs_name, description: '' }]);
  assert.equal(T(s, 'OBS')[0].obs_descr, '');
  await savedValid(s, 'dhbl-renamed.xer');
  await call('undo', { handle: s.h }); await call('undo', { handle: s.h });
  assert.equal(T(s, 'OBS')[0].obs_descr ?? '', o.obs_descr ?? '');
  // a resource curve (Tower-A carries one)
  const t = await open(join(SAMPLES_DIR, 'Tower-A_costloaded.xer'), true);
  const c = T(t, 'RSRCCURVDATA')[0];
  assert.ok(c, 'Tower-A has a resource curve');
  await ok(t, [{ op: 'update_resource_curve', name: c.curv_name, new_name: 'Curve 1' }]);
  assert.equal(T(t, 'RSRCCURVDATA')[0].curv_name, 'Curve 1');
  assert.match(await refused(t, [{ op: 'update_resource_curve', name: 'nope', new_name: 'x' }]), /No resource curve/);
  await call('undo', { handle: t.h });
  assert.equal(T(t, 'RSRCCURVDATA')[0].curv_name, c.curv_name);
});
