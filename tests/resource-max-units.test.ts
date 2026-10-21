// update_resource sets a resource's Max Units / Time (per hour or per day), on every rate row it has, so the platform can
// cap resources on a scratch copy before level_resources and optimize_schedule; add_resource takes the same two forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { levelResources } from '../core/level/level.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); return r; };
const pid = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
const caps = (db: Db, id: string) => { const rid = rows(db, 'RSRC').find((r) => r.rsrc_short_name === id)!.rsrc_id; return rows(db, 'RSRCRATE').filter((x) => x.rsrc_id === rid).map((x) => Number(x.max_qty_per_hr)); };

function build(): Db {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'R', start: '2026-03-02' },
    { op: 'add_resource', id: 'CREW', max_units_per_day: 8 },
    { op: 'add_resource', id: 'CRANE', type: 'nonlabor', max_units_per_hour: 2 },
    { op: 'add_activity', id: 'A', name: 'Pour A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'Pour B', duration_days: 5 },
    { op: 'assign_resource', activity: 'A', resource: 'CREW', units_per_day: 8 }, { op: 'assign_resource', activity: 'B', resource: 'CREW', units_per_day: 8 },
  ]);
  return db;
}
const delayed = (db: Db) => { assert.ok(scheduleProjects(db, [pid(db)]).ok); return levelResources(db, [pid(db)], {}).delayed; };

test('add_resource takes max units per day or per hour; update_resource changes them on every rate row', () => {
  const db = build();
  assert.deepEqual([caps(db, 'CREW'), caps(db, 'CRANE')], [[1], [2]], '8 per day over 8 h = 1 per hour');
  const r = ok(db, [{ op: 'update_resource', id: 'CRANE', max_units_per_day: 24 }]);
  assert.deepEqual(r.results[0], { resource: 'CRANE', max_units_per_hour: 3, max_units_per_day: 24 });
  assert.deepEqual(caps(db, 'CRANE'), [3]);
  // a resource with several rate rows (one per effective date): the cap goes on each
  const rid = rows(db, 'RSRC').find((x) => x.rsrc_short_name === 'CRANE')!.rsrc_id;
  rows(db, 'RSRCRATE').push({ rsrc_rate_id: '999', rsrc_id: rid, max_qty_per_hr: '5', cost_per_qty: '10', start_date: '2026-06-01 00:00' });
  ok(db, [{ op: 'update_resource', id: 'CRANE', max_units_per_hour: 1.5 }]);
  assert.deepEqual(caps(db, 'CRANE'), [1.5, 1.5]);
  assert.equal(rows(db, 'RSRCRATE').find((x) => x.rsrc_rate_id === '999')!.cost_per_qty, '10', 'its price is left alone');
  // a resource without a rate row gets one
  rows(db, 'RSRCRATE').splice(0, rows(db, 'RSRCRATE').length, ...rows(db, 'RSRCRATE').filter((x) => x.rsrc_id !== rid));
  ok(db, [{ op: 'update_resource', id: 'CRANE', max_units_per_hour: 4 }]);
  assert.deepEqual(caps(db, 'CRANE'), [4]);
  for (const bad of [{ max_units_per_hour: 1, max_units_per_day: 8 }, { max_units_per_day: 0 }, { max_units_per_hour: -1 }]) {
    const x = applyOps(db, [{ op: 'update_resource', id: 'CRANE', ...bad }]);
    assert.equal(x.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(caps(db, 'CRANE'), [4], 'a refused edit changes nothing');
});

test('the cap set by update_resource is the one leveling works to', () => {
  const db = build();
  assert.equal(delayed(db), 1, 'two crews of 8/day against a cap of 8/day: one waits');
  ok(db, [{ op: 'update_resource', id: 'CREW', max_units_per_day: 16 }]);
  assert.equal(delayed(db), 0, 'raised to 16/day: both run together');
  ok(db, [{ op: 'update_resource', id: 'CREW', max_units_per_hour: 1 }]);
  assert.equal(delayed(db), 1, 'back to 1/hour');
});
