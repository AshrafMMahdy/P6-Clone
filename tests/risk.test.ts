import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Row } from '../core/db.ts';
import { rows } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import {
  addRisk, deleteRisk, heatMap, linkActivity, linkedTasks, riskProbability, riskScore, riskScheduleHours, scoreBand, schedLevelFromHours, unlinkActivity, updateRisk,
} from '../core/risk/register.ts';
import { defaultEstimates, getEstimates, mulberry32, runMonteCarlo, sampleDuration, setEstimate, spearman } from '../core/risk/montecarlo.ts';
import { SAMPLES_DIR } from './helpers.ts';

const CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|16:00)())))(0||3()((0||0(s|08:00|f|16:00)())))(0||4()((0||0(s|08:00|f|16:00)())))(0||5()((0||0(s|08:00|f|16:00)())))(0||6()((0||0(s|08:00|f|16:00)())))(0||7()())))(0||Exceptions()())))';
const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });

/** A -> B -> C -> M (finish milestone), durations in days. */
function chain(days = [5, 10, 3]): Db {
  const codes = ['A', 'B', 'C'];
  const tasks: Row[] = codes.map((c, i) => ({
    task_id: String(100 + i), proj_id: '1', wbs_id: '10', clndr_id: '1', task_code: c, task_name: `Task ${c}`, task_type: 'TT_Task', status_code: 'TK_NotStart',
    target_drtn_hr_cnt: String(days[i] * 8), remain_drtn_hr_cnt: String(days[i] * 8), act_start_date: '', act_end_date: '', cstr_type: '', cstr_date: '',
  }));
  tasks.push({ task_id: '103', proj_id: '1', wbs_id: '10', clndr_id: '1', task_code: 'M', task_name: 'Finish', task_type: 'TT_FinMile', status_code: 'TK_NotStart', target_drtn_hr_cnt: '0', remain_drtn_hr_cnt: '0', act_start_date: '', act_end_date: '', cstr_type: '', cstr_date: '' });
  const links = [['100', '101'], ['101', '102'], ['102', '103']];
  return {
    tables: {
      PROJECT: tbl('PROJECT', [{ proj_id: '1', proj_short_name: 'P', clndr_id: '1', plan_start_date: '2024-01-08 00:00', last_recalc_date: '2024-01-08 00:00', plan_end_date: '' }]),
      CALENDAR: tbl('CALENDAR', [{ clndr_id: '1', default_flag: 'Y', clndr_name: 'Std', clndr_data: CAL }]),
      PROJWBS: tbl('PROJWBS', [{ wbs_id: '10', proj_id: '1', parent_wbs_id: '', proj_node_flag: 'Y', wbs_short_name: 'P' }]),
      TASK: tbl('TASK', tasks),
      TASKPRED: tbl('TASKPRED', links.map(([p, s], i) => ({ task_pred_id: String(i + 1), task_id: s, pred_task_id: p, proj_id: '1', pred_proj_id: '1', pred_type: 'PR_FS', lag_hr_cnt: '0' }))),
    },
  };
}

test('risk score, bands and probability/impact scale', () => {
  const db = chain();
  const r = addRisk(db, '1', { risk_name: 'Late steel', pre_prob: 'H', pre_sched_impact: 'VH', pre_cost_impact: 'L', post_prob: 'L', post_sched_impact: 'M' });
  assert.equal(r.risk_code, 'RSK-0001');
  assert.equal(addRisk(db, '1').risk_code, 'RSK-0002');
  assert.deepEqual(riskScore(r, 'pre'), { prob: 4, sched: 5, cost: 2, impact: 5, score: 20, band: 'high' });
  // post falls back to pre for blank fields (cost) and takes the worse impact
  assert.deepEqual(riskScore(r, 'post'), { prob: 2, sched: 3, cost: 2, impact: 3, score: 6, band: 'medium' });
  assert.equal(scoreBand(4), 'low');
  assert.equal(scoreBand(5), 'medium');
  assert.equal(scoreBand(12), 'high');
  assert.equal(schedLevelFromHours(40), 'VL');
  assert.equal(schedLevelFromHours(100), 'M');
  assert.equal(schedLevelFromHours(1000), 'VH');
  assert.equal(riskProbability(r, 'pre'), 0.6);
  updateRisk(db, r.proj_risk_id, { pre_prob_pct: '35', pre_sched_impact_hr_cnt: '24' });
  assert.equal(riskProbability(r, 'pre'), 0.35);
  assert.equal(riskScheduleHours(r, 'pre'), 24);
  // impact from hours when the rating is blank
  updateRisk(db, r.proj_risk_id, { pre_sched_impact: '', pre_cost_impact: '', pre_sched_impact_hr_cnt: '200' });
  assert.equal(riskScore(r, 'pre').impact, 4);
});

