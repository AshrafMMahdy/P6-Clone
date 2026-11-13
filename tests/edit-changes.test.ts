// edit answers `changes: [{id, field, old, new}]` (every value that moved), by the list rule above 25 (25 shown, changes_total, changes_note, a CSV with all of them), and the one shared "saved dates not current" note when the edit leaves the saved dates not current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { getSession } from '../mcp/runtime.ts';
import { describeChanges } from '../core/project/changes.ts';
import { OP_NAMES } from '../core/project/ops.ts';
import { sampleCopy, testRoots } from './helpers.ts';
import { readXerFile } from '../core/xer/parseFile.ts';

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
  // (the activity is not started: its remaining duration follows, and it moved, so it is said)
  assert.deepEqual(e.changes, [{ id: 'A', field: 'Original Duration (days)', old: 3, new: 5 }, { id: 'A', field: 'Remaining Duration (days)', old: 3, new: 5 }]);
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
  // every value that moved: the units a day, and the totals that follow them over the activity's 3 days
  assert.deepEqual(e.changes, [{ id: 'A R1', field: 'Budgeted Units/Time (units a day)', old: 4, new: 6 }, { id: 'A R1', field: 'Budgeted Units', old: 12, new: 18 }, { id: 'A R1', field: 'Remaining Units', old: 12, new: 18 }, { id: 'A R1', field: 'Remaining Units/Time (units a day)', old: 4, new: 6 }]);
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

