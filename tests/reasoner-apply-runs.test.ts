// The schedule reasoner's apply (optimize_schedule apply, and the Optimise screen's Apply through writeWhiqFields) follows the owner's run rule of
// 2026-11-11, the one the platform applies to its stored schedules: the run's numbers become the current ones, the numbers they replace move into
// WHIQ original duration (d) (the first change of an activity) or WHIQ run <K-1> duration (d); and the reasoner is refused on a schedule in progress.
// crash_schedule's apply follows the same rule (one rule for every apply that writes these fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { saveBaseline } from '../core/progress/baseline.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { reasonerRefusal, runNumbers, whiqFieldClash, writeWhiqFields } from '../core/analysis/whiq-fields.ts';
import { reasonerModelPath } from '../core/analysis/hrmRuntime.ts';

const ORIGINAL = 'WHIQ original duration (d)', CHANGE = 'WHIQ duration change (d)', NOTE = 'WHIQ change note', RANK = 'WHIQ leveling rank';
const runField = (n: number) => `WHIQ run ${n} duration (d)`;
const good = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops as never, { calendarDays: true }); assert.ok(r.ok, JSON.stringify(r.ok ? '' : r.error)); };

/** A project `id` with activities A..E of 10, 8, 6, 5, 4 days, scheduled. */
function plan(id = 'R', codes = ['A', 'B', 'C', 'D', 'E'], db: Db = { tables: {} }, start = '2026-06-01') {
  good(db, [{ op: 'add_project', id, start }, ...codes.map((c, i) => ({ op: 'add_activity', project: id, id: c, name: c, duration_days: [10, 8, 6, 5, 4][i] }))]);
  assert.ok(scheduleProjects(db, [rows(db, 'PROJECT').find((p) => p.proj_short_name === id)!.proj_id]).ok);
  return db;
}
const projId = (db: Db, id: string) => rows(db, 'PROJECT').find((p) => p.proj_short_name === id)!.proj_id;
const taskOf = (db: Db, project: string, code: string) => rows(db, 'TASK').find((t) => t.task_code === code && t.proj_id === projId(db, project))!;
const daysOf = (db: Db, project: string, code: string) => Number(taskOf(db, project, code).remain_drtn_hr_cnt) / 8;
/** What the tool's apply does for a run: the new durations are written (the proposal's ops), then writeWhiqFields (the same call the screen's Apply makes). */
function apply(db: Db, changes: Record<string, number>, o: { project?: string; ranks?: string[]; crash?: boolean } = {}) {
  const project = o.project ?? 'R', pid = projId(db, project);
  const list = Object.entries(changes).map(([id, to]) => ({ task_id: taskOf(db, project, id).task_id, id, project, from_days: daysOf(db, project, id), to_days: to, cost: 5 }));
  good(db, list.map((c) => ({ op: 'update_activity', project, id: c.id, duration_days: c.to_days })));
  const ranks = (o.ranks ?? []).map((id, k) => ({ task_id: taskOf(db, project, id).task_id, id, project, rank: k + 1 }));
  // crash_schedule gives no ranks (no `ranks` at all); the reasoner always does (an empty list when it ranked none)
  return writeWhiqFields(db, o.crash ? { changes: list, who: 'Crashed (least cost)' } : { changes: list, ranks, who: 'Crashed by the schedule reasoner' }, { calendarDays: true, projIds: [pid] });
}
const labels = (db: Db) => rows(db, 'UDFTYPE').map((u) => u.udf_type_label).filter((l) => l.startsWith('WHIQ')).sort();
/** value of a field on an activity ('' none) */
const val = (db: Db, code: string, label: string, project = 'R') => {
  const u = rows(db, 'UDFTYPE').find((x) => x.udf_type_label === label); if (!u) return undefined;
  const v = rows(db, 'UDFVALUE').find((x) => x.udf_type_id === u.udf_type_id && x.fk_id === taskOf(db, project, code).task_id);
  return v ? v.udf_number || v.udf_text : undefined;
};

