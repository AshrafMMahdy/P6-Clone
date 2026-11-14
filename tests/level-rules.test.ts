// Resource leveling: the rules a blind review of 2026-11-14 found broken, each as a case of its own. The leveler decides the delays and the scheduler dates
// everything, so where no resource is over its limit a leveling changes nothing the schedule calculated, whatever the logic, progress and constraints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { callTool, toolResult } from '../mcp/server.ts';
import { getSession } from '../mcp/runtime.ts';
import { sampleCopy, testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
async function project(ops: unknown[], start = '2021-02-01', schedule = true) {
  const p = await call('new_project', { id: 'LV', start });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e.error));
  if (schedule) assert.equal((await call('schedule', { handle: p.handle })).ok, true);
  return { h: p.handle as string, owner_key: p.owner_key as string };
}
const act = (id: string, d: number, extra: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...extra });
const on = (activity: string, units_per_day = 8, resource = 'R') => ({ op: 'assign_resource', activity, resource, units_per_day });
const R = { op: 'add_resource', id: 'R', max_units_per_day: 8 };
const rel = (pred: string, succ: string, extra: Record<string, unknown> = {}) => ({ op: 'add_relationship', pred, succ, ...extra });
const row = (h: string, id: string, proj?: string) => { const db = getSession(h).db; return db.tables.TASK.rows.find((t) => t.task_code === id && (!proj || db.tables.PROJECT.rows.find((p) => p.proj_id === t.proj_id)!.proj_short_name === proj))!; };
const SCHED = ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt'];
const snap = (h: string) => getSession(h).db.tables.TASK.rows.map((t) => `${t.task_code}: ${SCHED.map((f) => t[f] ?? '').join(' | ')}`);

test('Preserve off and no resource over its limit: every date and float is what schedule gave (progress out of sequence, a start-to-start lag from a started activity, constraints, a Must Finish By date)', async () => {
  const { h } = await project([R, act('A', 10), act('B', 5), act('C', 5), act('D', 3, { constraint: { type: 'finish_on_or_before', date: '2021-03-05' } }), act('E', 4), act('M', 0, { type: 'finish_milestone' }),
    rel('A', 'B', { type: 'SS', lag_days: 4 }), rel('B', 'C'), rel('A', 'D'), rel('C', 'M'), rel('D', 'M'), rel('E', 'C'), on('B', 4), on('D', 4), { op: 'set_project', must_finish_by: '2021-03-20' }]);
  // A in progress, C completed before its predecessor B has started
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', actual_start: '2021-02-01', remaining_days: 6 }, { op: 'update_activity', id: 'E', actual_start: '2021-02-01', actual_finish: '2021-02-04' }, { op: 'update_activity', id: 'C', actual_start: '2021-02-05', actual_finish: '2021-02-11' }] })).error);
  assert.equal((await call('schedule', { handle: h, data_date: '2021-02-15' })).ok, true);
  const before = snap(h);
  const l = await call('level_resources', { handle: h, preserve_scheduled_dates: false });
  assert.ok(!l.error, JSON.stringify(l.error));
  assert.deepEqual([l.delayed, l.cannot_be_leveled], [0, []]);
  assert.deepEqual(snap(h), before);
});

test('a finish milestone after a delayed activity sits on that activity\'s finish; a level of effort activity takes the span of the delayed activities; Preserve off after Preserve on leaves early = remaining for every activity', async () => {
  const { h } = await project([R, act('A', 5), act('B', 5), on('A'), on('B'), act('FM', 0, { type: 'finish_milestone' }), rel('B', 'FM'), act('L', 0, { type: 'level_of_effort' }), rel('B', 'L', { type: 'SS' }), rel('FM', 'L', { type: 'FF' })]);
  const l = await call('level_resources', { handle: h });
  assert.deepEqual(l.moved.map((m: any) => `${m.id} ${m.start} ${m.delayed_by}`), ['FM 2021-02-12 17:00 predecessor', 'B 2021-02-08 08:00 resource'].sort((a, b) => a.slice(a.indexOf(' ')).localeCompare(b.slice(b.indexOf(' ')))));
  assert.deepEqual([row(h, 'FM').restart_date, row(h, 'FM').early_start_date], ['2021-02-12 17:00', '2021-02-05 17:00']);
  assert.deepEqual([row(h, 'L').restart_date, row(h, 'L').reend_date], ['2021-02-08 08:00', '2021-02-12 17:00'], 'the level of effort spans B as leveled');
  // the same file leveled again with the scheduled dates not preserved: early and remaining dates are one, for the activities that do not move in this run too
  const u = await call('level_resources', { handle: h, preserve_scheduled_dates: false });
  assert.ok(!u.error, JSON.stringify(u.error));
  for (const id of ['A', 'B', 'FM', 'L']) assert.deepEqual([row(h, id).early_start_date, row(h, id).early_end_date], [row(h, id).restart_date, row(h, id).reend_date], id);
  assert.equal(row(h, 'B').early_start_date, '2021-02-08 08:00');
});

