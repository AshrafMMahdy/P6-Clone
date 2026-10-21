// Edit operations the platform's anonymised export runs on a copy of a customer's file: rename or delete a resource
// (refused while referenced, unless asked to clear the references), clear an activity's primary resource, rename or
// delete an activity code value (project code types too), a new Project ID and internal project number with every
// reference following, fresh GUIDs, user fields cleared. Each over MCP edit, undoable, the saved file re-opened as
// P6-valid; then a whole anonymise pass and a search of the saved XER for any original name or GUID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { sessions } from '../mcp/runtime.ts';
import { refTarget, type Row } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const call = async (name: string, a: Record<string, unknown>) => { const r = await callTool(name, a); return toolResult(r.out, r.isError).structuredContent as any; };
const dir = mkdtempSync(join(tmpdir(), 'p6anon-'));
type S = { h: string; k: string };
async function open(path: string, lenient = false): Promise<S> {
  const o = await call('open_file', { path, ...(lenient ? { lenient: true } : {}) });
  assert.equal(o.error, undefined, JSON.stringify(o.error ?? {}).slice(0, 400));
  return { h: o.handle, k: o.owner_key };
}
const edit = (s: S, operations: unknown[]) => call('edit', { handle: s.h, owner_key: s.k, operations });
const ok = async (s: S, operations: unknown[]) => { const r = await edit(s, operations); assert.equal(r.error, undefined, JSON.stringify(r.error ?? {}).slice(0, 400)); return r; };
const undo = (s: S) => call('undo', { handle: s.h });
const T = (s: S, n: string): Row[] => sessions.get(s.h)!.db.tables[n]?.rows ?? [];
const count = (s: S, n: string, f: (r: Row) => boolean) => T(s, n).filter(f).length;

/** Saved, re-opened as strictly as P6 would and validated: no fatal or error finding. */
async function savedValid(s: S, name: string): Promise<{ path: string; s: S }> {
  const path = join(dir, name);
  const sv = await call('save', { handle: s.h, owner_key: s.k, path });
  assert.equal(sv.error, undefined, JSON.stringify(sv.error ?? {}).slice(0, 400));
  const r = await open(path);
  const v = await call('validate', { handle: r.h });
  assert.deepEqual([v.counts?.fatal ?? 0, v.counts?.error ?? 0], [0, 0], JSON.stringify(v).slice(0, 600));
  return { path, s: r };
}

/** Every field of every table that points at a project, as [table.field, value]. */
const projectRefs = (s: S) => Object.values(sessions.get(s.h)!.db.tables).flatMap((t) => t.fields.filter((f) => refTarget(f, t.name) === 'PROJECT' || (t.name === 'PROJECT' && f === 'proj_id')).flatMap((f) => t.rows.map((r) => [`${t.name}.${f}`, r[f]] as const)));

/** The resource on the most assignments that is also a primary resource. */
function busyResource(s: S) {
  const n = (r: Row) => count(s, 'TASKRSRC', (a) => a.rsrc_id === r.rsrc_id);
  const r = T(s, 'RSRC').filter((x) => T(s, 'TASK').some((t) => t.rsrc_id === x.rsrc_id)).sort((a, b) => n(b) - n(a))[0] ?? T(s, 'RSRC').sort((a, b) => n(b) - n(a))[0];
  return { r, rid: r.rsrc_id, key: r.rsrc_short_name, assignments: n(r), primary: count(s, 'TASK', (t) => t.rsrc_id === r.rsrc_id) };
}