test('first apply: the four fields, no numbered field, an original only on each changed activity, the change measured from it', () => {
  const db = plan();
  apply(db, { A: 6, C: 3 }, { ranks: ['A', 'B', 'C'] });
  assert.deepEqual(labels(db), [NOTE, CHANGE, RANK, ORIGINAL].sort());
  assert.deepEqual(['A', 'B', 'C', 'D'].map((c) => val(db, c, ORIGINAL)), ['10', undefined, '6', undefined]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((c) => val(db, c, CHANGE)), ['-4', undefined, '-3', undefined]);
  assert.match(val(db, 'A', NOTE)!, /^Crashed by the schedule reasoner \d{4}-\d{2}-\d{2}: 10 d to 6 d, cost 5$/);
  assert.deepEqual(['A', 'B', 'C'].map((c) => val(db, c, RANK)), ['1', '2', '3']);
});

test('second apply is run 2: it declares WHIQ run 1 duration (d), holding the number it replaced on exactly the activities it changed that already had an original; a new one gets an original and no run-1 cell', () => {
  const db = plan();
  apply(db, { A: 6, B: 7 });
  const w = apply(db, { A: 3, C: 4 }); // A had an original (10, now 6), C is first changed (6)
  assert.ok(labels(db).includes(runField(1)));
  assert.deepEqual(['A', 'B', 'C'].map((c) => val(db, c, runField(1))), ['6', undefined, undefined], 'only A: B was not changed by run 2 (empty cell), C is changed for the first time');
  assert.deepEqual(['A', 'B', 'C'].map((c) => val(db, c, ORIGINAL)), ['10', '8', '6'], 'the original never changes once set; C gets its original now');
  assert.deepEqual(['A', 'B', 'C'].map((c) => val(db, c, CHANGE)), ['-7', '-1', '-2'], 'B is not touched by run 2 and keeps its change');
  assert.match(val(db, 'A', NOTE)!, /: 6 d to 3 d, cost 5 \(original 10 d\)$/);
  assert.match(val(db, 'B', NOTE)!, /: 8 d to 7 d, cost 5$/, 'an activity the latest run does not change keeps its note');
  assert.equal(daysOf(db, 'R', 'B'), 7, 'and its duration');
  assert.deepEqual(w.find((f) => f.name === runField(1)), { name: runField(1), activities: 1, kept_from_earlier: 0 });
});

test('changed in run 1, untouched in run 2, changed in run 3: the run-1 cell is empty, the run-2 cell holds the number run 1 gave; earlier numbered fields are never touched', () => {
  const db = plan();
  apply(db, { A: 8, B: 6 });      // run 1
  apply(db, { B: 5 });            // run 2: A untouched
  assert.equal(val(db, 'A', runField(1)), undefined);
  assert.equal(val(db, 'B', runField(1)), '6');
  apply(db, { A: 7, B: 4 });      // run 3: declares WHIQ run 2 duration (d)
  assert.deepEqual(['A', 'B'].map((c) => val(db, c, runField(1))), [undefined, '6'], 'the run-1 column is as run 2 left it');
  assert.deepEqual(['A', 'B'].map((c) => val(db, c, runField(2))), ['8', '5']);
  assert.deepEqual(['A', 'B'].map((c) => val(db, c, ORIGINAL)), ['10', '8']);
  assert.deepEqual(['A', 'B'].map((c) => val(db, c, CHANGE)), ['-3', '-4']);
  assert.deepEqual(labels(db).filter((l) => /run/.test(l)), [runField(1), runField(2)]);
});

test('a run that changes only never-touched activities still declares its (empty) field, and the next apply numbers correctly', () => {
  const db = plan();
  apply(db, { A: 8 });                       // run 1
  const w = apply(db, { C: 3 });             // run 2: C never touched: original only
  assert.ok(labels(db).includes(runField(1)), 'declared though no cell is filled');
  assert.deepEqual(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === rows(db, 'UDFTYPE').find((u) => u.udf_type_label === runField(1))!.udf_type_id), []);
  assert.deepEqual(w.find((f) => f.name === runField(1)), { name: runField(1), activities: 0, kept_from_earlier: 0 });
  apply(db, { A: 6 });                       // run 3
  assert.ok(labels(db).includes(runField(2)) && !labels(db).includes(runField(3)));
  assert.equal(val(db, 'A', runField(2)), '8');
  assert.equal(val(db, 'A', runField(1)), undefined);
});

