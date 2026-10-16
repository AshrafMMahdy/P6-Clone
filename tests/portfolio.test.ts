import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, Row } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { createPortfolio, deletePortfolio, getPortfolio, listPortfolios, portfolioSummary, projectsIn, updatePortfolio } from '../core/portfolio.ts';
import { writeXer } from '../core/xer/write.ts';

const tbl = (name: string, rs: Row[]) => ({ name, fields: [...new Set(rs.flatMap((r) => Object.keys(r)))], rows: rs });

function fixture(): Db {
  const task = (id: string, proj: string, extra: Row): Row => ({
    task_id: id, proj_id: proj, task_code: `A${id}`, task_type: 'TT_Task', complete_pct_type: 'CP_Drtn', target_drtn_hr_cnt: '80', remain_drtn_hr_cnt: '80',
    act_start_date: '', act_end_date: '', total_float_hr_cnt: '0', ...extra,
  });
  return { tables: {
    EPS: tbl('EPS', [{ eps_id: '1', parent_eps_id: '', eps_name: 'Enterprise' }, { eps_id: '2', parent_eps_id: '1', eps_name: 'Buildings' }, { eps_id: '3', parent_eps_id: '2', eps_name: 'Towers' }, { eps_id: '4', parent_eps_id: '1', eps_name: 'Roads' }]),
    PROJECT: tbl('PROJECT', [
      { proj_id: '1', proj_short_name: 'TWR-A', last_recalc_date: '2026-01-11 08:00', _eps_id: '3', critical_drtn_hr_cnt: '0', sum_base_proj_id: '' },
      { proj_id: '2', proj_short_name: 'RD-1', last_recalc_date: '2026-02-01 08:00', _eps_id: '4', critical_drtn_hr_cnt: '0', sum_base_proj_id: '' },
      { proj_id: '3', proj_short_name: 'TWR-A BL', _baseline_of: '1', _eps_id: '3' },
    ]),
    PROJWBS: tbl('PROJWBS', [
      { wbs_id: '1', proj_id: '1', proj_node_flag: 'Y', wbs_name: 'Tower A', status_code: 'WS_Open' },
      { wbs_id: '2', proj_id: '2', proj_node_flag: 'Y', wbs_name: 'Ring Road', status_code: 'WS_Planned' },
      { wbs_id: '3', proj_id: '3', proj_node_flag: 'Y', wbs_name: 'Tower A baseline', status_code: 'WS_Open' },
    ]),
    TASK: tbl('TASK', [
      // project 1: one complete, one in progress (half done), one not started with float
      task('1', '1', { act_start_date: '2026-01-05 08:00', act_end_date: '2026-01-09 17:00', remain_drtn_hr_cnt: '0', target_start_date: '2026-01-05 08:00', target_end_date: '2026-01-09 17:00', total_float_hr_cnt: '' }),
      task('2', '1', { act_start_date: '2026-01-07 08:00', remain_drtn_hr_cnt: '40', target_start_date: '2026-01-07 08:00', target_end_date: '2026-01-15 08:00', early_start_date: '2026-01-11 08:00', early_end_date: '2026-01-16 17:00' }),
      task('3', '1', { target_start_date: '2026-01-19 08:00', target_end_date: '2026-01-30 17:00', early_start_date: '2026-01-19 08:00', early_end_date: '2026-01-30 17:00', total_float_hr_cnt: '16' }),
      task('9', '1', { task_type: 'TT_WBS' }),
      // project 2: one not started, negative float
      task('4', '2', { target_start_date: '2026-03-02 08:00', target_end_date: '2026-03-31 17:00', early_start_date: '2026-03-02 08:00', early_end_date: '2026-03-31 17:00', total_float_hr_cnt: '-8' }),
      // baseline project task (must never be counted)
      task('5', '3', { target_start_date: '2025-01-01 08:00', target_end_date: '2027-01-01 08:00' }),
    ]),
    TASKRSRC: tbl('TASKRSRC', [
      { taskrsrc_id: '1', task_id: '1', proj_id: '1', target_cost: '1000', act_reg_cost: '1100', act_ot_cost: '0', remain_cost: '0' },
      { taskrsrc_id: '2', task_id: '2', proj_id: '1', target_cost: '2000', act_reg_cost: '900', act_ot_cost: '100', remain_cost: '1000' },
      { taskrsrc_id: '3', task_id: '3', proj_id: '1', target_cost: '3000', act_reg_cost: '0', act_ot_cost: '0', remain_cost: '3000' },
      { taskrsrc_id: '4', task_id: '4', proj_id: '2', target_cost: '500', act_reg_cost: '0', act_ot_cost: '0', remain_cost: '500' },
    ]),
    PROJCOST: tbl('PROJCOST', [{ cost_item_id: '1', task_id: '3', proj_id: '1', target_cost: '400', act_cost: '0', remain_cost: '400' }]),
  } };
}

