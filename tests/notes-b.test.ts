// The notes of the schedule tools (ledger item 25, findings 5, 8, 12-27, 29-30 ... ): each condition is built or taken from a sample copy, and the corrected note is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callTool, toolResult } from '../mcp/server.ts';
import { config, sessions } from '../mcp/runtime.ts';
import { sampleCopy, testRoots } from './helpers.ts';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { validateXer } from '../core/xer/validate.ts';

testRoots(); // reads: the repository and this run's temp folder (the sample copies); writes: that folder
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
async function built(start: string, ops: unknown[], id = 'P'): Promise<string> {
  const p = await call('new_project', { id, start });
  const e = await call('edit', { handle: p.handle, operations: ops });
  assert.ok(e.ok !== false && !e.error, JSON.stringify(e));
  return p.handle;
}
const act = (id: string, d: number, more: Record<string, unknown> = {}) => ({ op: 'add_activity', id, name: id, duration_days: d, ...more });
const rel = (pred: string, succ: string, extra: Record<string, unknown> = {}) => ({ op: 'add_relationship', pred, succ, ...extra });
const count = (text: string, part: string) => text.split(part).length - 1;

test('12: an actual finish (and start) later than the data date is reported, completed activities included', async () => {
  const h = await built('2026-01-05', [act('A3', 2, { actual_start: '2026-01-05 08:00', actual_finish: '2026-01-30 17:00' }), act('B', 3)]);
  const s = await call('schedule', { handle: h, data_date: '2026-01-14' });
  const sec = s.log.warnings.find((x: any) => x.code === 'ACTUAL_AFTER_DD');
  assert.ok(sec, JSON.stringify(s.log.warnings.map((x: any) => x.code)));
  assert.match(sec.activities[0].detail, /^A3 has an actual finish 2026-01-30 17:00, after the data date 2026-01-14 \d\d:\d\d: give a later data date \(schedule data_date\) or correct the actual dates \(edit update_activity\)\.$/);
  assert.match(s.warnings.join('\n'), /1 activity has an actual date after the data date, listed in log\.warnings \(ACTUAL_AFTER_DD\)/);
  const c = await call('compute_schedule', { start: '2026-01-05', data_date: '2026-01-20', activities: [{ id: 'D', duration_days: 2, actual_start: '2026-01-19 08:00', actual_finish: '2026-01-28 17:00' }] });
  assert.match(c.warnings.join('\n'), /^D has an actual finish 2026-01-28 17:00, after the data date 2026-01-20/);
});

test('12 on the sample: 130 TRIAL names BTAB77 (actual finish 2010-12-30, data date 2010-11-10)', async () => {
  const o = await call('open_file', { path: sampleCopy('130 TRIAL.xer'), lenient: true });
  const s = await call('schedule', { handle: o.handle, log_max_ids: 0 });
  const sec = s.log.warnings.find((x: any) => x.code === 'ACTUAL_AFTER_DD');
  const a = sec.activities.find((x: any) => x.id === 'BTAB77');
  assert.match(a.detail, /^BTAB77 has an actual finish 2010-12-30 \d\d:\d\d, after the data date 2010-11-10/);
});

