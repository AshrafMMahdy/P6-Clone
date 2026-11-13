// baseline_variance: the schedule as planned (a baseline, or another schedule) against the schedule as it stands, and who and what delayed it, on the open file's own tables. Ported from our copy of the Bellator
// Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/forensics/": asPlannedVsBuilt.ts for the per-activity variance, slip classes and critical-path overlay; delayAnalysis.ts for the delay drivers
// and causal chains (its concurrency options are off by default and not carried over: windows_analysis apportions delay between causes); baselineCompare.ts only for its per-activity variance, whose SPI(t) is the Earned Schedule of progress_curves and whose BEI is the clone's one BEI, forensic.ts beiFigures). The clone reads the real thing:
// P6's stored total float and critical flag (no second CPM), working days of each activity's calendar, the real baselines, the actual dates and the data date. Where an input is absent the part is not assessed with the
// reason. The other side is a baseline (the earlier side) or another schedule (as_planned); the open project is the later, as-built side.
import { rows, groupBy, type Db, type Row } from '../db.ts';
import { formatP6Date } from '../dates.ts';
import { isCritical } from '../project/ctx.ts';
import { percentOf } from '../diff.ts';
import type { Update } from './delay.ts';
import { baselineOf, baselineFinish, forecastFinish, isDone, isLoe, isMilestone, isWbs, makeScope } from './common.ts';
import { baselinePairs, beiFigures, currentStart, schedulePairs, varianceDetail, type ActivityVariance, type Assessed, type ReferencePairs, type SlipClass } from './forensic.ts';

/** A delay driver is an activity whose finish is this many working days or more behind the other side (delayAnalysis.ts:96, :113-114: min_impact_days default 1; the source's number, not yet agreed with the owner: ledger item 26). */
export const DRIVER_MIN_DAYS = 1;
export type VarianceType = 'start_delay' | 'finish_delay' | 'duration_overrun' | 'compound_delay';
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface Driver {
  id: string; name: string; project?: string;
  /** finish variance, working days of the activity's calendar (positive = later than the other side) */
  delay_days: number; start_variance_days: number | null; duration_variance_days: number | null;
  variance_type: VarianceType;
  reference_start: string | null; reference_finish: string | null; current_start: string | null; current_finish: string | null;
  /** critical in P6's stored float; null for finished work (P6 keeps no float for it) */
  on_critical_path: boolean | null;
  /** the activities after it in the logic, any relationship, counted once each (delayAnalysis.ts:303-313) */
  successors_reached: number;
  /** (critical 1, not critical 0.5) x (1 + successors reached / activities); null where criticality is not known (delayAnalysis.ts:141) */
  causal_score: number | null;
  /** this driver's delay days over the sum of all drivers' delay days (delayAnalysis.ts:190-191) */
  share_of_driver_days: number;
  /** the value of the activity code named in responsibility_code, null for none; absent when no code was named */
  responsible?: string | null;
}
export interface Chain {
  root: string; impacted_milestone: string | null; ends_at: string; path: string[]; path_total: number;
  /** the root driver's delay days (delayAnalysis.ts:227) */
  delay_days: number;
}
export interface OverlayRow { id: string; name: string; project?: string; critical_in_reference: boolean | null; critical_now: boolean | null; newly_critical: boolean; no_longer_critical: boolean; /** critical now, and not in the other side at all (added since): not "newly critical", which needs a counterpart that was not critical */ added_and_critical: boolean }

export type Responsibility = { result: 'assessed'; code_type: string; parties: { party: string; drivers: number; delay_days: number }[]; note: string } | { result: 'not_assessed'; note: string };

export interface BaselineVarianceResult {
  report: 'Baseline variance';
  status: 'fail' | 'warning' | 'pass'; summary: string;
  compared_with: { kind: 'baseline' | 'as_planned'; name: string; how: string; projects_without?: string[] };
  data_date: string | null;
  activities: { compared: number; not_in_reference: number; without_dates: number };
  slip_classes: Record<SlipClass, number>;
  project_slip: Assessed<{ current_finish: string; reference_finish: string; working_days: number }>;
  totals: { project_slip_working_days: number | null; critical_drivers_delay_days: number; finished_drivers: { count: number; delay_days: number; note: string } };
  critical_overlay: Assessed<{ reference_critical_total: number; current_critical_total: number; newly_critical_total: number; added_and_critical_total: number; no_longer_critical_total: number }>;
  bei: Assessed<{ value: number; completed: number; due: number }>;
  duration_weighted_percent_complete: Assessed<{ value: number; earned_days: number; planned_days: number }>;
  drivers_total: number;
  responsibility: Responsibility;
  variances: ActivityVariance[]; drivers: Driver[]; chains: Chain[]; overlay: OverlayRow[];
  method: string[];
}
export type Refusal = { refused: true; message: string; next: string };