test('the limit is measured over the hours of the day the activities work (a 10-hour day), a resource assigned twice counts with both assignments, a limit of 0 from a date is no capacity from then (as the histogram reads it)', async () => {
  const ten = { op: 'add_calendar', name: 'Ten', work_week: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['07:00', '17:00']]])) };
  let { h } = await project([ten, { op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 5, { calendar: 'Ten' }), on('A', 8)]);
  // (1 unit an hour: 10 unit-hours on a 10-hour day are the limit, not 2 over it)
  let l = await call('level_resources', { handle: h });
  assert.deepEqual([l.cannot_be_leveled, l.peaks], [[], [{ resource: 'R', peak: 10, limit: 10, day: '2021-02-01', overallocated: false }]]);
  ({ h } = await project([R, act('Z', 5), on('Z', 6), { ...on('Z', 6), allow_duplicate: true }, act('B', 5), on('B', 2)]));
  l = await call('level_resources', { handle: h });
  assert.deepEqual(l.cannot_be_leveled, [{ id: 'Z', why: 'alone it needs 12 h in a day against the limit of 8 h' }]);
  ({ h } = await project([R, act('A', 5), act('C', 5, { constraint: { type: 'start_on_or_after', date: '2021-02-15' } }), on('A'), on('C')]));
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'add_row', table: 'RSRCRATE', fields: { rsrc_id: getSession(h).db.tables.RSRC.rows[0].rsrc_id, start_date: '2021-02-15 00:00', max_qty_per_hr: '0' } }] })).error);
  l = await call('level_resources', { handle: h });
  assert.deepEqual(l.cannot_be_leveled, [{ id: 'C', why: 'alone it needs 8 h in a day against the limit of 0 h' }]);
  const hist = await call('resource_histogram', { handle: h });
  assert.equal((hist.resources ?? hist.result ?? [])[0]?.over_allocated_periods > 0, l.peaks[0].overallocated, JSON.stringify(hist).slice(0, 300));
});

test('an edit of a leveled activity starts from its Start (the leveled one); a Microsoft Project export carries it', async () => {
  const { h, owner_key } = await project([R, act('A', 5), act('B', 5), on('A'), on('B')]);
  await call('level_resources', { handle: h });
  assert.equal(row(h, 'B').restart_date, '2021-02-08 08:00');
  const out = join(process.env.TMPDIR ?? '/tmp', `lv-${Date.now()}.xml`);
  assert.ok(!(await call('save', { handle: h, owner_key, path: out, format: 'mspdi' })).error);
  const starts = [...readFileSync(out, 'utf8').matchAll(/<(Start|Finish)>([^<]+)</g)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(starts.includes('Start 2021-02-08T08:00:00') && starts.includes('Finish 2021-02-12T17:00:00'), starts.join(' | '));
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'B', duration_days: 6 }] })).error);
  assert.deepEqual([row(h, 'B').restart_date, row(h, 'B').reend_date], ['2021-02-08 08:00', '2021-02-15 17:00']);
});

