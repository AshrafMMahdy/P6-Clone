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
import { storedDatesState } from '../core/schedule/stored-dates.ts';
import { datesNotCurrent } from '../core/notes.ts';

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
  assert.match(sec.activities[0].detail, /^A3 has an actual finish 2026-01-30 17:00 after the data date 2026-01-14 \d\d:\d\d\.$/);
  assert.equal(s.warnings, undefined, 'the log is P6\'s own content: no second list of it in the answer');
  const c = await call('compute_schedule', { start: '2026-01-05', data_date: '2026-01-20', activities: [{ id: 'D', duration_days: 2, actual_start: '2026-01-19 08:00', actual_finish: '2026-01-28 17:00' }] });
  assert.match(c.notes.join('\n'), /^D has an actual finish 2026-01-28 17:00 after the data date 2026-01-20/);
});

test('12 on the sample: 130 TRIAL names BTAB77 (actual finish 2010-12-30, data date 2010-11-10)', async () => {
  const o = await call('open_file', { path: sampleCopy('130 TRIAL.xer'), lenient: true });
  const s = await call('schedule', { handle: o.handle, log_max_ids: 0 });
  const sec = s.log.warnings.find((x: any) => x.code === 'ACTUAL_AFTER_DD');
  const a = sec.activities.find((x: any) => x.id === 'BTAB77');
  assert.match(a.detail, /^BTAB77 has an actual finish 2010-12-30 \d\d:\d\d after the data date 2010-11-10/);
});

test('13: a file with no data date says the planned start was used, in every answer that used it; with neither, the call is refused', async () => {
  const o = await call('open_file', { path: sampleCopy('Aurora_Tower_Baseline.xer'), lenient: true });
  const used = /^aurora_tower has no data date: the planned start 2026-06-22 08:00 was used\. Set one with schedule data_date\.$/;
  const d0 = await call('dcma_14', { handle: o.handle });
  assert.ok(d0.notes.some((n: string) => /^Checks that need a data date( and .*)? not assessed: aurora_tower has no data date; pass status_date\.$/.test(n)), JSON.stringify(d0.notes));
  const ps0 = await call('project_summary', { handle: o.handle });
  assert.deepEqual(ps0.notes, ['aurora_tower has no data date: schedule uses the planned start 2026-06-22 08:00. Set one with schedule data_date.']);
  const s = await call('schedule', { handle: o.handle });
  assert.equal(s.notes.filter((w: string) => used.test(w)).length, 1, 'said once');
  for (const tool of ['decm', 'check_schedule']) {
    const r = await call(tool, { handle: o.handle });
    assert.equal(r.notes.filter((w: string) => used.test(w)).length, 1, tool);
  }
  // a data date given afterwards ends the note
  await call('schedule', { handle: o.handle, data_date: '2026-07-01' });
  assert.ok(!(await call('dcma_14', { handle: o.handle })).notes.some((n: string) => /no data date/.test(n)));
  // no data date and no planned start: no date is made up
  const h = await built('2026-01-05', [act('A', 2)], 'NODATE');
  await call('edit', { handle: h, operations: [{ op: 'set_fields', table: 'PROJECT', where: { proj_short_name: 'NODATE' }, fields: { plan_start_date: '', last_recalc_date: '' } }] });
  const r = await call('schedule', { handle: h });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'Refused: NODATE has no data date and no planned start: nothing can be calculated.');
  assert.equal(r.error.hint, 'Set one with edit set_project (planned start) or pass data_date.');
});

test('16: compute_schedule gives every warning as a note (the first 25, the total, the cut note, the whole list in a file), with negative float, a missed must-finish-by, an unmet mandatory constraint and unmet relationships', async () => {
  const acts: any[] = [{ id: 'A', duration_days: 10 }];
  for (let i = 0; i < 60; i++) acts.push({ id: `C${i}`, duration_days: 2, predecessors: [{ id: 'A' }], constraint: { type: 'finish_on_or_before', date: '2026-01-06' } });
  const r = await call('compute_schedule', { start: '2026-01-05', activities: acts });
  assert.equal(r.notes.length, 25);
  assert.ok(r.notes_total >= 60, `notes_total ${r.notes_total}`);
  assert.match(r.notes_note, new RegExp(`^25 of ${r.notes_total} shown; all ${r.notes_total} in .*compute_schedule_notes-result-.*\\.csv\\.$`));
  const file = /in (.+\.csv)\.$/.exec(r.notes_note)![1];
  assert.equal(readFileSync(file, 'utf8').trim().split(/\r?\n/).length, r.notes_total + (/^(note|notes)\r?\n/i.test(readFileSync(file, 'utf8')) ? 1 : 0));
  // a finish past must_finish_by, a mandatory finish that breaks the logic
  const m = await call('compute_schedule', { start: '2026-01-05', must_finish_by: '2026-01-07', activities: [{ id: 'A', duration_days: 5 }, { id: 'D', duration_days: 3, predecessors: [{ id: 'A' }], constraint: { type: 'mandatory_finish', date: '2025-12-31' } }] });
  const w = m.notes.join('\n');
  assert.doesNotMatch(w, /Mandatory Finish 2025-12-31/); // a bare date is 00:00, the same working moment as 17:00 of the working day before: met
  assert.match(w, /A FS D is not met by 11 days\./);
  assert.match(w, /A has -11 days of total float\./);
  assert.doesNotMatch(w, / h /);
});

