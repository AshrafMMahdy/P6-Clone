// P6-style CPM scheduler (F9). Works on raw TASK/TASKPRED rows and writes dates back.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date, MIN_PER_DAY } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { WorkCalendar, CalendarHorizonError } from '../calendar/calendar.ts';
import { inheritExceptions, parseClndrData, standardCalendar, type CalendarDef } from '../calendar/clndr-data.ts';
import { findLoops } from '../xer/validate.ts';
import { buildScheduleLog } from './log.ts';

export type LogicMode = 'retained' | 'override' | 'actual';
export type FloatType = 'start' | 'finish' | 'smallest';
export type LagCalendar = 'predecessor' | 'successor' | '24h' | 'project';

export interface SchedOptions {
  /** Override every project's data date (minutes). */
  dataDate?: number;
  logic: LogicMode;
  floatType: FloatType;
  lagCalendar: LagCalendar;
  openEndedCritical: boolean;
  ignoreExternal: boolean;
  useExpectedFinish: boolean;
  criticalBy: 'float' | 'longestPath';
  criticalFloatHrs: number;
  /** P6 6.x builds place milestones one minute inside a work period instead of across a non-work gap. */
  legacyMilestones: boolean;
}

export interface ScheduleStats { activities: number; relationships: number; notStarted: number; inProgress: number; completed: number; finish: number | null; dataDate: number | null }
export interface ScheduleResult { ok: boolean; log: string; findings: Finding[]; stats: ScheduleStats; projects: Record<string, { finish: number | null; dataDate: number }> }

type RelType = 'FS' | 'SS' | 'FF' | 'SF';
type Status = 'NS' | 'IP' | 'CO';

interface Proj {
  row: Row; id: string; dd: number; floor: number; opts: SchedOptions; cal: WorkCalendar;
  mfb: number | null; finish: number; lateFinish: number;
}
interface Act {
  row: Row; id: string; code: string; proj: Proj; cal: WorkCalendar; fcal: WorkCalendar; type: string; status: Status;
  as: number | null; af: number | null; dur: number;
  es: number; ef: number; ls: number; lf: number;
  preds: Rel[]; succs: Rel[]; tf: number | null; ff: number | null; driving: boolean; done: boolean;
}
interface Rel { pred: Act | null; succ: Act | null; type: RelType; lag: number; row: Row; slack: number }

const H = 60;
const BIG = Number.MAX_SAFE_INTEGER;

export function optionsFor(db: Db, proj: Row, over: Partial<SchedOptions> = {}): SchedOptions {
  const so = rows(db, 'SCHEDOPTIONS').find((r) => r.proj_id === proj.proj_id) ?? {};
  const base: SchedOptions = {
    logic: so.sched_progress_override === 'Y' ? 'override' : so.sched_retained_logic === 'N' ? 'actual' : 'retained',
    floatType: so.sched_float_type === 'FT_SS' ? 'start' : so.sched_float_type === 'FT_Smallest' ? 'smallest' : 'finish',
    lagCalendar: ({ rcal_Successor: 'successor', rcal_24Hour: '24h', rcal_ProjDefault: 'project' } as Record<string, LagCalendar>)[so.sched_calendar_on_relationship_lag] ?? 'predecessor',
    openEndedCritical: so.sched_open_critical_flag === 'Y',
    ignoreExternal: so.sched_outer_depend_type === 'SD_None',
    useExpectedFinish: so.sched_use_expect_end_flag === 'Y',
    criticalBy: proj.critical_path_type === 'CT_DrivPath' ? 'longestPath' : 'float',
    criticalFloatHrs: Number(proj.critical_drtn_hr_cnt || 0),
    legacyMilestones: proj._legacy_ms != null && proj._legacy_ms !== '' ? proj._legacy_ms === 'Y' : isLegacyLayout(db),
  };
  return { ...base, ...over };
}

/** TASK layout written by P6 6.x builds (has the old_* restart fields). */
export function isLegacyLayout(db: Db): boolean {
  return !!db.tables.TASK?.fields.includes('old_restart_date');
}

