import { test } from 'node:test';
import assert from 'node:assert/strict';
import { types } from 'node:util';
import { record, rollback } from '../core/journal.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseXer } from '../core/xer/parse.ts';
import { importIntoDb, defaultPlan } from '../core/xer/import.ts';
import { realSamples } from './helpers.ts';
import type { Db } from '../core/db.ts';

const noProxies = (v: unknown, seen = new Set<unknown>()): boolean => {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  if (types.isProxy(v)) return false;
  seen.add(v);
  return Object.values(v).every((x) => noProxies(x, seen));
};

test('undo/redo every kind of change, and nothing recorded leaks into the data', () => {
  const db: Db = { tables: { TASK: { name: 'TASK', fields: ['task_id', 'n'], rows: [{ task_id: '1', n: 'a' }, { task_id: '2', n: 'b' }, { task_id: '3', n: 'c' }] } } };
  const before = structuredClone(db);
  const j = record(db, (d) => {
    const T = d.tables.TASK;
    T.rows[0].n = 'A';                         // edit
    delete T.rows[1].n;                        // remove a field
    (T.rows[2] as Record<string, string>).x = 'new'; // add a field
    T.rows.push({ task_id: '4', n: 'd' });     // add a row
    T.rows.sort((p, q) => q.task_id.localeCompare(p.task_id)); // reorder in place
    T.rows.splice(1, 1);                       // delete a row
    d.tables.PRED = { name: 'PRED', fields: ['x'], rows: T.rows.filter((r) => r.task_id !== '4') }; // table built from views
    T.fields.push('x');
  });
  const after = structuredClone(db);
  assert.ok(noProxies(db));
  const redo = rollback(j);
  assert.deepEqual(db, before);
  rollback(redo);
  assert.deepEqual(db, after);
});

test('a real schedule run and a real import roll back exactly', () => {
  const db = parseXer(realSamples().find((s) => s.name === 'cairo festival city.xer')!.bytes).db;
  const before = structuredClone(db);
  const j = record(db, (d) => { scheduleProjects(d, d.tables.PROJECT.rows.map((p) => p.proj_id)); const src = parseXer(realSamples().find((s) => s.name === 'CfC.xer')!.bytes).db; importIntoDb(d, src, defaultPlan(src)); });
  assert.notDeepEqual(db, before);
  assert.ok(noProxies(db));
  const after = structuredClone(db);
  const redo = rollback(j);
  assert.deepEqual(db, before);
  rollback(redo);
  assert.deepEqual(db, after);
});
