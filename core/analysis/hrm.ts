// The White Hat IQ schedule reasoner (HRM, models/reasoner.onnx), embedded: it picks each activity's mode (normal or
// crashed) and a placement priority so the resource-limited schedule finishes soonest. Ported from the platform
// (reasonerFeatures.ts, sgs.ts, reasonerOnnx.ts): the features must match training exactly. What changed on the way in:
// the instance comes from the project's own remaining durations, calendars, assignments and Max Units/Time; the
// sample count and seed are parameters; the best proposal is then checked with the clone's own P6 leveler, against
// P6's default leveling, so the answer is in real dates. Inference is passed in (infer), so this file stays pure: the
// MCP server and CLI run the model in Node (hrmRuntime.ts), the desktop app through its main process.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { dayHours } from '../project/units.ts';
import { scheduleProjects } from '../schedule/cpm.ts';
import { levelResources } from '../level/level.ts';
import { onScratch } from './batch.ts';
import type { CrashActivity } from './crash.ts';
import { isLoe, isWbs, type Tick } from './common.ts';

export const REASONER_KMAX = 3;
/** the precedence bias is n x n floats: past this the model gets slow and large */
export const REASONER_MAX_ACTIVITIES = 3000;

export interface HrmMode { duration: number; crewSize: number; cost: number }
export interface HrmPred { id: number; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }
export interface HrmActivity { id: number; task: Row; duration: number; preds: HrmPred[]; group: string; crewSize: number; modes: HrmMode[]; started: boolean }
export interface HrmInstance { acts: HrmActivity[]; caps: Map<string, number> }
export interface ReasonerInputs { n: number; feats: Float32Array; bias: Float32Array; modeMask: Uint8Array }
export type Infer = (x: ReasonerInputs) => Promise<{ priority: Float32Array; modeLogits: Float32Array }>;

const TYPE: Record<string, HrmPred['type']> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };

/** The open project as the reasoner sees it: remaining work in whole working days on each activity's calendar, the
 *  leveled resource with the most units as its crew, Max Units/Time as the cap, crash data as a second mode. */
export function buildInstance(db: Db, projIds: string[], o: { activities?: CrashActivity[]; hoursPerDay?: number } = {}): HrmInstance {
  const open = new Set(projIds), dh = dayHours(db, o.hoursPerDay ?? 8, true);
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id) && !t.act_end_date && !isWbs(t) && !isLoe(t));
  const idx = new Map(tasks.map((t, i) => [t.task_id, i]));
  const rsrc = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  const cap = new Map<string, number>();
  for (const r of rsrc.values()) if (Number(r.max_qty_per_hr) > 0) cap.set(r.rsrc_id, Number(r.max_qty_per_hr));
  for (const r of rows(db, 'RSRCRATE')) if (Number(r.max_qty_per_hr) > 0) cap.set(r.rsrc_id, Number(r.max_qty_per_hr));
  const primary = new Map<string, Row>();
  for (const a of rows(db, 'TASKRSRC')) {
    if (!idx.has(a.task_id) || !cap.has(a.rsrc_id) || rsrc.get(a.rsrc_id)?.rsrc_type === 'RT_Mat' || rsrc.get(a.rsrc_id)?.level_flag === 'N') continue;
    const cur = primary.get(a.task_id);
    if (!cur || Number(a.target_qty_per_hr || 0) > Number(cur.target_qty_per_hr || 0)) primary.set(a.task_id, a);
  }
  const crash = new Map((o.activities ?? []).map((a) => [a.id, a]));
  const preds: HrmPred[][] = tasks.map(() => []);
  for (const r of rows(db, 'TASKPRED')) {
    const a = idx.get(r.pred_task_id), b = idx.get(r.task_id);
    if (a == null || b == null) continue;
    preds[b].push({ id: a, type: TYPE[r.pred_type] ?? 'FS', lag: Math.round(Number(r.lag_hr_cnt || 0) / dh.rel(r)) });
  }
  const caps = new Map<string, number>();
  const acts = tasks.map((t, i): HrmActivity => {
    const h = dh.task(t), rem = Number(t.remain_drtn_hr_cnt || 0);
    const d = rem > 0 ? Math.max(1, Math.round(rem / h)) : 0;
    const a = primary.get(t.task_id), group = a ? rsrc.get(a.rsrc_id)?.rsrc_short_name ?? a.rsrc_id : '';
    const crew = a ? Number(a.target_qty_per_hr || 0) : 0;
    if (a) caps.set(group, cap.get(a.rsrc_id)!);
    const modes: HrmMode[] = [{ duration: d, crewSize: crew, cost: 0 }];
    const c = crash.get(t.task_code);
    if (c && d > 0) {
      const cd = c.crash_days ?? c.min_days;
      const days = cd != null ? Math.max(1, Math.round(cd)) : d;
      // crashing keeps the work: the same units over fewer days need a bigger crew
      if (days < d) modes.push({ duration: days, crewSize: crew * (d / days), cost: c.crash_cost ?? (c.cost_per_day ?? 0) * (d - days) });
    }
    return { id: i, task: t, duration: d, preds: preds[i], group, crewSize: crew, modes, started: !!t.act_start_date };
  });
  return { acts, caps };
}

