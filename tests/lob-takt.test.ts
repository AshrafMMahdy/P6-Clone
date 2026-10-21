// Takt (check, apply) and control (forecast from production, alarms ranked by time to react, buffers absorbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { expandLob } from '../core/lob/expand.ts';
import { scheduleLob } from '../core/lob/pace.ts';
import { locationDurations } from '../core/lob/edit.ts';
import { taktApply, taktCheck } from '../core/lob/takt.ts';
import { forecastLob } from '../core/lob/forecast.ts';
import type { LobModel, LobTask } from '../core/lob/model.ts';

const floors = ['F1', 'F2', 'F3', 'F4'];
const trade = (code: string, perFloor: number[], crewSize: number): LobTask => ({ code, name: code, trade: code, precision: 1, order: [...floors], items: [{ name: code, unit: 'm2', consumption: 0.5, quantities: floors.map((location, k) => ({ location, quantity: perFloor[k] })) }], segments: [{ from: 'F1', to: 'F4', crews: 1, crewSize, productivity: 1, driver: 'crew', timing: 'asap' }] });
// drywall: 5 days a floor, but floor 3 is twice the work; paint: 2.5 days a floor
const model = (): LobModel => ({ version: 1, project: 'LOB', levels: ['Floor'], locations: floors.map((code) => ({ code, name: code, level: 1, parent: null })), tasks: [trade('DW', [800, 800, 1600, 800], 10), trade('PT', [400, 400, 400, 400], 10)], links: [], takt: { taktDays: 5, train: ['DW', 'PT'], bufferPeriods: 1 } });

test('takt check names the trade × zone that does not fit, and the fix', () => {
  const c = taktCheck(model());
  assert.equal(c.fits, false);
  assert.deepEqual(c.misfits.map((x) => [x.task, x.zone, x.days]), [['DW', 'F3', 10]]);
  assert.match(c.misfits[0].fix, /crew 10 → 20 people, or split F3/);
});

test('takt apply: crews sized to fit, every zone exactly one takt period, paced, linked as a train with the buffer', () => {
  const r = taktApply(model());
  const m = r.model;
  assert.equal(taktCheck(m).fits, true);
  for (const t of m.tasks) { const d = locationDurations(m, t); for (const f of floors) assert.ok(Math.abs(d.get(f)! - 5) < 1e-9, `${t.code} ${f}: ${d.get(f)}`); assert.equal(t.segments[0].timing, 'paced'); }
  assert.equal(m.tasks[0].segments[0].crewSize, 20);
  assert.deepEqual(m.links.map((l) => [l.pred, l.succ, l.type, l.lagDays]), [['DW', 'PT', 'FS', 5]]);
  assert.ok(r.changes.some((c) => c.task === 'DW' && c.field === 'crew_size' && c.old === 10 && c.new === 20));
  assert.ok(r.changes.some((c) => c.task === 'PT' && c.field === 'factor'), 'paint stretched to the takt, and said so');
});

function scheduled(): { db: Db; pid: string; m: LobModel } {
  const db: Db = { tables: {} };
  applyOps(db, [{ op: 'add_project', id: 'LOB', start: '2026-03-02' }]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  const m = model();
  m.tasks[0].items[0].quantities.forEach((q) => (q.quantity = 800));
  m.links = [{ kind: 'task', pred: 'DW', succ: 'PT', type: 'FS', lagDays: 0, bufferDays: 5 }];
  expandLob(db, pid, m, { hoursPerDay: 8 });
  scheduleLob(db, [pid], new Map([[pid, m]]), { hoursPerDay: 8 });
  return { db, pid, m };
}

test('forecast: drywall ran at twice its planned time, so its forecast slips and paint is warned, nearest first', () => {
  const { db, pid, m } = scheduled();
  // floors 1 and 2 of drywall took 10 days each instead of 5; the data date is when floor 2 finished
  const ops = [{ op: 'update_activity', id: 'DW-F1', project: 'LOB', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-13 17:00' }, { op: 'update_activity', id: 'DW-F2', project: 'LOB', actual_start: '2026-03-16 08:00', actual_finish: '2026-03-27 17:00' }];
  assert.equal(applyOps(db, ops, { hoursPerDay: 8 }).ok, true);
  rows(db, 'PROJECT')[0].last_recalc_date = '2026-03-30 08:00';
  const f = forecastLob(db, pid, m, { hoursPerDay: 8 });
  assert.equal(f.rates.DW, 2);
  assert.equal(f.forecast.DW[2][1].slice(0, 10), '2026-04-10', 'floor 3: 10 working days from the data date');
  assert.ok(f.alarms.length >= 2 && f.alarms.every((a) => a.pred === 'DW' && a.succ === 'PT'));
  // floor 2: painting was planned to start before the drywall finished (overdue, so first); then floors 3 and 4
  assert.deepEqual(f.alarms.map((a) => a.location), ['F2', 'F3', 'F4'], 'nearest first');
  assert.ok(f.alarms[0].daysToReact <= 0 && f.alarms[0].daysToReact <= f.alarms[1].daysToReact && f.alarms[1].daysToReact <= f.alarms[2].daysToReact);
});

test('forecast: a predecessor late within the buffer raises no alarm (the buffer is absorbed)', () => {
  const { db, pid, m } = scheduled();
  // floor 1 took 7 days instead of 5: two days of the five-day buffer used
  applyOps(db, [{ op: 'update_activity', id: 'DW-F1', project: 'LOB', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-10 17:00' }], { hoursPerDay: 8 });
  rows(db, 'PROJECT')[0].last_recalc_date = '2026-03-11 08:00';
  const f = forecastLob(db, pid, m, { hoursPerDay: 8, windowDays: 21 });
  assert.equal(f.rates.DW, 1.4);
  assert.equal(f.alarms.filter((a) => a.location === 'F2').length, 0);
});