test('several projects: each moved activity carries its project, and activity_priority names one by {id, project}; Activity ID order is one order (A10 before A9, as P6 sorts the column)', async () => {
  const p = await call('new_project', { id: 'P1', start: '2021-02-01' }), h = p.handle as string;
  const e = await call('edit', { handle: h, operations: [R, act('B', 5), on('B'), { op: 'add_project', id: 'P2', start: '2021-02-01' }, { ...act('B', 5), project: 'P2' }, { ...on('B'), project: 'P2' }] });
  assert.ok(!e.error, JSON.stringify(e.error));
  assert.equal((await call('schedule', { handle: h })).ok, true);
  const first = await call('level_resources', { handle: h, dry_run: true });
  assert.deepEqual(first.moved.map((m: any) => [m.id, m.project]), [['B', 'P2']]);
  assert.equal((await call('level_resources', { handle: h, dry_run: true, activity_priority: ['B'] })).error.message, 'Activity "B" is in several projects (P1, P2).');
  assert.deepEqual((await call('level_resources', { handle: h, dry_run: true, activity_priority: [{ id: 'B', project: 'P2' }] })).moved.map((m: any) => [m.id, m.project]), [['B', 'P1']]);
  const { h: g } = await project([R, act('A9', 5), act('A10', 5), on('A9'), on('A10')]);
  for (const args of [{}, { priority_by: 'activity_id' }, { priority_by: 'Activity ID' }]) assert.deepEqual((await call('level_resources', { handle: g, dry_run: true, ...args })).moved.map((m: any) => m.id), ['A9'], JSON.stringify(args));
  assert.deepEqual((await call('level_resources', { handle: g, dry_run: true, priority_by: 'Activity ID descending' })).moved.map((m: any) => m.id), ['A10']);
});

test('an option the run has no use for is said; an activity with a mandatory constraint is not delayed; activities with no dates stop the leveling; the leveled-dates sentences come only with a leveling', async () => {
  const { h } = await project([R, act('A', 5), act('B', 5, { constraint: { type: 'mandatory_start', date: '2021-02-01' } }), on('A'), on('B')]);
  const l = await call('level_resources', { handle: h, dry_run: true, over_allocation_pct: 50, min_float_days: 1 });
  assert.ok(l.notes.includes('min_float_days and over_allocation_pct are used only when leveling within float (within_float: true), as in P6: not used in this run.'), JSON.stringify(l.notes));
  assert.deepEqual([l.settings.over_allocation_pct, l.settings.min_float_days], [undefined, undefined]);
  // B is mandatory and taken first: A waits for it
  assert.deepEqual(l.moved.map((m: any) => m.id), ['A']);
  const w = await call('level_resources', { handle: h, dry_run: true, within_float: true, preserve_scheduled_dates: false });
  assert.ok(w.notes.includes('Leveling within float preserves the scheduled dates, as in P6: preserve_scheduled_dates: false was not used.'), JSON.stringify(w.notes));
  // two mandatory activities on the same days: neither is delayed, the second is listed
  const { h: m } = await project([R, act('A', 5, { constraint: { type: 'mandatory_start', date: '2021-02-01' } }), act('B', 5, { constraint: { type: 'mandatory_start', date: '2021-02-01' } }), on('A'), on('B')]);
  const both = await call('level_resources', { handle: m });
  assert.deepEqual([both.moved, both.cannot_be_leveled], [[], [{ id: 'B', why: 'it has a mandatory constraint, so it is not delayed' }]]);
  // never calculated: refused, nothing changed
  const { h: n } = await project([R, act('A', 5), on('A')], '2021-02-01', false);
  getSession(n).db.tables.TASK.rows.forEach((t) => { for (const f of ['early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date']) t[f] = ''; });
  assert.equal((await call('level_resources', { handle: n })).error.message, 'Not leveled: activity A has no calculated dates: run schedule first.');
  // nothing to level: no sentence about leveled dates, with the scheduled dates preserved or not
  const { h: z } = await project([act('A', 5)]);
  for (const preserve_scheduled_dates of [true, false]) assert.deepEqual((await call('level_resources', { handle: z, preserve_scheduled_dates })).notes, ['No resource is assigned to an activity: nothing to level.']);
});

test('a second calculation of a real file gives what the first gave (129 trial.xer: three late starts used to move)', async () => {
  const o = await call('open_file', { path: sampleCopy('129 trial.xer') });
  assert.equal((await call('schedule', { handle: o.handle, log: false })).ok, true);
  const first = snap(o.handle);
  assert.equal((await call('schedule', { handle: o.handle, log: false })).ok, true);
  assert.deepEqual(snap(o.handle).filter((x, i) => x !== first[i]), []);
});

// ---- a leveling always ends (three networks on which the placing and the calculation chased each other for ever, found by random networks on 2026-11-14)
const dates = (h: string, id: string) => `${row(h, id).restart_date}..${row(h, id).reend_date}`;

