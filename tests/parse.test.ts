import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { samples, realSamples, xer, CORRUPT } from './helpers.ts';

const codes = (t: string | Uint8Array) => parseXer(typeof t === 'string' ? xer(t) : t).findings.map((f) => f.code);

test('parses tables, fields, rows', () => {
  const r = parseXer(xer('ERMHDR\t7.0\t2014-01-01\tProject\n%T\tTASK\n%F\ttask_id\ttask_code\n%R\t1\tA100\n%R\t2\tA200\n%E\n'));
  assert.equal(r.db.header?.version, '7.0');
  assert.deepEqual(r.db.tables.TASK.fields, ['task_id', 'task_code']);
  assert.equal(r.db.tables.TASK.rows[1].task_code, 'A200');
  assert.deepEqual(r.findings, []);
  assert.equal(r.meta.lineEnding, 'CRLF');
});

test('structural findings', () => {
  assert.ok(codes('%T\tTASK\n%F\ta\n%R\t1\n%E\n').includes('NO_HEADER'));
  assert.ok(codes(new TextEncoder().encode('ERMHDR\t7.0\n%T\tX\n%F\ta\n%R\t1\n%E\n')).includes('LF_ENDINGS'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%F\ta\n%R\t1\n').includes('NO_END'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%R\t1\n%E\n').includes('ROW_BEFORE_FIELDS'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%F\ta\n%R\t1\t2\n%E\n').includes('FIELD_COUNT'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%F\ta\tb\n%R\t1\n%E\n').includes('FIELD_COUNT_SHORT'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%F\ta\n%R\t1\n%T\tX\n%F\ta\n%R\t2\n%E\n').includes('DUP_TABLE'));
  assert.ok(codes('ERMHDR\t7.0\n%T\tX\n%F\ta\nxR\t1\n%E\n').includes('BAD_LINE'));
});

test('every sample parses without throwing', () => {
  for (const s of samples()) {
    const r = parseXer(s.bytes);
    assert.ok(r.db.tables, s.name);
  }
});

test('real P6 samples have no structural errors', () => {
  for (const s of realSamples()) {
    const bad = parseXer(s.bytes).findings.filter((f) => f.severity === 'error' || f.severity === 'fatal');
    assert.deepEqual(bad, [], s.name);
  }
  for (const name of CORRUPT) {
    const s = samples().find((x) => x.name === name)!;
    assert.ok(parseXer(s.bytes).findings.some((f) => f.code === 'BAD_LINE'), name);
  }
});
