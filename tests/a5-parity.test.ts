// What the platform needs to move its schedule computation to the clone (ledger A5 round 3(a)): activity_table (G-1),
// compute_schedule (G-2), schedule options (G-3), one relationship per pair and type (G-4), duplicate assignments
// (G-5), break_loops and loops (G-9), and a big network built in seconds (G-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { rows, type Db } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
const dir = mkdtempSync(join(tmpdir(), 'p6a5-'));
const NET = [
  { id: 'S', type: 'start_milestone' }, { id: 'A', duration_days: 5, predecessors: [{ id: 'S' }] },
  { id: 'B', duration_days: 3, predecessors: [{ id: 'A', type: 'SS', lag_days: 2 }, { id: 'A', type: 'FF' }] },
  { id: 'C', duration_days: 2, predecessors: [{ id: 'B' }] }, { id: 'D', duration_days: 1, predecessors: [{ id: 'S' }] },
  { id: 'F', type: 'finish_milestone', predecessors: [{ id: 'C' }, { id: 'D' }] },
];
/** The same network through new_project + edit + schedule. */
async function handleFor(acts = NET, extra: unknown[] = []) {
  const h = (await call('new_project', { id: 'P', start: '2026-03-02' })).handle;
  const ops: unknown[] = acts.map(({ predecessors: _p, ...a }) => ({ op: 'add_activity', name: a.id, ...a }));
  for (const a of acts) for (const p of (a as any).predecessors ?? []) ops.push({ op: 'add_relationship', pred: p.id, succ: a.id, type: p.type, lag_days: p.lag_days });
  const e = await call('edit', { handle: h, operations: [...ops, ...extra] });
  assert.equal(e.ok, true, JSON.stringify(e));
  return h;
}
const col = (t: { columns: string[]; rows: unknown[][] }, c: string) => Object.fromEntries(t.rows.map((r) => [r[0], r[t.columns.indexOf(c)]]));

test('G-1 activity_table: every activity\'s computed fields, compact, paged by offset / limit with no cap', async () => {
  const h = await handleFor();
  assert.equal((await call('schedule', { handle: h })).ok, true);
  const all = await call('activity_table', { handle: h });
  assert.deepEqual(all.columns, ['id', 'status', 'type', 'start', 'finish', 'early_start', 'early_finish', 'late_start', 'late_finish', 'rem_late_start', 'rem_late_finish', 'orig_days', 'rem_days', 'total_float_days', 'free_float_days', 'critical', 'driving', 'start_wd', 'finish_wd']);
  assert.deepEqual([all.total, all.rows.length, all.next_offset], [6, 6, null]);
  // the same values get_activity gives
  for (const id of ['A', 'B', 'D']) {
    const g = await call('get_activity', { handle: h, activity_id: id });
    const r = all.rows.find((x: unknown[]) => x[0] === id);
    assert.deepEqual([r[5], r[6], r[7], r[8], r[13], r[14], r[15]], [g.early_start, g.early_finish, g.late_start, g.late_finish, g.total_float_days, g.free_float_days, g.critical], id);
  }
  assert.deepEqual(col(all, 'start_wd'), { S: 0, A: 0, B: 2, C: 5, D: 0, F: 7 });
  assert.deepEqual(col(all, 'total_float_days'), { S: 0, A: 0, B: 0, C: 0, D: 6, F: 0 });
  // pages
  const p1 = await call('activity_table', { handle: h, limit: 4 }), p2 = await call('activity_table', { handle: h, offset: p1.next_offset, limit: 4 });
  assert.deepEqual([p1.rows.length, p1.next_offset, p2.rows.length, p2.next_offset], [4, 4, 2, null]);
  assert.deepEqual([...p1.rows, ...p2.rows], all.rows);
  assert.equal((await call('activity_table', { handle: h, limit: 1_000_000 })).rows.length, 6);
  assert.deepEqual((await call('activity_table', { handle: h, names: true, limit: 1 })).rows[0].slice(0, 2), ['S', 'S']);
});