export const VARIANCE_METHOD = [
  'the other side is the baseline (project, bl1-bl3 or a saved baseline’s name) or another schedule (as_planned, matched by Activity ID, then by a name unique on both sides); the open project is the later, as-built side (asPlannedVsBuilt.ts:33-37)',
  'start, finish and duration variance per activity in working days of its calendar (positive = later or longer): current = actual, else forecast, else planned; other side = its actual / early / planned date (core/variance.ts:50-76, in calendar days there); duration = start to finish on each side',
  'slip classes of the finish variance: under 0 ahead, 0 on time, up to 5 days minor, up to 15 moderate, up to 30 major, more severe (variance.ts:19-26)',
  'critical path overlay: critical in each side’s own stored float (the source ran a CPM on each: asPlannedVsBuilt.ts:50-52); newly critical = critical now and in the other side with a counterpart that was not critical; an activity added since (critical now, no counterpart in the other side) is not newly critical, it is listed apart as added_and_critical; the other side must carry total float, else not assessed',
  'project slip = the latest current finish less the latest finish of the other side, working days of the project calendar, signed (delayAnalysis.ts:168-170 floors it at 0: not carried over, an early finish shows as a negative number)',
  `delay drivers: activities whose finish is ${DRIVER_MIN_DAYS} working day or more later than the other side (delayAnalysis.ts:96, :113-114), level of effort left out (its dates follow the work it spans); variance type from the start and duration variances: both later = compound_delay, duration longer = duration_overrun, start later = start_delay, else finish_delay (:121-124)`,
  'successors reached = activities after the driver in the logic, any relationship, each once (:303-313); causal score = (critical 1, else 0.5) x (1 + successors reached / activities) (:141)',
  'critical = P6’s stored float rule (the project’s critical-float limit or longest path); finished work has no float, so a finished driver is neither critical nor not: it is counted apart (finished_drivers) and has no causal score',
  'concurrent delay is not assessed: the source’s concurrency classification and its 50/50 split are both OFF by default (delayAnalysis.ts:98-99, :203-214), and so is here. A driver keeps its own variance type, and the responsibility table sums each party’s driver days in full. The days of a delay passed down a chain are not concurrent delay (that needs independent causes in the same window): windows_analysis apportions delay between causes',
  'two totals, side by side and not the same thing: project_slip_working_days (the schedule as a whole) and critical_drivers_delay_days (the sum of the critical drivers’ own delays; drivers delaying the same days each count theirs, so it can exceed the slip)',
  'responsibility: a P6 file has no delay-category field; the value of the activity code named in responsibility_code on each driver is its party, driver days summed per value (and no value)',
  'causal chain of a critical driver: along its critical successors, the smallest Activity ID first, to the first milestone (a milestone type or a zero duration), else to the end of the critical chain (:315-335)',
  'duration_weighted_percent_complete (the source’s schedule_performance_index, :240-247, a duration-weighted % complete, not SPI; SPI(t) is Earned Schedule in progress_curves): sum of (duration x % complete) over the sum of durations, durations in working days (the other side’s, else the original duration), level of effort and WBS summaries left out',
  'BEI: the clone’s one definition (dcma_14 check 14): tasks completed over tasks the other side planned to finish by the data date',
  'status: fail when the project slip is over 0 or any activity slipped by more than 15 working days (the source’s fail rules, asPlannedVsBuilt.ts:75 and delayAnalysis.ts:290), warning when any activity slipped, else pass',
];

