// The LOB model and its driver matrix: an edit sets one value, the driver decides what follows, and every value that
// moved is reported (the fix for Vico's silent rate/crew changes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, LobRefused, type LobModel, type LobSegment } from '../core/lob/model.ts';
import { edit, locationDurations, segmentDuration } from '../core/lob/edit.ts';

/** 2 parts × 3 floors; plaster: 1000 m² per floor, 0.5 h/m², one crew of 10 at 8 h (80 h a day): 6.25 days a floor. */
function plan(driver: LobSegment['driver'] = 'crew'): LobModel {
  const locations: LobModel['locations'] = [{ code: 'P1', name: 'Part 1', level: 1, parent: null }, { code: 'P2', name: 'Part 2', level: 1, parent: null }];
  for (const p of ['P1', 'P2']) for (const f of [1, 2, 3]) locations.push({ code: `${p}F${f}`, name: `Floor ${f}`, level: 2, parent: p });
  const order = ['P1F1', 'P1F2', 'P1F3', 'P2F1', 'P2F2', 'P2F3'];
  const m: LobModel = {
    version: 1, project: 'LOB', levels: ['Part', 'Floor'], locations, links: [],
    tasks: [{ code: 'PW', name: 'Plaster works', trade: 'Plasterers', precision: 2, order, items: [{ name: 'Plaster', unit: 'm2', consumption: 0.5, quantities: order.map((location) => ({ location, quantity: 1000 })) }], segments: [{ from: 'P1F1', to: 'P2F3', crews: 1, crewSize: 10, productivity: 1, driver: 'crew', timing: 'asap_paced' }] }],
  };
  if (driver !== 'crew') m.tasks[0].segments[0] = edit(m, { op: 'set_driver', task: 'PW', driver }).model.tasks[0].segments[0];
  return m;
}
const fields = (c: { field: string; location?: string; segment?: number }[]) => c.map((x) => `${x.field}${x.location ? `@${x.location}` : ''}`).sort();

test('durations: work ÷ crew-hours × factor; a model checks clean', () => {
  const m = plan();
  assert.deepEqual(check(m), []);
  const d = locationDurations(m, m.tasks[0]);
  assert.equal(d.get('P1F1'), 6.25);
  assert.equal(segmentDuration(m, m.tasks[0], 0), 37.5);
});

test('driver crew: a crew change moves the rate and every duration; a rate edit is refused', () => {
  const r = edit(plan(), { op: 'set_crew', task: 'PW', crew_size: 20 });
  assert.deepEqual(fields(r.changes), ['crew_size', 'duration', 'duration@P1F1', 'duration@P1F2', 'duration@P1F3', 'duration@P2F1', 'duration@P2F2', 'duration@P2F3', 'rate']);
  assert.equal(locationDurations(r.model, r.model.tasks[0]).get('P1F1'), 3.125);
  assert.throws(() => edit(plan(), { op: 'set_rate', task: 'PW', rate: 300 }), (e: Error) => e instanceof LobRefused && /the crew is held; change the driver or the crew/.test(e.message));
});

test('driver rate: a rate change moves the crew (whole people) and durations; a crew edit is refused with the rate wording', () => {
  const r = edit(plan('rate'), { op: 'set_rate', task: 'PW', rate: 330 });
  const s = r.model.tasks[0].segments[0];
  assert.equal(s.crewSize, 21, '330 m²/day × 0.5 h ÷ 8 h = 20.6, rounded up');
  assert.ok(fields(r.changes).includes('crew_size') && fields(r.changes).includes('rate'));
  assert.throws(() => edit(plan('rate'), { op: 'set_crew', task: 'PW', crew_size: 12 }), /the rate is held; change the driver or the rate/);
  assert.throws(() => edit(plan('rate'), { op: 'set_duration', task: 'PW', days: 20 }), /the rate is held/);
  // under the crew driver the crew is held too (L-9): a duration sizes the crew only when asked to
  assert.throws(() => edit(plan('crew'), { op: 'set_duration', task: 'PW', days: 20 }), /the crew is held; change the driver or the crew/);
  assert.equal(edit(plan('crew'), { op: 'set_duration', task: 'PW', days: 20, crew_follows: true }).model.tasks[0].segments[0].driver, 'crew');
});

