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
