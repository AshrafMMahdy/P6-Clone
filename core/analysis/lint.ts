// Schedule lint: logic and modelling problems P6 schedules without complaint, each with the activities it hits and, where
// there is one, the fix as edit operations (FS overlaps carry the days saved, found by scheduling the fix on a scratch
// copy). The "platform" profile adds White Hat IQ's graded network metrics (serialization, criticality, single-file
// work, chain length, link mix and density, redundant links, disguised orphans, SS abuse) with a score and grade.
// Days are working days of each activity's calendar (the platform's version used calendar days).
import { maxOf, minOf } from '../arrays.ts';
import { type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { isCritical } from '../project/ctx.ts';
import { record, rollback } from '../journal.ts';
import { applyOps } from '../project/ops.ts';
import { scheduleProjects } from '../schedule/cpm.ts';
import { isDone, isLoe, isMilestone, isWbs, makeScope, offender, pct, type CheckResult, type Offender, type Scope } from './common.ts';

export type Band = 'pass' | 'warn' | 'fail';
export interface Fix { activities: string[]; fix: string; ops: Record<string, unknown>[]; saves_days?: number }
export interface LintCheck extends CheckResult { severity: 'error' | 'warning' | 'info'; band: Band; fixes?: Fix[]; weight?: number; /** the thresholds this check was judged by */ applied?: object }
export interface LintReport { report: 'Schedule Lint'; profile: 'p6' | 'platform'; score?: number; grade?: string; work_activities: number; relationships: number; checks: LintCheck[]; thresholds: LintThresholds; overridden: string[]; not_used?: string[] }
export interface LintOptions { projIds?: string[]; hoursPerDay?: number; profile?: 'p6' | 'platform'; checks?: string[]; maxIds?: number; simulate?: boolean; thresholds?: Record<string, unknown> }

type Pair = [number, number];
interface Bands { pass: Pair; warn: Pair }
interface UpperBands { pass: number; warn: number }
/** Every number lint judges by. The platform profile's are White Hat IQ's schedule_lint configuration (the same names
 *  in snake_case; its camelCase names are read too), which organisations set in their wiki; the P6 checks' are counts
 *  allowed before a check fails (0: any one fails). Days are working days. */
export interface LintThresholds {
  dangling_start: { max: number }; dangling_finish: { max: number }; empty_wbs: { max: number }; milestone_duration: { max: number }; loe_on_critical: { max: number };
  /** FS leads up to this many days are tolerated (0: every lead is flagged) */
  fs_overlap: { max_lead_days: number };
  /** hard constraints (Start On, Finish On, Mandatory) allowed before the check warns */
  constraints: { max_hard: number };
  /** look-alike activities chained FS: a ladder needs min_group_size of them, durations within max_duration_ratio, at
   *  least min_chained_share of the pairs chained by FS lags of 0..chain_lag_max; the SS lag offered is
   *  max(lag_min, ceil(duration / lag_divisor)); max_targets ladders are listed */
  ladder: { min_group_size: number; max_duration_ratio: number; min_chained_share: number; chain_lag_max: number; lag_divisor: number; lag_min: number; max_targets: number };
  /** networks with fewer work activities than this get the small-network bands */
  small_network_below: number;
  /** extra open ends tolerated beyond one start and one finish */
  connectivity: { max_open_ends: number };
  start_anchored: { min_peer_gap_days: number; warn_max: number };
  serialization: Bands & { small_pass: Pair; small_warn: Pair };
  criticality: Bands;
  single_file: UpperBands & { small_pass: number; small_warn: number };
  longest_chain: UpperBands & { small_pass: number; small_warn: number };
  non_fs_share: Bands;
  edges_per_activity: Bands;
  redundant_links: UpperBands;
  ss_abuse: { base_cap: number; edge_share_cap: number };
  weights: Record<string, number>;
  /** the lowest score of each grade */
  grades: Record<string, number>;
}
export const DEFAULT_LINT_THRESHOLDS: LintThresholds = {
  dangling_start: { max: 0 }, dangling_finish: { max: 0 }, empty_wbs: { max: 0 }, milestone_duration: { max: 0 }, loe_on_critical: { max: 0 },
  fs_overlap: { max_lead_days: 0 }, constraints: { max_hard: 0 },
  ladder: { min_group_size: 3, max_duration_ratio: 2, min_chained_share: 0.7, chain_lag_max: 2, lag_divisor: 3, lag_min: 2, max_targets: 10 },
  small_network_below: 25,
  connectivity: { max_open_ends: 0 },
  start_anchored: { min_peer_gap_days: 30, warn_max: 2 },
  serialization: { pass: [0.08, 0.4], warn: [0.05, 0.6], small_pass: [0.08, 0.7], small_warn: [0.05, 0.9] },
  criticality: { pass: [0.1, 0.35], warn: [0.05, 0.5] },
  single_file: { pass: 0.15, warn: 0.3, small_pass: 0.4, small_warn: 0.65 },
  longest_chain: { pass: 0.5, warn: 0.75, small_pass: 0.75, small_warn: 0.9 },
  non_fs_share: { pass: [0.05, 0.5], warn: [0.02, 0.7] },
  edges_per_activity: { pass: [1.2, 3], warn: [0.9, 4] },
  redundant_links: { pass: 0.05, warn: 0.15 },
  ss_abuse: { base_cap: 15, edge_share_cap: 0.03 },
  weights: { connectivity: 15, start_anchored: 10, serialization: 15, criticality: 15, single_file: 10, longest_chain: 5, non_fs_share: 10, edges_per_activity: 10, redundant_links: 10 },
  grades: { 'A+': 95, A: 90, 'B+': 85, B: 80, 'C+': 75, C: 65, D: 55, F: 0 },
};
// the platform's own names (its LintConfig, and its check names in weights) for the same thresholds
const ALIAS: Record<string, string> = { non_fs: 'non_fs_share', redundant: 'redundant_links', serialization_index: 'serialization', criticality_ratio: 'criticality', single_file_share: 'single_file', redundant_share: 'redundant_links', longest_chain_share: 'longest_chain', start_anchored_outliers: 'start_anchored' };
// parts of the platform's configuration with nothing here to apply to (its prose and listing sizes)
const PLATFORM_UNUSED = new Set(['stretches', 'connectivity_rows_listed', 'max_targets']);
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Defaults with the given overrides laid over them, checked against the defaults' shape: the thresholds applied, the
 *  paths overridden and the platform settings that have nothing to apply to here. Throws on an unknown name or a value
 *  of the wrong shape. */
export function resolveLintThresholds(input: Record<string, unknown> | undefined): { thresholds: LintThresholds; overridden: string[]; not_used: string[] } {
  const t = structuredClone(DEFAULT_LINT_THRESHOLDS) as unknown as Record<string, unknown>, overridden: string[] = [], not_used: string[] = [];
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const walk = (into: Record<string, unknown>, from: unknown, path: string) => {
    if (from == null || typeof from !== 'object' || Array.isArray(from)) throw new Error(`thresholds${path ? `.${path}` : ''} must be an object.`);
    const free = path === 'weights' || path === 'grades';
    for (const [k0, v] of Object.entries(from as Record<string, unknown>)) {
      const k = path === 'grades' ? k0 : path === '' || path === 'weights' ? (ALIAS[snake(k0)] ?? snake(k0)) : snake(k0);
      const at = path ? `${path}.${k}` : k;
      if (path === 'weights' && !(LINT_CHECKS as readonly string[]).includes(k)) throw new Error(`Unknown check "${k}" in thresholds.weights.`);
      if (!free && !(k in into)) {
        if (PLATFORM_UNUSED.has(k)) { not_used.push(at); continue; }
        throw new Error(`Unknown threshold "${at}". Known: ${Object.keys(into).join(', ')}.`);
      }
      const cur = into[k];
      if (free || isNum(cur)) {
        if (!isNum(v) || v < 0) throw new Error(`thresholds.${at} must be a number of 0 or more.`);
        into[k] = v; overridden.push(at);
      } else if (Array.isArray(cur)) {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || v[0] > v[1]) throw new Error(`thresholds.${at} must be [low, high].`);
        into[k] = [v[0], v[1]]; overridden.push(at);
      } else walk(cur as Record<string, unknown>, v, at);
    }
  };
  if (input != null) walk(t, input, '');
  return { thresholds: t as unknown as LintThresholds, overridden, not_used };
}

