// One edit on every activity a filter picks (P6's filter, select all, then Global Change / Assign / Delete / Link /
// Renumber): "select" on the one-activity operations, link_activities and renumber_activities, each one step whatever
// the number of activities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from '../core/project/ops.ts';
import { parseXer } from '../core/xer/parse.ts';
import { rows, type Db } from '../core/db.ts';
import { SAMPLES_DIR } from './helpers.ts';

const load = (): Db => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'CfC.xer')))).db;
const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const tasks = (db: Db) => rows(db, 'TASK').filter((t) => !rows(db, 'PROJECT').find((p) => p.proj_id === t.proj_id)?._baseline_of);

test('select: code, UDF, notebook and resource for every activity of a WBS branch in one operation each', () => {
  const db = load();
  const W = rows(db, 'PROJWBS'), byId = new Map(W.map((w) => [w.wbs_id, w]));
  // a top-level element with activities under it (its children included)
  const top = W.find((w) => byId.get(w.parent_wbs_id)?.proj_node_flag === 'Y' && tasks(db).some((t) => { for (let x = byId.get(t.wbs_id); x; x = byId.get(x.parent_wbs_id)) if (x === w) return true; return false; }))!;
  const under = new Set([top.wbs_id]);
  for (let grew = true; grew;) { grew = false; for (const w of W) if (under.has(w.parent_wbs_id) && !under.has(w.wbs_id)) { under.add(w.wbs_id); grew = true; } }
  const mine = tasks(db).filter((t) => under.has(t.wbs_id));
  assert.ok(mine.length > 1);
  const res = rows(db, 'RSRC')[0]?.rsrc_short_name ?? 'NEWRES';
  const r = ok(db, [
    { op: 'add_code_type', name: 'Area', values: [{ code: 'N' }, { code: 'S' }] },
    { op: 'add_udf', name: 'Package' },
    ...(rows(db, 'RSRC').length ? [] : [{ op: 'add_resource', id: 'NEWRES' }]),
    { op: 'assign_code', type: 'Area', value: 'N', select: { wbs: top.wbs_short_name } },
    { op: 'set_udf', udf: 'Package', value: 'P-01', select: { wbs: top.wbs_short_name } },
    { op: 'set_notebook', topic: 'Notes', text: 'Sub package P-01', select: { wbs: top.wbs_short_name } },
    { op: 'assign_resource', resource: res, allow_duplicate: true, select: { wbs: top.wbs_short_name, where: { task_type: { op: 'in', value: ['TT_Task', 'TT_Rsrc'] } } } },
  ]);
  const at = r.results.length - 4;
  assert.equal((r.results[at] as any).selected, mine.length);
  const code = rows(db, 'ACTVCODE').find((v) => v.short_name === 'N')!;
  assert.equal(new Set(rows(db, 'TASKACTV').filter((a) => a.actv_code_id === code.actv_code_id).map((a) => a.task_id)).size, mine.length);
  const udf = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Package')!;
  assert.equal(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === udf.udf_type_id && v.udf_text === 'P-01').length, mine.length);
  assert.ok((r.results[at + 3] as any).selected >= 1);

  // the picked activities found again by their code and UDF; exclude takes some back out
  const again = ok(db, [{ op: 'update_activity', priority: 'high', select: { code: { type: 'Area', value: 'N' }, udf: { udf: 'Package', value: 'P-01' }, exclude: { ids: [mine[0].task_code] } } }]);
  assert.equal((again.results[0] as any).selected, mine.length - 1);
  assert.equal(tasks(db).find((t) => t.task_code === mine[0].task_code)!.priority_type === 'PT_High', false);
  // uncoded activities: code empty
  const rest = ok(db, [{ op: 'assign_code', type: 'Area', value: 'S', select: { code: { type: 'Area', empty: true } } }]);
  assert.equal((rest.results[0] as any).selected, tasks(db).length - mine.length);
});