test('an activity in progress is leveled like one not started, as in P6: its remaining work is delayed whole, after its predecessor and after an activity of higher priority', async () => {
  for (const preserve of [true, false]) {
    // X (in progress) finishes with T by the logic and shares its resource: T first (the predecessor), X's remaining work after it
    let { h } = await project([R, act('T', 5), act('X', 8), on('T'), on('X'), rel('T', 'X', { type: 'FF' })]);
    assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'X', actual_start: '2021-02-01', remaining_days: 5 }] })).error);
    assert.equal((await call('schedule', { handle: h, data_date: '2021-02-08' })).ok, true);
    let l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.deepEqual(l.moved, [{ id: 'X', from: '2021-02-08 08:00', start: '2021-02-15 08:00', finish: '2021-02-19 17:00', delayed_by: 'resource' }]);
    assert.deepEqual([dates(h, 'T'), dates(h, 'X'), row(h, 'X').act_start_date, l.cannot_be_leveled, l.peaks[0].overallocated], ['2021-02-08 08:00..2021-02-12 17:00', '2021-02-15 08:00..2021-02-19 17:00', '2021-02-01 00:00', [], false]);
    assert.equal((await call('level_resources', { handle: h, preserve_scheduled_dates: preserve })).delayed, 0, 'a second leveling moves nothing');
    // no logic between them: the Activity Leveling Priority decides, started or not
    ({ h } = await project([R, act('N', 3, { priority: 'top' }), act('X', 8), on('N'), on('X')]));
    assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'X', actual_start: '2021-02-01', remaining_days: 5 }] })).error);
    assert.equal((await call('schedule', { handle: h, data_date: '2021-02-08' })).ok, true);
    l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.deepEqual([dates(h, 'N'), dates(h, 'X'), l.delayed], ['2021-02-08 08:00..2021-02-10 17:00', '2021-02-11 08:00..2021-02-17 17:00', 1]);
  }
});

test('As Late As Possible is not applied in a leveling, as in P6: the activity is leveled from where the schedule put it and does not follow a finish the leveling moves (it did, and the leveling never ended)', async () => {
  const NOTE = 'As in P6, an As Late As Possible constraint is not applied in a leveling: Z stays where the schedule put it unless the leveling delays it.';
  for (const preserve of [true, false]) {
    // Z sits at the end of the project, on Q's days and Q's resource: Q (its ID is first) keeps its days, Z goes after it, and the project's finish goes with Z
    let { h } = await project([R, act('P', 6), act('Q', 5), on('Q'), act('Z', 4, { constraint: { type: 'as_late_as_possible' } }), on('Z'), rel('P', 'Q', { lag_days: 3 })]);
    assert.deepEqual([dates(h, 'Q'), dates(h, 'Z')], ['2021-02-12 08:00..2021-02-18 17:00', '2021-02-15 08:00..2021-02-18 17:00']);
    const l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.ok(!l.error, JSON.stringify(l.error));
    assert.deepEqual(l.moved, [{ id: 'Z', from: '2021-02-15 08:00', start: '2021-02-19 08:00', finish: '2021-02-24 17:00', delayed_by: 'resource' }]);
    assert.deepEqual([dates(h, 'Q'), l.cannot_be_leveled, l.peaks[0].overallocated, l.notes[0]], ['2021-02-12 08:00..2021-02-18 17:00', [], false, NOTE]);
    const snapshot = snap(h);
    assert.deepEqual([(await call('level_resources', { handle: h, preserve_scheduled_dates: preserve })).delayed, snap(h)], [0, snapshot], 'a second leveling changes nothing');
    // nothing over its limit: the activity is not moved (a leveling only delays)
    ({ h } = await project([R, act('A', 5), on('A'), act('C', 10), act('Z', 3, { constraint: { type: 'as_late_as_possible' } }), on('Z')]));
    const before = snap(h);
    const n = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.deepEqual([n.delayed, dates(h, 'Z')], [0, '2021-02-10 08:00..2021-02-12 17:00']);
    // (preserved: no field changes; not preserved: A's late dates come forward, as it cannot be late on Z's days)
    if (preserve) assert.deepEqual(snap(h), before);
    else assert.deepEqual([row(h, 'A').late_start_date, row(h, 'A').late_end_date, row(h, 'A').total_float_hr_cnt], ['2021-02-03 08:00', '2021-02-09 17:00', '16']);
  }
});