/** Number as P6 writes it: up to 6 decimals, no trailing zeros. */
export function p6num(n: number): string {
  const s = (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

const relType = (s: string): RelType => (s?.slice(3, 5) as RelType) || 'FS';

/** Calendar lookup with P6 fallbacks; records parse problems as findings. */
export function calendarResolver(db: Db, findings: Finding[]) {
  const cache = new Map<string, WorkCalendar>();
  const byId = new Map(rows(db, 'CALENDAR').map((r) => [r.clndr_id, r]));
  const defRow = rows(db, 'CALENDAR').find((r) => r.default_flag === 'Y');
  const std = new WorkCalendar(standardCalendar());
  const defs = new Map<string, CalendarDef | null>();
  const def = (id: string, depth = 0): CalendarDef | null => {
    if (defs.has(id)) return defs.get(id)!;
    const r = byId.get(id);
    if (!r) return null;
    let d: CalendarDef | null = null;
    try {
      if (r.clndr_data) d = parseClndrData(r.clndr_data);
    } catch (e) {
      findings.push({ severity: 'warning', code: 'SCHED_CAL_INVALID', table: 'CALENDAR', key: id, message: `Calendar ${r.clndr_name} is invalid (${(e as Error).message}); standard 5-day calendar used.`, p6: 'P6 cannot use the calendar.' });
    }
    d ??= standardCalendar();
    // Project and resource calendars inherit holidays from their base calendar.
    const base = r.base_clndr_id && r.base_clndr_id !== id && depth < 10 ? def(r.base_clndr_id, depth + 1) : null;
    if (base) d = inheritExceptions(d, base);
    defs.set(id, d);
    return d;
  };
  const get = (id: string | undefined): WorkCalendar | undefined => {
    if (!id) return undefined;
    if (cache.has(id)) return cache.get(id);
    const d = def(id);
    if (!d) return undefined;
    const cal = new WorkCalendar(d);
    cache.set(id, cal);
    return cal;
  };
  return { get, fallback: (projCal?: string) => get(projCal) ?? get(defRow?.clndr_id) ?? std };
}

export function scheduleProjects(db: Db, projIds: string[], over: Partial<SchedOptions> = {}): ScheduleResult {
  const findings: Finding[] = [];
  const cals = calendarResolver(db, findings);
  const projects = new Map<string, Proj>();
  for (const row of rows(db, 'PROJECT')) {
    if (!projIds.includes(row.proj_id)) continue;
    const opts = optionsFor(db, row, over);
    const dd = opts.dataDate ?? parseP6Date(row.last_recalc_date) ?? parseP6Date(row.plan_start_date) ?? Math.floor(Date.now() / 60000 / 1440) * 1440;
    // Not-started work cannot start before the data date or the project planned start.
    const ps = parseP6Date(row.plan_start_date);
    projects.set(row.proj_id, { row, id: row.proj_id, dd, floor: ps != null && ps > dd ? ps : dd, opts, cal: cals.fallback(row.clndr_id), mfb: parseP6Date(row.plan_end_date), finish: dd, lateFinish: dd });
  }
  const emptyStats: ScheduleStats = { activities: 0, relationships: 0, notStarted: 0, inProgress: 0, completed: 0, finish: null, dataDate: null };
  if (!projects.size) {
    findings.push({ severity: 'error', code: 'SCHED_NO_PROJECT', message: 'No project to schedule.', p6: 'Nothing to schedule.' });
    return { ok: false, log: '', findings, stats: emptyStats, projects: {} };
  }

  // Resource calendars for resource-dependent activities
  const rsrcCal = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.clndr_id]));
  const firstRsrc = new Map<string, string>();
  for (const a of rows(db, 'TASKRSRC')) if (!firstRsrc.has(a.task_id)) firstRsrc.set(a.task_id, a.rsrc_id);
  // P6 uses the project's own calendar when it has the same name as the global calendar an activity points to
  const sameNameProjectCal = new Map<string, string>();
  {
    const calRows = rows(db, 'CALENDAR');
    for (const g of calRows) {
      if (g.proj_id) continue;
      for (const pc of calRows) if (pc.proj_id && pc.clndr_id !== g.clndr_id && (pc.clndr_name || '').trim().toLowerCase() === (g.clndr_name || '').trim().toLowerCase()) sameNameProjectCal.set(pc.proj_id + '|' + g.clndr_id, pc.clndr_id);
    }
  }
  const asgByTask = new Map<string, Row[]>();
  for (const a of rows(db, 'TASKRSRC')) { let l = asgByTask.get(a.task_id); if (!l) asgByTask.set(a.task_id, (l = [])); l.push(a); }
  const rsrcType = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_type]));

  const acts = new Map<string, Act>();
  for (const row of rows(db, 'TASK')) {
    const proj = projects.get(row.proj_id);
    if (!proj) continue;
    let cal = cals.get(sameNameProjectCal.get(row.proj_id + '|' + row.clndr_id) ?? row.clndr_id) ?? proj.cal;
    const taskCal = cal; // floats are measured on the activity's own calendar (even for resource dependent)
    let hrs = row.remain_drtn_hr_cnt !== '' && row.remain_drtn_hr_cnt != null ? Number(row.remain_drtn_hr_cnt) : Number(row.target_drtn_hr_cnt || 0);
    if (row.task_type === 'TT_Rsrc') {
      // Resource dependent: the longest labor/nonlabor assignment drives, on its resource's calendar,
      // for remaining units / remaining units per hour.
      let best = -1, bestCal: WorkCalendar | undefined;
      for (const a of asgByTask.get(row.task_id) ?? []) {
        if ((a.rsrc_type || rsrcType.get(a.rsrc_id)) === 'RT_Mat') continue;
        const rate = Number(a.remain_qty_per_hr || 0);
        if (!(rate > 0)) continue;
        const h = Number(a.remain_qty || 0) / rate;
        if (h > best) { best = h; bestCal = cals.get(rsrcCal.get(a.rsrc_id) ?? ''); }
      }
      if (best >= 0) { hrs = best; cal = bestCal ?? cal; }
      else cal = cals.get(rsrcCal.get(firstRsrc.get(row.task_id) ?? '')) ?? cal;
    }
    const as = parseP6Date(row.act_start_date), af = parseP6Date(row.act_end_date);
    const status: Status = af != null ? 'CO' : as != null ? 'IP' : 'NS';
    const isMile = row.task_type === 'TT_Mile' || row.task_type === 'TT_FinMile';
    acts.set(row.task_id, {
      row, id: row.task_id, code: row.task_code || row.task_id, proj, cal, fcal: taskCal, type: row.task_type || 'TT_Task', status,
      as: status === 'NS' ? null : (as ?? af), af: status === 'CO' ? af : null,
      dur: isMile || status === 'CO' ? 0 : Math.max(0, Math.round((Number.isFinite(hrs) ? hrs : 0) * H)),
      es: 0, ef: 0, ls: BIG, lf: BIG, preds: [], succs: [], tf: null, ff: null, driving: false, done: false,
    });
  }

  // Relationships
  const rels: Rel[] = [];
  for (const row of rows(db, 'TASKPRED')) {
    const succ = acts.get(row.task_id) ?? null, pred = acts.get(row.pred_task_id) ?? null;
    if (!succ && !pred) continue;
    if (succ && pred && succ === pred) continue;
    if ((!succ || !pred)) {
      const inSet = (succ ?? pred)!;
      if (inSet.proj.opts.ignoreExternal) continue;
    }
    const r: Rel = { pred, succ, type: relType(row.pred_type), lag: Math.round(Number(row.lag_hr_cnt || 0) * H), row, slack: BIG };
    rels.push(r);
    if (pred) pred.succs.push(r);
    succ?.preds.push(r);
  }

  const isMain = (a: Act) => a.type !== 'TT_LOE' && a.type !== 'TT_WBS';
  const main = [...acts.values()].filter(isMain);

  // Topological order of main activities
  const indeg = new Map<Act, number>();
  for (const a of main) indeg.set(a, a.preds.filter((r) => r.pred && isMain(r.pred)).length);
  const order: Act[] = [];
  const queue = main.filter((a) => indeg.get(a) === 0);
  while (queue.length) {
    const a = queue.pop()!;
    order.push(a);
    for (const r of a.succs) {
      if (!r.succ || !isMain(r.succ)) continue;
      const n = indeg.get(r.succ)! - 1;
      indeg.set(r.succ, n);
      if (n === 0) queue.push(r.succ);
    }
  }
  if (order.length < main.length) {
    const succ = new Map<string, string[]>();
    for (const r of rels) if (r.pred && r.succ && isMain(r.pred) && isMain(r.succ)) {
      let l = succ.get(r.pred.code); if (!l) succ.set(r.pred.code, (l = [])); l.push(r.succ.code);
    }
    for (const loop of findLoops(succ)) findings.push({ severity: 'error', code: 'SCHED_LOOP', message: `Loop: ${loop.join(' → ')} → ${loop[0]}`, p6: 'P6 stops scheduling: "Circular relationship (loop) detected".' });
    const log = buildScheduleLog({ projects: [...projects.values()].map((p) => p.row), dataDate: null, opts: [...projects.values()][0].opts, findings, stats: emptyStats, acts: [] });
    return { ok: false, log, findings, stats: emptyStats, projects: {} };
  }

  const allTasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const lagCal = (r: Rel): WorkCalendar => {
    const p = (r.succ ?? r.pred)!.proj;
    switch (p.opts.lagCalendar) {
      case 'successor': return (r.succ ?? r.pred)!.cal;
      case '24h': return WorkCalendar.continuous();
      case 'project': return p.cal;
      default: return (r.pred ?? r.succ)!.cal;
    }
  };
  const lagAdd = (t: number, r: Rel) => (r.lag === 0 ? t : lagCal(r).addWork(t, r.lag));
  const lagSub = (t: number, r: Rel) => (r.lag === 0 ? t : lagCal(r).subWork(t, r.lag));
  // Completed activities behave as zero-length nodes at their computed early date (P6 propagates logic through them).
  const startOf = (a: Act) => (a.status === 'IP' ? a.as! : a.es);
  const finishOf = (a: Act) => a.ef;
  /** Time a relationship releases its successor. Completed predecessors count lags from their actual dates;
   *  a completed activity pushed past the data date by open logic upstream passes that date on. */
  const predTime = (r: Rel): number => {
    const p = r.pred!;
    const fin = r.type === 'FS' || r.type === 'FF';
    if (p.status === 'NS') return lagAdd(fin ? finishOf(p) : startOf(p), r);
    if (p.status === 'IP') {
      if (fin) return lagAdd(finishOf(p), r);
      // Start links from an in-progress predecessor.
      if (p.proj.opts.logic !== 'retained') return lagAdd(p.as!, r);
      // Retained Logic: the lag still to run is the lag minus the work time elapsed between the predecessor's
      // actual start and the data date; it runs from the predecessor's remaining (resumed) start.
      const lc = lagCal(r);
      const elapsed = Math.max(0, lc.workBetween(Math.min(p.as!, p.proj.dd), p.proj.dd));
      const left = r.lag - elapsed;
      return left > 0 ? lc.addWork(p.es, left) : p.es;
    }
    // actual dates after the data date do not push successors past what the data date allows
    const base = lagAdd(Math.min(fin ? p.af! : p.as!, p.proj.dd), r);
    if (p.ef <= p.proj.dd) return base;
    // completed but pushed past the data date by its own predecessors: logic runs from its propagated date with
    // only the lag still to run (the lag minus the work time elapsed between its actual date and the data date)
    if (r.lag <= 0) return p.as! > p.proj.dd ? Math.max(base, lagAdd(p.ef, r)) : Math.max(base, p.ef);
    const lc = lagCal(r);
    const left = r.lag - Math.max(0, lc.workBetween(Math.min(fin ? p.af! : p.as!, p.proj.dd), p.proj.dd));
    return Math.max(base, left > 0 ? lc.addWork(p.ef, left) : p.ef);
  };
  const extStart = (r: Rel): number | null => {
    // predecessor outside the scheduled set: its stored dates, else the successor's external early start
    const row = allTasks.get(r.row.pred_task_id);
    if (row) {
      const s = parseP6Date(row.act_start_date) ?? parseP6Date(row.early_start_date);
      const f = parseP6Date(row.act_end_date) ?? parseP6Date(row.early_end_date);
      return r.type === 'FS' || r.type === 'FF' ? f : s;
    }
    return parseP6Date(r.succ!.row.external_early_start_date);
  };

  const snapEarly = (a: Act, raw: number, floor: number) => {
    if (a.type === 'TT_FinMile') {
      // A finish can sit inside work time or at a period end. P6 never moves a finish milestone back across
      // a non-work gap: if it lands at a period start (or in a gap) it is placed one minute into the period.
      if (a.proj.opts.legacyMilestones) a.es = a.ef = a.cal.prevWorkEnd(raw) === raw ? raw : a.cal.nextWorkStart(raw) + 1;
      else if (a.cal.prevWorkEnd(raw) === raw || a.cal.nextWorkStart(raw) === raw) a.es = a.ef = raw; // inside work or on a period boundary: stays
      else a.es = a.ef = a.cal.nextWorkStart(raw);
    } else if (a.type === 'TT_Mile') {
      a.es = a.ef = a.cal.nextWorkStart(raw);
    } else {
      a.es = a.cal.nextWorkStart(raw);
      a.ef = a.dur ? a.cal.addWork(a.es, a.dur) : a.es;
    }
  };
  const cstr = (a: Act): [string, number][] => {
    const out: [string, number][] = [];
    const c1 = parseP6Date(a.row.cstr_date), c2 = parseP6Date(a.row.cstr_date2);
    if (a.row.cstr_type && (c1 != null || a.row.cstr_type === 'CS_ALAP')) out.push([a.row.cstr_type, c1 ?? 0]);
    if (a.row.cstr_type2 && (c2 != null || a.row.cstr_type2 === 'CS_ALAP')) out.push([a.row.cstr_type2, c2 ?? 0]);
    return out;
  };

  try {
    // Forward pass
    for (const a of order) {
      if (a.status === 'CO') {
        let raw = a.proj.dd;
        if (a.proj.opts.logic !== 'override') for (const r of a.preds) {
          if (!r.pred || !isMain(r.pred)) continue;
          const t = predTime(r);
          if (t > raw) raw = t;
        }
        a.es = a.ef = raw;
        continue;
      }
      const floor = a.status === 'NS' ? a.proj.floor : a.proj.dd;
      let raw = floor;
      let finDriver: number | null = null; // required finish from an FF/SF link, when it drives
      const applyLogic = a.status === 'NS' || a.proj.opts.logic !== 'override';
      if (applyLogic) {
        for (const r of a.preds) {
          if (r.pred && !isMain(r.pred)) continue;
          // (Retained Logic applies start links to the remaining work of in-progress activities too.)
          let t: number | null;
          if (!r.pred) { t = extStart(r); if (t == null) continue; t = lagAdd(t, r); }
          else t = predTime(r);
          if (r.type === 'FF' || r.type === 'SF') {
            // P6 6.x: a required finish at a period start becomes one minute into that period
            if (a.proj.opts.legacyMilestones && a.dur && a.cal.prevWorkEnd(t) !== t) t = a.cal.nextWorkStart(t) + 1;
            const rf = t;
            t = a.dur ? a.cal.subWork(t, a.dur) : t;
            if (t > raw) { raw = t; finDriver = rf; continue; }
          }
          if (t > raw) { raw = t; finDriver = null; }
        }
        const ext = parseP6Date(a.row.external_early_start_date);
        if (ext != null && !a.proj.opts.ignoreExternal && !a.preds.some((r) => !r.pred) && ext > raw) raw = ext;
      }
      let mand: number | null = null;
      if (a.status === 'NS') {
        for (const [ty, c0] of cstr(a)) {
          // P6 6.x: a finish constraint on a period start means one minute into the period
          const c = a.proj.opts.legacyMilestones && /MEO|MANDFIN/.test(ty) && a.dur && a.cal.prevWorkEnd(c0) !== c0 ? a.cal.nextWorkStart(c0) + 1 : c0;
          if (ty === 'CS_MSO' || ty === 'CS_MSOA') raw = Math.max(raw, c);
          else if (ty === 'CS_MEO' || ty === 'CS_MEOA') raw = Math.max(raw, a.dur ? a.cal.subWork(c, a.dur) : c);
          else if (ty === 'CS_MANDSTART') mand = c;
          else if (ty === 'CS_MANDFIN') mand = a.dur ? a.cal.subWork(c, a.dur) : c;
        }
      }
      if (a.proj.opts.useExpectedFinish && a.row.expect_end_date) {
        const exp = parseP6Date(a.row.expect_end_date)!;
        const st = a.cal.nextWorkStart(mand ?? raw);
        // P6 recomputes remaining duration from the expected finish only when the remaining work starts at the
        // data date; otherwise the stored remaining duration (set when progress was last applied) is used.
        if (exp > st && st === a.cal.nextWorkStart(a.proj.dd)) a.dur = a.cal.workBetween(st, exp);
      }
      snapEarly(a, mand ?? raw, floor);
      // P6 5.x/7.x builds keep a link-driven finish that falls on a period start as that time (same work instant)
      if (!a.proj.opts.legacyMilestones && finDriver != null && mand == null && a.dur && a.type !== 'TT_FinMile' && finDriver > a.ef && a.cal.workBetween(a.ef, finDriver) === 0 && a.fcal.workBetween(a.ef, finDriver) === 0) a.ef = a.cal.nextWorkStart(finDriver);
      if (mand != null) { a.es = mand; a.ef = a.dur ? a.cal.addWork(mand, a.dur) : mand; }
    }

    // Project finish (latest early finish) and late finish (Must Finish By or finish)
    for (const p of projects.values()) {
      let f = p.dd;
      for (const a of main) if (a.proj === p && a.status !== 'CO' && a.ef > f) f = a.ef;
      p.finish = f;
      p.lateFinish = p.mfb ?? f;
    }

    // Backward pass
    for (let i = order.length - 1; i >= 0; i--) {
      const a = order[i];
      let raw = a.proj.lateFinish;
      for (const r of a.succs) {
        if (!r.succ) {
          const ext = parseP6Date(a.row.external_late_end_date);
          if (ext != null && ext < raw) raw = ext;
          continue;
        }
        const s = r.succ;
        if (!isMain(s)) continue;
        // an in-progress predecessor has already used up the lag of its start links
        const base = r.type === 'FS' || r.type === 'SS' ? s.ls : s.lf;
        let t: number;
        if (a.status === 'CO') t = base;
        else if (a.status === 'IP' && (r.type === 'SS' || r.type === 'SF')) {
          const lc = lagCal(r);
          const left = r.lag - Math.max(0, lc.workBetween(Math.min(a.as!, a.proj.dd), a.proj.dd));
          t = left > 0 ? lc.subWork(base, left) : base;
        } else t = lagSub(base, r);
        if (r.type === 'SS' || r.type === 'SF') t = a.dur ? a.cal.addWork(t, a.dur) : t;
        if (t < raw) raw = t;
      }
      if (a.status === 'CO') { a.ls = a.lf = raw; continue; }
      let mand: number | null = null;
      if (a.status === 'NS') {
        for (const [ty, c] of cstr(a)) {
          if (ty === 'CS_MSO' || ty === 'CS_MSOB') raw = Math.min(raw, a.dur ? a.cal.addWork(c, a.dur) : c);
          else if (ty === 'CS_MEO' || ty === 'CS_MEOB') raw = Math.min(raw, c);
          else if (ty === 'CS_MANDSTART') mand = a.dur ? a.cal.addWork(c, a.dur) : c;
          else if (ty === 'CS_MANDFIN') mand = c;
        }
      }
      raw = mand ?? raw;
      // Mirror rule: a start milestone's late date at a period end (or in a gap) is one minute before the end.
      if (a.type === 'TT_Mile') a.ls = a.lf = a.proj.opts.legacyMilestones ? (a.cal.nextWorkStart(raw) === raw ? raw : a.cal.prevWorkEnd(raw) - 1) : a.cal.nextWorkStart(raw) === raw ? raw : a.cal.prevWorkEnd(raw);
      else if (a.type === 'TT_FinMile') a.ls = a.lf = a.cal.prevWorkEnd(raw);
      else {
        a.lf = mand ?? a.cal.prevWorkEnd(raw);
        a.ls = a.dur ? a.cal.subWork(a.lf, a.dur) : a.lf;
        // P6: a task-dependent activity starts late no later than its longest assignment, and an assignment with
        // no units rate keeps the duration of its stored dates (it does not follow the activity's).
        if (a.type === 'TT_Task' && a.status === 'NS') for (const asg of asgByTask.get(a.row.task_id) ?? []) {
          if (Number(asg.remain_qty_per_hr || 0) > 0 || Number(asg.relag_drtn_hr_cnt || 0)) continue;
          const s0 = parseP6Date(asg.restart_date), f0 = parseP6Date(asg.reend_date);
          const d = asg.remain_drtn_hr_cnt ? Number(asg.remain_drtn_hr_cnt) * H : s0 != null && f0 != null ? a.cal.workBetween(s0, f0) : 0;
          if (d > a.dur) a.ls = Math.min(a.ls, a.cal.subWork(a.lf, d));
        }
      }
    }

    // Relationship slack, floats, ALAP
    const relSlack = (r: Rel): number => {
      const a = r.pred!, s = r.succ!;
      const from = predTime(r);
      const to = r.type === 'FS' || r.type === 'SS' ? (s.status === 'NS' ? s.es : s.es) : s.ef;
      const w = a.fcal.workBetween(from, to);
      return w < 0 && s.type === 'TT_Rsrc' ? s.cal.workBetween(from, to) : w; // a resource-dependent successor is late only by its own work time
    };
    for (const a of order) {
      if (a.status === 'CO') continue;
      const ef = a.proj.opts.floatType;
      const fin = a.fcal.workBetween(a.ef, a.lf), st = a.fcal.workBetween(a.es, a.ls);
      a.tf = ef === 'finish' ? fin : ef === 'start' ? st : Math.min(fin, st);
      let ff = BIG;
      for (const r of a.succs) {
        if (!r.succ || !isMain(r.succ)) continue; // completed successors count too (zero-length at their date)
        r.slack = relSlack(r);
        if (r.slack < ff) ff = r.slack;
      }
      // open end: free float to the project finish; P6 6.x builds measure it to the end of the Must Finish By day
      const openEnd = a.proj.opts.legacyMilestones && a.proj.mfb != null ? a.cal.prevWorkEnd(Math.floor(a.proj.mfb / MIN_PER_DAY + 1) * MIN_PER_DAY) : a.proj.finish;
      a.ff = ff === BIG ? a.cal.workBetween(a.ef, openEnd) : ff;
      if (a.proj.opts.useExpectedFinish && a.row.expect_end_date) a.ff = 0; // P6: an expected finish pins the activity (no free float)
    }
    // As Late As Possible: from the end of the network backwards, finish at the latest time that does not delay
    // any successor's early dates (successors already final), never past the activity's own late finish.
    for (let i = order.length - 1; i >= 0; i--) {
      const a = order[i];
      if (a.status === 'CO' || a.type === 'TT_LOE' || !cstr(a).some(([t]) => t === 'CS_ALAP')) continue;
      let ef = BIG; // successors limit it, not the late finish (negative float stays negative)
      for (const r of a.succs) {
        if (!r.succ || !isMain(r.succ)) continue; // completed successors count with their propagated dates
        const s = r.succ;
        let t = lagSub(r.type === 'FS' || r.type === 'SS' ? s.es : s.ef, r);
        if (r.type === 'SS' || r.type === 'SF') t = a.dur ? a.cal.addWork(t, a.dur) : t;
        if (t < ef) ef = t;
      }
      if (ef === BIG) ef = a.lf;
      a.ff = 0; // ALAP uses up all free float
      if (ef <= a.ef || a.cal.workBetween(a.ef, ef) <= 0) continue;
      a.ef = ef = a.dur ? a.cal.prevWorkEnd(ef) : ef; // a finish sits at the end of the last work period
      a.es = a.dur ? a.cal.subWork(ef, a.dur) : ef;
      a.ff = 0;
      const fin = a.fcal.workBetween(a.ef, a.lf), st = a.fcal.workBetween(a.es, a.ls);
      a.tf = a.proj.opts.floatType === 'finish' ? fin : a.proj.opts.floatType === 'start' ? st : Math.min(fin, st);
      for (const r of a.preds) {
        if (!r.pred || !isMain(r.pred) || r.pred.status === 'CO') continue;
        r.slack = relSlack(r);
        const p = r.pred;
        if (cstr(p).some(([t]) => t === 'CS_ALAP') || (p.proj.opts.useExpectedFinish && p.row.expect_end_date)) continue;
        let ff = BIG;
        for (const q of p.succs) if (q.succ && isMain(q.succ)) ff = Math.min(ff, q.slack === BIG ? relSlack(q) : q.slack);
        if (ff !== BIG) p.ff = ff;
      }
    }

    // Longest path: back from the latest-finishing activities along driving relationships
    for (const p of projects.values()) {
      const stack = main.filter((a) => a.proj === p && a.status !== 'CO' && a.ef === p.finish);
      while (stack.length) {
        const a = stack.pop()!;
        if (a.driving) continue;
        a.driving = true;
        for (const r of a.preds) if (r.pred && isMain(r.pred) && r.pred.status !== 'CO' && r.slack === 0) stack.push(r.pred);
      }
    }

    // Level of effort: spans from its predecessors to its successors
    for (const a of acts.values()) {
      if (!isMain(a) && a.status === 'CO') { a.es = a.ef = a.ls = a.lf = a.proj.dd; continue; }
      if (a.type !== 'TT_LOE' || a.status === 'CO') continue;
      let es = BIG, ef = -BIG, ls = BIG, lf = -BIG;
      for (const r of a.preds) {
        if (!r.pred || r.pred.type === 'TT_LOE' || r.pred.type === 'TT_WBS') continue;
        const p = r.pred;
        const e = lagAdd(r.type === 'FS' || r.type === 'FF' ? finishOf(p) : startOf(p), r);
        const l = lagAdd(r.type === 'FS' || r.type === 'FF' ? (p.status === 'CO' ? p.af! : p.lf) : (p.status === 'NS' ? p.ls : p.as!), r);
        if (r.type === 'SS' || r.type === 'FS') { es = Math.min(es, e); ls = Math.min(ls, l); } else { ef = Math.max(ef, e); lf = Math.max(lf, l); }
      }
      for (const r of a.succs) {
        if (!r.succ || r.succ.type === 'TT_LOE' || r.succ.type === 'TT_WBS') continue;
        const s = r.succ;
        const e = lagSub(r.type === 'FS' || r.type === 'SS' ? startOf(s) : finishOf(s), r);
        const l = lagSub(r.type === 'FS' || r.type === 'SS' ? (s.status === 'NS' ? s.ls : s.as!) : (s.status === 'CO' ? s.af! : s.lf), r);
        if (r.type === 'FF' || r.type === 'FS') { ef = Math.max(ef, e); lf = Math.max(lf, l); } else { es = Math.min(es, e); ls = Math.min(ls, l); }
      }
      const floor = a.proj.dd;
      if (es === BIG) { es = floor; ls = floor; }
      es = a.cal.nextWorkStart(Math.max(es, floor));
      ls = a.cal.nextWorkStart(Math.max(ls, floor));
      if (ef === -BIG) { ef = a.dur ? a.cal.addWork(es, a.dur) : es; lf = a.dur ? a.cal.addWork(ls, a.dur) : ls; }
      ef = Math.max(es, a.cal.prevWorkEnd(ef));
      lf = Math.max(ls, a.cal.prevWorkEnd(lf));
      if (a.status === 'IP') ls = a.as!; // P6 reports an in-progress LOE's late start as its actual start
      Object.assign(a, { es, ef, ls, lf });
      a.dur = a.cal.workBetween(es, ef);
      a.tf = a.cal.workBetween(ef, lf);
      a.ff = 0;
    }

    // WBS summary activities span their WBS subtree
    const wbsParent = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w.parent_wbs_id]));
    const under = (wbs: string, root: string) => { for (let w: string | undefined = wbs, n = 0; w && n < 200; w = wbsParent.get(w), n++) if (w === root) return true; return false; };
    for (const a of acts.values()) {
      if (a.type !== 'TT_WBS') continue;
      const kids = [...acts.values()].filter((b) => b !== a && b.type !== 'TT_WBS' && b.status !== 'CO' && b.proj === a.proj && under(b.row.wbs_id, a.row.wbs_id));
      if (!kids.length) { a.es = a.ef = a.ls = a.lf = a.cal.nextWorkStart(a.proj.dd); a.dur = 0; a.tf = 0; a.ff = a.cal.workBetween(a.es, a.proj.opts.legacyMilestones && a.proj.mfb != null ? a.cal.prevWorkEnd(Math.floor(a.proj.mfb / MIN_PER_DAY + 1) * MIN_PER_DAY) : a.proj.finish); continue; }
      a.es = kids.reduce((x, k) => Math.min(x, k.es), BIG); a.ef = kids.reduce((x, k) => Math.max(x, k.ef), -BIG);
      a.ls = kids.reduce((x, k) => Math.min(x, k.ls), BIG); a.lf = kids.reduce((x, k) => Math.max(x, k.lf), -BIG);
      a.dur = a.cal.workBetween(a.es, a.ef);
      a.tf = a.cal.workBetween(a.ef, a.lf);
      // free float from its own successors, else open-end rule, like any other activity
      let wff = BIG;
      for (const r of a.succs) if (r.succ && isMain(r.succ)) wff = Math.min(wff, a.cal.workBetween(lagAdd(r.type === 'FS' || r.type === 'FF' ? a.ef : a.es, r), r.type === 'FS' || r.type === 'SS' ? r.succ.es : r.succ.ef));
      a.ff = wff === BIG ? a.cal.workBetween(a.ef, a.proj.finish) : wff;
      if (a.status === 'CO') a.status = 'IP';
    }

  } catch (e) {
    if (!(e instanceof CalendarHorizonError)) throw e;
    findings.push({ severity: 'error', code: 'SCHED_CALENDAR', message: `Scheduling stopped: ${e.message}. A calendar has no work time.`, p6: 'P6 cannot schedule activities on a calendar without work time.' });
    return { ok: false, log: '', findings, stats: emptyStats, projects: {} };
  }

  // Write back
  const T = table(db, 'TASK');
  for (const f of ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt', 'driving_path_flag', 'target_start_date', 'target_end_date', 'remain_drtn_hr_cnt']) addField(T, f);
  const stats: ScheduleStats = { activities: acts.size, relationships: rels.length, notStarted: 0, inProgress: 0, completed: 0, finish: null, dataDate: null };
  for (const a of acts.values()) {
    const r = a.row;
    if (a.status === 'CO') {
      stats.completed++;
      Object.assign(r, {
        early_start_date: formatP6Date(a.es), early_end_date: formatP6Date(a.ef),
        late_start_date: formatP6Date(a.ls), late_end_date: formatP6Date(a.lf),
        restart_date: '', reend_date: '', rem_late_start_date: '', rem_late_end_date: '',
        total_float_hr_cnt: '', free_float_hr_cnt: '', driving_path_flag: 'N',
      });
      continue;
    }
    a.status === 'NS' ? stats.notStarted++ : stats.inProgress++;
    const es = formatP6Date(a.es), ef = formatP6Date(a.ef), ls = formatP6Date(a.ls), lf = formatP6Date(a.lf);
    Object.assign(r, {
      early_start_date: es, early_end_date: ef, late_start_date: ls, late_end_date: lf,
      restart_date: es, reend_date: ef, rem_late_start_date: ls, rem_late_end_date: lf,
      total_float_hr_cnt: a.tf == null ? '' : p6num(a.tf / H), free_float_hr_cnt: a.ff == null ? '' : p6num(a.ff / H),
      driving_path_flag: a.driving ? 'Y' : 'N',
    });
    if (a.status === 'NS') { r.target_start_date = es; r.target_end_date = ef; }
    if (a.type === 'TT_LOE' || a.type === 'TT_WBS') {
      r.remain_drtn_hr_cnt = p6num(a.dur / H);
      if (a.status === 'NS') r.target_drtn_hr_cnt = p6num(a.dur / H);
    }
  }
  const P = table(db, 'PROJECT');
  addField(P, 'scd_end_date'); addField(P, 'last_recalc_date');
  const out: ScheduleResult['projects'] = {};
  for (const p of projects.values()) {
    p.row.scd_end_date = formatP6Date(p.finish);
    p.row.last_recalc_date = formatP6Date(p.dd);
    out[p.id] = { finish: p.finish, dataDate: p.dd };
    stats.finish = Math.max(stats.finish ?? 0, p.finish);
    stats.dataDate = stats.dataDate == null ? p.dd : Math.min(stats.dataDate, p.dd);
  }

  // Schedule log warnings (like SCHEDLOG)
  for (const a of order) {
    if (a.status === 'CO') continue;
    if (!a.preds.length) findings.push({ severity: 'info', code: 'OPEN_START', key: a.code, message: `${a.code} has no predecessors.`, p6: 'Listed in the schedule log under "Activities without predecessors".' });
    if (!a.succs.length) findings.push({ severity: 'info', code: 'OPEN_FINISH', key: a.code, message: `${a.code} has no successors.`, p6: 'Listed in the schedule log under "Activities without successors".' });
    if (a.status === 'IP') for (const r of a.preds) if (r.pred && r.type === 'FS' && r.pred.status !== 'CO') findings.push({ severity: 'warning', code: 'OUT_OF_SEQUENCE', key: a.code, message: `${a.code} started before predecessor ${r.pred.code} finished.`, p6: 'Listed in the schedule log under "Out of sequence activities".' });
    if (a.tf != null && a.tf < 0) findings.push({ severity: 'info', code: 'NEGATIVE_FLOAT', key: a.code, message: `${a.code} has ${p6num(a.tf / H)} h total float.`, p6: 'P6 schedules it with negative float (constraint or Must Finish By violated).' });
    for (const [ty, c] of cstr(a)) {
      if ((ty === 'CS_MSO' || ty === 'CS_MSOB') && a.es > c) findings.push({ severity: 'warning', code: 'CONSTRAINT_VIOLATED', key: a.code, message: `${a.code}: ${ty} ${formatP6Date(c)} cannot be met (early start ${formatP6Date(a.es)}).`, p6: 'Listed in the schedule log under "Constraints violated".' });
      if ((ty === 'CS_MEO' || ty === 'CS_MEOB') && a.ef > c) findings.push({ severity: 'warning', code: 'CONSTRAINT_VIOLATED', key: a.code, message: `${a.code}: ${ty} ${formatP6Date(c)} cannot be met (early finish ${formatP6Date(a.ef)}).`, p6: 'Listed in the schedule log under "Constraints violated".' });
    }
    if (a.as != null && a.as > a.proj.dd) findings.push({ severity: 'warning', code: 'ACTUAL_AFTER_DD', key: a.code, message: `${a.code} has an actual start after the data date.`, p6: 'Listed in the schedule log under "Actual dates after data date".' });
  }

  const first = [...projects.values()][0];
  const log = buildScheduleLog({ projects: [...projects.values()].map((p) => p.row), dataDate: first.dd, opts: first.opts, findings, stats, acts: order.map((a) => ({ code: a.code, name: a.row.task_name })) });
  return { ok: true, log, findings, stats, projects: out };
}