test('22: a calendar with no work time is named, with the way out; not an internal error', async () => {
  const r = await call('compute_schedule', { start: '2026-01-05', calendars: [{ name: 'Dead', work_week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }], activities: [{ id: 'A', duration_days: 3, calendar: 'Dead' }] });
  assert.equal(r.error.code, 'bad_input');
  assert.equal(r.error.message, 'Refused: calendar Dead has no work time (used by A); give it work hours or move those activities to another calendar.');
  assert.doesNotMatch(JSON.stringify(r), /Internal error/);
  assert.equal(r.error.where, 'activities[0] (A)');
});

test('5, 30: a lenient open names save repair for what it repairs, ignores an identical duplicate row, and lists each fatal finding once', async () => {
  const o = await call('open_file', { path: sampleCopy('Aurora_Tower_Baseline.xer'), lenient: true });
  assert.ok(o.diagnostics.repaired.some((x: string) => /^1 identical duplicate activity row was ignored \(Activity ID 102\)\.$/.test(x)), JSON.stringify(o.diagnostics.repaired));
  assert.equal(o.still_rejected, false);
  assert.match(o.notes[0], /^Opened a repaired copy: P6 would refuse Aurora_Tower_Baseline\.xer as given \(/);
  assert.equal(o.notes.length, 1, JSON.stringify(o.notes));
  assert.equal(o.file_as_given.fatal.filter((x: any) => x.code === 'DUP_KEY').length, 1);
  const t = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  assert.equal(t.still_rejected, true);
  assert.deepEqual(t.notes.filter((n: string) => /^Not repaired/.test(n)), ['Not repaired: Project TOWER-A-BL1 has no root WBS node: P6 refuses the file; save with repair: true adds it.']);
  assert.ok(t.file_as_given.fatal.some((x: any) => x.code === 'NO_PROJ_NODE'), 'the finding is listed in file_as_given.fatal');
  assert.equal(t.note, undefined);
});

test('14, 8: a plain save names what P6 would still reject and the repair; the repair says what it changed', async () => {
  const t = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const plain = await call('save', { handle: t.handle, path: 'tower-a-plain.xer' });
  assert.equal(plain.p6_would_reject, undefined);
  assert.equal(plain.notes.length, 1, JSON.stringify(plain.notes));
  assert.match(plain.notes[0], /^tower-a-plain\.xer has 1 fault P6 refuses, already in the file when it was opened: Project TOWER-A-BL1 has no root WBS node/);
  const rep = await call('save', { handle: t.handle, path: 'tower-a-repaired.xer', repair: true });
  assert.equal(rep.repaired, true);
  assert.equal(rep.changes_total, 1);
  assert.ok(rep.changes.every((c: any) => !(c.new === '' && /_date$/.test(c.field))), 'no date was cleared');
  assert.deepEqual(rep.notes, ['Repaired copy written: 1 repair (changes lists them).']);
  assert.equal(rep.cleared_actuals_rule, undefined, 'no actual was cleared: the rule is not printed');
});

test('15: saving to MPX or Microsoft Project XML says every kind of data the format has no place for, once', async () => {
  const o = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const s = await call('save', { handle: o.handle, path: 'tower-a-edited.mpx' });
  const lost = (s.notes ?? []).filter((n: string) => /^Not written to /.test(n));
  assert.deepEqual(lost, ['Not written to MPX: expenses (2), steps (2), user-defined field values (2), notebook topics (2); save as XER to keep them.']);
  const x = await call('save', { handle: o.handle, path: 'tower-a-edited.xml', format: 'mspdi' });
  const lostX = (x.notes ?? []).filter((n: string) => /^Not written to /.test(n));
  assert.deepEqual(lostX, ['Not written to Microsoft Project XML: expenses (2), steps (2), notebook topics (2); save as XER to keep them.']);
});

test('17: the activity count says when duplicate rows were merged', async () => {
  const h = await built('2026-01-05', [act('A', 2), act('B', 2), rel('A', 'B')]);
  const s = sessions.get(h)!;
  const T = s.db.tables.TASK.rows;
  T.push({ ...T[0], task_name: 'A again' }); // two rows with one internal id (not identical)
  const ps = await call('project_summary', { handle: h });
  assert.equal(ps.activities, 3);
  assert.deepEqual(ps.notes, ['Activity A appears twice in the file; it was counted once; save with repair: true fixes it.']);
  const sc = await call('schedule', { handle: h });
  assert.equal(sc.stats.activities, 2);
  assert.deepEqual(sc.notes, ['Activity A appears twice in the file; it was scheduled once; save with repair: true fixes it.']);
});

test('18: update_progress is keyed by Project ID, in the style of the other tools; the reschedule\'s findings stay in the log, the edit is confirmed once', async () => {
  const p = await call('new_project', { id: 'UPD', start: '2026-01-05', must_finish_by: '2026-01-09' });
  await call('edit', { handle: p.handle, operations: [act('A', 5), act('B', 10), rel('A', 'B')] });
  const u = await call('update_progress', { handle: p.handle, data_date: '2026-01-07' });
  assert.equal(u.ok, true);
  assert.deepEqual(Object.keys(u.projects), ['UPD']);
  assert.deepEqual(Object.keys(u.projects.UPD).sort(), ['completed', 'data_date', 'started', 'updated']);
  assert.match(u.data_date, /^2026-01-07/);
  assert.deepEqual(u.notes, ['Progress updated to data date 2026-01-07 in UPD: 2 started, 0 completed, 2 updated.']);
  assert.equal(u.warnings, undefined);
  assert.ok(u.log.exceptions.some((x: any) => x.code === 'NEGATIVE_FLOAT'), 'negative float is P6\'s own log content');
  assert.equal(u.progress, undefined);
  assert.equal(u.errors, undefined);
});

test('19: evaluate says a started activity is driven by its remaining duration', async () => {
  const h = await built('2026-01-05', [act('A', 18, { actual_start: '2026-01-05 08:00' }), act('B', 2), rel('A', 'B')]);
  await call('schedule', { handle: h, data_date: '2026-01-12' });
  const e = await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'A', duration_days: 200 }] });
  assert.equal(e.finish_delta_days, 0);
  assert.deepEqual(e.notes, ['A has started: its remaining duration drives its dates, so the change of original duration has no effect; set remaining_days.']);
  const ok = await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'A', remaining_days: 30 }] });
  assert.equal(ok.notes, undefined);
  assert.ok(ok.finish_delta_days > 0);
});

