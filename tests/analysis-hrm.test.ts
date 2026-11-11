import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { buildInstance, classicPriorities, decode, instanceHorizon, optimizeSchedule, reasonerInputs, reasonerOutput, ReasonerBadAnswer, REASONER_WINDOW, serialSgs, type HrmActivity, type HrmInstance, type ReasonerInputs } from '../core/analysis/hrm.ts';
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
  // …and nothing else: the pairs the model is told share a path are exactly those of one chain inside this window
  // (a chain's activities are one after another, so m of them in the window are m x (m - 1) ordered pairs)
  for (let w = 0; w < o2.windows; w++) {
    const perChain = new Map<number, number>();
    for (const id of win(w)) perChain.set(Math.floor(id / 100), (perChain.get(Math.floor(id / 100)) ?? 0) + 1);
    let want = 0; for (const m of perChain.values()) want += m * (m - 1);
    let got = 0; for (const v of s2.seen[w].bias) got += v;
    assert.equal(got, want, `window ${w}: only its own links`);
  }
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
  assert.ok(r.makespan > 40000, String(r.makespan));
  void t0;
});

test('the pick of the next activity (a heap) is the scan it replaced: the highest priority, ties to the one eligible first', () => {
  // the scan as it was: every eligible activity looked at for every placement
  const scan = (acts: HrmActivity[], priority: number[]) => {
    const indeg = acts.map((a) => a.preds.length), succ: number[][] = acts.map(() => []), order: number[] = [];
    for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
    const eligible = new Set(acts.filter((a) => !indeg[a.id]).map((a) => a.id));
    while (eligible.size) { let pick = -1, best = -Infinity; for (const id of eligible) if (priority[id] > best) { best = priority[id]; pick = id; } eligible.delete(pick); order.push(pick); for (const s of succ[pick]) if (--indeg[s] === 0) eligible.add(s); }
    return order;
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 40; round++) {
    // a random network (links only to earlier activities), priorities from a few values so ties are many
    const n = 30 + Math.floor(rnd() * 200), acts: HrmActivity[] = [];
    for (let id = 0; id < n; id++) {
      const preds = id ? Array.from(new Set(Array.from({ length: Math.floor(rnd() * 3) }, () => Math.floor(rnd() * id)))).map((p) => ({ id: p, type: 'FS' as const, lag: 0 })) : [];
      acts.push({ id, task: { task_id: String(id), task_code: `A${id}` } as HrmActivity['task'], duration: 1 + Math.floor(rnd() * 4), preds, group: 'T0', crewSize: 1, modes: [{ duration: 1, crewSize: 1, cost: 0 }], started: false });
    }
    const priority = acts.map(() => Math.floor(rnd() * 4)), dur = acts.map((a) => a.duration);
    // the placements are the same if and only if the order is: compare with the scan's order placed one by one (no resource limit: start = the latest predecessor's finish)
    const order = scan(acts, priority), start: number[] = [], finish: number[] = [];
    for (const id of order) { let t = 0; for (const p of acts[id].preds) t = Math.max(t, finish[p.id]); start[id] = t; finish[id] = t + dur[id]; }
    // with a limit of one crew the placement depends on the order alone, so an equal placement proves an equal order
    const one = new Map([['T0', 1]]), got = serialSgs(acts, dur, one, priority);
    const u = new Set<number>(), s2: number[] = [], f2: number[] = [];
    for (const id of order) { let t = 0; for (const p of acts[id].preds) t = Math.max(t, f2[p.id]); const fits = (t0: number) => { for (let d = t0; d < t0 + dur[id]; d++) if (u.has(d)) return false; return true; }; while (!fits(t)) t++; s2[id] = t; f2[id] = t + dur[id]; for (let d = t; d < t + dur[id]; d++) u.add(d); }
    assert.deepEqual(got.start, s2, `round ${round}`);
  }
});

test('a model answer that is not a number is refused by name, never ordered by', async () => {
  const big = madeInstance(8, 100);
  for (const bad of [NaN, Infinity, -Infinity]) {
    let calls = 0;
    const infer = async (x: ReasonerInputs) => { const r = { priority: Float32Array.from({ length: x.n }, (_, k) => Math.sin(k)), modeLogits: new Float32Array(x.n * 3) }; if (calls++ === 1) r.priority[5] = bad; return r; };
    await assert.rejects(() => reasonerOutput(big, infer), (e: unknown) => e instanceof ReasonerBadAnswer && /activity A\d+/.test((e as Error).message), String(bad));
  }
  // through optimizeSchedule: a refusal in words (reasoner_failed), and the project untouched
  const { db, pid } = project(4);
  const before = JSON.stringify(rows(db, 'TASK'));
  const nan = async (x: ReasonerInputs) => ({ priority: new Float32Array(x.n).fill(NaN), modeLogits: new Float32Array(x.n * 3) });
  const r = await optimizeSchedule(db, [pid], { seed: 1 }, nan, () => undefined);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'reasoner_failed');
  assert.equal(JSON.stringify(rows(db, 'TASK')), before);
});

