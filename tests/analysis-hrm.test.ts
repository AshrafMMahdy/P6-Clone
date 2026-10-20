import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { buildInstance, optimizeSchedule, reasonerInputs, serialSgs } from '../core/analysis/hrm.ts';
import { nodeInfer, reasonerModelPath } from '../core/analysis/hrmRuntime.ts';

// The platform's own reasoner check: two parallel chains in one trade and a join, crew 2 each, under a cap of 4.
function project(cap: number): { db: Db; pid: string } {
  const db: Db = { tables: {} };
  const A = (id: number, d: number, preds: number[]) => [{ op: 'add_activity', id: `A${id}`, name: `A${id}`, duration_days: d }, ...preds.map((p) => ({ op: 'add_relationship', pred: `A${p}`, succ: `A${id}` }))];
  const spec: [number, number, number[]][] = [[1, 4, []], [2, 6, [1]], [3, 5, [2]], [4, 5, []], [5, 7, [4]], [6, 4, [5]], [7, 3, []], [8, 5, [7]], [9, 4, [3, 6]], [10, 6, [9, 8]], [11, 3, [10]], [12, 2, [11]]];
  const order = [...spec].sort((a, b) => a[0] - b[0]);
  const r = applyOps(db, [
    { op: 'add_project', id: 'HRM', start: '2026-06-01' },
    { op: 'add_resource', id: 'civil', name: 'Civil crew', max_units_per_hour: cap },
    ...order.flatMap(([id, d]) => A(id, d, [])),
    ...order.flatMap(([id, , preds]) => preds.map((p) => ({ op: 'add_relationship', pred: `A${p}`, succ: `A${id}` }))),
    ...order.map(([id]) => ({ op: 'assign_resource', activity: `A${id}`, resource: 'civil', units_per_day: 16 })),
  ], { calendarDays: true });
  assert.ok(r.ok, JSON.stringify(r.error));
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  return { db, pid };
}

test('reasoner instance and inputs follow the trained featurizer', () => {
  const { db, pid } = project(4);
  const inst = buildInstance(db, [pid]);
  assert.equal(inst.acts.length, 12);
  assert.deepEqual([inst.acts[0].duration, inst.acts[0].crewSize, inst.acts[0].group], [4, 2, 'civil']);
  assert.equal(inst.caps.get('civil'), 4);
  const x = reasonerInputs(inst);
  assert.equal(x.feats.length, 12 * 9);
  // A1 reaches A12 through A2, A3, A9, A10, A11; A1 and A4 share no path
  assert.equal(x.bias[0 * 12 + 11], 1);
  assert.equal(x.bias[0 * 12 + 3], 0);
  // each column is normalised
  for (let c = 0; c < 9; c++) { let m = 0; for (let i = 0; i < 12; i++) m += x.feats[i * 9 + c]; assert.ok(Math.abs(m / 12) < 1e-4); }
  // SGS: uncapped = CPM (chain 5+7+4, then 4+6+3+2 = 31 days); cap 4 with crews of 2 runs only two chains at once
  const dur = inst.acts.map((a) => a.duration);
  assert.equal(serialSgs(inst.acts, dur, new Map()).makespan, 31);
  assert.ok(serialSgs(inst.acts, dur, inst.caps).makespan >= 31);
});

test('optimize_schedule runs the embedded model and checks its answer with the P6 leveler', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { db, pid } = project(4);
  const before = JSON.stringify(db);
  const apply = (d: Db, ops: unknown[]) => { const r = applyOps(d, ops, { calendarDays: true }); assert.ok(r.ok); };
  const r = await optimizeSchedule(db, [pid], { seed: 7, samples: 50 }, nodeInfer, apply);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.stringify(db), before, 'nothing is kept');
  assert.equal(r.trajectories, 51);
  assert.equal(r.better_than_p6_leveler, true, 'beats P6 default leveling on this network (2026-07-15 against 2026-07-21)');
  assert.ok(r.reasoner_finish && r.p6_leveled_finish && r.cpm_finish);
  assert.ok(r.sgs_makespan_days >= 31);
  assert.equal(r.order.length, 12);
  // same seed, same answer
  const again = await optimizeSchedule(db, [pid], { seed: 7, samples: 50 }, nodeInfer, apply);
  assert.ok(again.ok);
  assert.deepEqual(again.priority, r.priority);
  // crash data adds a second mode the model may choose
  const c = await optimizeSchedule(db, [pid], { activities: [{ id: 'A5', crash_days: 4, crash_cost: 900 }] }, nodeInfer, apply);
  assert.ok(c.ok);
  assert.equal(c.crashable_activities, 1);
  // a plain project has nothing for the model to choose
  const empty: Db = { tables: {} };
  applyOps(empty, [{ op: 'add_project', id: 'E', start: '2026-06-01' }, { op: 'add_activity', id: 'X', name: 'X', duration_days: 3 }]);
  const e = await optimizeSchedule(empty, [rows(empty, 'PROJECT')[0].proj_id], {}, nodeInfer, apply);
  assert.equal(!e.ok && e.error.code, 'nothing_to_optimise');
});

test('MCP optimize_schedule: proposal, apply as one undoable change, min_crash_cost, clear errors', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'OPT', start: '2026-06-01' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 4 }];
  for (const [id, d] of [['A', 4], ['B', 6], ['C', 5], ['D', 7], ['E', 3]] as const) ops.push({ op: 'add_activity', id, name: id, duration_days: d }, { op: 'assign_resource', activity: id, resource: 'civil', units_per_day: 16 });
  ops.push({ op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'C', succ: 'D' });
  assert.equal((await call('edit', { handle: h, owner_key, operations: ops })).err, false);
  await call('schedule', { handle: h, owner_key });
  const r = await call('optimize_schedule', { handle: h, seed: 1, samples: 20 });
  assert.equal(r.err, false, JSON.stringify(r.d));
  assert.equal(r.d.objective, 'makespan');
  assert.ok(r.d.reasoner_finish && r.d.p6_leveled_finish);
  assert.equal(r.d.order, undefined, 'task ids stay inside');
  const ap = await call('optimize_schedule', { handle: h, owner_key, seed: 1, samples: 20, apply: true });
  assert.equal(ap.d.applied, true, JSON.stringify(ap.d));
  assert.equal((await call('undo', { handle: h, owner_key })).err, false);
  const cc = await call('optimize_schedule', { handle: h, objective: 'min_crash_cost', target_days: 1 });
  assert.equal(cc.d.objective, 'min_crash_cost');
  assert.ok(cc.d.stop);
  assert.equal((await call('optimize_schedule', { handle: h, objective: 'fastest' })).d.error.code, 'bad_input');
  const prev = process.env.P6CLONE_REASONER;
  process.env.P6CLONE_REASONER = 'Z:/nowhere/reasoner.onnx';
  try { /* the session is already loaded, so this checks only the path lookup */ assert.equal((await import('../core/analysis/hrmRuntime.ts')).reasonerModelPath(), null); } finally { if (prev == null) delete process.env.P6CLONE_REASONER; else process.env.P6CLONE_REASONER = prev; }
});
