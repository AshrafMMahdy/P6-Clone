import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { buildInstance, optimizeSchedule, reasonerInputs, reasonerOutput, REASONER_WINDOW, serialSgs, type HrmActivity, type HrmInstance, type ReasonerInputs } from '../core/analysis/hrm.ts';
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

/** A made instance: `chains` chains of `len` activities one after another (durations 1..5), each on one of three trades. */
function madeInstance(chains: number, len: number, crew = 2, cap = 4): HrmInstance {
  const acts: HrmActivity[] = [];
  for (let c = 0; c < chains; c++) for (let k = 0; k < len; k++) {
    const id = acts.length, d = 1 + ((c * 7 + k * 3) % 5);
    acts.push({ id, task: { task_id: String(id), task_code: `A${id}` } as HrmActivity['task'], duration: d, preds: k ? [{ id: id - 1, type: 'FS', lag: 0 }] : [], group: `T${c % 3}`, crewSize: crew, modes: [{ duration: d, crewSize: crew, cost: 0 }], started: false });
  }
  return { acts, caps: new Map([['T0', cap], ['T1', cap], ['T2', cap]]) };
}
/** A stand-in for the model: it records what it was shown and answers a priority that is not in the order shown. */
function recordingInfer() {
  const seen: ReasonerInputs[] = [];
  const infer = async (x: ReasonerInputs) => { seen.push(x); return { priority: Float32Array.from({ length: x.n }, (_, k) => Math.sin(k * 12.9898) * 2.5), modeLogits: new Float32Array(x.n * 3) }; };
  return { seen, infer };
}

test('the reasoner reads a schedule of any size: up to 512 activities at once, a larger one 512 at a time in order of earliest start (owner 2026-11-09)', async () => {
  // a small one: the whole network in one reading
  const small = madeInstance(4, 100), s1 = recordingInfer();
  const o1 = await reasonerOutput(small, s1.infer);
  assert.deepEqual([o1.windows, s1.seen.length, s1.seen[0].n], [1, 1, 400]);
  // 3,300 activities (past the 3,000 that used to be refused): 7 readings, none larger than the window, every activity read once
  const big = madeInstance(33, 100), s2 = recordingInfer();
  const o2 = await reasonerOutput(big, s2.infer);
  assert.equal(o2.windows, Math.ceil(3300 / REASONER_WINDOW));
  assert.deepEqual(s2.seen.map((x) => x.n), [512, 512, 512, 512, 512, 512, 228]);
  assert.equal(o2.priority.length, 3300);
  // the windows are in order of earliest start: here the k-th activities of the chains start together, so window 0 holds the first of every chain
  const early = serialSgs(big.acts, big.acts.map((a) => a.duration), new Map()).start;
  const byStart = big.acts.map((_, i) => i).sort((a, b) => early[a] - early[b] || a - b);
  const win = (w: number) => byStart.slice(w * REASONER_WINDOW, (w + 1) * REASONER_WINDOW);
  for (let w = 0; w + 1 < o2.windows; w++) {
    const lowest = Math.min(...win(w).map((id) => o2.priority[id])), nextHighest = Math.max(...win(w + 1).map((id) => o2.priority[id]));
    assert.ok(lowest > nextHighest, `window ${w}: every activity ahead of every activity of window ${w + 1} (${lowest} > ${nextHighest})`);
  }
  // inside a window the order is the model's own (its priorities, as it answered them for that window)
  for (let w = 0; w < o2.windows; w++) {
    const ids = win(w), model = ids.map((_, k) => Math.fround(Math.sin(k * 12.9898) * 2.5));
    const got = ids.map((_, k) => k).sort((a, b) => o2.priority[ids[b]] - o2.priority[ids[a]]), want = ids.map((_, k) => k).sort((a, b) => model[b] - model[a]);
    assert.deepEqual(got, want, `window ${w}: the model's order kept`);
  }
  // a window is its own network: only the links inside it (the bias marks no pair that the window's links do not join)
  const w0 = win(0), at = new Map(w0.map((id, k) => [id, k])), x0 = s2.seen[0];
  const joined = (a: number, b: number) => x0.bias[a * x0.n + b] === 1;
  const idA = w0.find((id) => big.acts[id].preds.length && at.has(big.acts[id].preds[0].id))!, idP = big.acts[idA].preds[0].id;
  assert.ok(joined(at.get(idA)!, at.get(idP)!), 'a link inside the window is there');
  const lone = w0.find((id) => big.acts[id].preds.length && !at.has(big.acts[id].preds[0].id));
  if (lone != null) assert.equal(x0.feats.length, x0.n * 9);
  // the same instance twice: the same answer (nothing random in the reading)
  const again = await reasonerOutput(big, recordingInfer().infer);
  assert.deepEqual(Array.from(again.priority), Array.from(o2.priority));
});