export function baselineVariance(db: Db, o: { projIds?: string[]; hoursPerDay?: number; baseline?: string; asPlanned?: Update; responsibilityCode?: string }): BaselineVarianceResult | Refusal {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, calendarDays: true });
  const how = 'give the other side one of two ways: assign a baseline to the project (edit assign_baseline; baseline then names project, bl1, bl2, bl3 or a saved baseline’s name) or pass as_planned, another schedule as {handle} or {path}';
  // ---- the other side
  let ref: ReferencePairs, refRows: Row[], refCritical: (r: Row) => boolean, kind: 'baseline' | 'as_planned', bls: Map<string, ReturnType<typeof baselineOf>>, which = o.baseline ?? 'project';
  if (o.asPlanned) {
    if (s.projs.length !== 1) return { refused: true, message: `as_planned is one schedule and this file has ${s.projs.length} projects.`, next: 'Pass project to say which project it is compared with.' };
    const u = o.asPlanned, p = s.projs[0];
    const pr = schedulePairs(s, { name: u.name, db: u.db, projId: u.projId });
    if (pr.result === 'not_assessed') return { refused: true, message: pr.note, next: how };
    ref = pr; kind = 'as_planned';
    refRows = rows(u.db, 'TASK').filter((t) => t.proj_id === u.projId && !isWbs(t));
    const projs = new Map(rows(u.db, 'PROJECT').map((x) => [x.proj_id, x]));
    refCritical = (r) => isCritical(r, { proj: projs });
    // for the BEI the other schedule stands as the baseline: its activities under the Activity ID of the activity they were matched with
    const tasks = new Map<string, Row>();
    for (const [t, b] of ref.pairs) if (b) tasks.set(t.task_code, { ...b, task_code: t.task_code });
    bls = new Map([[p.proj_id, { projId: u.projId, name: u.name, tasks, how: ref.how }]]);
  } else {
    const pr = baselinePairs(s, which);
    if (pr.result === 'not_assessed') return { refused: true, message: o.baseline != null ? `No baseline "${o.baseline}" for this project.` : `The project has no baseline assigned, and no other schedule was given.`, next: `${how.charAt(0).toUpperCase()}${how.slice(1)}.` };
    ref = pr; kind = 'baseline';
    bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, which)]));
    refRows = [...bls.values()].flatMap((b) => (b ? [...b.tasks.values()].filter((t) => !isWbs(t)) : []));
    refCritical = (r) => isCritical(r, s.ctx);
  }
  // ---- code type for the responsible party
  let codeTypeIds: Set<string> | null = null, codeTypeName = '';
  if (o.responsibilityCode != null) {
    const want = String(o.responsibilityCode).trim().toLowerCase(), types = rows(db, 'ACTVTYPE');
    const hit = types.filter((t) => String(t.actv_code_type ?? '').trim().toLowerCase() === want);
    if (!hit.length) return { refused: true, message: `No activity code type "${o.responsibilityCode}" in this file.`, next: `The file's activity code types: ${[...new Set(types.map((t) => t.actv_code_type))].join(', ') || 'none'}. Pass responsibility_code with one of them, or leave it out.` };
    codeTypeIds = new Set(hit.map((t) => t.actv_code_type_id)); codeTypeName = hit[0].actv_code_type;
  }

  const activities = s.tasks.filter((t) => !isWbs(t));
  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const text = (m: number | null) => (m == null ? null : formatP6Date(m));
  // ---- per activity: variance and slip class (rows worst first)
  const rowsV: ActivityVariance[] = [];
  const classes: Record<SlipClass, number> = { ahead: 0, on_time: 0, minor_slip: 0, moderate_slip: 0, major_slip: 0, severe_slip: 0 };
  let notIn = 0, noDates = 0;
  const base = (t: Row) => ({ id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}) });
  // the clone's one variance (forensic.ts varianceOf): exact working minutes, the slip class judged on them, the days shown rounded
  const exact = new Map<Row, { fin: number | null; start: number | null; dur: number | null; day: number }>(), rowOf = new Map<Row, ActivityVariance>();
  for (const x of varianceDetail(s, ref)) {
    exact.set(x.task, { fin: x.exact.finish, start: x.exact.start, dur: x.exact.duration, day: x.exact.day });
    rowOf.set(x.task, x.row);
    if (!x.ref) notIn++; else if (x.exact.finish == null) noDates++;
    if (x.row.slip_class) classes[x.row.slip_class]++;
    rowsV.push(x.row);
  }
  const order = new Map(rowsV.map((v, i) => [v, i]));
  rowsV.sort((a, b) => (b.finish_variance_days ?? -Infinity) - (a.finish_variance_days ?? -Infinity) || order.get(a)! - order.get(b)!);
  const compared = rowsV.filter((v) => v.slip_class).length;

  // ---- critical path overlay (the other side must carry float)
  const live = [...ref.pairs].filter(([t]) => !isLoe(t));
  const refHasFloat = live.some(([, b]) => b && !isDone(b) && b.total_float_hr_cnt !== '' && b.total_float_hr_cnt != null);
  const curHasFloat = live.some(([t]) => !isDone(t) && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null);
  let overlay: OverlayRow[] = [];
  let overlaySummary: BaselineVarianceResult['critical_overlay'];
  if (!refHasFloat || !curHasFloat) overlaySummary = { result: 'not_assessed', note: !curHasFloat ? 'No incomplete activity carries a total float: schedule the project (F9) first.' : `The ${kind === 'baseline' ? `${ref.name} baseline` : ref.name} carries no total float on its activities, so what was critical in it cannot be told (a baseline saved from a scheduled project does).` };
  else {
    for (const [t, b] of ref.pairs) {
      if (isLoe(t)) continue;
      const now = isDone(t) ? null : isCritical(t, s.ctx), was = b ? (isDone(b) ? null : refCritical(b)) : null;
      if (now || was) overlay.push({ ...base(t), critical_in_reference: was, critical_now: now, newly_critical: !!now && b != null && was === false, no_longer_critical: !!was && now === false, added_and_critical: !!now && b == null });
    }
    overlay.sort((a, b) => Number(b.newly_critical) - Number(a.newly_critical) || Number(b.added_and_critical) - Number(a.added_and_critical) || Number(!!b.critical_now) - Number(!!a.critical_now) || a.id.localeCompare(b.id));
    overlaySummary = { result: 'assessed', reference_critical_total: overlay.filter((x) => x.critical_in_reference).length, current_critical_total: overlay.filter((x) => x.critical_now).length, newly_critical_total: overlay.filter((x) => x.newly_critical).length, added_and_critical_total: overlay.filter((x) => x.added_and_critical).length, no_longer_critical_total: overlay.filter((x) => x.no_longer_critical).length };
  }

  // ---- project slip
  const latest = (xs: (number | null)[]) => xs.reduce<number | null>((m, x) => (x != null && (m == null || x > m) ? x : m), null);
  const curLatest = latest(activities.map(forecastFinish)), refLatest = latest(refRows.map(baselineFinish));
  const slipDays = curLatest != null && refLatest != null && s.projs[0] ? s.workDays(s.projCal(s.projs[0]), refLatest, curLatest) : null;
  const projectSlip: BaselineVarianceResult['project_slip'] = slipDays != null ? { result: 'assessed', current_finish: formatP6Date(curLatest!), reference_finish: formatP6Date(refLatest!), working_days: slipDays } : { result: 'not_assessed', note: 'The schedule or the other side has no finish date.' };

  // ---- delay drivers
  const succs = s.ctx.succsOf, taskById = s.ctx.taskById;
  const reached = (id: string) => { const seen = new Set<string>(), q = (succs.get(id) ?? []).map((r) => r.task_id); for (let i = 0; i < q.length; i++) { const x = q[i]; if (seen.has(x)) continue; seen.add(x); for (const r of succs.get(x) ?? []) q.push(r.task_id); } let n = 0; for (const x of seen) { const t = taskById.get(x); if (t && !isWbs(t)) n++; } return n; };
  const party = (() => {
    if (!codeTypeIds) return null;
    const values = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c.actv_code_name || c.short_name || c.actv_code_id]));
    const m = new Map<string, string>();
    for (const [taskId, as] of groupBy(rows(db, 'TASKACTV'), 'task_id')) { const a = as.find((x) => codeTypeIds!.has(x.actv_code_type_id)); if (a) m.set(taskId, values.get(a.actv_code_id) ?? a.actv_code_id); }
    return m;
  })();
  const drivers: Driver[] = [];
  for (const [t, b] of ref.pairs) {
    const x = exact.get(t)!;
    if (!b || isLoe(t) || x.fin == null) continue;
    if (x.fin < DRIVER_MIN_DAYS * x.day) continue;
    const v = rowOf.get(t)!;
    const startLater = (x.start ?? 0) > 0, durLonger = (x.dur ?? 0) > 0;
    const vtype: VarianceType = startLater && durLonger ? 'compound_delay' : durLonger ? 'duration_overrun' : startLater ? 'start_delay' : 'finish_delay';
    const crit = isDone(t) ? null : isCritical(t, s.ctx), n = reached(t.task_id);
    drivers.push({
      ...base(t), delay_days: v.finish_variance_days!, start_variance_days: v.start_variance_days, duration_variance_days: v.duration_variance_days, variance_type: vtype,
      reference_start: v.reference_start, reference_finish: v.reference_finish, current_start: v.current_start, current_finish: v.current_finish,
      on_critical_path: crit, successors_reached: n, causal_score: crit == null ? null : r3((crit ? 1 : 0.5) * (1 + n / Math.max(1, activities.length))), share_of_driver_days: 0,
      ...(party ? { responsible: party.get(t.task_id) ?? null } : {}),
    });
  }
  const byTask = new Map<Driver, Row>(); const taskOfDriver = new Map<string, Row>();
  for (const [t] of ref.pairs) taskOfDriver.set(`${base(t).project ?? ''}|${base(t).id}`, t);
  for (const d of drivers) byTask.set(d, taskOfDriver.get(`${d.project ?? ''}|${d.id}`)!);
  const sumAll = drivers.reduce((a, d) => a + d.delay_days, 0);
  for (const d of drivers) d.share_of_driver_days = sumAll ? r3(d.delay_days / sumAll) : 0;
  drivers.sort((a, b) => b.delay_days - a.delay_days);

  const crit = drivers.filter((d) => d.on_critical_path === true);

  // ---- totals
  const criticalSum = r2(crit.reduce((a, d) => a + d.delay_days, 0));
  const finished = drivers.filter((d) => d.on_critical_path === null);
  const totals = { project_slip_working_days: slipDays, critical_drivers_delay_days: criticalSum, finished_drivers: { count: finished.length, delay_days: r2(finished.reduce((a, d) => a + d.delay_days, 0)), note: 'Finished work has no float in P6: whether these were critical cannot be told, so their days are not in critical_drivers_delay_days.' } };

  // ---- responsibility
  let responsibility: Responsibility;
  if (!party) responsibility = { result: 'not_assessed', note: `A P6 file has no field for who is responsible for a delay. Pass responsibility_code: the name of an activity code type whose value on each activity is its party (for example "Responsibility"). Activity code types in this file: ${[...new Set(rows(db, 'ACTVTYPE').map((t) => t.actv_code_type))].join(', ') || 'none (add one and assign it to the activities)'}.` };
  else {
    // each party's driver days in full (the source's default, delayAnalysis.ts:203-214 with both options off)
    const sums = new Map<string, { drivers: number; days: number }>();
    for (const d of drivers) {
      const key = d.responsible ?? 'no value', e = sums.get(key) ?? sums.set(key, { drivers: 0, days: 0 }).get(key)!;
      e.drivers++; e.days += d.delay_days;
    }
    responsibility = { result: 'assessed', code_type: codeTypeName, parties: [...sums].map(([k, e]) => ({ party: k, drivers: e.drivers, delay_days: r2(e.days) })).sort((a, b) => b.delay_days - a.delay_days || a.party.localeCompare(b.party)), note: `Driver days per value of the activity code "${codeTypeName}", each driver's days in full; "no value" is a driver with no value of it. Concurrent delay is not assessed here: windows_analysis apportions delay between causes.` };
  }

  // ---- causal chains: critical drivers along their critical successors to the first milestone
  const isMile = (t: Row) => isMilestone(t) || Number(t.target_drtn_hr_cnt || 0) === 0;
  const chains: Chain[] = crit.map((d) => {
    const root = byTask.get(d)!, path = [root], guard = new Set([root.task_id]);
    let cur = root, mile: Row | null = null;
    for (;;) {
      const next = (succs.get(cur.task_id) ?? []).map((r) => taskById.get(r.task_id)).filter((x): x is Row => !!x && !isDone(x) && isCritical(x, s.ctx) && !guard.has(x.task_id)).sort((a, b) => a.task_code.localeCompare(b.task_code))[0];
      if (!next) break;
      path.push(next); guard.add(next.task_id); cur = next;
      if (isMile(next)) { mile = next; break; }
    }
    if (!mile && isMile(cur)) mile = cur;
    return { root: d.id, impacted_milestone: mile?.task_code ?? null, ends_at: cur.task_code, path: path.map((t) => t.task_code), path_total: path.length, delay_days: d.delay_days };
  });

  // ---- BEI and the duration-weighted percent complete
  const bei = beiFigures(s, bls, which, { matched: !!o.asPlanned });
  const asg = groupBy(rows(db, 'TASKRSRC'), 'task_id');
  let earned = 0, planned = 0;
  for (const [t, b] of ref.pairs) {
    if (isLoe(t)) continue;
    const dur = (b ? Number(b.target_drtn_hr_cnt || 0) / s.dh.task(t) : 0) || Number(t.target_drtn_hr_cnt || 0) / s.dh.task(t);
    const pctDone = isDone(t) ? 100 : percentOf(t, asg.get(t.task_id) ?? []) ?? 0;
    earned += dur * (pctDone / 100); planned += dur;
  }
  const slipped = classes.minor_slip + classes.moderate_slip + classes.major_slip + classes.severe_slip;
  const status = (slipDays != null && slipDays > 0) || classes.major_slip > 0 || classes.severe_slip > 0 ? 'fail' : slipped > 0 ? 'warning' : 'pass';
  const newly = overlaySummary.result === 'assessed' ? overlaySummary.newly_critical_total : null, added = overlaySummary.result === 'assessed' ? overlaySummary.added_and_critical_total : 0;
  return {
    report: 'Baseline variance', status,
    summary: `${slipped} activit${slipped === 1 ? 'y' : 'ies'} slipped of ${compared} compared; project slip ${slipDays != null ? `${slipDays} working days` : 'not assessed'}; ${drivers.length} delay driver(s), ${criticalSum} working days on critical drivers; ${newly != null ? `${newly} newly critical${added ? `, ${added} added since and critical` : ''}` : 'newly critical not assessed'}`,
    compared_with: { kind, name: ref.name, how: ref.how, ...(ref.projects_without.length ? { projects_without: ref.projects_without } : {}) },
    data_date: text(dd), activities: { compared, not_in_reference: notIn, without_dates: noDates }, slip_classes: classes,
    project_slip: projectSlip, totals, critical_overlay: overlaySummary,
    bei: bei.result === 'assessed' ? { result: 'assessed', value: bei.value, completed: bei.completed, due: bei.due } : { result: 'not_assessed', note: bei.note },
    duration_weighted_percent_complete: planned > 0 ? { result: 'assessed', value: r3(earned / planned), earned_days: r2(earned), planned_days: r2(planned) } : { result: 'not_assessed', note: 'No activity has a duration.' },
    drivers_total: drivers.length, responsibility, variances: rowsV, drivers, chains, overlay, method: VARIANCE_METHOD,
  };
}

