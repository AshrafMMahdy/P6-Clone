import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkCalendar, CalendarHorizonError } from '../core/calendar/calendar.ts';
import { standardCalendar } from '../core/calendar/clndr-data.ts';
import { parseP6Date as d, formatP6Date as f, minutesToSerial } from '../core/dates.ts';

// Mon-Fri 08:00-12:00, 13:00-17:00
const cal = new WorkCalendar(standardCalendar());
const H = 60;

test('nextWorkStart / prevWorkEnd', () => {
  assert.equal(f(cal.nextWorkStart(d('2024-01-05 17:00')!)), '2024-01-08 08:00'); // Fri end -> Mon
  assert.equal(f(cal.nextWorkStart(d('2024-01-08 12:00')!)), '2024-01-08 13:00'); // lunch
  assert.equal(f(cal.nextWorkStart(d('2024-01-08 09:30')!)), '2024-01-08 09:30');
  assert.equal(f(cal.prevWorkEnd(d('2024-01-08 08:00')!)), '2024-01-05 17:00');
  assert.equal(f(cal.prevWorkEnd(d('2024-01-08 12:30')!)), '2024-01-08 12:00');
  assert.equal(f(cal.prevWorkEnd(d('2024-01-09 00:00')!)), '2024-01-08 17:00');
});

test('addWork lands on period end', () => {
  assert.equal(f(cal.addWork(d('2024-01-08 08:00')!, 8 * H)), '2024-01-08 17:00');
  assert.equal(f(cal.addWork(d('2024-01-05 16:00')!, 8 * H)), '2024-01-08 16:00');
  assert.equal(f(cal.addWork(d('2024-01-05 17:00')!, 0)), '2024-01-05 17:00');
  assert.equal(f(cal.addWork(d('2024-01-08 08:00')!, 40 * H)), '2024-01-12 17:00');
});

test('subWork lands on period start', () => {
  assert.equal(f(cal.subWork(d('2024-01-08 17:00')!, 8 * H)), '2024-01-08 08:00');
  assert.equal(f(cal.subWork(d('2024-01-08 16:00')!, 8 * H)), '2024-01-05 16:00');
  assert.equal(f(cal.subWork(d('2024-01-08 09:00')!, 2 * H)), '2024-01-05 16:00');
});

test('holiday exception skipped', () => {
  const def = standardCalendar();
  def.exceptions.set(minutesToSerial(d('2024-01-09')!), []);
  const c = new WorkCalendar(def);
  assert.equal(f(c.addWork(d('2024-01-08 08:00')!, 16 * H)), '2024-01-10 17:00');
  assert.equal(c.workBetween(d('2024-01-08 08:00')!, d('2024-01-11 08:00')!), 16 * H);
});

test('workBetween', () => {
  const a = d('2024-01-08 08:00')!, b = d('2024-01-12 17:00')!;
  assert.equal(cal.workBetween(a, b), 40 * H);
  assert.equal(cal.workBetween(b, a), -40 * H);
  assert.equal(cal.workBetween(d('2024-01-05 17:00')!, d('2024-01-08 08:00')!), 0);
});

test('continuous calendar and horizon', () => {
  const c = WorkCalendar.continuous();
  assert.equal(f(c.addWork(d('2024-01-06 00:00')!, 24 * H)), '2024-01-07 00:00');
  const none = new WorkCalendar({ week: [[], [], [], [], [], [], []], exceptions: new Map() });
  assert.throws(() => none.nextWorkStart(0), CalendarHorizonError);
});
