// Days the clone reports follow the rule its edits take them by. MCP and CLI (calendarDays): working days of each
// activity's own calendar (lags: the relationship-lag calendar), so 5 d on a 10-h calendar reads back as 5 d in every
// result that shows days. The desktop app (no calendarDays): every day at the fixed hours per day, edits and lookups
// alike. An 8-h project reads the same either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { runTool } from '../core/query/tools.ts';
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { readXlsx } from '../core/excel/xlsx.ts';
import { compareSchedules } from '../core/diff.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { runReport, runSpec, parseSpec } from '../renderer/reports/engine.ts';
import { COLUMN_BY_ID, makeCtx } from '../renderer/model.ts';
import { rows, type Db } from '../core/db.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
const ten = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['07:00', '17:00']]]));
// A -> B (FS + 1 d) and D on a 10-hour calendar, C on the 8-hour default: A 5 d, B 5 d, D 2 d (float 9 d), C 5 d (float 6 d)
const OPS = [
  { op: 'add_calendar', name: 'Ten', work_week: ten },
  { op: 'add_activity', id: 'A', name: 'Ten A', calendar: 'Ten', duration_days: 5 },
  { op: 'add_activity', id: 'B', name: 'Ten B', calendar: 'Ten', duration_days: 5 },
  { op: 'add_relationship', pred: 'A', succ: 'B', lag_days: 1 },
  { op: 'add_activity', id: 'D', name: 'Ten D', calendar: 'Ten', duration_days: 2 },
  { op: 'add_activity', id: 'C', name: 'Eight C', duration_days: 5 },
];
const WANT = { A: [5, 5, 0], B: [5, 5, 0], D: [2, 2, 9], C: [5, 5, 6] } as Record<string, number[]>;

test('MCP: 5 d on a 10-h calendar reads back as 5 d in every result that shows days; the 8-h activity is unchanged', async () => {
  const h = (await call('new_project', { id: 'CD', start: '2026-03-02' })).handle;
  assert.equal((await call('edit', { handle: h, operations: OPS })).ok, true);
  assert.equal((await call('schedule', { handle: h })).finish, '2026-03-16 17:00');
  for (const [id, [o, r, tf]] of Object.entries(WANT)) {
    const g = await call('get_activity', { handle: h, activity_id: id });
    assert.deepEqual([g.orig_days, g.rem_days, g.total_float_days, g.free_float_days], [o, r, tf, tf], id);
  }
  const a = await call('get_activity', { handle: h, activity_id: 'A' });
  assert.deepEqual([a.successors[0].lag_days, a.successors[0].rel_free_float_days], [1, 0]);
  const found = (await call('find_activities', { handle: h })).activities;
  assert.deepEqual(Object.fromEntries(found.map((x: any) => [x.id, [x.orig_days, x.rem_days, x.total_float_days]])), WANT);
  assert.deepEqual((await call('critical_path', { handle: h })).activities.map((x: any) => [x.id, x.orig_days]), [['A', 5], ['B', 5]]);
  const tr = await call('trace_logic', { handle: h, activity_id: 'B' });
  assert.deepEqual([tr.activity.orig_days, tr.levels[0].activities[0].orig_days, tr.links[0].lag_days], [5, 5, 1]);
  assert.match((await call('project_summary', { handle: h })).days_are, /each activity's own calendar/);
  // reports: built-in and defined
  const sr = await call('run_report', { handle: h, report: 'Schedule Report' });
  assert.deepEqual(sr.rows.filter((x: any) => !x.group).map((x: any) => [x.cells[0], x.cells[2], x.cells[3], x.cells[7]]), [['A', '5', '5', '0'], ['D', '2', '2', '9'], ['C', '5', '5', '6'], ['B', '5', '5', '0']]);
  const ar = await call('run_report', { handle: h, definition: { subject: 'activities', columns: ['activity_id', 'orig_dur', 'rem_dur', 'total_float', 'free_float'] } });
  assert.deepEqual(ar.rows.filter((x: any) => !x.group).map((x: any) => x.cells), [['5', '5', '0', '0'], ['2', '2', '9', '9'], ['5', '5', '6', '6'], ['5', '5', '0', '0']]);
  const rr = await call('run_report', { handle: h, definition: { subject: 'relationships', columns: ['pred_code', 'succ_code', 'lag'] } });
  assert.deepEqual(rr.rows[0].cells, ['A', 'B', '1']);
  // spreadsheet: exported in the same days, and read back nothing changes
  const xlsx = join(mkdtempSync(join(tmpdir(), 'p6cd-')), 'cd.xlsx');
  await call('export_excel', { handle: h, path: xlsx });
  const sheets = await readXlsx(new Uint8Array(readFileSync(xlsx)));
  const T = sheets.find((s) => s.name === 'TASK')!.rows, P = sheets.find((s) => s.name === 'TASKPRED')!.rows;
  const col = (f: string) => T[0].indexOf(f);
  assert.deepEqual(T.slice(2).filter((r) => r[col('task_code')] === 'A').map((r) => [r[col('target_drtn_hr_cnt')], r[col('remain_drtn_hr_cnt')]]), [[5, 5]]);
  assert.equal(P[2][P[0].indexOf('lag_hr_cnt')], 1);
  assert.equal((await call('import_excel', { handle: h, path: xlsx, dry_run: true })).note, 'Nothing to change.');
  // compare: the edit of A from 5 to 6 days is 5 -> 6
  const other = (await call('new_project', { id: 'CD', start: '2026-03-02' })).handle;
  await call('edit', { handle: other, operations: [...OPS.slice(0, 1), { ...OPS[1], duration_days: 6 }, ...OPS.slice(2)] });
  const cmp = await call('compare', { handle: h, other_handle: other });
  assert.deepEqual(cmp.changes.filter((c: any) => c.field === 'original_duration' || c.field === 'remaining_duration' || c.field === 'lag').map((c: any) => [c.id, c.field, c.a, c.b]), [['A', 'original_duration', '5', '6'], ['A', 'remaining_duration', '5', '6']]);
});

/** The same project built by the core functions, edits with the given rule. */
function project(calendarDays: boolean): Db {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'CD', start: '2026-03-02' }, ...OPS], { calendarDays }).ok, true);
  assert.equal(scheduleProjects(db, [rows(db, 'PROJECT')[0].proj_id]).ok, true);
  return db;
}
const col = (id: string) => COLUMN_BY_ID.get(id)!;
const prefs = (calendarDays?: boolean) => ({ hoursPerDay: 8, dateFormat: 'dd-MMM-yy' as const, showTime: false, durationDecimals: 1, ...(calendarDays ? { calendarDays } : {}) });

