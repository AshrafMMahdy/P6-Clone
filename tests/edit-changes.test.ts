// edit answers `changes: [{id, field, old, new}]` (every value that moved), by the list rule above 25 (25 shown, changes_total, changes_note, a CSV with all of them), and the one shared "saved dates not current" note when the edit leaves the saved dates not current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
const act = (id: string, d = 3) => ({ op: 'add_activity', id, name: id, duration_days: d });
async function project(extra: unknown[] = []) {
  const p = await call('new_project', { id: 'EC', start: '2026-03-02' });
  const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_resource', id: 'R1', max_units_per_day: 8 }, act('A'), act('B'), act('C'), { op: 'add_relationship', pred: 'A', succ: 'B' }, ...extra] });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  await call('schedule', { handle: p.handle });   // the saved dates are current
  return p.handle as string;
}
const STALE = /^The saved dates of EC are not what a recalculation gives \(\d+ of \d+ open activit(?:y|ies) differs?\)(?:: these figures are of the saved dates)?; run schedule to recalculate them\.$/;

test('a duration change is old -> new in days; the saved dates are then not current, said once', async () => {
  const h = await project();
  const e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', duration_days: 5 }] });
  assert.deepEqual(e.changes, [{ id: 'A', field: 'Original Duration (days)', old: 3, new: 5 }]);
  assert.equal(e.notes.filter((n: string) => STALE.test(n)).length, 1, JSON.stringify(e.notes));
  assert.equal(e.changes_total, undefined); assert.equal(e.changes_note, undefined);
  // schedule makes them current again: the next edit that moves no date says nothing about them
  await call('schedule', { handle: h });
  const n = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', name: 'Renamed' }] });
  assert.deepEqual(n.changes, [{ id: 'A', field: 'Activity Name', old: 'A', new: 'Renamed' }]);
  assert.equal((n.notes ?? []).filter((x: string) => STALE.test(x)).length, 0);
});

test('a relationship added and deleted, an activity added and deleted, an assignment added and deleted', async () => {
  const h = await project();
  const add = await call('edit', { handle: h, operations: [{ op: 'add_relationship', pred: 'B', succ: 'C', type: 'SS' }, act('D'), { op: 'assign_resource', activity: 'A', resource: 'R1' }] });
  assert.deepEqual(add.changes.map((c: any) => [c.id, c.field, c.old, c.new]).sort(), [['A R1', 'resource assignment', null, 'added'], ['B SS C', 'relationship', null, 'added'], ['D', 'activity', null, 'added']]);
  assert.equal(add.notes.filter((n: string) => STALE.test(n)).length, 1, 'once for the whole answer');
  const del = await call('edit', { handle: h, operations: [{ op: 'delete_relationship', pred: 'B', succ: 'C', type: 'SS' }, { op: 'delete_activity', id: 'D' }, { op: 'unassign_resource', activity: 'A', resource: 'R1' }] });
  assert.deepEqual(del.changes.map((c: any) => [c.id, c.field, c.old, c.new]).sort(), [['A R1', 'resource assignment', 'exists', 'deleted'], ['B SS C', 'relationship', 'exists', 'deleted'], ['D', 'activity', 'exists', 'deleted']]);
});

test('an assignment edited: its units a day, old -> new', async () => {
  const h = await project([{ op: 'assign_resource', activity: 'A', resource: 'R1', units_per_day: 4 }]);
  const e = await call('edit', { handle: h, operations: [{ op: 'update_assignment', activity: 'A', resource: 'R1', units_per_day: 6 }] });
  assert.deepEqual(e.changes, [{ id: 'A R1', field: 'Budgeted Units/Time (units a day)', old: 4, new: 6 }]);
});

test('more than 25 changes: 25 shown, the total, the cut note naming a CSV that holds all of them', async () => {
  const h = await project();
  const ops = Array.from({ length: 30 }, (_, i) => act(`N${i + 1}`));
  const e = await call('edit', { handle: h, operations: ops });
  assert.equal(e.changes.length, 25);
  assert.equal(e.changes_total, 30);
  const m = /^25 of 30 shown; all 30 in (.+\.csv)\.$/.exec(e.changes_note);
  assert.ok(m, e.changes_note);
  const lines = readFileSync(m![1], 'utf8').trim().split(/\r?\n/);
  assert.equal(lines[0], 'id,field,old,new');
  assert.equal(lines.length - 1, 30, 'the CSV holds every change');
  assert.ok(lines.some((l) => l.startsWith('"N30","activity"')));
  assert.equal(e.notes.filter((n: string) => STALE.test(n)).length, 1, 'once, however many changes');
});

test('an edit that moves no date says nothing about the saved dates', async () => {
  const h = await project();
  const e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'C', name: 'Third' }] });
  assert.deepEqual(e.changes, [{ id: 'C', field: 'Activity Name', old: 'C', new: 'Third' }]);
  assert.equal(e.notes, undefined);
});

test('float_paths reads the saved dates: when they are not current it says so once, and not when they are', async () => {
  const h = await project();
  const clean = await call('float_paths', { handle: h });
  assert.equal(clean.notes, undefined);
  await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', duration_days: 9 }] });
  const stale = await call('float_paths', { handle: h });
  assert.equal(stale.notes.filter((n: string) => STALE.test(n)).length, 1, JSON.stringify(stale.notes));
  await call('schedule', { handle: h });
  assert.equal((await call('float_paths', { handle: h })).notes, undefined);
});
