// Schedule lint: logic and modelling problems P6 schedules without complaint, each with the activities it hits and, where
// there is one, the fix as edit operations (FS overlaps carry the days saved, found by scheduling the fix on a scratch
// copy). The "platform" profile adds White Hat IQ's graded network metrics (serialization, criticality, single-file
// work, chain length, link mix and density, redundant links, disguised orphans, SS abuse) with a score and grade.
// Days are working days of each activity's calendar (the platform's version used calendar days).
import { type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { isCritical } from '../project/ctx.ts';
import { record, rollback } from '../journal.ts';
import { applyOps } from '../project/ops.ts';
import { scheduleProjects } from '../schedule/cpm.ts';
import { isDone, isLoe, isMilestone, isWbs, makeScope, offender, pct, type CheckResult, type Offender, type Scope } from './common.ts';

export type Band = 'pass' | 'warn' | 'fail';
export interface Fix { activities: string[]; fix: string; ops: Record<string, unknown>[]; saves_days?: number }
export interface LintCheck extends CheckResult { severity: 'error' | 'warning' | 'info'; band: Band; fixes?: Fix[]; weight?: number }
export interface LintReport { report: 'Schedule Lint'; profile: 'p6' | 'platform'; score?: number; grade?: string; work_activities: number; relationships: number; checks: LintCheck[] }
export interface LintOptions { projIds?: string[]; hoursPerDay?: number; profile?: 'p6' | 'platform'; checks?: string[]; maxIds?: number; simulate?: boolean }

export const LINT_CHECKS = ['dangling_start', 'dangling_finish', 'fs_overlap', 'empty_wbs', 'milestone_duration', 'constraints', 'loe_on_critical', 'lag_calendar',
  'connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'] as const;
const PLATFORM_ONLY = new Set(['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse']);
const WEIGHTS: Record<string, number> = { connectivity: 15, start_anchored: 10, serialization: 15, criticality: 15, single_file: 10, longest_chain: 5, non_fs_share: 10, edges_per_activity: 10, redundant_links: 10 };

const check = (id: string, name: string, severity: LintCheck['severity'], found: Offender[], denominator: number | null, band: Band, maxIds: number, extra: Partial<LintCheck> = {}): LintCheck => ({
  id, name, severity, band, result: band === 'fail' ? 'fail' : 'pass', unit: '%', metric: denominator ? pct(found.length, denominator) : null, threshold: null,
  numerator: found.length, denominator, activities: maxIds ? found.slice(0, maxIds) : found, total_activities: found.length, ...extra,
});
const bandOf = (v: number, pass: [number, number], warn: [number, number]): Band => (v >= pass[0] && v <= pass[1] ? 'pass' : v >= warn[0] && v <= warn[1] ? 'warn' : 'fail');
const nameKey = (t: Row) => t.task_name.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export function lintSchedule(db: Db, o: LintOptions = {}): LintReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, calendarDays: true });
  const profile = o.profile ?? 'p6', maxIds = o.maxIds ?? 100;
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
    out.push(check('dangling_start', 'Dangling start (no FS or SS predecessor drives the start)', 'warning', f, live.length, f.length ? 'fail' : 'pass', maxIds, { note: 'Its start floats free of logic: add a finish-to-start or start-to-start predecessor.' }));
  }
  if (want('dangling_finish')) {
    const f = live.filter((t) => succs(t).length && !succs(t).some((r) => type(r) === 'PR_FS' || type(r) === 'PR_FF')).map((t) => offender(t, s, `only ${succs(t).map((r) => type(r).slice(3)).join(', ')} out`));
    out.push(check('dangling_finish', 'Dangling finish (its finish drives no FS or FF successor)', 'warning', f, live.length, f.length ? 'fail' : 'pass', maxIds, { note: 'If it ran late nothing would move: add a finish-to-start or finish-to-finish successor.' }));
  }
  if (want('fs_overlap')) out.push(fsOverlap(s, o.simulate !== false, maxIds));
  if (want('empty_wbs')) {
    const W2 = (s.db.tables.PROJWBS?.rows ?? []).filter((w) => s.projIds.has(w.proj_id) && w.proj_node_flag !== 'Y');
    const kids = new Map<string, string[]>(); for (const w of W2) kids.set(w.parent_wbs_id, [...(kids.get(w.parent_wbs_id) ?? []), w.wbs_id]);
    const has = new Set(s.tasks.map((t) => t.wbs_id));
    const any = (id: string, n = 0): boolean => has.has(id) || (n < 50 && (kids.get(id) ?? []).some((k) => any(k, n + 1)));
    const f = W2.filter((w) => !any(w.wbs_id)).map((w) => ({ id: w.wbs_short_name, name: w.wbs_name }));
    out.push(check('empty_wbs', 'WBS elements with no activities', 'warning', f, W2.length, f.length ? 'fail' : 'pass', maxIds, { note: 'WBS elements with no activities under them: scope missing from the schedule, or elements to delete.' }));
  }
  if (want('milestone_duration')) {
    const f: Offender[] = [];
    for (const t of s.tasks) {
      if (isMilestone(t) && (Number(t.target_drtn_hr_cnt || 0) > 0 || Number(t.remain_drtn_hr_cnt || 0) > 0)) f.push(offender(t, s, `milestone with ${Math.round(days(t, t.target_drtn_hr_cnt) * 10) / 10} d duration`));
      else if (!isMilestone(t) && !isWbs(t) && !isLoe(t) && Number(t.target_drtn_hr_cnt || 0) === 0 && !isDone(t)) f.push(offender(t, s, 'zero-duration task: make it a milestone'));
    }
    out.push(check('milestone_duration', 'Milestones with a duration, and zero-duration tasks', 'warning', f, s.tasks.length, f.length ? 'fail' : 'pass', maxIds));
  }
  if (want('constraints')) {
    const HARD = new Set(['CS_MANDSTART', 'CS_MANDFIN', 'CS_MSO', 'CS_MEO']);
    const f = live.filter((t) => t.cstr_type || t.cstr_type2).map((t) => offender(t, s, [t.cstr_type, t.cstr_type2].filter(Boolean).map((c) => c.slice(3)).join(', ')));
    const hard = live.filter((t) => HARD.has(t.cstr_type) || HARD.has(t.cstr_type2)).length;
    out.push(check('constraints', 'Constrained activities (every type)', hard ? 'warning' : 'info', f, live.length, hard ? 'warn' : 'pass', maxIds, { note: `${hard} hard (Start On, Finish On, Mandatory); constraints should stand for real dates, not replace logic.` }));
  }
  if (want('loe_on_critical')) {
    const f = s.tasks.filter((t) => (isLoe(t) || isWbs(t)) && !isDone(t) && isCritical(t, s.ctx)).map((t) => offender(t, s, isLoe(t) ? 'level of effort' : 'WBS summary'));
    out.push(check('loe_on_critical', 'Level of effort or WBS summary activities on the critical path', 'warning', f, null, f.length ? 'fail' : 'pass', maxIds, { note: 'Summary activities take their dates from others; on the critical path they hide what really drives the finish.' }));
  }
  if (want('lag_calendar')) {
    const f = s.rels.filter((r) => { const a = task(r.pred_task_id), b = task(r.task_id); return a && b && Number(r.lag_hr_cnt || 0) !== 0 && a.clndr_id !== b.clndr_id; }).map((r) => ({ id: `${task(r.pred_task_id)!.task_code} -> ${task(r.task_id)!.task_code}`, name: `${type(r).slice(3)} lag ${Math.round(Number(r.lag_hr_cnt) / s.dh.task(task(r.pred_task_id)!) * 10) / 10}d`, value: 'different calendars' }));
    out.push(check('lag_calendar', 'Lags between activities on different calendars', 'info', f, s.rels.length, 'pass', maxIds, { note: 'The lag is counted on the relationship lag calendar (Schedule Options): check it means what was intended.' }));
  }
  if (profile === 'platform') out.push(...platformChecks(s, W, maxIds, want));

  const scored = out.filter((c) => c.weight);
  const total = scored.reduce((a, c) => a + (c.weight ?? 0), 0);
  const score = total ? Math.round((scored.reduce((a, c) => a + (c.weight ?? 0) * (c.band === 'pass' ? 1 : c.band === 'warn' ? 0.6 : 0), 0) / total) * 100) : undefined;
  const grade = score == null ? undefined : score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 85 ? 'B+' : score >= 80 ? 'B' : score >= 75 ? 'C+' : score >= 65 ? 'C' : score >= 55 ? 'D' : 'F';
  return { report: 'Schedule Lint', profile, ...(score != null ? { score, grade } : {}), work_activities: W.length, relationships: s.rels.length, checks: out };
}

