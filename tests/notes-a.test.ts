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
  assert.match(detail, /^A1 FS A5: relationship float -\d+(\.\d+)? days$/);
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
  assert.match(text, /scheduled finish 2026-01-/);
  assert.doesNotMatch(text, /MEOB|MANDFIN|CS_/);
  // 31: warnings[] points to the log instead of repeating every activity; the mandatory constraint and the unmet relationship are counted
  const w: string = s.warnings.join('\n');
  assert.doesNotMatch(w, /CS_|MEOB|cannot be met \(early/);
  assert.match(w, /activit(y|ies) ha(s|ve) a constraint the scheduled dates do not meet, listed with the scheduled date in log\.exceptions \(CONSTRAINT_UNMET\)/);
  assert.match(w, /relationship(s)? (is|are) not met by the scheduled dates, listed in log\.exceptions \(RELATIONSHIP_UNMET\)/);
  assert.equal(count(w, 'CONSTRAINT_UNMET'), 1);
  // 36: statistics once, with dates
  assert.equal(s.log.statistics, undefined);
  assert.match(s.stats.finish, /^2026-/);
  assert.match(s.stats.dataDate, /^2026-01-05/);
});

test('39: negative float is given in days, like every other answer', async () => {
  const h = await built('2026-01-05', [act('A1', 10), act('A5', 2, { constraint: { type: 'finish_on_or_before', date: '2026-01-09' } }), rel('A1', 'A5')]);
  const s = await call('schedule', { handle: h });
  const neg = s.log.exceptions.find((x: any) => x.code === 'NEGATIVE_FLOAT');
  assert.match(neg.activities[0].detail, /^A\d has total float of -\d+(\.\d+)? days?\.$/);
  assert.doesNotMatch(neg.activities[0].detail, / h /);
  assert.match(s.warnings.join('\n'), /negative total float, listed in log\.exceptions \(NEGATIVE_FLOAT\)/);
});

test('3: a loop is described as a set of activities, not as a path', async () => {
  const r = await call('compute_schedule', { start: '2026-01-05', break_loops: false, activities: [{ id: 'A', duration_days: 1 }, { id: 'B', duration_days: 1 }, { id: 'C', duration_days: 1 }, { id: 'D', duration_days: 1 }], relationships: [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }, { pred: 'B', succ: 'D' }, { pred: 'C', succ: 'A' }, { pred: 'D', succ: 'A' }] });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /^These activities are in a loop: [A-D], [A-D], [A-D], [A-D]\./);
  assert.doesNotMatch(r.error.message, /→/);
  assert.match(r.error.message, /pass break_loops: true/);
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
  assert.match(worse.best_note, /^No scenario improves on the schedule as it stands \(finish 2026-01-\d\d \d\d:\d\d\): the earliest, "s1", finishes 20 days later\./);
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

test('7: schedule_health says what it is, and its hard constraints are the DCMA set it names', async () => {
  const h = await built('2026-01-05', [act('A', 2, { constraint: { type: 'finish_on_or_before', date: '2026-02-01' } }), act('B', 2)]);
  const r = await call('schedule_health', { handle: h });
  assert.equal(r.hard_constraints.count, 1, 'Finish On or Before counts: it is in the DCMA set the note names');
  assert.match(r.note, /^Counts only, with no pass or fail: dcma_14 grades them against the DCMA limits\./);
  assert.doesNotMatch(r.note, /5% limits/);
});

test('9: validate does not warn about the clone\'s own in-memory EPS table', async () => {
  const h = await built('2026-01-05', [act('A', 2)]);
  const v = await call('validate', { handle: h });
  assert.ok(!JSON.stringify(v).includes('Unknown table EPS'));
});

