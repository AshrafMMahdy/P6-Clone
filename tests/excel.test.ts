import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { rows } from '../core/db.ts';
import { readXlsx, writeXlsx, unzip } from '../core/excel/xlsx.ts';
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { applyOps } from '../core/project/ops.ts';
import { SAMPLES_DIR } from './helpers.ts';

const load = () => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;

test('xlsx round trip keeps text, numbers, dates and unicode; the file is a valid zip workbook', async () => {
  const bytes = await writeXlsx([{ name: 'S1', rows: [['a', 1.5, new Date(Date.UTC(2027, 2, 1, 8, 0))], [null, 'Tower «A» & <B>', 'مبنى']], boldRows: 1 }]);
  const files = await unzip(bytes);
  assert.ok(files.has('xl/workbook.xml') && files.has('xl/worksheets/sheet1.xml') && files.has('[Content_Types].xml'));
  const [s] = await readXlsx(bytes);
  assert.equal(s.name, 'S1');
  assert.equal(s.rows[0][0], 'a'); assert.equal(s.rows[0][1], 1.5);
  assert.equal((s.rows[0][2] as Date).toISOString(), '2027-03-01T08:00:00.000Z');
  assert.equal(s.rows[1][1], 'Tower «A» & <B>'); assert.equal(s.rows[1][2], 'مبنى');
});

test('P6-style export re-imported unchanged plans nothing; edits become exactly the matching operations', async () => {
  const db = load();
  const p = rows(db, 'PROJECT')[0];
  const sheets = await readXlsx(await writeXlsx(exportSheets(db, [p.proj_id])));
  assert.deepEqual(sheets.map((s) => s.name), ['TASK', 'TASKPRED', 'RSRC', 'TASKRSRC', 'USERDATA']);
  const task = sheets[0];
  assert.equal(task.rows[0][1], 'task_code'); assert.equal(task.rows[1][1], 'Activity ID');
  assert.equal(task.rows.length - 2, rows(db, 'TASK').length);
  const none = planImport(db, sheets, p.proj_short_name);
  assert.deepEqual(none.warnings, []);
  assert.equal(none.ops.length, 0, JSON.stringify(none.ops.slice(0, 3)));
  // edit: a duration, a new activity, a deleted activity, a new relationship
  const col = (f: string) => task.rows[0].indexOf(f);
  const a2410 = task.rows.find((r) => r[col('task_code')] === 'A2410')!;
  a2410[col('target_drtn_hr_cnt')] = 30;
  const victim = task.rows.find((r) => r[col('task_code')] === 'A1320')!;
  victim[col('delete_record_flag')] = 'Y';
  const fresh = Array(task.rows[0].length).fill(null); fresh[col('task_code')] = 'X9000'; fresh[col('task_name')] = 'Added in Excel'; fresh[col('target_drtn_hr_cnt')] = 4;
  task.rows.push(fresh);
  sheets[1].rows.push([null, 'A2410', null, 'X9000', 'SS', 2, null]);
  const plan = planImport(db, sheets, p.proj_short_name);
  assert.deepEqual(plan.summary, { activitiesAdded: 1, activitiesUpdated: 1, activitiesDeleted: 1, relationshipsAdded: 1, relationshipsUpdated: 0, relationshipsDeleted: 0, resourcesAdded: 0, assignmentsAdded: 0, assignmentsDeleted: 0, unchanged: plan.summary.unchanged });
  const r = applyOps(db, plan.ops);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const t = new Map(rows(db, 'TASK').map((x) => [x.task_code, x]));
  assert.equal(Number(t.get('A2410')!.target_drtn_hr_cnt), 240);
  assert.ok(t.has('X9000') && !t.has('A1320'));
  assert.ok(rows(db, 'TASKPRED').some((x) => x.pred_task_id === t.get('A2410')!.task_id && x.task_id === t.get('X9000')!.task_id && x.pred_type === 'PR_SS' && Number(x.lag_hr_cnt) === 16));
});
