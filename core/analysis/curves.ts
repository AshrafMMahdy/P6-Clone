// Time-phased curves as P6's Activity Usage and Resource Usage profiles show them:
//  - progress curves per week or month: planned value (the baseline budget along the baseline dates; the current budget
//    and planned dates without a baseline), earned value (budget x % complete) and actual cost, both spread evenly from
//    the actual start to the data date (or actual finish); periods stored in the XER's financial-period tables (Store
//    Period Performance: TASKFIN with FINDATES) take precedence for the past; remaining cost along the remaining early
//    dates and along the remaining late dates; per-period and cumulative SPI and CPI; EAC, ETC, VAC and TCPI at the
//    data date;
//  - resource histograms: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining
//    late units or cost per period, the limit, over-allocation and its severity.
// Spreading is linear over each activity's working time. Values are hours (units) or the project currency (cost).
import { baselineOf } from './common.ts';
import { groupBy, indexBy, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { activityCosts, earnedValue, percentComplete, sumLines } from '../cost/rollup.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { bucketStart, nextBucket, spreadUsage, type UsageBucket } from '../resource/usage.ts';
import type { WorkCalendar } from '../calendar/calendar.ts';

const n = (s: string | undefined) => Number(s || 0) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (t: number) => formatP6Date(t).slice(0, 10);

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
export interface ProgressCurves {
  report: 'Progress Curves'; units: 'cost' | 'hours'; period: 'week' | 'month'; data_date: string | null; baseline: string | null;
  stored_periods: number;
  totals: { bac: number; pv: number; ev: number; ac: number; etc: number; eac: number; vac: number; spi: number | null; cpi: number | null; tcpi: number | null };
  periods: CurvePeriod[]; warnings: string[];
}

export function progressCurves(db: Db, projIds: string[], o: { period?: 'week' | 'month'; units?: 'cost' | 'hours'; from?: number; to?: number; taskIds?: Set<string> } = {}): ProgressCurves {
  const period = o.period ?? 'month', units = o.units ?? 'cost';
  const open = new Set(projIds);
  const projs = rows(db, 'PROJECT').filter((p) => open.has(p.proj_id));
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id) && t.task_type !== 'TT_WBS' && (!o.taskIds || o.taskIds.has(t.task_id)));
  const cals = calendarResolver(db, []);
  const projById = indexBy(projs, 'proj_id');
  const calOf = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(projById.get(t.proj_id)?.clndr_id);
  const asgBy = groupBy(rows(db, 'TASKRSRC'), 'task_id');
  const lines = activityCosts(db, projIds);
  const dd = Math.min(...projs.map((p) => parseP6Date(p.last_recalc_date) ?? Infinity));
  const dataDate = Number.isFinite(dd) ? dd : null;
  const warnings: string[] = [];

  // baseline counterparts (dates of the planned value)
  const bl = new Map<string, Row>();
  let blName: string | null = null;
  for (const p of projs) { const b = baselineOf(db, p, 'project'); if (b) { blName = b.name; for (const t of b.tasks.values()) bl.set(`${p.proj_id}|${t.task_code}`, t); } }
  if (!blName) warnings.push('No project baseline is assigned: planned value uses the current budget and planned dates.');

  // the quantities per activity
  const q = (t: Row) => {
    if (units === 'cost') { const l = lines.get(t.task_id)!; return { bac: l.bac, actual: l.ac, remaining: l.remaining }; }
    const a = asgBy.get(t.task_id) ?? [];
    const b = bl.get(`${t.proj_id}|${t.task_code}`);
    const bacUnits = b ? (asgBy.get(b.task_id) ?? []).reduce((s, x) => s + n(x.target_qty), 0) : a.reduce((s, x) => s + n(x.target_qty), 0);
    return { bac: bacUnits, actual: a.reduce((s, x) => s + n(x.act_reg_qty) + n(x.act_ot_qty), 0), remaining: a.reduce((s, x) => s + n(x.remain_qty), 0) };
  };
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
    if (bac && ps != null && pf != null) spreadLinear(pv, g, bac, ps, pf, cal);
    const pct = percentComplete(t, asgBy.get(t.task_id) ?? []);
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
  let totals: ProgressCurves['totals'];
  if (units === 'cost') {
    const e = earnedValue(sumLines(tasks.map((t) => lines.get(t.task_id)!).filter(Boolean)));
    totals = { bac: r2(e.bac), pv: r2(e.pv), ev: r2(e.ev), ac: r2(e.ac), etc: r2(e.etc), eac: r2(e.eac), vac: r2(e.vac), spi: e.pv ? r2(e.spi) : null, cpi: e.ac ? r2(e.cpi) : null, tcpi: e.bac - e.ac ? r2(e.tcpi) : null };
  } else {
    const s = tasks.map(q).reduce((a, x) => ({ bac: a.bac + x.bac, actual: a.actual + x.actual, remaining: a.remaining + x.remaining }), { bac: 0, actual: 0, remaining: 0 });
    const evH = tasks.reduce((a, t) => a + q(t).bac * percentComplete(t, asgBy.get(t.task_id) ?? []), 0);
    const pvH = periods.filter((p) => p.cum_ev != null).at(-1)?.cum_pv ?? 0;
    totals = { bac: r2(s.bac), pv: r2(pvH), ev: r2(evH), ac: r2(s.actual), etc: r2(s.remaining), eac: r2(s.actual + s.remaining), vac: r2(s.bac - s.actual - s.remaining), spi: pvH ? r2(evH / pvH) : null, cpi: s.actual ? r2(evH / s.actual) : null, tcpi: s.bac - s.actual ? r2((s.bac - evH) / (s.bac - s.actual)) : null };
  }
  if (totals.ev > 0 && totals.ac === 0) warnings.push(`Earned value is ${totals.ev} but no actual ${units === 'cost' ? 'cost' : 'units'} are recorded: CPI cannot be measured (it is left empty, not taken as 1).`);
  if (!totals.bac) warnings.push(units === 'cost' ? 'The schedule has no budgeted cost (no costed resources or expenses): use units: hours, or load costs.' : 'The schedule has no budgeted units (no resource assignments).');
  return { report: 'Progress Curves', units, period, data_date: dataDate != null ? formatP6Date(dataDate) : null, baseline: blName, stored_periods: usedFin.size, totals, periods, warnings };
}