test('optimize_schedule runs the embedded model and checks its answer with the P6 leveler', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { db, pid } = project(4);
  const before = JSON.stringify(db);
  const apply = (d: Db, ops: unknown[]) => { const r = applyOps(d, ops, { calendarDays: true }); assert.ok(r.ok); };
  const r = await optimizeSchedule(db, [pid], { seed: 7, samples: 50 }, nodeInfer, apply);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.stringify(db), before, 'nothing is kept');
  assert.equal(r.trajectories, 60, '50 sampled, the model\'s own answer and the nine starting placements');
  assert.ok(r.best_from && r.note?.startsWith('No crash data was given'));
  assert.equal(r.better_than_p6_leveler, true, 'beats P6 default leveling on this network (2026-07-15 against 2026-07-21)');
  assert.ok(r.reasoner_finish && r.p6_leveled_finish && r.cpm_finish);
  assert.ok(r.sgs_makespan_days >= 31);
  assert.equal(r.order.length, 12);
  // biggest_changes: the activities whose dates differ between cpm and the reasoner, the largest finish shift first, then the start shift
  assert.equal(r.biggest_changes_total, r.dates.filter((x) => x.cpm[0] !== x.reasoner[0] || x.cpm[1] !== x.reasoner[1]).length);
  assert.equal(r.biggest_changes!.length, r.biggest_changes_total);
  assert.ok(r.biggest_changes_total > 0);
  assert.deepEqual(Object.keys(r.biggest_changes![0]), ['id', 'name', 'cpm_start', 'cpm_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days']);
  const keys = r.biggest_changes!.map((x) => [Math.abs(x.finish_delta_days ?? 0), Math.abs(x.start_delta_days ?? 0)]);
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

// ---- the reasoner's search: the starting rules and the final pass over the modes (owner 2026-11-10) ----

/** A made activity: `modes` are [duration, cost] pairs after the normal one; the crew grows as the days shrink, as buildInstance makes it. */
function act(id: number, d: number, preds: number[], crash: [number, number][] = [], group = 'T', crew = 1, started = false): HrmActivity {
  return { id, task: { task_id: String(id), task_code: `A${id}` } as HrmActivity['task'], duration: d, preds: preds.map((p) => ({ id: p, type: 'FS' as const, lag: 0 })), group, crewSize: crew, started,
    modes: [{ duration: d, crewSize: crew, cost: 0 }, ...crash.map(([days, cost]) => ({ duration: days, crewSize: crew * (d / days), cost }))] };
}
const neutral = (n: number, k = 3) => ({ priority: new Float32Array(n), modeLogits: new Float32Array(n * k) });
const stand = (priority: number[]) => ({ priority: Float32Array.from(priority), modeLogits: new Float32Array(priority.length * 3) });

test('the four classic priority rules are the research code\'s, equal to hand-computed values on a small network', () => {
  // A(3) -> B(2), A -> C(4; crashable to 2), B -> D(1), C -> D, and E(5) alone
  const inst: HrmInstance = { acts: [act(0, 3, []), act(1, 2, [0]), act(2, 4, [0], [[2, 10]]), act(3, 1, [1, 2]), act(4, 5, [])], caps: new Map() };
  const r = classicPriorities(inst);
  // shortest durations 3,2,2,1,5: earliest finishes 3,5,5,6,5 so the finish is 6; latest finishes D 6, B 5, C 5, A min(5-2, 5-2) = 3, E 6
  assert.deepEqual(r.LFT, [-3, -5, -5, -6, -6]);
  // activities after each: A has B, C, D; B and C have D; D and E none
  assert.deepEqual(r.MTS, [3, 1, 1, 0, 0]);
  // longest duration (C: 4, the normal mode) plus that count
  assert.deepEqual(r.GRPW, [6, 3, 5, 1, 5]);
  assert.deepEqual(r.SPT, [-3, -2, -2, -1, -5]);
});

test('the search is never worse than the best of its nine starting placements, whatever the model answers', async () => {
  // three chains on one trade under a limit of 2 crews of 2: the order matters
  const inst = madeInstance(6, 8, 2, 4);
  inst.acts.forEach((a, i) => { if (i % 3 === 0) a.modes.push({ duration: Math.max(1, a.duration - 1), crewSize: 2, cost: 5 }); });
  const n = inst.acts.length, early = serialSgs(inst.acts, inst.acts.map((a) => a.duration), new Map()).start;
  // the model's answer is deliberately bad: the activities that start last first
  const bad = stand(early.map((v) => v * 3));
  const rules = classicPriorities(inst), normal = inst.acts.map(() => 0), shortest = inst.acts.map((a) => a.modes.length > 1 ? 1 : 0);
  const place = (modes: number[], prio: number[]) => serialSgs(inst.acts, inst.acts.map((a, i) => a.modes[modes[i]].duration), inst.caps, prio).makespan;
  const nine = [...(['LFT', 'MTS', 'GRPW', 'SPT'] as const).flatMap((k) => [place(normal, rules[k]), place(shortest, rules[k])]), place(normal, early.map((v) => -v))];
  assert.equal(nine.length, 9);
  const modelOnly = await decode(inst, bad, { samples: 0 });
  assert.equal(modelOnly.trajectories, 10);
  assert.ok(modelOnly.makespan <= Math.min(...nine), `${modelOnly.makespan} against the best starting placement ${Math.min(...nine)}`);
  assert.ok(modelOnly.makespan <= place(normal, Array.from(bad.priority)), 'and no worse than the bad answer on its own');
  assert.equal(n, 48);
  // the sampled trajectories are counted beside them
  assert.equal((await decode(inst, bad, { samples: 7, seed: 3 })).trajectories, 17);
});

