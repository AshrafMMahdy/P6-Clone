import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SAMPLES_DIR } from './helpers.ts';

const CLI = join(import.meta.dirname, '..', 'cli', 'p6clone.ts');
const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

test('validate --json on agent file reports fatal key typo', () => {
  const r = run('validate', join(SAMPLES_DIR, 'Tower-A.xer'), '--json');
  assert.equal(r.status, 2, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, 'fatal');
  assert.ok(j.findings.some((f: { code: string }) => f.code === 'MISSING_KEY_FIELD'));
});

test('validate real P6 file exits 0', () => {
  const r = run('validate', join(SAMPLES_DIR, 'CfC.xer'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /P6 would import this file/);
});

test('export then diff shows no differences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6c-'));
  const out = join(dir, 'out.xer');
  const src = join(SAMPLES_DIR, 'CfC.xer');
  assert.equal(run('export', src, '--version', '6.0.0', '--out', out).status, 0);
  assert.ok(existsSync(out));
  const d = run('diff', src, out, '--json');
  assert.deepEqual(JSON.parse(d.stdout), []);
});

// ---- headless P6: new, edit, query, review
const tmp = () => mkdtempSync(join(tmpdir(), 'p6h-'));
const runIn = (input: string, ...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', input });

test('new + edit builds and schedules a project from scratch; the result is a valid XER', () => {
  const d = tmp(), v0 = join(d, 'v0.xer'), v1 = join(d, 'v1.xer');
  assert.equal(run('new', '--id', 'T1', '--name', 'Test', '--start', '2026-03-02', '--out', v0).status, 0);
  const ops = JSON.stringify([
    { op: 'add_wbs', code: 'A', name: 'Area A' },
    { op: 'add_activity', id: 'A10', name: 'Start', type: 'start_milestone', wbs: 'A' },
    { op: 'add_activity', id: 'A20', name: 'Work', wbs: 'A', duration_days: 5 },
    { op: 'add_activity', id: 'A30', name: 'More work', wbs: 'A', duration_days: 3 },
    { op: 'add_activity', id: 'A40', name: 'Done', type: 'finish_milestone', wbs: 'A' },
    { op: 'add_relationship', pred: 'A10', succ: 'A20' },
    { op: 'add_relationship', pred: 'A20', succ: 'A30', type: 'FS', lag_days: 1 },
    { op: 'add_relationship', pred: 'A30', succ: 'A40' },
  ]);
  const r = runIn(ops, 'edit', v0, '--ops', '-', '--schedule', '--json', '--out', v1);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.applied, 8);
  assert.equal(j.schedule.finish, '2026-03-12 17:00'); // 5 days + 1 day lag + 3 days on the standard 5-day calendar
  assert.equal(run('validate', v1).status, 0);
  const q = JSON.parse(run('query', v1, 'activity', 'A30', '--json').stdout);
  assert.equal(q.start, '2026-03-10 08:00'); // A20 ends Fri 6 Mar, +1 day lag = Mon 9 Mar
  assert.deepEqual(q.predecessors.map((p: { id: string; lag_days: number }) => [p.id, p.lag_days]), [['A20', 1]]);
});

test('edit is one transaction: a failing operation changes nothing and is named', () => {
  const d = tmp(), v0 = join(d, 'v0.xer'), out = join(d, 'out.xer');
  run('new', '--id', 'T2', '--start', '2026-03-02', '--out', v0);
  const r = runIn(JSON.stringify([{ op: 'add_activity', id: 'B1', name: 'ok' }, { op: 'add_relationship', pred: 'B1', succ: 'NOPE' }]), 'edit', v0, '--ops', '-', '--out', out, '--json');
  assert.equal(r.status, 65);
  const j = JSON.parse(r.stdout);
  assert.equal(j.error.index, 1);
  assert.match(j.error.message, /No activity "NOPE"/);
  assert.equal(existsSync(out), false);
});

