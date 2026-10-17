import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { emptyDb, rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { activityCosts, earnedValue } from '../core/cost/rollup.ts';
import { saveBaseline, assignBaseline } from '../core/progress/baseline.ts';
import { runTool } from '../core/query/tools.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { listReports, runReport, runSpec, parseSpec } from '../renderer/reports/engine.ts';
import { reportHtml, reportPages, reportXlsx } from '../renderer/reports/output.ts';
import { readXlsx } from '../core/excel/xlsx.ts';
import { SAMPLES_DIR } from './helpers.ts';

const prefs = { hoursPerDay: 8, dateFormat: 'yyyy-mm-dd' as const, showTime: false, durationDecimals: 0 };
const cairo = () => parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer')))).db;

test('earned value follows P6: baseline budget, planned value at the data date, earned value from % complete', () => {
  const db = emptyDb();
  const r = applyOps(db, [
    { op: 'add_project', id: 'EV', start: '2027-03-01' },
    { op: 'add_resource', id: 'CREW', type: 'labor', units_per_day: 8, price_per_unit: 10 },
    { op: 'add_activity', id: 'A', name: 'Work', duration_days: 10 },
    { op: 'assign_resource', activity: 'A', resource: 'CREW', units: 80 },
  ]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const p = rows(db, 'PROJECT')[0];
  let line = activityCosts(db, [p.proj_id]).get(rows(db, 'TASK')[0].task_id)!;
  assert.equal(line.bac, 800, 'no baseline: BAC is the current budget');
  // baseline it, then the budget grows: BAC stays the baseline's 800
  assignBaseline(db, p.proj_id, saveBaseline(db, p.proj_id, 'BL1'));
  const asg = rows(db, 'TASKRSRC').find((a) => a.proj_id === p.proj_id)!;
  asg.target_cost = '1000';
  // progress: started, 40% physical, 300 actual, data date mid-way through the baseline dates
  const t = rows(db, 'TASK').find((x) => x.proj_id === p.proj_id)!;
  t.act_start_date = '2027-03-01 08:00'; t.complete_pct_type = 'CP_Phys'; t.phys_complete_pct = '40'; t.status_code = 'TK_Active';
  asg.act_reg_cost = '300'; asg.remain_cost = '600';
  const bl = rows(db, 'TASK').find((x) => x.proj_id === p.sum_base_proj_id)!;
  const s = Date.parse(bl.target_start_date.replace(' ', 'T') + 'Z'), f = Date.parse(bl.target_end_date.replace(' ', 'T') + 'Z');
  const mid = new Date((s + f) / 2); p.last_recalc_date = mid.toISOString().slice(0, 16).replace('T', ' ');
  line = activityCosts(db, [p.proj_id]).get(t.task_id)!;
  const e = earnedValue(line);
  assert.equal(e.bac, 800);
  assert.ok(Math.abs(e.pv - 400) < 1, `PV ${e.pv} = half of BAC at mid-way`);
  assert.equal(e.ev, 320, 'EV = BAC x 40%');
  assert.equal(e.ac, 300);
  assert.equal(e.eac, 900, 'EAC = AC + remaining cost');
  assert.equal(e.vac, -100);
  assert.ok(Math.abs(e.spi - 0.8) < 0.01 && Math.abs(e.cpi - 320 / 300) < 1e-9);
  // the same through the AI / MCP lookup
  const ev = runTool('earned_value', {}, db, makeCtx(db, { hoursPerDay: 8 }), [p.proj_id], 8) as { projects: { totals: { ev: number; bac: number; has?: boolean } ; has_baseline: boolean }[] };
  assert.equal(ev.projects[0].totals.ev, 320); assert.equal(ev.projects[0].has_baseline, true);
});

test('every standard report runs; group bands without activities are left out; custom definitions sort and filter', () => {
  const db = cairo();
  const ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const list = listReports(db);
  assert.ok(list.length >= 25 && ['Schedule', 'Progress', 'Earned Value', 'Cost', 'Resources'].every((g) => list.some((e) => e.group === g)));
  for (const e of list) assert.doesNotThrow(() => runReport(db, ids, e.id, { prefs }), e.id);
  const ms = runReport(db, ids, 'Milestone Report', { prefs }).report;
  assert.equal(ms.rows.filter((r) => !r.bold).length, 44);
  const wbs = runSpec(db, ids, parseSpec({ name: 'M by WBS', subject: 'activities', columns: ['task_code', 'task_name'], filter: 'milestones', group_by: 'wbs' })!, { prefs });
  for (let i = 0; i < wbs.rows.length; i++) if (wbs.rows[i].bold) {
    const lv = wbs.rows[i].level ?? 0;
    const next = wbs.rows.slice(i + 1).find((r) => !r.bold || (r.level ?? 0) <= lv);
    assert.ok(next && !next.bold, `band "${wbs.rows[i].cells[0]}" has activities under it`);
  }
  const fl = runSpec(db, ids, parseSpec({ name: 'F', subject: 'activities', columns: ['task_code', 'total_float'], filter: 'open', group_by: 'none', sort_by: 'total_float', sort_desc: true })!, { prefs });
  const vals = fl.rows.map((r) => Number(r.cells[1]));
  assert.deepEqual(vals, [...vals].sort((a, b) => b - a));
  for (const subject of ['assignments', 'wbs', 'resources', 'relationships']) {
    const r = runSpec(db, ids, parseSpec({ name: subject, subject })!, { prefs });
    assert.ok(r.rows.length > 0 && r.columns.length > 2, subject);
  }
});

test('report outputs: printed pages, HTML and Excel', async () => {
  const db = cairo();
  const ids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const { report } = runReport(db, ids, 'Relationship Report', { prefs });
  const pages = reportPages(db, ids, report, { paper: 'A4', landscape: false }, prefs, 'Relationship Report');
  assert.ok(pages.length >= 3, `${pages.length} pages for ${report.rows.length} rows`);
  assert.ok(pages.every((p) => p.prims.some((x) => x.t === 'text' && x.bold && x.s.startsWith('Pred'))), 'column titles repeat on every page');
  assert.match(reportHtml(report, 'now'), /<h1>Relationship Report<\/h1>/);
  const [sheet] = await readXlsx(await reportXlsx(report));
  assert.equal(sheet.rows[0][0], 'Relationship Report');
  assert.equal(sheet.rows[3][0], 'Predecessor');
  assert.equal(sheet.rows.length - 4, report.rows.length);
});