test('the final pass over the modes finds what the sampling and the starting rules missed, and stops on its own', async () => {
  // two chains into a join: X (10 days, crashable to 6 for 100) is critical, Y (4 days, crashable to 2 for 50) has float. Every starting
  // placement is all-normal (10 days) or all-crashed (6 days, cost 150): the best choice, X crashed and Y not (6 days, cost 100), is in none.
  const inst: HrmInstance = { acts: [act(0, 10, [], [[6, 100]]), act(1, 4, [], [[2, 50]]), act(2, 1, [0, 1])], caps: new Map() };
  const r = await decode(inst, neutral(3), { samples: 0 });
  assert.equal(r.makespan, 7);
  assert.deepEqual(r.modes, [1, 0, 0]);
  assert.equal(r.cost, 100);
  assert.equal(r.best_from, 'mode pass');
  assert.equal(r.cancelled, false);
  assert.equal(r.improvable, 2);
  // two passes: the first changes Y back, the second changes nothing (4 trials: each of the two activities is tried in the other mode)
  assert.equal(r.mode_passes, 2);
  assert.ok(r.mode_trials >= 4);
  // every trial is ticked with the pass it belongs to
  const said: string[] = [];
  await decode(inst, neutral(3), { samples: 0, tick: async (_d, _t, m) => { said.push(m); } });
  const trials = said.filter((m) => m.startsWith('improving the modes'));
  assert.equal(trials.length, r.mode_trials);
  assert.ok(trials.every((m) => /^improving the modes: activity \d of 2, pass \d$/.test(m)));
  // and each of the nine starting placements is ticked before it is made (a cancel there is the caller's, as in the sampling)
  assert.equal(said.length - trials.length, 9);
  assert.ok(said.slice(0, 9).every((m, k) => m.startsWith(`starting placement ${k + 1} of 9: `)));
});

test('a cancel in the final pass keeps the best found so far and says it was stopped; optimize_schedule answers it partial and applies nothing', async () => {
  const inst: HrmInstance = { acts: [act(0, 10, [], [[6, 100]]), act(1, 4, [], [[2, 50]]), act(2, 1, [0, 1])], caps: new Map() };
  const stopAt = (nth: number) => { let k = 0; return async (_d: number, _t: number, m: string) => { if (m.startsWith('improving the modes') && ++k === nth) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); }; };
  // stopped before the first trial: the best of the starting placements stands (all crashed, 6 + 1 days, cost 150)
  const none = await decode(inst, neutral(3), { samples: 0, tick: stopAt(1) });
  assert.deepEqual([none.cancelled, none.mode_trials, none.makespan, none.cost], [true, 0, 7, 150]);
  // stopped at the third trial: the second one was kept (X back to normal was worse; Y back to normal kept: cost 100)
  const some = await decode(inst, neutral(3), { samples: 0, tick: stopAt(3) });
  assert.deepEqual([some.cancelled, some.mode_trials, some.makespan, some.cost], [true, 2, 7, 100]);
  // a cancel in the sampling is the caller's, as before
  await assert.rejects(() => decode(inst, neutral(3), { samples: 5, tick: async (_d, _t, m) => { if (m.startsWith('trajectory')) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); } }), (e: unknown) => (e as { code?: string }).code === 'cancelled');
  // through optimizeSchedule: a partial answer with its proposal, finishes in real dates, and a note
  const { db, pid } = project(4);
  const crash = [{ id: 'A5', crash_days: 4, crash_cost: 900 }, { id: 'A2', crash_days: 4, crash_cost: 500 }];
  const done = await optimizeSchedule(db, [pid], { samples: 3, seed: 1, activities: crash }, async (x) => stand(Array.from({ length: x.n }, (_, k) => k)), () => undefined);
  assert.ok(done.ok && !done.partial);
  const before = JSON.stringify(db);
  const cut = await optimizeSchedule(db, [pid], { samples: 3, seed: 1, activities: crash, tick: stopAt(2) }, async (x) => stand(Array.from({ length: x.n }, (_, k) => k)), (d, ops) => { assert.ok(applyOps(d, ops as never, { calendarDays: true }).ok); });
  assert.ok(cut.ok);
  assert.equal(cut.ok && cut.partial, true);
  assert.equal(cut.ok && cut.stopped, 'cancelled');
  assert.match(cut.ok ? cut.partial_note! : '', /Cancelled in the final pass over the modes/);
  assert.ok(cut.ok && cut.reasoner_finish && cut.p6_leveled_finish, 'the checks in real dates are made');
  assert.equal(JSON.stringify(db), before, 'nothing was changed');
});