test('portfolio CRUD keeps definitions in the internal _PORTFOLIO table', () => {
  const db = fixture();
  const p = createPortfolio(db, 'Towers', { descr: 'All towers', projIds: ['1'] });
  assert.equal(p.id, '1');
  assert.deepEqual(projectsIn(db, p.id), ['1']);
  assert.throws(() => createPortfolio(db, ' towers '), /already exists/);
  assert.throws(() => createPortfolio(db, '  '), /blank/);
  const q = createPortfolio(db, 'All Active', { rule: { status: 'WS_Open' } });
  assert.deepEqual(listPortfolios(db).map((x) => x.name), ['All Active', 'Towers']);
  updatePortfolio(db, p.id, { name: 'Tower Projects', projIds: ['1', '2', '404', '2'] });
  assert.deepEqual(projectsIn(db, p.id), ['1', '2'], 'missing and duplicate ids dropped');
  assert.equal(getPortfolio(db, p.id)?.name, 'Tower Projects');
  assert.throws(() => updatePortfolio(db, p.id, { name: 'all active' }), /already exists/);
  // switch a rule portfolio to a fixed list and back
  updatePortfolio(db, q.id, { projIds: ['2'] });
  assert.equal(getPortfolio(db, q.id)?.rule, undefined);
  assert.deepEqual(projectsIn(db, q.id), ['2']);
  updatePortfolio(db, q.id, { rule: { nameContains: 'road' } });
  assert.deepEqual(projectsIn(db, q.id), ['2']);
  deletePortfolio(db, q.id);
  assert.equal(listPortfolios(db).length, 1);
  assert.throws(() => deletePortfolio(db, q.id), /not found/);
  assert.deepEqual(projectsIn(db, 'nope'), []);
  // portfolios are never written to XER
  const text = new TextDecoder().decode(writeXer(db, { version: '19.12', encoding: 'utf-8' }));
  assert.ok(!text.includes('_PORTFOLIO') && !text.includes('Tower Projects'));
});

test('rule portfolios filter by status, EPS (with child nodes) and name, never baselines', () => {
  const db = fixture();
  const ids = (rule: Parameters<typeof createPortfolio>[2]) => projectsIn(db, createPortfolio(db, `p${Math.random()}`, rule).id);
  assert.deepEqual(ids({ rule: { epsId: '2' } }), ['1'], 'Buildings includes Towers');
  assert.deepEqual(ids({ rule: { epsId: '1' } }), ['1', '2']);
  assert.deepEqual(ids({ rule: { status: 'WS_Planned' } }), ['2']);
  assert.deepEqual(ids({ rule: { nameContains: 'tower' } }), ['1']);
  assert.deepEqual(ids({ rule: { nameContains: 'TWR' } }), ['1']);
  assert.deepEqual(ids({ rule: { status: 'WS_Open', epsId: '4' } }), []);
  assert.deepEqual(ids({ rule: {} }), ['1', '2']);
});

test('portfolio summary: counts, dates, float, critical, costs and earned value', () => {
  const db = fixture();
  const s = portfolioSummary(db, ['1', '2', 'missing']);
  assert.equal(s.projects.length, 2);
  const [a, b] = s.projects;
  assert.equal(a.code, 'TWR-A');
  assert.equal(a.name, 'Tower A');
  assert.equal(a.status, 'Active');
  assert.deepEqual([a.activities, a.notStarted, a.inProgress, a.completed], [3, 1, 1, 1]);
  assert.equal(a.start, parseP6Date('2026-01-05 08:00'));
  assert.equal(a.finish, parseP6Date('2026-01-30 17:00'));
  assert.equal(a.dataDate, parseP6Date('2026-01-11 08:00'));
  assert.equal(a.minTotalFloatHr, 0);
  assert.equal(a.critical, 1);
  assert.equal(a.budgetedCost, 6400);
  assert.equal(a.actualCost, 2100);
  assert.equal(a.remainingCost, 4400);
  assert.equal(a.atCompletionCost, 6500);
  // BCWP: 1000 x 100% + 2000 x 50% ; ACWP 2100
  assert.equal(a.bcwp, 2000);
  assert.equal(a.acwp, 2100);
  assert.ok(a.bcws > 1000 && a.bcws < 3000);
  assert.ok(Math.abs(a.cpi - 2000 / 2100) < 1e-9);
  assert.ok(Math.abs(a.spi - a.bcwp / a.bcws) < 1e-9);

  assert.equal(b.status, 'Planned');
  assert.equal(b.minTotalFloatHr, -8);
  assert.equal(b.critical, 1);
  assert.equal(b.bcws, 0);
  assert.equal(b.spi, 0);

  const t = s.totals;
  assert.equal(t.activities, 4);
  assert.equal(t.critical, 2);
  assert.equal(t.budgetedCost, 6900);
  assert.equal(t.minTotalFloatHr, -8);
  assert.equal(t.start, a.start);
  assert.equal(t.finish, parseP6Date('2026-03-31 17:00'));
  assert.equal(t.dataDate, b.dataDate, 'totals show the latest data date');
  assert.ok(Math.abs(t.cpi - 2000 / 2100) < 1e-9);
  assert.equal(portfolioSummary(db, []).totals.activities, 0);
});
