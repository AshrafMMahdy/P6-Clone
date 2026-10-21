// Schedules past what V8 can pass as arguments: Math.max / Math.min / push over a spread array failed with "Maximum
// call stack size exceeded" at 228,000 activities (DCMA-14 and lint). Every site loops now (core/arrays.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { dcma14 } from '../core/analysis/dcma.ts';
import { maxOf, minOf, pushAll } from '../core/arrays.ts';
import type { Db } from '../core/db.ts';

test('maxOf, minOf and pushAll over a million values (a spread of this size overflows the stack)', () => {
  const a = Float64Array.from({ length: 1_000_000 }, (_, i) => (i * 7919) % 1_000_003);
  assert.throws(() => Math.max(...(a as unknown as number[])), RangeError, 'the spread itself fails');
  assert.equal(maxOf(a), 1_000_002);
  assert.equal(minOf(a), 0);
  assert.deepEqual([maxOf([]), minOf([]), maxOf([1, NaN, 3])], [-Infinity, Infinity, NaN]);
  const out = [1]; pushAll(out, a); assert.equal(out.length, 1_000_001);
});

test('DCMA-14 on 160,000 activities finishes (past 150,000 it failed with "Maximum call stack size exceeded")', { timeout: 600_000 }, () => {
  const db: Db = { tables: {} };
  const r = applyOps(db, [{ op: 'add_project', id: 'BIG', start: '2026-03-02' }, { op: 'add_activity', id: 'A0', name: 'Activity 0', duration_days: 5 }, { op: 'add_activity', id: 'A1', name: 'Activity 1', duration_days: 5 }, { op: 'add_relationship', pred: 'A0', succ: 'A1' }]);
  assert.ok(r.ok, JSON.stringify(r.error));
  const T = db.tables.TASK, base = T.rows[1];
  let id = Math.max(...T.rows.map((t) => Number(t.task_id))) + 1;
  for (let i = 2; i < 160_000; i++) T.rows.push({ ...base, task_id: String(id++), task_code: `A${i}`, task_name: `Activity ${i}`, guid: '' });
  const d = dcma14(db);
  assert.ok(d.checks.length >= 14);
});
