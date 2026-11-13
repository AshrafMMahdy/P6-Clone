// A general contractor's weekly update from subcontractors' schedules, through the MCP: progress transferred in one call
// (by Activity ID, or several of theirs onto one package activity by an activity code), and their file imported into
// the open project (Update Existing Project, a new project beside it), each one undoable change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAMPLES_DIR } from './helpers.ts';

const { callTool, toolResult } = await import('../mcp/server.ts');
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); const d = toolResult(r.out, r.isError).structuredContent as any; return { err: r.isError, d }; };
const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.err, false, `${name}: ${JSON.stringify(r.d).slice(0, 400)}`); assert.ok(!r.d?.error, `${name}: ${JSON.stringify(r.d).slice(0, 400)}`); return r.d; };
const rowsOf = async (handle: string, table: string, columns: string[]) => (await ok('read_table', { handle, table, columns })).rows as string[][];

/** The subcontractor's week: their copy of the programme with progress on six activities and a code "Package" on three. */
async function subFile(dir: string) {
  const src = join(SAMPLES_DIR, 'CfC.xer'), w1 = join(dir, 'SUB-w1.xer'), w2 = join(dir, 'SUB-w2.xer');
  copyFileSync(src, w1);
  const s = await ok('open_file', { path: w1 }), S = { handle: s.handle, owner_key: s.owner_key };
  const T = (await rowsOf(s.handle, 'TASK', ['task_code', 'status_code', 'target_start_date', 'target_drtn_hr_cnt', 'task_type'])).filter((r) => r[1] === 'TK_NotStart' && r[4] === 'TT_Task').slice(0, 6);
  const day = (r: string[], n: number) => new Date(Date.parse(r[2].slice(0, 10)) + n * 864e5).toISOString().slice(0, 10);
  await ok('edit', { ...S, operations: [
    ...T.slice(0, 3).map((r) => ({ op: 'update_activity', id: r[0], actual_start: day(r, 0), actual_finish: day(r, 2) })),
    ...T.slice(3).map((r) => ({ op: 'update_activity', id: r[0], actual_start: day(r, 1), remaining_days: 3 })),
    { op: 'add_code_type', name: 'Package', values: [{ code: 'PKG1' }] },
    ...T.slice(3).map((r) => ({ op: 'assign_code', type: 'Package', value: 'PKG1', activity: r[0] })),
  ] });
  await ok('save', { ...S, path: w2 });
  await ok('close', { ...S, discard: true });
  return { w2, codes: T.map((r) => r[0]) };
}

