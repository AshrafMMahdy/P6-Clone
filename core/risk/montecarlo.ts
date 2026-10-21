// Schedule risk analysis (Monte Carlo), in the manner of Primavera Risk Analysis.
//
// Inputs
//  - Three-point estimates of REMAINING duration per activity, internal table `_RISKEST`
//    (task_id, min_hr, ml_hr, max_hr, dist). Internal tables (leading "_") are never exported to XER.
//  - Risk events: PROJRISK rows (not Rejected) with a probability and a schedule impact in hours;
//    when a risk occurs in an iteration its impact is added to every linked (TASKRISK) open activity.
//
// Each iteration copies the TASK/PROJECT rows of the analysed projects into a scratch Db (the real Db is
// never touched), samples remaining durations of not-started / in-progress activities, adds the triggered
// risk impacts, runs the normal CPM (`scheduleProjects`) and records the project finish, each activity's
// early finish and whether it was critical (total float <= 0).
import { rows, type Db, type Row, type Table } from '../db.ts';
import { MIN_PER_DAY, parseP6Date } from '../dates.ts';
import { calendarResolver, scheduleProjects, p6num, type SchedOptions } from '../schedule/cpm.ts';
import { linkedTasks, riskProbability, riskScheduleHours, risksOf, type RiskPhase } from './register.ts';

export const RISKEST = '_RISKEST';
export type Dist = 'triangle' | 'betapert' | 'uniform' | 'none';
export const DISTS: Record<Dist, string> = { triangle: 'Triangle', betapert: 'BetaPERT', uniform: 'Uniform', none: 'None (fixed)' };
export const RISKEST_FIELDS = ['task_id', 'min_hr', 'ml_hr', 'max_hr', 'dist'];

export interface Estimate { taskId: string; min: number; ml: number; max: number; dist: Dist }

// ---------------------------------------------------------------- PRNG and distributions

/** Seeded 32-bit PRNG (mulberry32). Returns a function giving uniform numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  let u = 0;
  while (u <= 1e-12) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia-Tsang gamma sampler (shape k > 0, scale 1). */
function gamma(k: number, rng: () => number): number {
  if (k < 1) return gamma(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Sample one duration from a three-point estimate. */
export function sampleDuration(e: { min: number; ml: number; max: number; dist: Dist }, rng: () => number): number {
  const [a, b] = e.min <= e.max ? [e.min, e.max] : [e.max, e.min];
  const m = Math.min(b, Math.max(a, e.ml));
  if (e.dist === 'none' || b - a < 1e-9) return e.dist === 'none' ? e.ml : m;
  const u = rng();
  switch (e.dist) {
    case 'uniform': return a + u * (b - a);
    case 'betapert': {
      const al = 1 + (4 * (m - a)) / (b - a), be = 1 + (4 * (b - m)) / (b - a);
      const x = gamma(al, rng), y = gamma(be, rng);
      return a + (x / (x + y)) * (b - a);
    }
    default: { // triangle, inverse CDF
      const f = (m - a) / (b - a);
      return u < f ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m));
    }
  }
}

// ---------------------------------------------------------------- estimates table

const isMile = (t: Row) => t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile';
const isSummary = (t: Row) => t.task_type === 'TT_LOE' || t.task_type === 'TT_WBS';
/** Activities whose duration can be uncertain: open (not completed) task/resource dependent activities. */
export const isEstimable = (t: Row) => !t.act_end_date && !isMile(t) && !isSummary(t);
/** Remaining duration (hours) as the scheduler reads it. */
export function remainingHours(t: Row): number {
  const h = t.remain_drtn_hr_cnt !== '' && t.remain_drtn_hr_cnt != null ? Number(t.remain_drtn_hr_cnt) : Number(t.target_drtn_hr_cnt || 0);
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}

function estTable(db: Db): Table {
  const t = (db.tables[RISKEST] ??= { name: RISKEST, fields: [...RISKEST_FIELDS], rows: [] });
  for (const f of RISKEST_FIELDS) if (!t.fields.includes(f)) t.fields.push(f);
  return t;
}

