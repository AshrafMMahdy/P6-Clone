// The White Hat IQ schedule reasoner (HRM, models/reasoner.onnx), embedded: it picks each activity's mode (normal or
// crashed) and a placement priority so the resource-limited schedule finishes soonest. Ported from the platform
// (reasonerFeatures.ts, sgs.ts, reasonerOnnx.ts): the features must match training exactly. What changed on the way in:
// the instance comes from the project's own remaining durations, calendars, assignments and Max Units/Time; the
// sample count and seed are parameters; the best proposal is then checked with the clone's own P6 leveler, against
// P6's default leveling, so the answer is in real dates. Inference is passed in (infer), so this file stays pure: the
// MCP server and CLI run the model in Node (hrmRuntime.ts), the desktop app through its main process.
import { maxOf, minOf } from '../arrays.ts';
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { dayHours } from '../project/units.ts';
import { calendarResolver, scheduleProjects } from '../schedule/cpm.ts';
import { levelResources } from '../level/level.ts';
import { onScratch } from './batch.ts';
import type { CrashActivity } from './crash.ts';
import { isLoe, isWbs, type Tick } from './common.ts';
import { fieldChange } from './whiq-fields.ts';

export const REASONER_KMAX = 3;
/** The most activities the model reads at once: the largest network it was trained on. Its inputs and its memory grow with the square
 *  of the activities (11,425 at once does not fit any PC), so a larger schedule is read a window of this many at a time (reasonerOutput):
 *  no schedule is too large for it (owner 2026-11-09; measured on real schedules: windows finish as soon as the whole network, or sooner). */
export const REASONER_WINDOW = 512;

export interface HrmMode { duration: number; crewSize: number; cost: number }
export interface HrmPred { id: number; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }
export interface HrmActivity { id: number; task: Row; duration: number; preds: HrmPred[]; group: string; crewSize: number; modes: HrmMode[]; started: boolean }
export interface HrmInstance { acts: HrmActivity[]; caps: Map<string, number> }
export interface ReasonerInputs { n: number; feats: Float32Array; bias: Float32Array; modeMask: Uint8Array }
export type Infer = (x: ReasonerInputs) => Promise<{ priority: Float32Array; modeLogits: Float32Array }>;
/** The model's answer for a whole instance (reasonerOutput): a priority and the mode scores for every activity. */
export interface ReasonerOutput { priority: ArrayLike<number>; modeLogits: ArrayLike<number>; windows: number }

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

/** Descendants as bit rows (n x n bits): row u has bit v set when v is reached from u, OR-ed up in reverse precedence order. */
function descendantRows(succ: number[][], order: number[]) {
  const n = succ.length, W = (n + 31) >>> 5, reach = new Uint32Array(n * W);
  for (let k = order.length - 1; k >= 0; k--) {
    const u = order[k], ru = u * W;
    for (const s of succ[u]) { reach[ru + (s >>> 5)] |= 1 << (s & 31); const rs = s * W; for (let w = 0; w < W; w++) reach[ru + w] |= reach[rs + w]; }
  }
  return { W, reach };
}

/** The four classic priority rules, exactly as the research code computes them (baselines.py _priority_from_rule: a higher number is
 *  placed first), on the clone's instance. Like the research they read the precedence structure (who comes before whom), not the link
 *  types or lags: the placement that follows (serialSgs) honours those. A duration is taken over every mode the activity has.
 *  LFT: the latest finish of a backward pass on each activity's shortest duration, negated (the most urgent first). MTS: the number of
 *  activities that follow it, through any chain. GRPW: its longest duration plus that number. SPT: its shortest duration, negated. */
