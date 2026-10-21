// Continuity: a paced trade's crew never waits between locations; its last location stays where F9 put it; the moves
// are start-on-or-after constraints, so the XER alone (as real P6 reads it) schedules to the same dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { parseP6Date } from '../core/dates.ts';
import { calendarResolver, scheduleProjects } from '../core/schedule/cpm.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { expandLob } from '../core/lob/expand.ts';
import { scheduleLob } from '../core/lob/pace.ts';
import type { LobModel, LobTask, Timing } from '../core/lob/model.ts';

const floors = ['F1', 'F2', 'F3', 'F4', 'F5'];
const task = (code: string, crewSize: number, timing: Timing): LobTask => ({ code, name: code, trade: code, precision: 1, order: [...floors], items: [{ name: code, unit: 'm2', consumption: 0.5, quantities: floors.map((location) => ({ location, quantity: 1000 })) }], segments: [{ from: 'F1', to: 'F5', crews: 1, crewSize, productivity: 1, driver: 'crew', timing }] });
function build(timing: Timing): { db: Db; pid: string; m: LobModel } {
  const db: Db = { tables: {} };
  applyOps(db, [{ op: 'add_project', id: 'LOB', start: '2026-03-02' }]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  // concrete: 6.25 days a floor; plaster, twice the crew: 3.125 days a floor, after the concrete of its floor
  const m: LobModel = { version: 1, project: 'LOB', levels: ['Floor'], locations: floors.map((code) => ({ code, name: code, level: 1, parent: null })), tasks: [task('CS', 10, 'asap'), task('PW', 20, timing)], links: [{ kind: 'task', pred: 'CS', succ: 'PW', type: 'FS', lagDays: 0 }] };
  assert.equal(expandLob(db, pid, m, { hoursPerDay: 8 }).ok, true);
  return { db, pid, m };
}
const dates = (db: Db, code: string) => { const t = rows(db, 'TASK').find((x) => x.task_code === code)!; return [parseP6Date(t.early_start_date)!, parseP6Date(t.early_end_date)!]; };

test('a fast trade behind a slow one: paced, its crew never waits, and it ends where it would have', () => {
  const asap = build('asap');
  assert.equal(scheduleLob(asap.db, [asap.pid], new Map([[asap.pid, asap.m]]), { hoursPerDay: 8 }).ok, true);
  const cal = calendarResolver(asap.db, []).fallback(rows(asap.db, 'PROJECT')[0].clndr_id);
  const gap = (db: Db, k: number) => cal.workBetween(dates(db, `PW-F${k}`)[1], dates(db, `PW-F${k + 1}`)[0]);
  assert.ok(gap(asap.db, 1) > 0, 'unpaced: the plasterers wait for the concrete');
  const p = build('asap_paced');
  const r = scheduleLob(p.db, [p.pid], new Map([[p.pid, p.m]]), { hoursPerDay: 8 });
  assert.equal(r.ok, true, r.error ?? '');
  assert.deepEqual(r.unpaced, []);
  for (const k of [1, 2, 3, 4]) assert.equal(gap(p.db, k), 0, `no wait between floor ${k} and ${k + 1}`);
  assert.equal(dates(p.db, 'PW-F5')[1], dates(asap.db, 'PW-F5')[1], 'the last floor finishes as it would have');
  assert.ok(dates(p.db, 'PW-F1')[0] > dates(asap.db, 'PW-F1')[0], 'the first floor starts later');
  assert.ok(rows(p.db, 'TASK').filter((t) => t.task_code.startsWith('PW-') && t.cstr_type === 'CS_MSOA').length >= 4);
  // back to ASAP: the constraints continuity wrote are taken away
  p.m.tasks[1].segments[0].timing = 'asap';
  scheduleLob(p.db, [p.pid], new Map([[p.pid, p.m]]), { hoursPerDay: 8 });
  assert.equal(rows(p.db, 'TASK').filter((t) => t.cstr_type === 'CS_MSOA').length, 0);
});

test('the exported XER alone (no LOB model, as real P6 reads it) schedules to the same early dates', () => {
  const p = build('asap_paced');
  scheduleLob(p.db, [p.pid], new Map([[p.pid, p.m]]), { hoursPerDay: 8 });
  const back = parseXer(writeXer(p.db, { version: '19.12' })).db;
  const pid2 = rows(back, 'PROJECT')[0].proj_id;
  assert.equal(scheduleProjects(back, [pid2], {}).ok, true);
  for (const t of rows(p.db, 'TASK')) {
    const u = rows(back, 'TASK').find((x) => x.task_code === t.task_code)!;
    assert.equal(u.early_start_date, t.early_start_date, `${t.task_code} start`);
    assert.equal(u.early_end_date, t.early_end_date, `${t.task_code} finish`);
  }
});

test('continuity that fights the logic yields after 20 passes and names the trade', () => {
  const db: Db = { tables: {} };
  applyOps(db, [{ op: 'add_project', id: 'LOB', start: '2026-03-02' }]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  const three = ['L1', 'L2', 'L3'];
  // A's third location waits for B, which waits for A's second: pacing A pushes its second location later, which
  // pushes B, which pushes the third, for ever
  const A: LobTask = { ...task('A', 10, 'asap_paced'), order: three, items: [{ name: 'A', unit: 'm2', consumption: 0.5, quantities: three.map((location) => ({ location, quantity: 1000 })) }], segments: [{ from: 'L1', to: 'L3', crews: 1, crewSize: 10, productivity: 1, driver: 'crew', timing: 'asap_paced' }] };
  const B: LobTask = { ...task('B', 10, 'asap'), order: ['L1'], items: [{ name: 'B', unit: 'm2', consumption: 0.5, quantities: [{ location: 'L1', quantity: 1000 }] }], segments: [{ from: 'L1', to: 'L1', crews: 1, crewSize: 10, productivity: 1, driver: 'crew', timing: 'asap' }] };
  const m: LobModel = { version: 1, project: 'LOB', levels: ['Zone'], locations: three.map((code) => ({ code, name: code, level: 1, parent: null })), tasks: [A, B], links: [{ kind: 'location', pred: 'A', succ: 'B', predLocation: 'L2', succLocation: 'L1', type: 'FS', lagDays: 0 }, { kind: 'location', pred: 'B', succ: 'A', predLocation: 'L1', succLocation: 'L3', type: 'FS', lagDays: 0 }] };
  assert.equal(expandLob(db, pid, m, { hoursPerDay: 8 }).ok, true);
  const r = scheduleLob(db, [pid], new Map([[pid, m]]), { hoursPerDay: 8 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unpaced, ['A']);
});