/** The answer (every list cut to the clone's list rule, with its true total beside it), the whole result, and the result tables. */
export function shapeVariance(r: BaselineVarianceResult, first: <T>(l: T[]) => T[]) {
  const cutChain = (c: Chain) => ({ ...c, path: first(c.path) });
  const parties = r.responsibility.result === 'assessed' ? { parties: first(r.responsibility.parties), parties_total: r.responsibility.parties.length } : {};
  const answer = {
    ...r,
    responsibility: r.responsibility.result === 'assessed' ? { ...r.responsibility, ...parties } : r.responsibility,
    variances: first(r.variances), variances_total: r.variances.length,
    drivers: first(r.drivers), drivers_total: r.drivers.length,
    chains: first(r.chains).map(cutChain), chains_total: r.chains.length,
    overlay: first(r.overlay), overlay_total: r.overlay.length,
  };
  const whole = { ...r, variances_total: r.variances.length, chains_total: r.chains.length, overlay_total: r.overlay.length };
  const tables = [
    { name: 'variances', columns: ['id', 'name', 'project', 'reference_start', 'reference_finish', 'current_start', 'current_finish', 'start_variance_days', 'finish_variance_days', 'duration_variance_days', 'slip_class'], rows: r.variances },
    { name: 'drivers', columns: ['id', 'name', 'project', 'delay_days', 'variance_type', 'on_critical_path', 'successors_reached', 'causal_score', 'share_of_driver_days', 'start_variance_days', 'duration_variance_days', 'reference_start', 'reference_finish', 'current_start', 'current_finish', 'responsible'],
      rows: r.drivers },
    { name: 'chains', columns: ['root', 'impacted_milestone', 'ends_at', 'delay_days', 'path_total', 'path'], rows: r.chains.map((c) => ({ ...c, path: c.path.join(' > ') })) },
    { name: 'critical_overlay', columns: ['id', 'name', 'project', 'critical_in_reference', 'critical_now', 'newly_critical', 'added_and_critical', 'no_longer_critical'], rows: r.overlay },
  ];
  return { answer, whole, tables };
}
