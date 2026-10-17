import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addActivity, addRelationship, checkRelationship, deleteActivities, newProject, nextTaskCode, setActual, setPercent, fmtDate, fmtDur, COLUMN_BY_ID, makeCtx } from '../renderer/model.ts';
import { emptyDb } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';

const prefs = { hoursPerDay: 8, dateFormat: 'dd-MMM-yy' as const, showTime: false, durationDecimals: 0 };

test('new project from scratch schedules and exports a valid XER', () => {
  const db = emptyDb();
  const pid = newProject(db, { id: 'DEMO', name: 'Demo Project', start: '2024-01-08 08:00' });
  const root = db.tables.PROJWBS.rows[0].wbs_id;
  const a = addActivity(db, pid, root), b = addActivity(db, pid, root);
  assert.equal(a.task_code, 'A1000');
  assert.equal(b.task_code, 'A1010');
  assert.equal(addRelationship(db, a.task_id, b.task_id), undefined);
  assert.match(String(checkRelationship(db, b.task_id, a.task_id)), /loop/);
  assert.match(String(checkRelationship(db, a.task_id, b.task_id)), /exists/);
  const r = scheduleProjects(db, [pid]);
  assert.ok(r.ok);
  assert.equal(b.early_start_date, '2024-01-15 08:00');
  const back = parseXer(writeXer(db, { version: '19.12' }));
  const errs = validateXer(back.db, back.findings).filter((f) => f.severity === 'error' || f.severity === 'fatal');
  assert.deepEqual(errs.map((e) => e.message), []);
  deleteActivities(db, [a.task_id]);
  assert.equal(db.tables.TASKPRED.rows.length, 0);
  assert.equal(nextTaskCode(db, pid), 'A1020');
});

test('status edits follow P6 rules', () => {
  const r: Record<string, string> = { target_drtn_hr_cnt: '40', remain_drtn_hr_cnt: '40', act_start_date: '', act_end_date: '', complete_pct_type: 'CP_Drtn' };
  assert.match(String(setPercent(r, 50)), /started/);
  assert.match(String(setActual(r, 'finish', '2024-01-10 16:00')), /actual start first/);
  assert.equal(setActual(r, 'start', '2024-01-08 08:00'), undefined);
  assert.equal(setPercent(r, 25), undefined);
  assert.equal(r.remain_drtn_hr_cnt, '30');
  assert.match(String(setActual(r, 'finish', '2024-01-01 08:00')), /on or after/);
  assert.equal(setActual(r, 'finish', '2024-01-12 16:00'), undefined);
  assert.equal(r.remain_drtn_hr_cnt, '0');
  assert.equal(r.status_code, 'TK_Complete');
});

test('formatting and column getters', () => {
  assert.equal(fmtDate('2014-08-16 08:00', prefs), '16-Aug-14');
  assert.equal(fmtDur('40', prefs), '5');
  const db = emptyDb();
  const pid = newProject(db, { id: 'X', name: 'X', start: '2024-01-08 08:00' });
  const t = addActivity(db, pid, db.tables.PROJWBS.rows[0].wbs_id);
  t.act_start_date = '2024-01-08 08:00';
  const ctx = makeCtx(db, prefs);
  assert.equal(COLUMN_BY_ID.get('start')!.get(t, ctx), '08-Jan-24 A');
  assert.equal(COLUMN_BY_ID.get('orig_dur')!.get(t, ctx), '5');
  const copy = { ...t };
  assert.match(String(COLUMN_BY_ID.get('task_code')!.edit!.set(db, copy, '', ctx)), /blank/);
});