test('the change is current minus original on every activity that has an original, including one whose duration was edited by hand between runs', () => {
  const db = plan();
  apply(db, { A: 8, B: 6 });
  good(db, [{ op: 'update_activity', id: 'A', duration_days: 9 }]); // by hand
  apply(db, { B: 5 });
  assert.equal(val(db, 'A', CHANGE), '-1', '9 - 10, A not changed by run 2');
  assert.equal(val(db, 'B', CHANGE), '-3');
});

test('a project with the four fields from the earlier behaviour is a project with an original: its next apply is run 2', () => {
  const db = plan();
  good(db, [{ op: 'add_udf', name: ORIGINAL, data_type: 'number' }, { op: 'add_udf', name: CHANGE, data_type: 'number' }, { op: 'add_udf', name: NOTE, data_type: 'text' }, { op: 'add_udf', name: RANK, data_type: 'integer' },
    { op: 'set_udf', activity: 'A', udf: ORIGINAL, value: 10 }, { op: 'set_udf', activity: 'A', udf: CHANGE, value: -4 }, { op: 'set_udf', activity: 'A', udf: NOTE, value: 'old' }, { op: 'set_udf', activity: 'A', udf: RANK, value: 1 },
    { op: 'update_activity', id: 'A', duration_days: 6 }]);
  assert.deepEqual([...runNumbers(db, [projId(db, 'R')]).values()], [2]);
  apply(db, { A: 3 }, { ranks: ['B'] });
  assert.equal(val(db, 'A', runField(1)), '6');
  assert.equal(val(db, 'A', ORIGINAL), '10');
  assert.equal(val(db, 'A', RANK), undefined, 'a rank the latest run does not give is removed');
  assert.equal(val(db, 'B', RANK), '1');
});

test('several projects in one file: the run number is decided per project from what the file declares; a number is never repeated for a project', () => {
  const db = plan('W'); plan('X', ['A', 'B', 'C', 'D', 'E'], db);
  const [w, x] = [projId(db, 'W'), projId(db, 'X')];
  assert.deepEqual([...runNumbers(db, [w, x]).values()], [1, 1], 'nothing declared: both are in their first run');
  apply(db, { A: 8 }, { project: 'W' });     // W run 1
  apply(db, { A: 6 }, { project: 'W' });     // W run 2: declares run 1
  assert.deepEqual([...runNumbers(db, [w, x]).values()], [3, 1], 'W is at run 3; X has no original of its own, so its first run is 1 (no numbered field for it)');
  const before = labels(db).filter((l) => /run/.test(l));
  apply(db, { B: 7 }, { project: 'X' });
  assert.deepEqual(labels(db).filter((l) => /run/.test(l)), before, 'X’s first apply declared no numbered field');
  assert.equal(val(db, 'B', ORIGINAL, 'X'), '8');
  assert.deepEqual([...runNumbers(db, [w, x]).values()], [3, 3]);
  apply(db, { B: 6 }, { project: 'X' });     // X run 3 (it skipped no number of its own: its runs are 1, then 3)
  assert.ok(labels(db).includes(runField(2)));
  assert.equal(val(db, 'B', runField(2), 'X'), '7');
  assert.deepEqual([...runNumbers(db, [w])].map(([, k]) => k), [4], 'W’s next run is above everything declared');
});

// ---- one rule for every apply: crash_schedule's apply is a run in the numbering ----
const cell = (db: Db, code: string, label: string, project = 'R') => val(db, code, label, project);

test('reasoner, crash, reasoner: original 10, run 1 = 8 (what the crash replaced), run 2 = 6 (what the last reasoner run replaced), current 4; the crash is run 2 and declares its column', () => {
  const db = plan();
  apply(db, { A: 8 });                      // run 1 (reasoner): replaces 10 -> original
  apply(db, { A: 6 }, { crash: true });     // run 2 (crash): replaces 8 -> run 1 column
  assert.equal(cell(db, 'A', runField(1)), '8');
  assert.ok(labels(db).includes(runField(1)) && !labels(db).includes(runField(2)));
  apply(db, { A: 4 });                      // run 3 (reasoner): replaces 6 -> run 2 column
  assert.deepEqual([ORIGINAL, runField(1), runField(2), CHANGE].map((l) => cell(db, 'A', l)), ['10', '8', '6', '-6']);
  assert.equal(daysOf(db, 'R', 'A'), 4);
  assert.match(cell(db, 'A', NOTE)!, /: 6 d to 4 d, cost 5 \(original 10 d\)$/);
});