test('transfer_progress: a subcontractor\'s progress onto the GC programme in one call; dry run, undo, package summary by code', { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sub-progress-'));
  const { w2, codes } = await subFile(dir);
  const gcPath = join(dir, 'GC.xer');
  copyFileSync(join(SAMPLES_DIR, 'CfC.xer'), gcPath);
  const g = await ok('open_file', { path: gcPath }), G = { handle: g.handle, owner_key: g.owner_key };
  const sub = new Map((await (async () => { const o = await ok('open_file', { path: w2 }); const r = await rowsOf(o.handle, 'TASK', ['task_code', 'act_start_date', 'act_end_date', 'remain_drtn_hr_cnt']); await ok('close', { handle: o.handle, owner_key: o.owner_key, discard: true }); return r; })()).map((r) => [r[0], r]));

  const dry = await ok('transfer_progress', { ...G, path: w2, dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.updated >= 6 && dry.unmatched_from.length === 0, JSON.stringify(dry).slice(0, 300));
  const untouched = await rowsOf(g.handle, 'TASK', ['task_code', 'act_start_date']);
  assert.ok(untouched.filter((r) => codes.includes(r[0])).every((r) => r[1] === ''), 'a dry run changes nothing');

  const t = await ok('transfer_progress', { ...G, path: w2, data_date: 'from' });
  assert.ok(t.changes.some((c: any) => c.id === codes[0] && c.changed.act_end_date));
  const gc = new Map((await rowsOf(g.handle, 'TASK', ['task_code', 'act_start_date', 'act_end_date', 'remain_drtn_hr_cnt', 'status_code'])).map((r) => [r[0], r]));
  for (const c of codes) assert.deepEqual(gc.get(c)!.slice(1, 4), sub.get(c)!.slice(1, 4), c);
  assert.equal(gc.get(codes[0])![4], 'TK_Complete');
  const sch = await ok('schedule', { ...G, log: false });
  assert.equal(sch.ok, true);
  await ok('undo', G); await ok('undo', G); // the schedule, then the whole transfer
  assert.ok((await rowsOf(g.handle, 'TASK', ['task_code', 'act_start_date'])).filter((r) => codes.includes(r[0])).every((r) => r[1] === ''), 'one undo takes the transfer back');

  // one GC activity for the package: three of theirs carry the code Package = PKG1
  const pkg = (await rowsOf(g.handle, 'TASK', ['task_code', 'task_type'])).find((r) => r[1] === 'TT_Task' && !codes.includes(r[0]))![0];
  await ok('edit', { ...G, operations: [{ op: 'add_code_type', name: 'Sub package', values: [{ code: 'PKG1' }] }, { op: 'assign_code', type: 'Sub package', value: 'PKG1', activity: pkg }] });
  const p = await ok('transfer_progress', { ...G, path: w2, match: 'code', code_type: 'Sub package', from_code_type: 'Package' });
  assert.equal(p.matched, 1);
  assert.deepEqual(p.changes[0].from.sort(), codes.slice(3).sort());
  const row = (await rowsOf(g.handle, 'TASK', ['task_code', 'act_start_date', 'act_end_date', 'status_code'])).find((r) => r[0] === pkg)!;
  assert.equal(row[1], [...codes.slice(3)].map((c) => sub.get(c)![1]).sort()[0], 'the earliest of their starts');
  assert.equal(row[2], '', 'not finished while any of theirs is open');
  assert.equal(row[3], 'TK_Active');
  assert.ok(p.unmatched_from_count > 100 && p.unmatched_from.length === 100, 'their other activities are counted as not matched, the first 100 listed');

  const bad = await call('transfer_progress', { ...G, path: w2, match: 'code', code_type: 'Nope' });
  assert.match(bad.d.error.message, /No activity code type "Nope"/);
  await ok('close', { ...G, discard: true });
});

test('import_file: Update Existing Project from the subcontractor\'s file, and their file as a new project beside the GC\'s (other_handle)', { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sub-import-'));
  const { w2, codes } = await subFile(dir);
  const gcPath = join(dir, 'GC.xer');
  copyFileSync(join(SAMPLES_DIR, 'CfC.xer'), gcPath);
  const g = await ok('open_file', { path: gcPath }), G = { handle: g.handle, owner_key: g.owner_key };
  const n0 = (await rowsOf(g.handle, 'TASK', ['task_code'])).length;
  const dry = await ok('import_file', { ...G, path: w2, action: 'update', dry_run: true });
  assert.ok(dry.counts.TASK.updated === n0 && !dry.counts.TASK.inserted, JSON.stringify(dry.counts.TASK));
  const u = await ok('import_file', { ...G, path: w2, action: 'update' });
  assert.deepEqual(u.projects.length, 1);
  const gc = new Map((await rowsOf(g.handle, 'TASK', ['task_code', 'act_start_date'])).map((r) => [r[0], r[1]]));
  assert.equal(gc.size, n0, 'matched by Activity ID: nothing added');
  assert.ok(codes.every((c) => gc.get(c)), 'their actuals came in');
  assert.ok((await ok('list_dictionaries', { handle: g.handle })) != null);

  const o = await ok('open_file', { path: w2 });
  const nw = await ok('import_file', { ...G, other_handle: o.handle, action: 'new' });
  assert.equal(nw.projects.length, 1);
  assert.notEqual(nw.projects[0], u.projects[0], 'a Project ID already used gets -1');
  assert.equal((await rowsOf(g.handle, 'TASK', ['task_code'])).length, 2 * n0);
  const refused = await call('import_file', { ...G, path: w2, action: 'update', data: { wbs: 'remove_missing' } });
  assert.match(JSON.stringify(refused.d), /remove_missing is for activities, relationships and assignments/);
  await ok('close', { handle: o.handle, owner_key: o.owner_key, discard: true });
  await ok('close', { ...G, discard: true });
});