test('no resource to level: nothing is calculated or written, with the scheduled dates preserved or not, and on dates that are not current', async () => {
  const { h } = await project([act('A', 5), act('B', 5), rel('A', 'B')]);
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', duration_days: 8 }] })).error);
  const before = snap(h);
  for (const preserve of [true, false]) {
    const l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.deepEqual([l.delayed, l.notes, snap(h)], [0, ['No resource is assigned to an activity: nothing to level.'], before]);
  }
});

test('"its predecessors first" follows the logic through an activity completed out of sequence (retained logic carries the delay through it)', async () => {
  for (const preserve of [true, false]) {
    // A100 starts C (completed already) and C starts A180: A180 has the higher priority, yet A100 is its predecessor and is placed first
    const { h } = await project([R, act('A100', 3), on('A100'), act('C', 2), act('A180', 4, { priority: 'top' }), on('A180'), rel('A100', 'C', { type: 'SS' }), rel('C', 'A180', { type: 'SS' })]);
    assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'C', actual_start: '2021-02-01', actual_finish: '2021-02-02' }] })).error);
    assert.equal((await call('schedule', { handle: h, data_date: '2021-02-08' })).ok, true);
    assert.deepEqual([dates(h, 'A100'), dates(h, 'A180')], ['2021-02-08 08:00..2021-02-10 17:00', '2021-02-08 08:00..2021-02-11 17:00']);
    const l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve });
    assert.deepEqual(l.moved, [{ id: 'A180', from: '2021-02-08 08:00', start: '2021-02-11 08:00', finish: '2021-02-16 17:00', delayed_by: 'resource' }]);
    assert.deepEqual([dates(h, 'A100'), l.cannot_be_leveled], ['2021-02-08 08:00..2021-02-10 17:00', []]);
  }
});

// ---- what a blind check of the reworked leveling found (2026-11-14)
test('the backward leveling takes the activities in the reverse of the forward order: no negative float where nothing constrains the finish', async () => {
  const { h } = await project([R, act('A', 5), act('B', 5), act('L', 12), rel('L', 'B', { type: 'FF', lag_days: 2 }), act('C', 5), on('A'), on('B'), on('C')]);
  const l = await call('level_resources', { handle: h, preserve_scheduled_dates: false });
  assert.ok(!l.error, JSON.stringify(l.error));
  assert.deepEqual(['A', 'B', 'L', 'C'].map((id) => `${id} ${row(h, id).total_float_hr_cnt}`), ['A 0', 'B 0', 'L 8', 'C 0']);
});

test('a resource still over its limit is reported on the day it is most over; a leveling on a project with no data date says the planned start that was used', async () => {
  let { h } = await project([R, act('A', 5), act('B', 5, { constraint: { type: 'mandatory_start', date: '2021-02-01' } }), act('C', 5, { constraint: { type: 'mandatory_start', date: '2021-02-01' } }), on('A', 2), on('B', 6), on('C', 6)]);
  let l = await call('level_resources', { handle: h, dry_run: true });
  assert.deepEqual(l.peaks, [{ resource: 'R', peak: 12, limit: 8, day: '2021-02-01', overallocated: true }]);
  ({ h } = await project([R, act('A', 5), act('B', 5), on('A'), on('B')]));
  getSession(h).db.tables.PROJECT.rows[0].last_recalc_date = '';
  l = await call('level_resources', { handle: h });
  assert.equal(l.delayed, 1);
  assert.ok(l.notes.some((n: string) => /^LV has no data date: the planned start 2021-02-01 \S+ was used\. Set one with schedule data_date\.$/.test(n)), JSON.stringify(l.notes));
});

test('after a leveling that preserved the scheduled dates, an edit of the duration keeps the Early Start and the leveled Start, each with its own finish; a start typed in moves the activity', async () => {
  const { h } = await project([R, act('A', 5), act('B', 5), on('A'), on('B')]);
  assert.equal((await call('level_resources', { handle: h })).delayed, 1);
  assert.deepEqual([row(h, 'B').early_start_date, row(h, 'B').restart_date], ['2021-02-01 08:00', '2021-02-08 08:00']);
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'B', duration_days: 7 }] })).error);
  assert.deepEqual([row(h, 'B').early_start_date, row(h, 'B').early_end_date, row(h, 'B').restart_date, row(h, 'B').reend_date], ['2021-02-01 08:00', '2021-02-09 17:00', '2021-02-08 08:00', '2021-02-16 17:00']);
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', start: '2021-02-10' }] })).error);
  assert.deepEqual([row(h, 'A').early_start_date, row(h, 'A').restart_date, row(h, 'A').reend_date, row(h, 'A').cstr_type], ['2021-02-10 08:00', '2021-02-10 08:00', '2021-02-16 17:00', 'CS_MSOA']);
});