test('driver duration: the crew follows, rounded up, and the reachable total is said', () => {
  const r = edit(plan('duration'), { op: 'set_duration', task: 'PW', days: 20 });
  const s = r.model.tasks[0].segments[0];
  assert.equal(s.crewSize, 19, '3000 h ÷ 8 h ÷ 20 days = 18.75 people');
  assert.match(r.note ?? '', /asked 20 days, got 19\.7/);
  assert.throws(() => edit(plan('duration'), { op: 'set_crew', task: 'PW', crew_size: 12 }), /the duration is held; change the driver or the duration/);
});

test('quantities: under crew only that location moves; under duration the crew follows and every location is reported', () => {
  const a = edit(plan(), { op: 'set_quantity', task: 'PW', location: 'P1F2', quantity: 2000 });
  assert.deepEqual(fields(a.changes), ['duration', 'duration@P1F2', 'quantity (Plaster)@P1F2']);
  const b = edit(plan('duration'), { op: 'set_quantity', task: 'PW', location: 'P1F2', quantity: 2000 });
  assert.ok(fields(b.changes).includes('crew_size'));
  assert.ok(['P1F1', 'P1F3', 'P2F1'].every((l) => fields(b.changes).includes(`duration@${l}`)), 'the other locations moved, and say so');
  const z = edit(plan(), { op: 'set_quantity', task: 'PW', location: 'P2F3', quantity: 0 });
  assert.equal(locationDurations(z.model, z.model.tasks[0]).has('P2F3'), false, 'no work, no activity');
});

test('a location duration sets its factor; a factor sets its duration; nothing else moves', () => {
  const a = edit(plan(), { op: 'set_location_duration', task: 'PW', location: 'P1F1', days: 9 });
  assert.deepEqual(fields(a.changes), ['duration', 'duration@P1F1', 'factor@P1F1']);
  const b = edit(plan(), { op: 'set_factor', task: 'PW', location: 'P2F1', factor: 0.8 });
  assert.deepEqual(fields(b.changes), ['duration', 'duration@P2F1', 'factor@P2F1']);
  assert.equal(locationDurations(b.model, b.model.tasks[0]).get('P2F1'), 5);
});

test('split at a floor: the floors above get their own crew; merge puts it back', () => {
  const s = edit(plan(), { op: 'split', task: 'PW', at: 'P2F1' }).model;
  assert.deepEqual(s.tasks[0].segments.map((x) => [x.from, x.to]), [['P1F1', 'P1F3'], ['P2F1', 'P2F3']]);
  assert.deepEqual(check(s), []);
  const faster = edit(s, { op: 'set_crew', task: 'PW', segment: 2, crew_size: 20 });
  assert.ok(faster.changes.every((c) => c.segment !== 1 && !['P1F1', 'P1F2', 'P1F3'].includes(c.location ?? '')), 'part 1 untouched');
  const merged = edit(s, { op: 'merge', task: 'PW', at: 'P2F1' }).model;
  assert.deepEqual(merged.tasks[0].segments.map((x) => [x.from, x.to]), [['P1F1', 'P2F3']]);
  assert.throws(() => edit(plan(), { op: 'split', task: 'PW', at: 'P1F1' }), /not one/);
});

test('check: a broken tree and segments that skip locations are named', () => {
  const m = plan();
  m.locations.push({ code: 'X', name: 'orphan', level: 2, parent: null });
  m.tasks[0].segments[0].from = 'P1F2';
  const p = check(m);
  assert.ok(p.some((x) => /X \(level 2\) needs a parent/.test(x)));
  assert.ok(p.some((x) => /does not follow on/.test(x)));
});