test('crash first, then the reasoner: the crash is run 1 (original 10, no numbered field), the reasoner is run 2 and puts the 8 the crash gave into run 1', () => {
  const db = plan();
  const w = apply(db, { A: 8 }, { crash: true });
  assert.deepEqual(labels(db), [NOTE, CHANGE, ORIGINAL].sort(), 'a first apply declares no numbered field, and a crash gives no rank');
  assert.deepEqual(w.map((f) => f.name), [ORIGINAL, CHANGE, NOTE]);
  apply(db, { A: 6, B: 7 });                // run 2
  assert.deepEqual([ORIGINAL, runField(1), CHANGE].map((l) => cell(db, 'A', l)), ['10', '8', '-4']);
  assert.deepEqual([ORIGINAL, runField(1), CHANGE].map((l) => cell(db, 'B', l)), ['8', undefined, '-1'], 'B is changed for the first time in run 2: an original and no run-1 cell');
});

test('the reviewer’s p3 sequence: a crash between two reasoner runs, and a crash first (the old rule lost the 8 and numbered the reasoner as run 2 with an empty run 1)', () => {
  const r = plan('R'), q = plan('Q');
  apply(r, { A: 8 }); apply(r, { A: 6 }, { crash: true }); apply(r, { A: 4 });
  assert.deepEqual([ORIGINAL, runField(1), runField(2)].map((l) => cell(r, 'A', l)), ['10', '8', '6']);
  apply(q, { A: 8 }, { project: 'Q', crash: true }); apply(q, { B: 6 }, { project: 'Q' });
  assert.deepEqual([ORIGINAL, runField(1)].map((l) => cell(q, 'A', l, 'Q')), ['10', undefined], 'A: changed by run 1 only');
  assert.deepEqual([ORIGINAL, runField(1)].map((l) => cell(q, 'B', l, 'Q')), ['8', undefined], 'B: changed first by run 2: its original');
  assert.ok(labels(q).includes(runField(1)), 'run 2 declares the run-1 column');
});

test('crash gives no ranks: the ranks a reasoner run left stay; the reasoner removes the ranks it does not give', () => {
  const db = plan();
  apply(db, { A: 8 }, { ranks: ['A', 'B', 'C'] });
  const w = apply(db, { A: 6 }, { crash: true });
  assert.deepEqual(['A', 'B', 'C'].map((c) => cell(db, c, RANK)), ['1', '2', '3']);
  assert.equal(w.find((f) => f.name === RANK), undefined, 'no rank field written');
  apply(db, { A: 4 }, { ranks: ['C'] });
  assert.deepEqual(['A', 'B', 'C'].map((c) => cell(db, c, RANK)), [undefined, undefined, '1']);
});

test('crash on a schedule in progress: for an activity under way the number it replaces is its remaining duration; the move into the run column is the same; progress is no edit', () => {
  const db = plan();
  good(db, [{ op: 'update_activity', id: 'A', actual_start: '2026-06-01' }, { op: 'update_activity', id: 'B', actual_start: '2026-06-01' }]);
  const rem = (c: string, h: number) => { taskOf(db, 'R', c).remain_drtn_hr_cnt = String(h); }; // progress: the remaining duration of A and B shrinks
  rem('A', 40); rem('B', 24);
  assert.equal(daysOf(db, 'R', 'A'), 5);
  // run 1: A is under way, its remaining 5 d is crashed to 3 d (the ops of crash_schedule write remaining_hours for a started activity)
  const list = (c: string, from: number, to: number) => ({ task_id: taskOf(db, 'R', c).task_id, id: c, project: 'R', from_days: from, to_days: to, cost: 5 });
  const write = (changes: ReturnType<typeof list>[]) => { for (const c of changes) taskOf(db, 'R', c.id).remain_drtn_hr_cnt = String(c.to_days * 8); return writeWhiqFields(db, { changes, who: 'Crashed (least cost)' }, { calendarDays: true, projIds: [projId(db, 'R')] }); };
  write([list('A', 5, 3), list('B', 3, 3 - 1)]);
  assert.deepEqual([ORIGINAL, CHANGE].map((l) => cell(db, 'A', l)), ['5', '-2'], 'the original is the remaining duration it had');
  assert.match(cell(db, 'A', NOTE)!, /: 5 d to 3 d, cost 5$/);
  // B keeps its values while progress moves its remaining duration; a later crash of A moves A's 3 into run 1 and leaves B's change as written
  rem('B', 8);
  write([list('A', 3, 2)]);
  assert.deepEqual([ORIGINAL, runField(1), CHANGE].map((l) => cell(db, 'A', l)), ['5', '3', '-3']);
  assert.deepEqual([ORIGINAL, CHANGE].map((l) => cell(db, 'B', l)), ['3', '-1'], 'B was not changed by run 2 and its remaining duration moved by progress: its change is not recomputed');
  assert.equal(cell(db, 'B', runField(1)), undefined);
});

