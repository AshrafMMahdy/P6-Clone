// Time-phased curves as P6's Activity Usage and Resource Usage profiles show them:
//  - progress curves per week or month: planned value (the baseline budget along the baseline dates; the current budget
//    and planned dates without a baseline), earned value (budget x % complete) and actual cost, both spread evenly from
//    the actual start to the data date (or actual finish); periods stored in the XER's financial-period tables (Store
//    Period Performance: TASKFIN with FINDATES) take precedence for the past; remaining cost along the remaining early
//    dates and along the remaining late dates; per-period and cumulative SPI and CPI; EAC, ETC, VAC and TCPI at the
//    data date;
//  - Earned Schedule (Lipke) in the totals: ES, the time at which the cumulative planned value equals the earned value now (interpolated inside the
//    period it falls in), AT, the actual time from the planned start to the data date, SPI(t) = ES / AT and SV(t) = ES - AT, in the curve's period
//    unit and as a date and working days of the project calendar; "not assessed" with the reason, never 1, where they cannot be worked out;
//  - a third basis, units: duration: planned value = each activity's baseline (else planned) duration spread evenly over its baseline (else planned) dates
//    on its calendar, earned = that duration x its % complete, so a schedule without costs or resource units has a planned value too;
//  - resource histograms: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining
//    late units or cost per period, the limit, over-allocation and its severity.
// Spreading is linear over each activity's working time. Values are hours (units) or the project currency (cost).
import { maxOf, minOf } from '../arrays.ts';
import { noDataDateReason, andList, projectsText, baselineChosen, cap, currentPlanUsed, notAssessed, refusal, tidyNotes } from '../notes.ts';
import { baselineOf, dataDateAssumedNotes, dataDateGaps, namesText } from './common.ts';
import { groupBy, indexBy, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { activityCosts, earnedValue, percentComplete, plannedShare, sumLines } from '../cost/rollup.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { bucketStart, nextBucket, resourceLimits, spreadUsage, type UsageBucket } from '../resource/usage.ts';
import type { WorkCalendar } from '../calendar/calendar.ts';

const n = (s: string | undefined) => Number(s || 0) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (t: number) => formatP6Date(t).slice(0, 10);

/** What the totals mean on the duration basis (every figure is a sum of the activities' working days, none is the length of the project; the project's time performance is SPI(t) / Earned Schedule). All of them are kept: each has a plain meaning in working days. */
export interface Grid { starts: number[]; ends: number[] }
export function makeGrid(from: number, to: number, period: 'week' | 'month'): Grid {
  const starts: number[] = [];
  for (let t = bucketStart(from, period as UsageBucket); t < to && starts.length < 5000; t = nextBucket(t, period as UsageBucket)) starts.push(t);
  return { starts, ends: starts.map((s) => nextBucket(s, period as UsageBucket)) };
}

/** Add qty spread evenly over the working time from a to b into the grid's periods (all of it at a when a >= b). */
export function spreadLinear(into: number[], g: Grid, qty: number, a: number, b: number, cal: WorkCalendar): void {
  if (!qty || !g.starts.length) return;
  const total = b > a ? cal.workBetween(a, b) : 0;
  if (total <= 0) { const i = g.ends.findIndex((e) => e > a); if (i >= 0 && a >= g.starts[0]) into[i] += qty; return; }
  for (let i = 0; i < g.starts.length; i++) {
    if (g.ends[i] <= a) continue;
    if (g.starts[i] >= b) break;
    const w = cal.workBetween(Math.max(a, g.starts[i]), Math.min(b, g.ends[i]));
    if (w > 0) into[i] += (qty * w) / total;
  }
}

export interface CurvePeriod {
  start: string; end: string;
  pv: number; ev: number | null; ac: number | null; remaining_early: number; remaining_late: number;
  cum_pv: number; cum_ev: number | null; cum_ac: number | null; cum_forecast_early: number; cum_forecast_late: number;
  spi: number | null; cpi: number | null; cum_spi: number | null; cum_cpi: number | null;
}
/** Earned Schedule at the data date (Lipke), added to the curve's totals. es, at, pd, sv_t are in periods (weeks or months, as the curve's period); es_date is the date at which the planned value equals the earned value now;
 *  the _days are working days of the first project's calendar from the planned start. All null, with the reason in notes, when they cannot be worked out. */
export interface EarnedSchedule { es: number | null; at: number | null; pd: number | null; spi_t: number | null; sv_t: number | null; es_date: string | null; es_days: number | null; at_days: number | null; sv_t_days: number | null; /** why it is not assessed (said once, in the notes), else null */ es_reason: string | null }
export interface ProgressCurves {
  report: 'Progress Curves'; units: 'cost' | 'hours' | 'duration'; period: 'week' | 'month'; data_date: string | null; baseline: string | null; baseline_how?: string;
  stored_periods: number;
  totals: { bac: number; pv: number; ev: number; ac: number; etc: number; eac: number; vac: number; spi: number | null; cpi: number | null; tcpi: number | null } & Omit<EarnedSchedule, 'es_reason'>;
  periods: CurvePeriod[]; /** what was left out or replaced, each sentence once */ notes: string[];
}

/** The call is refused (progressCurves throws this): the message says why, next what to do. The MCP layer turns it into the tool's refusal. */
export class CurvesRefused extends Error { next: string; constructor(message: string, next: string) { super(message); this.next = next; } }

export function progressCurves(db: Db, projIds: string[], o: { period?: 'week' | 'month'; units?: 'cost' | 'hours' | 'duration'; from?: number; to?: number; taskIds?: Set<string> } = {}): ProgressCurves {
  const period = o.period ?? 'month', units = o.units ?? 'cost';
  const open = new Set(projIds);
  const projs = rows(db, 'PROJECT').filter((p) => open.has(p.proj_id));
  // projects with different data dates have no single "now": every figure at the data date (planned value, actuals, EAC, VAC, TCPI, SPI, CPI, Earned Schedule) and the per-period curve would measure one project at another's date. There is no sound answer, so the call is refused before anything is computed
  const dates = projs.map((p) => parseP6Date(p.last_recalc_date) ?? null);
  if (projs.length > 1 && new Set(dates).size > 1) { const r = refusal(`${projectsText(projs.map((p) => p.proj_short_name))} have different data dates (${namesText(projs.map((p, i) => (dates[i] != null ? formatP6Date(dates[i]!).slice(0, 10) : 'none')))})`, `pass project: ${namesText(projs.map((p) => p.proj_short_name))} (one project at a time)`); throw new CurvesRefused(r.message, r.hint); }
  // (duration: level of effort has no duration of its own, it spans other activities', so it carries no planned duration)
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id) && t.task_type !== 'TT_WBS' && !(units === 'duration' && t.task_type === 'TT_LOE') && (!o.taskIds || o.taskIds.has(t.task_id)));
  const cals = calendarResolver(db, []);
  const projById = indexBy(projs, 'proj_id');
  const calOf = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(projById.get(t.proj_id)?.clndr_id);
  const asgBy = groupBy(rows(db, 'TASKRSRC'), 'task_id');
  const lines = activityCosts(db, projIds);
  const dd = minOf(projs.map((p) => parseP6Date(p.last_recalc_date) ?? Infinity));
  const dataDate = Number.isFinite(dd) ? dd : null;
  const notes: string[] = [...dataDateAssumedNotes(projs), ...dataDateGaps(projs, 'figures at the data date', null)];
  // baseline counterparts (dates of the planned value)
  const bl = new Map<string, Row>();
  // the project baseline, else the primary user baseline (BL1), as P6 Professional's baseline bars fall back
  let blName: string | null = null, blHow = '';
  const noBaseline: string[] = [];
  // the baseline P6 uses is the one ASSIGNED (the project baseline, else the primary one, BL1): a baseline that is only saved in the file is not picked; with none assigned the current project is its own baseline
  for (const p of projs) { const b = (p.sum_base_proj_id ? baselineOf(db, p, 'project') : null) ?? baselineOf(db, p, 'bl1'); if (b) { blName = b.name; blHow = b.how; for (const t of b.tasks.values()) bl.set(`${p.proj_id}|${t.task_code}`, t); if (!/project baseline$/.test(b.how)) notes.push(baselineChosen(p.proj_short_name, b.name, b.how)); } else noBaseline.push(p.proj_short_name); }
  if (noBaseline.length) notes.push(currentPlanUsed(noBaseline));

  // the quantities per activity (the planned quantity from the baseline activity when there is one; duration: in working days of the activity's calendar)
  const qOf = (t: Row) => {
    if (units === 'cost') { const l = lines.get(t.task_id)!; return { bac: l.bac, actual: l.ac, remaining: l.remaining }; }
    if (units === 'duration') {
      const cal = calOf(t), hpd = cal.hoursPerDay(), b = bl.get(`${t.proj_id}|${t.task_code}`) ?? t;
      if (!hpd) return { bac: 0, actual: 0, remaining: 0 };
      // actual = the working time from the actual start to the actual finish, or to the data date while it is under way
      const as = parseP6Date(t.act_start_date), end = Math.min(parseP6Date(t.act_end_date) ?? dataDate ?? -Infinity, dataDate ?? Infinity);
      return { bac: n(b.target_drtn_hr_cnt) / hpd, actual: as != null && end > as ? cal.workBetween(as, end) / 60 / hpd : 0, remaining: t.act_end_date ? 0 : n(t.remain_drtn_hr_cnt) / hpd };
    }
    const a = asgBy.get(t.task_id) ?? [];
    const b = bl.get(`${t.proj_id}|${t.task_code}`);
    const bacUnits = b ? (asgBy.get(b.task_id) ?? []).reduce((s, x) => s + n(x.target_qty), 0) : a.reduce((s, x) => s + n(x.target_qty), 0);
    return { bac: bacUnits, actual: a.reduce((s, x) => s + n(x.act_reg_qty) + n(x.act_ot_qty), 0), remaining: a.reduce((s, x) => s + n(x.remain_qty), 0) };
  };
  const qCache = new Map<string, ReturnType<typeof qOf>>();
  const q = (t: Row) => qCache.get(t.task_id) ?? (qCache.set(t.task_id, qOf(t)), qCache.get(t.task_id)!);
  const d = (v?: string) => parseP6Date(v);
  const spanOf = (t: Row) => {
    const b = bl.get(`${t.proj_id}|${t.task_code}`) ?? t;
    return [d(b.target_start_date || b.early_start_date), d(b.target_end_date || b.early_end_date)] as const;
  };
  let from = o.from ?? Infinity, to = o.to ?? -Infinity;
  if (o.from == null || o.to == null) for (const t of tasks) {
    const [ps, pf] = spanOf(t);
    for (const x of [ps, d(t.act_start_date), d(t.early_start_date)]) if (x != null && o.from == null) from = Math.min(from, x);
    for (const x of [pf, d(t.act_end_date), d(t.early_end_date), d(t.late_end_date)]) if (x != null && o.to == null) to = Math.max(to, x);
  }
  const g = Number.isFinite(from) && Number.isFinite(to) && to > from ? makeGrid(from, to, period) : { starts: [], ends: [] };
  const N = g.starts.length;
  let plannedBac = 0, undatedBac = 0, plannedEv = 0, p0 = Infinity, p1 = -Infinity; // the planned value that was spread, the value earned on it, and the span it is spread over (Earned Schedule)
  const pv = new Array(N).fill(0), ev = new Array(N).fill(0), ac = new Array(N).fill(0), early = new Array(N).fill(0), late = new Array(N).fill(0);

  // stored financial periods (P6 Tools > Store Period Performance) for the past
  const fin = indexBy(rows(db, 'FINDATES'), 'fin_dates_id');
  const taskIds = new Set(tasks.map((t) => t.task_id));
  const stored = rows(db, 'TASKFIN').filter((f) => taskIds.has(f.task_id));
  const storedBy = groupBy(stored, 'task_id');
  const usedFin = new Set<string>();
  const into = (arr: number[], t: number, v: number) => { const i = g.ends.findIndex((e) => e > t); if (i >= 0 && t >= (g.starts[0] ?? Infinity)) arr[i] += v; };

  for (const t of tasks) {
    const { bac, actual, remaining } = q(t);
    const cal = calOf(t);
    const [ps, pf] = spanOf(t);
    const pct = percentComplete(t, asgBy.get(t.task_id) ?? []);
    if (bac && ps != null && pf != null) { spreadLinear(pv, g, bac, ps, pf, cal); plannedBac += bac; plannedEv += bac * pct; p0 = Math.min(p0, ps); p1 = Math.max(p1, pf); }
    else if (bac) undatedBac += bac;
    const evTotal = bac * pct;
    const as = d(t.act_start_date);
    let evLeft = evTotal, acLeft = actual, lastFinEnd = as;
    if (units === 'cost') for (const f of storedBy.get(t.task_id) ?? []) {
      const fd = fin.get(f.fin_dates_id); const fe = d(fd?.end_date);
      if (fe == null) continue;
      usedFin.add(f.fin_dates_id);
      const fAc = n(f.act_work_cost) + n(f.act_equip_cost) + n(f.act_mat_cost) + n(f.act_expense_cost);
      into(ev, fe - 1, n(f.bcwp)); into(ac, fe - 1, fAc);
      evLeft -= n(f.bcwp); acLeft -= fAc;
      if (lastFinEnd == null || fe > lastFinEnd) lastFinEnd = fe;
    }
    if (as != null && dataDate != null) {
      // what was earned and spent belongs before the data date, also when an actual date is (wrongly) after it
      const endPast = Math.min(d(t.act_end_date) ?? dataDate, dataDate);
      let a0 = lastFinEnd != null && lastFinEnd > as ? Math.min(lastFinEnd, endPast) : as;
      if (a0 >= endPast) a0 = endPast - 1; // started on or after the data date: all of it in the period before
      spreadLinear(ev, g, evLeft, a0, Math.max(a0, endPast), cal);
      spreadLinear(ac, g, acLeft, a0, Math.max(a0, endPast), cal);
    }
    if (remaining) {
      const rs = d(t.restart_date || t.early_start_date), re = d(t.reend_date || t.early_end_date);
      if (rs != null && re != null) spreadLinear(early, g, remaining, rs, re, cal);
      const ls = d(t.rem_late_start_date || t.late_start_date), le = d(t.rem_late_end_date || t.late_end_date);
      if (ls != null && le != null) spreadLinear(late, g, remaining, ls, le, cal);
      else if (rs != null && re != null) spreadLinear(late, g, remaining, rs, re, cal);
    }
  }

  const periods: CurvePeriod[] = [];
  let cpv = 0, cev = 0, cac = 0, cfe = 0, cfl = 0;
  for (let i = 0; i < N; i++) {
    const past = dataDate != null && g.starts[i] < dataDate;
    cpv += pv[i]; cev += ev[i]; cac += ac[i]; cfe += ac[i] + early[i]; cfl += ac[i] + late[i];
    periods.push({
      start: iso(g.starts[i]), end: iso(g.ends[i]),
      pv: r2(pv[i]), ev: past ? r2(ev[i]) : null, ac: past ? r2(ac[i]) : null, remaining_early: r2(early[i]), remaining_late: r2(late[i]),
      cum_pv: r2(cpv), cum_ev: past ? r2(cev) : null, cum_ac: past ? r2(cac) : null, cum_forecast_early: r2(cfe), cum_forecast_late: r2(cfl),
      spi: past && pv[i] ? r2(ev[i] / pv[i]) : null, cpi: past && ac[i] ? r2(ev[i] / ac[i]) : null,
      cum_spi: past && cpv ? r2(cev / cpv) : null, cum_cpi: past && cac ? r2(cev / cac) : null,
    });
  }

  // totals at the data date (the same figures as the earned value lookup, in cost; or in hours)
  let totals: Omit<ProgressCurves['totals'], keyof EarnedSchedule>;
  if (units === 'cost') {
    const e = earnedValue(sumLines(tasks.map((t) => lines.get(t.task_id)!).filter(Boolean)));
    totals = { bac: r2(e.bac), pv: r2(e.pv), ev: r2(e.ev), ac: r2(e.ac), etc: r2(e.etc), eac: r2(e.eac), vac: r2(e.vac), spi: e.pv ? r2(e.spi) : null, cpi: e.ac ? r2(e.cpi) : null, tcpi: e.bac - e.ac ? r2(e.tcpi) : null };
  } else {
    const s = tasks.map(q).reduce((a, x) => ({ bac: a.bac + x.bac, actual: a.actual + x.actual, remaining: a.remaining + x.remaining }), { bac: 0, actual: 0, remaining: 0 });
    const evH = tasks.reduce((a, t) => a + q(t).bac * percentComplete(t, asgBy.get(t.task_id) ?? []), 0);
    // the planned value AT the data date, as the cost basis cuts it (rollup.ts plannedShare: the share of the activity's baseline, else planned, dates elapsed at the data date), not to the end of the period that holds the data date: SPI does not depend on the period length
    const pvH = dataDate == null ? 0 : tasks.reduce((a, t) => a + q(t).bac * plannedShare(t, bl.get(`${t.proj_id}|${t.task_code}`), dataDate), 0);
    totals = { bac: r2(s.bac), pv: r2(pvH), ev: r2(evH), ac: r2(s.actual), etc: r2(s.remaining), eac: r2(s.actual + s.remaining), vac: r2(s.bac - s.actual - s.remaining), spi: pvH ? r2(evH / pvH) : null, cpi: s.actual ? r2(evH / s.actual) : null, tcpi: s.bac - s.actual ? r2((s.bac - evH) / (s.bac - s.actual)) : null };
  }
  if (totals.ev > 0 && totals.ac === 0) notes.push(notAssessed('CPI', `no actual ${units === 'cost' ? 'cost' : units === 'duration' ? 'duration' : 'units'} is recorded`));
  if (!totals.bac) notes.push(units === 'cost' ? `No budgeted cost in ${andList(projs.map((p) => p.proj_short_name))}: pass units: duration or hours, or load costs.` : units === 'duration' ? `No planned duration in ${andList(projs.map((p) => p.proj_short_name))}: every activity is a milestone or has none.` : `No budgeted units in ${andList(projs.map((p) => p.proj_short_name))}: pass units: duration, or load resources.`);
  const sched = earnedSchedule({ g, pv, period, units, baseline: blName, plannedBac, undatedBac, plannedEv, p0, p1, dataDate, cal: projs[0] ? cals.fallback(projs[0].clndr_id) : null });
  const { es_reason: _reason, ...schedFigures } = sched;
  return { report: 'Progress Curves', units, period, data_date: dataDate != null ? formatP6Date(dataDate) : null, baseline: blName, ...(blName ? { baseline_how: blHow } : {}), stored_periods: usedFin.size, totals: { ...totals, ...schedFigures }, periods, notes: tidyNotes([...notes, ...(sched.es_reason && totals.bac ? [notAssessed('Earned Schedule', dataDate == null ? noDataDateReason(projectsText(projs.filter((p) => parseP6Date(p.last_recalc_date) == null).map((p) => p.proj_short_name)), null) : sched.es_reason)] : [])]) };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Earned Schedule not assessed, with the reason. */