test('heat map matrix and activity links', () => {
  const db = chain();
  const a = addRisk(db, '1', { pre_prob: 'H', pre_sched_impact: 'M', pre_cost_impact: 'VL' });
  const b = addRisk(db, '1', { pre_prob: 'H', pre_sched_impact: 'L', pre_cost_impact: 'M' });
  const c = addRisk(db, '1', { pre_prob: 'VL', pre_sched_impact: 'VL', pre_cost_impact: 'VL', status_code: 'RS_Rejected' });
  const d = addRisk(db, '1', { pre_prob: '', pre_sched_impact: 'H' });
  const hm = heatMap(db, ['1'], 'pre');
  assert.equal(hm.cells.length, 5);
  assert.equal(hm.cells[0].length, 5);
  assert.deepEqual(hm.cells[3][2].risks.sort(), [a.proj_risk_id, b.proj_risk_id].sort());
  assert.equal(hm.cells[3][2].score, 12);
  assert.equal(hm.cells[3][2].band, 'high');
  assert.equal(hm.cells[0][0].risks.length, 0, 'rejected risks are left out');
  assert.equal(heatMap(db, ['1'], 'pre', { includeRejected: true }).cells[0][0].risks[0], c.proj_risk_id);
  assert.deepEqual(hm.unrated, [d.proj_risk_id]);

  assert.equal(typeof linkActivity(db, a.proj_risk_id, '101'), 'object');
  linkActivity(db, a.proj_risk_id, '101'); // duplicate ignored
  linkActivity(db, a.proj_risk_id, '102');
  assert.equal(linkActivity(db, a.proj_risk_id, '999'), 'Activity not found.');
  assert.deepEqual(linkedTasks(db, a.proj_risk_id), ['101', '102']);
  unlinkActivity(db, a.proj_risk_id, '101');
  assert.deepEqual(linkedTasks(db, a.proj_risk_id), ['102']);
  deleteRisk(db, a.proj_risk_id);
  assert.equal(rows(db, 'PROJRISK').length, 3);
  assert.equal(rows(db, 'TASKRISK').length, 0);
});

test('risk tables round-trip through the XER writer; _RISKEST is not exported', () => {
  const db = chain();
  const r = addRisk(db, '1', { risk_name: 'Ground conditions', pre_prob: 'M', pre_sched_impact_hr_cnt: '40', risk_type_id: '3' });
  linkActivity(db, r.proj_risk_id, '100');
  defaultEstimates(db, ['1']);
  const text = new TextDecoder().decode(writeXer(db, { version: '19.12', projIds: ['1'], encoding: 'utf-8' }));
  assert.ok(!text.includes('_RISKEST'));
  const back = parseXer(new TextEncoder().encode(text)).db;
  assert.equal(back.tables.PROJRISK.rows[0].risk_name, 'Ground conditions');
  assert.equal(back.tables.PROJRISK.rows[0].pre_sched_impact_hr_cnt, '40');
  assert.equal(back.tables.TASKRISK.rows[0].task_id, '100');
  assert.deepEqual(back.tables.RISKTYPE.rows.map((t) => t.risk_type), ['Procurement'], 'referenced category exported');
  assert.ok(text.indexOf('%T	PROJRISK') < text.indexOf('%T	TASKRISK'));
  assert.ok(!back.tables._RISKEST);
});