test('user filters and database columns (activity codes, UDFs)', async () => {
  const { buildActivityRows } = await import('../renderer/views/activityRows.ts');
  const { extraColumns, setColumnDb } = await import('../renderer/model.ts');
  const { table } = await import('../core/db.ts');
  const db = emptyDb();
  setColumnDb(() => db);
  const pid = newProject(db, { id: 'F', name: 'Filters', start: '2024-01-08 08:00' });
  const root = db.tables.PROJWBS.rows[0].wbs_id;
  const [a, b, c] = [addActivity(db, pid, root), addActivity(db, pid, root), addActivity(db, pid, root)];
  a.target_drtn_hr_cnt = a.remain_drtn_hr_cnt = '16'; b.target_drtn_hr_cnt = b.remain_drtn_hr_cnt = '80'; c.task_name = 'Pour slab';
  addRelationship(db, a.task_id, b.task_id);
  scheduleProjects(db, [pid]);
  table(db, 'ACTVTYPE').rows.push({ actv_code_type_id: '7', actv_code_type: 'Phase' });
  table(db, 'ACTVCODE').rows.push({ actv_code_id: '70', actv_code_type_id: '7', short_name: 'CIV' });
  table(db, 'TASKACTV').rows.push({ task_id: b.task_id, actv_code_type_id: '7', actv_code_id: '70', proj_id: pid });
  table(db, 'UDFTYPE').rows.push({ udf_type_id: '9', table_name: 'TASK', udf_type_label: 'Cost', logical_data_type: 'FT_INT' });
  table(db, 'UDFVALUE').rows.push({ udf_type_id: '9', fk_id: c.task_id, proj_id: pid, udf_number: '12' });
  assert.deepEqual(extraColumns(db).map((x) => [x.id, x.title]), [['code_7', 'Phase'], ['udf_9', 'Cost']]);
  const ctx = makeCtx(db, prefs);
  assert.equal(COLUMN_BY_ID.get('code_7')!.get(b, ctx), 'CIV');
  assert.equal(COLUMN_BY_ID.get('udf_9')!.get(c, ctx), '12');
  const ids = (json: object) => {
    table(db, '_FILTER').rows = [{ filter_id: '1', name: 'f', json: JSON.stringify(json) }];
    return buildActivityRows(makeCtx(db, prefs), [pid], {}, 'user:1', 'none', 'task_code').map((r) => r.task!.task_code);
  };
  assert.deepEqual(ids({ rows: [{ col: 'orig_dur', op: 'gt', value: '5' }] }), [b.task_code]);
  assert.deepEqual(ids({ rows: [{ col: 'start', op: 'ge', value: '2024-01-10' }] }), [b.task_code]);
  assert.deepEqual(ids({ rows: [{ col: 'start', op: 'eq', value: '2024-01-08' }, { col: 'task_name', op: 'contains', value: 'SLAB' }] }), [c.task_code]);
  assert.deepEqual(ids({ any: true, rows: [{ col: 'code_7', op: 'eq', value: 'civ' }, { col: 'udf_9', op: 'ge', value: '12' }] }), [b.task_code, c.task_code]);
  assert.deepEqual(ids({ rows: [{ col: 'code_7', op: 'empty', value: '' }] }), [a.task_code, c.task_code]);
});

test('trace logic walks levels and marks driving links', async () => {
  const { traceLogic } = await import('../core/project/ctx.ts');
  const { relationshipFloat } = await import('../core/schedule/cpm.ts');
  const db = emptyDb();
  const pid = newProject(db, { id: 'TR', name: 'Trace', start: '2024-01-08 08:00' });
  const root = db.tables.PROJWBS.rows[0].wbs_id;
  const [a, b, c, d, e] = [0, 1, 2, 3, 4].map(() => addActivity(db, pid, root));
  b.target_drtn_hr_cnt = b.remain_drtn_hr_cnt = '16'; // shorter, so B -> C is not driving
  for (const [x, y] of [[a, c], [b, c], [c, d], [d, e]]) addRelationship(db, x.task_id, y.task_id);
  assert.ok(scheduleProjects(db, [pid]).ok);
  const ctx = makeCtx(db, prefs), ff = relationshipFloat(db, ctx);
  const tr = traceLogic(ctx, c.task_id, { preds: 2, succs: 1 }, ff);
  assert.deepEqual(tr.levels.get(-1)!.sort(), [a.task_id, b.task_id].sort());
  assert.deepEqual(tr.levels.get(1), [d.task_id]);
  assert.equal(tr.levels.has(2), false);
  assert.deepEqual(tr.links.map((l) => [l.from, l.ff === 0]).sort(), [[a.task_id, true], [b.task_id, false], [c.task_id, true]].sort());
  assert.deepEqual(traceLogic(ctx, c.task_id, { preds: 3, succs: 0, drivingOnly: true }, ff).levels.get(-1), [a.task_id]);
  assert.equal(traceLogic(ctx, c.task_id, { preds: 1, succs: 0, maxPerLevel: 1 }, ff).more.get(-1), 1);
});
