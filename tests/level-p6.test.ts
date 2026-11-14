// Resource leveling as P6 levels (owner 2026-11-14: "match P6"; the sources are in the platform's ledger, "P6 RESEARCH, 2026-11-14"). The expected dates of the
// first tests are the published results of P6 itself: Harris (211112_P6_Resource_Leveling.pdf: three unlinked activities, with and without "Preserve scheduled early
// and late dates", both Must Finish By dates), Ten Six (leveling within float, the float to preserve, the percent to over-allocate, a limit that changes by date),
// Winter (a chain leveled in Activity ID order, the successor delayed by its predecessor) and a planners' forum (use equal to the limit fits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, toolResult } from '../mcp/server.ts';
import { getSession } from '../mcp/runtime.ts';
import { testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
async function project(start: string, ops: unknown[]) {
  const p = await call('new_project', { id: 'LV', start });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e.error));
  const s = await call('schedule', { handle: p.handle });
  assert.equal(s.ok, true, JSON.stringify(s.error));
  return p.handle as string;
}
/** The dates the file holds for an activity, by day (read from the rows themselves). */
const day = (v: string | undefined) => (v ?? '').slice(5, 10);
const row = (h: string, id: string) => getSession(h).db.tables.TASK.rows.find((t) => t.task_code === id)!;
const dates = (h: string, id: string) => { const t = row(h, id); return { early: `${day(t.early_start_date)}..${day(t.early_end_date)}`, remaining: `${day(t.restart_date)}..${day(t.reend_date)}`, late: `${day(t.late_start_date)}..${day(t.late_end_date)}`, float: Number(t.total_float_hr_cnt) / 8 }; };
const act = (id: string, d: number, extra: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...extra });
const on = (activity: string, resource = 'R', units_per_day = 8) => ({ op: 'assign_resource', activity, resource, units_per_day });

// Harris: data date Monday 1 Feb 2021, 5-day week; A1000 "1 - Top", A1010 "3 - Normal", A1020 "2 - High"; the default priority list (Activity Leveling Priority, ascending)
const harris = (mustFinishBy: string) => project('2021-02-01', [{ op: 'set_project', must_finish_by: mustFinishBy }, { op: 'add_resource', id: 'R', max_units_per_day: 8 },
  act('A1000', 5, { priority: 'top' }), act('A1010', 5), act('A1020', 5, { priority: 'high' }), on('A1000'), on('A1010'), on('A1020')]);

test('Preserve scheduled early and late dates, ticked (P6\'s default): the leveled dates are the Remaining Early dates; early, late and float stay as scheduled', async () => {
  const h = await harris('2021-02-27');
  const l = await call('level_resources', { handle: h });
  assert.deepEqual(l.settings, { preserve_scheduled_dates: true, within_float: false, priority_by: ['activity_leveling_priority'] });
  assert.deepEqual(l.moved.map((m: any) => [m.id, m.start.slice(5, 10), m.delayed_by]), [['A1020', '02-08', 'resource'], ['A1010', '02-15', 'resource']]);
  assert.deepEqual(dates(h, 'A1000'), { early: '02-01..02-05', remaining: '02-01..02-05', late: '02-22..02-26', float: 15 });
  assert.deepEqual(dates(h, 'A1020'), { early: '02-01..02-05', remaining: '02-08..02-12', late: '02-22..02-26', float: 15 });
  assert.deepEqual(dates(h, 'A1010'), { early: '02-01..02-05', remaining: '02-15..02-19', late: '02-22..02-26', float: 15 });
  // the planned dates of an activity not started follow its Start and Finish; so do its assignments
  assert.equal(day(row(h, 'A1010').target_start_date), '02-15');
  const db = getSession(h).db, asg = db.tables.TASKRSRC.rows.find((a) => a.task_id === row(h, 'A1010').task_id)!;
  assert.deepEqual([day(asg.restart_date), day(asg.reend_date)], ['02-15', '02-19']);
  // what the answer tells the agent, each once: where the leveled dates are, and what removes them
  assert.deepEqual(l.notes, ['The leveled dates are the activities\' Start and Finish (their Remaining Early dates); Early Start, Early Finish, the late dates and Total Float are as they were before the leveling (Preserve scheduled early and late dates).',
    'schedule calculates the dates again without the resources\' limits, which removes this leveling; schedule with level_resources: true levels again after calculating.']);
  // the readers of an activity's Start and Finish give the leveled dates, beside the scheduled early dates
  const a = await call('get_activity', { handle: h, activity_id: 'A1010' });
  assert.deepEqual([a.start, a.finish, a.early_start, a.early_finish].map((v: string) => v.slice(5, 10)), ['02-15', '02-19', '02-01', '02-05'], JSON.stringify(a).slice(0, 400));
  // the project's Scheduled Finish is the schedule's (its latest early finish); the latest Finish of its activities is the leveled one
  const s = await call('project_summary', { handle: h });
  assert.deepEqual([s.projects[0].scheduled_finish.slice(5, 10), s.latest_finish.slice(5, 10)], ['02-05', '02-19']);
  // the scheduled dates are still what a calculation gives: nothing is said to be out of date
  assert.ok(!(s.notes ?? []).some((n: string) => /saved dates/.test(n)), JSON.stringify(s.notes));
  // no resource is over its limit any more
  assert.deepEqual(l.peaks, [{ resource: 'R', peak: 8, limit: 8, day: '2021-02-01', overallocated: false }]);
});