test('query and review on a real P6 file', () => {
  const f = join(SAMPLES_DIR, 'cairo festival city.xer');
  const s = JSON.parse(run('query', f, 'summary', '--json').stdout);
  assert.ok(s.activities > 50);
  const found = JSON.parse(run('query', f, 'find', '--text', 'water', '--limit', '2', '--json').stdout);
  assert.ok(found.total_matches >= 2 && found.activities.length === 2);
  const r = run('review', f, '--json');
  assert.equal(r.status, 3); // this programme has leads (negative lags): a failing check
  const rv = JSON.parse(r.stdout);
  assert.equal(rv.checks.find((c: { id: string }) => c.id === 'leads').grade, 'fail');
  assert.equal(rv.checks.find((c: { id: string }) => c.id === 'saved_dates').grade, 'pass');
});

test('P6 XML in and out: validate, query and schedule read .xml; --out *.xml writes P6 XML', () => {
  const dir = tmp(), xml = join(dir, 'p.xml'), out = join(dir, 'out.xml');
  assert.equal(run('export', join(SAMPLES_DIR, 'CfC.xer'), '--format', 'xml', '--out', xml).status, 0);
  const v = run('validate', xml, '--json');
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.ok(!JSON.parse(v.stdout).findings.some((f: { code: string }) => f.code === 'MISSING_FIELD'), 'XER field-list checks do not apply to XML');
  assert.match(run('query', xml, 'summary').stdout, /activities: \d+/);
  assert.equal(run('schedule', xml, '--out', out).status, 0);
  assert.match(readFileSync(out, 'utf8'), /<APIBusinessObjects/);
});

test('unknown command and missing file are reported', () => {
  const u = run('bogus');
  assert.equal(u.status, 64);
  assert.match(u.stderr, /unknown command "bogus"/);
  assert.equal(run('--help').status, 0);
  assert.match(run('query', 'no-such-file.xer', 'summary').stderr, /Cannot read no-such-file\.xer: no such file/);
});

test('query shows activity codes and UDFs and finds by code', () => {
  const f = join(SAMPLES_DIR, 'el ezz warehouse.xer');
  const a = JSON.parse(run('query', f, 'activity', 'A160', '--json').stdout);
  assert.deepEqual(a.activity_codes, { 'TYPE OF WORK': 'civil - civil works' });
  assert.deepEqual(a.udfs, { '(New)': '1000' });
  const b = JSON.parse(run('query', f, 'activity', 'A1020', '--json').stdout);
  assert.deepEqual(b.predecessors.map((p: { id: string; driving: boolean; rel_free_float_days: number }) => [p.id, p.driving, p.rel_free_float_days]), [['A1050', true, 0]]);
  const found = JSON.parse(run('query', f, 'find', '--code', 'TYPE OF WORK=civil', '--limit', '100', '--json').stdout);
  assert.equal(found.total_matches, 8);
  assert.ok(found.activities.some((x: { id: string }) => x.id === 'A160'));
});

