// The notes of the schedule tools (ledger item 25, findings 1-11 and the ones that share their code): each condition is built, and the corrected note is asserted: true value, present, with its next step, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { setRoots } from '../mcp/runtime.ts';
import { SAMPLES_DIR } from './helpers.ts';

setRoots(join(import.meta.dirname, '..'), mkdtempSync(join(tmpdir(), 'p6-notes-a-')));
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
/** A project made in the clone: new_project, then the operations. */
async function built(start: string, ops: unknown[], id = 'P'): Promise<string> {
  const p = await call('new_project', { id, start });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  return p.handle;
}
const act = (id: string, d: number, more: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...more });
const rel = (pred: string, succ: string, extra: Record<string, unknown> = {}) => ({ op: 'add_relationship', pred, succ, ...extra });
const count = (text: string, part: string) => text.split(part).length - 1;

test('1: an unmet relationship is given in days, not minutes called hours', async () => {
  const h = await built('2026-01-05', [act('A1', 10), act('A5', 2, { constraint: { type: 'mandatory_finish', date: '2026-01-07' } }), rel('A1', 'A5')]);
  const s = await call('schedule', { handle: h });
  const sec = s.log.exceptions.find((x: any) => x.code === 'RELATIONSHIP_UNMET');
  assert.ok(sec, JSON.stringify(s.log.exceptions.map((x: any) => x.code)));
  const detail: string = sec.activities[0].detail;
  assert.match(detail, /^A1 FS A5 is not met by \d+(\.\d+)? days\.$/);
  assert.doesNotMatch(detail, / h /);
  // the same function in trace_logic: days, not hours of minutes
  const t = await call('trace_logic', { handle: h, activity_id: 'A5' });
  const link = t.links.find((l: any) => l.pred === 'A1');
  assert.ok(link.free_float_days <= 0 && link.free_float_days > -30, `free_float_days ${link.free_float_days}`);
});

test('38: constraints are named by P6 and the scheduled date stands beside the constraint date; each unmet fact is said once', async () => {
  const h = await built('2026-01-05', [act('A1', 10), act('A5', 2, { constraint: { type: 'finish_on_or_before', date: '2026-01-09' } }), act('M', 3, { constraint: { type: 'mandatory_finish', date: '2026-01-06' } }), rel('A1', 'A5'), rel('A1', 'M')]);
  const s = await call('schedule', { handle: h });
  const unmet = s.log.exceptions.find((x: any) => x.code === 'CONSTRAINT_UNMET');
  const text = JSON.stringify(unmet);
  assert.match(text, /Finish On or Before 2026-01-09/);
  assert.match(text, /Mandatory Finish 2026-01-06/);
  assert.match(text, /\(scheduled 2026-01-\d\d \d\d:\d\d\)/);
  assert.doesNotMatch(text, /MEOB|MANDFIN|CS_/);
  // 31: the log is P6's own content, said once there: no second list of it in the answer
  assert.equal(s.warnings, undefined);
  assert.equal(s.notes, undefined);
  assert.ok(s.log.exceptions.some((x: any) => x.code === 'RELATIONSHIP_UNMET'));
  assert.equal(count(text, 'MEOB'), 0);
  // 36: statistics once, with dates
  assert.equal(s.log.statistics, undefined);
  assert.match(s.stats.finish, /^2026-/);
  assert.match(s.stats.dataDate, /^2026-01-05/);
});

test('39: negative float is given in days, like every other answer', async () => {
  const h = await built('2026-01-05', [act('A1', 10), act('A5', 2, { constraint: { type: 'finish_on_or_before', date: '2026-01-09' } }), rel('A1', 'A5')]);
  const s = await call('schedule', { handle: h });
  const neg = s.log.exceptions.find((x: any) => x.code === 'NEGATIVE_FLOAT');
  assert.match(neg.activities[0].detail, /^A\d has -\d+(\.\d+)? days? of total float\.$/);
  assert.doesNotMatch(neg.activities[0].detail, / h /);
  assert.equal(s.warnings, undefined);
});

test('3: a loop is described as a set of activities, not as a path', async () => {
  const r = await call('compute_schedule', { start: '2026-01-05', break_loops: false, activities: [{ id: 'A', duration_days: 1 }, { id: 'B', duration_days: 1 }, { id: 'C', duration_days: 1 }, { id: 'D', duration_days: 1 }], relationships: [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }, { pred: 'B', succ: 'D' }, { pred: 'C', succ: 'A' }, { pred: 'D', succ: 'A' }] });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'Loop: A, B, C, D are in a loop.');
  assert.doesNotMatch(r.error.message, /→/);
  assert.match(r.error.hint, /pass break_loops: true/);
  assert.deepEqual(r.error.loops, [['A', 'B', 'C', 'D']]);
});