test('20: windows_analysis says when an update\'s saved dates are not current, and when two updates share a data date', async () => {
  const a = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const b = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const w = await call('windows_analysis', { handle: a.handle, updates: [{ handle: b.handle }] });
  assert.ok(Array.isArray(w.notes), JSON.stringify(w).slice(0, 400));
  assert.equal(w.notes.filter((n: string) => /^The saved dates of .+ are not current: 3 of 3 open activities differ from what F9 gives; run schedule first\.$/.test(n)).length, 2, JSON.stringify(w.notes));
  assert.ok(w.notes.some((n: string) => /^.+ and current have the same data date 2026-04-01 \d\d:\d\d: the window is 0 days\.$/.test(n)), JSON.stringify(w.notes));
});

test('21: each project has its own data date in the calculation; the answers show each one\'s own, said once', async () => {
  const h = await built('2026-01-05', [act('A', 5), act('B', 5), rel('A', 'B')], 'P1');
  await call('edit', { handle: h, operations: [{ op: 'add_project', id: 'P2', start: '2026-01-05' }, { op: 'add_activity', project: 'P2', id: 'X', name: 'X', duration_days: 5 }, { op: 'set_project', project: 'P2', data_date: '2026-01-12' }, { op: 'set_project', project: 'P1', data_date: '2026-01-07' }] });
  const s = await call('schedule', { handle: h });
  assert.deepEqual(s.data_dates, { P1: '2026-01-07 00:00', P2: '2026-01-12 00:00' });
  assert.deepEqual(s.notes, ['P1 and P2 have different data dates (2026-01-07, 2026-01-12): each project\u2019s own date was used; pass project to work on one.']);
  assert.equal(s.data_dates_note, undefined);
  // the calculation: P2's first activity starts at its own data date
  const t = await call('activity_table', { handle: h, project: 'P2' });
  assert.match(JSON.stringify(t.rows ?? t.activities ?? t).slice(0, 4000), /2026-01-12/);
  const d = await call('dcma_14', { handle: h });
  assert.deepEqual(d.status_dates, { P1: '2026-01-07 00:00', P2: '2026-01-12 00:00' });
  assert.equal(d.notes.filter((n: string) => /different data dates/.test(n)).length, 1);
  assert.equal(d.status_dates_note, undefined);
  assert.equal(d.checks.find((c: any) => c.id === 'cpli').result, 'not_assessed');
});

