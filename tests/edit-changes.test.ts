// edit answers `changes: [{id, field, old, new}]` (every value that moved), by the list rule above 25 (25 shown, changes_total, changes_note, a CSV with all of them), and the one shared "saved dates not current" note when the edit leaves the saved dates not current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { getSession } from '../mcp/runtime.ts';
import { describeChanges } from '../core/project/changes.ts';
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

test('every named operation confirms its change in P6’s words: no column name, no file code, no internal number, no row without a name', async () => {
  const p = await call('new_project', { id: 'P', start: '2026-01-05' }), h = p.handle as string;
  const all: { op: string; id: string; field: string; old: unknown; new: unknown }[] = [];
  const edit = async (op: Record<string, unknown>) => {
    const e = await call('edit', { handle: h, operations: [op] });
    assert.ok(!e.error, `${op.op}: ${JSON.stringify(e.error)}`);
    // the columns no P6 name is recorded for (right only for set_fields, where the caller names the column): none for a named operation
    const s = getSession(h);
    assert.deepEqual(describeChanges(s.db, s.history[s.history.length - 1].j, s.hpd).unnamed, [], `${op.op}: columns named by their own words`);
    const ch = (e.changes ?? []) as { id: string; field: string; old: unknown; new: unknown }[];
    for (const c of ch) {
      all.push({ op: String(op.op), ...c });
      assert.ok(c.id !== '', `${op.op}: a change with no name: ${JSON.stringify(c)}`);
      for (const v of [c.old, c.new]) assert.ok(!(typeof v === 'string' && /^[A-Za-z]{2,6}_[A-Za-z0-9]+$/.test(v)), `${op.op}: a file code as a value: ${JSON.stringify(c)}`);
      assert.ok(!/^[a-z]/.test(c.field) || ['activity', 'relationship', 'resource', 'resource assignment', 'calendar', 'project', 'baseline'].includes(c.field), `${op.op}: ${c.field}`);
    }
    return { e, ch };
  };
  const one = (ch: { id: string; field: string; old: unknown; new: unknown }[], field: string) => { const c = ch.filter((x) => x.field === field); assert.equal(c.length, 1, `${field}: ${JSON.stringify(ch)}`); return [c[0].id, c[0].old, c[0].new]; };
  for (const op of [{ op: 'add_wbs', code: 'W1', name: 'Area 1' }, { op: 'add_wbs', code: 'W2' }, { op: 'add_calendar', name: 'Six', work_week: { sat: [['08:00', '12:00']] } }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5, wbs: 'W1' }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 3 }, { op: 'add_activity', id: 'C', name: 'C', duration_days: 2 },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_resource', id: 'R1', name: 'Crew', type: 'labor', max_units_per_day: 8 }, { op: 'assign_resource', activity: 'A', resource: 'R1', units_per_day: 8 }, { op: 'add_code_type', name: 'Phase', values: [{ code: 'P1', name: 'One' }, { code: 'P2', name: 'Two' }] },
    { op: 'add_udf', name: 'Zone', data_type: 'text' }, { op: 'add_cost_account', id: 'CA1', name: 'Acc' }, { op: 'add_expense', activity: 'A', name: 'Permit', budgeted_cost: 100 }, { op: 'add_step', activity: 'A', name: 'Step 1' }, { op: 'add_eps', id: 'E1', name: 'Eps' }, { op: 'add_obs', name: 'Obs1' }, { op: 'add_role', id: 'RO1', name: 'Role' },
    { op: 'add_resource_curve', name: 'Front', values: [0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, { op: 'set_notebook', activity: 'A', topic: 'Notes', text: 'hello' }]) await edit(op);

  // Schedule Options, as the dialog words them; the two columns of "progressed activities" are one option; the float is echoed in the unit given
  let r = await edit({ op: 'set_schedule_options', logic: 'override', lag_calendar: '24h', float_type: 'finish', critical: 'longest_path', critical_float_days: 2, float_paths: true, float_path_end: 'C', float_path_method: 'total_float', ignore_external: true, open_ended_critical: true, use_expected_finish: false });
  assert.deepEqual(one(r.ch, 'When scheduling progressed activities use'), ['P', 'Retained Logic', 'Progress Override']);
  assert.deepEqual(one(r.ch, 'Calendar for scheduling Relationship Lag'), ['P', 'Predecessor Activity Calendar', '24 Hour Calendar']);
  assert.deepEqual(one(r.ch, 'Define critical activities as'), ['P', 'Total Float less than or equal to', 'Longest Path']);
  assert.deepEqual(one(r.ch, 'Ignore relationships to and from other projects'), ['P', 'No', 'Yes']);
  assert.deepEqual(one(r.ch, 'Display multiple float paths ending with activity'), ['P', null, 'C']);
  assert.deepEqual(one(r.ch, 'Critical activities: Total Float at or below (days)'), ['P', 0, 2]);
  assert.ok(r.e.results[0].set.includes('critical_float_days 2') && !r.e.results[0].set.some((x: string) => x.startsWith('critical_float_hours')), JSON.stringify(r.e.results));
  r = await edit({ op: 'set_schedule_options', logic: 'actual' });
  assert.deepEqual(one(r.ch, 'When scheduling progressed activities use'), ['P', 'Progress Override', 'Actual Dates']);

  // a project: its name is the Project Name (the root WBS node carries it); a new ID is said once
  r = await edit({ op: 'set_project', name: 'New name', calendar: 'Six' });
  assert.deepEqual(one(r.ch, 'Project Name'), ['P', 'P', 'New name']);
  assert.deepEqual(one(r.ch, 'Default Calendar'), ['P', 'Standard 5 Day Workweek', 'Six']);
  r = await edit({ op: 'set_project', new_id: 'PX' });
  assert.deepEqual(r.ch, [{ id: 'PX', field: 'Project ID', old: 'P', new: 'PX' }]);

  // an activity: its WBS by code, its expected finish, its primary resource by Resource ID
  await edit({ op: 'update_activity', id: 'A', primary_resource: '' });
  r = await edit({ op: 'update_activity', id: 'A', wbs: 'W2', expected_finish: '2026-02-01', primary_resource: 'R1' });
  assert.deepEqual(one(r.ch, 'WBS'), ['A', 'W1', 'W2']);
  assert.deepEqual(one(r.ch, 'Expected Finish'), ['A', null, '2026-02-01 00:00']);
  assert.deepEqual(one(r.ch, 'Primary Resource'), ['A', null, 'R1']);

  // an assignment: the curve by its name, a cost a person entered, costs no longer calculated from units
  r = await edit({ op: 'update_assignment', activity: 'A', resource: 'R1', budgeted_cost: 500, curve: 'Front' });
  assert.deepEqual(one(r.ch, 'Curve'), ['A R1', null, 'Front']);
  assert.deepEqual(one(r.ch, 'Calculate costs from units'), ['A R1', 'Yes', 'No']);
  assert.equal(one(r.ch, 'Budgeted Cost')[2], '500');
  r = await edit({ op: 'assign_role', activity: 'B', role: 'RO1', units_per_day: 8 });
  r = await edit({ op: 'update_assignment', activity: 'B', assigned_role: 'RO1', units_per_day: 4 });
  assert.deepEqual(one(r.ch, 'Budgeted Units/Time (units a day)'), ['B RO1', 8, 4]);

  // codes, a custom field, a notebook (its text, not the HTML the file keeps), an expense, a step, the dictionaries
  r = await edit({ op: 'update_code_type', name: 'Phase', new_name: 'Stage' });
  assert.deepEqual(r.ch, [{ id: 'Stage', field: 'Activity Code Name', old: 'Phase', new: 'Stage' }]);
  r = await edit({ op: 'update_code_value', type: 'Stage', code: 'P2', new_code: 'P3', name: 'Three' });
  assert.deepEqual(r.ch, [{ id: 'Stage = P3', field: 'Code Value', old: 'P2', new: 'P3' }, { id: 'Stage = P3', field: 'Description', old: 'Two', new: 'Three' }]);
  r = await edit({ op: 'update_udf', udf: 'Zone', new_name: 'Zone 2' });
  assert.deepEqual(r.ch, [{ id: 'Zone 2', field: 'User Defined Field Title', old: 'Zone', new: 'Zone 2' }]);
  r = await edit({ op: 'set_notebook', activity: 'A', topic: 'Notes', text: 'bye' });
  assert.deepEqual(r.ch, [{ id: 'A / Notes', field: 'Notebook Topic', old: 'hello', new: 'bye' }]);
  r = await edit({ op: 'update_expense', activity: 'A', name: 'Permit', new_name: 'Permit 2', budgeted_cost: 200, account: 'CA1', vendor: 'V', po_number: 'PO-1', description: 'd', unit_of_measure: 'ea' });
  assert.deepEqual(one(r.ch, 'Expense Item'), ['A / Permit 2', 'Permit', 'Permit 2']);
  assert.deepEqual(one(r.ch, 'Cost Account'), ['A / Permit 2', null, 'CA1']);
  assert.deepEqual(one(r.ch, 'Vendor'), ['A / Permit 2', null, 'V']);
  r = await edit({ op: 'update_step', activity: 'A', name: 'Step 1', new_name: 'Step one', weight: 2, completed: true });
  assert.deepEqual(one(r.ch, 'Step Name'), ['A / Step one', 'Step 1', 'Step one']);
  assert.deepEqual(one(r.ch, 'Completed'), ['A / Step one', 'No', 'Yes']);
  r = await edit({ op: 'update_cost_account', id: 'CA1', new_id: 'CA2', name: 'Acc 2' });
  assert.deepEqual(r.ch, [{ id: 'CA2', field: 'Cost Account ID', old: 'CA1', new: 'CA2' }, { id: 'CA2', field: 'Cost Account Name', old: 'Acc', new: 'Acc 2' }]);
  r = await edit({ op: 'update_eps', id: 'E1', new_id: 'E2', name: 'Eps 2' });
  assert.deepEqual(one(r.ch, 'EPS ID'), ['E2', 'E1', 'E2']);
  r = await edit({ op: 'update_obs', name: 'Obs1', new_name: 'Obs2', description: 'd' });
  assert.deepEqual(one(r.ch, 'OBS Name'), ['Obs2', 'Obs1', 'Obs2']);
  r = await edit({ op: 'update_role', id: 'RO1', new_id: 'RO2', name: 'Role 2' });
  assert.deepEqual(one(r.ch, 'Role ID'), ['RO2', 'RO1', 'RO2']);
  r = await edit({ op: 'update_resource_curve', name: 'Front', new_name: 'Front 2' });
  assert.deepEqual(r.ch, [{ id: 'Front 2', field: 'Resource Curve Name', old: 'Front', new: 'Front 2' }]);

  // a baseline renamed (its ID once, its name as the Project Name), then deleted: ONE line for the baseline, the slots it filled by its name,
  // and none of its activities, WBS elements, relationships or assignments row by row
  await edit({ op: 'save_baseline', name: 'BL1', assign_as: 'project' });
  await edit({ op: 'assign_baseline', baseline: 'BL1', as: 'bl1' });
  r = await edit({ op: 'update_baseline', baseline: 'BL1', new_name: 'BL1X', name: 'Baseline X' });
  assert.deepEqual(r.ch, [{ id: 'BL1X', field: 'Project ID', old: 'BL1', new: 'BL1X' }, { id: 'BL1X', field: 'Project Name', old: 'New name', new: 'Baseline X' }]);
  r = await edit({ op: 'delete_baseline', baseline: 'BL1X' });
  const lines = (x: unknown[]) => x.map((c) => JSON.stringify(c)).sort();
  assert.deepEqual(lines(r.ch), lines([{ id: 'PX', field: 'Primary Baseline', old: 'BL1X', new: null }, { id: 'PX', field: 'Project Baseline', old: 'BL1X', new: null }, { id: 'BL1X', field: 'baseline', old: 'exists', new: 'deleted' }]));
  // a calendar deleted: what used it names the deleted calendar by its name
  r = await edit({ op: 'delete_calendar', name: 'Six', replace_with: 'Standard 5 Day Workweek' });
  assert.deepEqual(one(r.ch, 'Default Calendar'), ['PX', 'Six', 'Standard 5 Day Workweek']);
  assert.ok(all.length > 60, `${all.length} changes were checked`);
});