test('G-1 on a real file: activity_table rows follow the schedule of all its activities', async () => {
  const o = await call('open_file', { path: join(import.meta.dirname, 'fixtures', 'Polaris_DC1_Baseline_Schedule.xer'), lenient: true });
  await call('schedule', { handle: o.handle });
  const t = await call('activity_table', { handle: o.handle, limit: 50 });
  assert.equal(t.total, (await call('project_summary', { handle: o.handle })).activities);
  assert.equal(t.rows.length, 50);
  const g = await call('get_activity', { handle: o.handle, activity_id: t.rows[10][0] });
  assert.deepEqual([t.rows[10][5], t.rows[10][13]], [g.early_start, g.total_float_days]);
});

test('G-2 compute_schedule: no handle; the same rows as a project built and scheduled with the same network; loops broken and listed', async () => {
  const r = await call('compute_schedule', { start: '2026-03-02', activities: NET });
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = await handleFor();
  await call('schedule', { handle: h });
  assert.deepEqual(r.rows, (await call('activity_table', { handle: h })).rows);
  assert.deepEqual([r.finish, r.loops, r.broken_links], ['2026-03-10 17:00', [], []]);
  // calendars, constraints, must finish by, progress and options
  const c = await call('compute_schedule', {
    start: '2026-03-02', data_date: '2026-03-04', must_finish_by: '2026-03-27', calendars: [{ name: 'Six', work_week: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['08:00', '16:00']]])) }],
    activities: [{ id: 'A', duration_days: 6, calendar: 'Six', actual_start: '2026-03-02 08:00', remaining_days: 4 }, { id: 'B', duration_days: 2, constraint: { type: 'start_on_or_after', date: '2026-03-16' }, predecessors: [{ id: 'A', lag_hours: 24 }] }],
    options: { lag_calendar: '24h' },
  });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.rows.map((x: unknown[]) => [x[0], x[1], x[3], x[4]]), [['A', 'IP', '2026-03-02 08:00', '2026-03-07 16:00'], ['B', 'NS', '2026-03-16 08:00', '2026-03-17 17:00']]);
  assert.equal(col(c, 'total_float_days').B, 7); // to must finish by 2026-03-27 00:00: late finish 03-26 17:00
  // a loop: the link that closes it is left out and named
  const l = await call('compute_schedule', { start: '2026-03-02', activities: [{ id: 'A', duration_days: 1, predecessors: [{ id: 'C' }] }, { id: 'B', duration_days: 1, predecessors: [{ id: 'A' }] }, { id: 'C', duration_days: 1, predecessors: [{ id: 'B' }] }] });
  assert.deepEqual([l.ok, l.loops.map((x: string[]) => [...x].sort()), l.broken_links], [true, [['A', 'B', 'C']], [{ pred: 'C', succ: 'A', type: 'FS' }]]);
  const nl = await call('compute_schedule', { start: '2026-03-02', break_loops: false, activities: [{ id: 'A', duration_days: 1, predecessors: [{ id: 'B' }] }, { id: 'B', duration_days: 1, predecessors: [{ id: 'A' }] }] });
  assert.deepEqual([nl.ok, nl.error.code, nl.error.loops.map((x: string[]) => [...x].sort())], [false, 'schedule_failed', [['A', 'B']]]);
  // bad input says where
  const bad = await call('compute_schedule', { start: '2026-03-02', activities: [{ id: 'A', duration_days: 1, predecessors: [{ id: 'Z' }] }] });
  assert.deepEqual([bad.ok, bad.error.code, bad.error.where], [false, 'bad_input', 'activities[0].predecessors[0]']);
  assert.equal((await call('compute_schedule', { start: '2026-03-02', activities: [{ id: 'A' }], options: { logic: 'sometimes' } })).error.where, 'options');
});