test('several projects in one file (the reviewer’s p3 sequence): the run number is the file’s, a project’s run can skip numbers; no value is lost and no column holds two runs’ values of one activity', () => {
  const db = plan('X'); plan('Y', ['A', 'B', 'C', 'D', 'E'], db);
  const seen: Record<string, Set<string>> = { X: new Set(['10']), Y: new Set(['10']) };   // every duration activity A of each project ever had
  const step = (project: string, to: number) => { apply(db, { A: to }, { project }); seen[project].add(String(to)); };
  step('X', 9); step('X', 8); step('Y', 7); step('Y', 6); step('X', 5);
  const col = (project: string) => Object.fromEntries([ORIGINAL, runField(1), runField(2), runField(3)].map((l) => [l, cell(db, 'A', l, project)]));
  assert.deepEqual(col('X'), { [ORIGINAL]: '10', [runField(1)]: '9', [runField(2)]: undefined, [runField(3)]: '8' }, 'X ran as runs 1, 2, 4 of the file’s numbering: it holds 9 (before run 2) and 8 (before run 4)');
  assert.deepEqual(col('Y'), { [ORIGINAL]: '10', [runField(1)]: undefined, [runField(2)]: '7', [runField(3)]: undefined }, 'Y ran as runs 1 and 3: it holds 7 (before run 3)');
  // nothing lost: every number an activity ever had, except its current one, is in exactly one cell of its own; the current one is its duration
  for (const project of ['X', 'Y']) {
    const held = Object.values(col(project)).filter((v) => v != null) as string[];
    assert.equal(new Set(held).size, held.length, `${project}: no number held twice`);
    assert.deepEqual([...new Set(held)].sort(), [...seen[project]].filter((v) => v !== String(daysOf(db, project, 'A'))).sort(), `${project}: every earlier number is held`);
  }
  assert.deepEqual([daysOf(db, 'X', 'A'), daysOf(db, 'Y', 'A')], [5, 6]);
});

test('a project with baselines is ONE project: its numbering is the single-schedule rule, whether the baseline is tagged (_baseline_of) or only has orig_proj_id as an XER read without markBaselines; baselines get no field and never count as progress', () => {
  for (const tagged of [true, false]) {
    const db = plan();
    const bid = saveBaseline(db, projId(db, 'R'), 'BL');
    const b = rows(db, 'PROJECT').find((p) => p.proj_id === bid)!;
    if (!tagged) { b.orig_proj_id = projId(db, 'R'); b._baseline_of = ''; }
    // the four fields declared (as a file from the platform's apply carries them), no activity of R holding a value
    good(db, [{ op: 'add_udf', name: ORIGINAL, data_type: 'number' }]);
    assert.deepEqual([...runNumbers(db, [projId(db, 'R')]).values()], [2], `${tagged ? 'tagged' : 'untagged'} baseline: the platform's rule (the original is declared: run 2)`);
    // the baseline's activities are in progress: not the run's concern
    for (const t of rows(db, 'TASK').filter((t) => t.proj_id === bid)) t.act_start_date = '2026-06-01 08:00';
    assert.equal(reasonerRefusal(db, [projId(db, 'R'), bid]), undefined);
    assert.equal(reasonerRefusal(db, [projId(db, 'R')]), undefined);
    apply(db, { A: 8 });
    assert.equal(cell(db, 'A', ORIGINAL), '10', 'A had no original yet: the number it replaced is its original');
    assert.ok(labels(db).includes(runField(1)), 'it is run 2: it declares the run-1 column');
    const blIds = new Set(rows(db, 'TASK').filter((t) => t.proj_id === bid).map((t) => t.task_id));
    const orig = rows(db, 'UDFTYPE').filter((u) => /^WHIQ/.test(u.udf_type_label)).map((u) => u.udf_type_id);
    assert.equal(rows(db, 'UDFVALUE').filter((v) => orig.includes(v.udf_type_id) && blIds.has(v.fk_id)).length, 0, 'no field on a baseline activity');
  }
});