test('the answer says what won, and with no crash data why there was no mode to choose', async () => {
  const { db, pid } = project(4);
  const infer = async (x: ReasonerInputs) => stand(Array.from({ length: x.n }, (_, k) => Math.sin(k)));
  const plain = await optimizeSchedule(db, [pid], { samples: 5, seed: 1 }, infer, () => undefined);
  assert.ok(plain.ok);
  assert.equal(plain.note, "No crash data was given, so there was no mode to choose: this is the best placement found among the model's own answer, the classic rules' orders and the sampled variations of the model's answer. Give crash data (activities: [{id, crash_days, crash_cost} \u2026]) for the reasoner to choose what to shorten.");
  assert.match(plain.best_from, /^(model|sampled|(LFT|MTS|GRPW|SPT) \((normal|shortest) modes\)|earliest start \(no resource limit\))$/);
  assert.equal(plain.mode_trials, undefined);
  assert.equal(plain.trajectories, 15);
  // crash data on an id that is not there: said, not the same note
  const ghost = await optimizeSchedule(db, [pid], { samples: 1, activities: [{ id: 'NOPE', crash_days: 1, crash_cost: 1 }] }, infer, () => undefined);
  assert.ok(ghost.ok && /^Crash data was given, but no activity in it can be shortened/.test(ghost.note!));
  // with crash data: no note, the pass ran
  const crash = await optimizeSchedule(db, [pid], { samples: 1, activities: [{ id: 'A5', crash_days: 4, crash_cost: 900 }] }, infer, () => undefined);
  assert.ok(crash.ok);
  assert.equal(crash.note, undefined);
  assert.ok(crash.mode_passes! >= 1 && crash.mode_trials! >= 1);
});

// ---- apply writes down what it changed: user-defined fields beside each activity (owner 2026-11-10) ----

test('apply writes the WHIQ fields beside each changed activity in the same undoable change: written, undone, replaced on a second apply, and kept by a saved XER', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setRoots } = await import('../mcp/runtime.ts');
  setRoots(null, tmpdir());
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'WQ', start: '2026-06-01' })).d, h = np.handle, owner_key = np.owner_key;
  // A (10 days) then B (5 days) in a chain, C (6 days) alone: A is critical and cheap to crash
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 20 }];
  for (const [id, d] of [['A', 10], ['B', 5], ['C', 6]] as const) ops.push({ op: 'add_activity', id, name: `Activity ${id}`, duration_days: d }, { op: 'assign_resource', activity: id, resource: 'civil', units_per_day: 16 });
  ops.push({ op: 'add_relationship', pred: 'A', succ: 'B' });
  assert.equal((await call('edit', { handle: h, owner_key, operations: ops })).err, false);
  await call('schedule', { handle: h, owner_key });
  // what the project holds of the fields: UDF type labels, and each activity's values by label
  const fields = async () => {
    const tbl = async (table: string) => { const r = (await call('read_table', { handle: h, table })).d; return r.rows ? r : { columns: [], rows: [] }; }; // (a table the project has not got yet: empty)
    const types = await tbl('UDFTYPE'), vals = await tbl('UDFVALUE'), tasks = await tbl('TASK');
    const col = (t: any, c: string) => t.columns.indexOf(c);
    const label = new Map<string, string>(types.rows.map((r: string[]) => [r[col(types, 'udf_type_id')], r[col(types, 'udf_type_label')]]));
    const code = new Map<string, string>(tasks.rows.map((r: string[]) => [r[col(tasks, 'task_id')], r[col(tasks, 'task_code')]]));
    const out: Record<string, Record<string, string>> = {};
    for (const r of vals.rows) { const l = label.get(r[col(vals, 'udf_type_id')]); if (!l?.startsWith('WHIQ')) continue; (out[code.get(r[col(vals, 'fk_id')])!] ??= {})[l] = r[col(vals, 'udf_number')] || r[col(vals, 'udf_text')]; }
    return { labels: [...label.values()].filter((l) => l.startsWith('WHIQ')).sort(), values: out };
  };
  assert.deepEqual((await fields()).labels, []);
  const crash = [{ id: 'A', crash_days: 6, crash_cost: 4500 }, { id: 'C', crash_days: 4, crash_cost: 100 }];
  const ap = await call('optimize_schedule', { handle: h, owner_key, seed: 1, samples: 5, activities: crash, apply: true });
  assert.equal(ap.err, false, JSON.stringify(ap.d));
  assert.equal(ap.d.applied, true);
  const f1 = await fields();
  assert.deepEqual(f1.labels, ['WHIQ change note', 'WHIQ duration change (d)', 'WHIQ leveling rank', 'WHIQ original duration (d)']);
  // A was crashed (10 to 6 d, cost 4,500); the fields are on the activities the run changed, the rank on every leveled one (all three)
  assert.equal(f1.values.A['WHIQ original duration (d)'], '10');
  assert.equal(f1.values.A['WHIQ duration change (d)'], '-4');
  assert.match(f1.values.A['WHIQ change note'], /^Crashed by the schedule reasoner \d{4}-\d{2}-\d{2}: 10 d to 6 d, cost 4,500$/);
  assert.equal(f1.values.B['WHIQ change note'], undefined, 'B was not changed');
  assert.deepEqual(['A', 'B', 'C'].map((k) => Number(f1.values[k]['WHIQ leveling rank'])).sort(), [1, 2, 3]);
  const named = new Map((ap.d.fields_written as { name: string; activities: number }[]).map((x) => [x.name, x.activities]));
  assert.equal(named.get('WHIQ original duration (d)'), Object.values(f1.values).filter((v) => v['WHIQ original duration (d)'] != null).length);
  assert.equal(named.get('WHIQ leveling rank'), 3);
  // the same change as the apply: one undo takes the fields back too (and the crashed duration)
  assert.equal((await call('undo', { handle: h, owner_key })).err, false);
  assert.deepEqual(await fields(), { labels: [], values: {} });
  // applied again, then a second apply: the original stays the first one (10: the activity is now 6 d, crashed to 3), the change is measured from it
  await call('optimize_schedule', { handle: h, owner_key, seed: 1, samples: 5, activities: crash, apply: true });
  const again = await call('optimize_schedule', { handle: h, owner_key, seed: 1, samples: 5, activities: [{ id: 'A', crash_days: 3, crash_cost: 700 }], apply: true });
  assert.equal(again.err, false, JSON.stringify(again.d));
  const f2 = await fields();
  assert.equal(f2.values.A['WHIQ original duration (d)'], '10', 'the original is written once: the second apply does not turn it into the crashed 6');
  assert.equal(f2.values.A['WHIQ duration change (d)'], '-7', 'the latest duration (3) minus the original (10)');
  assert.match(f2.values.A['WHIQ change note'], /: 6 d to 3 d, cost 700 \(original 10 d\)$/);
  const named2 = new Map((again.d.fields_written as { name: string; activities: number; kept_from_earlier: number }[]).map((x) => [x.name, x]));
  // the note and rank are the latest run's; A holds the original of the earlier run (kept, not written again)
  assert.deepEqual([named2.get('WHIQ change note')!.activities, named2.get('WHIQ change note')!.kept_from_earlier], [1, 0]);
  assert.deepEqual([named2.get('WHIQ original duration (d)')!.activities, named2.get('WHIQ original duration (d)')!.kept_from_earlier], [0, 1]);
  // the run rule (owner 2026-11-11): the second apply is run 2, so it declares WHIQ run 1 duration (d) and moves the number it replaced (6) there; the original stays 10
  assert.equal(f2.values.A['WHIQ run 1 duration (d)'], '6');
  assert.deepEqual(f2.labels, ['WHIQ change note', 'WHIQ duration change (d)', 'WHIQ leveling rank', 'WHIQ original duration (d)', 'WHIQ run 1 duration (d)']);
  // the XER saved and read again still has them
  const dir = mkdtempSync(join(tmpdir(), 'p6-whiq-')), file = join(dir, 'whiq.xer');
  assert.equal((await call('save', { handle: h, owner_key, path: file })).err, false);
  const text = readFileSync(file, 'utf8');
  for (const l of ['WHIQ original duration (d)', 'WHIQ duration change (d)', 'WHIQ change note', 'WHIQ leveling rank']) assert.ok(text.includes(l), l);
  const re = (await call('open_file', { path: file })).d;
  const types = (await call('read_table', { handle: re.handle, table: 'UDFTYPE' })).d;
  assert.ok(['WHIQ original duration (d)', 'WHIQ change note'].every((l) => types.rows.some((r: string[]) => r.includes(l))));
  const vals = (await call('read_table', { handle: re.handle, table: 'UDFVALUE' })).d;
  assert.ok(vals.rows.length >= 6);
  // crash_schedule's apply writes the same three (its first apply: no numbered field, no rank), noted as least-cost crashing
  const np2 = (await call('new_project', { id: 'WQ2', start: '2026-06-01' })).d;
  await call('edit', { handle: np2.handle, owner_key: np2.owner_key, operations: [{ op: 'add_activity', id: 'X', name: 'X', duration_days: 10 }, { op: 'add_activity', id: 'Y', name: 'Y', duration_days: 5 }, { op: 'add_relationship', pred: 'X', succ: 'Y' }] });
  await call('schedule', { handle: np2.handle, owner_key: np2.owner_key });
  const cs = await call('crash_schedule', { handle: np2.handle, owner_key: np2.owner_key, target_days: 12, activities: [{ id: 'X', crash_days: 6, crash_cost: 400 }], apply: true });
  assert.equal(cs.err, false, JSON.stringify(cs.d));
  assert.deepEqual(cs.d.fields_written.map((x: any) => x.name), ['WHIQ original duration (d)', 'WHIQ duration change (d)', 'WHIQ change note']);
  const tv = (await call('read_table', { handle: np2.handle, table: 'UDFVALUE' })).d;
  assert.ok(tv.rows.some((r: string[]) => r.some((c) => /^Crashed \(least cost\) \d{4}-\d{2}-\d{2}: 10 d to \d+(\.\d+)? d, cost [\d,.]+$/.test(c))), JSON.stringify(tv.rows).slice(0, 400));
  assert.equal((await call('undo', { handle: np2.handle, owner_key: np2.owner_key })).err, false);
  assert.equal((await call('read_table', { handle: np2.handle, table: 'UDFVALUE' })).d.rows?.length ?? 0, 0, 'undo removes them');
});

