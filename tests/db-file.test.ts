import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbToLines, linesToDb } from '../core/db-file.ts';
import type { Db } from '../core/db.ts';

test('database file round trip in pieces, and old single-line files still load', () => {
  const rows = Array.from({ length: 12345 }, (_, i) => ({ task_id: String(i), task_name: `Act ${i} "quoted"\nline` }));
  const db: Db = { header: { version: '19.12', exportDate: '2026-10-16', raw: [] }, tables: { TASK: { name: 'TASK', fields: ['task_id', 'task_name'], rows }, PROJECT: { name: 'PROJECT', fields: ['proj_id'], rows: [] } } };
  const lines = dbToLines(db, { layoutName: 'x' });
  assert.ok(lines.length > 3 && lines.every((l) => !l.includes('\n')));
  assert.deepEqual(linesToDb(lines), { db, ui: { layoutName: 'x' } });
  assert.deepEqual(linesToDb([JSON.stringify({ version: 1, db, ui: { a: 1 } })]), { db, ui: { a: 1 } });
});