test('a numbered field of another type refuses the apply before anything is written (field_type_clash words)', () => {
  const db = plan();
  apply(db, { A: 8 });
  good(db, [{ op: 'add_udf', name: runField(1).toLowerCase(), data_type: 'text' }]); // (field names are matched without case; the numbering reads the exact name, so the next run is 2 and writes run 1)
  const o = { changes: [1], projIds: [projId(db, 'R')] };
  const c = whiqFieldClash(db, o)!;
  assert.deepEqual([c.field, c.found, c.needed], [runField(1).toLowerCase(), 'text', 'number']);
});

// ---- the MCP tool: two real applies, undo, XER, and the refusal of a schedule in progress ----
const { callTool, toolResult } = await import('../mcp/server.ts');
const { setRoots } = await import('../mcp/runtime.ts');
setRoots(null, tmpdir());
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
async function mcpProject(id: string, extra: unknown[] = [], direct?: (db: Db) => void) {
  const np = (await call('new_project', { id, start: '2026-06-01' })).d;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 20 }];
  for (const [c, d] of [['A', 10], ['B', 5], ['C', 6]] as const) ops.push({ op: 'add_activity', id: c, name: `Activity ${c}`, duration_days: d }, { op: 'assign_resource', activity: c, resource: 'civil', units_per_day: 16 });
  ops.push({ op: 'add_relationship', pred: 'A', succ: 'B' }, ...extra);
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  if (direct) direct((await import('../mcp/runtime.ts')).sessions.get(np.handle)!.db);
  return { handle: np.handle as string, owner_key: np.owner_key as string };
}
const udf = async (handle: string) => {
  const t = async (table: string) => { const r = (await call('read_table', { handle, table })).d; return r.rows ? r : { columns: [], rows: [] }; };
  const types = await t('UDFTYPE'), vals = await t('UDFVALUE'), tasks = await t('TASK');
  const col = (x: any, c: string) => x.columns.indexOf(c);
  const label = new Map<string, string>(types.rows.map((r: string[]) => [r[col(types, 'udf_type_id')], r[col(types, 'udf_type_label')]]));
  const code = new Map<string, string>(tasks.rows.map((r: string[]) => [r[col(tasks, 'task_id')], r[col(tasks, 'task_code')]]));
  const values: Record<string, Record<string, string>> = {};
  for (const r of vals.rows) { const l = label.get(r[col(vals, 'udf_type_id')]); if (l?.startsWith('WHIQ')) (values[code.get(r[col(vals, 'fk_id')])!] ??= {})[l] = r[col(vals, 'udf_number')] || r[col(vals, 'udf_text')]; }
  return { labels: [...label.values()].filter((l) => l.startsWith('WHIQ')).sort(), values };
};

