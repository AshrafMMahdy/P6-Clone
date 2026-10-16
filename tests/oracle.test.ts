// Ratchet: rescheduling real P6 exports must keep matching P6's own dates at least as well as before.
// Regenerate the baseline after a deliberate improvement: UPDATE_ORACLE=1 node --test tests/oracle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { oracle } from '../scripts/oracle.ts';

const FILE = join(import.meta.dirname, 'oracle-baseline.json');

test('scheduler matches real P6 results (ratchet)', { timeout: 600_000 }, () => {
  const now = Object.fromEntries(oracle().map((r) => [r.file, r.overall]));
  if (process.env.UPDATE_ORACLE || !existsSync(FILE)) writeFileSync(FILE, JSON.stringify(now, null, 1) + '\n');
  const base: Record<string, number> = JSON.parse(readFileSync(FILE, 'utf8'));
  const worse = Object.entries(base).filter(([f, v]) => (now[f] ?? 0) < v - 0.05).map(([f, v]) => `${f}: ${now[f]} < ${v}`);
  assert.deepEqual(worse, []);
});