test('a crew larger than its limit is placed where the day-by-day search ends, without the search: the same placement, at once', () => {
  // the search as it was (the reference): every day from the earliest tried until the crew fits or the horizon is passed
  const slow = (inst: HrmInstance) => {
    const acts = inst.acts, dur = acts.map((a) => a.duration), start: number[] = [], finish: number[] = [], usage = new Map<string, Map<number, number>>();
    const horizon = Math.max(1, dur.reduce((x, d) => x + d, 0) + 1);
    // in precedence order as serialSgs takes it with no priority: the activities with no predecessor as listed, then each as its last predecessor is placed
    const indeg = acts.map((x) => x.preds.length), succ: number[][] = acts.map(() => []), order: number[] = acts.filter((x) => !x.preds.length).map((x) => x.id);
    for (const x of acts) for (const p of x.preds) succ[p.id].push(x.id);
    for (let i = 0; i < order.length; i++) for (const n of succ[order[i]]) if (--indeg[n] === 0) order.push(n);
    for (const id of order) {
      const a = acts[id], d = dur[a.id], cap = inst.caps.get(a.group) ?? Infinity; let t = 0;
      for (const p of a.preds) t = Math.max(t, finish[p.id] + p.lag);
      const u = usage.get(a.group) ?? usage.set(a.group, new Map()).get(a.group)!;
      const fits = (t0: number) => { for (let day = t0; day < t0 + d; day++) if ((u.get(day) ?? 0) + a.crewSize > cap + 1e-9) return false; return true; };
      for (let guard = 0; !fits(t) && guard <= horizon; guard++) t++;
      start[a.id] = t; finish[a.id] = t + d;
      for (let day = t; day < t + d; day++) u.set(day, (u.get(day) ?? 0) + a.crewSize);
    }
    return { start, finish };
  };
  // a mix: crews of 2 under a limit of 4, and every seventh activity needing 9 of a limit of 4
  const inst = madeInstance(6, 40);
  inst.acts.forEach((a) => { if (a.id % 7 === 3) { a.crewSize = 9; a.modes = [{ duration: a.duration, crewSize: 9, cost: 0 }]; } });
  const want = slow(inst), got = serialSgs(inst.acts, inst.acts.map((a) => a.duration), inst.caps);
  assert.deepEqual(got.start, want.start);
  assert.deepEqual(got.finish, want.finish);
  // 2,400 activities that fit on no day, on a horizon of 40,000 days: placed at once (the search took seconds per placement)
  const never = madeInstance(60, 40, 9, 4), t0 = Date.now();
  never.acts.forEach((a) => { a.duration = 17; a.modes = [{ duration: 17, crewSize: 9, cost: 0 }]; });
  const r = serialSgs(never.acts, never.acts.map((a) => a.duration), never.caps);
  assert.ok(r.makespan > 40000 && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
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
  // biggest_changes: the activities whose dates differ between cpm and the reasoner, the largest finish shift first, then the start shift
  assert.equal(r.biggest_changes_total, r.dates.filter((x) => x.cpm[0] !== x.reasoner[0] || x.cpm[1] !== x.reasoner[1]).length);
  assert.equal(r.biggest_changes.length, r.biggest_changes_total);
  assert.ok(r.biggest_changes_total > 0);
  assert.deepEqual(Object.keys(r.biggest_changes[0]), ['id', 'name', 'cpm_start', 'cpm_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days']);
  const keys = r.biggest_changes.map((x) => [Math.abs(x.finish_delta_days ?? 0), Math.abs(x.start_delta_days ?? 0)]);
  assert.deepEqual(keys, [...keys].sort((x, y) => y[0] - x[0] || y[1] - x[1]));
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