export function classicPriorities(inst: HrmInstance): Record<'LFT' | 'MTS' | 'GRPW' | 'SPT', number[]> {
  const acts = inst.acts, n = acts.length;
  const succ: number[][] = acts.map(() => []);
  for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
  const order = topoOrder(acts);
  const shortest = acts.map((a) => minOf(a.modes.map((m) => m.duration))), longest = acts.map((a) => maxOf(a.modes.map((m) => m.duration)));
  const ef = new Array<number>(n).fill(0);
  for (const u of order) { let est = 0; for (const p of acts[u].preds) if (ef[p.id] > est) est = ef[p.id]; ef[u] = est + shortest[u]; }
  const cmax = n ? maxOf(ef) : 0, lf = new Array<number>(n).fill(cmax);
  for (let k = n - 1; k >= 0; k--) { const u = order[k]; if (succ[u].length) lf[u] = minOf(succ[u].map((s) => lf[s] - shortest[s])); }
  const { W, reach } = descendantRows(succ, order);
  const following = acts.map((_, u) => { let c = 0; for (let w = 0; w < W; w++) { let v = reach[u * W + w]; while (v) { v &= v - 1; c++; } } return c; });
  return { LFT: lf.map((v) => -v), MTS: following, GRPW: longest.map((d, i) => d + following[i]), SPT: shortest.map((d) => -d) };
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
    return [minOf(durs), maxOf(durs), durs.reduce((x, y) => x + y, 0) / durs.length, a.modes.reduce((x, m) => x + m.crewSize, 0) / a.modes.length, a.modes.reduce((x, m) => x + (m.cost || 0), 0) / a.modes.length, a.modes.length, a.preds.length, succ[i].length, depth[i]];
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
  const { W, reach } = descendantRows(succ, order);
  for (let u = 0; u < n; u++) for (let w = 0; w < W; w++) for (let bits = reach[u * W + w]; bits; bits &= bits - 1) { const v = (w << 5) + (31 - Math.clz32(bits & -bits)); bias[u * n + v] = 1; bias[v * n + u] = 1; }
  const modeMask = new Uint8Array(n * REASONER_KMAX);
  acts.forEach((a, i) => { for (let j = 0; j < Math.min(REASONER_KMAX, a.modes.length); j++) modeMask[i * REASONER_KMAX + j] = 1; });
  return { n, feats, bias, modeMask };
}

/** The horizon an activity whose crew fits on no day is placed past: one per instance, from each activity's LONGEST mode (not the modes a
 *  placement chose), so shortening one activity never moves another's over-limit placement and a crash that changes nothing else
 *  cannot lower the makespan. A search computes it once and passes it into every serialSgs call it makes. */
export function instanceHorizon(acts: HrmActivity[]): number {
  const fin = (d: number) => (Number.isFinite(d) ? d : 0);
  return Math.max(1, acts.reduce((s, a) => s + Math.max(fin(a.duration), ...a.modes.map((m) => fin(m.duration))), 0) + 1);
}

/** Serial schedule generation with renewable crews (the platform's sgs.ts): activities in precedence order, ties by
 *  priority (higher first), each at the earliest day its predecessors allow where its crew fits under the cap. `horizon`: where an
 *  over-limit crew is placed past (instanceHorizon); absent, the sum of the durations given (right for one fixed choice of modes). */
