import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseP6Date, formatP6Date, serialToMinutes, minutesToSerial, weekday } from '../core/dates.ts';
import { decodeText, encodeCp1252 } from '../core/encoding.ts';

test('P6 date round trip', () => {
  const t = parseP6Date('2014-08-16 08:00')!;
  assert.equal(formatP6Date(t), '2014-08-16 08:00');
  assert.equal(parseP6Date(''), null);
  assert.equal(parseP6Date('2024-02-31 00:00'), null);
  assert.equal(formatP6Date(parseP6Date('2024-02-03')), '2024-02-03 00:00');
});

test('OLE serial days', () => {
  assert.equal(formatP6Date(serialToMinutes(41519)), '2013-09-02 00:00');
  assert.equal(minutesToSerial(parseP6Date('2013-09-02 13:00')!), 41519);
  assert.equal(weekday(parseP6Date('2013-09-02')!), 1); // Monday
});

test('cp1252', () => {
  assert.deepEqual([...encodeCp1252('€a')], [0x80, 0x61]);
  assert.equal(decodeText(new Uint8Array([0x80])).text, '€');
  assert.equal(decodeText(new Uint8Array([0xe2, 0x82, 0xac])).encoding, 'utf-8');
});