test('every named operation confirms its change in P6’s words: no column name, no file code, no internal number, no row without a name (a file with two projects)', async () => {
  const p = await call('new_project', { id: 'P', start: '2026-01-05' }), h = p.handle as string;
  const ran = new Set<string>(), lines: string[] = [], answers: any[] = [];
  const RAW = new Set(['set_fields', 'add_row', 'delete_rows']);   // the caller names the table and the column itself
  const FILE_CODE = /^(TT|TK|PR|CS|CP|DT|PT|RT|CT|FT|SD|CA|RV|WS|QT|rcal)_[A-Za-z0-9]+$/;
  const curve = [0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ops: Record<string, unknown>[] = [
    { op: 'add_project', id: 'Q', start: '2026-02-02', name: 'Second' },
    { op: 'add_eps', id: 'E1', name: 'Eps' }, { op: 'add_eps', id: 'E0', name: 'Top' }, { op: 'update_eps', id: 'E1', new_id: 'E2', name: 'Eps 2', parent: 'E0' },
    { op: 'add_financial_period_calendar', name: 'Fiscal' }, { op: 'add_financial_periods', from: '2026-01-01', to: '2026-03-31', every: 'month' },
    { op: 'add_calendar', name: 'Six', work_week: { sat: [['08:00', '12:00']] } },
    { op: 'set_project', project: 'P', name: 'New name', data_date: '2026-01-07', planned_start: '2026-01-06', must_finish_by: '2026-06-01', calendar: 'Six', eps: 'E2', financial_period_calendar: 'Fiscal' },
    { op: 'set_project', project: 'P', new_proj_id: 77 },
    { op: 'set_schedule_options', project: 'P', ss_lag_from_actual_start: true }, { op: 'set_schedule_options', project: 'P', float_paths: true, float_path_method: 'total_float' },
    { op: 'set_schedule_options', project: 'P', logic: 'retained' }, { op: 'set_schedule_options', project: 'P', logic: 'override', lag_calendar: '24h', float_type: 'smallest', critical: 'longest_path', critical_float_hours: 12, ignore_external: true, open_ended_critical: true, use_expected_finish: false },
    { op: 'add_wbs', code: 'W1', name: 'Area 1', project: 'P' }, { op: 'add_wbs', code: 'W3', name: 'Sub', parent: 'W1', project: 'P' }, { op: 'add_wbs', code: 'W2', project: 'P' }, { op: 'add_wbs', code: 'W1', project: 'Q' },
    { op: 'update_wbs', code: 'W1.W3', name: 'Sub two', parent: 'W2', project: 'P' },
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 5, wbs: 'W1', project: 'P' }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 3, project: 'P' }, { op: 'add_activity', id: 'C', name: 'C', duration_days: 2, project: 'P' }, { op: 'add_activity', id: 'D', name: 'D', duration_days: 2, project: 'P' },
    { op: 'add_activity', id: 'A', name: 'A in Q', duration_days: 4, wbs: 'W1', project: 'Q' }, { op: 'add_activity', id: 'X', name: 'X', duration_days: 4, project: 'Q' },
    { op: 'add_relationship', pred: 'A', succ: 'B', project: 'P' }, { op: 'update_relationship', pred: 'A', succ: 'B', new_type: 'SS', lag_days: 2, project: 'P' }, { op: 'set_predecessors', activity: 'C', links: [{ pred: 'A', type: 'FF', lag_days: 1 }], project: 'P' },
    { op: 'link_activities', select: { project: 'P', ids: ['C', 'D'] } }, { op: 'delete_relationship', pred: 'C', succ: 'D', project: 'P' },
    { op: 'add_resource', id: 'R1', name: 'Crew', type: 'labor', max_units_per_day: 8, price_per_unit: 10 }, { op: 'add_resource', id: 'R2', name: 'Crane', type: 'nonlabor' }, { op: 'add_resource', id: 'R3', name: 'Sand', type: 'material' },
    { op: 'update_resource', id: 'R2', new_id: 'R2X', name: 'Crane X', max_units_per_day: 16 },
    { op: 'add_role', id: 'RO1', name: 'Role' }, { op: 'add_role', id: 'RO0', name: 'Top role' }, { op: 'update_role', id: 'RO1', new_id: 'RO2', name: 'Role 2', parent: 'RO0' },
    { op: 'add_resource_curve', name: 'Front', values: curve }, { op: 'update_resource_curve', name: 'Front', new_name: 'Front 2' },
    { op: 'assign_resource', activity: 'A', resource: 'R1', units_per_day: 8, project: 'P' }, { op: 'assign_resource', activity: 'A', resource: 'R1', units_per_day: 8, project: 'Q' }, { op: 'assign_resource', activity: 'B', resource: 'R2X', units_per_day: 8, project: 'P' }, { op: 'assign_resource', activity: 'A', resource: 'R3', units: 20, project: 'P' },
    { op: 'assign_role', activity: 'B', role: 'RO2', units_per_day: 8, project: 'P' },
    { op: 'update_assignment', activity: 'A', resource: 'R1', units_per_day: 4, project: 'P' }, { op: 'update_assignment', activity: 'A', resource: 'R1', units_per_day: 4, project: 'Q' },
    { op: 'update_assignment', activity: 'A', resource: 'R1', remaining_units: 12, project: 'P' }, { op: 'update_assignment', activity: 'A', resource: 'R1', actual_units: 6, project: 'P' }, { op: 'update_assignment', activity: 'A', resource: 'R1', units: 30, project: 'P' },
    { op: 'update_assignment', activity: 'A', resource: 'R1', budgeted_cost: 500, curve: 'Front 2', project: 'P' }, { op: 'update_assignment', activity: 'A', resource: 'R1', actual_cost: 123, project: 'P' }, { op: 'update_assignment', activity: 'A', resource: 'R1', remaining_cost: 300, project: 'P' },
    { op: 'update_assignment', activity: 'B', assigned_role: 'RO2', units_per_day: 4, project: 'P' },
    { op: 'update_activity', id: 'B', name: 'B2', duration_days: 4, type: 'resource_dependent', calendar: 'Six', priority: 'high', constraint: { type: 'start_on_or_after', date: '2026-01-12' }, secondary_constraint: { type: 'finish_on_or_before', date: '2026-03-01' }, wbs: 'W2.W3', project: 'P' },
    { op: 'update_activity', id: 'B', expected_finish: '2026-02-01', primary_resource: 'R2X', project: 'P' }, { op: 'update_activity', id: 'A', duration_days: 9, project: 'P' }, { op: 'update_activity', id: 'A', duration_days: 9, project: 'Q' },
    { op: 'update_activity', id: 'A', actual_start: '2026-01-06 08:00', percent_complete: 40, project: 'P' }, { op: 'update_activity', id: 'D', new_id: 'D9', project: 'P' },
    { op: 'renumber_activities', select: { project: 'Q', ids: ['X'] }, prefix: 'N', start: 10, increment: 10 },
    { op: 'update_calendar', name: 'Six', new_name: 'Six days', work_week: { sat: [['08:00', '16:00']] }, holidays: ['2026-01-19'], work_exceptions: { '2026-01-23': [['08:00', '12:00']] } }, { op: 'update_calendar', name: 'Six days', remove_exceptions: ['2026-01-19'] }, { op: 'add_holidays', calendar: 'Six days', dates: ['2026-01-20'] },
    { op: 'add_code_type', name: 'Phase', values: [{ code: 'P1', name: 'One' }, { code: 'P2', name: 'Two' }] }, { op: 'add_code_type', name: 'Sector', subject: 'project', values: [{ code: 'S1' }] }, { op: 'add_code_type', name: 'Trade', subject: 'resource', values: [{ code: 'T1' }] }, { op: 'add_code_type', name: 'Kind', subject: 'assignment', values: [{ code: 'K1' }] },
    { op: 'add_code_value', type: 'Phase', code: 'P4' }, { op: 'assign_code', type: 'Phase', value: 'P1', activity: 'A', project: 'P' }, { op: 'assign_code', type: 'Sector', value: 'S1', project: 'P' }, { op: 'assign_code', type: 'Trade', value: 'T1', resource: 'R1' }, { op: 'assign_code', type: 'Kind', value: 'K1', activity: 'A', resource: 'R1', project: 'P' },
    { op: 'update_code_type', name: 'Phase', new_name: 'Stage' }, { op: 'update_code_type', name: 'Sector', new_name: 'Sector 2', subject: 'project' }, { op: 'update_code_type', name: 'Trade', new_name: 'Trade 2', subject: 'resource' },
    { op: 'update_code_value', type: 'Stage', code: 'P2', new_code: 'P3', name: 'Three' }, { op: 'update_code_value', type: 'Sector 2', code: 'S1', new_code: 'S9', name: 'Nine', subject: 'project' }, { op: 'update_code_value', type: 'Trade 2', code: 'T1', new_code: 'T9', name: 'Nine', subject: 'resource' },
    { op: 'delete_code_value', type: 'Stage', code: 'P4' },
    { op: 'add_udf', name: 'Zone', data_type: 'text' }, { op: 'set_udf', udf: 'Zone', value: 'North', activity: 'A', project: 'P' }, { op: 'set_udf', udf: 'Zone', value: 'South', activity: 'A', project: 'P' }, { op: 'update_udf', udf: 'Zone', new_name: 'Zone 2' },
    { op: 'set_notebook', activity: 'A', topic: 'Notes', text: 'hello', project: 'P' }, { op: 'set_notebook', activity: 'A', topic: 'Notes', text: 'bye', project: 'P' }, { op: 'set_notebook', wbs: 'W1', topic: 'Scope', text: 'w', project: 'P' }, { op: 'set_notebook', wbs: 'W1', topic: 'Scope', text: 'w2', project: 'P' },
    { op: 'add_cost_account', id: 'CA1', name: 'Acc' }, { op: 'add_cost_account', id: 'CA0', name: 'Top' }, { op: 'update_cost_account', id: 'CA1', new_id: 'CA2', name: 'Acc 2' },
    { op: 'add_expense', activity: 'A', name: 'Permit', budgeted_cost: 100, project: 'P' }, { op: 'add_expense', activity: 'A', name: 'Permit', budgeted_cost: 100, project: 'Q' }, { op: 'add_expense', activity: 'A', name: 'Fee', budgeted_cost: 50, project: 'P' },
    { op: 'update_expense', activity: 'A', name: 'Permit', vendor: 'V', project: 'P' }, { op: 'update_expense', activity: 'A', name: 'Permit', vendor: 'V', project: 'Q' },
    { op: 'update_expense', activity: 'A', name: 'Permit', new_name: 'Permit 2', budgeted_cost: 200, account: 'CA2', po_number: 'PO-1', description: 'd', unit_of_measure: 'ea', units: 2, price_per_unit: 100, actual_cost: 50, project: 'P' },
    { op: 'add_step', activity: 'A', name: 'Step 1', project: 'P' }, { op: 'update_step', activity: 'A', name: 'Step 1', new_name: 'Step one', weight: 2, percent_complete: 50, description: 'sd', project: 'P' }, { op: 'update_step', activity: 'A', name: 'Step one', completed: true, project: 'P' },
    { op: 'set_estimates', activity: 'C', min_days: 1, most_likely_days: 2, max_days: 5, distribution: 'triangle', project: 'P' }, { op: 'set_estimates', activity: 'C', max_days: 6, distribution: 'betapert', project: 'P' },
    { op: 'add_obs', name: 'Obs1' }, { op: 'add_obs', name: 'Obs0' }, { op: 'update_obs', name: 'Obs1', new_name: 'Obs2', description: 'd', parent: 'Obs0' },
    { op: 'add_row', table: 'POBS', fields: { pobs_name: 'Org' } }, { op: 'update_pobs', name: 'Org', new_name: 'Org 2', description: 'od', manager: 'M' },
    { op: 'update_financial_period_calendar', name: 'Fiscal', new_name: 'Fiscal 2' }, { op: 'update_financial_period', name: '2026-01-01', new_name: 'Jan 26' },
    { op: 'set_fields', table: 'PROJECT', fields: { act_this_per_link_flag: 'Y' }, where: { proj_short_name: 'P' } },
    { op: 'set_period_actuals', activity: 'A', period: 'Jan 26', values: { labor_units: 5, labor_cost: 50 }, project: 'P' }, { op: 'set_period_actuals', activity: 'A', period: 'Jan 26', values: { labor_units: 7 }, project: 'P' },
    { op: 'set_period_actuals', activity: 'A', resource: 'R1', period: 'Jan 26', values: { units: 3, cost: 30 }, project: 'P' }, { op: 'set_period_actuals', activity: 'A', resource: 'R1', period: 'Jan 26', values: { units: 4 }, project: 'P' },
    { op: 'store_period_performance', project: 'P', period: 'Jan 26' },
    { op: 'save_baseline', project: 'P', name: 'BL1', assign_as: 'project' }, { op: 'assign_baseline', baseline: 'BL1', as: 'bl1', project: 'P' }, { op: 'build_baseline', project: 'P', name: 'BL2', activities: [{ activity: 'B', duration_days: 6 }] },
    { op: 'update_baseline', baseline: 'BL1', new_name: 'BL1X', name: 'Baseline X' }, { op: 'update_wbs', code: 'W1', name: 'Area one in baseline', project: 'BL1X', in_baseline: true }, { op: 'update_activity', id: 'C', name: 'C in baseline', project: 'BL1X', in_baseline: true },
    { op: 'copy_project', from: 'Q', id: 'Q2' }, { op: 'copy_activities', activities: [{ id: 'C', new_id: 'C2' }], project: 'P' }, { op: 'move_activity', id: 'C2', to_project: 'Q', project: 'P' },
    { op: 'replace_text', pairs: [{ find: 'Crew', replace: 'Team' }, { find: 'Area', replace: 'Zone' }] }, { op: 'clear_descriptions' }, { op: 'clear_authors', project: 'P' }, { op: 'regenerate_guids', project: 'Q' }, { op: 'clear_udfs', project: 'P' }, { op: 'clear_notebooks', project: 'P' },
    { op: 'restore_baseline', baseline: 'BL2' }, { op: 'delete_baseline', baseline: 'BL1X' },
    { op: 'delete_step', activity: 'A', name: 'Step one', project: 'P' }, { op: 'delete_expense', activity: 'A', name: 'Fee', project: 'P' }, { op: 'delete_expenses', project: 'P' },
    { op: 'unassign_resource', activity: 'B', assigned_role: 'RO2', project: 'P' }, { op: 'delete_resource', id: 'R1', clear_references: true }, { op: 'delete_resource_curve', name: 'Front 2' },
    { op: 'delete_udf', udf: 'Zone 2' }, { op: 'delete_code_type', name: 'Stage' }, { op: 'delete_cost_account', id: 'CA2' }, { op: 'add_role', id: 'RO9' }, { op: 'delete_role', id: 'RO9' }, { op: 'delete_obs', name: 'Obs2' }, { op: 'add_eps', id: 'E9' }, { op: 'delete_eps', id: 'E9' },
    { op: 'dissolve_activity', id: 'B', project: 'P' }, { op: 'delete_activity', id: 'D9', project: 'P' }, { op: 'delete_wbs', code: 'W1', project: 'P' },
    { op: 'delete_financial_period', name: 'Jan 26', clear_stored: true }, { op: 'add_financial_period_calendar', name: 'Spare' }, { op: 'delete_financial_period_calendar', name: 'Spare' }, { op: 'delete_calendar', name: 'Six days', replace_with: 'Standard 5 Day Workweek' },
  ];
  const silent: string[] = [];
  for (const op of ops) {
    const name = String(op.op);
    ran.add(name);
    const e = await call('edit', { handle: h, operations: [op] });
    assert.ok(!e.error, `${name}: ${JSON.stringify(e.error)}`);
    answers.push(e);
    if (!(e.changes ?? []).length) silent.push(name);
    const s = getSession(h);
    // the columns no P6 name is recorded for: none for a named operation
    if (!RAW.has(name)) assert.deepEqual(describeChanges(s.db, s.history[s.history.length - 1].j, s.hpd).unnamed, [], `${name}: columns named by their own words`);
    for (const c of (e.changes ?? []) as { id: string; project?: string; field: string; old: unknown; new: unknown }[]) {
      assert.ok(c.id !== '' && !/^ | $|  /.test(c.id), `${name}: a change whose row is not named: ${JSON.stringify(c)}`);
      for (const v of [c.old, c.new]) assert.ok(!(typeof v === 'string' && FILE_CODE.test(v)), `${name}: a file code as a value: ${JSON.stringify(c)}`);
      lines.push(`${name}: [${c.id}${c.project ? ` @${c.project}` : ''}] ${c.field}: ${JSON.stringify(c.old)} -> ${JSON.stringify(c.new)}`);
    }
  }
  // every named operation was run (a new one added to the engine fails here until it is in the list above)
  assert.deepEqual(OP_NAMES.filter((n) => !ran.has(n) && !RAW.has(n)), []);
  // every operation that changed the file says at least one change. The two that say none: the schedule option set to what it already is (nothing
  // changed), and clear_authors, which empties who added or changed a row (no P6 column of the schedule; its own answer counts the fields it cleared)
  assert.deepEqual(silent, ['set_schedule_options', 'clear_authors']);
  assert.ok(lines.length > 150, 'the checks below read real lines');
  // every field these operations were given is one they have: none is reported as not used
  assert.deepEqual(answers.flatMap((e) => ((e.notes ?? []) as string[]).filter((n) => /has no field/.test(n))), []);
  assert.deepEqual(lines.filter((l) => /(: |-> )"\d+"( ->|$)/.test(l) && !/number|Number|Units|Cost|Price|Weight|Hours|days|Duration|Lag|%|Float|paths|Year|Sequence|Limit|Probability|Level/.test(l)), [], 'no bare internal number as a value');
  assert.deepEqual(lines.filter((l) => /^[a-z_]+: \[(\d+|[^\]]* \d{3,})?( @[^\]]*)?\]/.test(l) || /\[(|[^\]]* \/ )\]/.test(l)), [], 'no row named by an internal number, or by nothing');
  assert.deepEqual(lines.filter((l) => { const m = /: ("[^"]*"|[^" ]+) -> ("[^"]*"|[^" ]+)$/.exec(l); return !!m && m[1] === m[2]; }), [], 'no line says a value changed to itself');
  assert.deepEqual(lines.filter((l) => /that is not in the file/.test(l)), [], 'everything a row points at is in this file');
  const said = (line: string) => assert.ok(lines.includes(line), `not said: ${line}\n${lines.filter((l) => l.startsWith(line.split(':')[0] + ':')).join('\n')}`);
  const count = (start: string) => lines.filter((l) => l.startsWith(start)).length;

  // a project: its name, its EPS, its financial period calendar and its internal number by P6's names, never a key
  said('set_project: [P] Project Name: "P" -> "New name"');
  said('set_project: [P] EPS: "Enterprise" -> "E2"');
  said('set_project: [P] Default Calendar: "Standard 5 Day Workweek" -> "Six"');
  said('add_financial_period_calendar: [P] Financial Period Calendar: null -> "Fiscal"');
  said('set_project: [P] Internal project number: 1 -> 77');
  assert.equal(count('set_project: ') , 7, 'a new internal number is one line, not one per row of the project');
  // Schedule Options as the dialog words them; the two whose columns look like calculated ones are said too; "progressed activities" is one
  // option read as the scheduler reads its two columns
  said('set_schedule_options: [P] Calculate start-to-start lag from: "Early Start" -> "Actual Start"');
  said('set_schedule_options: [P] Calculate multiple paths using: null -> "Total Float"');
  assert.equal(count('set_schedule_options: [P] When scheduling progressed activities use: '), 1, 'retained -> retained says nothing; override is said once');
  said('set_schedule_options: [P] When scheduling progressed activities use: "Retained Logic" -> "Progress Override"');
  said('set_schedule_options: [P] Calendar for scheduling Relationship Lag: "Predecessor Activity Calendar" -> "24 Hour Calendar"');
  said('set_schedule_options: [P] Define critical activities as: "Total Float less than or equal to" -> "Longest Path"');
  said('set_schedule_options: [P] Critical activities: Total Float at or below (days): 0 -> 1.5');
  // rows named as the agent names them, with the project when the file has several: a WBS by its path, an activity that is in both projects
  said('update_wbs: [W2.W3 @P] Parent WBS: "W1" -> "W2"');
  said('update_activity: [A @P] Original Duration (days): 5 -> 9');
  said('update_activity: [A @Q] Original Duration (days): 4 -> 9');
  said('update_activity: [B @P] WBS: "P" -> "W2.W3"');
  said('update_activity: [B @P] Expected Finish: null -> "2026-02-01 00:00"');
  said('update_activity: [B @P] Primary Resource: null -> "R2X"');
  said('update_expense: [A / Permit @P] Vendor: null -> "V"');
  said('update_expense: [A / Permit @Q] Vendor: null -> "V"');
  // an assignment: every named value that moved is said, whether a person set it or it followed (the platform does not guess which); a role assignment by its role
  said('update_assignment: [A R1 @P] Remaining Units: 10 -> 12');
  said('update_assignment: [A R1 @P] Actual Regular Units: 0 -> 6');
  said('update_assignment: [A R1 @P] Budgeted Units: 10 -> 30');
  said('update_assignment: [A R1 @P] Curve: null -> "Front 2"');
  said('update_assignment: [A R1 @P] Calculate costs from units: "Yes" -> "No"');
  said('update_assignment: [A R1 @P] Budgeted Cost: 300 -> 500');
  said('update_assignment: [A R1 @P] Actual Regular Cost: 60 -> 123');
  said('update_assignment: [B RO2 @P] Budgeted Units/Time (units a day): 8 -> 4');
  assert.equal(lines.filter((l) => l.startsWith('update_assignment: ') && /Cost: 0 -> 60|Cost: 100 -> 120/.test(l)).length, 2, 'a cost that followed the units (costs calculated from units) moved, so it is said');
  // a calendar, codes of the three subjects, a custom field, notebooks (the text), an expense, a step, estimates in days, the dictionaries with their parents
  said('update_calendar: [Six days] Hours per Year: 208 -> 416');
  said('update_code_type: [Sector 2] Project Code Name: "Sector" -> "Sector 2"');
  said('update_code_value: [Trade 2 = T9] Code Value: "T1" -> "T9"');
  said('update_udf: [Zone 2] User Defined Field Title: "Zone" -> "Zone 2"');
  said('set_notebook: [A / Notes @P] Notebook Text: "hello" -> "bye"');
  said('set_notebook: [W1 / Scope @P] Notebook Text: "w" -> "w2"');
  said('update_expense: [A / Permit 2 @P] Cost Account: null -> "CA2"');
  said('update_step: [A / Step one @P] Completed: "No" -> "Yes"');
  said('set_estimates: [C @P] Maximum Remaining Duration (days): 5 -> 6');
  said('update_eps: [E2] Parent EPS: "Enterprise" -> "E0"');
  said('update_role: [RO2] Parent Role: null -> "RO0"');
  said('update_obs: [Obs2] Parent OBS: null -> "Obs0"');
  said('update_pobs: [Org 2] Performing Organization Manager: null -> "M"');
  said('update_financial_period: [Jan 26] Financial Period Name: "2026-01-01" -> "Jan 26"');
  said('set_period_actuals: [A / Jan 26 @P] Actual Labor Units: 5 -> 7');
  said('set_period_actuals: [A R1 / Jan 26 @P] Actual Units: 3 -> 4');
  said('store_period_performance: [P] Last Financial Period Stored: null -> "Jan 26"');
  // a baseline: renamed once, its rows named with it; deleted as ONE line; what pointed at a deleted row is said by that row's name
  said('update_baseline: [BL1X] Baseline Name: "BL1" -> "BL1X"');
  said('update_wbs: [W1 in baseline BL1X @P] WBS Name: "Area 1" -> "Area one in baseline"');
  said('update_activity: [C in baseline BL1X @P] Activity Name: "C" -> "C in baseline"');
  said('delete_baseline: [BL1X] baseline: "exists" -> "deleted"');
  said('delete_baseline: [P] Primary Baseline: "BL1X" -> null');
  assert.equal(lines.filter((l) => l.startsWith('delete_baseline: ') && /activity|relationship|WBS|assignment/.test(l)).length, 0, 'none of the deleted baseline’s rows one by one');
  said('delete_financial_period: [P] Last Financial Period Stored: "Jan 26" -> null');
  said('delete_calendar: [P] Default Calendar: "Six days" -> "Standard 5 Day Workweek"');
  // a deleted resource: each of its assignments named by the resource's ID, in each project
  said('delete_resource: [A R1 @P] resource assignment: "exists" -> "deleted"');
  said('delete_resource: [A R1 @Q] resource assignment: "exists" -> "deleted"');
  said('unassign_resource: [B RO2 @P] resource assignment: "exists" -> "deleted"');
  // the bulk operations: no GUID, author or date line; clear_descriptions leaves the notebook topics their names
  assert.equal(count('regenerate_guids: '), 1);
  assert.equal(count('clear_authors: '), 0);
  assert.equal(lines.filter((l) => l.startsWith('clear_descriptions: ') && /Notebook Topic/.test(l)).length, 0);
  const topics = (await call('read_table', { handle: h, table: 'MEMOTYPE' })).rows as unknown[][];
  assert.ok(topics.length >= 2 && topics.every((r) => r.every((v) => v !== '' && v != null) ), `the notebook topics keep their keys and names: ${JSON.stringify(topics)}`);
  assert.ok(lines.length > 150, `${lines.length} changes were checked`);
});