test('distributions stay within min..max; PRNG reproducible', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const rng = mulberry32(7);
  for (const dist of ['triangle', 'betapert', 'uniform'] as const) {
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const x = sampleDuration({ min: 10, ml: 12, max: 20, dist }, rng);
      assert.ok(x >= 10 && x <= 20, `${dist} ${x}`);
      sum += x;
    }
    const mean = sum / 2000;
    const expect = dist === 'triangle' ? 14 : dist === 'betapert' ? (10 + 4 * 12 + 20) / 6 : 15;
    assert.ok(Math.abs(mean - expect) < 0.4, `${dist} mean ${mean} vs ${expect}`);
  }
  assert.equal(sampleDuration({ min: 5, ml: 8, max: 9, dist: 'none' }, rng), 8);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test('Monte Carlo on a chain: reproducible, bounded, 100% critical, real db untouched', async () => {
  const db = chain();
  setEstimate(db, '100', { min: 32, ml: 40, max: 64, dist: 'triangle' });
  setEstimate(db, '101', { min: 64, ml: 80, max: 120, dist: 'triangle' });
  setEstimate(db, '102', { min: 16, ml: 24, max: 40, dist: 'triangle' });
  assert.equal(getEstimates(db).size, 3);
  const before = JSON.stringify(db);
  let calls = 0;
  const r1 = await runMonteCarlo(db, ['1'], { iterations: 200, seed: 123, onProgress: () => calls++ });
  assert.equal(JSON.stringify(db), before, 'real db untouched');
  assert.equal(calls, 200);
  const r2 = await runMonteCarlo(db, ['1'], { iterations: 200, seed: 123 });
  assert.deepEqual(r2.finishSamples, r1.finishSamples, 'same seed, same samples');
  const r3 = await runMonteCarlo(db, ['1'], { iterations: 200, seed: 124 });
  assert.notDeepEqual(r3.finishSamples, r1.finishSamples);

  // all-min and all-max schedules bound the samples
  const fin = (h: [number, number, number]) => {
    const d = chain();
    d.tables.TASK.rows.slice(0, 3).forEach((t, i) => { t.remain_drtn_hr_cnt = String(h[i]); });
    return scheduleProjects(d, ['1']).stats.finish!;
  };
  const lo = fin([32, 64, 16]), hi = fin([64, 120, 40]);
  assert.ok(r1.percentiles.P50 > lo && r1.percentiles.P50 < hi, 'P50 between min and max finish');
  assert.ok(r1.finishSamples.every((f) => f >= lo && f <= hi));
  assert.ok(r1.percentiles.P10 <= r1.percentiles.P50 && r1.percentiles.P50 <= r1.percentiles.P80 && r1.percentiles.P80 <= r1.percentiles.P90);
  assert.equal(r1.deterministicFinish, scheduleProjects(chain(), ['1']).stats.finish);
  assert.equal(r1.histogram.reduce((s, b) => s + b.count, 0), 200);
  assert.equal(r1.histogram[r1.histogram.length - 1].cumPct, 100);
  assert.equal(r1.cumulative[r1.cumulative.length - 1].pct, 100);
  for (const a of r1.activities) assert.equal(a.criticality, 100, `${a.code} critical in every iteration`);
  assert.equal(r1.sensitivity.length, 3);
  assert.equal(r1.sensitivity[0].code, 'B', 'widest range drives the finish most');
  assert.ok(r1.sensitivity.every((s) => s.rho > 0));
  assert.equal(r1.milestones.length, 1);
  assert.equal(r1.milestones[0].code, 'M');
  assert.equal(r1.milestones[0].P50, r1.percentiles.P50);
});

test('Monte Carlo with deterministic estimates reproduces the CPM finish', async () => {
  const db = chain();
  defaultEstimates(db, ['1'], 100, 100);
  const r = await runMonteCarlo(db, ['1'], { iterations: 25, seed: 1 });
  assert.ok(r.finishSamples.every((f) => f === r.deterministicFinish));
  assert.equal(r.percentiles.P90, r.deterministicFinish);
  assert.equal(r.probDeterministic, 1);
  assert.equal(r.sensitivity.length, 0);
});

test('risk events add their impact to linked activities when they occur', async () => {
  const db = chain();
  defaultEstimates(db, ['1'], 100, 100);
  const sure = addRisk(db, '1', { pre_prob: 'VH', pre_prob_pct: '100', pre_sched_impact_hr_cnt: '16', status_code: 'RS_Open' });
  linkActivity(db, sure.proj_risk_id, '101');
  const r = await runMonteCarlo(db, ['1'], { iterations: 10, seed: 9 });
  const det = r.deterministicFinish;
  const late = chain([5, 12, 3]);
  assert.ok(r.finishSamples.every((f) => f === scheduleProjects(late, ['1']).stats.finish && f > det), '+16 h on B in every iteration');
  assert.equal(r.risks[0].triggeredPct, 100);
  const off = await runMonteCarlo(db, ['1'], { iterations: 5, seed: 9, riskEvents: 'off' });
  assert.ok(off.finishSamples.every((f) => f === det));
  updateRisk(db, sure.proj_risk_id, { status_code: 'RS_Rejected' });
  const rej = await runMonteCarlo(db, ['1'], { iterations: 5, seed: 9 });
  assert.equal(rej.risks.length, 0);
});

test('smoke: cairo festival city, 50 iterations', async () => {
  const { db } = parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'cairo festival city.xer'))));
  const pids = rows(db, 'PROJECT').map((p) => p.proj_id);
  const n = defaultEstimates(db, pids);
  assert.ok(n > 0);
  const before = JSON.stringify(db.tables.TASK);
  const r = await runMonteCarlo(db, pids, { iterations: 50, seed: 2026 });
  assert.equal(JSON.stringify(db.tables.TASK), before);
  assert.equal(r.finishSamples.length, 50);
  assert.ok(r.percentiles.P10 >= r.min && r.percentiles.P90 <= r.max);
  // max estimates are 125% and min 90%, so the deterministic finish is not later than the P90
  assert.ok(r.percentiles.P90 >= r.deterministicFinish);
  assert.ok(r.activities.some((a) => a.criticality > 0));
  assert.ok(r.sensitivity.length > 0 && Math.abs(r.sensitivity[0].rho) <= 1);
  assert.ok(parseP6Date('2000-01-01')! < r.percentiles.P50);
});