const DIST_SET = new Set<string>(Object.keys(DISTS));
function toEstimate(r: Row): Estimate | null {
  const min = Number(r.min_hr), ml = Number(r.ml_hr), max = Number(r.max_hr);
  if (r.ml_hr === '' || !Number.isFinite(ml)) return null;
  return { taskId: r.task_id, min: Number.isFinite(min) && r.min_hr !== '' ? min : ml, ml, max: Number.isFinite(max) && r.max_hr !== '' ? max : ml, dist: (DIST_SET.has(r.dist) ? r.dist : 'triangle') as Dist };
}

export function getEstimates(db: Db): Map<string, Estimate> {
  const m = new Map<string, Estimate>();
  for (const r of rows(db, RISKEST)) { const e = toEstimate(r); if (e) m.set(r.task_id, e); }
  return m;
}

/** Create or change an activity's estimate (hours). Pass `null` to remove it. */
export function setEstimate(db: Db, taskId: string, patch: Partial<Omit<Estimate, 'taskId'>> | null): void {
  const t = estTable(db);
  const i = t.rows.findIndex((r) => r.task_id === taskId);
  if (patch === null) { if (i >= 0) t.rows.splice(i, 1); return; }
  let r = t.rows[i];
  if (!r) {
    const task = rows(db, 'TASK').find((x) => x.task_id === taskId);
    const h = task ? remainingHours(task) : 0;
    r = { task_id: taskId, min_hr: p6num(h), ml_hr: p6num(h), max_hr: p6num(h), dist: 'triangle' };
    t.rows.push(r);
  }
  if (patch.min != null) r.min_hr = p6num(Math.max(0, patch.min));
  if (patch.ml != null) r.ml_hr = p6num(Math.max(0, patch.ml));
  if (patch.max != null) r.max_hr = p6num(Math.max(0, patch.max));
  if (patch.dist != null) r.dist = patch.dist;
}

/** Remove estimates (all, or of the given activities). */
export function clearEstimates(db: Db, taskIds?: string[]): void {
  const t = db.tables[RISKEST];
  if (!t) return;
  if (!taskIds) { t.rows = []; return; }
  const s = new Set(taskIds);
  t.rows = t.rows.filter((r) => !s.has(r.task_id));
}

/**
 * Default three-point estimates for every open activity of the projects:
 * min = remaining x minPct %, most likely = remaining, max = remaining x maxPct %, triangle.
 * Replaces existing estimates of those activities. Returns the number of activities estimated.
 */