export function serialSgs(acts: HrmActivity[], dur: number[], caps: Map<string, number>, priority?: number[], horizon?: number): { start: number[]; finish: number[]; makespan: number } {
  let order: number[];
  if (!priority) order = topoOrder(acts);
  else {
    const indeg = acts.map((a) => a.preds.length), succ: number[][] = acts.map(() => []);
    for (const a of acts) for (const p of a.preds) succ[p.id].push(a.id);
    // next: the eligible activity of the highest priority, ties to the one that became eligible first. Kept in a heap: a wide network
    // has thousands eligible at once, and looking through them all for every placement made the time grow with the square of the
    // activities (40,000 all eligible: 6 s a placement run, and a proposal is 65 of them).
    const heap: number[] = [], seq = new Int32Array(acts.length);
    let nseq = 0;
    const before = (a: number, b: number) => priority[a] > priority[b] || (priority[a] === priority[b] && seq[a] < seq[b]);
    const push = (id: number) => { seq[id] = nseq++; let i = heap.push(id) - 1; while (i > 0) { const up = (i - 1) >> 1; if (!before(heap[i], heap[up])) break; [heap[i], heap[up]] = [heap[up], heap[i]]; i = up; } };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && before(heap[l], heap[m])) m = l; if (r < heap.length && before(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
      return top;
    };
    for (const a of acts) if (!indeg[a.id]) push(a.id);
    order = [];
    while (heap.length) { const pick = pop(); order.push(pick); for (const s of succ[pick]) if (--indeg[s] === 0) push(s); }
    if (order.length < acts.length) { const seen = new Set(order); for (const a of acts) if (!seen.has(a.id)) order.push(a.id); }
  }
  const start = new Array(acts.length).fill(0), finish = new Array(acts.length).fill(0);
  const usage = new Map<string, Map<number, number>>();
  horizon ??= Math.max(1, dur.reduce((s, d) => s + (Number.isFinite(d) ? d : 0), 0) + 1);
  for (const id of order) {
    const a = acts[id], d = dur[id], crew = a.crewSize * (a.duration && d ? a.duration / d : 1), cap = caps.get(a.group) ?? Infinity;
    let t = 0;
    for (const p of a.preds) {
      const c = p.type === 'SS' ? start[p.id] + p.lag : p.type === 'FF' ? finish[p.id] + p.lag - d : p.type === 'SF' ? start[p.id] + p.lag - d : finish[p.id] + p.lag;
      if (c > t) t = c;
    }
    const u = usage.get(a.group) ?? usage.set(a.group, new Map()).get(a.group)!;
    if (d > 0 && crew > 0 && cap !== Infinity) {
      // a crew larger than the limit fits on no day: where the day-by-day search below would end (past the horizon), without the search
      // (2,390 such activities made one placement of a 3,353-activity schedule take 2.9 s, and it is run 65 times)
      if (crew > cap + 1e-9) t += horizon + 1;
      else {
        const fits = (t0: number) => { for (let day = t0; day < t0 + d; day++) if ((u.get(day) ?? 0) + crew > cap + 1e-9) return false; return true; };
        for (let guard = 0; !fits(t) && guard <= horizon; guard++) t++;
      }
    }
    start[id] = t; finish[id] = t + d;
    if (d > 0 && crew > 0) for (let day = t; day < t + d; day++) u.set(day, (u.get(day) ?? 0) + crew);
  }
  return { start, finish, makespan: Math.max(0, maxOf(finish)) };
}

/** How far the lowest priority of a window sits above the highest of the next one. The sampled placements jitter every priority by a
 *  draw of spread 0.3 to 1.3 (decode), so at 1 the activities next to a window's border still change places in some trajectories and
 *  those well inside a window never leave it: the windows stay in order, their borders are explored. */
const WINDOW_GAP = 1;
/** The model answered something that is not a number for an activity. */
export class ReasonerBadAnswer extends Error {
  readonly activity: string;
  constructor(activity: string) { super(`The reasoner's model answered a value that is not a number for activity ${activity}: nothing can be ordered by it.`); this.activity = activity; }
}
/** The model's answer for the whole instance. Up to REASONER_WINDOW activities it reads the network at once. A larger one it reads a
 *  window at a time: the activities in order of their earliest start with no resource limit (ties as listed), cut into consecutive windows
 *  of REASONER_WINDOW; each window is its own small network (the links inside it), read by the model as it was trained. The windows are
 *  then put in order: every activity of an earlier window ahead of every activity of a later one, and inside a window the model's own
 *  priority. (The placement that follows, serialSgs and the P6 leveler, is always of the whole network: only the order comes from here.) */
