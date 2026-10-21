import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { progressCurves, resourceHistograms } from '../core/analysis/curves.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); };
const pid = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((a, x) => a + (x ?? 0), 0) * 100) / 100;

function build(): Db {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'C', start: '2026-03-02' },
    { op: 'add_resource', id: 'LAB', units_per_day: 8, max_units_per_day: 8, price_per_unit: 10 },
    { op: 'add_activity', id: 'A', name: 'Dig', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'Pour', duration_days: 10 }, { op: 'add_activity', id: 'P', name: 'Parallel', duration_days: 10 },
    { op: 'add_relationship', pred: 'A', succ: 'B' },
    { op: 'assign_resource', activity: 'A', resource: 'LAB' }, { op: 'assign_resource', activity: 'B', resource: 'LAB' }, { op: 'assign_resource', activity: 'P', resource: 'LAB' },
  ]);
  assert.ok(scheduleProjects(db, [pid(db)]).ok);
  ok(db, [{ op: 'save_baseline', name: 'C BL', assign_as: 'project' }]);
  // Dig half done at the data date (one week late), its cost on budget so far
  ok(db, [{ op: 'update_activity', id: 'A', actual_start: '2026-03-09 08:00', remaining_days: 5 }, { op: 'update_assignment', activity: 'A', resource: 'LAB', actual_units: 40 }, { op: 'set_project', data_date: '2026-03-16' }]);
  assert.ok(scheduleProjects(db, [pid(db)]).ok);
  return db;
}

test('progress curves: PV spreads the baseline budget, EV and AC up to the data date, forecasts after, SPI/CPI', () => {
  const db = build();
  const c = progressCurves(db, [pid(db)], { period: 'week' });
  assert.equal(c.baseline, 'C BL');
  assert.equal(c.totals.bac, 3 * 80 * 10, 'BAC: 3 activities x 80 h x 10');
  assert.equal(sum(c.periods.map((p) => p.pv)), c.totals.bac, 'the PV curve adds up to BAC');
  assert.equal(c.periods.at(-1)!.cum_pv, c.totals.bac);
  const past = c.periods.filter((p) => p.cum_ev != null);
  assert.equal(past.at(-1)!.cum_ev, c.totals.ev, 'cumulative EV at the data date = EV');
  assert.equal(past.at(-1)!.cum_ac, c.totals.ac, 'cumulative AC at the data date = AC');
  assert.equal(c.periods.find((p) => p.start > '2026-03-16')!.ev, null, 'no EV after the data date');
  assert.ok(c.totals.spi! < 1, `behind schedule (SPI ${c.totals.spi})`);
  assert.equal(c.totals.ac, 400);
  assert.equal(c.periods.at(-1)!.cum_forecast_early, c.totals.eac, 'actual + remaining early ends at EAC');
  // hours
  const h = progressCurves(db, [pid(db)], { units: 'hours', period: 'month' });
  assert.equal(h.totals.bac, 240);
  assert.equal(h.totals.ac, 40);
});

test('CPI is left empty (not 1) when no actual cost is recorded, with a warning', () => {
  const db = build();
  for (const a of rows(db, 'TASKRSRC')) { a.act_reg_qty = '0'; a.act_reg_cost = '0'; a.act_ot_cost = '0'; }
  const c = progressCurves(db, [pid(db)]);
  assert.equal(c.totals.cpi, null);
  assert.ok(c.warnings.some((w) => /CPI cannot be measured/.test(w)));
});

test('resource histogram: budgeted, actual, remaining early/late, limit and over-allocation severity', () => {
  const db = build();
  const r = resourceHistograms(db, [pid(db)], { period: 'week' });
  const lab = r.resources[0];
  assert.equal(lab.resource, 'LAB');
  assert.equal(sum(lab.periods.map((p) => p.budgeted)), 240);
  assert.equal(sum(lab.periods.map((p) => p.actual)), 40);
  assert.equal(sum(lab.periods.map((p) => p.remaining_early)), 200);
  assert.equal(sum(lab.periods.map((p) => p.remaining_late)), 200);
  // Dig/Pour and Parallel overlap: 16 h a day against an 8 h limit
  assert.ok(lab.over_allocated_periods > 0);
  assert.equal(lab.severity, 'critical');
  assert.ok(lab.peak!.demand > lab.peak!.limit!);
  const cost = resourceHistograms(db, [pid(db)], { cost: true });
  assert.equal(sum(cost.resources[0].periods.map((p) => p.budgeted)), 2400);
  assert.equal(cost.resources[0].severity, 'none');
});

test('baseline found by its copy link (Tower-A: no sum_base_proj_id); EV of an actual after the data date stays in cum_ev', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { detectFormat, readRaw } = await import('../renderer/io.ts');
  const { baselineOf } = await import('../core/analysis/common.ts');
  const p = join(import.meta.dirname, '..', 'Sample XERs', 'Tower-A.xer'), b = new Uint8Array(readFileSync(p));
  const tw = readRaw(b, detectFormat(p, b)).db;
  const main = rows(tw, 'PROJECT').find((x) => !x._baseline_of)!;
  assert.equal(baselineOf(tw, main, 'project')?.name, 'TOWER-A-BL1');
  assert.ok(!progressCurves(tw, [main.proj_id], {}).warnings.some((w) => /No project baseline/.test(w)));
  // an activity whose actual start and finish are after the data date: its EV is still counted by the data date
  const db: Db = { tables: {} };
  const r = applyOps(db, [
    { op: 'add_project', id: 'EV', start: '2026-03-02' }, { op: 'add_resource', id: 'R', name: 'R', price_per_unit: 10 },
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'assign_resource', activity: 'A', resource: 'R', units_per_day: 8 },
    { op: 'update_activity', id: 'A', actual_start: '2026-03-20 08:00', actual_finish: '2026-03-26 17:00' },
  ]);
  assert.ok(r.ok, JSON.stringify(r.error));
  const pid = rows(db, 'PROJECT')[0].proj_id;
  scheduleProjects(db, [pid], { dataDate: Date.UTC(2026, 2, 16, 8) / 60000 });
  const c = progressCurves(db, [pid], { period: 'week' });
  const lastEv = c.periods.filter((x) => x.cum_ev != null).at(-1)!.cum_ev!;
  assert.ok(c.totals.ev > 0, 'the activity earned value: ' + c.totals.ev);
  assert.equal(lastEv, c.totals.ev, 'cum_ev at the data date equals the earned value');
});