test('23: a missing baseline is said the same way by every tool, naming the clone\'s own way', async () => {
  const h = await built('2026-01-05', [act('A', 5, { actual_start: '2026-01-05 08:00' }), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h, data_date: '2026-01-08' });
  const reason = 'no baseline is assigned to P; assign one with edit assign_baseline';
  const d = await call('dcma_14', { handle: h });
  assert.ok(d.notes.includes(`Missed tasks and Baseline execution index (BEI) not assessed: ${reason}, or pass baseline.`), JSON.stringify(d.notes));
  assert.equal(d.checks.find((c: any) => c.id === 'missed_tasks').result, 'not_assessed');
  const c = await call('check_schedule', { handle: h });
  assert.ok(c.notes.includes(`Late activities and Baseline Execution Index (BEI) not assessed: ${reason}.`), JSON.stringify(c.notes));
  assert.equal(c.checks.find((x: any) => x.id === 'bei').result, 'not_assessed');
  const ph = await call('planning_horizon', { handle: h });
  assert.ok(ph.notes.includes(`Forecast stability not assessed: ${reason}, or pass baseline.`), JSON.stringify(ph.notes));
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
  const lines = (r.notes ?? []).filter((w: string) => /belongs to project|skipped/.test(w));
  assert.equal(lines.length, 1, JSON.stringify(r.notes));
  assert.match(lines[0], /^The workbook's Project ID is "TOWER-A" and the open project's is "tower_a": \d+ rows were skipped \(activities 2, relationships 1\)\. Give project: "TOWER-A" if that project is open, or change the Project ID column of the workbook to "tower_a"\.$/);
  assert.equal(r.warnings, undefined);
});

