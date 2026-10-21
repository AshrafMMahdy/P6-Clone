// Neutral Microsoft Project model shared by the MSPDI (XML) and MPX readers/writers, and its mapping onto
// the raw P6 tables (PROJECT, PROJWBS, CALENDAR, TASK, TASKPRED, RSRC, RSRCRATE, TASKRSRC, SCHEDOPTIONS).
//
// MS Project has no WBS table: P6 WBS nodes become summary tasks and summary tasks come back as WBS nodes.
// What MS Project cannot hold natively (Activity ID, activity type, P6 constraint codes, duration type, the
// secondary constraint) travels in task Text fields, the way P6 itself maps extra fields on MS Project export.
// Each task's UID is kept on its activity / WBS row (_msp_uid, never written to XER or P6 XML) so that callers can
// match activities to the file, and writing Microsoft Project again gives those tasks their original UIDs.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { selectRows } from '../xer/write.ts';
import { hoursPerWeek, inheritExceptions, parseClndrData, scheduledCalendarDef, serializeClndrData, standardCalendar, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num, progressKey } from '../schedule/cpm.ts';
import type { Ghosts, Kept, ProjectKept } from './keep.ts';

export type RelType = 'FS' | 'SS' | 'FF' | 'SF';

export interface MCal {
  uid: string;
  name: string;
  isBase: boolean;
  baseUid?: string;
  /** index 0 = Sunday; null = inherited from the base calendar (derived calendars only). */
  week: (Shift[] | null)[];
  /** OLE serial day -> shifts (empty = non-work day). */
  exceptions: Map<number, Shift[]>;
  /** read from MSPDI: the calendar as written; the row it is written from */
  keep?: Kept; row?: Row;
}

/** P6 values carried in MS Project custom fields. */
export interface P6Extra { activityId?: string; taskType?: string; cstr?: string; cstr2?: string; durType?: string; calName?: string }

export interface MPred { uid: string; type: RelType; lagHrs: number; /** percentage lag (MS Project only), resolved against the predecessor duration */ lagPct?: number }

export interface MTask {
  uid: string;
  id: number;
  name: string;
  level: number;
  wbs: string;
  outline: string;
  summary: boolean;
  milestone: boolean;
  /** MS Project task type: 0 fixed units, 1 fixed duration, 2 fixed work. */
  type: number | null;
  durHrs: number | null;
  remHrs: number | null;
  /** MSPDI ActualDuration: the work done (hours), from which Project schedules the rest */
  actHrs?: number | null;
  pct: number | null;
  /** P6 date strings 'yyyy-mm-dd hh:mm' ('' when absent). */
  start: string; finish: string; earlyStart: string; earlyFinish: string; lateStart: string; lateFinish: string;
  actualStart: string; actualFinish: string; constraintDate: string; deadline: string;
  /** 0 ASAP .. 7 FNLT */
  constraintType: number | null;
  calUid: string;
  totalSlackHrs: number | null;
  freeSlackHrs: number | null;
  ignoreRsrcCal: boolean | null;
  critical: boolean | null;
  extra: P6Extra;
  preds: MPred[];
  /** read from MSPDI: the task as written (keep.ts); written from this TASK or (summary) PROJWBS row; its links in
   *  the order of its <PredecessorLink> elements (null: one the clone does not read) */
  keep?: Kept; row?: Row; links?: (MPred | null)[];
}

export interface MRes { uid: string; id: number; name: string; code: string; type: 'work' | 'material' | 'cost'; maxUnits: number | null; rate: number | null; calUid: string; p6Type?: string; keep?: Kept; row?: Row }

export interface MAssign {
  uid: string; taskUid: string; resUid: string; units: number | null;
  workHrs: number | null; actualWorkHrs: number | null; remainingWorkHrs: number | null;
  cost: number | null; actualCost: number | null; remainingCost: number | null;
  start: string; finish: string; actualStart: string; actualFinish: string;
  keep?: Kept; row?: Row;
}

export interface MProject {
  name: string;
  title: string;
  start: string;
  finish: string;
  statusDate: string;
  calUid: string;
  minutesPerDay: number;
  minutesPerWeek: number;
  /** MS Project "split in-progress tasks" ~ P6 Retained Logic. */
  splitsInProgress: boolean | null;
  criticalHrs: number;
  /** whose rules made the dates: a P6 build (written by the clone from P6) or Microsoft Project (resume: its rule for
   *  the remaining work of started tasks) */
  rules?: { ver?: string; legacy?: boolean; known?: boolean; resume?: boolean };
  calendars: MCal[];
  tasks: MTask[];
  resources: MRes[];
  assignments: MAssign[];
  /** read from MSPDI: the project's own elements, the elements that are not rows, whether the clone's custom fields
   *  were in the file; written from this PROJECT row */
  keep?: ProjectKept; row?: Row;
}

export function emptyTask(uid: string, id: number): MTask {
  return {
    uid, id, name: '', level: 1, wbs: '', outline: '', summary: false, milestone: false, type: null, durHrs: null, remHrs: null, pct: null,
    start: '', finish: '', earlyStart: '', earlyFinish: '', lateStart: '', lateFinish: '', actualStart: '', actualFinish: '', constraintDate: '', deadline: '',
    constraintType: null, calUid: '', totalSlackHrs: null, freeSlackHrs: null, ignoreRsrcCal: null, critical: null, extra: {}, preds: [],
  };
}

// ---------- constraint / type maps