/** Each op alone, then undone; then all together saved and re-opened P6-valid. */
async function eachOp(s: S, file: string, newProjId: string) {
  const R = busyResource(s);
  assert.ok(R.assignments > 0, 'a resource with assignments');
  // a resource still referenced is not deleted
  const refused = await edit(s, [{ op: 'delete_resource', id: R.key }]);
  assert.equal(refused.error?.code, 'op_failed');
  assert.match(refused.error.message, /assignment\(s\).*clear_references: true/);
  assert.equal(count(s, 'RSRC', (r) => r.rsrc_id === R.rid), 1);
  // rename
  await ok(s, [{ op: 'update_resource', id: R.key, new_id: 'RES-RENAMED', name: 'Renamed resource' }]);
  assert.deepEqual(T(s, 'RSRC').filter((r) => r.rsrc_id === R.rid).map((r) => [r.rsrc_short_name, r.rsrc_name]), [['RES-RENAMED', 'Renamed resource']]);
  assert.equal((await edit(s, [{ op: 'update_resource', id: 'RES-RENAMED', new_id: T(s, 'RSRC').find((r) => r.rsrc_id !== R.rid)!.rsrc_short_name }])).error?.code, 'op_failed', 'a Resource ID already used');
  await undo(s);
  assert.equal(T(s, 'RSRC').find((r) => r.rsrc_id === R.rid)!.rsrc_short_name, R.key);
  // the primary resource: cleared, refused when not assigned, set again
  const t = T(s, 'TASK').find((x) => x.rsrc_id === R.rid) ?? T(s, 'TASK').find((x) => T(s, 'TASKRSRC').some((a) => a.task_id === x.task_id && a.rsrc_id === R.rid))!;
  const scope = { project: T(s, 'PROJECT').find((p) => p.proj_id === t.proj_id)!.proj_short_name };
  await ok(s, [{ op: 'update_activity', id: t.task_code, ...scope, primary_resource: '' }]);
  assert.equal(T(s, 'TASK').find((x) => x.task_id === t.task_id)!.rsrc_id, '');
  const other = T(s, 'RSRC').find((r) => !T(s, 'TASKRSRC').some((a) => a.task_id === t.task_id && a.rsrc_id === r.rsrc_id));
  if (other) assert.match((await edit(s, [{ op: 'update_activity', id: t.task_code, ...scope, primary_resource: other.rsrc_short_name }])).error.message, /is not assigned to/);
  await ok(s, [{ op: 'update_activity', id: t.task_code, ...scope, primary_resource: R.key }]);
  assert.equal(T(s, 'TASK').find((x) => x.task_id === t.task_id)!.rsrc_id, R.rid);
  await undo(s); await undo(s);
  assert.equal(T(s, 'TASK').find((x) => x.task_id === t.task_id)!.rsrc_id ?? '', t.rsrc_id ?? '');
  // delete, clearing what points at it
  const d = await ok(s, [{ op: 'delete_resource', id: R.key, clear_references: true }]);
  assert.deepEqual(d.results[0], { deleted: R.key, assignments_removed: R.assignments, primary_resources_cleared: R.primary });
  assert.deepEqual([count(s, 'RSRC', (r) => r.rsrc_id === R.rid), count(s, 'TASKRSRC', (a) => a.rsrc_id === R.rid), count(s, 'TASK', (x) => x.rsrc_id === R.rid), count(s, 'RSRCRATE', (x) => x.rsrc_id === R.rid), count(s, 'RSRCROLE', (x) => x.rsrc_id === R.rid)], [0, 0, 0, 0, 0]);
  await undo(s);
  assert.deepEqual([count(s, 'RSRC', (r) => r.rsrc_id === R.rid), count(s, 'TASKRSRC', (a) => a.rsrc_id === R.rid), count(s, 'TASK', (x) => x.rsrc_id === R.rid)], [1, R.assignments, R.primary]);

  // an activity code value (project-scoped in these files): renamed, then deleted with its assignments
  const v = [...T(s, 'ACTVCODE')].sort((a, b) => count(s, 'TASKACTV', (x) => x.actv_code_id === b.actv_code_id) - count(s, 'TASKACTV', (x) => x.actv_code_id === a.actv_code_id))[0];
  const type = T(s, 'ACTVTYPE').find((x) => x.actv_code_type_id === v.actv_code_type_id)!;
  const uses = count(s, 'TASKACTV', (x) => x.actv_code_id === v.actv_code_id);
  const kids = count(s, 'ACTVCODE', (x) => x.parent_actv_code_id === v.actv_code_id);
  const tscope = type.proj_id ? { project: T(s, 'PROJECT').find((p) => p.proj_id === type.proj_id)!.proj_short_name } : {};
  await ok(s, [{ op: 'update_code_value', type: type.actv_code_type, code: v.short_name, ...tscope, new_code: 'CVN', name: 'Renamed value' }]);
  assert.deepEqual(T(s, 'ACTVCODE').filter((x) => x.actv_code_id === v.actv_code_id).map((x) => [x.short_name, x.actv_code_name]), [['CVN', 'Renamed value']]);
  const del = await ok(s, [{ op: 'delete_code_value', type: type.actv_code_type, code: 'CVN', ...tscope }]);
  assert.equal(del.results[0].assignments_removed >= uses, true);
  assert.equal(del.results[0].with_children >= kids, true);
  assert.deepEqual([count(s, 'ACTVCODE', (x) => x.actv_code_id === v.actv_code_id), count(s, 'TASKACTV', (x) => x.actv_code_id === v.actv_code_id)], [0, 0]);
  await undo(s); await undo(s);
  assert.deepEqual([T(s, 'ACTVCODE').find((x) => x.actv_code_id === v.actv_code_id)!.short_name, count(s, 'TASKACTV', (x) => x.actv_code_id === v.actv_code_id)], [v.short_name, uses]);

  // a new Project ID and internal number: every reference follows, and back on undo
  const p = T(s, 'PROJECT').find((x) => !x._baseline_of)!, pid = p.proj_id, code = p.proj_short_name;
  const before = projectRefs(s).filter(([, x]) => x === pid).length;
  assert.equal((await edit(s, [{ op: 'set_project', project: code, new_proj_id: 'x1' }])).error?.code, 'op_failed');
  const sp = await ok(s, [{ op: 'set_project', project: code, new_id: 'PRJ-NEW', new_proj_id: newProjId }]);
  assert.deepEqual(sp.results[0], { project: 'PRJ-NEW', proj_id: newProjId });
  assert.deepEqual([projectRefs(s).filter(([, x]) => x === pid), projectRefs(s).filter(([, x]) => x === newProjId).length], [[], before]);
  assert.equal(T(s, 'PROJWBS').find((w) => w.proj_id === newProjId && w.proj_node_flag === 'Y')!.wbs_short_name !== code, true, 'the root WBS node does not keep the old Project ID');
  assert.equal((await call('get_activity', { handle: s.h, project: 'PRJ-NEW', activity_id: T(s, 'TASK').find((x) => x.proj_id === newProjId)!.task_code })).error, undefined);
  await undo(s);
  assert.deepEqual([T(s, 'PROJECT').find((x) => x.proj_id === pid)?.proj_short_name, projectRefs(s).filter(([, x]) => x === pid).length, projectRefs(s).filter(([, x]) => x === newProjId).length], [code, before, 0]);

  // all of it at once, saved: P6-valid when re-opened, and the changes kept
  await ok(s, [
    { op: 'update_activity', id: t.task_code, ...scope, primary_resource: '' },
    { op: 'delete_resource', id: R.key, clear_references: true },
    { op: 'update_code_value', type: type.actv_code_type, code: v.short_name, ...tscope, new_code: 'CVN' },
    { op: 'delete_code_value', type: type.actv_code_type, code: 'CVN', ...tscope },
    { op: 'set_project', project: code, new_id: 'PRJ-NEW', new_proj_id: newProjId },
  ]);
  const back = await savedValid(s, file);
  assert.deepEqual([count(back.s, 'RSRC', (r) => r.rsrc_short_name === R.key), count(back.s, 'ACTVCODE', (x) => x.short_name === 'CVN'), T(back.s, 'PROJECT').some((x) => x.proj_short_name === 'PRJ-NEW')], [0, 0, true]);
  return back;
}