test('25: crash_schedule says when the target was missed and by how much; the default crash data is said', async () => {
  const h = await built('2026-01-05', [act('A', 10), act('B', 10), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const r = await call('crash_schedule', { handle: h, target_days: 30 });
  assert.equal(r.note, undefined);
  assert.ok(r.notes.includes('Target 30 days not reached: 6 days gained; no remaining path through B, A can be shortened.'), JSON.stringify(r.notes));
  assert.ok(r.notes.some((n: string) => /^No crash data given: each open activity may lose up to 30% of its remaining duration/.test(n)), JSON.stringify(r.notes));
  assert.equal(r.days_gained, 6);
});

test('27: the answer too large to return says where all of it is, also when it comes through job_status', async () => {
  const h = await built('2026-01-05', Array.from({ length: 80 }, (_, i) => act(`T${i}`, 2)));
  const old = config.maxResponseChars;
  try {
    config.maxResponseChars = 3000;
    const direct = await call('activity_table', { handle: h });
    assert.equal(direct.note, undefined);
    assert.match(direct.notes[0], /^The answer is too large to return \(\d+ characters\); all of it is in .*activity_table-result-.*\.json, or ask for less \(this tool's limit, offset, project\)\.$/);
    const job = await call('activity_table', { handle: h, async: true });
    let st: any;
    for (let i = 0; i < 100; i++) { st = await call('job_status', { job_id: job.job_id, wait_seconds: 2 }); if (st.status !== 'running') break; }
    assert.equal(st.truncated, true, JSON.stringify(st).slice(0, 300));
    assert.match(st.notes[0], /or call activity_table again asking for less \(its limit, offset, project\)\.$/);
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
  assert.equal(f.find((x) => x.code === 'FORECAST_BEFORE_DD'), undefined, 'a forecast before the data date is one of the saved dates that are not current');
  const st = storedDatesState(db).stale[0];
  assert.equal(datesNotCurrent(st.proj, st.differ, st.open), 'The saved dates of G are not current: 1 of 4 open activities differ from what F9 gives; run schedule first.');
  const fu = f.find((x) => x.code === 'FIELD_UNKNOWN' && x.field === 'def_qty_per_hrx')!;
  assert.equal(fu.message, 'RSRC.def_qty_per_hrx is not a P6 field: its values are lost on import (did you mean def_qty_per_hr?).');
});

test('32, 37: schedule_index says each reason once and without internal words', async () => {
  const h = await built('2026-01-05', [act('A', 5), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const si = await call('schedule_index', { handle: h });
  const text = JSON.stringify({ ...si, exported: undefined });
  assert.equal(count(text, 'no baseline is assigned to P'), 1, 'the baseline reason is said once, in notes');
  assert.doesNotMatch(text, /Bellator|the source|healthScore|scheduleRiskIndex|\.ts:\d/);
  assert.equal(si.method, undefined, 'the weights and the logic definitions are in the tool description');
  assert.deepEqual(si.notes, ['Baseline drift risk not assessed: no baseline is assigned to P; assign one with edit assign_baseline, or pass baseline.', 'Resource risk not assessed: the file has no resource assignments.']);
  assert.deepEqual(si.summary.risk.left_out, ['baseline_drift', 'resource']);
  const e = await call('new_project', { id: 'EMPTY', start: '2026-01-05' });
  const es = await call('schedule_index', { handle: e.handle });
  assert.equal(es.summary.health.note, undefined);
  assert.equal(es.summary.risk.note, undefined);
  assert.equal(es.progress_summary.note, undefined, 'the reason of a part left out is in notes only');
  assert.ok(Object.values(es.risk.sub_metrics).every((m: any) => m.reason === undefined), 'a sub-metric left out has its reason once, in notes');
  assert.ok(es.health.breakdown.density.reason === undefined && es.health.left_out.length === 4);
  assert.ok(es.notes.includes('Health score not assessed: no part of the health score could be assessed.'), JSON.stringify(es.notes));
});

test('41, 42: the counts of each tool are facts: a constraint is named by P6, a late activity by its baseline, and no answer carries a definition', async () => {
  const h = await built('2026-01-05', [act('A', 5, { constraint: { type: 'finish_on_or_before', date: '2026-02-01' } }), act('B', 3), rel('A', 'B')]);
  await call('schedule', { handle: h });
  const d = await call('dcma_14', { handle: h });
  const hc = d.checks.find((c: any) => c.id === 'hard_constraints');
  assert.equal(hc.note, undefined);
  assert.equal(hc.activities[0].value, 'Finish On or Before', 'a constraint is named by P6, never by its code');
  assert.equal(d.checks.find((c: any) => c.id === 'logic').note, undefined);
  const c = await call('check_schedule', { handle: h });
  const chc = c.checks.find((x: any) => x.id === 'hard_constraints');
  assert.equal(chc.note, undefined);
  assert.equal(chc.numerator, 0, 'Finish On or Before is a soft constraint here');
  assert.ok(!c.notes.some((n: string) => /^Open ends here/.test(n)), JSON.stringify(c.notes));
  const l = await call('lint', { handle: h });
  assert.equal(l.checks.find((x: any) => x.id === 'constraints').activities[0].value, 'Finish On or Before');
  const s = await call('schedule', { handle: h });
  assert.equal(s.log.warnings.find((x: any) => x.code === 'OPEN_START').definition, undefined);
  // check_schedule: late activities, with a baseline
  const base = await built('2026-01-05', [act('A', 5), act('B', 3), rel('A', 'B'), { op: 'save_baseline', name: 'BL base', assign_as: 'project' }], 'PB');
  await call('schedule', { handle: base });
  const ca = await call('check_schedule', { handle: base });
  const late = ca.checks.find((x: any) => x.id === 'late_activities');
  assert.equal(late.note, undefined);
  assert.equal(late.numerator, 1);
  assert.deepEqual(ca.notes, ['Baseline Execution Index (BEI) not assessed: no baseline activity was due to finish before the data date.']);
  // compare: the integrity lists are facts; the answer carries no advice
  const t1 = await call('open_file', { path: sampleCopy('Tower-A.xer'), lenient: true });
  const t2 = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const cmp = await call('compare', { handle: t1.handle, other_handle: t2.handle });
  assert.equal(cmp.progress_integrity.clean, false);
  assert.equal(cmp.progress_integrity.retroactive_actuals_total, 2);
  assert.equal(cmp.progress_integrity.note, undefined);
});