export const LINT_CHECKS = ['dangling_start', 'dangling_finish', 'fs_overlap', 'empty_wbs', 'milestone_duration', 'constraints', 'loe_on_critical', 'lag_calendar',
  'connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'] as const;
const PLATFORM_ONLY = new Set(['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse']);

const check = (id: string, name: string, severity: LintCheck['severity'], found: Offender[], denominator: number | null, band: Band, maxIds: number, extra: Partial<LintCheck> = {}): LintCheck => ({
  id, name, severity, band, result: band === 'fail' ? 'fail' : 'pass', unit: '%', metric: denominator ? pct(found.length, denominator) : null, threshold: null,
  numerator: found.length, denominator, activities: maxIds ? found.slice(0, maxIds) : found, total_activities: found.length, ...extra,
});
const bandOf = (v: number, pass: [number, number], warn: [number, number]): Band => (v >= pass[0] && v <= pass[1] ? 'pass' : v >= warn[0] && v <= warn[1] ? 'warn' : 'fail');
const nameKey = (t: Row) => t.task_name.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function lintSchedule(db: Db, o: LintOptions = {}): LintReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, calendarDays: true });
  const profile = o.profile ?? 'p6', maxIds = o.maxIds ?? 100;
  const { thresholds: T, overridden, not_used } = resolveLintThresholds(o.thresholds);
  const upTo = (n: number, max: number): Band => (n <= max ? 'pass' : 'fail');
  const want = (id: string) => (!o.checks?.length || o.checks.includes(id)) && (profile === 'platform' || !PLATFORM_ONLY.has(id));
  const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [], succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
  const task = (id: string) => s.ctx.taskById.get(id);
  const days = (t: Row, h?: string) => Number(h || 0) / s.dh.task(t);
  const type = (r: Row) => r.pred_type || 'PR_FS';
  const W = s.tasks.filter((t) => !isWbs(t) && !isLoe(t) && !isMilestone(t));
  const live = s.tasks.filter((t) => !isDone(t) && !isWbs(t) && !isLoe(t));
  const out: LintCheck[] = [];

  if (want('dangling_start')) {
    const f = live.filter((t) => !t.act_start_date && preds(t).length && !preds(t).some((r) => type(r) === 'PR_FS' || type(r) === 'PR_SS')).map((t) => offender(t, s, `only ${preds(t).map((r) => type(r).slice(3)).join(', ')} in`));
    out.push(check('dangling_start', 'Dangling start (no FS or SS predecessor drives the start)', 'warning', f, live.length, upTo(f.length, T.dangling_start.max), maxIds, { applied: T.dangling_start, note: 'Its start floats free of logic: add a finish-to-start or start-to-start predecessor.' }));
  }
  if (want('dangling_finish')) {
    const f = live.filter((t) => succs(t).length && !succs(t).some((r) => type(r) === 'PR_FS' || type(r) === 'PR_FF')).map((t) => offender(t, s, `only ${succs(t).map((r) => type(r).slice(3)).join(', ')} out`));
    out.push(check('dangling_finish', 'Dangling finish (its finish drives no FS or FF successor)', 'warning', f, live.length, upTo(f.length, T.dangling_finish.max), maxIds, { applied: T.dangling_finish, note: 'If it ran late nothing would move: add a finish-to-start or finish-to-finish successor.' }));
  }
  if (want('fs_overlap')) out.push(fsOverlap(s, o.simulate !== false, maxIds, T));
  if (want('empty_wbs')) {
    const W2 = (s.db.tables.PROJWBS?.rows ?? []).filter((w) => s.projIds.has(w.proj_id) && w.proj_node_flag !== 'Y');
    const kids = new Map<string, string[]>(); for (const w of W2) { const l = kids.get(w.parent_wbs_id); if (l) l.push(w.wbs_id); else kids.set(w.parent_wbs_id, [w.wbs_id]); }
    const has = new Set(s.tasks.map((t) => t.wbs_id));
    const any = (id: string, n = 0): boolean => has.has(id) || (n <= kids.size && (kids.get(id) ?? []).some((k) => any(k, n + 1)));
    const f = W2.filter((w) => !any(w.wbs_id)).map((w) => ({ id: w.wbs_short_name, name: w.wbs_name }));
    out.push(check('empty_wbs', 'WBS elements with no activities', 'warning', f, W2.length, upTo(f.length, T.empty_wbs.max), maxIds, { applied: T.empty_wbs, note: 'WBS elements with no activities under them: scope missing from the schedule, or elements to delete.' }));
  }
  if (want('milestone_duration')) {
    const f: Offender[] = [];
    for (const t of s.tasks) {
      if (isMilestone(t) && (Number(t.target_drtn_hr_cnt || 0) > 0 || Number(t.remain_drtn_hr_cnt || 0) > 0)) f.push(offender(t, s, `milestone with ${Math.round(days(t, t.target_drtn_hr_cnt) * 10) / 10} d duration`));
      else if (!isMilestone(t) && !isWbs(t) && !isLoe(t) && Number(t.target_drtn_hr_cnt || 0) === 0 && !isDone(t)) f.push(offender(t, s, 'zero-duration task: make it a milestone'));
    }
    out.push(check('milestone_duration', 'Milestones with a duration, and zero-duration tasks', 'warning', f, s.tasks.length, upTo(f.length, T.milestone_duration.max), maxIds, { applied: T.milestone_duration }));
  }
  if (want('constraints')) {
    const HARD = new Set(['CS_MANDSTART', 'CS_MANDFIN', 'CS_MSO', 'CS_MEO']);
    const f = live.filter((t) => t.cstr_type || t.cstr_type2).map((t) => offender(t, s, [t.cstr_type, t.cstr_type2].filter(Boolean).map((c) => c.slice(3)).join(', ')));
    const hard = live.filter((t) => HARD.has(t.cstr_type) || HARD.has(t.cstr_type2)).length;
    out.push(check('constraints', 'Constrained activities (every type)', hard > T.constraints.max_hard ? 'warning' : 'info', f, live.length, hard > T.constraints.max_hard ? 'warn' : 'pass', maxIds, { applied: T.constraints, note: `${hard} hard (Start On, Finish On, Mandatory); constraints should stand for real dates, not replace logic.` }));
  }
  if (want('loe_on_critical')) {
    const f = s.tasks.filter((t) => (isLoe(t) || isWbs(t)) && !isDone(t) && isCritical(t, s.ctx)).map((t) => offender(t, s, isLoe(t) ? 'level of effort' : 'WBS summary'));
    out.push(check('loe_on_critical', 'Level of effort or WBS summary activities on the critical path', 'warning', f, null, upTo(f.length, T.loe_on_critical.max), maxIds, { applied: T.loe_on_critical, note: 'Summary activities take their dates from others; on the critical path they hide what really drives the finish.' }));
  }
  if (want('lag_calendar')) {
    const f = s.rels.filter((r) => { const a = task(r.pred_task_id), b = task(r.task_id); return a && b && Number(r.lag_hr_cnt || 0) !== 0 && a.clndr_id !== b.clndr_id; }).map((r) => ({ id: `${task(r.pred_task_id)!.task_code} -> ${task(r.task_id)!.task_code}`, name: `${type(r).slice(3)} lag ${Math.round(Number(r.lag_hr_cnt) / s.dh.task(task(r.pred_task_id)!) * 10) / 10}d`, value: 'different calendars' }));
    out.push(check('lag_calendar', 'Lags between activities on different calendars', 'info', f, s.rels.length, 'pass', maxIds, { note: 'The lag is counted on the relationship lag calendar (Schedule Options): check it means what was intended.' }));
  }
  if (profile === 'platform') out.push(...platformChecks(s, W, maxIds, want, T));

  const scored = out.filter((c) => c.weight);
  const total = scored.reduce((a, c) => a + (c.weight ?? 0), 0);
  const score = total ? Math.round((scored.reduce((a, c) => a + (c.weight ?? 0) * (c.band === 'pass' ? 1 : c.band === 'warn' ? 0.6 : 0), 0) / total) * 100) : undefined;
  const grades = Object.entries(T.grades).sort((a, b) => b[1] - a[1]);
  const grade = score == null ? undefined : (grades.find(([, min]) => score >= min) ?? grades[grades.length - 1])?.[0];
  for (const c of out) if (c.weight != null) c.applied = { ...c.applied, weight: c.weight };
  return { report: 'Schedule Lint', profile, ...(score != null ? { score, grade } : {}), work_activities: W.length, relationships: s.rels.length, checks: out, thresholds: T, overridden, ...(not_used.length ? { not_used } : {}) };
}