test('Preserve unticked: the early dates take the leveled dates and a backward leveling from the Must Finish By date gives the late dates and the float (P6\'s published results)', async () => {
  let h = await harris('2021-02-27');
  let l = await call('level_resources', { handle: h, preserve_scheduled_dates: false });
  assert.deepEqual(dates(h, 'A1000'), { early: '02-01..02-05', remaining: '02-01..02-05', late: '02-08..02-12', float: 5 });
  assert.deepEqual(dates(h, 'A1020'), { early: '02-08..02-12', remaining: '02-08..02-12', late: '02-15..02-19', float: 5 });
  assert.deepEqual(dates(h, 'A1010'), { early: '02-15..02-19', remaining: '02-15..02-19', late: '02-22..02-26', float: 5 });
  assert.match(l.notes[0], /^Every date and float was recalculated with the leveling in it: the early dates are the leveled dates, and the late dates are brought forward where the resources do not allow them/);
  // the project's Scheduled Finish is the leveled one now
  assert.equal((await call('project_summary', { handle: h })).projects[0].scheduled_finish.slice(5, 10), '02-19');
  // a Must Finish By date the leveled work cannot meet: the late dates go before the data date and the float is negative
  h = await harris('2021-02-13');
  l = await call('level_resources', { handle: h, preserve_scheduled_dates: false });
  assert.deepEqual(dates(h, 'A1000'), { early: '02-01..02-05', remaining: '02-01..02-05', late: '01-25..01-29', float: -5 });
  assert.deepEqual(dates(h, 'A1020'), { early: '02-08..02-12', remaining: '02-08..02-12', late: '02-01..02-05', float: -5 });
  assert.deepEqual(dates(h, 'A1010'), { early: '02-15..02-19', remaining: '02-15..02-19', late: '02-08..02-12', float: -5 });
  // the same with the dates preserved: only the Remaining Early dates move
  h = await harris('2021-02-13');
  await call('level_resources', { handle: h, preserve_scheduled_dates: true });
  assert.deepEqual(dates(h, 'A1010'), { early: '02-01..02-05', remaining: '02-15..02-19', late: '02-08..02-12', float: 5 });
});

test('within total float: the lowest priority that does not fit stays on its dates, over the limit, and is listed', async () => {
  const h = await harris('2021-02-13');
  const l = await call('level_resources', { handle: h, within_float: true, preserve_scheduled_dates: false });
  assert.equal(l.settings.preserve_scheduled_dates, true, 'leveling within float preserves the scheduled dates');
  assert.deepEqual([dates(h, 'A1000').remaining, dates(h, 'A1020').remaining, dates(h, 'A1010').remaining], ['02-01..02-05', '02-08..02-12', '02-01..02-05']);
  assert.deepEqual(l.cannot_be_leveled, [{ id: 'A1010', why: 'it does not fit within its total float' }]);
  assert.equal(l.peaks[0].overallocated, true);
  // (the report holds the settings and the counts; the activities are in moved and cannot_be_leveled, once)
  assert.match(l.report, /Activities delayed due to resource leveling\.+1\r\n Activities delayed due to predecessor delay\.+0\r\n Activities that cannot be leveled\.+1\r\n/);
});