test('edit operations refuse codes P6 does not have and keep P6 rules (milestone duration, one link per pair and type; per pair for Microsoft Project)', async () => {
  const { applyOps } = await import('../core/project/ops.ts');
  const { emptyDb } = await import('../core/db.ts');
  const db = emptyDb();
  const ok = (ops: unknown[]) => { const r = applyOps(db, ops); assert.equal(r.ok, true, r.error?.message ?? ''); };
  const err = (ops: unknown[]): string => applyOps(db, ops).error?.message ?? '';
  ok([{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'add_activity', project: 'P', id: 'A1', name: 'a', duration_days: 5 }, { op: 'add_activity', project: 'P', id: 'A2', name: 'b', duration_days: 2 },
    { op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2' }]);
  // Microsoft Project (onePerPair): a second relationship between the same pair (any type) is skipped with a warning
  const m = applyOps(structuredClone(db), [{ op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2', type: 'SS' }], { onePerPair: true });
  assert.deepEqual([m.results[0], m.warnings!.length], [{ skipped: 'A1 SS A2', existing: 'A1 FS A2' }, 1]);
  assert.match(m.warnings![0], /A1 -> A2 \(SS\) skipped: .*FS relationship, and Microsoft Project keeps one per pair/);
  // P6: one per pair and type (an SS beside the FS is kept); a true duplicate is skipped with a warning; the rest applies
  const r = applyOps(db, [{ op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2', type: 'SS' }, { op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2' }, { op: 'update_activity', project: 'P', id: 'A2', name: 'b2' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.slice(0, 2), [{ relationship: 'A1 SS A2' }, { skipped: 'A1 FS A2', existing: 'A1 FS A2' }]);
  assert.equal(r.warnings!.length, 1);
  assert.match(r.warnings![0], /A1 -> A2 \(FS\) skipped: it already exists/);
  assert.equal(db.tables.TASKPRED.rows.length, 2);
  db.tables.TASKPRED.rows.pop(); // back to the one FS
  assert.equal(db.tables.TASK.rows.find((x) => x.task_code === 'A2')!.task_name, 'b2');
  assert.equal(applyOps(db, [{ op: 'update_activity', project: 'P', id: 'A2', name: 'b' }]).warnings, undefined);
  db.tables.TASKPRED.rows.push({ ...db.tables.TASKPRED.rows[0], task_pred_id: '99', pred_type: 'PR_SS' }); // a file that has two
  assert.match(err([{ op: 'update_activity', project: 'P', id: 'A1', constraint: { type: 'CS_START_ON', date: '2026-03-02' } }]), /Unknown constraint/);
  assert.match(err([{ op: 'update_activity', project: 'P', id: 'A1', type: 'TT_Milestone' }]), /Unknown activity type/);
  assert.match(err([{ op: 'update_relationship', project: 'P', pred: 'A1', succ: 'A2', type: 'SS', new_type: 'FS' }]), /already has a FS relationship/);
  ok([{ op: 'update_activity', project: 'P', id: 'A1', type: 'TT_FinMile' }, { op: 'update_activity', project: 'P', id: 'A2', constraint: { type: 'CS_MSOA', date: '2026-03-09' } }]);
  const t = db.tables.TASK.rows.find((r) => r.task_code === 'A1')!;
  assert.deepEqual([t.task_type, t.target_drtn_hr_cnt, t.remain_drtn_hr_cnt], ['TT_FinMile', '0', '0']);
});

test('compare matches activities by Activity ID, so renumbered internal ids are not differences', async () => {
  const { compareSchedules } = await import('../core/diff.ts');
  const { parseXer } = await import('../core/xer/parse.ts');
  const a = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;
  const b: typeof a = structuredClone(a);
  const shift = (v: string) => (v ? String(Number(v) + 100000) : v);
  for (const t of b.tables.TASK.rows) t.task_id = shift(t.task_id);
  for (const r of b.tables.TASKPRED.rows) { r.task_id = shift(r.task_id); r.pred_task_id = shift(r.pred_task_id); r.task_pred_id = shift(r.task_pred_id); }
  assert.deepEqual(compareSchedules(a, b), []);
  const [t0, t1] = b.tables.TASK.rows;
  t0.target_drtn_hr_cnt = String(Number(t0.target_drtn_hr_cnt) + 16);
  b.tables.TASK.rows = b.tables.TASK.rows.filter((t) => t !== t1);
  b.tables.TASKPRED.rows = b.tables.TASKPRED.rows.filter((r) => r.task_id !== t1.task_id && r.pred_task_id !== t1.task_id);
  const cs = compareSchedules(a, b);
  assert.deepEqual(cs.filter((c) => c.object === 'activity').map((c) => [c.kind, c.id, c.field ?? '']), [['changed', t0.task_code, 'original_duration'], ['deleted', t1.task_code, '']]);
  const lost = a.tables.TASKPRED.rows.filter((r) => r.task_id === a.tables.TASK.rows[1].task_id || r.pred_task_id === a.tables.TASK.rows[1].task_id).length;
  assert.equal(cs.filter((c) => c.object === 'relationship' && c.kind === 'deleted').length, lost);
  const r = run('compare', join(SAMPLES_DIR, 'cairo festival city.xer'), join(SAMPLES_DIR, 'cairo festival city.xer'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Activities: 0 added, 0 deleted, 0 changed/);
});

test('the operations guide given to the AI assistant covers every operation, and every listed operation exists', async () => {
  const { applyOps, OP_GUIDE, OP_NAMES } = await import('../core/project/ops.ts');
  const { emptyDb } = await import('../core/db.ts');
  const src = ['ops.ts', 'ops-extra.ts'].map((f) => readFileSync(join(import.meta.dirname, '..', 'core', 'project', f), 'utf8')).join('\n');
  const handled = [...src.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...OP_NAMES].sort(), [...new Set(handled)].sort());
  for (const n of OP_NAMES) assert.match(OP_GUIDE, new RegExp(`(^|\n|/ )${n}:|${n} /|; ${n}:`), n);
  for (const n of OP_NAMES) assert.doesNotMatch(applyOps(emptyDb(), [{ op: n }]).error?.message ?? '', /Unknown operation/, n);
  // a small schedule built only from what the guide says
  const db = emptyDb();
  const r = applyOps(db, [
    { op: 'add_project', id: 'B5', name: 'Five-story building', start: '2026-11-02' },
    { op: 'add_calendar', name: '6-day', work_week: { mon: [['07:00', '15:00']], tue: [['07:00', '15:00']], wed: [['07:00', '15:00']], thu: [['07:00', '15:00']], fri: [['07:00', '15:00']], sat: [['07:00', '15:00']], sun: [] }, holidays: ['2026-12-25'] },
    { op: 'add_wbs', code: 'SUB', name: 'Substructure' }, { op: 'add_wbs', code: 'L1', name: 'Level 1', parent: 'SUB' },
    { op: 'add_activity', id: 'M0', name: 'Start', type: 'start_milestone', wbs: 'SUB' },
    { op: 'add_activity', id: 'A1000', name: 'Excavation', wbs: 'SUB', duration_days: 10, calendar: '6-day' },
    { op: 'add_activity', id: 'A1010', name: 'Columns L1', wbs: 'SUB.L1', duration_days: 5, constraint: { type: 'start_on_or_after', date: '2026-11-20' } },
    { op: 'add_activity', id: 'M9', name: 'Finish', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'M0', succ: 'A1000' }, { op: 'add_relationship', pred: 'A1000', succ: 'A1010', type: 'SS', lag_days: 3 },
    { op: 'add_relationship', pred: 'A1010', succ: 'M9' },
    { op: 'add_resource', id: 'CREW', type: 'labor', units_per_day: 8 }, { op: 'assign_resource', activity: 'A1010', resource: 'CREW' },
  ]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  assert.equal(db.tables.TASK.rows.length, 4);
});

test('copy_project makes a clean, renumbered copy that can be trimmed; lookups read any project by ID', async () => {
  const { applyOps } = await import('../core/project/ops.ts');
  const { runTool } = await import('../core/query/tools.ts');
  const { parseXer } = await import('../core/xer/parse.ts');
  const { makeCtx } = await import('../core/project/ctx.ts');
  const { rows } = await import('../core/db.ts');
  const db = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;
  const src = rows(db, 'PROJECT')[0];
  const srcTasks = rows(db, 'TASK').filter((t) => t.proj_id === src.proj_id);
  const srcRels = rows(db, 'TASKPRED').length;
  const progressed = srcTasks.filter((t) => t.act_start_date).length;
  const r = applyOps(db, [{ op: 'copy_project', from: src.proj_short_name, id: 'COPY1', name: 'Template copy', start: '2027-01-04' }]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const p = rows(db, 'PROJECT').find((x) => x.proj_short_name === 'COPY1')!;
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === p.proj_id);
  assert.equal(tasks.length, srcTasks.length);
  assert.equal(rows(db, 'TASKPRED').length, srcRels * 2, 'relationships copied');
  assert.ok(tasks.every((t) => !srcTasks.some((s) => s.task_id === t.task_id)), 'new internal ids');
  assert.ok(tasks.every((t) => !t.act_start_date && !t.act_end_date && t.remain_drtn_hr_cnt === t.target_drtn_hr_cnt), 'progress cleared');
  assert.ok(progressed === 0 || srcTasks.filter((t) => t.act_start_date).length === progressed, 'source untouched');
  assert.equal(p.plan_start_date.slice(0, 10), '2027-01-04');
  assert.ok(tasks.every((t) => !t.target_start_date || t.target_start_date >= '2027-01-04'), 'planned dates moved to the new start');
  // the copy is edited like any project, by Activity ID, without touching the source
  const victim = tasks.find((t) => t.task_type === 'TT_Task')!.task_code;
  assert.equal(applyOps(db, [{ op: 'delete_activity', project: 'COPY1', id: victim }]).ok, true);
  assert.ok(rows(db, 'TASK').some((t) => t.proj_id === src.proj_id && t.task_code === victim), 'source keeps the activity');
  assert.match(applyOps(db, [{ op: 'copy_project', from: src.proj_short_name, id: 'copy1' }]).error?.message ?? '', /already exists/);
  // lookups
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const list = runTool('list_projects', {}, db, ctx, [src.proj_id], 8) as { projects: { id: string; open: boolean; activities: number }[] };
  assert.deepEqual(list.projects.map((x) => [x.id, x.open]), [[src.proj_short_name, true], ['COPY1', false]]);
  const sum = runTool('project_summary', { project: 'COPY1' }, db, ctx, [src.proj_id], 8) as { activities: number };
  assert.equal(sum.activities, srcTasks.length - 1);
  assert.match((runTool('list_wbs', { project: 'NOPE' }, db, ctx, [], 8) as { error: string }).error, /No project "NOPE"/);
});

test('delete_wbs removes a whole floor and keeps the chain closed across it; dissolving a chain bridges its ends', async () => {
  const { applyOps } = await import('../core/project/ops.ts');
  const { emptyDb, rows } = await import('../core/db.ts');
  const db = emptyDb();
  const floor = (n: number) => [
    { op: 'add_wbs', code: `L${n}`, name: `Level ${n}` },
    { op: 'add_activity', id: `F${n}0`, name: `L${n} formwork`, wbs: `L${n}`, duration_days: 5 },
    { op: 'add_activity', id: `F${n}1`, name: `L${n} rebar`, wbs: `L${n}`, duration_days: 3 },
    { op: 'add_activity', id: `F${n}2`, name: `L${n} pour`, wbs: `L${n}`, duration_days: 1 },
    { op: 'add_relationship', pred: `F${n}0`, succ: `F${n}1`, type: 'SS', lag_days: 2 }, { op: 'add_relationship', pred: `F${n}1`, succ: `F${n}2` },
    ...(n > 1 ? [{ op: 'add_relationship', pred: `F${n - 1}2`, succ: `F${n}0`, lag_days: 1 }] : []),
  ];
  const r = applyOps(db, [{ op: 'add_project', id: 'T', start: '2027-03-01' }, ...floor(1), ...floor(2), ...floor(3)]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const d = applyOps(db, [{ op: 'delete_wbs', code: 'L2' }]);
  assert.equal(d.ok, true, d.error?.message ?? '');
  assert.deepEqual(d.results[0], { deleted_wbs: 'L2', wbs_elements: 1, activities: 3, relationships_added: 1 });
  const code = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.task_code]));
  const links = rows(db, 'TASKPRED').map((p) => `${code.get(p.pred_task_id)}>${code.get(p.task_id)} ${p.pred_type} ${Number(p.lag_hr_cnt)}`);
  assert.ok(links.includes('F12>F30 PR_FS 8'), 'level 1 pour now leads to level 3 formwork: ' + links.join(', '));
  assert.ok(!rows(db, 'PROJWBS').some((w) => w.wbs_short_name === 'L2') && !rows(db, 'TASK').some((t) => t.task_code.startsWith('F2')));
  // keep_logic false just deletes
  assert.equal(applyOps(db, [{ op: 'delete_wbs', code: 'L3', keep_logic: false }]).results[0] && rows(db, 'TASKPRED').some((p) => code.get(p.task_id) === 'F30'), false);
});