// ---- the reasoner round 2b: over-limit placement, cancels after the search, the whole order, the WHIQ fields ----

const cancelledError = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

test('an activity whose crew exceeds its limit is placed past a horizon of the instance, not of the modes chosen: a crash that changes nothing else is not kept', async () => {
  // A needs 5 of a limit of 3 (it fits on no day); B (10 d, crashable to 5 for 1000) has 20 d of float beside C (30 d)
  const make = (withA: boolean): HrmInstance => ({ acts: [...(withA ? [act(0, 10, [], [], 'T', 5)] : []), act(withA ? 1 : 0, 10, [], [[5, 1000]], 'U'), act(withA ? 2 : 1, 30, [], [], 'V')].map((a, i) => ({ ...a, id: i })), caps: new Map([['T', 3]]) });
  const withA = make(true), alone = make(false);
  const r = await decode(withA, neutral(3), { samples: 0 });
  assert.deepEqual(r.modes, [0, 0, 0], 'B is not crashed: it only moved the over-limit activity earlier');
  assert.equal(r.cost, 0);
  assert.deepEqual((await decode(alone, neutral(2), { samples: 0 })).modes, [0, 0], 'without A, B stays normal too');
  // the same makespan whatever the modes: one horizon for the instance
  const horizon = instanceHorizon(withA.acts);
  assert.equal(horizon, 10 + 10 + 30 + 1, 'from the longest mode of each activity');
  const place = (dur: number[]) => serialSgs(withA.acts, dur, withA.caps, undefined, horizon).makespan;
  assert.equal(place([10, 10, 30]), place([10, 5, 30]));
  // with no horizon given, serialSgs keeps its own (the sum of the durations it is given): the default for other callers
  assert.notEqual(serialSgs(withA.acts, [10, 10, 30], withA.caps).makespan, serialSgs(withA.acts, [10, 5, 30], withA.caps).makespan);
});