/** FS links that should overlap: leads (FS with negative lag: use SS plus lag), SS lags as long as the predecessor
 *  (really FS), and "ladders" (a run of look-alike activities chained FS that could start in step). */
function fsOverlap(s: Scope, simulate: boolean, maxIds: number): LintCheck {
  const task = (id: string) => s.ctx.taskById.get(id)!;
  const durD = (t: Row) => Number(t.remain_drtn_hr_cnt || t.target_drtn_hr_cnt || 0) / s.dh.task(t);
  const lagD = (r: Row) => Number(r.lag_hr_cnt || 0) / s.dh.task(task(r.pred_task_id));
  const live = (r: Row) => { const a = s.ctx.taskById.get(r.pred_task_id), b = s.ctx.taskById.get(r.task_id); return a && b && !isDone(b); };
  const found: Offender[] = [], fixes: Fix[] = [];
  for (const r of s.rels) {
    if (!live(r)) continue;
    const a = task(r.pred_task_id), b = task(r.task_id), ty = r.pred_type || 'PR_FS';
    if (ty === 'PR_FS' && lagD(r) < 0) {
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
  for (const t of s.tasks) if (!isDone(t) && !isWbs(t) && !isLoe(t) && !isMilestone(t)) { const k = `${t.proj_id}|${nameKey(t)}`; groups.set(k, [...(groups.get(k) ?? []), t]); }
  const ladders: Fix[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const ds = g.map(durD), mn = Math.min(...ds), mx = Math.max(...ds);
    if (!(mn > 0) || mx > 2 * mn) continue;
    const ids = new Set(g.map((t) => t.task_id));
    const chain = s.rels.filter((r) => ids.has(r.pred_task_id) && ids.has(r.task_id) && (r.pred_type || 'PR_FS') === 'PR_FS' && lagD(r) >= 0 && lagD(r) <= 2);
    if (chain.length < Math.max(2, Math.floor(0.7 * (g.length - 1)))) continue;
    const ops = chain.map((r) => ({ op: 'update_relationship', pred: task(r.pred_task_id).task_code, succ: task(r.task_id).task_code, type: 'FS', new_type: 'SS', lag_days: Math.max(2, Math.ceil(durD(task(r.pred_task_id)) / 3)) }));
    ladders.push({ activities: g.map((t) => t.task_code), fix: `Overlap "${g[0].task_name}" and its ${g.length - 1} look-alikes: ${chain.length} FS links become SS + lag`, ops });
  }
  // Simulate what each fix saves: only ladders with a critical activity can move the finish (the others save 0), the
  // biggest 10 of them; the base is scheduled once and each fix once, on a rolled-back copy.
  const code2task = new Map(s.tasks.map((t) => [t.task_code, t]));
  const critLadder = (l: Fix) => l.activities.some((c) => { const t = code2task.get(c); return t && isCritical(t, s.ctx); });
  ladders.sort((a, b) => Number(critLadder(b)) - Number(critLadder(a)) || b.activities.length - a.activities.length);
  const top = ladders.slice(0, 20);
  for (const l of top) if (!critLadder(l)) l.saves_days = 0;
  const toSim = top.filter(critLadder).slice(0, 10);
  if (simulate && toSim.length) {
    const ids = [...s.projIds];
    const finishAfter = (ops: Record<string, unknown>[]) => {
      let f: number | null = null;
      const j = record(s.db, (d) => {
        if (ops.length && !applyOps(d, ops, { hoursPerDay: s.hpd, calendarDays: true }).ok) return;
        const r = scheduleProjects(d, ids, {});
        if (r.ok) f = Math.max(...d.tables.TASK.rows.filter((t) => s.projIds.has(t.proj_id)).map((t) => parseP6Date(t.act_end_date || t.early_end_date) ?? -Infinity));
      });
      rollback(j);
      return f;
    };
    const base = finishAfter([]);
    const cal = s.projs[0] ? s.projCal(s.projs[0]) : null;
    for (const l of toSim) { const f = finishAfter(l.ops); l.saves_days = base != null && f != null && cal ? Math.round(s.workDays(cal, f, base) * 10) / 10 : undefined; }
  }
  top.sort((a, b) => (b.saves_days ?? 0) - (a.saves_days ?? 0));
  for (const l of top.slice(0, 10)) { found.push({ id: l.activities[0], name: l.fix, value: l.saves_days != null ? `saves ${l.saves_days} d` : undefined }); fixes.push(l); }
  return check('fs_overlap', 'Finish-to-start links that should overlap', 'warning', found, null, found.length ? 'warn' : 'pass', maxIds, { fixes, note: 'Leads hide an overlap inside an FS link; an SS lag as long as the predecessor is really an FS; a ladder of look-alike activities chained FS could run in step. Each fix is a list of edit operations; ladders show the days the fix saves.' });
}

/** White Hat IQ's graded network checks (bands as in its schedule_lint; small networks have wider bands). */
function platformChecks(s: Scope, W: Row[], maxIds: number, want: (id: string) => boolean): LintCheck[] {
  const out: LintCheck[] = [];
  const small = W.length < 25;
  const workIds = new Set(W.map((t) => t.task_id));
  const preds = (t: Row) => (s.ctx.predsOf.get(t.task_id) ?? []), succs = (t: Row) => (s.ctx.succsOf.get(t.task_id) ?? []);
  const start = (t: Row) => parseP6Date(t.act_start_date || t.early_start_date || t.target_start_date);
  const finish = (t: Row) => parseP6Date(t.act_end_date || t.early_end_date || t.target_end_date);
  const durD = (t: Row) => Number(t.target_drtn_hr_cnt || 0) / s.dh.task(t);
  const p = s.projs[0];
  const cal = p ? s.projCal(p) : null;
  const st = Math.min(...s.tasks.map((t) => start(t) ?? Infinity)), fi = Math.max(...s.tasks.map((t) => finish(t) ?? -Infinity));
  const makespan = cal && Number.isFinite(st) && Number.isFinite(fi) ? s.workDays(cal, st, fi) : 0;
  const metric = (id: string, name: string, v: number | null, b: Band, note: string, found: Offender[] = []): LintCheck => ({ ...check(id, name, 'info', found, null, b, maxIds, { note, weight: WEIGHTS[id] }), unit: 'ratio', metric: v == null ? null : Math.round(v * 1000) / 1000, numerator: null, denominator: null });

  if (want('connectivity')) {
    const np = s.tasks.filter((t) => !isWbs(t) && !preds(t).length), ns = s.tasks.filter((t) => !isWbs(t) && !succs(t).length);
    const v = Math.max(0, np.length - 1) + Math.max(0, ns.length - 1);
    out.push({ ...check('connectivity', 'Connectivity (one start, one finish)', 'warning', [...np.slice(0, 20).map((t) => offender(t, s, 'no predecessor')), ...ns.slice(0, 20).map((t) => offender(t, s, 'no successor'))], null, v ? 'fail' : 'pass', maxIds, { weight: WEIGHTS.connectivity, note: `${np.length} activities without predecessors and ${ns.length} without successors; a sound network has one of each.` }), unit: 'ratio', metric: v });
  }
  if (want('start_anchored')) {
    const starts = s.tasks.filter((t) => !isWbs(t) && !preds(t).length);
    const found: Offender[] = [];
    if (starts.length === 1) {
      const s0 = starts[0];
      for (const t of W) {
        const ps = preds(t);
        if (ps.length !== 1 || ps[0].pred_task_id !== s0.task_id) continue;
        const peers = W.filter((x) => x.wbs_id === t.wbs_id && x !== t).map((x) => start(x)).filter((x): x is number => x != null).sort((a, b) => a - b);
        const ts = start(t);
        if (peers.length < 2 || ts == null || !cal) continue;
        const med = peers[Math.floor(peers.length / 2)];
        if (s.workDays(cal, ts, med) >= 30) found.push(offender(t, s, `hung off ${s0.task_code}; its WBS peers start ${Math.round(s.workDays(cal, ts, med))} d later`));
      }
    }
    out.push(check('start_anchored', 'Disguised orphans (hung off the project start)', 'warning', found, null, found.length === 0 ? 'pass' : found.length <= 2 ? 'warn' : 'fail', maxIds, { weight: WEIGHTS.start_anchored, note: 'Activities whose only predecessor is the project start, while the rest of their WBS starts a month or more later: their real predecessor is missing.' }));
  }
  const work = W.reduce((a, t) => a + durD(t), 0);
  if (want('serialization')) { const v = work ? makespan / work : null; out.push(metric('serialization', 'Serialization index (makespan / total work)', v, v == null ? 'pass' : bandOf(v, [0.08, small ? 0.7 : 0.4], [0.05, small ? 0.9 : 0.6]), 'Near 1: everything in one line; very low: work bunched in parallel.')); }
  if (want('criticality')) { const c = W.filter((t) => !isDone(t) && isCritical(t, s.ctx)).length, v = W.length ? c / W.length : null; out.push(metric('criticality', 'Criticality ratio (critical work / work)', v, v == null ? 'pass' : bandOf(v, [0.1, 0.35], [0.05, 0.5]), 'Share of work activities on the critical path.')); }
  if (want('single_file') && cal && makespan > 0) {
    const day0 = Math.floor(st / 1440), dayN = Math.floor(fi / 1440), n = dayN - day0 + 1, cnt = new Int32Array(n + 1);
    for (const t of W) { const a = start(t), b = finish(t); if (a == null || b == null) continue; cnt[Math.max(0, Math.floor(a / 1440) - day0)]++; cnt[Math.min(n, Math.floor(b / 1440) - day0 + 1)]--; }
    let run = 0, workDays = 0, single = 0;
    for (let d = 0; d < n; d++) { run += cnt[d]; if (!cal.shiftsOn(day0 + d).length) continue; workDays++; if (run <= 1) single++; }
    const v = workDays ? single / workDays : 0;
    out.push(metric('single_file', 'Single-file share (working days with at most one activity running)', v, bandOf(v, [0, small ? 0.4 : 0.15], [0, small ? 0.65 : 0.3]), 'Days when the job hangs on one activity.'));
  }
  if (want('longest_chain')) {
    const ids = s.tasks.filter((t) => !isWbs(t)).map((t) => t.task_id), set = new Set(ids), indeg = new Map(ids.map((i) => [i, 0])), len = new Map(ids.map((i) => [i, 1]));
    for (const r of s.rels) if (set.has(r.pred_task_id) && set.has(r.task_id)) indeg.set(r.task_id, indeg.get(r.task_id)! + 1);
    const q = ids.filter((i) => indeg.get(i) === 0); let seen = 0, best = 0;
    while (q.length) { const i = q.pop()!; seen++; best = Math.max(best, len.get(i)!); for (const r of s.ctx.succsOf.get(i) ?? []) { if (!set.has(r.task_id)) continue; len.set(r.task_id, Math.max(len.get(r.task_id)!, len.get(i)! + 1)); indeg.set(r.task_id, indeg.get(r.task_id)! - 1); if (!indeg.get(r.task_id)) q.push(r.task_id); } }
    const v = seen === ids.length && ids.length ? best / ids.length : null;
    out.push(metric('longest_chain', 'Longest chain share (activities in the longest chain / all)', v, v == null ? 'pass' : bandOf(v, [0, small ? 0.75 : 0.5], [0, small ? 0.9 : 0.75]), v == null ? 'The network has loops; not measured.' : `The longest chain has ${best} activities.`));
  }
  const links = s.rels.filter((r) => workIds.has(r.pred_task_id) || workIds.has(r.task_id));
  if (want('non_fs_share')) { const v = links.length ? links.filter((r) => (r.pred_type || 'PR_FS') !== 'PR_FS').length / links.length : null; out.push(metric('non_fs_share', 'Non-FS link share', v, v == null ? 'pass' : bandOf(v, [0.05, 0.5], [0.02, 0.7]), 'Some SS/FF overlap is healthy; too much hides the sequence.')); }
  if (want('edges_per_activity')) { const v = W.length ? links.length / W.length : null; out.push(metric('edges_per_activity', 'Links per work activity', v, v == null ? 'pass' : bandOf(v, [1.2, 3], [0.9, 4]), 'Too few: logic missing; too many: tangled.')); }
  if (want('redundant_links')) {
    // an FS (lag >= 0) link implied by another FS (lag >= 0) path between the same two activities
    const fsOut = new Map<string, Row[]>();
    for (const r of s.rels) if ((r.pred_type || 'PR_FS') === 'PR_FS' && Number(r.lag_hr_cnt || 0) >= 0) fsOut.set(r.pred_task_id, [...(fsOut.get(r.pred_task_id) ?? []), r]);
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
    out.push({ ...check('redundant_links', 'Redundant FS links', 'info', red, fsN, bandOf(v, [0, 0.05], [0, 0.15]), maxIds, { weight: WEIGHTS.redundant_links, note: 'Links already implied by another chain; they clutter the network without adding logic.' }), fixes: red.slice(0, maxIds || red.length).map((x) => { const [a, b] = x.id.split(' -> '); return { activities: [a, b], fix: `Delete ${a} FS ${b}`, ops: [{ op: 'delete_relationship', pred: a, succ: b, type: 'FS' }] }; }) });
  }
  if (want('ss_abuse')) {
    const bad = s.rels.filter((r) => { const a = s.ctx.taskById.get(r.pred_task_id), b = s.ctx.taskById.get(r.task_id); return a && b && (r.pred_type === 'PR_SS' || r.pred_type === 'PR_FF') && nameKey(a) !== nameKey(b) && a.wbs_id !== b.wbs_id; })
      .map((r) => ({ id: `${s.ctx.taskById.get(r.pred_task_id)!.task_code} -> ${s.ctx.taskById.get(r.task_id)!.task_code}`, name: `${r.pred_type.slice(3)} across unrelated work`, value: 'check the overlap is real' }));
    const cap = Math.max(15, Math.ceil(0.03 * s.rels.length));
    out.push(check('ss_abuse', 'SS/FF links between unrelated work', 'info', bad, s.rels.length, bad.length > cap ? 'warn' : 'pass', maxIds, { note: `SS/FF links between different kinds of work in different WBS elements (more than ${cap} is a warning): overlaps used as shortcuts instead of real logic.` }));
  }
  return out;
}