export async function reasonerOutput(inst: HrmInstance, infer: Infer, tick?: Tick): Promise<ReasonerOutput> {
  const n = inst.acts.length;
  // an answer that is not a number for an activity orders nothing (and one such value would lift every earlier window to it): refused
  const read1 = async (acts: HrmActivity[]) => {
    const r = await infer(reasonerInputs({ acts, caps: inst.caps }));
    for (let k = 0; k < acts.length; k++) {
      let ok = Number.isFinite(r.priority[k]);
      for (let j = 0; ok && j < Math.min(REASONER_KMAX, acts[k].modes.length); j++) ok = Number.isFinite(r.modeLogits[k * REASONER_KMAX + j]);
      if (!ok) throw new ReasonerBadAnswer(String(acts[k].task.task_code ?? acts[k].id));
    }
    return r;
  };
  if (n <= REASONER_WINDOW) return { ...(await read1(inst.acts)), windows: 1 };
  const early = serialSgs(inst.acts, inst.acts.map((a) => a.duration), new Map(), undefined, instanceHorizon(inst.acts)).start;
  const byStart = inst.acts.map((_, i) => i).sort((a, b) => early[a] - early[b] || a - b);
  const windows = Math.ceil(n / REASONER_WINDOW);
  const read: { ids: number[]; priority: Float32Array; lo: number; hi: number }[] = [];
  const modeLogits = new Float32Array(n * REASONER_KMAX);
  for (let w = 0; w < windows; w++) {
    if (tick) await tick(w, windows, `reading window ${w + 1} of ${windows} (${REASONER_WINDOW} activities at a time)`);
    const ids = byStart.slice(w * REASONER_WINDOW, (w + 1) * REASONER_WINDOW), at = new Map(ids.map((id, k) => [id, k]));
    const acts = ids.map((id, k): HrmActivity => ({ ...inst.acts[id], id: k, preds: inst.acts[id].preds.filter((p) => at.has(p.id)).map((p) => ({ ...p, id: at.get(p.id)! })) }));
    const r = await read1(acts);
    ids.forEach((id, k) => { for (let j = 0; j < REASONER_KMAX; j++) modeLogits[id * REASONER_KMAX + j] = r.modeLogits[k * REASONER_KMAX + j]; });
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < ids.length; k++) { const v = r.priority[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    read.push({ ids, priority: r.priority, lo, hi });
  }
  // a window's priorities are lifted so its lowest is above the next window's highest by WINDOW_GAP: the order of the windows, then the
  // model's (64-bit: a float32 would lose the model's small differences under the lift of a long schedule)
  const priority = new Float64Array(n);
  let lift = 0;
  for (let w = windows - 1; w >= 0; w--) {
    const x = read[w];
    if (w < windows - 1) lift += read[w + 1].hi - x.lo + WINDOW_GAP;
    x.ids.forEach((id, k) => { priority[id] = x.priority[k] + lift; });
  }
  return { priority, modeLogits, windows };
}

/** Where the best placement came from: the model's own answer, a sampled trajectory around it, a classic starting rule (its name and the
 *  modes it was placed with, or the earliest start with no resource limit), or the final pass over the modes. */
export type BestFrom = 'model' | 'sampled' | 'mode pass' | (string & {});

/** The search of the research's decode_gram, in its parts: the model's answer; the nine starting placements (the four classic priority
 *  rules, each with every activity in its normal mode and with every activity in its shortest mode, and the plain earliest start with no
 *  resource limit); `samples` trajectories with sampled modes and jittered priority around the model's answer; then a final pass over
 *  the modes. Each is scored by the SGS and the best is kept: the shortest makespan, then the lowest cost, the earlier one on a tie.
 *  Work already under way is placed first in every one of them. A cancel (the tick throws code 'cancelled') between the starting
 *  placements or in the sampling is the caller's, as it always was; one in the final pass stops it there, and the best so far is the answer (cancelled: true). */
export async function decode(inst: HrmInstance, out: { priority: ArrayLike<number>; modeLogits: ArrayLike<number> }, o: { samples?: number; seed?: number; tick?: Tick } = {}) {
  const acts = inst.acts, n = acts.length;
  const valid: number[][] = [], probs: number[][] = [], argmax: number[] = [];
  for (let i = 0; i < n; i++) {
    const vm = acts[i].modes.map((_, k) => k).filter((k) => k < REASONER_KMAX);
    const lg = vm.map((k) => out.modeLogits[i * REASONER_KMAX + k]), mx = maxOf(lg);
    const ex = lg.map((v) => Math.exp(v - mx)), sum = ex.reduce((x, y) => x + y, 0) || 1;
    valid.push(vm); probs.push(ex.map((e) => e / sum)); argmax.push(vm[lg.indexOf(mx)]);
  }
  // work already under way is placed first, where it is (1e6 is above every lifted priority of reasonerOutput: a window adds its
  // range + WINDOW_GAP, about 6, so it holds to some 150,000 windows — 80 million activities)
  const first = (i: number) => (acts[i].started ? 1e6 : 0);
  const netPrio = Array.from({ length: n }, (_, i) => out.priority[i] + first(i));
  let rs = (o.seed ?? 0x9e3779b9) >>> 0;
  const rand = () => { rs |= 0; rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());
  const horizon = instanceHorizon(acts); // one for the whole search: the placements of different mode choices are comparable
  const run = (modes: number[], prio: number[], from: BestFrom) => { const dur = acts.map((a, i) => a.modes[modes[i]]?.duration ?? a.duration); return { modes, prio, from, makespan: serialSgs(acts, dur, inst.caps, prio, horizon).makespan, cost: acts.reduce((s, a, i) => s + (a.modes[modes[i]]?.cost ?? 0), 0) }; };
  type Placed = ReturnType<typeof run>;
  const better = (c: Placed, than: Placed) => c.makespan < than.makespan || (c.makespan === than.makespan && c.cost < than.cost);
  let best = run(argmax, netPrio, 'model');
  // the starting placements: each classic rule with the normal modes and with the shortest, and the earliest start with no limit
  const normal = acts.map(() => 0), shortest = acts.map((a) => a.modes.reduce((k, m, j) => (m.duration < a.modes[k].duration ? j : k), 0));
  const rules = classicPriorities(inst);
  let starts = 0;
  for (const rule of ['LFT', 'MTS', 'GRPW', 'SPT'] as const) {
    const prio = rules[rule].map((v, i) => v + first(i));
    for (const [label, modes] of [['normal modes', normal], ['shortest modes', shortest]] as const) { await o.tick?.(starts, 9, `starting placement ${starts + 1} of 9: ${rule} (${label})`); const c = run(modes, prio, `${rule} (${label})`); starts++; if (better(c, best)) best = c; }
  }
  const early = serialSgs(acts, acts.map((a) => a.duration), new Map(), undefined, horizon).start;
  await o.tick?.(starts, 9, `starting placement ${starts + 1} of 9: earliest start (no resource limit)`);
  { const c = run(normal, early.map((v, i) => -v + first(i)), 'earliest start (no resource limit)'); starts++; if (better(c, best)) best = c; }
  const K = o.samples ?? (n > 120 ? 64 : 200);
  for (let k = 0; k < K; k++) {
    if (o.tick) await o.tick(k, K, `trajectory ${k} of ${K}`); // every trajectory: on a large schedule one takes seconds, and a cancel waits for the next tick
    const scale = 0.3 + rand(), sample = rand() < 0.5;
    const mc = argmax.map((am, i) => { if (!sample || valid[i].length === 1) return am; const r = rand(); let acc = 0; for (let j = 0; j < valid[i].length; j++) { acc += probs[i][j]; if (r <= acc) return valid[i][j]; } return valid[i].at(-1)!; });
    const c = run(mc, netPrio.map((p) => p + gauss() * scale), 'sampled');
    if (better(c, best)) best = c;
  }
  // The final pass over the modes (the research's local search): with the best priority, for each activity that has a second mode (the
  // ones with crash data) try each other mode and keep it when the makespan, then the cost, is strictly lower; again from the first
  // until a whole pass changes nothing. No limit on the passes and no cut of the activities: it runs to its end.
  // It ends: a kept change strictly lowers the pair (makespan, cost), which orders the finite set of mode choices (every activity has a
  // fixed number of modes) strictly, so no choice is reached twice, and a pass that keeps nothing is the last.
  const improvable = acts.map((_, i) => i).filter((i) => valid[i].length > 1);
  let trials = 0, passes = 0, cancelled = false;
  if (improvable.length) {
    try {
      for (let changed = true; changed;) {
        changed = false; passes++;
        for (let j = 0; j < improvable.length; j++) {
          const i = improvable[j];
          for (const k of valid[i]) {
            if (k === best.modes[i]) continue;
            await o.tick?.(trials, 0, `improving the modes: activity ${j + 1} of ${improvable.length}, pass ${passes}`); // every trial: a cancel lands at once
            const trial = best.modes.slice(); trial[i] = k; trials++;
            const c = run(trial, best.prio, 'mode pass');
            if (better(c, best)) { best = c; changed = true; }
          }
        }
      }
    } catch (e) { if ((e as { code?: unknown })?.code !== 'cancelled') throw e; cancelled = true; }
  }
  return { ...best, trajectories: starts + K + 1, best_from: best.from, improvable: improvable.length, mode_trials: trials, mode_passes: passes, cancelled };
}

/** The hours an apply writes for an activity in a mode: the mode's days at the hours its remaining work spreads over each of the
 *  instance's (rounded whole) days, so 20 h over 3 days crashed to 2 days is 13.33 h. The fields beside the activity show these hours. */
export function writtenHours(a: HrmActivity, mode: number, hoursPerDay = 8): number {
  const h = Number(a.task.remain_drtn_hr_cnt || 0) / (a.duration || 1) || hoursPerDay;
  return a.modes[mode].duration * h;
}

/** Durations of the crashed modes and the placement order (Activity task_ids, highest priority first). */
export function proposalOps(inst: HrmInstance, modes: number[], multi: boolean, projCode: Map<string, string>, hoursPerDay = 8) {
  const ops: Record<string, unknown>[] = [];
  inst.acts.forEach((a, i) => {
    if (!modes[i]) return;
    const hours = writtenHours(a, modes[i], hoursPerDay);
    ops.push({ op: 'update_activity', id: a.task.task_code, project: projCode.get(a.task.proj_id), ...(a.started ? { remaining_hours: hours } : { duration_hours: hours }), assignments_follow: true });
  });
  return ops;
}

const finishOf = (d: Db, projIds: string[]) => { const open = new Set(projIds); let f = -Infinity; for (const t of rows(d, 'TASK')) if (open.has(t.proj_id)) { const v = parseP6Date(t.act_end_date || t.early_end_date); if (v != null && v > f) f = v; } return Number.isFinite(f) ? f : null; };

/** maxPriority: how many of the placement order `priority` lists (default 100; 0 = all); the whole order is in `priority_rows` and `order`. */
export interface OptimizeOptions { samples?: number; seed?: number; activities?: CrashActivity[]; hoursPerDay?: number; tick?: Tick; maxPriority?: number }

export async function optimizeSchedule(db: Db, projIds: string[], o: OptimizeOptions, infer: Infer, applyOps: (d: Db, ops: unknown[]) => void) {
  const inst = buildInstance(db, projIds, o);
  const n = inst.acts.length;
  if (!n) return { ok: false as const, error: { code: 'bad_input', message: 'No remaining activities to optimise.' } };
  const leveled = inst.acts.filter((a) => a.crewSize > 0).length, crashable = inst.acts.filter((a) => a.modes.length > 1).length;
  if (!leveled && !crashable) return { ok: false as const, error: { code: 'nothing_to_optimise', message: 'No activity uses a resource with a Max Units/Time limit and no crash data was given, so there is nothing for the reasoner to choose.' } };
  let out: ReasonerOutput;
  try { out = await reasonerOutput(inst, infer, o.tick); }
  catch (e) { if (e instanceof ReasonerBadAnswer) return { ok: false as const, error: { code: 'reasoner_failed', message: e.message } }; throw e; }
  const best = await decode(inst, out, o);
  // a cancel in the final pass over the modes keeps the best found so far. The checks in real dates are ticked: a cancel at either one
  // (and one that came in the pass stays, the tick throws again) keeps the proposal found and says which checks were not run
  const cancelled = best.cancelled;
  // a crew larger than its resource's limit fits on no day, whatever the order: said, because no placement of it means anything
  // (counted as serialSgs places it: the crew of the mode chosen, a crashed mode's crew being larger)
  const overLimit = inst.acts.filter((a, i) => { const d = a.modes[best.modes[i]]?.duration ?? a.duration, crew = a.crewSize * (a.duration && d ? a.duration / d : 1); return d > 0 && crew > (inst.caps.get(a.group) ?? Infinity) + 1e-9; }).length;
  const order = inst.acts.map((a, i) => [a.task.task_id, best.prio[i]] as const).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  const projCode = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const ops = proposalOps(inst, best.modes, projIds.length > 1, projCode, o.hoursPerDay);
  // real dates: CPM, P6's default leveling (early start priority), and the reasoner's modes and order through the same leveler
  // (and every activity's dates at each stage: an export lists them side by side)
  const open = new Set(projIds);
  const datesOf = (d: Db) => new Map(rows(d, 'TASK').filter((t) => open.has(t.proj_id)).map((t) => [t.task_id, [parseP6Date(t.act_start_date || t.early_start_date), parseP6Date(t.act_end_date || t.early_end_date)] as const]));
  const measureLeveled = (d: Db, first?: string[]) => { const s = scheduleProjects(d, projIds, {}); if (!s.ok) throw new Error('The schedule failed.'); const cpm = finishOf(d, projIds), cpmDates = datesOf(d); if (leveled) levelResources(d, projIds, { first }); return { cpm, leveled: finishOf(d, projIds), cpmDates, dates: datesOf(d) }; };
  const cancelledAt = async (k: number, say: string) => { try { await o.tick?.(k, 3, say); return false; } catch (e) { if ((e as { code?: unknown })?.code !== 'cancelled') throw e; return true; } };
  type Measured = ReturnType<typeof measureLeveled>;
  let p6: Measured | undefined, mine: Measured | undefined, skipped: string | undefined;
  if (await cancelledAt(1, 'P6 leveling for comparison')) skipped = "Cancelled before the comparison with P6's leveling: neither it nor the leveling in the proposed order was run, so cpm_finish, p6_leveled_finish, reasoner_finish, better_than_p6_leveler, biggest_changes and the activities' dates are not given.";
  else {
    p6 = onScratch(db, (d) => measureLeveled(d));
    if (await cancelledAt(2, 'leveling in the proposed order')) skipped = "Cancelled before the leveling in the proposed order: it was not run, so reasoner_finish, better_than_p6_leveler, biggest_changes and the activities' dates are not given (cpm_finish and p6_leveled_finish are).";
    else mine = onScratch(db, (d) => { applyOps(d, ops); return measureLeveled(d, order); });
  }
  const fmt = (v: number | null) => (v != null ? formatP6Date(v) : null);
  // (a day: the hours per day of the activity's calendar, as evaluate's shifts take it)
  const cals = calendarResolver(db, []), projCal = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.clndr_id])), dh = dayHours(db, o.hoursPerDay ?? 8, true);
  const byTask = new Map(inst.acts.map((a) => [a.task.task_id, a]));
  /** every activity of the projects: its dates under CPM (no leveling), P6's default leveling, and the reasoner's modes and order
   *  (minutes; start and finish, actual where it has one) */
  const dates = !p6 || !mine ? [] : rows(db, 'TASK').filter((t) => open.has(t.proj_id)).map((t) => {
    const cpm = p6.cpmDates.get(t.task_id)!, mod = mine.dates.get(t.task_id)!, cal = cals.get(t.clndr_id) ?? cals.fallback(projCal.get(t.proj_id) ?? '');
    // reasoner against CPM, in working days of the activity's calendar (later: positive)
    const wd = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round(((a <= b ? cal.workBetween(a, b) : -cal.workBetween(b, a)) / 60 / dh.task(t)) * 100) / 100);
    return { taskId: t.task_id, code: t.task_code, name: t.task_name, cpm, p6: p6!.dates.get(t.task_id)!, reasoner: mod, startDeltaDays: wd(cpm[0], mod[0]), finishDeltaDays: wd(cpm[1], mod[1]) };
  });
  // the activities whose dates the reasoner's proposal moves against CPM, the largest finish shift first, then the largest start shift
  // (all of them: the answer shows the first max_changes, the export every one)
  const shift = (v: number | null) => Math.abs(v ?? 0);
  const biggest = dates.filter((x) => x.cpm[0] !== x.reasoner[0] || x.cpm[1] !== x.reasoner[1])
    .sort((x, y) => shift(y.finishDeltaDays) - shift(x.finishDeltaDays) || shift(y.startDeltaDays) - shift(x.startDeltaDays))
    .map((x) => ({ id: x.code, name: x.name, cpm_start: fmt(x.cpm[0]), cpm_finish: fmt(x.cpm[1]), reasoner_start: fmt(x.reasoner[0]), reasoner_finish: fmt(x.reasoner[1]), start_delta_days: x.startDeltaDays, finish_delta_days: x.finishDeltaDays }));
  return {
    ok: true as const,
    activities: n, leveled_activities: leveled, crashable_activities: crashable, trajectories: best.trajectories,
    /** what won: 'model', 'sampled', a classic rule with its modes, 'earliest start (no resource limit)', or 'mode pass' */
    best_from: best.best_from,
    ...(best.improvable ? { mode_trials: best.mode_trials, mode_passes: best.mode_passes } : {}),
    ...(!crashable ? { note: o.activities?.length ? "Crash data was given, but no activity in it can be shortened (an id that is not an activity of the schedule, or crash_days not below its remaining days), so there was no mode to choose: this is the best placement found among the model's own answer, the classic rules' orders and the sampled variations of the model's answer." : "No crash data was given, so there was no mode to choose: this is the best placement found among the model's own answer, the classic rules' orders and the sampled variations of the model's answer. Give crash data (activities: [{id, crash_days, crash_cost} \u2026]) for the reasoner to choose what to shorten." } : {}),
    ...(cancelled || skipped ? { partial: true as const, stopped: 'cancelled' as const, partial_note: [
      cancelled ? `Cancelled in the final pass over the modes (${best.mode_trials} trial${best.mode_trials === 1 ? '' : 's'} of pass ${best.mode_passes} done): this is the best found before the stop, a valid proposal but not the pass's end.` : '',
      skipped ?? '', 'Nothing was applied; pass ops to edit to make the changes, or run again for the full result.'].filter(Boolean).join(' ') } : {}),
    /** how the model read the network: at once (1), or this many windows of REASONER_WINDOW activities */
    model_windows: out.windows,
    ...(overLimit ? { over_limit_activities: overLimit, over_limit_note: `${overLimit} activit${overLimit === 1 ? 'y needs' : 'ies need'} more of a resource than its Max Units/Time allows on any day: no order can level ${overLimit === 1 ? 'it' : 'them'}, so the leveled finishes here say little until the limit or the assignment is corrected.` } : {}),
    // (a check that was cancelled before it ran is absent, never invented)
    ...(p6 ? { cpm_finish: fmt(p6.cpm), p6_leveled_finish: fmt(p6.leveled) } : {}),
    ...(mine ? { reasoner_finish: fmt(mine.leveled) } : {}),
    ...(p6 && mine ? { better_than_p6_leveler: p6.leveled != null && mine.leveled != null ? mine.leveled < p6.leveled : null } : {}),
    sgs_makespan_days: best.makespan, crash_cost: Math.round(best.cost * 100) / 100,
    changes: inst.acts.flatMap((a, i) => (best.modes[i] ? [{ id: a.task.task_code, from_days: a.duration, to_days: a.modes[best.modes[i]].duration, cost: a.modes[best.modes[i]].cost }] : [])),
    priority: (o.maxPriority ? order.slice(0, o.maxPriority) : o.maxPriority === 0 ? order : order.slice(0, 100)).map((id) => byTask.get(id)!.task.task_code), priority_total: order.length,
    ops, order, priority_rows: order.map((id) => { const t = byTask.get(id)!.task; return { id: t.task_code as string, name: t.task_name as string }; }),
    /** for the fields an apply writes beside each activity (whiq-fields.ts): the activities whose duration the run changed, and the
     *  placement order of every leveled activity (its place in `order`, 1 = first) */
    field_changes: inst.acts.flatMap((a, i) => (best.modes[i] ? [fieldChange(db, a.task, projCode.get(a.task.proj_id), Number(a.task.remain_drtn_hr_cnt || 0), writtenHours(a, best.modes[i], o.hoursPerDay), a.modes[best.modes[i]].cost, o.hoursPerDay ?? 8)] : [])),
    field_ranks: leveled ? order.flatMap((id, k) => { const a = byTask.get(id)!; return a.crewSize > 0 ? [{ task_id: a.task.task_id as string, id: a.task.task_code as string, project: projCode.get(a.task.proj_id) as string, rank: k + 1 }] : []; }) : [],
    ...(p6 && mine ? { biggest_changes: biggest, biggest_changes_total: biggest.length } : {}),
    dates,
  };
}