test('optimize_schedule: a cancel at either check in real dates keeps the proposal and names what was not run; the starting placements are ticked', async () => {
  const { db, pid } = project(4);
  const crash = [{ id: 'A5', crash_days: 4, crash_cost: 900 }, { id: 'A2', crash_days: 4, crash_cost: 500 }];
  const infer = async (x: ReasonerInputs) => stand(Array.from({ length: x.n }, (_, k) => k));
  const before = JSON.stringify(db);
  const at = (re: RegExp) => async (_d: number, _t: number, m: string) => { if (re.test(m)) throw cancelledError(); };
  // before the comparison with P6's leveling: neither check was run
  const one = await optimizeSchedule(db, [pid], { samples: 2, seed: 1, activities: crash, tick: at(/^P6 leveling for comparison/) }, infer, () => undefined);
  assert.ok(one.ok && one.partial && one.stopped === 'cancelled');
  assert.match(one.partial_note!, /Cancelled before the comparison with P6's leveling/);
  assert.ok(Array.isArray(one.ops) && one.priority.length === 12 && one.mode_passes, 'the proposal found is kept');
  for (const k of ['cpm_finish', 'p6_leveled_finish', 'reasoner_finish', 'better_than_p6_leveler', 'biggest_changes', 'biggest_changes_total']) assert.equal(k in one, false, `${k} was not computed: absent, not invented`);
  assert.deepEqual(one.dates, []);
  // before the leveling in the proposed order: P6's was done
  const two = await optimizeSchedule(db, [pid], { samples: 2, seed: 1, activities: crash, tick: at(/^leveling in the proposed order/) }, infer, () => undefined);
  assert.ok(two.ok && two.partial);
  assert.match(two.partial_note!, /Cancelled before the leveling in the proposed order/);
  assert.ok(two.p6_leveled_finish && two.cpm_finish);
  for (const k of ['reasoner_finish', 'better_than_p6_leveler', 'biggest_changes']) assert.equal(k in two, false, k);
  // a cancel that landed in the final pass stays (the tick throws again): the two checks are not run, the answer is at once
  let calls = 0;
  const sticky = await optimizeSchedule(db, [pid], { samples: 2, seed: 1, activities: crash, tick: async (_d, _t, m) => { if (m.startsWith('improving the modes') && ++calls === 1) { cancelledFlag = true; } if (cancelledFlag) throw cancelledError(); } }, infer, () => undefined);
  assert.ok(sticky.ok && sticky.partial);
  assert.match(sticky.partial_note!, /Cancelled in the final pass over the modes/);
  assert.match(sticky.partial_note!, /Cancelled before the comparison with P6's leveling/);
  assert.equal('p6_leveled_finish' in sticky, false);
  assert.equal(JSON.stringify(db), before, 'nothing was changed');
  // a cancel between the starting placements is the caller's (as in the sampling)
  await assert.rejects(() => optimizeSchedule(db, [pid], { samples: 2, seed: 1, activities: crash, tick: at(/^starting placement 4 of 9/) }, infer, () => undefined), (e: unknown) => (e as { code?: string }).code === 'cancelled');
  // and a run that is not cancelled answers every check, with none of this
  const done = await optimizeSchedule(db, [pid], { samples: 2, seed: 1, activities: crash }, infer, () => undefined);
  assert.ok(done.ok && !done.partial && done.reasoner_finish && done.p6_leveled_finish && done.biggest_changes);
});
let cancelledFlag = false;

test('optimize_schedule max_priority: the order listed is as long as asked (default 100, 0 = all), priority_total and the whole order stay', async () => {
  const { db, pid } = project(4);
  const infer = async (x: ReasonerInputs) => stand(Array.from({ length: x.n }, (_, k) => Math.sin(k)));
  const crash = [{ id: 'A5', crash_days: 4, crash_cost: 900 }];
  const dflt = await optimizeSchedule(db, [pid], { samples: 1, seed: 1, activities: crash }, infer, () => undefined);
  const three = await optimizeSchedule(db, [pid], { samples: 1, seed: 1, activities: crash, maxPriority: 3 }, infer, () => undefined);
  const all = await optimizeSchedule(db, [pid], { samples: 1, seed: 1, activities: crash, maxPriority: 0 }, infer, () => undefined);
  assert.ok(dflt.ok && three.ok && all.ok);
  assert.equal(dflt.priority.length, 12, 'fewer than 100: all of them');
  assert.deepEqual(three.priority, all.priority.slice(0, 3));
  assert.equal(three.priority_total, 12);
  assert.equal(all.priority.length, 12);
  assert.equal(all.priority_rows.length, 12);
  assert.deepEqual(all.priority_rows.map((x) => x.id), all.priority);
  const big = madeInstance(1, 1); void big;
});

test('the fields of a change are the hours actually written: 20 h on an 8 h day crashed from 3 rounded days to 2 is 2.5 d to 1.67 d', async () => {
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'F', start: '2026-06-01' }, { op: 'add_activity', id: 'X', name: 'X', duration_days: 2.5 }], { calendarDays: true }).ok);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  const r = await optimizeSchedule(db, [pid], { samples: 1, seed: 1, activities: [{ id: 'X', crash_days: 2, crash_cost: 10 }] }, async (x) => stand(Array.from({ length: x.n }, () => 0)), () => undefined);
  assert.ok(r.ok);
  assert.deepEqual(r.field_changes.map(({ task_id: _t, ...c }) => c), [{ id: 'X', project: 'F', from_days: 2.5, to_days: 1.67, cost: 10 }]);
  const op = r.ops[0] as { duration_hours: number };
  assert.ok(Math.abs(op.duration_hours - 40 / 3) < 1e-9, `the hours written ${op.duration_hours} are the ones the fields show`);
});