test('G-3 set_schedule_options writes P6\'s Schedule Options; schedule options override one run; new_project must_finish_by', async () => {
  const db: Db = { tables: {} };
  const r = applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'set_schedule_options', logic: 'override', lag_calendar: '24h', float_type: 'smallest', critical: 'longest_path', critical_float_days: 2, open_ended_critical: true, use_expected_finish: false, ignore_external: true, ss_lag_from_actual_start: true }]);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const so = rows(db, 'SCHEDOPTIONS')[0], p = rows(db, 'PROJECT')[0];
  assert.deepEqual([so.sched_progress_override, so.sched_retained_logic, so.sched_calendar_on_relationship_lag, so.sched_float_type, so.sched_open_critical_flag, so.sched_use_expect_end_flag, so.sched_outer_depend_type, so.sched_lag_early_start_flag, p.critical_path_type, p.critical_drtn_hr_cnt],
    ['Y', 'N', 'rcal_24Hour', 'FT_Min', 'Y', 'N', 'SD_None', 'N', 'CT_DrivPath', '16']);
  // kept through XER
  const back = parseXer(writeXer(db, { version: '19.12' })).db;
  assert.deepEqual([rows(back, 'SCHEDOPTIONS')[0].sched_calendar_on_relationship_lag, rows(back, 'PROJECT')[0].critical_path_type], ['rcal_24Hour', 'CT_DrivPath']);
  assert.match(applyOps(db, [{ op: 'set_schedule_options', logic: 'sometimes' }]).error!.message, /logic must be one of retained/);
  assert.match(applyOps(db, [{ op: 'set_schedule_options', colour: 'red' }]).error!.message, /Unknown schedule option "colour"/);
  assert.match(applyOps(db, [{ op: 'set_schedule_options' }]).error!.message, /at least one schedule option/);
  // MCP: one run with other options leaves the project's as they were
  const h = (await call('new_project', { id: 'Q', start: '2026-03-02', must_finish_by: '2026-03-31' })).handle;
  await call('edit', { handle: h, operations: [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 1 }, { op: 'add_relationship', pred: 'A', succ: 'B', lag_hours: 24 }] });
  const startB = async (args: Record<string, unknown> = {}) => { await call('schedule', { handle: h, ...args }); return (await call('get_activity', { handle: h, activity_id: 'B' })).start; };
  assert.equal(await startB(), '2026-03-12 08:00'); // 24 working hours on the predecessor's calendar
  assert.equal(await startB({ options: { lag_calendar: '24h' } }), '2026-03-09 08:00');
  assert.equal(await startB(), '2026-03-12 08:00', 'the override was for that run only');
  assert.equal((await call('schedule', { handle: h, options: { lag_calendar: 'moon' } })).error.code, 'bad_input');
  await call('edit', { handle: h, operations: [{ op: 'set_schedule_options', lag_calendar: '24h' }] });
  assert.equal(await startB(), '2026-03-09 08:00');
  // must_finish_by: late dates measured to it
  assert.equal((await call('get_activity', { handle: h, activity_id: 'B' })).late_finish, '2026-03-30 17:00');
});