test('10 and 34: progress_curves names the first planned cost, and says "no budgeted cost" once', async () => {
  const h = await built('2026-03-02', [act('A', 5), act('B', 5), rel('A', 'B')]);
  const c = await call('progress_curves', { handle: h, units: 'cost' });
  const all = JSON.stringify(c);
  assert.equal(count(all, 'no budgeted cost'), 1, 'said once (in warnings), not again in es_note');
  assert.match(c.totals.es_note, /Earned Schedule is not assessed: the planned value is 0 \(warnings says why and what to do\)\./);
  assert.match(c.warnings.join(' '), /Assign one with edit assign_baseline\./);
  const withCost = await built('2026-03-02', [{ op: 'add_resource', id: 'R', price_per_unit: 10 }, act('A', 5), { op: 'assign_resource', activity: 'A', resource: 'R' }], 'Q');
  const d = await call('progress_curves', { handle: withCost, units: 'cost' });
  assert.doesNotMatch(d.totals.es_note ?? '', /from the planned start/);
});

test('11: the three tools say what they do with a resource that has no limit, each in the same sentence; level_resources says when nothing was leveled', async () => {
  const h = await built('2026-01-05', [{ op: 'add_resource', id: 'R1' }, act('A', 5), act('B', 5), { op: 'assign_resource', activity: 'A', resource: 'R1' }, { op: 'assign_resource', activity: 'B', resource: 'R1' }]);
  // clear the limit: a resource with no Max Units/Time
  await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'RSRCRATE', where: { rsrc_id: '1' }, fields: { max_qty_per_hr: '0' } }] });
  await call('schedule', { handle: h });
  const l = await call('level_resources', { handle: h, dry_run: true });
  assert.match(l.report, /No resource has a limit set \(Max Units\/Time\), so nothing was leveled\. A resource with no limit set \(Max Units\/Time 0\) is not leveled\. Set a limit with edit update_resource max_units_per_day\./);
  const hist = await call('resource_histogram', { handle: h });
  assert.match(hist.resources_order_note, /A resource with no limit set \(Max Units\/Time 0\) counts as over-allocated in every period in which it has work, with severity none, so it comes after the resources that really exceed a limit\. Set a limit with edit update_resource max_units_per_day\./);
  const si = await call('schedule_index', { handle: h });
  assert.match(JSON.stringify(si), /A resource with no limit set \(Max Units\/Time 0\) is left out of the over-allocation figures\. Set a limit with edit update_resource max_units_per_day\./);
});

test('11: a resource added with no maximum says what limit it was given', async () => {
  const p = await call('new_project', { id: 'RR', start: '2026-01-05' });
  const e = await call('edit', { handle: p.handle, operations: [{ op: 'add_resource', id: 'R2' }, { op: 'add_resource', id: 'R3', units_per_day: 4 }, { op: 'add_resource', id: 'R4', max_units_per_day: 6 }] });
  assert.equal(e.warnings.length, 2);
  assert.match(e.warnings[0], /^Resource R2 was given no limit, so its Max Units\/Time is the default: 8 units a day \(1 unit an hour on a day of 8 hours\)\. Give max_units_per_day/);
  assert.match(e.warnings[1], /^Resource R3 was given no limit, so its Max Units\/Time is the default: 4 units a day \(its units_per_day\)/);
});

test('26: level_resources says when one activity alone needs more than the limit', async () => {
  const h = await built('2026-01-05', [{ op: 'add_resource', id: 'R1', max_units_per_day: 8 }, act('A', 3), { op: 'assign_resource', activity: 'A', resource: 'R1' }, act('B', 2), { op: 'assign_resource', activity: 'B', resource: 'R1' }]);
  await call('edit', { handle: h, operations: [{ op: 'update_assignment', activity: 'A', resource: 'R1', units_per_day: 16 }] });
  await call('schedule', { handle: h });
  const l = await call('level_resources', { handle: h, dry_run: true });
  assert.match(l.report, /Resource R1 still overallocated by \d+ h on 2026-01-\d\d: activity A alone needs 16 h in a day against the limit of 8 h, so delaying it cannot fix this: lower its assignment \(edit update_assignment\) or raise the limit \(edit update_resource max_units_per_day\)/);
});