export interface HistogramPeriod { start: string; end: string; budgeted: number; actual: number; remaining_early: number; remaining_late: number; limit: number | null; over_allocated: number; available: number | null }
export interface ResourceHistogram { resource: string; name: string; units: 'hours' | 'cost'; peak: { start: string; demand: number; limit: number | null } | null; over_allocated_periods: number; severity: 'none' | 'minor' | 'moderate' | 'critical'; periods: HistogramPeriod[] }

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
    const periods: HistogramPeriod[] = g.starts.map((s, i) => {
      const demand = actual[i] + early[i], limit = cap ? cap[i] : null;
      return { start: iso(s), end: iso(g.ends[i]), budgeted: r2(budgeted[i]), actual: r2(actual[i]), remaining_early: r2(early[i]), remaining_late: r2(late[i]), limit: limit != null ? r2(limit) : null, over_allocated: limit != null && demand > limit * threshold ? r2(demand - limit) : 0, available: limit != null ? r2(Math.max(0, limit - demand)) : null };
    });
    const peakI = periods.reduce((m, p, i) => (p.actual + p.remaining_early > periods[m].actual + periods[m].remaining_early ? i : m), 0);
    const ratio = Math.max(0, ...periods.map((p) => (p.limit ? (p.actual + p.remaining_early) / p.limit : 0)));
    out.push({
      resource: R.get(id)?.rsrc_short_name ?? id, name: R.get(id)?.rsrc_name ?? '', units: o.cost ? 'cost' : 'hours',
      peak: periods.length ? { start: periods[peakI].start, demand: r2(periods[peakI].actual + periods[peakI].remaining_early), limit: periods[peakI].limit } : null,
      over_allocated_periods: periods.filter((p) => p.over_allocated > 0).length,
      severity: o.cost || ratio <= threshold ? 'none' : ratio >= 2 ? 'critical' : ratio >= 1.5 ? 'moderate' : 'minor',
      periods,
    });
  }
  return { report: 'Resource Histogram', period, resources: out };
}