const noEarnedSchedule = (es_reason: string): EarnedSchedule => ({ es: null, at: null, pd: null, spi_t: null, sv_t: null, es_date: null, es_days: null, at_days: null, sv_t_days: null, es_reason });

/** Earned Schedule (Lipke) from the planned-value curve: ES = the time at which the cumulative planned value equals the earned value now, found in the period where the cumulative curve passes it and interpolated
 *  linearly across the part of that period the planned value is spread over (the whole period, except where the plan starts or ends inside it); AT = the actual time from the planned start to the data date;
 *  SPI(t) = ES / AT; SV(t) = ES - AT. Positions are in periods from the grid, with the fraction of a period counted by the calendar time elapsed in it. Earned value at or above the whole planned value = the planned duration
 *  (a finished project: SPI(t) = PD / AT, which stays meaningful where cost-based SPI returns to 1). Not assessed, with the reason: no planned value, no data date, no planned dates, a window that cuts the planned curve,
 *  a data date that is not after the planned start. */
function earnedSchedule(o: { g: Grid; pv: number[]; period: 'week' | 'month'; units: 'cost' | 'hours' | 'duration'; baseline: string | null; plannedBac: number; undatedBac: number; plannedEv: number; p0: number; p1: number; dataDate: number | null; cal: WorkCalendar | null }): EarnedSchedule {
  const none = noEarnedSchedule;
  const { g, pv, period, dataDate } = o;
  if (!(o.plannedBac > 0) && o.undatedBac > 0) return none('there is no planned curve (the activities with a planned value have no planned dates)');
  if (!(o.plannedBac > 0)) return none('the planned value is 0');
  if (dataDate == null) return none('the project has no data date');
  if (!g.starts.length || !(o.p1 > o.p0)) return none('there is no planned curve (the planned value all falls on one instant)');
  const planned = pv.reduce((a, x) => a + x, 0);
  // 1e-9 (relative): floating-point tolerance. The planned value summed period by period can fall a rounding error short of the budget that was spread, which would read a whole curve as cut by the window
  if (planned < o.plannedBac * (1 - 1e-9)) return none('the from/to window cuts the planned curve; leave from and to out');
  // positions in periods from the first period of the grid: the periods whole, then the share of the period elapsed
  const pos = (t: number) => {
    const b = bucketStart(t, period), e = nextBucket(b, period);
    let k = 0;
    if (b >= g.starts[0]) for (let x = g.starts[0]; x < b; x = nextBucket(x, period)) k++;
    else for (let x = b; x < g.starts[0]; x = nextBucket(x, period)) k--;
    return k + (t - b) / (e - b);
  };
  if (!(dataDate > o.p0)) return none('the data date is not after the planned start');
  const earned = Math.min(o.plannedEv, planned);
  // the period where the cumulative planned value passes the earned value
  let tStar = o.p0;
  // the same 1e-9 tolerance: an earned value equal to the whole planned value up to rounding is all of it (the planned finish)
  if (earned >= planned * (1 - 1e-9)) tStar = o.p1;
  else if (earned > 0) {
    let cum = 0;
    for (let i = 0; i < pv.length; i++) {
      // 1e-12 (relative): floating-point tolerance, tighter because it compares a running sum with one value: an earned value that equals a cumulative planned value up to rounding is found in the period where the curve reaches it, not the next
      if (cum + pv[i] >= earned * (1 - 1e-12) && pv[i] > 0) {
        const lo = Math.max(g.starts[i], o.p0), hi = Math.min(g.ends[i], o.p1);
        tStar = lo + ((earned - cum) / pv[i]) * (hi - lo);
        break;
      }
      cum += pv[i];
    }
  }
  const origin = pos(o.p0), es = pos(tStar) - origin, at = pos(dataDate) - origin, pd = pos(o.p1) - origin;
  const hpd = o.cal?.hoursPerDay() || 0, days = (a: number, b: number) => (o.cal && hpd ? r3(o.cal.workBetween(a, b) / 60 / hpd) : null);
  const esDays = days(o.p0, tStar), atDays = days(o.p0, dataDate);
  return {
    es: r3(es), at: r3(at), pd: r3(pd), spi_t: r3(es / at), sv_t: r3(es - at), es_date: iso(tStar), es_days: esDays, at_days: atDays, sv_t_days: esDays != null && atDays != null ? r3(esDays - atDays) : null,
    es_reason: null,
  };
}