test('whiqRunOps (the one rule of every apply): the original is written once, the change is measured from it, the note says so, and values of earlier runs on other activities are counted', async () => {
  const { whiqRunOps, whiqFieldClash } = await import('../core/analysis/whiq-fields.ts');
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'W', start: '2026-06-01' }, ...['A', 'B'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 10 }))], { calendarDays: true }).ok);
  const task = (code: string) => rows(db, 'TASK').find((t) => t.task_code === code)!.task_id;
  const run = (changes: { id: string; from: number; to: number }[], ranks: string[]) => {
    assert.ok(applyOps(db, changes.map((c) => ({ op: 'update_activity', id: c.id, duration_days: c.to })), { calendarDays: true }).ok); // (the run's own durations are in before its fields are written)
    const w = whiqRunOps(db, { changes: changes.map((c) => ({ task_id: task(c.id), id: c.id, project: 'W', from_days: c.from, to_days: c.to, cost: 5 })), ranks: ranks.map((id, k) => ({ task_id: task(id), id, project: 'W', rank: k + 1 })), who: 'Crashed', on: '2026-11-10' });
    assert.ok(applyOps(db, w.ops as never, { calendarDays: true }).ok);
    return w.fields_written;
  };
  const value = (code: string, label: string) => { const t = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === label)!, v = rows(db, 'UDFVALUE').find((x) => x.udf_type_id === t.udf_type_id && x.fk_id === task(code)); return v ? v.udf_number || v.udf_text : undefined; };
  run([{ id: 'A', from: 10, to: 6 }], ['A', 'B']);
  const second = run([{ id: 'A', from: 6, to: 3 }], ['B']);
  assert.equal(value('A', 'WHIQ original duration (d)'), '10');
  assert.equal(value('A', 'WHIQ run 1 duration (d)'), '6', 'the second apply is run 2: the number it replaced');
  assert.equal(value('A', 'WHIQ duration change (d)'), '-7');
  assert.equal(value('A', 'WHIQ change note'), 'Crashed 2026-11-10: 6 d to 3 d, cost 5 (original 10 d)');
  // a rank the latest run does not give is removed (the run gave ranks: the reasoner's); B's is the latest
  assert.equal(value('A', 'WHIQ leveling rank'), undefined);
  assert.equal(value('B', 'WHIQ leveling rank'), '1');
  assert.deepEqual(second.find((f) => f.name === 'WHIQ original duration (d)'), { name: 'WHIQ original duration (d)', activities: 0, kept_from_earlier: 1 });
  // a field with the label and another type: found before anything is written
  assert.equal(whiqFieldClash(db, { changes: [1] }), undefined);
  assert.ok(applyOps(db, [{ op: 'delete_udf', udf: 'WHIQ change note' }, { op: 'add_udf', name: 'whiq change note', data_type: 'number' }], { calendarDays: true }).ok);
  const clash = whiqFieldClash(db, { changes: [1] })!;
  assert.deepEqual([clash.field, clash.found, clash.needed], ['whiq change note', 'number', 'text']);
  assert.match(clash.hint, /update_udf.*delete_udf.*ops/);
  assert.equal(whiqFieldClash(db, { changes: [] }), undefined, 'a field this run does not write is not looked at');
});