/** MS Project ConstraintType 0..7 -> P6 cstr_type ('' = none). */
export const MSP_TO_CSTR = ['', 'CS_ALAP', 'CS_MANDSTART', 'CS_MANDFIN', 'CS_MSOA', 'CS_MSOB', 'CS_MEOA', 'CS_MEOB'];
const CSTR_TO_MSP: Record<string, number> = {
  CS_ALAP: 1, CS_MANDSTART: 2, CS_MSO: 2, CS_MANDFIN: 3, CS_MEO: 3, CS_MSOA: 4, CS_MSOB: 5, CS_MEOA: 6, CS_MEOB: 7,
};
const P6_CSTR = new Set(['CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MEO', 'CS_MEOB', 'CS_MEOA', 'CS_ALAP', 'CS_MANDSTART', 'CS_MANDFIN']);
const P6_TASK_TYPES = new Set(['TT_Task', 'TT_Rsrc', 'TT_LOE', 'TT_Mile', 'TT_FinMile', 'TT_WBS']);
const P6_DUR_TYPES = new Set(['DT_FixedDUR2', 'DT_FixedDrtn', 'DT_FixedQty', 'DT_FixedRate']);
/** MS Project task Type (0 fixed units, 1 fixed duration, 2 fixed work) <-> P6 duration type. */
const MSP_TYPE_TO_DT = ['DT_FixedRate', 'DT_FixedDUR2', 'DT_FixedQty'];
const DT_TO_MSP_TYPE: Record<string, number> = { DT_FixedRate: 0, DT_FixedDUR2: 1, DT_FixedDrtn: 1, DT_FixedQty: 2 };

// ---------- small helpers

export const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === '') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

/** Accepts 'yyyy-mm-ddThh:mm[:ss[.fff]][Z]' or P6 format; returns P6 'yyyy-mm-dd hh:mm' or ''. */
export function toP6Date(s: string | undefined): string {
  if (!s) return '';
  const t = parseP6Date(s.trim().replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, '').slice(0, 19));
  return t == null ? '' : formatP6Date(t);
}

/** Natural sort for Activity IDs (A1000 < A1010 < A10000). */
export const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

const DAY_SHIFTS: Shift[] = [{ start: 480, end: 720 }, { start: 780, end: 1020 }];

/** Default MS Project working times (08:00-12:00, 13:00-17:00). */
export function defaultShifts(): Shift[] {
  return DAY_SHIFTS.map((s) => ({ ...s }));
}

/** A link as comparable text: predecessor UID, P6 type, lag hours. */
export const linkKey = (predUid: string, type: string, lag: string | number) => `${predUid}:${type}:${Number(lag) || 0}`;

/** UIDs: a row's own (kept from the file) when not taken yet, else the lowest one nothing kept uses. */
function uidMaker(kept: (string | undefined)[]): (r?: Row) => string {
  const keep = new Set(kept.filter((x): x is string => !!x)), used = new Set<string>();
  let next = 1;
  return (r) => {
    let u = r?._msp_uid && !used.has(r._msp_uid) ? r._msp_uid : '';
    if (!u) { while (keep.has(String(next)) || used.has(String(next))) next++; u = String(next++); }
    used.add(u);
    return u;
  };
}
/** IDs: a row's own (from the file), else after the highest one the file had (1, 2, 3... for a P6 project). */
function idMaker(kept: (string | undefined)[]): (r: Row) => number {
  let max = kept.reduce((m, x) => Math.max(m, Number(x) || 0), 0);
  return (r) => (r._msp_id ? Number(r._msp_id) : ++max);
}