test('select: delete a selection in one pass; an empty selection changes nothing; refusals', () => {
  const db = load();
  const n = tasks(db).length;
  const type = tasks(db).find((t) => t.task_type !== 'TT_Task')!.task_type;
  const done = tasks(db).filter((t) => t.task_type === type).length;
  const r = ok(db, [{ op: 'delete_activity', select: { where: { task_type: type } } }]);
  assert.equal((r.results[0] as any).deleted, done);
  assert.equal(tasks(db).length, n - done);
  const none = ok(db, [{ op: 'update_activity', name: 'x', select: { where: { task_name: 'no such name at all' } } }]);
  assert.deepEqual(none.results[0], { selected: 0 });
  assert.match(none.warnings![0], /picked no activity/);
  const bad = (sel: unknown, op = 'update_activity') => applyOps(db, [{ op, name: 'x', select: sel }]).error!.message;
  assert.match(bad({ wbs: 'NOPE' }), /No WBS "NOPE"/);
  assert.match(bad({ ids: ['NOPE1'] }), /no activity NOPE1/);
  assert.match(bad({ where: { nofield: 1 } }), /no field "nofield"/);
  assert.match(bad({ colour: 'red' }), /unknown colour/);
  assert.match(bad({}, 'add_relationship'), /select works with/);
  assert.match(applyOps(db, [{ op: 'update_activity', id: tasks(db)[0].task_code, select: {} }]).error!.message, /not both/);
});

test('link_activities: a chain in start order, existing links skipped, one undo; renumber_activities', () => {
  const db = load();
  const ids = ['L1', 'L2', 'L3', 'L4'];
  ok(db, [{ op: 'add_wbs', code: 'NEWW' }, ...ids.map((id, i) => ({ op: 'add_activity', id, name: `New ${i}`, wbs: 'NEWW', duration_days: 2 }))]);
  const before = rows(db, 'TASKPRED').length;
  const l = ok(db, [{ op: 'add_relationship', pred: 'L1', succ: 'L2' }, { op: 'link_activities', select: { wbs: 'NEWW' }, order_by: 'id' }]);
  assert.deepEqual(l.results[1], { selected: 4, linked: 2, skipped: 1 });
  assert.equal(rows(db, 'TASKPRED').length, before + 3);
  const code = (id: string) => tasks(db).find((t) => t.task_code === id)!.task_id;
  assert.ok(rows(db, 'TASKPRED').some((p) => p.pred_task_id === code('L3') && p.task_id === code('L4')));
  // listed order, SS with lag
  ok(db, [{ op: 'add_activity', id: 'L5', name: 'L5', wbs: 'NEWW' }, { op: 'add_activity', id: 'L6', name: 'L6', wbs: 'NEWW' }, { op: 'link_activities', select: { ids: ['L6', 'L5'] }, type: 'SS', lag_days: 1 }]);
  assert.ok(rows(db, 'TASKPRED').some((p) => p.pred_task_id === code('L6') && p.task_id === code('L5') && p.pred_type === 'PR_SS'));
  // a chain that closes a loop is refused like add_relationship
  assert.match(applyOps(db, [{ op: 'link_activities', select: { ids: ['L4', 'L1'] } }]).error!.message, /loop/);
  ok(db, [{ op: 'delete_activity', select: { ids: ['L5', 'L6'] } }]);

  const rn = ok(db, [{ op: 'renumber_activities', select: { wbs: 'NEWW' }, prefix: 'Z-', start: 10, increment: 5 }]);
  assert.deepEqual(rn.results[0], { selected: 4, renumbered: 4, first: 'Z-10', last: 'Z-25' });
  assert.deepEqual(tasks(db).filter((t) => t.task_code.startsWith('Z-')).map((t) => t.task_code).sort(), ['Z-10', 'Z-15', 'Z-20', 'Z-25']);
  // a new ID another activity keeps: refused, nothing changed
  ok(db, [{ op: 'add_activity', id: 'Q100', name: 'Kept', wbs: 'NEWW' }]);
  const c = applyOps(db, [{ op: 'renumber_activities', select: { ids: ['Z-10', 'Z-15'] }, prefix: 'Q', start: 95, increment: 5 }]);
  assert.equal(c.ok, false);
  assert.match(c.error!.message, /IDs other activities keep: Q100 \(kept by Kept\)/);
  assert.ok(tasks(db).some((t) => t.task_code === 'Z-10'), 'nothing changed');
  // the selection's own IDs may be reused among themselves (a shift of the same activities)
  ok(db, [{ op: 'renumber_activities', select: { wbs: 'NEWW', exclude: { ids: ['Q100'] } }, prefix: 'Z-', start: 15, increment: 5 }]);
  assert.deepEqual(tasks(db).filter((t) => t.task_code.startsWith('Z-')).map((t) => t.task_code).sort(), ['Z-15', 'Z-20', 'Z-25', 'Z-30']);
});