test('optimize_schedule apply: run 1, run 2 (the run-1 field), undo of run 2 takes back its values and the field it declared, XER save and open keep the numbering', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { handle, owner_key } = await mcpProject('RR');
  const opt = (crash: unknown[]) => call('optimize_schedule', { handle, owner_key, seed: 1, samples: 5, activities: crash, apply: true });
  const r1 = await opt([{ id: 'A', crash_days: 6, crash_cost: 4500 }, { id: 'C', crash_days: 4, crash_cost: 100 }]);
  assert.equal(r1.err, false, JSON.stringify(r1.d).slice(0, 300));
  const f1 = await udf(handle);
  assert.deepEqual(f1.labels, [NOTE, CHANGE, RANK, ORIGINAL].sort(), 'no numbered field after the first apply');
  assert.equal(f1.values.A[ORIGINAL], '10');
  const r2 = await opt([{ id: 'A', crash_days: 3, crash_cost: 700 }]);
  assert.equal(r2.err, false, JSON.stringify(r2.d).slice(0, 300));
  const f2 = await udf(handle);
  assert.equal(f2.values.A[runField(1)], '6');
  assert.equal(f2.values.A[ORIGINAL], '10');
  assert.equal(f2.values.A[CHANGE], '-7');
  assert.ok(r2.d.fields_written.some((x: any) => x.name === runField(1)));
  // undo: one change takes everything of the apply back, the field it declared too
  assert.equal((await call('undo', { handle, owner_key })).err, false);
  assert.deepEqual(await udf(handle), f1);
  // redo brings the values and the field back
  assert.equal((await call('redo', { handle, owner_key })).err, false);
  assert.deepEqual(await udf(handle), f2);
  assert.equal((await call('undo', { handle, owner_key })).err, false);
  assert.equal((await call('optimize_schedule', { handle, owner_key, seed: 1, samples: 5, activities: [{ id: 'A', crash_days: 3, crash_cost: 700 }], apply: true })).err, false);
  // save as XER and open: the numbering is read from the declared fields, so the next apply is run 3
  const file = join(mkdtempSync(join(tmpdir(), 'p6-runs-')), 'runs.xer');
  assert.equal((await call('save', { handle, owner_key, path: file })).err, false);
  assert.ok(readFileSync(file, 'utf8').includes(runField(1)));
  const re = (await call('open_file', { path: file })).d;
  const r3 = await call('optimize_schedule', { handle: re.handle, owner_key: re.owner_key, seed: 1, samples: 5, activities: [{ id: 'A', crash_days: 2, crash_cost: 900 }], apply: true });
  assert.equal(r3.err, false, JSON.stringify(r3.d).slice(0, 300));
  const f3 = await udf(re.handle);
  assert.ok(f3.labels.includes(runField(2)) && f3.labels.includes(runField(1)));
  assert.equal(f3.values.A[runField(2)], '3', 'the number run 2 gave');
  assert.equal(f3.values.A[runField(1)], '6');
});

/** a project in progress by one fact alone */
const FACTS: Record<string, { ops: unknown[]; says: RegExp; direct?: (db: Db) => void }> = {
  'an actual start': { ops: [{ op: 'update_activity', id: 'C', actual_start: '2026-06-01' }], says: /1 activity has actual dates or progress/ },
  'an actual finish': { ops: [{ op: 'update_activity', id: 'C', actual_start: '2026-06-01', actual_finish: '2026-06-02' }], says: /1 activity has actual dates or progress/ },
  'percent complete above 0, no dates (physical)': { ops: [{ op: 'set_fields', table: 'TASK', where: { task_code: 'C' }, fields: { complete_pct_type: 'CP_Phys', phys_complete_pct: '25' } }], says: /1 activity has actual dates or progress/ },
  'percent complete above 0, no dates (duration)': { ops: [{ op: 'set_fields', table: 'TASK', where: { task_code: 'C' }, fields: { remain_drtn_hr_cnt: '16' } }], says: /1 activity has actual dates or progress/ },
  // (the status follows the actual dates in every edit, so a status with no dates is how an imported file can state it: set on the row)
  'status active, no dates': { ops: [], direct: (db) => { rows(db, 'TASK').find((t) => t.task_code === 'C')!.status_code = 'TK_Active'; }, says: /1 activity has actual dates or progress/ },
  'a data date after the planned start': { ops: [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { last_recalc_date: '2026-06-10 08:00' } }], says: /the data date 2026-06-10 is after the planned start 2026-06-01/ },
};
for (const [fact, { ops, says }] of Object.entries(FACTS)) {
  test(`optimize_schedule is refused on ${fact} alone, with and without apply, both objectives, before anything runs; crash_schedule still runs`, async () => {
    const { handle, owner_key } = await mcpProject(`IP${Object.keys(FACTS).indexOf(fact)}`, ops, FACTS[fact].direct);
    const before = JSON.stringify((await call('read_table', { handle, table: 'TASK' })).d);
    for (const apply of [false, true]) for (const objective of ['makespan', 'min_crash_cost']) {
      const r = await call('optimize_schedule', { handle, owner_key, objective, apply, target_days: 3, seed: 1, samples: 2 });
      assert.equal(r.d.error?.code, 'schedule_in_progress', `${objective} apply ${apply}: ${JSON.stringify(r.d).slice(0, 200)}`);
      assert.match(r.d.error.message, /^optimize_schedule: nothing was run\. The schedule is in progress \(/);
      assert.match(r.d.error.message, says);
      assert.match(r.d.error.message, /the schedule reasoner plans only work that has not started\.$/);
      assert.equal(r.d.error.hint, 'To shorten the remaining work of a schedule in progress, use crash_schedule. To level resources on work in progress, use level_resources.');
    }
    assert.equal(JSON.stringify((await call('read_table', { handle, table: 'TASK' })).d), before, 'nothing changed');
    const crash = await call('crash_schedule', { handle, owner_key, target_days: 3, activities: [{ id: 'A', crash_days: 6, crash_cost: 10 }] });
    assert.equal(crash.err, false, JSON.stringify(crash.d).slice(0, 300));
    assert.equal(crash.d.error, undefined);
    assert.equal((await call('level_resources', { handle, owner_key, dry_run: true })).err, false, 'level_resources takes work in progress');
  });
}

test('a project not started, with the data date on its planned start (a later time of that day too), runs; the refusal compares days, strictly after', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { handle, owner_key } = await mcpProject('NS', [{ op: 'set_fields', table: 'PROJECT', all: true, fields: { last_recalc_date: '2026-06-01 16:00' } }]);
  const r = await call('optimize_schedule', { handle, owner_key, seed: 1, samples: 2, activities: [{ id: 'A', crash_days: 6, crash_cost: 10 }] });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  const db = (await import('../mcp/runtime.ts')).sessions.get(handle)!.db;
  assert.equal(reasonerRefusal(db, rows(db, 'PROJECT').map((p) => p.proj_id)), undefined);
});

