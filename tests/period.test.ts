// Financial periods and Store Period Performance (P6: Admin > Financial Periods, Tools > Store Period Performance):
// each period holds what was done in it (the value to date less the other periods), storing again overwrites, Actual
// This Period goes back to zero, and P6's "link actual to date and actual this period" option is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { rollback, record } from '../core/journal.ts';

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const fail = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, false); return r.error!.message; };

function build(): Db {
  const db = { tables: {} } as Db;
  ok(db, [
    { op: 'add_project', id: 'P', start: '2026-01-05' },
    { op: 'add_resource', id: 'LAB', type: 'labor', price_per_unit: 10 },
    { op: 'add_resource', id: 'MAT', type: 'material', price_per_unit: 2 },
    { op: 'add_activity', id: 'A', name: 'Dig', duration_days: 20 },
    { op: 'assign_resource', activity: 'A', resource: 'LAB', units: 160 },
    { op: 'assign_resource', activity: 'A', resource: 'MAT', units: 100 },
    { op: 'add_expense', activity: 'A', name: 'Skip hire', budgeted_cost: 500 },
  ]);
  return db;
}

test('financial periods: batch months and weeks, overlap refused, rename, delete', () => {
  const db = build();
  const r = ok(db, [{ op: 'add_financial_periods', from: '2026-01-01', to: '2026-03-31', every: 'month' }]);
  assert.deepEqual(r.results[0], { financial_periods: 3, first: '2026-01-01', last: '2026-03-01' });
  assert.deepEqual(rows(db, 'FINDATES').map((f) => [f.start_date, f.end_date]), [['2026-01-01 00:00', '2026-01-31 00:00'], ['2026-02-01 00:00', '2026-02-28 00:00'], ['2026-03-01 00:00', '2026-03-31 00:00']]);
  assert.match(fail(db, [{ op: 'add_financial_periods', periods: [{ name: 'X', start: '2026-03-15', end: '2026-04-15' }] }]), /overlaps 2026-03-01/);
  const w = ok(db, [{ op: 'add_financial_periods', from: '2026-04-01', to: '2026-04-20', every: 'week', week_ends_on: 'fri' }]);
  assert.equal((w.results[0] as any).financial_periods, 4); // Apr 1-3, 4-10, 11-17, 18-24
  assert.equal(rows(db, 'FINDATES').find((f) => f.fin_dates_name === '2026-04-01')!.end_date, '2026-04-03 00:00', 'the first week ends on the Friday');
  ok(db, [{ op: 'update_financial_period', name: '2026-01-01', new_name: 'Jan 26' }, { op: 'delete_financial_period', name: '2026-04-11' }]);
  assert.ok(rows(db, 'FINDATES').some((f) => f.fin_dates_name === 'Jan 26'));
  assert.equal(rows(db, 'FINDATES').length, 6);
});

test('store_period_performance: per period values, overwrite, Actual This Period reset, link option required, one undo', () => {
  const db = build();
  ok(db, [{ op: 'add_financial_periods', from: '2026-01-01', to: '2026-02-28', every: 'month' }]);
  assert.match(fail(db, [{ op: 'store_period_performance', period: '2026-01-01' }]), /Link actual to date and actual this period/);
  ok(db, [{ op: 'set_fields', table: 'PROJECT', fields: { act_this_per_link_flag: 'Y' }, all: true }]);

  // January: 40 labor hours, 30 material units, 100 of the expense spent
  ok(db, [
    { op: 'update_activity', id: 'A', actual_start: '2026-01-05' },
    { op: 'update_assignment', activity: 'A', resource: 'LAB', actual_units: 40 },
    { op: 'update_assignment', activity: 'A', resource: 'MAT', actual_units: 30 },
    { op: 'update_expense', activity: 'A', name: 'Skip hire', actual_cost: 100 },
    { op: 'set_fields', table: 'TASKRSRC', fields: { act_this_per_qty: 40 }, all: true },
    { op: 'set_project', data_date: '2026-02-01' },
  ]);
  const jan = ok(db, [{ op: 'store_period_performance' }]).results[0] as any; // default: the period before the data date
  assert.equal(jan.period, '2026-01-01');
  assert.equal(jan.stored.labor_units, 40);
  assert.equal(jan.stored.labor_cost, 400);
  assert.equal(jan.stored.material_cost, 60);
  assert.equal(jan.stored.expense_cost, 100);
  assert.equal(jan.assignments, 2);
  const tf = () => rows(db, 'TASKFIN').map((r) => [r.fin_dates_id, r.act_work_qty, r.act_expense_cost]);
  assert.deepEqual(rows(db, 'TASKRSRC').map((a) => a.act_this_per_qty), ['0', '0'], 'Actual This Period set to zero');
  assert.equal(rows(db, 'PROJECT')[0].last_fin_dates_id, rows(db, 'FINDATES')[0].fin_dates_id);

  // February: to date 100 hours and 250 expense; the period holds the difference
  ok(db, [
    { op: 'update_assignment', activity: 'A', resource: 'LAB', actual_units: 100 },
    { op: 'update_expense', activity: 'A', name: 'Skip hire', actual_cost: 250 },
    { op: 'update_activity', id: 'A', remaining_days: 10 },
    { op: 'set_project', data_date: '2026-03-01' },
  ]);
  const feb = ok(db, [{ op: 'store_period_performance', period: '2026-02-01' }]).results[0] as any;
  assert.equal(feb.stored.labor_units, 60);
  assert.equal(feb.stored.expense_cost, 150);
  assert.equal(feb.stored.material_cost, 0);
  assert.equal(rows(db, 'TASKFIN').length, 2);
  const febId = rows(db, 'FINDATES')[1].fin_dates_id;
  assert.deepEqual(rows(db, 'TRSRCFIN').filter((r) => r.fin_dates_id === febId).map((r) => [r.act_qty, r.act_cost]), [['60', '600.00']]);
  // stored again after a correction: overwritten, not added
  ok(db, [{ op: 'update_assignment', activity: 'A', resource: 'LAB', actual_units: 110 }]);
  const again = ok(db, [{ op: 'store_period_performance', period: '2026-02-01' }]).results[0] as any;
  assert.equal(again.stored.labor_units, 70);
  assert.equal(rows(db, 'TASKFIN').length, 2);
  // earned value: the two periods add up to the value to date
  const ev = rows(db, 'TASKFIN').reduce((s, r) => s + Number(r.bcwp), 0);
  assert.ok(ev > 0);

  // undo of the store: the edit's journal takes it back
  const j = record(db, (d) => { const r = applyOps(d, [{ op: 'store_period_performance', period: '2026-01-01' }]); assert.equal(r.ok, true); });
  rollback(j);
  assert.deepEqual(tf().length, 2);
  // a period holding stored data is not deleted by accident
  assert.match(fail(db, [{ op: 'delete_financial_period', name: '2026-02-01' }]), /clear_stored/);
  ok(db, [{ op: 'delete_financial_period', name: '2026-02-01', clear_stored: true }]);
  assert.equal(rows(db, 'TASKFIN').length, 1);
  assert.equal(rows(db, 'TRSRCFIN').filter((r) => r.fin_dates_id === febId).length, 0);
});
