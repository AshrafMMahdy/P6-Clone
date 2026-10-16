import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityCosts, sumLines, spi, cpi, percentComplete } from '../core/cost/rollup.ts';
import { REPORTS, reportCsv } from '../core/report/reports.ts';
import { parseXer } from '../core/xer/parse.ts';
import { samples } from './helpers.ts';
import type { Db, Row } from '../core/db.ts';

const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });

test('earned value for a half-done activity', () => {
  const db: Db = { tables: {
    PROJECT: tbl('PROJECT', [{ proj_id: '1', last_recalc_date: '2024-01-10 08:00', sum_base_proj_id: '' }]),
    TASK: tbl('TASK', [{ task_id: '1', proj_id: '1', task_code: 'A', complete_pct_type: 'CP_Drtn', target_drtn_hr_cnt: '32', remain_drtn_hr_cnt: '16', act_start_date: '2024-01-08 08:00', act_end_date: '', target_start_date: '2024-01-08 08:00', target_end_date: '2024-01-12 08:00' }]),
    TASKRSRC: tbl('TASKRSRC', [{ taskrsrc_id: '1', task_id: '1', proj_id: '1', target_cost: '1000', act_reg_cost: '600', act_ot_cost: '0', remain_cost: '500' }]),
  } };
  const l = sumLines(activityCosts(db, ['1']).values());
  assert.equal(l.bac, 1000);
  assert.equal(l.ev, 500);
  assert.equal(l.ac, 600);
  assert.equal(l.pv, 500);
  assert.equal(l.eac, 1100);
  assert.equal(spi(l), 1);
  assert.ok(Math.abs(cpi(l) - 500 / 600) < 1e-9);
  assert.equal(percentComplete(db.tables.TASK.rows[0], []), 0.5);
});

test('every report builds on a real project and exports CSV', () => {
  const db = parseXer(samples().find((s) => s.name === 'Copy of JWM - Baseline Programme Rev 05A.xer')!.bytes).db;
  const ids = db.tables.PROJECT.rows.map((p) => p.proj_id);
  for (const r of REPORTS) {
    const rep = r.build(db, ids, { hoursPerDay: 8, fmtDate: (s) => String(s ?? '') });
    assert.ok(rep.columns.length > 0, r.id);
    assert.ok(reportCsv(rep).split('\r\n').length === rep.rows.length + 1, r.id);
  }
});