test('G-4 one relationship per pair and type for XER / P6 (SS + FF pairs kept through save); one per pair for Microsoft Project; a true duplicate is skipped with a warning', async () => {
  const h = await handleFor(NET.slice(0, 3));
  const dup = await call('edit', { handle: h, operations: [{ op: 'add_relationship', pred: 'A', succ: 'B', type: 'SS' }] });
  assert.deepEqual([dup.results[0].skipped, dup.warnings.length], ['A SS B', 1]);
  assert.match(dup.warnings[0], /already exists/);
  assert.deepEqual((await call('get_activity', { handle: h, activity_id: 'B' })).predecessors.map((p: any) => p.type).sort(), ['FF', 'SS']);
  // saved and opened again: both kept
  const path = join(dir, 'pairs.xer');
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A' }, { op: 'add_activity', id: 'B', name: 'B' }, { op: 'add_relationship', pred: 'A', succ: 'B', type: 'SS', lag_days: 2 }, { op: 'add_relationship', pred: 'A', succ: 'B', type: 'FF' }]).ok, true);
  writeFileSync(path, writeXer(db, { version: '19.12' }));
  const re = await call('open_file', { path });
  assert.deepEqual((await call('get_activity', { handle: re.handle, activity_id: 'B' })).predecessors.map((p: any) => `${p.type} ${p.lag_days}`).sort(), ['FF 0', 'SS 2']);
  // Microsoft Project XML: one per pair
  const m = await call('open_file', { path: join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml') });
  const preds = (await call('get_activity', { handle: m.handle, activity_id: 'uid:162' })).predecessors;
  const one = preds.find((p: any) => p.id !== '(outside the open projects)');
  const r = await call('edit', { handle: m.handle, operations: [{ op: 'add_relationship', pred: one.id, succ: 'uid:162', type: one.type === 'SS' ? 'FF' : 'SS' }] });
  assert.equal(r.ok, true);
  assert.match(r.warnings[0], /Microsoft Project keeps one per pair/);
});

test('G-5 assign_resource allow_duplicate: the same resource twice on an activity', () => {
  const db: Db = { tables: {} };
  const base = [{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_resource', id: 'CREW' }, { op: 'assign_resource', activity: 'A', resource: 'CREW', units: 10 }];
  assert.equal(applyOps(db, base).ok, true);
  assert.match(applyOps(db, [{ op: 'assign_resource', activity: 'A', resource: 'CREW', units: 5 }]).error!.message, /already assigned to A \(allow_duplicate: true adds a second assignment\)/);
  const r = applyOps(db, [{ op: 'assign_resource', activity: 'A', resource: 'CREW', units: 5, allow_duplicate: true }]);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(rows(db, 'TASKRSRC').map((a) => Number(a.target_qty)), [10, 5]);
});

test('G-9 schedule: loops listed either way; break_loops leaves out the links that close them (they stay in the project)', async () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'L', start: '2026-03-02' }, ...['A', 'B', 'C', 'D'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 2 })), { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'C' }, { op: 'add_relationship', pred: 'C', succ: 'D' }]).ok, true);
  const T = rows(db, 'TASK'), id = (c: string) => T.find((t) => t.task_code === c)!.task_id;
  // a loop C -> A, as files from other tools carry (the edit itself refuses one)
  assert.match(applyOps(structuredClone(db), [{ op: 'add_relationship', pred: 'C', succ: 'A' }]).error!.message, /would create a loop/);
  db.tables.TASKPRED.rows.push({ ...db.tables.TASKPRED.rows[0], task_pred_id: '99', pred_task_id: id('C'), task_id: id('A') });
  const path = join(dir, 'loop.xer');
  writeFileSync(path, writeXer(db, { version: '19.12' }));
  const o = await call('open_file', { path, lenient: true });
  const no = await call('schedule', { handle: o.handle });
  assert.deepEqual([no.ok, no.loops.map((x: string[]) => [...x].sort()), no.error.code], [false, [['A', 'B', 'C']], 'schedule_failed']);
  assert.match(no.error.hint, /break_loops/);
  const yes = await call('schedule', { handle: o.handle, break_loops: true });
  assert.deepEqual([yes.ok, yes.loops.map((x: string[]) => [...x].sort()), yes.broken_links], [true, [['A', 'B', 'C']], [{ pred: 'C', succ: 'A', type: 'FS' }]]);
  assert.equal((await call('get_activity', { handle: o.handle, activity_id: 'A' })).predecessors.length, 1, 'the link stays in the project');
  assert.deepEqual((await call('schedule', { handle: (await call('new_project', { id: 'N', start: '2026-03-02' })).handle })).loops, []);
});