test('a schedule that is saved and opened again reads as current: an assignment with no units rate keeps the span of its own dates (129 trial.xer)', async () => {
  const o = await call('open_file', { path: sampleCopy('129 trial.xer') });
  assert.equal((await call('schedule', { handle: o.handle, log: false })).ok, true);
  const late = (h: string) => getSession(h).db.tables.TASK.rows.map((t) => `${t.task_code} ${t.late_start_date} ${t.late_end_date} ${t.total_float_hr_cnt}`);
  const first = late(o.handle);
  assert.equal((await call('schedule', { handle: o.handle, log: false })).ok, true);
  assert.deepEqual(late(o.handle), first, 'a second calculation gives the same late dates');
  const out = join(process.env.TMPDIR ?? '/tmp', `sched-${Date.now()}.xer`);
  const s = await call('save', { handle: o.handle, owner_key: o.owner_key, path: out });
  assert.ok(!s.error, JSON.stringify(s.error));
  const again = await call('open_file', { path: out });
  const saved = late(again.handle);
  assert.deepEqual(saved, first);
  assert.equal((await call('schedule', { handle: again.handle, log: false })).ok, true);
  assert.deepEqual(late(again.handle), saved, 'the file as saved is what a calculation of it gives');
});

test('saved dates that are not what the calculation gives: a leveling is refused with the call that settles it, nothing changed; schedule level_resources does both; a second leveling, on leveled dates, is not refused', async () => {
  const { h } = await project([R, act('A', 5), act('B', 5), act('C', 3), rel('A', 'C'), on('A'), on('B')]);
  // an edit since the last schedule: A is longer, so C's saved dates are no longer the logic's
  assert.ok(!(await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A', duration_days: 8 }] })).error);
  const before = snap(h);
  for (const args of [{}, { preserve_scheduled_dates: false }, { dry_run: true }]) {
    const l = await call('level_resources', { handle: h, ...args });
    assert.equal(l.error?.message, 'Not leveled: the saved dates of activity C are not what the calculation gives: run schedule first, or schedule with level_resources: true to calculate and level in one call.');
    assert.equal(l.error.hint, 'Nothing was changed.');
    assert.deepEqual(snap(h), before);
  }
  const s = await call('schedule', { handle: h, level_resources: true });
  assert.deepEqual([s.ok, s.leveling.delayed], [true, 1]);
  assert.deepEqual([dates(h, 'A'), dates(h, 'B')], ['2021-02-01 08:00..2021-02-10 17:00', '2021-02-11 08:00..2021-02-17 17:00']);
  // leveled dates are dates the calculation gives when it is held to them: leveling again, preserved or not, is not refused and moves nothing
  for (const preserve of [true, false, false, true]) { const l = await call('level_resources', { handle: h, preserve_scheduled_dates: preserve }); assert.ok(!l.error, JSON.stringify(l.error)); assert.equal(l.delayed, 0); }
});

test('a file that keeps the dates Microsoft Project calculated: the refusal and the standing sentence name the call that calculates it again', async () => {
  const o = await call('open_file', { path: join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml') });
  assert.ok(!o.error, JSON.stringify(o.error));
  const l = await call('level_resources', { handle: o.handle, preserve_scheduled_dates: false });
  assert.match(l.error.message, /^Not leveled: the saved dates of .* not what the calculation gives: run schedule first/);
  assert.equal(l.error.hint, 'Nothing was changed. Clinic Fitout keeps the dates Microsoft Project calculated, which a plain schedule leaves alone: schedule with data_date calculates it again.');
  const sum = await call('project_summary', { handle: o.handle });
  assert.ok(sum.notes.some((n: string) => n.endsWith('they are the dates Microsoft Project calculated, which a plain schedule keeps: schedule with data_date recalculates them.')), JSON.stringify(sum.notes));
});