test('optimize_schedule with objective min_crash_cost and crash_schedule itself apply by the same run rule', async () => {
  const { handle, owner_key } = await mcpProject('MC');
  const go = (tool: string, extra: Record<string, unknown>) => call(tool, { handle, owner_key, apply: true, ...extra });
  const one = await go('optimize_schedule', { objective: 'min_crash_cost', target_days: 4, activities: [{ id: 'A', crash_days: 6, crash_cost: 40 }] });
  assert.equal(one.err, false, JSON.stringify(one.d).slice(0, 300));
  assert.equal((await udf(handle)).values.A[ORIGINAL], '10');
  const two = await go('crash_schedule', { target_days: 2, activities: [{ id: 'A', crash_days: 3, crash_cost: 20 }] });
  assert.equal(two.err, false, JSON.stringify(two.d).slice(0, 300));
  const f = await udf(handle);
  assert.equal(f.values.A[runField(1)], '6', 'crash_schedule after the reasoner objective is run 2');
  assert.equal(f.values.A[ORIGINAL], '10');
  assert.ok(two.d.fields_written.some((x: any) => x.name === runField(1)));
  // crash_schedule on its own project: run 1 declares no numbered field, run 2 declares the run-1 field
  const other = await mcpProject('MD');
  for (const [d, c] of [[4, 6], [2, 3]]) assert.equal((await call('crash_schedule', { handle: other.handle, owner_key: other.owner_key, apply: true, target_days: d, activities: [{ id: 'A', crash_days: c, crash_cost: 10 }] })).err, false);
  const fo = await udf(other.handle);
  assert.deepEqual(fo.labels, [NOTE, CHANGE, ORIGINAL, runField(1)].sort());
  assert.equal(fo.values.A[runField(1)], '6');
});

test('B-undo: undo of an apply that declared a field takes back its values and the declaration; redo brings both back (crash_schedule, then crash_schedule)', async () => {
  const { handle, owner_key } = await mcpProject('UD');
  const crash = (target: number, to: number) => call('crash_schedule', { handle, owner_key, apply: true, target_days: target, activities: [{ id: 'A', crash_days: to, crash_cost: 10 }] });
  assert.equal((await crash(4, 6)).err, false);
  const f1 = await udf(handle);
  assert.ok(!f1.labels.includes(runField(1)));
  assert.equal((await crash(2, 3)).err, false);
  const f2 = await udf(handle);
  assert.ok(f2.labels.includes(runField(1)) && f2.values.A[runField(1)] === '6');
  assert.equal((await call('undo', { handle, owner_key })).err, false);
  assert.deepEqual(await udf(handle), f1, 'values and the declared field are gone');
  assert.equal((await call('redo', { handle, owner_key })).err, false);
  assert.deepEqual(await udf(handle), f2, 'and back');
});