export function defaultEstimates(db: Db, projIds: string[], minPct = 90, maxPct = 125, dist: Dist = 'triangle'): number {
  const s = new Set(projIds);
  const t = estTable(db);
  const byTask = new Map(t.rows.map((r) => [r.task_id, r]));
  let n = 0;
  for (const task of rows(db, 'TASK')) {
    if (!s.has(task.proj_id) || !isEstimable(task)) continue;
    const h = remainingHours(task);
    const r: Row = { task_id: task.task_id, min_hr: p6num((h * minPct) / 100), ml_hr: p6num(h), max_hr: p6num((h * maxPct) / 100), dist };
    const old = byTask.get(task.task_id);
    if (old) Object.assign(old, r); else t.rows.push(r);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- simulation

export interface MonteCarloOptions {
  iterations: number;
  seed?: number;
  onProgress?: (i: number) => void;
  /** Which risk values drive risk events: pre-response (default), post-response, or none. */
  riskEvents?: RiskPhase | 'off';
  /** Scheduling option overrides passed to scheduleProjects. */
  schedOptions?: Partial<SchedOptions>;
  /** Yield to the event loop every n iterations (default 5), and after any iteration that ends 200 ms or more after the
   *  last yield (a big schedule: status and cancel answer between iterations). */
  yieldEvery?: number;
  signal?: AbortSignal;
  /** Risk events given for this run (beside PROJRISK / TASKRISK): each happens with probability p and then adds its
   *  hours to the activities named (taskHours) and / or to the project finish (projectHours, working time on the
   *  project's calendar: a project-level delay). */
  events?: InlineEvent[];
  /** Duration ratio sampler: each activity's remaining duration times a ratio drawn per iteration. ratio_normal: a
   *  normal ratio clipped to [minRatio, maxRatio] (default mean 1.12, std 0.28, [0.3, 4]); ratio_empirical: with
   *  probability weight a ratio bootstrapped uniformly from ratios (only with at least 10 of them), else one from its
   *  normal (as ratio_normal) — the platform's blended slippage sampler, draw for draw. scope all (default): in place
   *  of three-point estimates; unestimated: only activities without one. */
  sampler?: Sampler;
  /** Rescale each three-point estimate so its mean is the activity's remaining duration. */
  reAnchor?: boolean;
  /** A date (minutes): the result says the chance of finishing by it. */
  deadline?: number;
}
export interface InlineEvent { name: string; p: number; taskHours: [string, number][]; projectHours: number }
export interface RatioNormal { mean?: number; std?: number; minRatio?: number; maxRatio?: number }
export type Sampler = (({ type: 'ratio_normal' } & RatioNormal) | { type: 'ratio_empirical'; ratios: number[]; weight: number; normal?: RatioNormal }) & { scope?: 'all' | 'unestimated' };

/** Mean of a three-point estimate under its distribution. */
export function estimateMean(e: { min: number; ml: number; max: number; dist: Dist }): number {
  const [a, b] = e.min <= e.max ? [e.min, e.max] : [e.max, e.min];
  const m = Math.min(b, Math.max(a, e.ml));
  return e.dist === 'none' ? e.ml : e.dist === 'uniform' ? (a + b) / 2 : e.dist === 'betapert' ? (a + 4 * m + b) / 6 : (a + m + b) / 3;
}
/** One ratio from a sampler, drawing from rng exactly as the platform's sampleRatio does (the empirical test only
 *  with at least 10 ratios; Box-Muller from two draws). */
export function sampleRatio(s: Sampler, rng: () => number): number {
  if (s.type === 'ratio_empirical' && s.ratios.length >= 10 && rng() < s.weight) return s.ratios[Math.floor(rng() * s.ratios.length)];
  const n: RatioNormal = s.type === 'ratio_empirical' ? s.normal ?? {} : s;
  const u1 = Math.max(1e-9, rng()), u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(n.maxRatio ?? 4, Math.max(n.minRatio ?? 0.3, (n.mean ?? 1.12) + z * (n.std ?? 0.28)));
}

export interface HistogramBin { start: number; end: number; count: number; cumPct: number }
export interface Percentiles { P10: number; P50: number; P80: number; P90: number }
export interface ActivityResult {
  taskId: string; code: string; name: string; projId: string; milestone: boolean;
  /** % of iterations the activity was critical (total float <= 0). */
  criticality: number;
  /** Spearman rank correlation of its sampled duration with the project finish; null when the duration never varied. */
  sensitivity: number | null;
  deterministicFinish: number | null;
  meanFinish: number | null;
  p50Finish: number | null;
  p80Finish: number | null;
  minDur: number; meanDur: number; maxDur: number;
}
export interface MilestoneResult extends Percentiles { taskId: string; code: string; name: string; deterministic: number | null; mean: number }
export interface RiskEventResult { projRiskId: string; code: string; name: string; probability: number; hours: number; activities: number; triggeredPct: number }

export interface MonteCarloResult {
  iterations: number;
  seed: number;
  elapsedMs: number;
  projIds: string[];
  dataDate: number | null;
  deterministicFinish: number;
  /** Project finish (latest early finish of the analysed projects) per iteration, minutes. */
  finishSamples: number[];
  percentiles: Percentiles;
  mean: number; min: number; max: number; stdDevDays: number;
  /** Share (0..1) of iterations finishing on or before the deterministic finish. */
  probDeterministic: number;
  /** With a deadline: share (0..1) of iterations finishing on or before it. */
  probDeadline?: number;
  /** The finishes in working days from the data date, on the first project's calendar (its hours per day). */
  days: { from: number | null; hoursPerDay: number; deterministic: number; mean: number; std: number; min: number; max: number; P10: number; P50: number; P80: number; P90: number;
    /** mean + k standard deviations (k = -3..3), in working days and as the date that many working days on */
    sigma: { k: number; days: number; date: number }[] };
  events: { name: string; probability: number; triggeredPct: number }[];
  histogram: HistogramBin[];
  /** Cumulative curve (S-curve): finish date vs. % of iterations finishing by then. */
  cumulative: { t: number; pct: number }[];
  /** All analysed activities, sorted by criticality desc. */
  activities: ActivityResult[];
  /** Activities with a varying duration, sorted by |rho| desc (tornado chart). */
  sensitivity: { taskId: string; code: string; name: string; rho: number }[];
  milestones: MilestoneResult[];
  risks: RiskEventResult[];
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** Ranks with ties averaged (1-based). */
function ranks(v: ArrayLike<number>): Float64Array {
  const n = v.length;
  const idx = Array.from({ length: n }, (_x, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Float64Array(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && v[idx[j + 1]] === v[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number | null {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation; null when either series is constant. */
export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number | null {
  if (x.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

const yieldNow = () => new Promise<void>((res) => setTimeout(res, 0));

interface Prepared {
  /** Rows of the analysed projects' TASK table, frozen copies taken when the run starts. */
  base: Row[];
  /** Positions of `base` rows in the TASK table. */
  pos: number[];
  taskRows: Row[];
  taskFields: string[];
  projRows: Row[];
  projFields: string[];
  shared: Record<string, Table>;
}

function prepare(db: Db, projIds: string[]): Prepared {
  const s = new Set(projIds);
  const T = db.tables.TASK ?? { name: 'TASK', fields: [], rows: [] };
  const taskRows = T.rows.map((r) => (s.has(r.proj_id) ? { ...r } : r));
  const pos: number[] = [];
  taskRows.forEach((r, i) => { if (s.has(r.proj_id)) pos.push(i); });
  const shared: Record<string, Table> = {};
  // Tables the scheduler only reads: shallow copies so edits made while the run is in progress do not leak in.
  for (const name of ['CALENDAR', 'TASKPRED', 'SCHEDOPTIONS', 'RSRC', 'TASKRSRC', 'PROJWBS']) {
    const t = db.tables[name];
    if (t) shared[name] = { name, fields: [...t.fields], rows: t.rows.map((r) => ({ ...r })) };
  }
  const P = db.tables.PROJECT ?? { name: 'PROJECT', fields: [], rows: [] };
  return { base: pos.map((i) => taskRows[i]), pos, taskRows, taskFields: [...T.fields], projRows: P.rows.map((r) => ({ ...r })), projFields: [...P.fields], shared };
}

/** Fresh scratch Db for one iteration: TASK rows of the analysed projects and PROJECT rows are copies. */
function scratch(p: Prepared): { db: Db; tasks: Row[] } {
  const trows = p.taskRows.slice();
  const tasks: Row[] = new Array(p.pos.length);
  for (let k = 0; k < p.pos.length; k++) trows[p.pos[k]] = tasks[k] = { ...p.base[k] };
  const db: Db = {
    tables: {
      ...p.shared,
      TASK: { name: 'TASK', fields: [...p.taskFields], rows: trows },
      PROJECT: { name: 'PROJECT', fields: [...p.projFields], rows: p.projRows.map((r) => ({ ...r })) },
    },
  };
  return { db, tasks };
}

function finishOf(res: ReturnType<typeof scheduleProjects>, projIds: string[]): number {
  let f = -Infinity;
  for (const id of projIds) { const x = res.projects[id]?.finish; if (x != null && x > f) f = x; }
  return Number.isFinite(f) ? f : (res.stats.finish ?? NaN);
}

function scheduleOrThrow(db: Db, projIds: string[], over: Partial<SchedOptions>) {
  const res = scheduleProjects(db, projIds, over);
  if (!res.ok) {
    const why = res.findings.filter((f) => f.severity === 'error' || f.severity === 'fatal').map((f) => f.message).slice(0, 3).join('; ');
    throw new Error(`The schedule cannot be calculated${why ? `: ${why}` : '.'}`);
  }
  return res;
}

export async function runMonteCarlo(db: Db, projIds: string[], opts: MonteCarloOptions): Promise<MonteCarloResult> {
  const t0 = Date.now();
  const iterations = Math.max(1, Math.floor(opts.iterations));
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const rng = mulberry32(seed);
  const over = opts.schedOptions ?? {};
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 5);
  const prep = prepare(db, projIds);
  const n = prep.base.length;
  if (!n) throw new Error('The projects have no activities.');

  // Deterministic run (current remaining durations)
  const det = scratch(prep);
  const detRes = scheduleOrThrow(det.db, projIds, over);
  const deterministicFinish = finishOf(detRes, projIds);
  const detEF = det.tasks.map((t) => parseP6Date(t.early_end_date));

  // What varies per activity
  const ests = getEstimates(db);
  const estimable = prep.base.map(isEstimable);
  const baseDur = prep.base.map(remainingHours);
  const est: (Estimate | null)[] = prep.base.map((t, k) => {
    const e = estimable[k] ? ests.get(t.task_id) ?? null : null;
    if (!e || !opts.reAnchor) return e;
    // re-anchored: the same shape, scaled so its mean is the remaining duration
    const m = estimateMean(e), f = m > 0 ? baseDur[k] / m : 1;
    return { ...e, min: e.min * f, ml: e.ml * f, max: e.max * f };
  });
  // a ratio is drawn for every open activity the sampler covers, milestones (zero length) too, as the platform's
  // forecast does, so the generator's sequence stays the same; only activities with a duration use it
  const sampler = opts.sampler;
  const drawK = sampler ? prep.base.map((t, k) => !t.act_end_date && !isSummary(t) && (sampler.scope !== 'unestimated' || !est[k])) : [];
  const ratioK = sampler ? prep.base.map((_t, k) => drawK[k] && estimable[k]) : [];
  const phase = opts.riskEvents ?? 'pre';
  const kOf = new Map(prep.base.map((t, k) => [t.task_id, k]));
  const riskEvents = phase === 'off' ? [] : risksOf(db, projIds).filter((r) => r.status_code !== 'RS_Rejected').map((r) => ({
    row: r, p: riskProbability(r, phase), hours: riskScheduleHours(r, phase),
    ks: linkedTasks(db, r.proj_risk_id).map((id) => kOf.get(id)).filter((k): k is number => k != null && estimable[k]),
  })).filter((e) => e.p > 0 && e.hours > 0 && e.ks.length);
  const riskHits = new Array<number>(riskEvents.length).fill(0);
  // Activities whose duration may vary: tracked for sensitivity
  const varies = new Set<number>();
  for (let k = 0; k < n; k++) { const e = est[k]; if (e && e.dist !== 'none' && Math.abs(e.max - e.min) > 1e-9) varies.add(k); if (e && Math.abs(e.ml - baseDur[k]) > 1e-9) varies.add(k); if (ratioK[k] && baseDur[k] > 0) varies.add(k); }
  for (const e of riskEvents) for (const k of e.ks) varies.add(k);
  const inline = (opts.events ?? []).map((e) => ({ ...e, hits: 0, ks: e.taskHours.map(([id, h]) => [kOf.get(id), h] as const).filter((x): x is readonly [number, number] => x[0] != null && estimable[x[0]]) }));
  for (const e of inline) for (const [k] of e.ks) varies.add(k);
  const cals = calendarResolver(db, []), proj0 = rows(db, 'PROJECT').find((p) => p.proj_id === projIds[0]);
  const pcal = cals.fallback(proj0?.clndr_id ?? '');
  const tracked = [...varies];
  const durSamples = tracked.map(() => new Float64Array(iterations));
  const durStats = Array.from({ length: n }, (_x, k) => ({ min: Infinity, max: -Infinity, sum: 0, base: baseDur[k] }));

  const finishes = new Float64Array(iterations);
  const critCount = new Uint32Array(n);
  // each activity's early finish per iteration, as minutes from its first one (4 bytes, exact within 31 years):
  // 1,000 iterations of 80,000 activities hold 320 MB, not 640
  const efSamples = Array.from({ length: n }, () => new Float32Array(iterations));
  const efAnchor = new Float64Array(n).fill(NaN);
  const dur = new Float64Array(n);

  let lastYield = Date.now();
  for (let it = 0; it < iterations; it++) {
    if (opts.signal?.aborted) throw new Error('Risk analysis cancelled.');
    const { db: sdb, tasks } = scratch(prep);
    for (let k = 0; k < n; k++) {
      const e = est[k];
      if (sampler && drawK[k]) { const ratio = sampleRatio(sampler, rng); dur[k] = ratioK[k] ? baseDur[k] * Math.max(0, ratio) : baseDur[k]; }
      else dur[k] = e ? Math.max(0, sampleDuration(e, rng)) : baseDur[k];
    }
    for (let j = 0; j < riskEvents.length; j++) {
      const ev = riskEvents[j];
      if (rng() < ev.p) { riskHits[j]++; for (const k of ev.ks) dur[k] += ev.hours; }
    }
    let projDelay = 0;
    for (const ev of inline) if (rng() < ev.p) { ev.hits++; for (const [k, h] of ev.ks) dur[k] += h; projDelay += ev.projectHours; }
    for (let k = 0; k < n; k++) {
      if (!estimable[k]) continue;
      if (dur[k] !== baseDur[k]) tasks[k].remain_drtn_hr_cnt = String(dur[k]);
      const s = durStats[k];
      if (dur[k] < s.min) s.min = dur[k];
      if (dur[k] > s.max) s.max = dur[k];
      s.sum += dur[k];
    }
    for (let j = 0; j < tracked.length; j++) durSamples[j][it] = dur[tracked[j]];
    const res = scheduleOrThrow(sdb, projIds, over);
    finishes[it] = finishOf(res, projIds);
    if (projDelay > 0 && Number.isFinite(finishes[it])) finishes[it] = pcal.addWork(finishes[it], Math.round(projDelay * 60));
    for (let k = 0; k < n; k++) {
      const t = tasks[k];
      const ef = parseP6Date(t.early_end_date);
      if (ef == null) efSamples[k][it] = NaN;
      else { if (Number.isNaN(efAnchor[k])) efAnchor[k] = ef; efSamples[k][it] = ef - efAnchor[k]; }
      if (!t.act_end_date && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null && Number(t.total_float_hr_cnt) <= 0 && !isSummary(t)) critCount[k]++;
    }
    opts.onProgress?.(it + 1);
    if (it + 1 < iterations && ((it + 1) % yieldEvery === 0 || Date.now() - lastYield >= 200)) { await yieldNow(); lastYield = Date.now(); }
  }

  // Finish distribution
  const sorted = Float64Array.from(finishes).sort();
  let sum = 0, sq = 0;
  for (const f of sorted) sum += f;
  const mean = sum / iterations;
  for (const f of sorted) sq += (f - mean) ** 2;
  const percentiles: Percentiles = { P10: percentile(sorted, 0.1), P50: percentile(sorted, 0.5), P80: percentile(sorted, 0.8), P90: percentile(sorted, 0.9) };
  let onTime = 0;
  for (const f of sorted) if (f <= deterministicFinish) onTime++;

  // Histogram in whole-day bins (at most ~40 bins)
  const min = sorted[0], max = sorted[sorted.length - 1];
  const d0 = Math.floor(min / MIN_PER_DAY) * MIN_PER_DAY;
  const spanDays = Math.max(1, Math.ceil((max - d0 + 1) / MIN_PER_DAY));
  const binDays = Math.max(1, Math.ceil(spanDays / 40));
  const nb = Math.max(1, Math.ceil(spanDays / binDays));
  const counts = new Array<number>(nb).fill(0);
  for (const f of sorted) counts[Math.min(nb - 1, Math.floor((f - d0) / (binDays * MIN_PER_DAY)))]++;
  let cum = 0;
  const histogram: HistogramBin[] = counts.map((c, i) => {
    cum += c;
    return { start: d0 + i * binDays * MIN_PER_DAY, end: d0 + (i + 1) * binDays * MIN_PER_DAY, count: c, cumPct: (100 * cum) / iterations };
  });
  const cumulative: { t: number; pct: number }[] = [];
  const stepC = Math.max(1, Math.floor(iterations / 200));
  for (let i = 0; i < iterations; i++) {
    if (i + 1 < iterations && sorted[i + 1] === sorted[i]) continue;
    if (i % stepC !== 0 && i !== iterations - 1 && cumulative.length) continue;
    cumulative.push({ t: sorted[i], pct: (100 * (i + 1)) / iterations });
  }
  if (cumulative[cumulative.length - 1]?.pct !== 100) cumulative.push({ t: max, pct: 100 });

  // Per activity
  const finishesOf = (k: number) => { const a = efSamples[k].filter((x) => Number.isFinite(x)).sort(), out = new Float64Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] + efAnchor[k]; return out; };
  const rho = new Map<number, number | null>();
  tracked.forEach((k, j) => rho.set(k, spearman(durSamples[j], finishes)));
  const activities: ActivityResult[] = prep.base.map((t, k) => {
    const efs = finishesOf(k);
    const s = durStats[k];
    return {
      taskId: t.task_id, code: t.task_code || t.task_id, name: t.task_name ?? '', projId: t.proj_id, milestone: isMile(t),
      criticality: (100 * critCount[k]) / iterations,
      sensitivity: rho.get(k) ?? null,
      deterministicFinish: detEF[k],
      meanFinish: efs.length ? efs.reduce((a, b) => a + b, 0) / efs.length : null,
      p50Finish: efs.length ? percentile(efs, 0.5) : null,
      p80Finish: efs.length ? percentile(efs, 0.8) : null,
      minDur: estimable[k] ? s.min : 0, meanDur: estimable[k] ? s.sum / iterations : 0, maxDur: estimable[k] ? s.max : 0,
    };
  });
  const sensitivity = activities.filter((a) => a.sensitivity != null).map((a) => ({ taskId: a.taskId, code: a.code, name: a.name, rho: a.sensitivity! }))
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  const milestones: MilestoneResult[] = prep.base.flatMap((t, k) => {
    if (!isMile(t) || t.act_end_date) return [];
    const efs = finishesOf(k);
    if (!efs.length) return [];
    return [{
      taskId: t.task_id, code: t.task_code || t.task_id, name: t.task_name ?? '', deterministic: detEF[k], mean: efs.reduce((a, b) => a + b, 0) / efs.length,
      P10: percentile(efs, 0.1), P50: percentile(efs, 0.5), P80: percentile(efs, 0.8), P90: percentile(efs, 0.9),
    }];
  });
  const risks: RiskEventResult[] = riskEvents.map((e, j) => ({
    projRiskId: e.row.proj_risk_id, code: e.row.risk_code ?? '', name: e.row.risk_name ?? '', probability: e.p, hours: e.hours, activities: e.ks.length,
    triggeredPct: (100 * riskHits[j]) / iterations,
  }));
  activities.sort((a, b) => b.criticality - a.criticality || a.code.localeCompare(b.code, undefined, { numeric: true }));

  // in working days from the data date on the first project's calendar, with sigma marks
  const from = detRes.stats.dataDate, hpdP = pcal.hoursPerDay() || 8;
  const wd = (t: number) => (from == null || !Number.isFinite(t) ? NaN : pcal.workBetween(from, t) / 60 / hpdP);
  const wds = Float64Array.from(sorted, wd);
  const wMean = wds.reduce((x, y) => x + y, 0) / iterations, wStd = Math.sqrt(wds.reduce((x, y) => x + (y - wMean) ** 2, 0) / iterations);
  const at = (d: number) => (from == null ? NaN : pcal.addWork(pcal.nextWorkStart(from), Math.max(0, Math.round(d * hpdP * 60))));
  const days = {
    from, hoursPerDay: hpdP, deterministic: wd(deterministicFinish), mean: wMean, std: wStd, min: wds[0], max: wds[wds.length - 1],
    P10: percentile(wds, 0.1), P50: percentile(wds, 0.5), P80: percentile(wds, 0.8), P90: percentile(wds, 0.9),
    sigma: [-3, -2, -1, 0, 1, 2, 3].map((k) => ({ k, days: wMean + k * wStd, date: at(wMean + k * wStd) })),
  };
  let byDeadline = 0;
  if (opts.deadline != null) for (const f of sorted) if (f <= opts.deadline) byDeadline++;

  return {
    days, events: inline.map((e) => ({ name: e.name, probability: e.p, triggeredPct: (100 * e.hits) / iterations })), ...(opts.deadline != null ? { probDeadline: byDeadline / iterations } : {}),
    iterations, seed, elapsedMs: Date.now() - t0, projIds: [...projIds], dataDate: detRes.stats.dataDate,
    deterministicFinish, finishSamples: Array.from(finishes), percentiles,
    mean, min, max, stdDevDays: Math.sqrt(sq / iterations) / MIN_PER_DAY,
    probDeterministic: onTime / iterations, histogram, cumulative, activities, sensitivity, milestones, risks,
  };
}