test('2 and 28: validate follows the scheduler on loops through a level of effort, and names Activity IDs', async () => {
  const h = await built('2026-01-05', [act('A', 2), act('B', 2), { op: 'add_activity', id: 'L', name: 'L', type: 'level_of_effort' }, rel('A', 'B')]);
  // a chain through a level of effort is no loop: the relationships are added around it
  await call('edit', { handle: h, operations: [rel('B', 'L'), rel('L', 'A')] });
  const s = await call('schedule', { handle: h });
  assert.deepEqual(s.loops, []);
  const v = await call('validate', { handle: h });
  assert.ok(!JSON.stringify(v).includes('REL_LOOP'), 'no loop is reported through a level of effort');
});

test('2: Enppi (a loop only through a level of effort) is not reported as a loop by validate or the open diagnostics', async () => {
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'Enppi.xer') });
  assert.ok(!JSON.stringify(o.diagnostics).includes('REL_LOOP'));
  const v = await call('validate', { handle: o.handle });
  assert.ok(!JSON.stringify(v).includes('loop'), JSON.stringify(v).slice(0, 300));
  const s = await call('schedule', { handle: o.handle });
  assert.deepEqual(s.loops, []);
});

test('4: evaluate_batch names no best when no scenario finishes the project earlier', async () => {
  const h = await built('2026-01-05', [act('A', 10), act('B', 5), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const worse = await call('evaluate_batch', { handle: h, scenarios: [{ name: 's1', overrides: [{ op: 'update_activity', id: 'A', duration_days: 30 }] }, { name: 'bad', overrides: [{ op: 'update_activity', id: 'NOPE', duration_days: 1 }] }] });
  assert.equal(worse.best, null);
  assert.equal(worse.best_note, undefined);
  assert.equal(worse.scenarios.find((s: any) => s.name === 's1').finish_delta_days, 20, 'the earliest scenario finishes 20 days later');
  assert.match(worse.scenarios.find((s: any) => s.name === 'bad').error, /No activity "NOPE"/);
  assert.deepEqual(worse.ranked, ['s1']);
  const better = await call('evaluate_batch', { handle: h, scenarios: [{ name: 'shorter', overrides: [{ op: 'update_activity', id: 'A', duration_days: 4 }] }] });
  assert.equal(better.best, 'shorter');
  assert.equal(better.best_note, undefined);
});

test('6: monte_carlo on a project with no activities is a plain refusal naming the cause and the next step, not a server bug', async () => {
  const p = await call('new_project', { id: 'EMPTY', start: '2026-01-05' });
  const r = await call('monte_carlo', { handle: p.handle, iterations: 10 });
  assert.equal(r.error.code, 'bad_input');
  assert.equal(r.error.message, 'The project has no activities, so there is nothing to simulate.');
  assert.match(r.error.hint, /Add activities first \(edit add_activity\)/);
  assert.doesNotMatch(JSON.stringify(r), /bug in the server/);
});

test('6: a schedule that cannot be calculated stops monte_carlo with a refusal, not a server bug', async () => {
  const h = await built('2026-01-05', [act('A', 2), act('B', 2), rel('A', 'B')]);
  await call('edit', { handle: h, operations: [{ op: 'add_row', table: 'TASKPRED', fields: { task_id: '1', pred_task_id: '2', proj_id: '1', pred_proj_id: '1', pred_type: 'PR_FS', lag_hr_cnt: '0' } }] });
  const r = await call('monte_carlo', { handle: h, iterations: 10 });
  if (r.error) { assert.equal(r.error.code, 'schedule_failed'); assert.doesNotMatch(JSON.stringify(r), /bug in the server/); assert.match(r.error.message, /loop/); }
});

test('7: schedule_health counts the hard constraints of the DCMA set, with no note of its own', async () => {
  const h = await built('2026-01-05', [act('A', 2, { constraint: { type: 'finish_on_or_before', date: '2026-02-01' } }), act('B', 2)]);
  const r = await call('schedule_health', { handle: h });
  assert.equal(r.hard_constraints.count, 1, 'Finish On or Before counts: it is in the DCMA set the tool description names');
  assert.equal(r.note, undefined);
  assert.equal(r.notes, undefined);
});

test('9: validate does not warn about the clone\'s own in-memory EPS table', async () => {
  const h = await built('2026-01-05', [act('A', 2)]);
  const v = await call('validate', { handle: h });
  assert.ok(!JSON.stringify(v).includes('Unknown table EPS'));
});

test('10 and 34: progress_curves says the current plan was used and "no budgeted cost" once; Earned Schedule says why it is not assessed', async () => {
  const h = await built('2026-03-02', [act('A', 5), act('B', 5), rel('A', 'B')]);
  const c = await call('progress_curves', { handle: h, units: 'cost' });
  const all = JSON.stringify(c);
  assert.equal(count(all, 'No budgeted cost'), 1, 'said once, in notes');
  assert.equal(c.warnings, undefined);
  assert.equal(c.totals.es_note, undefined);
  assert.deepEqual(c.notes, ['No baseline is assigned to P: the current budget and dates were used.', 'No budgeted cost in P: pass units: duration or hours, or load costs.']);
  const withCost = await built('2026-03-02', [{ op: 'add_resource', id: 'R', price_per_unit: 10 }, act('A', 5), { op: 'assign_resource', activity: 'A', resource: 'R' }], 'Q');
  const d = await call('progress_curves', { handle: withCost, units: 'cost' });
  assert.equal(d.totals.es_note, undefined);
  assert.equal(d.totals.bac, 400);
  assert.ok(d.notes.includes('Earned Schedule not assessed: the data date is not after the planned start.'), JSON.stringify(d.notes));
});

test('11: a resource with no limit is not judged: level_resources does not level it and says so, resource_histogram lists it once and counts no over-allocation, schedule_index leaves it out', async () => {
  const h = await built('2026-01-05', [{ op: 'add_resource', id: 'R1' }, act('A', 5), act('B', 5), { op: 'assign_resource', activity: 'A', resource: 'R1' }, { op: 'assign_resource', activity: 'B', resource: 'R1' }]);
  // clear the limit: a resource with no Max Units/Time
  await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'RSRCRATE', where: { rsrc_id: '1' }, fields: { max_qty_per_hr: '0' } }] });
  await call('schedule', { handle: h });
  const l = await call('level_resources', { handle: h, dry_run: true });
  assert.ok(l.notes.includes('No resource is judged for over-allocation: nothing to level.'), JSON.stringify(l.notes)); assert.doesNotMatch(l.report, /nothing to level/, 'said once, in notes');
  assert.equal(l.delayed, 0);
  const hist = await call('resource_histogram', { handle: h });
  assert.ok(hist.notes.includes('1 resource has no Max Units/Time, so its over-allocation is not assessed: R1.'), JSON.stringify(hist.notes));
  assert.equal(hist.resources_order_note, undefined);
  assert.equal(hist.resources[0].over_allocated_periods, 0);
  const si = await call('schedule_index', { handle: h });
  assert.ok(si.notes.includes('1 resource has no Max Units/Time, so its over-allocation is not assessed: R1.'), JSON.stringify(si.notes));
  assert.equal(si.resource_summary.over_allocated, 0);
});