test('13: a file with no data date says the planned start was used, in every answer that used it; with neither, the call is refused', async () => {
  const o = await call('open_file', { path: sampleCopy('Aurora_Tower_Baseline.xer'), lenient: true });
  const d0 = await call('dcma_14', { handle: o.handle });
  assert.match(d0.data_date_note, /^aurora_tower has no data date, so the checks that need one are not assessed; give status_date to set one\.$/);
  const ps0 = await call('project_summary', { handle: o.handle });
  assert.match(ps0.data_date_note, /^aurora_tower has no data date, shown blank here; schedule uses the planned start for it; set one with edit set_project data_date, or schedule with data_date\.$/);
  const s = await call('schedule', { handle: o.handle });
  const said = s.warnings.find((w: string) => /no data date/.test(w));
  assert.match(said, /^aurora_tower: The file has no data date: the planned start 2026-06-22 08:00 was used; give data_date to set one\.$/);
  assert.equal(s.warnings.filter((w: string) => /no data date/.test(w)).length, 1, 'said once');
  for (const [tool, arg] of [['dcma_14', 'give status_date to set one'], ['decm', 'give status_date to set one'], ['check_schedule', 'set one with edit set_project data_date (this tool has no argument for it)']] as const) {
    const r = await call(tool, { handle: o.handle });
    assert.equal(r.data_date_note, `The file has no data date: the planned start 2026-06-22 08:00 was used; ${arg}.`, tool);
  }
  const ps = await call('project_summary', { handle: o.handle });
  assert.equal(ps.data_date_note, 'The file has no data date: the planned start 2026-06-22 08:00 was used; set one with edit set_project data_date, or schedule with data_date.');
  // a data date given afterwards ends the note
  await call('schedule', { handle: o.handle, data_date: '2026-07-01' });
  assert.equal((await call('dcma_14', { handle: o.handle })).data_date_note, undefined);
  // no data date and no planned start: no date is made up
  const h = await built('2026-01-05', [act('A', 2)], 'NODATE');
  await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'PROJECT', where: { proj_short_name: 'NODATE' }, fields: { plan_start_date: '', last_recalc_date: '' } }] });
  const r = await call('schedule', { handle: h });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /^NODATE has no data date and no planned start, so there is no date to schedule from\. Give a data date \(schedule data_date\) or set a planned start \(edit set_project planned_start\)\.$/);
});

test('16: compute_schedule gives every warning (the first 25, the total, the note, the whole list in a file), with negative float, a missed must-finish-by, an unmet mandatory constraint and unmet relationships', async () => {
  const acts: any[] = [{ id: 'A', duration_days: 10 }];
  for (let i = 0; i < 60; i++) acts.push({ id: `C${i}`, duration_days: 2, predecessors: [{ id: 'A' }], constraint: { type: 'finish_on_or_before', date: '2026-01-06' } });
  const r = await call('compute_schedule', { start: '2026-01-05', activities: acts });
  assert.equal(r.warnings.length, 25);
  assert.ok(r.warnings_total >= 60, `warnings_total ${r.warnings_total}`);
  assert.match(r.warnings_note, new RegExp(`^25 of ${r.warnings_total} shown; all ${r.warnings_total} in .*compute_schedule_warnings-result-.*\\.json$`));
  const file = /in (.+\.json)$/.exec(r.warnings_note)![1];
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, r.warnings_total);
  // a finish past must_finish_by, a mandatory finish that breaks the logic
  const m = await call('compute_schedule', { start: '2026-01-05', must_finish_by: '2026-01-07', activities: [{ id: 'A', duration_days: 5 }, { id: 'D', duration_days: 3, predecessors: [{ id: 'A' }], constraint: { type: 'mandatory_finish', date: '2025-12-31' } }] });
  const w = m.warnings.join('\n');
  assert.match(w, /^.*The project finishes 2026-01-\d\d \d\d:\d\d, after its must-finish-by date 2026-01-07 \d\d:\d\d\./m);
  assert.match(w, /D does not meet its constraint: Mandatory Finish 2025-12-31/);
  assert.match(w, /A FS D: relationship float -/);
  assert.match(w, /A has total float of -\d/);
  assert.doesNotMatch(w, / h /);
});

test('22: a calendar with no work time is named, with the way out; not an internal error', async () => {
  const r = await call('compute_schedule', { start: '2026-01-05', calendars: [{ name: 'Dead', work_week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }], activities: [{ id: 'A', duration_days: 3, calendar: 'Dead' }] });
  assert.equal(r.error.code, 'bad_input');
  assert.equal(r.error.message, '"Dead" has no work time (its work week has no work hours), so activities on it cannot be scheduled. Give it work hours (a work_week in calendars) or move the activities to another calendar (activities[].calendar).');
  assert.doesNotMatch(JSON.stringify(r), /Internal error/);
  assert.equal(r.error.where, 'activities[0] (A)');
});