test('badra oil: resource rename and delete, primary resource cleared, project code value renamed and deleted, new Project ID and number', { timeout: 120_000 }, async () => {
  const s = await open(join(SAMPLES_DIR, 'badra oil.xer'));
  const back = await eachOp(s, 'badra-ops.xer', '4242');
  assert.equal(T(back.s, 'PROJECT')[0].proj_id, '4242', 'P6 keeps a project number the XER gives');
});

test('DHBL (17,958 assignments, 50,553 code assignments): the same operations', { timeout: 300_000 }, async () => {
  const s = await open(join(SAMPLES_DIR, 'DHBL-24FEB13_VER-7.0.xer'));
  await eachOp(s, 'dhbl-ops.xer', '7001');
});

/** Tower-A as P6 would take it: the damaged sample opened leniently, its broken baseline saved again, repaired. */
async function towerA(): Promise<S> {
  const s = await open(join(SAMPLES_DIR, 'Tower-A_costloaded.xer'), true);
  await ok(s, [{ op: 'delete_baseline', baseline: 'tower_a_bl1' }, { op: 'save_baseline', project: 'tower_a', name: 'tower_a_bl1', assign_as: 'project' }]);
  const path = join(dir, 'tower-a-variant.xer');
  const sv = await call('save', { handle: s.h, owner_key: s.k, path, repair: true });
  assert.equal(sv.check?.still_rejected, false, JSON.stringify(sv.check ?? sv).slice(0, 400));
  return open(path);
}

