// The LOB model in the XER: a project UDF flag and a notebook real P6 keeps, read back whole, split when long, detected
// when altered, and rebuilt from the activities (or the sidecar) when damaged; differences made outside are listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { expandLob } from '../core/lob/expand.ts';
import { isLobProject, loadLobModels, LOB_TOPIC, reconcile, saveLobModel } from '../core/lob/store.ts';
import type { LobModel } from '../core/lob/model.ts';

function model(floors = 3): LobModel {
  const locations: LobModel['locations'] = [{ code: 'P1', name: 'Part 1', level: 1, parent: null }];
  for (let f = 1; f <= floors; f++) locations.push({ code: `P1F${f}`, name: `Floor ${f}`, level: 2, parent: 'P1' });
  const order = locations.filter((l) => l.level === 2).map((l) => l.code);
  return { version: 1, project: 'LOB', levels: ['Part', 'Floor'], locations, links: [], tasks: [{ code: 'PW', name: 'Plaster works', trade: 'Plasterers', precision: 2, order, items: [{ name: 'Plaster', unit: 'm2', consumption: 0.5, quantities: order.map((location) => ({ location, quantity: 1000 })) }], segments: [{ from: order[0], to: order.at(-1)!, crews: 1, crewSize: 10, productivity: 1, driver: 'crew', timing: 'asap_paced' }] }] };
}
function saved(m = model()): { db: Db; pid: string } {
  const db: Db = { tables: {} };
  applyOps(db, [{ op: 'add_project', id: 'LOB', start: '2026-03-02' }, { op: 'add_project', id: 'DES', start: '2026-03-02' }]);
  const pid = rows(db, 'PROJECT').find((p) => p.proj_short_name === 'LOB')!.proj_id;
  expandLob(db, pid, m, { hoursPerDay: 8 });
  saveLobModel(db, pid, m, { hoursPerDay: 8 });
  return { db, pid };
}
const roundTrip = (db: Db) => parseXer(writeXer(db, { version: '19.12' })).db;
const lobId = (db: Db) => rows(db, 'PROJECT').find((p) => p.proj_short_name === 'LOB')!.proj_id;
const memo = (db: Db) => rows(db, 'WBSMEMO').find((w) => rows(db, 'MEMOTYPE').find((t) => t.memo_type_id === w.memo_type_id)?.memo_type.startsWith(LOB_TOPIC))!;

test('through an XER: the flag marks the LOB project only, and the model comes back whole', () => {
  const back = roundTrip(saved().db);
  assert.equal(isLobProject(back, lobId(back)), true);
  assert.equal(isLobProject(back, rows(back, 'PROJECT').find((p) => p.proj_short_name === 'DES')!.proj_id), false, 'the CPM project is an ordinary project');
  const got = loadLobModels(back).get(lobId(back))!;
  assert.equal(got.from, 'notebook');
  assert.deepEqual(got.model, model());
});

test('a notebook P6 rewrote as HTML (wrapped, entities) still reads', () => {
  const { db } = saved();
  const m = memo(db);
  m.wbs_memo = `<html><head></head><body><p style="x">${m.wbs_memo.replace(/<[^>]*>/g, '').replace(/ /g, '&nbsp;')}</p></body></html>`;
  assert.deepEqual(loadLobModels(db).get(lobId(db))!.model, model());
});

test('a long model is split into numbered topics and read back', () => {
  const big = model(400);
  const { db } = saved(big);
  const topics = rows(db, 'MEMOTYPE').map((t) => t.memo_type).filter((t) => t.startsWith(LOB_TOPIC));
  assert.ok(topics.length > 1 && topics.every((t) => / \d+\/\d+$/.test(t)), topics.join(', '));
  assert.deepEqual(loadLobModels(roundTrip(db)).get(lobId(db))!.model, big);
});

test('an altered notebook is detected; the sidecar is used, else the model is rebuilt from the activities and says what is lost', () => {
  const { db } = saved();
  const m = memo(db);
  // one character of the data changed, as an editor in P6 might
  const at = m.wbs_memo.indexOf('P6CLONE-LOB') + 120;
  m.wbs_memo = m.wbs_memo.slice(0, at) + (m.wbs_memo[at] === 'A' ? 'B' : 'A') + m.wbs_memo.slice(at + 1);
  const side = loadLobModels(db, { LOB: model() }).get(lobId(db))!;
  assert.equal(side.from, 'sidecar');
  assert.match(side.problems[0], /checksum does not match/);
  const rb = loadLobModels(db).get(lobId(db))!;
  assert.equal(rb.from, 'activities');
  assert.match(rb.problems[0], /rebuilt from the activities, without links between trades/);
  assert.deepEqual(rb.model.tasks.map((t) => [t.code, t.order]), [['PW', ['P1F1', 'P1F2', 'P1F3']]]);
  assert.deepEqual(rb.model.locations.map((l) => [l.code, l.level, l.parent]), [['P1', 1, null], ['P1F1', 2, 'P1'], ['P1F2', 2, 'P1'], ['P1F3', 2, 'P1']]);
  assert.equal(rb.model.tasks[0].items[0].quantities[0].quantity, 1000);
  assert.equal(rb.model.tasks[0].segments[0].crewSize, 10);
});

test('reconcile lists what changed outside the clone', () => {
  const { db, pid } = saved();
  applyOps(db, [{ op: 'delete_activity', id: 'PW-P1F2', project: 'LOB' }, { op: 'update_activity', id: 'PW-P1F3', project: 'LOB', duration_days: 9 }, { op: 'add_activity', id: 'PW-P1F9', name: 'extra', project: 'LOB' }, { op: 'set_udf', udf: 'LOB Task', value: 'PW', activity: 'PW-P1F9', project: 'LOB' }]);
  const r = reconcile(db, pid, model(), { hoursPerDay: 8 });
  assert.ok(r.some((x) => /PW-P1F2 is in the LOB plan but not in the file/.test(x)));
  assert.ok(r.some((x) => /PW-P1F3 lasts 9 days in the file, 6\.25 in the LOB plan/.test(x)));
  assert.ok(r.some((x) => /PW-P1F9 carries the LOB task PW but is not in the LOB plan/.test(x)));
});