test('G-13 a JWM-sized build (3,560 WBS, 11,426 activities, 32,407 relationships with SS+FF pairs, 3,393 assignments) applies in one edit in seconds; a loop names the first link that closed it', () => {
  const src = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'Copy of JWM - Baseline Programme Rev 05A.xer')))).db;
  const t = (n: string) => src.tables[n]?.rows ?? [];
  const byW = new Map(t('PROJWBS').map((w) => [w.wbs_id, w]));
  const path = (id: string): string => { const w = byW.get(id); if (!w || w.proj_node_flag === 'Y') return ''; const p = path(w.parent_wbs_id); return p ? `${p}.${w.wbs_short_name}` : w.wbs_short_name; };
  const depth = (id: string): number => { const w = byW.get(id); return !w || w.proj_node_flag === 'Y' ? 0 : 1 + depth(w.parent_wbs_id); };
  const ops: Record<string, unknown>[] = [{ op: 'add_project', id: 'JWM', start: '2020-01-01' }];
  for (const w of t('PROJWBS').filter((x) => x.proj_node_flag !== 'Y').sort((a, b) => depth(a.wbs_id) - depth(b.wbs_id))) { const pp = path(w.parent_wbs_id); ops.push({ op: 'add_wbs', code: w.wbs_short_name, name: w.wbs_name || w.wbs_short_name, ...(pp ? { parent: pp } : {}) }); }
  const code = new Map(t('TASK').map((x) => [x.task_id, x.task_code]));
  for (const x of t('TASK')) { const wp = path(x.wbs_id); ops.push({ op: 'add_activity', id: x.task_code, name: x.task_name || x.task_code, ...(wp ? { wbs: wp } : {}), duration_hours: Number(x.target_drtn_hr_cnt) || 0 }); }
  for (const r of t('TASKPRED')) if (code.has(r.pred_task_id) && code.has(r.task_id)) ops.push({ op: 'add_relationship', pred: code.get(r.pred_task_id), succ: code.get(r.task_id), type: (r.pred_type || 'PR_FS').slice(3), lag_hours: Number(r.lag_hr_cnt) || 0 });
  const rs = new Map(t('RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name])), seen = new Set<string>();
  for (const n of new Set(rs.values())) ops.push({ op: 'add_resource', id: n });
  for (const a of t('TASKRSRC')) if (code.has(a.task_id) && rs.has(a.rsrc_id)) { const k = `${a.task_id}|${a.rsrc_id}`; ops.push({ op: 'assign_resource', activity: code.get(a.task_id), resource: rs.get(a.rsrc_id), units: Number(a.target_qty) || 0, ...(seen.has(k) ? { allow_duplicate: true } : {}) }); seen.add(k); }
  const db: Db = { tables: {} };
  const t0 = performance.now();
  const r = applyOps(db, ops, { calendarDays: true });
  const ms = performance.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(ms < 15_000, `${Math.round(ms)} ms`);
  assert.equal(rows(db, 'TASKPRED').length, t('TASKPRED').length, 'every relationship of the file, SS + FF pairs included');
  // two loops closed in one edit: the error names the first operation that closed one
  const [a, b, c] = ['A1', 'A2', 'A3'];
  const small: Db = { tables: {} };
  const e = applyOps(small, [{ op: 'add_project', id: 'S', start: '2026-03-02' }, ...[a, b, c].map((id) => ({ op: 'add_activity', id, name: id })),
    { op: 'add_relationship', pred: a, succ: b }, { op: 'add_relationship', pred: b, succ: c }, { op: 'add_relationship', pred: b, succ: a }, { op: 'add_relationship', pred: c, succ: a }]);
  assert.deepEqual([e.ok, e.error!.index, e.error!.message], [false, 6, 'This relationship would create a loop (circular logic).']);
  assert.equal(small.tables.TASKPRED?.rows.length ?? 0, 0, 'nothing applied');
});