test('schedule options changed through the raw table are read as the scheduler reads them; two rows that change alike are two changes', async () => {
  const p = await call('new_project', { id: 'RAWOPT', start: '2026-01-05' }), h = p.handle as string;
  let e = await call('edit', { handle: h, operations: [act('A'), { op: 'set_schedule_options', logic: 'retained' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  // override Y beside retained Y: the scheduler follows override (optionsFor in cpm.ts), and the answer says so
  e = await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'SCHEDOPTIONS', fields: { sched_progress_override: 'Y' } , all: true }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual(e.changes, [{ id: 'RAWOPT', field: 'When scheduling progressed activities use', old: 'Retained Logic', new: 'Progress Override' }]);
  // a real file with no schedule options saved (small_villa): the first one set is said from "nothing saved", not from a value the file never held
  const o = await call('open_file', { path: sampleCopy('small_villa_g_1_schedule.xer'), lenient: true });
  assert.ok(o.handle, JSON.stringify(o).slice(0, 200));
  assert.equal(readXerFile(sampleCopy('small_villa_g_1_schedule.xer')).db.tables.SCHEDOPTIONS, undefined, 'the file holds no schedule options');
  const first = await call('edit', { handle: o.handle, operations: [{ op: 'set_schedule_options', logic: 'retained', lag_calendar: 'successor' }] });
  assert.ok(!first.error, JSON.stringify(first.error));
  const proj = first.results[0].project;
  assert.deepEqual(first.changes, [{ id: proj, field: 'When scheduling progressed activities use', old: null, new: 'Retained Logic' }, { id: proj, field: 'Calendar for scheduling Relationship Lag', old: null, new: 'Successor Activity Calendar' }]);
  // the same resource twice on one activity, both changed alike: two lines
  e = await call('edit', { handle: h, operations: [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, { op: 'assign_resource', activity: 'A', resource: 'R', units_per_day: 8 }, { op: 'assign_resource', activity: 'A', resource: 'R', units_per_day: 8, allow_duplicate: true }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  e = await call('edit', { handle: h, operations: [{ op: 'update_assignment', activity: 'A', resource: 'R', nth: 1, units_per_day: 4 }, { op: 'update_assignment', activity: 'A', resource: 'R', nth: 2, units_per_day: 4 }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.equal(e.changes.filter((c: any) => c.field === 'Budgeted Units/Time (units a day)' && c.old === 8 && c.new === 4).length, 2, JSON.stringify(e.changes));
});

// The same rules on files P6 wrote (its rows carry columns a built file does not: a resource row has role_id, numbers are written "450.00") and on the states a built file
// does not reach: a day of another length, a baseline read from a file, a relationship to a project the same edit made.
test('real files: a deleted resource by its ID, no line from a value to itself, days of the session, a restored baseline, a tie to a new project', async () => {
  const lines = (e: any) => ((e.changes ?? []) as any[]).map((c) => `[${c.id}${c.project ? ` @${c.project}` : ''}] ${c.field}: ${JSON.stringify(c.old)} -> ${JSON.stringify(c.new)}`);
  const unnamedOf = (h: string) => { const s = getSession(h); return describeChanges(s.db, s.history[s.history.length - 1].j, s.hpd).unnamed; };
  const noRawRow = (l: string[], what: string) => assert.deepEqual(l.filter((x) => /^\[\d+( @[^\]]*)?\]/.test(x) || /"\d+" -> |-> "\d+"$/.test(x)), [], what);
  // 129 trial: a resource P6 wrote, with a role and 22 assignments
  let h = (await call('open_file', { path: sampleCopy('129 trial.xer') })).handle as string;
  let e = await call('edit', { handle: h, operations: [{ op: 'delete_resource', id: 'SV', clear_references: true }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  const all = readFileSync(/all \d+ in (.+\.csv)\.$/.exec(e.changes_note)![1], 'utf8').trim().split(/\r?\n/);
  assert.equal(all.filter((l) => l.startsWith('"SV","resource",')).length, 1, 'the resource is named by its Resource ID');
  assert.equal(all.filter((l) => /^"[^"]+ SV","resource assignment",/.test(l)).length, 22);
  assert.deepEqual(unnamedOf(h), []);
  noRawRow(lines(e), 'delete_resource');
  // a baseline and a copy of a project with 212 project-level activity code values: one line each
  e = await call('edit', { handle: h, operations: [{ op: 'save_baseline', name: 'BLX' }] });
  assert.deepEqual(lines(e), ['[BLX] baseline: null -> "added"']);
  // 130 TRIAL: units changed on an assignment whose money P6 wrote as "450.00": the price did not change, and is not said
  h = (await call('open_file', { path: sampleCopy('130 TRIAL.xer') })).handle as string;
  e = await call('edit', { handle: h, operations: [{ op: 'update_assignment', activity: 'BTAB1416', resource: 'CM', units: 99 }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual(lines(e).filter((l) => /Price|Actual/.test(l)), []);
  assert.ok(lines(e).includes('[BTAB1416 CM] Budgeted Units: 9 -> 99') && lines(e).includes('[BTAB1416 CM] Budgeted Cost: 4050 -> 44550'), JSON.stringify(lines(e)));
  // Enppi opened with a 10-hour day (its calendars give no day length): 1,344 hours are 134.4 days, as get_activity says
  h = (await call('open_file', { path: sampleCopy('Enppi.xer'), hours_per_day: 10 })).handle as string;
  const before = Number(getSession(h).db.tables.TASK.rows.find((t) => t.task_code === '4229PPC140')!.target_drtn_hr_cnt) / 10; // (the row's own hours)
  e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: '4229PPC140', project: '4229 update 2-6-12', duration_days: 5 }] });
  assert.deepEqual([before, lines(e)[0]], [134.4, '[4229PPC140 @4229 update 2-6-12] Original Duration (days): 134.4 -> 5']);
  // Tower-A: a baseline read from the file, restored: it says so, in one line, with no column word and no internal number
  { let o = await call('open_file', { path: sampleCopy('Tower-A.xer') }); if (!o.handle) o = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true }); h = o.handle as string; }
  e = await call('edit', { handle: h, operations: [{ op: 'restore_baseline', baseline: 'TOWER-A-BL1' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual(lines(e), ['[TOWER-A-BL1] baseline: "baseline of TOWER-A" -> "restored as a project"']);
  assert.deepEqual(unnamedOf(h), []);
  // a project made in the edit that ties an existing project to it: the relationship is the existing project's logic too, so it is said, and its dates are no longer current
  h = (await call('new_project', { id: 'EC', start: '2026-03-02' })).handle as string;
  await call('edit', { handle: h, operations: [act('A'), act('B'), { op: 'add_relationship', pred: 'A', succ: 'B' }] });
  await call('schedule', { handle: h });
  e = await call('edit', { handle: h, operations: [{ op: 'add_project', id: 'Q', start: '2026-03-02' }, { op: 'add_activity', id: 'X', name: 'X', duration_days: 30, project: 'Q' }, { op: 'add_relationship', pred: 'X', pred_project: 'Q', succ: 'A', succ_project: 'EC' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual(lines(e), ['[Q] project: null -> "added"', '[X in Q FS A in EC] relationship: null -> "added"']);
  assert.ok((e.notes as string[]).some((n) => /^The saved dates of EC are not what a recalculation gives/.test(n)), JSON.stringify(e.notes));
});

test('a field an operation does not have is said, not taken in silence', async () => {
  const h = await project();
  const e = await call('edit', { handle: h, operations: [{ op: 'update_resource', id: 'R1', name: 'Crew 2', calendar: 'Six days', price_per_unit: 55 }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual((e.notes as string[]).filter((n) => /has no field/.test(n)), ['update_resource has no field "calendar"; the operation ran without it.', 'update_resource has no field "price_per_unit"; the operation ran without it.']);
  assert.deepEqual(e.changes.map((c: any) => [c.id, c.field, c.new]), [['R1', 'Resource Name', 'Crew 2']]);
});

test('a baseline saved in the session and restored says so; schedule options that change the dates mark them; a completed activity keeps its 100 %', async () => {
  const h = await project();
  await call('schedule', { handle: h });
  let e = await call('edit', { handle: h, operations: [{ op: 'save_baseline', name: 'B1' }] });
  e = await call('edit', { handle: h, operations: [{ op: 'restore_baseline', baseline: 'B1' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.deepEqual(e.changes, [{ id: 'B1', field: 'baseline', old: 'baseline of EC', new: 'restored as a project' }]);
  // an option that changes what the scheduler gives: the saved dates are compared again, and said when they differ
  const g = await project([{ op: 'update_activity', id: 'A', actual_start: '2026-03-02 08:00', remaining_days: 2 }, { op: 'update_activity', id: 'C', actual_start: '2026-03-03 08:00', remaining_days: 3 }]);
  await call('schedule', { handle: g, data_date: '2026-03-09' });
  e = await call('edit', { handle: g, operations: [{ op: 'set_schedule_options', logic: 'override' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  const sched = await call('schedule', { handle: g, dry_run: true });
  const differs = await call('critical_path', { handle: g });
  assert.equal(((e.notes ?? []) as string[]).some((n) => STALE.test(n)), ((differs.notes ?? []) as string[]).some((n) => /are not what a recalculation gives/.test(n)), `the edit says what the next analysis would: ${JSON.stringify([e.notes, differs.notes, sched.error])}`);
  // a completed activity: a % complete below 100 is refused (it set a remaining duration on finished work)
  e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', project: 'EC', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-04 17:00' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  e = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', project: 'EC', percent_complete: 55 }] });
  assert.match(e.error?.message ?? '', /The activity is complete \(it has an actual finish\)/);
});
