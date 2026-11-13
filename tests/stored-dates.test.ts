import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { checkStoredDates } from '../core/schedule/stored-dates.ts';
import { realSamples } from './helpers.ts';

const load = (name: string) => parseXer(realSamples().find((s) => s.name === name)!.bytes).db;

test('saved dates P6 calculated itself are reported current', () => {
  assert.deepEqual(checkStoredDates(load('cairo festival city.xer')), []);
});

test('a file edited after its last schedule is flagged, without changing the file', () => {
  const db = load('badra oil.xer');
  const before = JSON.stringify(db.tables.TASK.rows);
  const f = checkStoredDates(db);
  assert.equal(f[0].code, 'DATES_NOT_CURRENT');
  assert.match(f[0].message, /^The saved dates of .+ are not current: 26 of 635 open activit(?:y|ies) differs? from what F9 gives; run schedule first\.$/);
  assert.equal(f.filter((x) => x.code === 'DATE_NOT_CURRENT').length, 26); // one example per activity that differs, every one (an answer cuts the list by the list rule)
  assert.equal(JSON.stringify(db.tables.TASK.rows), before);
});