test('the core functions with calendarDays (as MCP and the CLI call them): days of each activity\'s calendar in lookups, print columns, reports, spreadsheet, compare', () => {
  const db = project(true);
  const t = (c: string) => rows(db, 'TASK').find((r) => r.task_code === c)!;
  assert.deepEqual([t('A').target_drtn_hr_cnt, t('C').target_drtn_hr_cnt, rows(db, 'TASKPRED')[0].lag_hr_cnt], ['50', '40', '10']);
  const g = runTool('get_activity', { activity_id: 'A' }, db, makeCtx(db, prefs()), [], 8, true) as any;
  assert.deepEqual([g.orig_days, g.successors[0].lag_days], [5, 1]);
  // print / activity table columns with the calendarDays preference
  const ctx = makeCtx(db, prefs(true));
  assert.deepEqual(['orig_dur', 'rem_dur', 'total_float', 'free_float'].map((c) => ['A', 'D', 'C'].map((x) => col(c).get(t(x), ctx))), [['5', '2', '5'], ['5', '2', '5'], ['0', '9', '6'], ['0', '9', '6']]);
  const ids = [rows(db, 'PROJECT')[0].proj_id];
  assert.equal(runReport(db, ids, 'Critical Activities', { prefs: prefs(true) }).report.rows[0].cells[2], '5');
  assert.deepEqual(runSpec(db, ids, parseSpec({ name: 'w', subject: 'wbs', columns: ['wbs_code', 'total_float'] })!, { prefs: prefs(true) }).rows[0].cells, ['CD', '0']);
  const T = exportSheets(db, ids, 8, true).find((s) => s.name === 'TASK')!.rows;
  assert.deepEqual(T.slice(2).map((r) => r[6]), [5, 5, 2, 5]);
  assert.equal(planImport(db, exportSheets(db, ids, 8, true), 'CD', 8, true).ops.length, 0);
  const b = project(true);
  applyOps(b, [{ op: 'update_activity', id: 'A', duration_days: 6 }], { calendarDays: true });
  assert.deepEqual(compareSchedules(db, b, 8, true).filter((c) => c.field === 'original_duration').map((c) => [c.a, c.b]), [['5', '6']]);
});

test('the desktop app (no calendarDays): days at the fixed hours per day, edits and lookups alike; the 8-h activity reads the same as with calendarDays', () => {
  const db = project(false);
  const t = (c: string) => rows(db, 'TASK').find((r) => r.task_code === c)!;
  // 5 d on the 10-h calendar is 40 h here (the table then shows 5, not 6.3)
  assert.deepEqual([t('A').target_drtn_hr_cnt, t('C').target_drtn_hr_cnt, rows(db, 'TASKPRED')[0].lag_hr_cnt], ['40', '40', '8']);
  const g = runTool('get_activity', { activity_id: 'A' }, db, makeCtx(db, prefs()), [], 8) as any;
  assert.deepEqual([g.orig_days, g.rem_days, g.successors[0].lag_days], [5, 5, 1]);
  assert.equal((runTool('project_summary', {}, db, makeCtx(db, prefs()), [], 8) as any).days_are, 'hours_per_day_used_for_days hours each');
  const ctx = makeCtx(db, prefs());
  assert.deepEqual(['orig_dur', 'rem_dur'].map((c) => col(c).get(t('A'), ctx)), ['5', '5']);
  // a 50-h activity: 6.3 d in the table, in lookups and in reports, as before
  applyOps(db, [{ op: 'update_activity', id: 'A', duration_hours: 50 }]);
  assert.equal(col('orig_dur').get(t('A'), makeCtx(db, prefs())), '6.3');
  assert.equal((runTool('get_activity', { activity_id: 'A' }, db, makeCtx(db, prefs()), [], 8) as any).orig_days, 6.3);
  const ids = [rows(db, 'PROJECT')[0].proj_id];
  assert.equal(runReport(db, ids, 'Schedule Report', { prefs: prefs() }).report.rows.find((r) => r.cells[0] === 'A')!.cells[2], '6.3');
  // the 8-h activity: read the same under both rules
  const cal = project(true);
  const c8 = (d: Db, on: boolean) => { const x = rows(d, 'TASK').find((r) => r.task_code === 'C')!; return [x.target_drtn_hr_cnt, (runTool('get_activity', { activity_id: 'C' }, d, makeCtx(d, prefs()), [], 8, on) as any).total_float_days, col('total_float').get(x, makeCtx(d, prefs(on)))]; };
  assert.deepEqual(c8(cal, false), c8(cal, true));
  assert.deepEqual(c8(cal, true), ['40', 6, '6']);
});
