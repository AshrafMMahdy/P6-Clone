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

test('edit operations refuse codes P6 does not have and keep P6 rules (milestone duration, one link per type)', async () => {
  const { applyOps } = await import('../core/project/ops.ts');
  const { emptyDb } = await import('../core/db.ts');
  const db = emptyDb();
  const ok = (ops: unknown[]) => { const r = applyOps(db, ops); assert.equal(r.ok, true, r.error?.message ?? ''); };
  const err = (ops: unknown[]): string => applyOps(db, ops).error?.message ?? '';
  ok([{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'add_activity', project: 'P', id: 'A1', name: 'a', duration_days: 5 }, { op: 'add_activity', project: 'P', id: 'A2', name: 'b', duration_days: 2 },
    { op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2' }, { op: 'add_relationship', project: 'P', pred: 'A1', succ: 'A2', type: 'SS' }]);
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