// Ten Six: start milestone -> A1010 (5d), A1020 (3d), A1030 (8d, no resource) -> finish milestone; PM 8 h/d on A1010 and A1020; leveling within float in every run
const tenSix = async (datedLimit: boolean) => {
  const h = await project('2016-09-05', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 },
    act('A1000', 0, { type: 'start_milestone' }), act('A1010', 5), act('A1020', 3), act('A1030', 8), act('A1040', 0, { type: 'finish_milestone' }),
    ...['A1010', 'A1020', 'A1030'].flatMap((x) => [{ op: 'add_relationship', pred: 'A1000', succ: x }, { op: 'add_relationship', pred: x, succ: 'A1040' }]), on('A1010'), on('A1020')]);
  if (datedLimit) { // the limit is 12 h/d from 8 September
    const e = await call('edit', { handle: h, operations: [{ op: 'add_row', table: 'RSRCRATE', fields: { rsrc_id: getSession(h).db.tables.RSRC.rows[0].rsrc_id, start_date: '2016-09-08 00:00', max_qty_per_hr: '1.5' } }] });
    assert.ok(!e.error, JSON.stringify(e.error));
  }
  return h;
};
test('within float: the float to preserve, and the percent to over-allocate tried only when the activity does not fit (Ten Six, P6 Professional 15.1)', async () => {
  const run = async (dated: boolean, min_float_days: number, over_allocation_pct: number) => { const h = await tenSix(dated); const l = await call('level_resources', { handle: h, within_float: true, min_float_days, over_allocation_pct }); return { a1010: dates(h, 'A1010').remaining, a1020: dates(h, 'A1020').remaining, float: dates(h, 'A1020').float, cannot: l.cannot_be_leveled.length }; };
  // 1: no float kept, no over-allocation: A1020 goes after A1010, inside its 5 days of float (the Total Float column keeps showing 5 days)
  assert.deepEqual(await run(false, 0, 0), { a1010: '09-05..09-09', a1020: '09-12..09-14', float: 5, cannot: 0 });
  // 2: one day of float to keep: it no longer fits, and is not moved
  assert.deepEqual(await run(false, 1, 0), { a1010: '09-05..09-09', a1020: '09-05..09-07', float: 5, cannot: 1 });
  // 3: 50 % over a limit of 12 h/d from 8 September (18 h): the first place that fits is 8 September
  assert.deepEqual(await run(true, 1, 50), { a1010: '09-05..09-09', a1020: '09-08..09-12', float: 5, cannot: 0 });
  // 4: 100 %: it fits where it stands
  assert.deepEqual(await run(true, 1, 100), { a1010: '09-05..09-09', a1020: '09-05..09-07', float: 5, cannot: 0 });
  // 5: the limit itself is tried first, even when the over-allocation would need no move
  assert.deepEqual(await run(true, 0, 100), { a1010: '09-05..09-09', a1020: '09-12..09-14', float: 5, cannot: 0 });
});

