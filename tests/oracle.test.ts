// Ratchet: rescheduling real P6 exports must never get more dates wrong than before
// (baseline: number of mismatched date/float values per file; 0 = identical to P6).
// Regenerate the baseline after a deliberate improvement: UPDATE_ORACLE=1 node --test tests/oracle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { oracle } from '../scripts/oracle.ts';

const FILE = join(import.meta.dirname, 'oracle-baseline.json');

test('scheduler matches real P6 results (ratchet)', { timeout: 600_000 }, () => {
  const now = Object.fromEntries(oracle().map((r) => [r.file, r.wrong]));
  if (process.env.UPDATE_ORACLE || !existsSync(FILE)) writeFileSync(FILE, JSON.stringify(now, null, 1) + '\n');
  const base: Record<string, number> = JSON.parse(readFileSync(FILE, 'utf8'));
  // downloaded/ cases are optional (files not in git): only checked where present
  const worse = Object.entries(base).filter(([f]) => f in now || !f.startsWith('downloaded/')).filter(([f, v]) => (now[f] ?? Infinity) > v).map(([f, v]) => `${f}: ${now[f]} wrong values > ${v}`);
  assert.deepEqual(worse, []);
});