test('Tower-A variant (baseline, roles, rates): the same operations; the baseline follows the new project number', { timeout: 120_000 }, async () => {
  const s = await towerA();
  const back = await eachOp(s, 'tower-a-ops.xer', '900');
  const p = T(back.s, 'PROJECT').find((x) => x.proj_short_name === 'PRJ-NEW')!, bl = T(back.s, 'PROJECT').find((x) => x._baseline_of)!;
  assert.deepEqual([p.proj_id, bl._baseline_of, p.sum_base_proj_id], ['900', '900', bl.proj_id]);
});

/** Rename everything a person could be named by, as the anonymised export does, from the file's own content. */
function anonymiseOps(s: S): unknown[] {
  const ops: unknown[] = [];
  for (const b of T(s, 'PROJECT').filter((p) => p._baseline_of)) ops.push({ op: 'delete_baseline', baseline: b.proj_short_name });
  const projs = T(s, 'PROJECT').filter((p) => !p._baseline_of);
  const pcode = new Map(projs.map((p, i) => [p.proj_id, `P${i + 1}`]));
  projs.forEach((p, i) => ops.push({ op: 'set_project', project: p.proj_short_name, new_id: `P${i + 1}`, name: `Project ${i + 1}`, new_proj_id: String(9000 + i) }));
  T(s, 'PROJWBS').filter((w) => pcode.has(w.proj_id)).forEach((w, i) => ops.push({ op: 'update_wbs', project: pcode.get(w.proj_id), code: `wbs_id:${w.wbs_id}`, new_code: `W${i + 1}`, ...(w.proj_node_flag === 'Y' ? {} : { name: `Area ${i + 1}` }) }));
  T(s, 'TASK').filter((t) => pcode.has(t.proj_id)).forEach((t, i) => ops.push({ op: 'update_activity', project: pcode.get(t.proj_id), id: t.task_code, new_id: `X${i + 1}`, name: `Activity ${i + 1}` }));
  T(s, 'RSRC').forEach((r, i) => ops.push({ op: 'update_resource', id: r.rsrc_short_name, new_id: `R${i + 1}`, name: `Resource ${i + 1}` }));
  // code values children first: a parent's new code would change the path its children are found by
  const live = (typeId: string) => { const pj = T(s, 'ACTVTYPE').find((x) => x.actv_code_type_id === typeId)!.proj_id; return !pj || pcode.has(pj); }; // a baseline's go with it
  T(s, 'ACTVTYPE').filter((x) => live(x.actv_code_type_id)).forEach((x, i) => ops.push({ op: 'update_code_type', name: x.actv_code_type, ...(x.proj_id ? { project: pcode.get(x.proj_id) } : {}), new_name: `Code type ${i + 1}` }));
  const V = T(s, 'ACTVCODE').filter((v) => live(v.actv_code_type_id)), byId = new Map(V.map((v) => [v.actv_code_id, v]));
  const path = (v: Row) => { const out: string[] = []; for (let x: Row | undefined = v; x; x = byId.get(x.parent_actv_code_id)) out.unshift(x.short_name); return out; };
  [...V].sort((a, b) => path(b).length - path(a).length).forEach((v, i) => {
    const k = T(s, 'ACTVTYPE').filter((x) => live(x.actv_code_type_id)).findIndex((x) => x.actv_code_type_id === v.actv_code_type_id);
    const type = T(s, 'ACTVTYPE').filter((x) => live(x.actv_code_type_id))[k];
    ops.push({ op: 'update_code_value', type: `Code type ${k + 1}`, code: path(v).join('.'), ...(type.proj_id && pcode.has(type.proj_id) ? { project: pcode.get(type.proj_id) } : {}), new_code: `C${i + 1}`, name: `Code ${i + 1}` });
  });
  // every notebook: the activities', the WBS elements' and the projects' (the EPS notebooks P6 writes into an XER)
  ops.push({ op: 'clear_notebooks' });
  T(s, 'CALENDAR').forEach((c, i) => ops.push({ op: 'update_calendar', name: c.clndr_name, new_name: `Calendar ${i + 1}` }));
  T(s, 'OBS').forEach((o, i) => ops.push({ op: 'update_obs', name: o.obs_name, new_name: `OBS ${i + 1}` }));
  T(s, 'ROLES').forEach((r, i) => ops.push({ op: 'update_role', id: r.role_short_name, new_id: `RL${i + 1}`, name: `Role ${i + 1}` }));
  T(s, 'ACCOUNT').forEach((a, i) => ops.push({ op: 'update_cost_account', id: a.acct_short_name, new_id: `AC${i + 1}`, name: `Account ${i + 1}` }));
  projs.forEach((_, i) => ops.push({ op: 'regenerate_guids', project: `P${i + 1}` }, { op: 'clear_authors', project: `P${i + 1}` }));
  return ops;
}
const GUID = (f: string) => f === 'guid' || f.endsWith('_guid');
const AUTHORS = ['create_user', 'update_user', 'add_by_name', 'user_id', 'ts_approve_user_id', 'checkout_user_id'];
/** Every GUID in the file, and every user field P6 writes that has a value. */
const fieldValues = (s: S, want: (f: string) => boolean) => Object.values(sessions.get(s.h)!.db.tables).flatMap((t) => t.fields.filter(want).flatMap((f) => t.rows.map((r) => r[f]).filter(Boolean)));
/** The names anonymising replaces (long enough not to turn up by chance inside other text). */
const originalNames = (s: S) => [
  ...T(s, 'PROJECT').map((p) => p.proj_short_name), ...T(s, 'PROJWBS').flatMap((w) => [w.wbs_short_name, w.wbs_name]), ...T(s, 'TASK').flatMap((t) => [t.task_code, t.task_name]),
  ...T(s, 'RSRC').flatMap((r) => [r.rsrc_short_name, r.rsrc_name]), ...T(s, 'ACTVTYPE').map((x) => x.actv_code_type), ...T(s, 'ACTVCODE').flatMap((v) => [v.short_name, v.actv_code_name]), ...T(s, 'CALENDAR').map((c) => c.clndr_name), ...T(s, 'OBS').map((o) => o.obs_name),
  ...T(s, 'ROLES').flatMap((r) => [r.role_short_name, r.role_name]), ...T(s, 'ACCOUNT').flatMap((a) => [a.acct_short_name, a.acct_name]),
  // notebook texts (Tower-A's project notebook: "EPS: Group / Middle East / Buildings")
  ...T(s, 'TASKMEMO').map((m) => m.task_memo), ...T(s, 'WBSMEMO').map((m) => m.wbs_memo),
  // the exporting user and database the header names, unless P6's defaults
  ...(sessions.get(s.h)!.db.header?.raw.slice(4, 7) ?? []).filter((x) => !['admin', 'dbxDatabaseNoName'].includes(x)),
].filter((n) => n && n.trim().length >= 4 && !/^[\d.\s:-]+$/.test(n));

