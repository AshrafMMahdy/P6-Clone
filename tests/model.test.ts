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