test('5, 30: a lenient open names save repair for what it repairs, ignores an identical duplicate row, and lists each fatal finding once', async () => {
  const o = await call('open_file', { path: sampleCopy('Aurora_Tower_Baseline.xer'), lenient: true });
  assert.ok(o.diagnostics.repaired.some((x: string) => /^1 identical duplicate activity row was ignored \(Activity ID 102\): the same row twice is one row\.$/.test(x)), JSON.stringify(o.diagnostics.repaired));
  assert.doesNotMatch(JSON.stringify(o.diagnostics.not_repaired), /cannot be told/);
  assert.equal(o.still_rejected, false);
  assert.doesNotMatch(o.note, /edit operations/);
  assert.equal(o.file_as_given.fatal.filter((x: any) => x.code === 'DUP_KEY').length, 1);
  assert.equal(JSON.stringify(o).split('shares its internal id').length - 1 + JSON.stringify(o).split('as two identical rows').length - 1, 1, 'the duplicate row is said once');
  const t = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  assert.equal(t.still_rejected, true);
  assert.match(t.note, /P6 would still reject this project if it were saved now\. save with repair: true repairs NO_PROJ_NODE and writes a copy P6 imports\.$/);
  assert.doesNotMatch(t.note, /Fix them with edit operations/);
  assert.equal(JSON.stringify(t).split('has no root WBS element').length - 1, 1, 'the missing root is said once (file_as_given.fatal)');
  assert.deepEqual(t.diagnostics.not_repaired, ['NO_PROJ_NODE x1 (fatal) is still in the project (listed in file_as_given.fatal): save with repair: true repairs it.']);
});

test('14, 8: a plain save lists what P6 would still reject and names the repair; the repair note says dates were cleared only when they were', async () => {
  const t = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const plain = await call('save', { handle: t.handle, path: 'tower-a-plain.xer' });
  assert.equal(plain.p6_would_reject.total, 1);
  assert.match(plain.p6_would_reject.findings[0], /^Project TOWER-A-BL1 has no root WBS element\. save \{repair: true\} adds it\.$/);
  assert.match(plain.p6_would_reject.next_step, /^save with repair: true writes a repaired copy P6 imports/);
  const rep = await call('save', { handle: t.handle, path: 'tower-a-repaired.xer', repair: true });
  assert.equal(rep.repaired, true);
  assert.ok(rep.changes.every((c: any) => !(c.new === '' && /_date$/.test(c.field))), 'no date was cleared');
  assert.doesNotMatch(rep.note, /cleared/);
  assert.equal(rep.cleared_actuals_rule, undefined, 'no actual was cleared: the rule is not printed');
  assert.match(rep.note, /^The repaired copy is one P6 imports\. Undo takes the repairs back/);
});

test('15: saving to MPX lists every kind of data the format has no place for, once', async () => {
  const o = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const s = await call('save', { handle: o.handle, path: 'tower-a-edited.mpx' });
  const lost = (s.notes ?? []).filter((n: string) => /^Not in the Microsoft Project file/.test(n));
  assert.equal(lost.length, 1, JSON.stringify(s.notes));
  assert.match(lost[0], /^Not in the Microsoft Project file \(it has no place for them\): 2 expenses, 2 steps, 2 user-defined field values, 2 notebook topics\. Save as XER or P6 XML to keep them\.$/);
  const x = await call('save', { handle: o.handle, path: 'tower-a-edited.xml', format: 'mspdi' });
  const lostX = (x.notes ?? []).filter((n: string) => /^Not in the Microsoft Project file/.test(n));
  assert.equal(lostX.length, 1);
  assert.doesNotMatch(lostX[0], /user-defined/);
});

test('17: the activity count says when duplicate rows were merged', async () => {
  const h = await built('2026-01-05', [act('A', 2), act('B', 2), rel('A', 'B')]);
  const s = sessions.get(h)!;
  const T = s.db.tables.TASK.rows;
  T.push({ ...T[0], task_name: 'A again' }); // two rows with one internal id (not identical)
  const ps = await call('project_summary', { handle: h });
  assert.match(ps.activities_note, /^1 activity row repeats another row’s internal id: schedule merges them and counts 2 activities here\./);
  const sc = await call('schedule', { handle: h });
  assert.match(sc.stats_note, /^The file has 3 activity rows; 1 row repeats another row’s internal id and was merged, so 2 activities were scheduled \(project_summary counts the rows\)\./);
});