function uniqueName(name: string, used: Set<string>): string {
  let n = name.trim() || 'Calendar';
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name.trim() || 'Calendar'} (${i})`;
  used.add(n.toLowerCase());
  return n;
}

// ---------- P6 tables -> MProject (export)

/** Effective calendar definitions (own week, exceptions inherited from base calendars), keyed by clndr_id. */
export function effectiveCalendars(calRows: Row[]): Map<string, CalendarDef> {
  const byId = new Map(calRows.map((r) => [r.clndr_id, r]));
  const out = new Map<string, CalendarDef>();
  const def = (id: string, depth: number): CalendarDef => {
    const hit = out.get(id);
    if (hit) return hit;
    const r = byId.get(id)!;
    let d: CalendarDef;
    d = scheduledCalendarDef(r); // the week F9 schedules it with (no data: P6's default week from its hours)
    if (r.base_clndr_id && r.base_clndr_id !== id && byId.has(r.base_clndr_id) && depth < 10) d = inheritExceptions(d, def(r.base_clndr_id, depth + 1));
    out.set(id, d);
    return d;
  };
  for (const r of calRows) def(r.clndr_id, 0);
  return out;
}

/** Build the MS Project model of one P6 project (the first of projIds, else the first project). */
export function projectFromDb(db: Db, projIds?: string[]): MProject {
  const pid = projIds?.[0] ?? rows(db, 'PROJECT').find((p) => !p._baseline_of)?.proj_id ?? rows(db, 'PROJECT')[0]?.proj_id ?? '';
  const sel = selectRows(db, pid ? [pid] : undefined);
  const get = (t: string) => sel.get(t) ?? [];
  const proj = get('PROJECT').find((p) => p.proj_id === pid) ?? rows(db, 'PROJECT').find((p) => p.proj_id === pid) ?? {};
  const wbsAll = get('PROJWBS').filter((w) => w.proj_id === pid);
  const root = wbsAll.find((w) => w.proj_node_flag === 'Y');
  // read from Microsoft Project XML: what the file had beyond the rows (keep.ts)
  const keep: ProjectKept | undefined = proj._msp_keep ? { kids: JSON.parse(proj._msp_keep), ghosts: JSON.parse(proj._msp_ghosts || '{}'), p6ext: proj._msp_p6ext === 'Y' } : undefined;
  const ghosts: Ghosts = { tasks: [], resources: [], assignments: [], calendars: [], ...keep?.ghosts };
  const keptOf = (r: Row): Kept | undefined => (r._msp_keep ? { kids: JSON.parse(r._msp_keep), xml: '', seq: Number(r._msp_seq), id: r._msp_id || undefined } : r._msp_xml ? { kids: [], xml: r._msp_xml, seq: Number(r._msp_seq) || 0 } : undefined);

  // Calendars: every calendar the project uses, written as stand-alone base calendars with inherited holidays merged in.
  // every calendar the project uses; for a project read from MSPDI, also the file's others (none is dropped)
  const calRows = keep ? [...get('CALENDAR'), ...rows(db, 'CALENDAR').filter((c) => c._msp_xml && !get('CALENDAR').includes(c))] : get('CALENDAR');
  const defs = effectiveCalendars(calRows);
  const calUid = new Map<string, string>();
  const used = new Set<string>();
  const calUidFor = uidMaker([...calRows.map((r) => r._msp_uid), ...ghosts.calendars.map((g) => g.uid)]);
  const calendars: MCal[] = calRows.map((r) => {
    const uid = calUidFor(r);
    calUid.set(r.clndr_id, uid);
    const d = defs.get(r.clndr_id)!;
    return { uid, name: uniqueName(r.clndr_name || `Calendar ${uid}`, used), isBase: true, week: d.week.map((s) => s.map((x) => ({ ...x }))), exceptions: new Map(d.exceptions), keep: keptOf(r), row: r };
  });
  let projCal = calUid.get(proj.clndr_id ?? '') ?? calUid.get(calRows.find((c) => c.default_flag === 'Y')?.clndr_id ?? '') ?? calendars[0]?.uid;
  if (!projCal) {
    const std = standardCalendar();
    calendars.push({ uid: calUidFor(), name: uniqueName('Standard', used), isBase: true, week: std.week, exceptions: std.exceptions });
    projCal = calendars[calendars.length - 1].uid;
  }
  const projCalRow = calRows.find((c) => calUid.get(c.clndr_id) === projCal);
  const projDef = defs.get(projCalRow?.clndr_id ?? '') ?? standardCalendar();
  const weekHrs = hoursPerWeek(projDef);
  const workDays = projDef.week.filter((d) => d.length).length || 5;
  const dayHrs = Number(projCalRow?.day_hr_cnt) || (weekHrs ? weekHrs / workDays : 8);

  // Resources
  // every resource the project uses; for a project read from MSPDI, also the file's unassigned ones
  const extraRes = keep ? rows(db, 'RSRC').filter((r) => r._msp_keep && !get('RSRC').includes(r)) : [];
  const rsrcRows = [...get('RSRC'), ...extraRes].sort((a, b) => (a._msp_seq ? Number(a._msp_seq) : 1e9) - (b._msp_seq ? Number(b._msp_seq) : 1e9));
  const extraIds = new Set(extraRes.map((r) => r.rsrc_id));
  const rates = [...get('RSRCRATE'), ...rows(db, 'RSRCRATE').filter((x) => extraIds.has(x.rsrc_id))];
  const resUid = new Map<string, string>();
  const resUidFor = uidMaker([...rsrcRows.map((r) => r._msp_uid), ...ghosts.resources.map((g) => g.uid)]);
  const resIdFor = idMaker([...rsrcRows.map((r) => r._msp_id), ...ghosts.resources.map((g) => String(g.seq))]);
  const resources: MRes[] = rsrcRows.map((r) => {
    const uid = resUidFor(r);
    resUid.set(r.rsrc_id, uid);
    const rr = rates.filter((x) => x.rsrc_id === r.rsrc_id).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));
    const ps = proj.plan_start_date ?? '';
    const rate = [...rr].reverse().find((x) => !x.start_date || x.start_date <= ps) ?? rr[0];
    return {
      uid, id: resIdFor(r), name: r.rsrc_name || r.rsrc_short_name || `Resource ${uid}`, code: r.rsrc_short_name ?? '',
      type: r.rsrc_type === 'RT_Mat' ? 'material' : 'work', maxUnits: num(rate?.max_qty_per_hr), rate: num(rate?.cost_per_qty),
      calUid: calUid.get(r.clndr_id) ?? '', p6Type: r.rsrc_type || undefined, keep: keptOf(r), row: r,
    };
  });

  // Task tree: WBS nodes become summary tasks; activities sit under their WBS
  const tasks: MTask[] = [];
  const taskUid = new Map<string, string>();
  const projTasks = get('TASK').filter((t) => t.proj_id === pid);
  const wbsIds = new Set(wbsAll.map((w) => w.wbs_id));
  const rootId = root?.wbs_id ?? '';
  const parentOf = (w: Row) => (w.parent_wbs_id && wbsIds.has(w.parent_wbs_id) && w.parent_wbs_id !== w.wbs_id ? w.parent_wbs_id : rootId);
  const kidsWbs = new Map<string, Row[]>();
  for (const w of wbsAll) {
    if (w.proj_node_flag === 'Y') continue;
    const p = parentOf(w);
    let a = kidsWbs.get(p);
    if (!a) kidsWbs.set(p, (a = []));
    a.push(w);
  }
  const kidsTask = new Map<string, Row[]>();
  for (const t of projTasks) {
    const w = t.wbs_id && wbsIds.has(t.wbs_id) ? t.wbs_id : rootId;
    let a = kidsTask.get(w);
    if (!a) kidsTask.set(w, (a = []));
    a.push(t);
  }
  // tasks read from Microsoft Project keep their UID and ID and their place among their siblings; the others get
  // UIDs and IDs no kept one uses, after them
  const uidFor = uidMaker([...projTasks, ...wbsAll].map((r) => r._msp_uid).concat(ghosts.tasks.map((g) => g.uid)));
  const idFor = idMaker([...projTasks, ...wbsAll].map((r) => r._msp_id).concat(ghosts.tasks.map((g) => String(g.seq))));
  const bySeq = <T extends { r: Row }>(l: T[]) => (l.some((x) => x.r._msp_seq) ? l.map((x, i) => ({ x, i, s: x.r._msp_seq ? Number(x.r._msp_seq) : Infinity })).sort((a, b) => a.s - b.s || a.i - b.i).map((y) => y.x) : l);
  const visited = new Set<string>();
  const visit = (wbsId: string, level: number, outline: string, code: string) => {
    if (visited.has(wbsId)) return;
    visited.add(wbsId);
    let n = 0;
    const acts = (kidsTask.get(wbsId) ?? []).sort((a, b) => natural(a.task_code ?? '', b.task_code ?? '')).map((r) => ({ r, wbs: false }));
    const ws = (kidsWbs.get(wbsId) ?? []).sort((a, b) => (Number(a.seq_num) || 0) - (Number(b.seq_num) || 0) || natural(a.wbs_short_name ?? '', b.wbs_short_name ?? '')).map((r) => ({ r, wbs: true }));
    for (const { r: t, wbs } of bySeq([...acts, ...ws])) {
      n++;
      const o = outline ? `${outline}.${n}` : String(n);
      if (!wbs) {
        const m = taskFromRow(t, uidFor(t), idFor(t), level, o, calUid.get(t.clndr_id) ?? projCal!);
        Object.assign(m, { keep: keptOf(t), row: t });
        taskUid.set(t.task_id, m.uid);
        tasks.push(m);
        continue;
      }
      const c = code ? `${code}.${t.wbs_short_name}` : t.wbs_short_name ?? '';
      const s = emptyTask(uidFor(t), idFor(t));
      Object.assign(s, { name: t.wbs_name || t.wbs_short_name || '', level, outline: o, wbs: c, summary: true, type: 1, durHrs: 0, calUid: projCal, keep: keptOf(t), row: t });
      tasks.push(s);
      visit(t.wbs_id, level + 1, o, c);
    }
  };
  visit(rootId, 1, '', '');
  // Orphan WBS cycles never reached: put their activities at the top level
  for (const t of projTasks) if (!taskUid.has(t.task_id)) {
    const m = taskFromRow(t, uidFor(t), idFor(t), 1, String(tasks.filter((x) => x.level === 1).length + 1), calUid.get(t.clndr_id) ?? projCal);
    Object.assign(m, { keep: keptOf(t), row: t });
    taskUid.set(t.task_id, m.uid);
    tasks.push(m);
  }
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  for (const r of get('TASKPRED')) {
    const s = taskUid.get(r.task_id), p = taskUid.get(r.pred_task_id);
    if (!s || !p || s === p) continue;
    const type = (r.pred_type?.slice(3, 5) || 'FS') as RelType;
    byUid.get(s)!.preds.push({ uid: p, type: ['FS', 'SS', 'FF', 'SF'].includes(type) ? type : 'FS', lagHrs: Number(r.lag_hr_cnt) || 0 });
  }
  // Summary dates span their children (MS Project recomputes them anyway)
  for (let i = tasks.length - 1; i >= 0; i--) {
    const s = tasks[i];
    if (!s.summary) continue;
    let st = '', fi = '';
    for (let j = i + 1; j < tasks.length && tasks[j].level > s.level; j++) {
      const c = tasks[j];
      if (c.start && (!st || c.start < st)) st = c.start;
      if (c.finish && (!fi || c.finish > fi)) fi = c.finish;
    }
    s.start = st || proj.plan_start_date || '';
    s.finish = fi || s.start;
  }

  const assignments: MAssign[] = [];
  const asgUidFor = uidMaker([...get('TASKRSRC').map((a) => a._msp_uid), ...ghosts.assignments.map((g) => g.uid)]);
  for (const a of get('TASKRSRC')) {
    const t = taskUid.get(a.task_id), r = resUid.get(a.rsrc_id);
    if (!t || !r) continue;
    const target = num(a.target_qty), act = (num(a.act_reg_qty) ?? 0) + (num(a.act_ot_qty) ?? 0), rem = num(a.remain_qty);
    const actCost = (num(a.act_reg_cost) ?? 0) + (num(a.act_ot_cost) ?? 0), remCost = num(a.remain_cost);
    assignments.push({
      uid: asgUidFor(a), taskUid: t, resUid: r, units: num(a.target_qty_per_hr) ?? num(a.remain_qty_per_hr),
      workHrs: rem != null ? act + rem : target, actualWorkHrs: act, remainingWorkHrs: rem,
      cost: remCost != null ? actCost + remCost : num(a.target_cost), actualCost: actCost, remainingCost: remCost,
      start: a.act_start_date || a.restart_date || a.target_start_date || '', finish: a.act_end_date || a.reend_date || a.target_end_date || '',
      actualStart: a.act_start_date ?? '', actualFinish: a.act_end_date ?? '', keep: keptOf(a), row: a,
    });
  }

  const so = get('SCHEDOPTIONS').find((s) => s.proj_id === pid) ?? rows(db, 'SCHEDOPTIONS').find((s) => s.proj_id === pid);
  const finish = proj.scd_end_date || tasks.reduce((m, t) => (t.finish > m ? t.finish : m), '');
  return {
    name: proj.proj_short_name || 'Project', title: root?.wbs_name || proj.proj_short_name || 'Project',
    start: proj.plan_start_date || tasks.reduce((m, t) => (t.start && (!m || t.start < m) ? t.start : m), ''), finish,
    statusDate: proj.last_recalc_date ?? '', calUid: projCal, minutesPerDay: Math.round(dayHrs * 60), minutesPerWeek: Math.round((weekHrs || dayHrs * 5) * 60),
    splitsInProgress: so ? so.sched_progress_override !== 'Y' : null, criticalHrs: Number(proj.critical_drtn_hr_cnt) || 0,
    calendars, tasks, resources, assignments, keep, row: proj,
  };
}

function taskFromRow(t: Row, uid: string, id: number, level: number, outline: string, calUid: string): MTask {
  const m = emptyTask(uid, id);
  const isMile = t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile';
  const done = !!t.act_end_date;
  const dur = num(t.target_drtn_hr_cnt) ?? 0;
  const rem = done ? 0 : num(t.remain_drtn_hr_cnt) ?? dur;
  const cstr1 = P6_CSTR.has(t.cstr_type ?? '') ? t.cstr_type : '';
  Object.assign(m, {
    name: t.task_name ?? '', level, outline, summary: false, milestone: isMile, type: DT_TO_MSP_TYPE[t.duration_type ?? ''] ?? 1,
    durHrs: isMile ? 0 : dur, remHrs: isMile ? 0 : rem,
    pct: done ? 100 : isMile ? (t.act_start_date ? 100 : 0) : dur > 0 ? Math.max(0, Math.min(100, Math.round(((dur - rem) / dur) * 100))) : t.act_start_date ? 50 : 0,
    start: t.act_start_date || t.early_start_date || t.target_start_date || '',
    finish: t.act_end_date || t.early_end_date || t.target_end_date || '',
    earlyStart: done ? '' : t.early_start_date ?? '', earlyFinish: done ? '' : t.early_end_date ?? '',
    lateStart: done ? '' : t.late_start_date ?? '', lateFinish: done ? '' : t.late_end_date ?? '',
    actualStart: t.act_start_date ?? '', actualFinish: t.act_end_date ?? '',
    constraintType: cstr1 ? CSTR_TO_MSP[cstr1] : 0, constraintDate: cstr1 && cstr1 !== 'CS_ALAP' ? t.cstr_date ?? '' : '',
    calUid, totalSlackHrs: num(t.total_float_hr_cnt), freeSlackHrs: num(t.free_float_hr_cnt),
    ignoreRsrcCal: t.task_type !== 'TT_Rsrc', critical: t.driving_path_flag === 'Y' || (num(t.total_float_hr_cnt) ?? 1) <= 0,
  } satisfies Partial<MTask>);
  // A finish-before secondary constraint is what MS Project calls a Deadline.
  if ((t.cstr_type2 === 'CS_MEOB' || t.cstr_type2 === 'CS_MEO') && t.cstr_date2) m.deadline = t.cstr_date2;
  m.extra = {
    activityId: t.task_code || undefined, taskType: t.task_type || undefined, cstr: cstr1 || undefined, durType: t.duration_type || undefined,
    cstr2: P6_CSTR.has(t.cstr_type2 ?? '') ? `${t.cstr_type2}${t.cstr_date2 ? ' ' + t.cstr_date2 : ''}` : undefined,
  };
  return m;
}

// ---------- MProject -> P6 tables (import)

const SCHED_DEFAULTS: Row = {
  sched_outer_depend_type: 'SD_Both', sched_open_critical_flag: 'N', sched_lag_early_start_flag: 'Y', sched_retained_logic: 'Y', sched_setplantoforecast: 'N',
  sched_float_type: 'FT_FF', sched_calendar_on_relationship_lag: 'rcal_Predecessor', sched_use_expect_end_flag: 'Y', sched_progress_override: 'N',
  level_float_thrs_cnt: '0', level_outer_assign_flag: 'N', level_outer_assign_priority: '5', level_over_alloc_pct: '25', level_within_float_flag: 'N',
  level_keep_sched_date_flag: 'Y', level_all_rsrc_flag: 'Y',
};

export function projectToDb(m: MProject, findings: Finding[], source: string): Db {
  const db: Db = { tables: {} };
  const push = (t: string, r: Row) => { const T = table(db, t); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };
  const pid = '1';
  const ghosts: Ghosts = m.keep ? m.keep.ghosts : { tasks: [], resources: [], assignments: [], calendars: [] };
  const kept = (k: { keep?: { kids: [string, string][]; seq: number; id?: string } }): Row => (k.keep ? { _msp_keep: JSON.stringify(k.keep.kids), _msp_seq: String(k.keep.seq), _msp_id: k.keep.id ?? '' } : {});
  const info = (code: string, message: string, p6: string, extra: Partial<Finding> = {}) => findings.push({ severity: 'info', code, message, p6, ...extra });
  const warn = (code: string, message: string, p6: string, extra: Partial<Finding> = {}) => findings.push({ severity: 'warning', code, message, p6, ...extra });

  // Calendars
  const calById = new Map(m.calendars.map((c) => [c.uid, c]));
  const calAlias = new Map<string, string>(); // resource-only derived calendars without own changes -> their base
  const resCalUids = new Set(m.resources.map((r) => r.calUid));
  const taskCalUids = new Set(m.tasks.map((t) => t.calUid));
  const resolvedWeek = (c: MCal, depth = 0): Shift[][] => {
    const base = c.baseUid && c.baseUid !== c.uid && depth < 10 ? calById.get(c.baseUid) : undefined;
    const bw = base ? resolvedWeek(base, depth + 1) : null;
    return c.week.map((d, i) => d ?? bw?.[i] ?? (i === 0 || i === 6 ? [] : defaultShifts()));
  };
  for (const c of m.calendars) {
    const own = c.week.some((d) => d != null) || c.exceptions.size > 0;
    if (!c.isBase && c.baseUid && calById.has(c.baseUid) && !own && resCalUids.has(c.uid) && !taskCalUids.has(c.uid) && c.uid !== m.calUid) { calAlias.set(c.uid, c.baseUid); if (c.keep) ghosts.calendars.push({ seq: c.keep.seq, uid: c.uid, xml: c.keep.xml }); continue; }
    const def: CalendarDef = { week: resolvedWeek(c), exceptions: c.exceptions };
    const wh = hoursPerWeek(def);
    const days = def.week.filter((d) => d.length).length || 5;
    push('CALENDAR', {
      ...(c.keep ? { _msp_uid: c.uid, _msp_xml: c.keep.xml, _msp_seq: String(c.keep.seq) } : {}),
      clndr_id: c.uid, default_flag: c.uid === m.calUid ? 'Y' : 'N', clndr_name: c.name, proj_id: '', base_clndr_id: !c.isBase && c.baseUid && calById.has(c.baseUid) ? c.baseUid : '',
      last_chng_date: '', clndr_type: c.isBase ? 'CA_Base' : 'CA_Rsrc', day_hr_cnt: p6num(c.uid === m.calUid && m.minutesPerDay ? m.minutesPerDay / 60 : wh / days || 8),
      week_hr_cnt: p6num(wh), month_hr_cnt: p6num((wh / days || 8) * 21.5), year_hr_cnt: p6num(wh * 52), rsrc_private: 'N', clndr_data: serializeClndrData(def),
    });
  }
  const calIds = new Set(rows(db, 'CALENDAR').map((c) => c.clndr_id));
  const cal = (uid: string) => { const u = calAlias.get(uid) ?? uid; return calIds.has(u) ? u : ''; };
  let projCal = cal(m.calUid);
  if (!projCal) {
    const first = rows(db, 'CALENDAR')[0];
    if (first) projCal = first.clndr_id;
    else {
      projCal = '1';
      push('CALENDAR', { clndr_id: '1', default_flag: 'Y', clndr_name: 'Standard', proj_id: '', base_clndr_id: '', last_chng_date: '', clndr_type: 'CA_Base', day_hr_cnt: '8', week_hr_cnt: '40', month_hr_cnt: '172', year_hr_cnt: '2080', rsrc_private: 'N', clndr_data: serializeClndrData(standardCalendar()) });
      info('MSP_NO_CALENDAR', `${source} defines no calendars; a Standard 5-day calendar was created.`, 'P6 assigns its default global calendar.');
    }
    rows(db, 'CALENDAR').forEach((c) => (c.default_flag = c.clndr_id === projCal ? 'Y' : 'N'));
  }

  // Project
  const start = m.start || m.tasks.reduce((s, t) => (t.start && (!s || t.start < s) ? t.start : s), '') || formatP6Date(Math.floor(Date.now() / 86400000) * 1440);
  const shortName = (m.name || m.title || 'MSP').replace(/\.(xml|mpp|mpx)$/i, '').slice(0, 40);
  push('PROJECT', {
    proj_id: pid, proj_short_name: shortName, clndr_id: projCal, plan_start_date: start, plan_end_date: '', scd_end_date: m.finish, last_recalc_date: m.statusDate || start,
    def_duration_type: 'DT_FixedDUR2', def_complete_pct_type: 'CP_Drtn', def_task_type: 'TT_Task', task_code_prefix: 'A', task_code_base: '1000', task_code_step: '10',
    critical_drtn_hr_cnt: p6num(m.criticalHrs || 0), critical_path_type: 'CT_TotFloat', name_sep_char: '.', project_flag: 'Y', def_qty_type: 'QT_Hour', def_rate_type: 'COST_PER_QTY',
    _msp_source: 'Y', // read from Microsoft Project (MSPDI or MPX): Project's rules where they differ (one link per pair)
  });
  push('SCHEDOPTIONS', {
    schedoptions_id: pid, proj_id: pid, ...SCHED_DEFAULTS,
    ...(m.splitsInProgress === false ? { sched_retained_logic: 'N', sched_progress_override: 'Y' } : {}),
  });

  // WBS + activities from the outline
  const maxUid = m.tasks.reduce((x, t) => Math.max(x, Number(t.uid) || 0), 0);
  const rootId = String(maxUid + 1);
  push('PROJWBS', { wbs_id: rootId, proj_id: pid, obs_id: '', seq_num: '0', proj_node_flag: 'Y', status_code: 'WS_Open', wbs_short_name: shortName, wbs_name: m.title || shortName, parent_wbs_id: '' });
  const tasks = m.tasks.filter((t) => t.level > 0);
  const isSummary = tasks.map((t, i) => t.summary || (i + 1 < tasks.length && tasks[i + 1].level > t.level));
  const stack: { level: number; wbsId: string; code: string }[] = [{ level: 0, wbsId: rootId, code: '' }];
  const summaryUids = new Set<string>();
  const taskRows = new Map<string, Row>();
  const codes = new Set<string>();
  let seq = 0, gen = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    while (stack.length > 1 && stack[stack.length - 1].level >= t.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (isSummary[i]) {
      summaryUids.add(t.uid);
      const full = t.wbs || t.outline || String(i + 1);
      const short = parent.code && full.startsWith(parent.code + '.') ? full.slice(parent.code.length + 1) : full.includes('.') && !t.wbs ? full.slice(full.lastIndexOf('.') + 1) : full;
      push('PROJWBS', { wbs_id: t.uid, proj_id: pid, obs_id: '', seq_num: String(++seq * 10), proj_node_flag: 'N', status_code: 'WS_Open', wbs_short_name: short.slice(0, 40), wbs_name: t.name, parent_wbs_id: parent.wbsId, _msp_uid: t.uid, ...kept(t) });
      stack.push({ level: t.level, wbsId: t.uid, code: full });
      if (t.preds.length) warn('MSP_SUMMARY_LINK', `Summary task "${t.name}" has ${t.preds.length} predecessor link(s); WBS nodes cannot carry logic, so they were dropped.`, 'P6 drops relationships on MS Project summary tasks when importing.', { table: 'TASKPRED', key: t.uid });
      continue;
    }
    let code = t.extra.activityId?.trim() || '';
    if (!code || codes.has(code)) {
      if (code) warn('MSP_DUP_ACTIVITY_ID', `Activity ID ${code} is used twice; a new ID was generated.`, 'P6 requires unique Activity IDs within a project.', { table: 'TASK', key: t.uid });
      do code = `A${1000 + 10 * gen++}`; while (codes.has(code));
    }
    codes.add(code);
    const r = taskRow(t, pid, parent.wbsId, cal(t.extra.calName ? m.calendars.find((c) => c.name === t.extra.calName)?.uid ?? t.calUid : t.calUid) || projCal, code, findings);
    taskRows.set(t.uid, r);
    Object.assign(r, kept(t));
    push('TASK', r);
  }
  // Milestones without a P6 type: start milestone when nothing drives it, else finish milestone
  for (const t of tasks) {
    const r = taskRows.get(t.uid);
    if (!r || r.task_type !== '?mile') continue;
    r.task_type = t.preds.some((p) => taskRows.has(p.uid)) ? 'TT_FinMile' : 'TT_Mile';
  }

  // Relationships
  let relId = 0;
  const imported = new Set<MPred>();
  for (const t of tasks) {
    const succ = taskRows.get(t.uid);
    if (!succ) continue;
    for (const p of t.preds) {
      if (p.uid === t.uid) continue;
      if (summaryUids.has(p.uid)) { warn('MSP_SUMMARY_LINK', `Link from summary task ${p.uid} to "${t.name}" dropped (WBS nodes cannot carry logic).`, 'P6 drops relationships on MS Project summary tasks when importing.', { table: 'TASKPRED', key: t.uid }); continue; }
      const pred = taskRows.get(p.uid);
      if (!pred) { warn('MSP_LINK_UNRESOLVED', `"${t.name}" has a predecessor ${p.uid} that is not in the file; link dropped.`, 'P6 drops links to tasks it does not import.', { table: 'TASKPRED', key: t.uid }); continue; }
      push('TASKPRED', { task_pred_id: String(++relId), task_id: succ.task_id, pred_task_id: pred.task_id, proj_id: pid, pred_proj_id: pid, pred_type: `PR_${p.type}`, lag_hr_cnt: p6num(p.lagHrs) });
      imported.add(p);
    }
    // each <PredecessorLink> of the file: the link it became ('': one the clone did not import), so that a save keeps
    // the links an edit did not touch as they were written (lag formats, links to summary tasks, other projects)
    if (t.links) { addField(table(db, 'TASK'), '_msp_links'); succ._msp_links = JSON.stringify(t.links.map((p) => (p && imported.has(p) ? linkKey(p.uid, `PR_${p.type}`, p6num(p.lagHrs)) : ''))); }
  }

  // Resources
  const resIds = new Set<string>();
  const codesR = new Set<string>();
  for (const r of m.resources) {
    if (!r.name && !r.code) continue;
    let code = (r.code || r.name).slice(0, 20);
    for (let i = 2; codesR.has(code); i++) code = `${(r.code || r.name).slice(0, 16)}-${i}`;
    codesR.add(code);
    const type = r.p6Type && ['RT_Labor', 'RT_Equip', 'RT_Mat'].includes(r.p6Type) ? r.p6Type : r.type === 'material' ? 'RT_Mat' : 'RT_Labor';
    if (r.type === 'cost' && !r.p6Type) info('MSP_COST_RESOURCE', `Cost resource "${r.name}" imported as a labor resource.`, 'P6 has no cost resources; P6 imports them as resources or expenses.', { table: 'RSRC', key: r.uid });
    resIds.add(r.uid);
    push('RSRC', {
      ...(r.keep ? { _msp_uid: r.uid, ...kept(r) } : {}),
      rsrc_id: r.uid, parent_rsrc_id: '', clndr_id: cal(r.calUid) || projCal, rsrc_name: r.name || code, rsrc_short_name: code, rsrc_title_name: '', def_qty_per_hr: p6num(r.maxUnits ?? 1),
      cost_qty_type: 'QT_Hour', active_flag: 'Y', auto_compute_act_flag: 'Y', def_cost_qty_link_flag: 'Y', ot_flag: 'N', rsrc_type: type,
    });
    push('RSRCRATE', { rsrc_rate_id: r.uid, rsrc_id: r.uid, max_qty_per_hr: p6num(r.maxUnits ?? 1), cost_per_qty: p6num(r.rate ?? 0), start_date: start });
  }
  const rsrcType = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_type]));
  for (const a of m.assignments) {
    const t = taskRows.get(a.taskUid);
    // not P6 assignments (on a summary task, unassigned, unknown resource): kept to be written back as they were
    const ghost = () => { if (a.keep) ghosts.assignments.push({ seq: a.keep.seq, uid: a.uid, xml: a.keep.xml }); };
    if (!t) { ghost(); if (summaryUids.has(a.taskUid)) warn('MSP_SUMMARY_ASSIGNMENT', `Resource assignment ${a.uid} on a summary task dropped.`, 'P6 cannot assign resources to WBS nodes.', { table: 'TASKRSRC', key: a.uid }); continue; }
    if (!resIds.has(a.resUid)) { ghost(); continue; } // unassigned (-65535) or unknown resource
    const done = !!t.act_end_date;
    const act = a.actualWorkHrs ?? 0;
    const rem = done ? 0 : a.remainingWorkHrs ?? Math.max(0, (a.workHrs ?? 0) - act);
    const target = a.workHrs ?? act + rem;
    const durH = Number(t.target_drtn_hr_cnt) || 0;
    const units = a.units ?? (durH > 0 ? target / durH : 1);
    const actCost = a.actualCost ?? 0;
    const remCost = done ? 0 : a.remainingCost ?? Math.max(0, (a.cost ?? 0) - actCost);
    push('TASKRSRC', {
      taskrsrc_id: a.uid, task_id: t.task_id, proj_id: pid, rsrc_id: a.resUid, role_id: '', acct_id: '', cost_qty_link_flag: 'Y',
      remain_qty: p6num(rem), target_qty: p6num(target), remain_qty_per_hr: p6num(units), target_qty_per_hr: p6num(units), act_reg_qty: p6num(act), act_ot_qty: '0',
      target_lag_drtn_hr_cnt: '0', relag_drtn_hr_cnt: '0', cost_per_qty: target > 0 && a.cost != null ? p6num(a.cost / target) : '0', target_cost: p6num(a.cost ?? actCost + remCost),
      act_reg_cost: p6num(actCost), act_ot_cost: '0', remain_cost: p6num(remCost),
      act_start_date: a.actualStart || (t.act_start_date ?? ''), act_end_date: a.actualFinish || (done ? t.act_end_date : ''),
      restart_date: done ? '' : t.restart_date ?? '', reend_date: done ? '' : t.reend_date ?? '', target_start_date: a.start || t.target_start_date || '', target_end_date: a.finish || t.target_end_date || '',
      rate_type: 'COST_PER_QTY', rsrc_type: rsrcType.get(a.resUid) ?? 'RT_Labor',
      ...(a.keep ? { _msp_uid: a.uid, _msp_keep: JSON.stringify(a.keep.kids), _msp_seq: String(a.keep.seq) } : {}),
    });
  }
  // P6 TASK.rsrc_id is the primary resource: first assignment
  const firstRsrc = new Map<string, string>();
  for (const a of rows(db, 'TASKRSRC')) if (!firstRsrc.has(a.task_id)) firstRsrc.set(a.task_id, a.rsrc_id);
  if (db.tables.TASK) { addField(db.tables.TASK, 'rsrc_id'); for (const r of db.tables.TASK.rows) r.rsrc_id = firstRsrc.get(r.task_id) ?? ''; }
  if (m.keep) {
    const P = table(db, 'PROJECT');
    for (const k of ['_msp_keep', '_msp_ghosts', '_msp_p6ext', '_msp_ntasks']) addField(P, k);
    for (const k of ['_msp_resume', '_p6_ver', '_legacy_ms']) addField(P, k);
    if (m.rules?.resume) P.rows[0]._msp_resume = 'Y';
    if (m.rules?.ver) P.rows[0]._p6_ver = m.rules.ver;
    if (m.rules?.known) P.rows[0]._legacy_ms = m.rules.legacy ? 'Y' : 'N';
    Object.assign(P.rows[0], { _msp_keep: JSON.stringify(m.keep.kids), _msp_ghosts: JSON.stringify(ghosts), _msp_p6ext: m.keep.p6ext ? 'Y' : '', _msp_ntasks: String(rows(db, 'TASK').length) });
  }
  return db;
}

function taskRow(t: MTask, pid: string, wbsId: string, clndr: string, code: string, findings: Finding[]): Row {
  const x = t.extra;
  const dur = Math.max(0, t.durHrs ?? 0);
  let type = x.taskType && P6_TASK_TYPES.has(x.taskType) && x.taskType !== 'TT_WBS' ? x.taskType : x.taskType === 'TT_WBS' ? 'TT_WBS' : '';
  if (!type) {
    if (t.milestone || dur === 0) type = '?mile';
    else type = 'TT_Task';
    if (t.milestone && dur > 0) { type = 'TT_Task'; findings.push({ severity: 'info', code: 'MSP_MILESTONE_DURATION', table: 'TASK', key: t.uid, message: `"${t.name}" is flagged as a milestone but has ${p6num(dur)} h duration; imported as a task.`, p6: 'P6 milestones have zero duration.' }); }
  }
  const mile = type === '?mile' || type === 'TT_Mile' || type === 'TT_FinMile';
  let as = t.actualStart, af = t.actualFinish;
  if (af && !as) { as = t.start || af; findings.push({ severity: 'warning', code: 'MSP_FINISH_WITHOUT_START', table: 'TASK', key: t.uid, message: `"${t.name}" has an actual finish but no actual start; start set to ${as}.`, p6: 'P6 requires an actual start on completed activities.' }); }
  if (!af && !as && (t.pct ?? 0) >= 100 && t.start && t.finish) { as = t.start; af = t.finish; }
  const status = af ? 'TK_Complete' : as ? 'TK_Active' : 'TK_NotStart';
  const rem = mile || af ? 0 : t.remHrs != null ? Math.max(0, t.remHrs) : as ? dur * (1 - Math.min(100, Math.max(0, t.pct ?? 0)) / 100) : dur;
  let cstr = '', cdate = '';
  if (x.cstr && P6_CSTR.has(x.cstr)) cstr = x.cstr;
  else if (t.constraintType != null && t.constraintType >= 0 && t.constraintType < MSP_TO_CSTR.length) cstr = MSP_TO_CSTR[t.constraintType];
  if (cstr && cstr !== 'CS_ALAP') {
    cdate = t.constraintDate;
    if (!cdate) { findings.push({ severity: 'warning', code: 'MSP_CONSTRAINT_NO_DATE', table: 'TASK', key: t.uid, message: `"${t.name}" has constraint ${cstr} without a date; constraint dropped.`, p6: 'P6 needs a constraint date.' }); cstr = ''; }
  }
  let cstr2 = '', cdate2 = '';
  if (x.cstr2) {
    const [ty, ...d] = x.cstr2.trim().split(/\s+/);
    if (P6_CSTR.has(ty)) { cstr2 = ty; cdate2 = toP6Date(d.join(' ')); }
  } else if (t.deadline) {
    findings.push({ severity: 'info', code: 'MSP_DEADLINE', table: 'TASK', key: t.uid, message: `"${t.name}" has a deadline ${t.deadline}; P6 has no deadlines, so it is not imported as a constraint.`, p6: 'P6 ignores MS Project deadlines on import.' });
  }
  const done = status === 'TK_Complete';
  const es = done ? as : t.earlyStart || t.start, ef = done ? af : t.earlyFinish || t.finish;
  const row: Row = {
    task_id: t.uid, proj_id: pid, wbs_id: wbsId, clndr_id: clndr, phys_complete_pct: p6num(Math.max(0, Math.min(100, t.pct ?? (done ? 100 : 0)))),
    complete_pct_type: 'CP_Drtn', task_type: type, duration_type: x.durType && P6_DUR_TYPES.has(x.durType) ? x.durType : MSP_TYPE_TO_DT[t.type ?? 1] ?? 'DT_FixedDUR2',
    status_code: status, task_code: code, task_name: t.name, rsrc_id: '', total_float_hr_cnt: done || t.totalSlackHrs == null ? '' : p6num(t.totalSlackHrs),
    free_float_hr_cnt: done || t.freeSlackHrs == null ? '' : p6num(t.freeSlackHrs), remain_drtn_hr_cnt: p6num(rem), target_drtn_hr_cnt: p6num(mile ? 0 : dur),
    cstr_date: cdate, act_start_date: as, act_end_date: af, late_start_date: done ? '' : t.lateStart, late_end_date: done ? '' : t.lateFinish, expect_end_date: '',
    early_start_date: es, early_end_date: ef, restart_date: done ? '' : es, reend_date: done ? '' : ef, target_start_date: t.start || es, target_end_date: t.finish || ef,
    rem_late_start_date: done ? '' : t.lateStart, rem_late_end_date: done ? '' : t.lateFinish, cstr_type: cstr, priority_type: 'PT_Normal',
    cstr_date2: cdate2, cstr_type2: cstr2, driving_path_flag: t.critical ? 'Y' : 'N', guid: '', _msp_uid: t.uid,
  };
  // the duration done, when started: what Microsoft Project's rule for the remaining work counts from (cpm.ts), with
  // the progress it holds for (progressKey)
  if (as && !af) Object.assign(row, { _msp_done: p6num(t.actHrs ?? Math.max(0, dur - rem)), _msp_done_of: progressKey(row) });
  return row;
}