for (const [label, make] of [['badra oil', () => open(join(SAMPLES_DIR, 'badra oil.xer'))], ['Tower-A variant', towerA], ['cleopatra elmohandesen', () => open(join(SAMPLES_DIR, 'cleopatra elmohandesen.xer'))]] as const) {
  test(`anonymise ${label}: everything renamed, GUIDs regenerated and authors cleared in one edit; the saved XER holds none of the original names, notebooks or GUIDs and re-opens P6-valid`, { timeout: 120_000 }, async () => {
    const s = await make();
    const names = [...new Set(originalNames(s))], guids = fieldValues(s, GUID);
    assert.ok(names.length > 20, `${names.length} names`);
    assert.ok(guids.length > 0 || label === 'Tower-A variant', `${guids.length} GUIDs`);
    const r = await ok(s, anonymiseOps(s));
    assert.ok(r.applied > names.length / 3);
    const back = await savedValid(s, `anon-${label.replace(/\W+/g, '-')}.xer`);
    const text = readFileSync(back.path, 'utf8');
    const fresh = fieldValues(back.s, (f) => f === 'guid');
    // a short name can turn up by chance inside a fresh random GUID: those are not a leak, so they are left out of the search
    const words = fresh.reduce((t, g) => t.split(g).join('\t'), text);
    assert.deepEqual(names.filter((n) => words.includes(n)), [], 'original names left in the saved XER');
    assert.deepEqual(guids.filter((g) => text.includes(g)), [], 'original GUIDs left in the saved XER');
    assert.deepEqual(fieldValues(back.s, (f) => AUTHORS.includes(f)), [], 'user fields cleared');
    assert.equal(new Set(fresh).size, fresh.length, 'fresh GUIDs are unique');
    assert.ok(fresh.every((g) => /^[A-Za-z0-9+/]{22}$/.test(g)), 'in P6\'s form');
    // undo puts every name, GUID and user back
    await undo(s);
    assert.deepEqual([...new Set(originalNames(s))].sort(), names.sort());
    assert.deepEqual(fieldValues(s, GUID), guids);
  });
}