/** FS links that should overlap: leads (FS with negative lag: use SS plus lag), SS lags as long as the predecessor
 *  (really FS), and "ladders" (a run of look-alike activities chained FS that could start in step). */
function fsOverlap(s: Scope, simulate: boolean, maxIds: number, T: LintThresholds): LintCheck {
  const L = T.ladder;
  const task = (id: string) => s.ctx.taskById.get(id)!;
  const durD = (t: Row) => Number(t.remain_drtn_hr_cnt || t.target_drtn_hr_cnt || 0) / s.dh.task(t);
  const lagD = (r: Row) => Number(r.lag_hr_cnt || 0) / s.dh.task(task(r.pred_task_id));
  const live = (r: Row) => { const a = s.ctx.taskById.get(r.pred_task_id), b = s.ctx.taskById.get(r.task_id); return a && b && !isDone(b); };
  const found: Offender[] = [], fixes: Fix[] = [];
  for (const r of s.rels) {
    if (!live(r)) continue;
    const a = task(r.pred_task_id), b = task(r.task_id), ty = r.pred_type || 'PR_FS';
    if (ty === 'PR_FS' && lagD(r) < -T.fs_overlap.max_lead_days - 1e-9) {
      const lag = Math.max(0, Math.round((durD(a) + lagD(r)) * 10) / 10);
      found.push({ id: `${a.task_code} -> ${b.task_code}`, name: `FS lag ${Math.round(lagD(r) * 10) / 10}d`, value: 'lead: model the overlap as SS' });
      fixes.push({ activities: [a.task_code, b.task_code], fix: `Change ${a.task_code} FS ${Math.round(lagD(r) * 10) / 10}d ${b.task_code} to SS ${lag}d`, ops: [{ op: 'update_relationship', pred: a.task_code, succ: b.task_code, type: 'FS', new_type: 'SS', lag_days: lag }] });
    } else if (ty === 'PR_SS' && durD(a) > 0 && lagD(r) >= durD(a)) {
      const lag = Math.round((lagD(r) - durD(a)) * 10) / 10;
      found.push({ id: `${a.task_code} -> ${b.task_code}`, name: `SS lag ${Math.round(lagD(r) * 10) / 10}d`, value: `lag is not shorter than ${a.task_code} (${Math.round(durD(a) * 10) / 10}d): really FS` });
      fixes.push({ activities: [a.task_code, b.task_code], fix: `Change ${a.task_code} SS ${Math.round(lagD(r) * 10) / 10}d ${b.task_code} to FS ${lag}d`, ops: [{ op: 'update_relationship', pred: a.task_code, succ: b.task_code, type: 'SS', new_type: 'FS', lag_days: lag }] });
    }
  }
  // ladders: >= 3 look-alike activities (names equal once digits are masked) of similar duration, mostly chained FS
  const groups = new Map<string, Row[]>();
  for (const t of s.tasks) if (!isDone(t) && !isWbs(t) && !isLoe(t) && !isMilestone(t)) { const k = `${t.proj_id}|${nameKey(t)}`; const g = groups.get(k); if (g) g.push(t); else groups.set(k, [t]); }
  // each group's links found from its own activities (not by a pass over every link per group), in link order
  const byPred = new Map<string, number[]>();
  s.rels.forEach((r, i) => { const l = byPred.get(r.pred_task_id); if (l) l.push(i); else byPred.set(r.pred_task_id, [i]); });
  const ladders: Fix[] = [];
  for (const g of groups.values()) {
    if (g.length < L.min_group_size) continue;
    const ds = g.map(durD), mn = minOf(ds), mx = maxOf(ds);
    if (!(mn > 0) || mx > L.max_duration_ratio * mn) continue;
    const ids = new Set(g.map((t) => t.task_id));
    const at: number[] = [];
    for (const t of g) for (const i of byPred.get(t.task_id) ?? []) { const r = s.rels[i]; if (ids.has(r.task_id) && (r.pred_type || 'PR_FS') === 'PR_FS' && lagD(r) >= 0 && lagD(r) <= L.chain_lag_max) at.push(i); }
    const chain = at.sort((x, y) => x - y).map((i) => s.rels[i]);
    if (chain.length < Math.max(2, Math.floor(L.min_chained_share * (g.length - 1)))) continue;
    const ops = chain.map((r) => ({ op: 'update_relationship', pred: task(r.pred_task_id).task_code, succ: task(r.task_id).task_code, type: 'FS', new_type: 'SS', lag_days: Math.max(L.lag_min, Math.ceil(durD(task(r.pred_task_id)) / Math.max(1e-9, L.lag_divisor))) }));
    ladders.push({ activities: g.map((t) => t.task_code), fix: `Overlap "${g[0].task_name}" and its ${g.length - 1} look-alikes: ${chain.length} FS links become SS + lag`, ops });
  }
  // Simulate what each fix saves: only ladders with a critical activity can move the finish (the others save 0), the
  // biggest 10 of them; the base is scheduled once and each fix once, on a rolled-back copy.
  const code2task = new Map(s.tasks.map((t) => [t.task_code, t]));
  const critLadder = (l: Fix) => l.activities.some((c) => { const t = code2task.get(c); return t && isCritical(t, s.ctx); });
  ladders.sort((a, b) => Number(critLadder(b)) - Number(critLadder(a)) || b.activities.length - a.activities.length);
  const top = ladders.slice(0, Math.max(20, L.max_targets * 2));
  for (const l of top) if (!critLadder(l)) l.saves_days = 0;
  const toSim = top.filter(critLadder).slice(0, L.max_targets);
  if (simulate && toSim.length) {
    const ids = [...s.projIds];
    const finishAfter = (ops: Record<string, unknown>[]) => {
      let f: number | null = null;
      const j = record(s.db, (d) => {
        if (ops.length && !applyOps(d, ops, { hoursPerDay: s.hpd, calendarDays: true }).ok) return;
        const r = scheduleProjects(d, ids, {});
        if (r.ok) f = maxOf(d.tables.TASK.rows.filter((t) => s.projIds.has(t.proj_id)).map((t) => parseP6Date(t.act_end_date || t.early_end_date) ?? -Infinity));
      });
      rollback(j);
      return f;
    };
    const base = finishAfter([]);
    const cal = s.projs[0] ? s.projCal(s.projs[0]) : null;
    for (const l of toSim) { const f = finishAfter(l.ops); l.saves_days = base != null && f != null && cal ? Math.round(s.workDays(cal, f, base) * 10) / 10 : undefined; }
  }
  top.sort((a, b) => (b.saves_days ?? 0) - (a.saves_days ?? 0));
  for (const l of top.slice(0, L.max_targets)) { found.push({ id: l.activities[0], name: l.fix, value: l.saves_days != null ? `saves ${l.saves_days} d` : undefined }); fixes.push(l); }
  return check('fs_overlap', 'Finish-to-start links that should overlap', 'warning', found, null, found.length ? 'warn' : 'pass', maxIds, { fixes, applied: { ...T.fs_overlap, ladder: L }, note: 'Leads hide an overlap inside an FS link; an SS lag as long as the predecessor is really an FS; a ladder of look-alike activities chained FS could run in step. Each fix is a list of edit operations; ladders show the days the fix saves.' });
}

