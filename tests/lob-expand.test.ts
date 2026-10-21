// The LOB model as P6 data: an activity per task × location with work, the five logic layers as relationships, the
// Location and Trade codes, and IDs that never move when locations are inserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { expandLob } from '../core/lob/expand.ts';
import type { LobModel, LobTask } from '../core/lob/model.ts';

const order = ['P1F1', 'P1F2', 'P1F3', 'P2F1', 'P2F2', 'P2F3'];
const task = (code: string, name: string, trade: string, perFloor = 1000): LobTask => ({ code, name, trade, precision: 2, order: [...order], items: [{ name, unit: 'm2', consumption: 0.5, quantities: order.map((location) => ({ location, quantity: perFloor })) }], segments: [{ from: 'P1F1', to: 'P2F3', crews: 1, crewSize: 10, productivity: 1, driver: 'crew', timing: 'asap' }] });
function model(): LobModel {
  const locations: LobModel['locations'] = [{ code: 'P1', name: 'Part 1', level: 1, parent: null }, { code: 'P2', name: 'Part 2', level: 1, parent: null }];
  for (const p of ['P1', 'P2']) for (const f of [1, 2, 3]) locations.push({ code: `${p}F${f}`, name: `Floor ${f}`, level: 2, parent: p });
  return { version: 1, project: 'LOB', levels: ['Part', 'Floor'], locations, tasks: [task('CS', 'Concrete skeleton', 'Concrete'), task('PW', 'Plaster works', 'Plasterers')], links: [{ kind: 'task', pred: 'CS', succ: 'PW', type: 'FS', lagDays: 0, locationLag: 1 }] };
}
function project(): { db: Db; pid: string } {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'LOB', start: '2026-03-02' }]).ok, true);
  return { db, pid: rows(db, 'PROJECT')[0].proj_id };
}
const rels = (db: Db) => { const id = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.task_code])); return rows(db, 'TASKPRED').map((r) => `${id.get(r.pred_task_id)}>${id.get(r.task_id)}`).sort(); };

test('an activity per task × location, codes and UDFs, logic layers 1, 3 and 4', () => {
  const { db, pid } = project();
  const r = expandLob(db, pid, model(), { hoursPerDay: 8 });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.added, 12);
  const codes = rows(db, 'TASK').map((t) => t.task_code).sort();
  assert.deepEqual(codes, ['CS-P1F1', 'CS-P1F2', 'CS-P1F3', 'CS-P2F1', 'CS-P2F2', 'CS-P2F3', 'PW-P1F1', 'PW-P1F2', 'PW-P1F3', 'PW-P2F1', 'PW-P2F2', 'PW-P2F3']);
  assert.equal(rows(db, 'TASK').find((t) => t.task_code === 'PW-P2F3')!.task_name, 'Plaster works, Part 2, Floor 3');
  const R = rels(db);
  for (const x of ['CS-P1F1>CS-P1F2', 'CS-P1F3>CS-P2F1', 'PW-P2F2>PW-P2F3']) assert.ok(R.includes(x), `within a task: ${x}`);
  // location lag +1 (L-4): plaster on a floor waits until the concrete of the floor above it is done; the top floor
  // waits for the concrete's last floor
  assert.ok(R.includes('CS-P1F2>PW-P1F1') && R.includes('CS-P1F3>PW-P1F2') && R.includes('CS-P1F3>PW-P1F3') && !R.includes('CS-P1F1>PW-P1F1'), R.join(' '));
  assert.ok(!R.some((x) => /^CS-P1F1>PW/.test(x)), 'the first floor of concrete holds no plaster floor up by itself');
  const lt = rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === 'Location')!;
  const vals = rows(db, 'ACTVCODE').filter((v) => v.actv_code_type_id === lt.actv_code_type_id);
  const p1 = vals.find((v) => v.short_name === 'P1')!;
  assert.equal(String(vals.find((v) => v.short_name === 'P1F2')!.parent_actv_code_id), String(p1.actv_code_id), 'the Location code is a hierarchy');
  assert.ok(rows(db, 'UDFTYPE').some((u) => u.udf_type_label === 'LOB Quantity'));
});

test('a second expansion changes nothing; a new floor adds its activities and keeps every ID; zero work drops one', () => {
  const { db, pid } = project();
  const m = model();
  expandLob(db, pid, m, { hoursPerDay: 8 });
  const again = expandLob(db, pid, m, { hoursPerDay: 8 });
  assert.deepEqual([again.added, again.updated, again.deleted, again.relationships.added, again.relationships.deleted], [0, 0, 0, 0, 0]);
  const before = new Map(rows(db, 'TASK').map((t) => [t.task_code, t.task_id]));
  m.locations.push({ code: 'P1F4', name: 'Floor 4', level: 2, parent: 'P1' });
  for (const t of m.tasks) { t.order.splice(3, 0, 'P1F4'); t.items[0].quantities.push({ location: 'P1F4', quantity: 1000 }); }
  m.tasks[1].items[0].quantities.find((q) => q.location === 'P2F2')!.quantity = 0;
  const r = expandLob(db, pid, m, { hoursPerDay: 8 });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.added, 2);
  assert.equal(r.deleted, 1);
  for (const [code, id] of before) if (code !== 'PW-P2F2') assert.equal(String(rows(db, 'TASK').find((t) => t.task_code === code)!.task_id), String(id), `${code} kept its id`);
  const R = rels(db);
  assert.ok(R.includes('PW-P2F1>PW-P2F3'), 'logic passes through the location with no work');
  assert.ok(R.includes('CS-P1F3>CS-P1F4') && R.includes('CS-P1F4>CS-P2F1'));
});

test('a link to a CPM project: its milestone drives the first location; relationships a user added are left alone', () => {
  const { db, pid } = project();
  applyOps(db, [{ op: 'add_project', id: 'DES', start: '2026-03-02' }, { op: 'add_activity', id: 'M1', name: 'Steel delivered', type: 'finish_milestone', project: 'DES' }]);
  const m = model();
  m.links.push({ kind: 'task', pred: 'M1', succ: 'CS', type: 'FS', lagDays: 2, project: 'DES' });
  expandLob(db, pid, m, { hoursPerDay: 8 });
  applyOps(db, [{ op: 'add_activity', id: 'X', name: 'Handover', project: 'LOB' }, { op: 'add_relationship', pred: 'PW-P2F3', succ: 'X', project: 'LOB' }]);
  assert.ok(rels(db).includes('M1>CS-P1F1'));
  const previous = structuredClone(m);
  m.links.pop();
  const r = expandLob(db, pid, m, { hoursPerDay: 8, previous });
  assert.equal(r.relationships.deleted, 1);
  assert.ok(!rels(db).includes('M1>CS-P1F1'));
  assert.ok(rels(db).includes('PW-P2F3>X'), 'a relationship the user added stays');
});