export interface HistogramPeriod { start: string; end: string; budgeted: number; actual: number; remaining_early: number; remaining_late: number; limit: number | null; over_allocated: number; available: number | null }
export interface ResourceHistogram { resource: string; name: string; units: 'hours' | 'cost'; /** false: Max Units/Time is 0 (no limit set): the demand is shown and no over-allocation is counted */ limit_set: boolean; peak: { start: string; demand: number; limit: number | null } | null; over_allocated_periods: number; severity: 'none' | 'minor' | 'moderate' | 'critical'; periods: HistogramPeriod[]; /** how many periods it has (an answer for many resources lists them for the 10 most over-allocated) */ periods_total: number }

/** Resource Usage Profile per resource (units = hours by default, or cost). */
export function resourceHistograms(db: Db, projIds: string[], o: { resources?: string[]; period?: 'week' | 'month'; cost?: boolean; threshold?: number } = {}): { report: 'Resource Histogram'; period: string; resources: ResourceHistogram[] } {
  const period = o.period ?? 'week', open = new Set(projIds), threshold = o.threshold ?? 1;
  const tasks = indexBy(rows(db, 'TASK'), 'task_id');
  const asg = rows(db, 'TASKRSRC').filter((a) => open.has(a.proj_id || tasks.get(a.task_id)?.proj_id || '') && a.rsrc_id);
  const R = indexBy(rows(db, 'RSRC'), 'rsrc_id');
  const want = o.resources?.length ? new Set(o.resources.map((x) => x.toLowerCase())) : null;
  const ids = [...new Set(asg.map((a) => a.rsrc_id))].filter((id) => !want || want.has((R.get(id)?.rsrc_short_name ?? '').toLowerCase()));
  const d = (v?: string) => parseP6Date(v);
  let from = Infinity, to = -Infinity;
  for (const a of asg) { const t = tasks.get(a.task_id); for (const x of [d(a.target_start_date || t?.target_start_date), d(a.act_start_date || t?.act_start_date), d(t?.early_start_date)]) if (x != null) from = Math.min(from, x); for (const x of [d(a.target_end_date || t?.target_end_date), d(t?.early_end_date), d(t?.late_end_date)]) if (x != null) to = Math.max(to, x); }
  if (!Number.isFinite(from) || !(to > from)) return { report: 'Resource Histogram', period, resources: [] };
  const g = makeGrid(from, to, period);
  const cals = calendarResolver(db, []);
  const limits = resourceLimits(db);
  const projOf = (t?: Row) => rows(db, 'PROJECT').find((p) => p.proj_id === t?.proj_id);
  const out: ResourceHistogram[] = [];
  for (const id of ids) {
    const N = g.starts.length;
    const budgeted = new Array(N).fill(0), late = new Array(N).fill(0);
    let actual: number[], early: number[], cap: number[] | null = null;
    if (!o.cost) {
      // actual and remaining early units with resource curves, and the limit, as the Resource Usage Profile
      const u = spreadUsage(db, projIds, { start: g.starts[0], end: g.ends[N - 1], bucket: period, rsrcId: id });
      const row = u.rows.find((x) => x.rsrcId === id)!;
      const idx = (b: number) => g.starts.indexOf(b);
      actual = new Array(N).fill(0); early = new Array(N).fill(0); cap = new Array(N).fill(0);
      u.buckets.forEach((b, i) => { const j = idx(b); if (j >= 0) { actual[j] += row.actual[i]; early[j] += row.remaining[i]; cap![j] += row.capacity[i]; } });
    } else { actual = new Array(N).fill(0); early = new Array(N).fill(0); }
    for (const a of asg.filter((x) => x.rsrc_id === id)) {
      const t = tasks.get(a.task_id); const cal = (t && cals.get(t.clndr_id)) || cals.fallback(projOf(t)?.clndr_id);
      const tq = o.cost ? n(a.target_cost) : n(a.target_qty), rq = o.cost ? n(a.remain_cost) : n(a.remain_qty), aq = n(a.act_reg_cost) + n(a.act_ot_cost);
      const ps = d(a.target_start_date || t?.target_start_date), pf = d(a.target_end_date || t?.target_end_date);
      if (ps != null && pf != null) spreadLinear(budgeted, g, tq, ps, pf, cal);
      const ls = d(a.rem_late_start_date || t?.rem_late_start_date || t?.late_start_date), le = d(a.rem_late_end_date || t?.rem_late_end_date || t?.late_end_date);
      if (ls != null && le != null) spreadLinear(late, g, rq, ls, le, cal);
      if (o.cost) {
        const as = d(a.act_start_date || t?.act_start_date), ae = d(a.act_end_date || t?.act_end_date) ?? d(projOf(t)?.last_recalc_date);
        if (as != null && ae != null) spreadLinear(actual, g, aq, as, Math.max(as, ae), cal);
        const rs = d(a.restart_date || t?.restart_date || t?.early_start_date), re = d(a.reend_date || t?.reend_date || t?.early_end_date);
        if (rs != null && re != null) spreadLinear(early, g, rq, rs, re, cal);
      }
    }
    const limitSet = limits.has(id); // no limit set (Max Units/Time 0): the demand is shown, no over-allocation is counted for it
    const periods: HistogramPeriod[] = g.starts.map((s, i) => {
      const demand = actual[i] + early[i], limit = cap && limitSet ? cap[i] : null;
      return { start: iso(s), end: iso(g.ends[i]), budgeted: r2(budgeted[i]), actual: r2(actual[i]), remaining_early: r2(early[i]), remaining_late: r2(late[i]), limit: limit != null ? r2(limit) : null, over_allocated: limit != null && demand > limit * threshold ? r2(demand - limit) : 0, available: limit != null ? r2(Math.max(0, limit - demand)) : null };
    });
    const peakI = periods.reduce((m, p, i) => (p.actual + p.remaining_early > periods[m].actual + periods[m].remaining_early ? i : m), 0);
    const ratio = Math.max(0, maxOf(periods.map((p) => (p.limit ? (p.actual + p.remaining_early) / p.limit : 0))));
    out.push({
      resource: R.get(id)?.rsrc_short_name ?? id, name: R.get(id)?.rsrc_name ?? '', units: o.cost ? 'cost' : 'hours', limit_set: limitSet,
      peak: periods.length ? { start: periods[peakI].start, demand: r2(periods[peakI].actual + periods[peakI].remaining_early), limit: periods[peakI].limit } : null,
      over_allocated_periods: periods.filter((p) => p.over_allocated > 0).length,
      severity: o.cost || !limitSet || ratio <= threshold ? 'none' : ratio >= 2 ? 'critical' : ratio >= 1.5 ? 'moderate' : 'minor',
      periods, periods_total: periods.length,
    });
  }
  return { report: 'Resource Histogram', period, resources: out };
}