test('A-L2: kept_from_earlier counts the values on the activities of the run’s projects only, not those of other projects in the file', async () => {
  const { whiqRunOps } = await import('../core/analysis/whiq-fields.ts');
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'W', start: '2026-06-01' }, { op: 'add_project', id: 'X', start: '2026-06-01' },
    ...['A', 'B'].map((id) => ({ op: 'add_activity', project: 'W', id, name: id, duration_days: 10 })), ...['A', 'B', 'C'].map((id) => ({ op: 'add_activity', project: 'X', id, name: id, duration_days: 10 }))], { calendarDays: true }).ok);
  const pid = (n: string) => rows(db, 'PROJECT').find((p) => p.proj_short_name === n)!.proj_id;
  const task = (proj: string, code: string) => rows(db, 'TASK').find((t) => t.task_code === code && t.proj_id === pid(proj))!.task_id;
  const run = (changes: { proj: string; id: string }[], projIds?: string[]) => {
    for (const c of changes) assert.ok(applyOps(db, [{ op: 'update_activity', project: c.proj, id: c.id, duration_days: 6 }], { calendarDays: true }).ok);
    const w = whiqRunOps(db, { changes: changes.map((c) => ({ task_id: task(c.proj, c.id), id: c.id, project: c.proj, from_days: 10, to_days: 6, cost: 5 })), who: 'Crashed', on: '2026-11-10', projIds });
    assert.ok(applyOps(db, w.ops as never, { calendarDays: true }).ok);
    return w.fields_written.find((f) => f.name === 'WHIQ duration change (d)')!;
  };
  run([{ proj: 'W', id: 'A' }, { proj: 'X', id: 'A' }, { proj: 'X', id: 'B' }, { proj: 'X', id: 'C' }]); // an earlier run: A in W, and A, B, C in X
  assert.deepEqual(run([{ proj: 'W', id: 'B' }], [pid('W')]), { name: 'WHIQ duration change (d)', activities: 1, kept_from_earlier: 1 }, 'of W only: A kept; X’s three are not this run’s');
  assert.deepEqual(run([{ proj: 'X', id: 'A' }], [pid('X')]), { name: 'WHIQ duration change (d)', activities: 1, kept_from_earlier: 2 }, 'of X only: B and C kept; W’s two are not counted');
});

test('MCP optimize_schedule and crash_schedule apply: a field of another type with a WHIQ label refuses the apply before anything changes; a cancel just before the change applies nothing', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => { const r = await callTool(name, args, undefined, signal); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'CL', start: '2026-06-01' })).d, h = np.handle, owner_key = np.owner_key;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 20 }];
  for (const [id, d] of [['A', 10], ['B', 5], ['C', 6]] as const) ops.push({ op: 'add_activity', id, name: `Activity ${id}`, duration_days: d }, { op: 'assign_resource', activity: id, resource: 'civil', units_per_day: 16 });
  ops.push({ op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_udf', name: 'WHIQ change note', data_type: 'number' });
  assert.equal((await call('edit', { handle: h, owner_key, operations: ops })).err, false);
  await call('schedule', { handle: h, owner_key });
  const days = async () => ['A', 'B', 'C'].map(async (id) => (await call('get_activity', { handle: h, activity_id: id })).d.orig_days);
  const crash = [{ id: 'A', crash_days: 6, crash_cost: 4500 }];
  const durations = async () => Promise.all(await days());
  const was = await durations();
  const bad = await call('optimize_schedule', { handle: h, owner_key, seed: 1, samples: 3, activities: crash, apply: true });
  assert.equal(bad.d.error?.code, 'field_type_clash', JSON.stringify(bad.d).slice(0, 300));
  assert.match(bad.d.error.message, /"WHIQ change note" of type number; the apply writes text/);
  assert.match(bad.d.error.hint, /update_udf.*delete_udf.*ops/);
  assert.deepEqual(await durations(), was, 'nothing was changed');
  const badCrash = await call('crash_schedule', { handle: h, owner_key, target_days: 10, apply: true });
  assert.equal(badCrash.d.error?.code, 'field_type_clash');
  assert.deepEqual(await durations(), was);
  // the field renamed away: the apply works; but first a cancel that lands just before the change (the checkpoint added to the call)
  assert.equal((await call('edit', { handle: h, owner_key, operations: [{ op: 'delete_udf', udf: 'WHIQ change note' }] })).err, false);
  const args = { handle: h, owner_key, seed: 1, samples: 3, activities: crash };
  const real = globalThis.setImmediate;
  let count = 0, abortAt = Infinity;
  const abort = new AbortController();
  (globalThis as any).setImmediate = (fn: any, ...rest: any[]) => { if (new Error().stack!.includes('checkpoint') && ++count >= abortAt) abort.abort(); return real(fn, ...rest); };
  process.env.P6CLONE_COMPUTE_WORKERS = '0';
  try {
    const plain = await call('optimize_schedule', args);
    assert.equal(plain.err, false, JSON.stringify(plain.d).slice(0, 300));
    abortAt = count + 1; count = 0;
    const r = await call('optimize_schedule', { ...args, apply: true }, abort.signal);
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.partial, true); assert.equal(r.d.stopped, 'cancelled'); assert.equal(r.d.applied, false);
    assert.match(r.d.partial_note, /Cancelled after the leveling in the proposed order, before the changes were made/);
    assert.ok(r.d.reasoner_finish && r.d.ops.length, 'the proposal and its checks are complete');
  } finally { (globalThis as any).setImmediate = real; delete process.env.P6CLONE_COMPUTE_WORKERS; }
  assert.deepEqual(await durations(), was, 'a cancel after the leveling in the proposed order applied nothing');
  const ok = await call('optimize_schedule', { ...args, apply: true });
  assert.equal(ok.d.applied, true, JSON.stringify(ok.d).slice(0, 300));
  // max_priority through the tool
  const two = await call('optimize_schedule', { ...args, max_priority: 2 }), every = await call('optimize_schedule', { ...args, max_priority: 0 });
  assert.equal(two.d.priority.length, 2); assert.equal(two.d.priority_total, 3);
  assert.equal(every.d.priority.length, 3);
  assert.equal((await call('optimize_schedule', { ...args, max_priority: -1 })).d.error?.code, 'bad_input');
});