function topoOrder(acts: HrmActivity[]): number[] {
  const indeg = acts.map((a) => a.preds.length), succ: number[][] = acts.map(() => []);
  for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
  const q = acts.filter((a) => !indeg[a.id]).map((a) => a.id), out: number[] = [];
  for (let i = 0; i < q.length; i++) { out.push(q[i]); for (const s of succ[q[i]]) if (--indeg[s] === 0) q.push(s); }
  if (out.length < acts.length) { const seen = new Set(out); for (const a of acts) if (!seen.has(a.id)) out.push(a.id); } // loops: the rest as listed
  return out;
}

/** The model's four inputs (featurize and precedence_bias of model.py; column order and normalisation as trained). */
export function reasonerInputs(inst: HrmInstance): ReasonerInputs {
  const acts = inst.acts, n = acts.length;
  const succ: number[][] = acts.map(() => []);
  for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
  const order = topoOrder(acts);
  const depth = new Array(n).fill(0);
  for (const u of order) for (const p of acts[u].preds) depth[u] = Math.max(depth[u], 1 + depth[p.id]);
  const raw = acts.map((a, i) => {
    const durs = a.modes.map((m) => m.duration);
    return [Math.min(...durs), Math.max(...durs), durs.reduce((x, y) => x + y, 0) / durs.length, a.modes.reduce((x, m) => x + m.crewSize, 0) / a.modes.length, a.modes.reduce((x, m) => x + (m.cost || 0), 0) / a.modes.length, a.modes.length, a.preds.length, succ[i].length, depth[i]];
  });
  const feats = new Float32Array(n * 9);
  for (let c = 0; c < 9; c++) {
    let mean = 0; for (let i = 0; i < n; i++) mean += raw[i][c]; mean /= n || 1;
    let v = 0; for (let i = 0; i < n; i++) v += (raw[i][c] - mean) ** 2;
    const std = Math.sqrt(v / (n || 1));
    for (let i = 0; i < n; i++) feats[i * 9 + c] = (raw[i][c] - mean) / (std + 1e-6);
  }
  // symmetric reachability: 1 where two activities share a directed path
  const bias = new Float32Array(n * n);
  // descendants as bit rows (n x n bits: 1.1 MB at 3,000 activities), OR-ed up in reverse precedence order
  const W = (n + 31) >>> 5, reach = new Uint32Array(n * W);
  for (let k = order.length - 1; k >= 0; k--) {
    const u = order[k], ru = u * W;
    for (const s of succ[u]) { reach[ru + (s >>> 5)] |= 1 << (s & 31); const rs = s * W; for (let w = 0; w < W; w++) reach[ru + w] |= reach[rs + w]; }
  }
  for (let u = 0; u < n; u++) for (let w = 0; w < W; w++) for (let bits = reach[u * W + w]; bits; bits &= bits - 1) { const v = (w << 5) + (31 - Math.clz32(bits & -bits)); bias[u * n + v] = 1; bias[v * n + u] = 1; }
  const modeMask = new Uint8Array(n * REASONER_KMAX);
  acts.forEach((a, i) => { for (let j = 0; j < Math.min(REASONER_KMAX, a.modes.length); j++) modeMask[i * REASONER_KMAX + j] = 1; });
  return { n, feats, bias, modeMask };
}

/** Serial schedule generation with renewable crews (the platform's sgs.ts): activities in precedence order, ties by
 *  priority (higher first), each at the earliest day its predecessors allow where its crew fits under the cap. */