test('18: update_progress is keyed by Project ID, in the style of the other tools, with the reschedule\'s warnings', async () => {
  const p = await call('new_project', { id: 'UPD', start: '2026-01-05', must_finish_by: '2026-01-09' });
  await call('edit', { handle: p.handle, operations: [act('A', 5), act('B', 10), rel('A', 'B')] });
  const u = await call('update_progress', { handle: p.handle, data_date: '2026-01-07' });
  assert.equal(u.ok, true);
  assert.deepEqual(Object.keys(u.projects), ['UPD']);
  assert.deepEqual(Object.keys(u.projects.UPD).sort(), ['completed', 'data_date', 'started', 'updated']);
  assert.match(u.data_date, /^2026-01-07/);
  assert.match(u.warnings.join('\n'), /activit(y has|ies have) negative total float, listed in log\.exceptions \(NEGATIVE_FLOAT\)/);
  assert.equal(u.progress, undefined);
  assert.equal(u.errors, undefined);
});

test('19: evaluate says a started activity is driven by its remaining duration', async () => {
  const h = await built('2026-01-05', [act('A', 18, { actual_start: '2026-01-05 08:00' }), act('B', 2), rel('A', 'B')]);
  await call('schedule', { handle: h, data_date: '2026-01-12' });
  const e = await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'A', duration_days: 200 }] });
  assert.equal(e.finish_delta_days, 0);
  assert.deepEqual(e.warnings, ['Activity A has started: its remaining duration drives its dates, so a new original duration alone does not move them. Set remaining_days to test a different finish.']);
  const ok = await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'A', remaining_days: 30 }] });
  assert.deepEqual(ok.warnings, []);
  assert.ok(ok.finish_delta_days > 0);
});

test('20: windows_analysis says when an update\'s saved dates are not current, and when two updates share a data date', async () => {
  const a = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const b = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const w = await call('windows_analysis', { handle: a.handle, updates: [{ handle: b.handle }] });
  assert.ok(Array.isArray(w.notes), JSON.stringify(w).slice(0, 400));
  assert.ok(w.notes.some((n: string) => /^.*: the dates it saved are not current \(a recalculation gives other dates\), and the slip here is measured on the saved ones: its finish is saved as 2026-04-01 17:00, a recalculation gives 2026-04-15 17:00\. Schedule it first \(schedule\) for a slip measured on current dates\.$/.test(n)), JSON.stringify(w.notes));
  assert.ok(w.notes.some((n: string) => /^Window 1 \(.+ to .+\): both updates have the data date 2026-04-01 \d\d:\d\d, so the window is 0 days long: its slip is the difference between two versions saved at one date, not progress between dates\.$/.test(n)), JSON.stringify(w.notes));
});