/** White Hat IQ's graded network checks (bands as in its schedule_lint; small networks have wider bands). */
function platformChecks(s: Scope, W: Row[], maxIds: number, want: (id: string) => boolean, T: LintThresholds): LintCheck[] {
  const out: LintCheck[] = [];
  const small = W.length < T.small_network_below;
  const WEIGHTS = T.weights;
  const sized = <P,>(x: { pass: P; warn: P; small_pass: P; small_warn: P }): { pass: P; warn: P; small_network?: true } => (small ? { pass: x.small_pass, warn: x.small_warn, small_network: true } : { pass: x.pass, warn: x.warn });
  const workIds = new Set(W.map((t) => t.task_id));
  const preds = (t: Row) => (s.ctx.predsOf.get(t.task_id) ?? []), succs = (t: Row) => (s.ctx.succsOf.get(t.task_id) ?? []);
  const start = (t: Row) => parseP6Date(t.act_start_date || t.early_start_date || t.target_start_date);
  const finish = (t: Row) => parseP6Date(t.act_end_date || t.early_end_date || t.target_end_date);
  const durD = (t: Row) => Number(t.target_drtn_hr_cnt || 0) / s.dh.task(t);
  const p = s.projs[0];
  const cal = p ? s.projCal(p) : null;
  const st = minOf(s.tasks.map((t) => start(t) ?? Infinity)), fi = maxOf(s.tasks.map((t) => finish(t) ?? -Infinity));
  const makespan = cal && Number.isFinite(st) && Number.isFinite(fi) ? s.workDays(cal, st, fi) : 0;
  const metric = (id: string, name: string, v: number | null, b: Band, note: string, applied: object, found: Offender[] = []): LintCheck => ({ ...check(id, name, 'info', found, null, b, maxIds, { note, weight: WEIGHTS[id], applied }), unit: 'ratio', metric: v == null ? null : Math.round(v * 1000) / 1000, numerator: null, denominator: null });

  if (want('connectivity')) {
    const np = s.tasks.filter((t) => !isWbs(t) && !preds(t).length), ns = s.tasks.filter((t) => !isWbs(t) && !succs(t).length);
    const v = Math.max(0, np.length - 1) + Math.max(0, ns.length - 1);
    out.push({ ...check('connectivity', 'Connectivity (one start, one finish)', 'warning', [...np.slice(0, 20).map((t) => offender(t, s, 'no predecessor')), ...ns.slice(0, 20).map((t) => offender(t, s, 'no successor'))], null, v > T.connectivity.max_open_ends ? 'fail' : 'pass', maxIds, { weight: WEIGHTS.connectivity, applied: T.connectivity, note: `${np.length} activities without predecessors and ${ns.length} without successors; a sound network has one of each.` }), unit: 'ratio', metric: v });
  }
  if (want('start_anchored')) {
    const starts = s.tasks.filter((t) => !isWbs(t) && !preds(t).length);
    const found: Offender[] = [];
    if (starts.length === 1) {
      const s0 = starts[0];
      // the work activities of each WBS, once (not a pass over all of them per activity)
      const byWbs = new Map<string, Row[]>();
      for (const x of W) { const l = byWbs.get(x.wbs_id); if (l) l.push(x); else byWbs.set(x.wbs_id, [x]); }
      for (const t of W) {
        const ps = preds(t);
        if (ps.length !== 1 || ps[0].pred_task_id !== s0.task_id) continue;
        const peers = byWbs.get(t.wbs_id)!.filter((x) => x !== t).map((x) => start(x)).filter((x): x is number => x != null).sort((a, b) => a - b);
        const ts = start(t);
        if (peers.length < 2 || ts == null || !cal) continue;
        const med = peers[Math.floor(peers.length / 2)];
        if (s.workDays(cal, ts, med) >= T.start_anchored.min_peer_gap_days) found.push(offender(t, s, `hung off ${s0.task_code}; its WBS peers start ${Math.round(s.workDays(cal, ts, med))} d later`));
      }
    }
    out.push(check('start_anchored', 'Disguised orphans (hung off the project start)', 'warning', found, null, found.length === 0 ? 'pass' : found.length <= T.start_anchored.warn_max ? 'warn' : 'fail', maxIds, { weight: WEIGHTS.start_anchored, applied: T.start_anchored, note: `Activities whose only predecessor is the project start, while the rest of their WBS starts ${T.start_anchored.min_peer_gap_days} working days or more later: their real predecessor is missing.` }));
  }
  const work = W.reduce((a, t) => a + durD(t), 0);
  if (want('serialization')) { const v = work ? makespan / work : null; out.push(metric('serialization', 'Serialization index (makespan / total work)', v, v == null ? 'pass' : bandOf(v, sized(T.serialization).pass, sized(T.serialization).warn), 'Near 1: everything in one line; very low: work bunched in parallel.', sized(T.serialization))); }
  if (want('criticality')) { const c = W.filter((t) => !isDone(t) && isCritical(t, s.ctx)).length, v = W.length ? c / W.length : null; out.push(metric('criticality', 'Criticality ratio (critical work / work)', v, v == null ? 'pass' : bandOf(v, T.criticality.pass, T.criticality.warn), 'Share of work activities on the critical path.', T.criticality)); }
  if (want('single_file') && cal && makespan > 0) {
    const day0 = Math.floor(st / 1440), dayN = Math.floor(fi / 1440), n = dayN - day0 + 1, cnt = new Int32Array(n + 1);
    for (const t of W) { const a = start(t), b = finish(t); if (a == null || b == null) continue; cnt[Math.max(0, Math.floor(a / 1440) - day0)]++; cnt[Math.min(n, Math.floor(b / 1440) - day0 + 1)]--; }
    let run = 0, workDays = 0, single = 0;
    for (let d = 0; d < n; d++) { run += cnt[d]; if (!cal.shiftsOn(day0 + d).length) continue; workDays++; if (run <= 1) single++; }
    const v = workDays ? single / workDays : 0;
    out.push(metric('single_file', 'Single-file share (working days with at most one activity running)', v, bandOf(v, [0, sized(T.single_file).pass], [0, sized(T.single_file).warn]), 'Days when the job hangs on one activity.', sized(T.single_file)));
  }
  if (want('longest_chain')) {
    const ids = s.tasks.filter((t) => !isWbs(t)).map((t) => t.task_id), set = new Set(ids), indeg = new Map(ids.map((i) => [i, 0])), len = new Map(ids.map((i) => [i, 1]));
    for (const r of s.rels) if (set.has(r.pred_task_id) && set.has(r.task_id)) indeg.set(r.task_id, indeg.get(r.task_id)! + 1);
    const q = ids.filter((i) => indeg.get(i) === 0); let seen = 0, best = 0;
    while (q.length) { const i = q.pop()!; seen++; best = Math.max(best, len.get(i)!); for (const r of s.ctx.succsOf.get(i) ?? []) { if (!set.has(r.task_id)) continue; len.set(r.task_id, Math.max(len.get(r.task_id)!, len.get(i)! + 1)); indeg.set(r.task_id, indeg.get(r.task_id)! - 1); if (!indeg.get(r.task_id)) q.push(r.task_id); } }
    const v = seen === ids.length && ids.length ? best / ids.length : null;
    out.push(metric('longest_chain', 'Longest chain share (activities in the longest chain / all)', v, v == null ? 'pass' : bandOf(v, [0, sized(T.longest_chain).pass], [0, sized(T.longest_chain).warn]), v == null ? 'The network has loops; not measured.' : `The longest chain has ${best} activities.`, sized(T.longest_chain)));
  }
  const links = s.rels.filter((r) => workIds.has(r.pred_task_id) || workIds.has(r.task_id));
  if (want('non_fs_share')) { const v = links.length ? links.filter((r) => (r.pred_type || 'PR_FS') !== 'PR_FS').length / links.length : null; out.push(metric('non_fs_share', 'Non-FS link share', v, v == null ? 'pass' : bandOf(v, T.non_fs_share.pass, T.non_fs_share.warn), 'Some SS/FF overlap is healthy; too much hides the sequence.', T.non_fs_share)); }
  if (want('edges_per_activity')) { const v = W.length ? links.length / W.length : null; out.push(metric('edges_per_activity', 'Links per work activity', v, v == null ? 'pass' : bandOf(v, T.edges_per_activity.pass, T.edges_per_activity.warn), 'Too few: logic missing; too many: tangled.', T.edges_per_activity)); }
  if (want('redundant_links')) {
    // an FS (lag >= 0) link implied by another FS (lag >= 0) path between the same two activities
    const fsOut = new Map<string, Row[]>();
    for (const r of s.rels) if ((r.pred_type || 'PR_FS') === 'PR_FS' && Number(r.lag_hr_cnt || 0) >= 0) { const l = fsOut.get(r.pred_task_id); if (l) l.push(r); else fsOut.set(r.pred_task_id, [r]); }
    const inDeg = new Map<string, number>(); for (const rs of fsOut.values()) for (const r of rs) inDeg.set(r.task_id, (inDeg.get(r.task_id) ?? 0) + 1);
    const red: Offender[] = []; let fsN = 0;
    for (const [u, rs] of fsOut) {
      fsN += rs.length;
      if (rs.length < 2) continue;
      for (const r of rs) {
        if ((inDeg.get(r.task_id) ?? 0) < 2 || Number(r.lag_hr_cnt || 0) !== 0) continue;
        const seen = new Set([u]); const stack = rs.filter((x) => x !== r).map((x) => x.task_id); let found = false, n = 0;
        while (stack.length && !found && n++ < 3000) { const v = stack.pop()!; if (v === r.task_id) { found = true; break; } if (seen.has(v)) continue; seen.add(v); for (const x of fsOut.get(v) ?? []) stack.push(x.task_id); }
        if (found) red.push({ id: `${s.ctx.taskById.get(u)?.task_code} -> ${s.ctx.taskById.get(r.task_id)?.task_code}`, name: 'FS, also reached through other FS links', value: 'redundant' });
      }
    }
    const v = fsN ? red.length / fsN : 0;
    out.push({ ...check('redundant_links', 'Redundant FS links', 'info', red, fsN, bandOf(v, [0, T.redundant_links.pass], [0, T.redundant_links.warn]), maxIds, { weight: WEIGHTS.redundant_links, applied: T.redundant_links, note: 'Links already implied by another chain; they clutter the network without adding logic.' }), fixes: red.slice(0, maxIds || red.length).map((x) => { const [a, b] = x.id.split(' -> '); return { activities: [a, b], fix: `Delete ${a} FS ${b}`, ops: [{ op: 'delete_relationship', pred: a, succ: b, type: 'FS' }] }; }) });
  }
  if (want('ss_abuse')) {
    const bad = s.rels.filter((r) => { const a = s.ctx.taskById.get(r.pred_task_id), b = s.ctx.taskById.get(r.task_id); return a && b && (r.pred_type === 'PR_SS' || r.pred_type === 'PR_FF') && nameKey(a) !== nameKey(b) && a.wbs_id !== b.wbs_id; })
      .map((r) => ({ id: `${s.ctx.taskById.get(r.pred_task_id)!.task_code} -> ${s.ctx.taskById.get(r.task_id)!.task_code}`, name: `${r.pred_type.slice(3)} across unrelated work`, value: 'check the overlap is real' }));
    const cap = Math.max(T.ss_abuse.base_cap, Math.ceil(T.ss_abuse.edge_share_cap * s.rels.length));
    out.push(check('ss_abuse', 'SS/FF links between unrelated work', 'info', bad, s.rels.length, bad.length > cap ? 'warn' : 'pass', maxIds, { applied: { ...T.ss_abuse, cap }, note: `SS/FF links between different kinds of work in different WBS elements (more than ${cap} is a warning): overlaps used as shortcuts instead of real logic.` }));
  }
  return out;
}
