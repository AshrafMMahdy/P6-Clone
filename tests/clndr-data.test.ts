import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClndrData, serializeClndrData } from '../core/calendar/clndr-data.ts';
import { parseXer } from '../core/xer/parse.ts';
import { samples } from './helpers.ts';

const DHBL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(f|16:00|s|08:00)())))(0||3()((0||0(f|16:00|s|08:00)())))(0||4()((0||0(f|16:00|s|08:00)())))(0||5()((0||0(f|16:00|s|08:00)())))(0||6()((0||0(f|16:00|s|08:00)())))(0||7()())))(0||Exceptions()((0||0(d|41519)())(0||1(d|41155)())))))';

test('parses week and exceptions', () => {
  const c = parseClndrData(DHBL);
  assert.deepEqual(c.week[0], []);
  assert.deepEqual(c.week[1], [{ start: 480, end: 960 }]);
  assert.deepEqual(c.week[6], []);
  assert.deepEqual(c.exceptions.get(41519), []);
  assert.equal(c.exceptions.size, 2);
});

test('serialize round-trips semantically', () => {
  const c = parseClndrData(DHBL);
  const c2 = parseClndrData(serializeClndrData(c));
  assert.deepEqual(c2.week, c.week);
  assert.deepEqual([...c2.exceptions].sort(), [...c.exceptions].sort());
});

test('midnight end and exception work hours', () => {
  const c = parseClndrData('(0||CalendarData()((0||DaysOfWeek()((0||1()((0||0(s|00:00|f|00:00)())))))(0||Exceptions()((0||0(d|45000)((0||0(s|08:00|f|12:00)())))))))');
  assert.deepEqual(c.week[0], [{ start: 0, end: 1440 }]);
  assert.deepEqual(c.exceptions.get(45000), [{ start: 480, end: 720 }]);
});

test('every calendar in real P6 samples parses', () => {
  const failures: string[] = [];
  let n = 0;
  for (const s of samples()) {
    for (const r of parseXer(s.bytes).db.tables.CALENDAR?.rows ?? []) {
      n++;
      try { parseClndrData(r.clndr_data); } catch (e) { if (s.realP6) failures.push(`${s.name} ${r.clndr_name}: ${(e as Error).message}`); }
    }
  }
  assert.ok(n > 100);
  assert.deepEqual(failures.filter((f) => !f.startsWith('CCA R03')), []);
});