export function serialSgs(acts: HrmActivity[], dur: number[], caps: Map<string, number>, priority?: number[]): { start: number[]; finish: number[]; makespan: number } {
  let order: number[];
  if (!priority) order = topoOrder(acts);
  else {
    const indeg = acts.map((a) => a.preds.length), succ: number[][] = acts.map(() => []);
    for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
    const eligible = new Set(acts.filter((a) => !indeg[a.id]).map((a) => a.id));
    order = [];
    while (eligible.size) {
      let pick = -1, best = -Infinity;
      for (const id of eligible) if (priority[id] > best) { best = priority[id]; pick = id; }
      eligible.delete(pick); order.push(pick);
      for (const s of succ[pick]) if (--indeg[s] === 0) eligible.add(s);
    }
    if (order.length < acts.length) { const seen = new Set(order); for (const a of acts) if (!seen.has(a.id)) order.push(a.id); }
  }
  const start = new Array(acts.length).fill(0), finish = new Array(acts.length).fill(0);
  const usage = new Map<string, Map<number, number>>();
  const horizon = Math.max(1, dur.reduce((s, d) => s + (Number.isFinite(d) ? d : 0), 0) + 1);
  for (const id of order) {
    const a = acts[id], d = dur[id], crew = a.crewSize * (a.duration && d ? a.duration / d : 1), cap = caps.get(a.group) ?? Infinity;
    let t = 0;
    for (const p of a.preds) {
      const c = p.type === 'SS' ? start[p.id] + p.lag : p.type === 'FF' ? finish[p.id] + p.lag - d : p.type === 'SF' ? start[p.id] + p.lag - d : finish[p.id] + p.lag;
      if (c > t) t = c;
    }
    const u = usage.get(a.group) ?? usage.set(a.group, new Map()).get(a.group)!;
    if (d > 0 && crew > 0 && cap !== Infinity) {
      const fits = (t0: number) => { for (let day = t0; day < t0 + d; day++) if ((u.get(day) ?? 0) + crew > cap + 1e-9) return false; return true; };
      for (let guard = 0; !fits(t) && guard <= horizon; guard++) t++;
    }
    start[id] = t; finish[id] = t + d;
    if (d > 0 && crew > 0) for (let day = t; day < t + d; day++) u.set(day, (u.get(day) ?? 0) + crew);
  }
  return { start, finish, makespan: Math.max(0, ...finish) };
}

/** Sampled decode around the net's answer (GRAM-style, as the platform): trajectory 0 is the net's argmax modes and
 *  priority; then `samples` more with sampled modes and jittered priority, each scored by the SGS; the best is kept. */
export async function decode(inst: HrmInstance, out: { priority: Float32Array; modeLogits: Float32Array }, o: { samples?: number; seed?: number; tick?: Tick } = {}) {
  const acts = inst.acts, n = acts.length;
  const valid: number[][] = [], probs: number[][] = [], argmax: number[] = [];
  for (let i = 0; i < n; i++) {
    const vm = acts[i].modes.map((_, k) => k).filter((k) => k < REASONER_KMAX);
    const lg = vm.map((k) => out.modeLogits[i * REASONER_KMAX + k]), mx = Math.max(...lg);
    const ex = lg.map((v) => Math.exp(v - mx)), sum = ex.reduce((x, y) => x + y, 0) || 1;
    valid.push(vm); probs.push(ex.map((e) => e / sum)); argmax.push(vm[lg.indexOf(mx)]);
  }
  // work already under way is placed first, where it is
  const netPrio = Array.from({ length: n }, (_, i) => out.priority[i] + (acts[i].started ? 1e6 : 0));
  let rs = (o.seed ?? 0x9e3779b9) >>> 0;
  const rand = () => { rs |= 0; rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());
  const run = (modes: number[], prio: number[]) => { const dur = acts.map((a, i) => a.modes[modes[i]]?.duration ?? a.duration); return { modes, prio, makespan: serialSgs(acts, dur, inst.caps, prio).makespan, cost: acts.reduce((s, a, i) => s + (a.modes[modes[i]]?.cost ?? 0), 0) }; };
  let best = run(argmax, netPrio);
  const K = o.samples ?? (n > 120 ? 64 : 200);
  for (let k = 0; k < K; k++) {
    if (o.tick && k % 16 === 0) await o.tick(k, K, `trajectory ${k} of ${K}`);
    const scale = 0.3 + rand(), sample = rand() < 0.5;
    const mc = argmax.map((am, i) => { if (!sample || valid[i].length === 1) return am; const r = rand(); let acc = 0; for (let j = 0; j < valid[i].length; j++) { acc += probs[i][j]; if (r <= acc) return valid[i][j]; } return valid[i].at(-1)!; });
    const c = run(mc, netPrio.map((p) => p + gauss() * scale));
    if (c.makespan < best.makespan || (c.makespan === best.makespan && c.cost < best.cost)) best = c;
  }
  return { ...best, trajectories: K + 1 };
}