test('11: a resource added with no maximum says what limit it was given', async () => {
  const p = await call('new_project', { id: 'RR', start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_resource', id: 'R2' }, { op: 'add_resource', id: 'R3', units_per_day: 4 }, { op: 'add_resource', id: 'R4', max_units_per_day: 6 }] });
  assert.equal(e.warnings, undefined);
  assert.equal(e.notes.length, 2);
  assert.match(e.notes[0], /^Resource R2 was given no limit, so its Max Units\/Time is the default: 8 units a day \(1 unit an hour on a day of 8 hours\)\. Give max_units_per_day/);
  assert.match(e.notes[1], /^Resource R3 was given no limit, so its Max Units\/Time is the default: 4 units a day \(its units_per_day\)/);
  assert.deepEqual(e.changes.map((c: any) => [c.id, c.field, c.new]), [['R2', 'resource', 'added'], ['R3', 'resource', 'added'], ['R4', 'resource', 'added']]);
});

test('26: level_resources says when one activity alone needs more than the limit', async () => {
  const h = await built('2026-01-05', [{ op: 'add_resource', id: 'R1', max_units_per_day: 8 }, act('A', 3), { op: 'assign_resource', activity: 'A', resource: 'R1' }, act('B', 2), { op: 'assign_resource', activity: 'B', resource: 'R1' }]);
  await call('edit', { handle: h, operations: [{ op: 'update_assignment', activity: 'A', resource: 'R1', units_per_day: 16 }] });
  await call('schedule', { handle: h });
  const l = await call('level_resources', { handle: h, dry_run: true });
  assert.match(l.report, /Resource R1 still overallocated by \d+ h on 2026-01-\d\d: activity A alone needs 16 h in a day against the limit of 8 h, so delaying it cannot fix this: lower its assignment \(edit update_assignment\) or raise the limit \(edit update_resource max_units_per_day\)/);
});