test('a chain on one crew is leveled in Activity ID order and the successor is delayed by its predecessor; use equal to the limit fits', async () => {
  // Winter: C1000 -> C1010..C1040 (one crew, 5 days each) ; C1040 -> C1050
  let h = await project('2015-01-26', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('C1000', 5), ...['C1010', 'C1020', 'C1030', 'C1040'].flatMap((x) => [act(x, 5), { op: 'add_relationship', pred: 'C1000', succ: x }, on(x)]), act('C1050', 5), { op: 'add_relationship', pred: 'C1040', succ: 'C1050' }]);
  const l = await call('level_resources', { handle: h });
  assert.deepEqual(['C1010', 'C1020', 'C1030', 'C1040', 'C1050'].map((x) => dates(h, x).remaining), ['02-02..02-06', '02-09..02-13', '02-16..02-20', '02-23..02-27', '03-02..03-06']);
  assert.deepEqual(l.moved.map((m: any) => `${m.id} ${m.delayed_by}`), ['C1020 resource', 'C1030 resource', 'C1040 resource', 'C1050 predecessor']);
  assert.match(l.report, /Activities delayed due to resource leveling\.+3\r\n Activities delayed due to predecessor delay\.+1\r\n/);
  // forum: two unlinked activities at 4 h/d on a limit of 8 h/d run together; at 4.1 h/d one waits for the other
  h = await project('2021-02-01', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 10), act('B', 10), on('A', 'R', 4), on('B', 'R', 4)]);
  assert.equal((await call('level_resources', { handle: h })).delayed, 0);
  h = await project('2021-02-01', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 10), act('B', 10), on('A', 'R', 4.1), on('B', 'R', 4)]);
  assert.deepEqual((await call('level_resources', { handle: h })).moved.map((m: any) => [m.id, m.start.slice(5, 10)]), [['B', '02-15']]);
});

test('the Leveling Priorities: by name, several, descending; the list the project stores is the default; a mandatory constraint goes first', async () => {
  const three = () => project('2021-02-01', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 5), act('B', 3), act('C', 4, { priority: 'low' }), on('A'), on('B'), on('C')]);
  const order = async (args: Record<string, unknown>, before?: (h: string) => Promise<unknown>) => { const h = await three(); await before?.(h); const l = await call('level_resources', { handle: h, ...args }); assert.ok(!l.error, JSON.stringify(l.error)); return { order: ['A', 'B', 'C'].sort((x, y) => row(h, x).restart_date.localeCompare(row(h, y).restart_date)).join(''), l }; };
  assert.equal((await order({})).order, 'ABC', 'the default: Activity Leveling Priority, then the Activity ID');
  assert.equal((await order({ priority_by: 'remaining_duration' })).order, 'BCA');
  assert.equal((await order({ priority_by: ['activity_leveling_priority descending', 'original_duration descending'] })).order, 'CAB');
  assert.equal((await order({ priority_by: 'activity_id descending' })).order, 'CBA');
  // the list the project stores (as P6 writes it in an XER), and a name in it that is no column of the activities
  const stored = (list: string) => (h: string) => call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'SCHEDOPTIONS', all: true, fields: { LevelPriorityList: list } }] }).then((e) => assert.ok(!e.error, JSON.stringify(e.error)));
  assert.equal((await order({}, stored('remain_drtn_hr_cnt,DESC\x7f\x7f'))).order, 'ACB');
  const odd = await order({}, stored('made_up,ASC\x7f\x7fremain_drtn_hr_cnt,ASC'));
  assert.equal(odd.order, 'BCA');
  assert.deepEqual(odd.l.notes.filter((n: string) => /made_up/.test(n)), ['The leveling priorities name "made_up", which is not a column of the activities in this file: left out of the order.']);
  assert.deepEqual(odd.l.settings.priority_by, ['remaining_duration']);
  // an unknown name is refused with the names there are
  const bad = await call('level_resources', { handle: await three(), priority_by: 'colour' });
  assert.match(bad.error.message, /priority_by does not know "colour"/);
  // a mandatory start is taken first, whatever the priorities say
  const m = await order({ priority_by: 'activity_id' }, (h) => call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'C', constraint: { type: 'mandatory_start', date: '2021-02-01' } }] }).then(() => call('schedule', { handle: h })));
  assert.equal(m.order, 'CAB');
});

test('an activity that alone needs more than the limit cannot be leveled: it stays where it is and is listed', async () => {
  const h = await project('2021-02-01', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 5), act('B', 5), on('A'), on('B', 'R', 12)]);
  const l = await call('level_resources', { handle: h });
  assert.deepEqual(l.cannot_be_leveled, [{ id: 'B', why: 'alone it needs 12 h in a day against the limit of 8 h' }]);
  assert.deepEqual(l.notes, ['An activity that alone needs more than the limit of its resource cannot be fitted by a delay: lower its assignment (edit update_assignment) or raise the limit (edit update_resource max_units_per_day).']);
  assert.deepEqual(l.moved, []);
  assert.equal(dates(h, 'B').remaining, '02-01..02-05');
});