/** Durations of the crashed modes and the placement order (Activity task_ids, highest priority first). */
export function proposalOps(inst: HrmInstance, modes: number[], multi: boolean, projCode: Map<string, string>, hoursPerDay = 8) {
  const ops: Record<string, unknown>[] = [];
  inst.acts.forEach((a, i) => {
    if (!modes[i]) return;
    const h = Number(a.task.remain_drtn_hr_cnt || 0) / (a.duration || 1) || hoursPerDay, hours = a.modes[modes[i]].duration * h;
    ops.push({ op: 'update_activity', id: a.task.task_code, project: projCode.get(a.task.proj_id), ...(a.started ? { remaining_hours: hours } : { duration_hours: hours }), assignments_follow: true });
  });
  return ops;
}

const finishOf = (d: Db, projIds: string[]) => { const open = new Set(projIds); let f = -Infinity; for (const t of rows(d, 'TASK')) if (open.has(t.proj_id)) { const v = parseP6Date(t.act_end_date || t.early_end_date); if (v != null && v > f) f = v; } return Number.isFinite(f) ? f : null; };

export interface OptimizeOptions { samples?: number; seed?: number; activities?: CrashActivity[]; hoursPerDay?: number; tick?: Tick }

export async function optimizeSchedule(db: Db, projIds: string[], o: OptimizeOptions, infer: Infer, applyOps: (d: Db, ops: unknown[]) => void) {
  const inst = buildInstance(db, projIds, o);
  const n = inst.acts.length;
  if (!n) return { ok: false as const, error: { code: 'bad_input', message: 'No remaining activities to optimise.' } };
  if (n > REASONER_MAX_ACTIVITIES) return { ok: false as const, error: { code: 'too_large', message: `${n} remaining activities; the reasoner takes up to ${REASONER_MAX_ACTIVITIES}. Use level_resources (P6's leveler) for this project, or optimise one project of the file.` } };
  const leveled = inst.acts.filter((a) => a.crewSize > 0).length, crashable = inst.acts.filter((a) => a.modes.length > 1).length;
  if (!leveled && !crashable) return { ok: false as const, error: { code: 'nothing_to_optimise', message: 'No activity uses a resource with a Max Units/Time limit and no crash data was given, so there is nothing for the reasoner to choose.' } };
  const out = await infer(reasonerInputs(inst));
  const best = await decode(inst, out, o);
  const order = inst.acts.map((a, i) => [a.task.task_id, best.prio[i]] as const).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  const projCode = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const ops = proposalOps(inst, best.modes, projIds.length > 1, projCode, o.hoursPerDay);
  // real dates: CPM, P6's default leveling (early start priority), and the reasoner's modes and order through the same leveler
  const measureLeveled = (d: Db, first?: string[]) => { const s = scheduleProjects(d, projIds, {}); if (!s.ok) throw new Error('The schedule failed.'); const cpm = finishOf(d, projIds); if (leveled) levelResources(d, projIds, { first }); return { cpm, leveled: finishOf(d, projIds) }; };
  if (o.tick) await o.tick(1, 3, 'P6 leveling for comparison');
  const p6 = onScratch(db, (d) => measureLeveled(d));
  if (o.tick) await o.tick(2, 3, 'leveling in the proposed order');
  const mine = onScratch(db, (d) => { applyOps(d, ops); return measureLeveled(d, order); });
  const fmt = (v: number | null) => (v != null ? formatP6Date(v) : null);
  const byTask = new Map(inst.acts.map((a) => [a.task.task_id, a]));
  return {
    ok: true as const,
    activities: n, leveled_activities: leveled, crashable_activities: crashable, trajectories: best.trajectories,
    cpm_finish: fmt(p6.cpm), p6_leveled_finish: fmt(p6.leveled), reasoner_finish: fmt(mine.leveled),
    better_than_p6_leveler: p6.leveled != null && mine.leveled != null ? mine.leveled < p6.leveled : null,
    sgs_makespan_days: best.makespan, crash_cost: Math.round(best.cost * 100) / 100,
    changes: inst.acts.flatMap((a, i) => (best.modes[i] ? [{ id: a.task.task_code, from_days: a.duration, to_days: a.modes[best.modes[i]].duration, cost: a.modes[best.modes[i]].cost }] : [])),
    priority: order.slice(0, 100).map((id) => byTask.get(id)!.task.task_code),
    ops, order,
  };
}
