import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFor, TABLE_ORDER, verification, knownFields } from '../core/xer/schema.ts';

test('field lists per version', () => {
  const t7 = fieldsFor('7.0', 'TASK')!;
  assert.equal(t7.length, 58);
  assert.equal(t7[0], 'task_id');
  assert.ok(!t7.includes('est_wt'));
  assert.ok(fieldsFor('5.0', 'TASK')!.includes('est_wt'));
  const modern = fieldsFor('19.12', 'TASK')!;
  assert.ok(modern.includes('location_id'));
  assert.equal(verification('19.12', 'TASK'), 'modern-build');
  assert.equal(verification('7.0', 'TASK'), 'exact');
  assert.ok(fieldsFor('19.12', 'ACCOUNT'), 'falls back for tables missing in modern sample');
  assert.equal(fieldsFor('7.0', 'NOPE'), undefined);
  assert.ok(knownFields('TASKPRED').has('task_pred_id'));
});

test('table order', () => {
  const i = (t: string) => TABLE_ORDER.indexOf(t);
  assert.ok(i('CURRTYPE') < i('PROJECT'));
  assert.ok(i('PROJECT') < i('CALENDAR') && i('CALENDAR') < i('PROJWBS'));
  assert.ok(i('PROJWBS') < i('TASK') && i('TASK') < i('TASKPRED') && i('TASKPRED') < i('TASKRSRC'));
  assert.ok(i('RSRC') < i('TASK'));
});