test('schedule removes a leveling; schedule with level_resources: true levels after calculating; a dry run and an undo leave nothing behind', async () => {
  const h = await harris('2021-02-27');
  const dry = await call('level_resources', { handle: h, dry_run: true });
  assert.equal(dry.moved.length, 2);
  assert.equal(dates(h, 'A1010').remaining, '02-01..02-05', 'a dry run changes nothing');
  assert.equal(dry.notes.length, 1, 'and has no leveling for schedule to remove');
  await call('level_resources', { handle: h });
  assert.equal(dates(h, 'A1010').remaining, '02-15..02-19');
  await call('schedule', { handle: h });
  assert.equal(dates(h, 'A1010').remaining, '02-01..02-05', 'a calculation works the dates out again from the logic alone');
  const s = await call('schedule', { handle: h, level_resources: true });
  assert.equal(s.ok, true);
  assert.deepEqual(s.leveling.moved.map((m: any) => m.id), ['A1020', 'A1010']);
  assert.equal(dates(h, 'A1010').remaining, '02-15..02-19');
  assert.equal(s.notes.filter((n: string) => /^The leveled dates are the activities' Start and Finish/.test(n)).length, 1);
  assert.equal(s.notes.filter((n: string) => /removes this leveling/.test(n)).length, 0);
  // the options of a leveling given with the calculation, for this run; a name that is no option is refused
  const w = await call('schedule', { handle: h, level_resources: { priority_by: 'activity_id descending' } });
  assert.deepEqual([w.leveling.settings.priority_by, w.leveling.moved.map((m: any) => m.id)], [['activity_id descending'], ['A1010', 'A1000']]);
  assert.equal((await call('schedule', { handle: h, level_resources: { dry_run: true } })).error.message, 'level_resources has no option "dry_run".');
  await call('schedule', { handle: h, level_resources: true });
  // leveling again from the leveled dates moves nothing more
  assert.equal((await call('level_resources', { handle: h })).delayed, 0);
  for (let i = 0; i < 6; i++) await call('undo', { handle: h }); // the leveling that moved nothing, three calculations with leveling, the calculation, the first leveling
  assert.equal(dates(h, 'A1010').remaining, '02-01..02-05');
  // the settings the project stores are the defaults of a call
  await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'SCHEDOPTIONS', all: true, fields: { level_keep_sched_date_flag: 'N' } }] });
  const l = await call('level_resources', { handle: h });
  assert.equal(l.settings.preserve_scheduled_dates, false);
  assert.equal(dates(h, 'A1010').early, '02-15..02-19');
});

test('a loop in the logic: leveling is refused and nothing is changed, as schedule refuses the same network', async () => {
  const h = await project('2021-02-01', [{ op: 'add_resource', id: 'R', max_units_per_day: 8 }, act('A', 5), act('B', 5), act('C', 5), on('A'), on('B'), on('C'), { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  // (the edit tools refuse a loop, so it is put in the rows: a file from another tool can hold one)
  const db = getSession(h).db;
  db.tables.TASKPRED.rows.push({ ...db.tables.TASKPRED.rows[0], task_pred_id: '999', task_id: row(h, 'A').task_id, pred_task_id: row(h, 'B').task_id });
  const before = JSON.stringify(db.tables.TASK.rows), changes = (await call('list_open', {})).open.find((x: any) => x.handle === h).changes;
  for (const dry_run of [true, false]) {
    const l = await call('level_resources', { handle: h, dry_run });
    assert.equal(l.error.message, 'Not leveled: the logic has a loop (A, B): a schedule with a loop is not leveled; change or delete one relationship of the loop.');
  }
  assert.equal(JSON.stringify(db.tables.TASK.rows), before);
  assert.equal((await call('list_open', {})).open.find((x: any) => x.handle === h).changes, changes, 'no undo entry is left');
});