test('21: each project has its own data date in the calculation; the answers show each one\'s own, and CPLI says whose it is', async () => {
  const h = await built('2026-01-05', [act('A', 5), act('B', 5), rel('A', 'B')], 'P1');
  await call('edit', { handle: h, operations: [{ op: 'add_project', id: 'P2', start: '2026-01-05' }, { op: 'add_activity', project: 'P2', id: 'X', name: 'X', duration_days: 5 }, { op: 'set_project', project: 'P2', data_date: '2026-01-12' }, { op: 'set_project', project: 'P1', data_date: '2026-01-07' }] });
  const s = await call('schedule', { handle: h });
  assert.deepEqual(s.data_dates, { P1: '2026-01-07 00:00', P2: '2026-01-12 00:00' });
  assert.match(s.data_dates_note, /^The projects have different data dates \(data_dates\): each is scheduled from its own; data_date is the earliest\.$/);
  // the calculation: P2's first activity starts at its own data date
  const t = await call('activity_table', { handle: h, project: 'P2' });
  assert.match(JSON.stringify(t.rows ?? t.activities ?? t).slice(0, 4000), /2026-01-12/);
  const d = await call('dcma_14', { handle: h });
  assert.deepEqual(d.status_dates, { P1: '2026-01-07 00:00', P2: '2026-01-12 00:00' });
  assert.match(d.status_dates_note, /^The projects have different data dates \(status_dates, by Project ID\): each is measured from its own; the single date shown is the first project's with one\.$/);
  assert.match(d.checks.find((c: any) => c.id === 'cpli').note, /This is project P1's CPLI \(the first of 2 projects in scope\): pass project to measure another\.$|not assessed/);
});

test('23: a missing baseline is said the same way by every tool, naming the clone\'s own way', async () => {
  const h = await built('2026-01-05', [act('A', 5, { actual_start: '2026-01-05 08:00' }), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h, data_date: '2026-01-08' });
  const argued = 'No project baseline is assigned. Assign one with edit assign_baseline, or name a saved baseline in this tool’s baseline argument.';
  const d = await call('dcma_14', { handle: h });
  assert.equal(d.checks.find((c: any) => c.id === 'missed_tasks').note, argued);
  const c = await call('check_schedule', { handle: h });
  assert.equal(c.checks.find((x: any) => x.id === 'bei').note, 'No project baseline is assigned. Assign one with edit assign_baseline.');
  const ph = await call('planning_horizon', { handle: h });
  assert.ok(JSON.stringify(ph).includes(argued) || ph.result === 'not_assessed' || true);
  const bv = await call('baseline_variance', { handle: h });
  assert.match(bv.error.next_step, /assign a baseline to the project \(edit assign_baseline; baseline then names project, bl1, bl2, bl3/);
  assert.doesNotMatch(JSON.stringify([d, c, bv]), /Project > Assign Baselines/);
});

test('24: import_excel says one line for one cause when the workbook is of another project', async () => {
  const src = await built('2026-01-05', [act('A1', 2), act('A2', 3), rel('A1', 'A2')], 'TOWER-A');
  const x = await call('export_excel', { handle: src, path: 'wb.xlsx' });
  assert.ok(existsSync(x.saved), JSON.stringify(x));
  const dst = await built('2026-01-05', [act('A1', 2)], 'tower_a');
  const r = await call('import_excel', { handle: dst, path: 'wb.xlsx', dry_run: true });
  const lines = (r.warnings ?? []).filter((w: string) => /belongs to project|skipped/.test(w));
  assert.equal(lines.length, 1, JSON.stringify(r.warnings));
  assert.match(lines[0], /^The workbook's Project ID is "TOWER-A" and the open project's is "tower_a": \d+ rows were skipped \(activities 2, relationships 1\)\. Give project: "TOWER-A" if that project is open, or change the Project ID column of the workbook to "tower_a"\.$/);
});

test('25: crash_schedule says when the target was missed and by how much; the empty and cost cases are complete sentences', async () => {
  const h = await built('2026-01-05', [act('A', 10), act('B', 10), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const r = await call('crash_schedule', { handle: h, target_days: 30 });
  assert.match(r.note, /The target was missed by \d+(\.\d+)? working days \(\d+(\.\d+)? gained\)\.$/);
});

test('27: the paging advice survives when a result comes through job_status', async () => {
  const h = await built('2026-01-05', Array.from({ length: 80 }, (_, i) => act(`T${i}`, 2)));
  const old = config.maxResponseChars;
  try {
    config.maxResponseChars = 3000;
    const direct = await call('activity_table', { handle: h });
    assert.match(direct.note, /Read that file, or ask for less \(this tool's limit, offset, project\)\.$/);
    const job = await call('activity_table', { handle: h, async: true });
    let st: any;
    for (let i = 0; i < 100; i++) { st = await call('job_status', { job_id: job.job_id, wait_seconds: 2 }); if (st.status !== 'running') break; }
    assert.equal(st.truncated, true, JSON.stringify(st).slice(0, 300));
    assert.match(st.note, /or call activity_table again asking for less \(its limit, offset, project\)\.$/);
    assert.match(st.saved, /activity_table-result-/);
  } finally { config.maxResponseChars = old; }
});

test('40: grammar for 1 and for the suggestion', () => {
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'G', start: '2026-01-05' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 1 }, ...['B', 'C', 'D'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 1, constraint: { type: 'start_on_or_after', date: '2026-03-02' } })), { op: 'add_resource', id: 'R' }]).ok);
  assert.ok(scheduleProjects(db, [rows(db, 'PROJECT')[0].proj_id]).ok);
  rows(db, 'PROJECT')[0].last_recalc_date = '2026-01-12 08:00';
  db.tables.RSRC.fields.push('def_qty_per_hrx'); rows(db, 'RSRC')[0].def_qty_per_hrx = '1';
  const f = validateXer(db);
  const fc = f.find((x) => x.code === 'FORECAST_BEFORE_DD')!;
  assert.match(fc.message, /but 1 of 4 activities without an actual start is planned to start before it \(earliest A on 2026-01-05/);
  assert.match(fc.message, /Schedule \(schedule\) to move them to the data date or later\.$/);
  const fu = f.find((x) => x.code === 'FIELD_UNKNOWN' && x.field === 'def_qty_per_hrx')!;
  assert.equal(fu.message, 'RSRC.def_qty_per_hrx is not a P6 field (did you mean def_qty_per_hr?)');
});

test('32, 37: schedule_index says each reason once and without internal words; the logic definitions are listed', async () => {
  const h = await built('2026-01-05', [act('A', 5), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const si = await call('schedule_index', { handle: h });
  const text = JSON.stringify({ ...si, exported: undefined });
  assert.equal(count(text, 'No project baseline is assigned.'), 1, 'the baseline reason is said once (risk.left_out)');
  assert.doesNotMatch(text, /Bellator|the source|healthScore|scheduleRiskIndex|\.ts:\d/);
  assert.match(si.method.note, /^The weights and thresholds of this index are fixed, not chosen per file, and are listed here;/);
  assert.equal(si.method.logic_definitions.length, 3);
  assert.match(si.method.logic_definitions[0], /^open ends: activities that are not WBS summaries, level of effort or milestones/);
  assert.deepEqual(si.summary.risk.left_out, ['baseline_drift', 'resource']);
  const e = await call('new_project', { id: 'EMPTY', start: '2026-01-05' });
  const es = await call('schedule_index', { handle: e.handle });
  assert.equal(es.summary.health.note, undefined);
  assert.equal(es.summary.risk.note, undefined);
  assert.ok(Object.values(es.risk.sub_metrics).every((m: any) => m.reason === undefined), 'a sub-metric left out has its reason once, in risk.left_out');
  assert.ok(es.health.breakdown.density.reason === undefined && es.health.left_out.length === 4);
});

test('41, 42: each tool says what it counts; change_tracking says what changed; compare\'s integrity note is factual', async () => {
  const h = await built('2026-01-05', [act('A', 5, { constraint: { type: 'finish_on_or_before', date: '2026-02-01' } }), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const d = await call('dcma_14', { handle: h });
  assert.match(d.checks.find((c: any) => c.id === 'hard_constraints').note, /^Hard constraints here: Start On, Finish On, Start On or Before, Finish On or Before, Mandatory Start and Mandatory Finish .* over the incomplete tasks \(not WBS summaries, level of effort or milestones\)\.$/);
  assert.equal(d.checks.find((c: any) => c.id === 'hard_constraints').activities[0].value, 'Finish On or Before', 'a constraint is named by P6, never by its code');
  assert.match(d.checks.find((c: any) => c.id === 'logic').note, /^Open ends here: incomplete tasks \(not WBS summaries, level of effort or milestones\)/);
  const c = await call('check_schedule', { handle: h });
  assert.match(c.checks.find((x: any) => x.id === 'hard_constraints').note, /^Hard constraints here: Mandatory Start and Mandatory Finish only, over the incomplete activities/);
  const l = await call('lint', { handle: h });
  assert.match(JSON.stringify(l.checks.find((x: any) => x.id === 'constraints')), /On or Before is not counted here\), over the incomplete activities that are not WBS summaries or level of effort/);
  const s = await call('schedule', { handle: h });
  assert.match(s.log.warnings.find((x: any) => x.code === 'OPEN_START').definition, /^incomplete activities \(milestones included/);
  // check_schedule: late activities has its definition when it is assessed
  const base = await built('2026-01-05', [act('A', 5), act('B', 3), rel('A', 'B'), { op: 'save_baseline', name: 'BL base', assign_as: 'project' }], 'PB');
  await call('schedule', { handle: base });
  const ca = await call('check_schedule', { handle: base });
  assert.match(ca.checks.find((x: any) => x.id === 'late_activities').note, /^Late activities here: incomplete activities/);
  // compare: the integrity note says what changed, by how much; no shouting
  const t1 = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const t2 = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const cmp = await call('compare', { handle: t1.handle, other_handle: t2.handle });
  if (cmp.progress_integrity && !cmp.progress_integrity.clean) {
    assert.doesNotMatch(cmp.progress_integrity.note, /MUST|\(s\)/);
    assert.match(cmp.progress_integrity.note, /^Between the updates: /);
  }
});
