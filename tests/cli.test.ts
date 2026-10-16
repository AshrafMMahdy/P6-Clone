import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
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
