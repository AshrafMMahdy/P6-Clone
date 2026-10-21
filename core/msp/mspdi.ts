// Microsoft Project XML (MSPDI, namespace http://schemas.microsoft.com/project) import/export.
// Elements are written in the order of the MSPDI schema (mspdi_pj12.xsd), which Microsoft Project enforces.
import type { Db, Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { parseClndrData, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../dates.ts';
import { parseXml, type XNode } from '../xml/p6xml.ts';
import { isLegacyLayout, p6num } from '../schedule/cpm.ts';
import { baselineNumbers, baselineXml, importMspBaselines } from './baselines.ts';
import { ASG_DEPS, COLLECTIONS, ORDER, PROJECT_DEPS, RES_DEPS, SUMMARY_DEPS, TASK_DEPS, changedSince, keepCtx, mergeKids, snapshotKept, type Ghosts, type Kept } from './keep.ts';
import { defaultShifts, emptyTask, linkKey, num, projectFromDb, projectToDb, toP6Date, type MPred, type MAssign, type MCal, type MProject, type MRes, type MTask, type P6Extra, type RelType } from './shared.ts';

export const MSPDI_NS = 'http://schemas.microsoft.com/project';

const child = (n: XNode, name: string) => n.children.find((c) => c.name === name);
const kids = (n: XNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
const val = (n: XNode | undefined, name: string) => (n ? child(n, name)?.text.trim() ?? '' : '');
const flag = (s: string) => s === '1' || s.toLowerCase() === 'true';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- custom fields (task/resource Text fields) carrying P6 data

const TASK_TEXT: [key: keyof P6Extra, fieldId: string, fieldName: string, alias: string][] = [
  ['activityId', '188743731', 'Text1', 'P6 Activity ID'],
  ['taskType', '188743734', 'Text2', 'P6 Activity Type'],
  ['cstr', '188743737', 'Text3', 'P6 Constraint'],
  ['cstr2', '188743740', 'Text4', 'P6 Secondary Constraint'],
  ['durType', '188743743', 'Text5', 'P6 Duration Type'],
];
const RES_TYPE_FIELD = ['205520904', 'Text1', 'P6 Resource Type'];
/** A definition with no values, naming the P6 build whose scheduling rules made the dates (so F9 after reading the file
 *  back applies the same: P6 5-7 builds place milestones one minute into a period). */
const RULES_FIELD = ['188743746', 'Text6'];
const rulesAlias = (ver: string, legacy: boolean) => `P6 Schedule Rules ${ver || '?'}${legacy ? ' legacy' : ''}`;

// ---------- durations and times

/** ISO-8601 duration (PT40H0M0S, P1DT2H, -PT8H) -> hours. Days count as working days of minutesPerDay. */
export function isoDurationHours(s: string, minutesPerDay = 480): number | null {
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const dayH = minutesPerDay / 60;
  const h = n(2) * 52 * 5 * dayH + n(3) * 20 * dayH + n(4) * 5 * dayH + n(5) * dayH + n(6) + n(7) / 60 + n(8) / 3600;
  return m[1] ? -h : h;
}

export function hoursToIso(h: number): string {
  const neg = h < 0;
  const secs = Math.round(Math.abs(h) * 3600);
  return `${neg ? '-' : ''}PT${Math.floor(secs / 3600)}H${Math.floor((secs % 3600) / 60)}M${secs % 60}S`;
}

const xmlDate = (s: string) => { const t = parseP6Date(s); return t == null ? '' : formatP6Date(t).replace(' ', 'T') + ':00'; };
const hms = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
const parseTime = (s: string, isEnd: boolean): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return isEnd && (v === 0 || v >= 1440) ? 1440 : v;
};

// ---------- calendar elements (read, and patched in place when an edited calendar is written back)

const shiftsOf = (n: XNode | undefined): Shift[] => kids(child(n ?? { name: '', children: [], text: '' }, 'WorkingTimes'), 'WorkingTime')
  .map((w) => ({ start: parseTime(val(w, 'FromTime'), false), end: parseTime(val(w, 'ToTime'), true) }))
  .filter((s): s is Shift => s.start != null && s.end != null && s.end > s.start).sort((a, b) => a.start - b.start);
const dayShifts = (n: XNode) => { const working = flag(val(n, 'DayWorking')); const ss = working ? shiftsOf(n) : []; return working && !ss.length ? defaultShifts() : ss; };
const serialOf = (s: string) => { const t = parseP6Date(toP6Date(s)); return t == null ? null : minutesToSerial(t); };
/** The days an <Exception> covers (OLE serial day -> shifts); `known` false for a recurrence type the clone cannot expand. */
function exceptionDays(ex: XNode): { days: Map<number, Shift[]>; known: boolean; long: boolean } {
  const days = new Map<number, Shift[]>();
  const tp = child(ex, 'TimePeriod');
  if (!tp) return { days, known: true, long: false };
  const ss = dayShifts(ex);
  const type = Number(val(ex, 'Type') || '1');
  const d0 = serialOf(val(tp, 'FromDate')), to = serialOf(val(tp, 'ToDate'));
  if (d0 == null) return { days, known: true, long: false };
  const d1 = to ?? d0, long = d1 - d0 > 20000, end = Math.min(d1, d0 + 20000);
  if (type === 1) { for (let d = d0; d <= end; d += Math.max(1, Number(val(ex, 'Period')) || 1)) days.set(d, ss.map((s) => ({ ...s }))); return { days, known: true, long }; }
  const dow = Number(val(ex, 'DaysOfWeek')) || 0, month = Number(val(ex, 'Month')), mday = Number(val(ex, 'MonthDay'));
  for (let d = d0; d <= end; d++) {
    const dt = new Date(serialToMinutes(d) * 60000);
    const ok = type === 6 ? (dow & (1 << dt.getUTCDay())) !== 0 : type === 2 || type === 4 ? dt.getUTCDate() === mday && (type === 4 || dt.getUTCMonth() === month) : false;
    if (ok) days.set(d, ss.map((s) => ({ ...s })));
  }
  if (!days.size && type !== 6 && type !== 2 && type !== 4) { days.set(d0, ss.map((s) => ({ ...s }))); return { days, known: false, long }; }
  return { days, known: true, long };
}

// ---------- parser

export function parseMspdi(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const empty: Db = { tables: {} };
  let root: XNode;
  const src = text.replace(/^﻿/, '');
  // read as it goes: each task, resource and assignment is read as soon as it closes and let go (readProject)
  const reader = projectReader(findings, src);
  try {
    root = parseXml(src, reader.split, reader.emit, reader.onRoot);
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'XML_PARSE', message: `XML is not well formed: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
  const p = root.children.find((c) => c.name === 'Project');
  if (!p) {
    findings.push({ severity: 'fatal', code: 'MSP_ROOT', message: 'Root element is not a Microsoft Project <Project> (MSPDI).', p6: 'P6 rejects the file: not a Microsoft Project XML file.' });
    return { db: empty, findings };
  }
  try {
    const m = reader.finish(p);
    if (!m.tasks.length) findings.push({ severity: 'warning', code: 'MSP_NO_TASKS', message: 'The Microsoft Project file contains no tasks.', p6: 'P6 imports an empty project.' });
    const db = projectToDb(m, findings, 'The Microsoft Project XML file');
    snapshotKept(db);
    // Baseline and Baseline1-10: saved baselines of the project (after the snapshot: they are not edits of the file)
    const bl = importMspBaselines(db, src);
    if (bl.length) findings.push({ severity: 'info', code: 'MSP_BASELINES', message: `${bl.length} baseline(s) read: ${bl.join(', ')}.`, p6: 'P6 imports Microsoft Project baselines only through its own conversion; the clone keeps each as a saved baseline.' });
    return { db, findings };
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'MSP_READ', message: `Could not read the Microsoft Project XML file: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
}

/** The project read element by element: the project's own fields, its custom fields and its calendars when the first
 *  task, resource or assignment arrives (Microsoft Project writes them first), then each of those as it closes. */
function projectReader(findings: Finding[], src: string) {
  let doc: XNode | null = null, p: XNode | null = null, headDone = false;
  let minutesPerDay = 480;
  // every element is also kept as written, so what the model does not hold goes back into the file unchanged (keep.ts)
  const raw = (n: XNode) => src.slice(n.s, n.e);
  const kidsOf = (n: XNode): [string, string][] => n.children.map((c) => [c.name, raw(c)]);
  const ghosts: Ghosts = { tasks: [], resources: [], assignments: [], calendars: [] };
  const hrs = (s: string) => (s ? isoDurationHours(s, minutesPerDay) : null);
  const extKey = new Map<string, keyof P6Extra | 'rsrcType'>();
  let p6rules: { ver: string; legacy: boolean; known: boolean } | null = null;
  const calendars: MCal[] = [];
  const head = (p: XNode) => {
  headDone = true;
  minutesPerDay = num(val(p, 'MinutesPerDay')) || 480;
  // custom field aliases
  for (const e of kids(child(p, 'ExtendedAttributes'), 'ExtendedAttribute')) {
    const alias = val(e, 'Alias');
    const hit = TASK_TEXT.find((x) => x[3] === alias);
    const rules = /^P6 Schedule Rules (\S+)( legacy)?$/.exec(alias);
    if (rules) { p6rules = { ver: rules[1] === '?' ? '' : rules[1], legacy: !!rules[2], known: true }; continue; }
    if (hit) extKey.set(val(e, 'FieldID'), hit[0]);
    else if (alias === RES_TYPE_FIELD[2]) extKey.set(val(e, 'FieldID'), 'rsrcType');
  }

  // calendars
  for (const c of kids(child(p, 'Calendars'), 'Calendar')) {
    const uid = val(c, 'UID');
    if (!uid) continue;
    const isBase = flag(val(c, 'IsBaseCalendar'));
    const baseUid = val(c, 'BaseCalendarUID');
    const cal: MCal = { uid, name: val(c, 'Name') || `Calendar ${uid}`, isBase, baseUid: baseUid && baseUid !== '-1' ? baseUid : undefined, week: [null, null, null, null, null, null, null], exceptions: new Map() };
    const setRange = (from: string, to: string, ss: Shift[], every = 1) => {
      const a = parseP6Date(toP6Date(from)), b = parseP6Date(toP6Date(to) || toP6Date(from));
      if (a == null || b == null) return;
      const d0 = minutesToSerial(a), d1 = minutesToSerial(b);
      if (d1 - d0 > 20000) { findings.push({ severity: 'warning', code: 'MSP_CAL_RANGE', table: 'CALENDAR', key: uid, message: `Calendar ${cal.name}: exception ${from}..${to} is longer than 20000 days; truncated.`, p6: 'P6 stores exceptions day by day.' }); }
      for (let d = d0; d <= Math.min(d1, d0 + 20000); d += Math.max(1, every)) cal.exceptions.set(d, ss.map((s) => ({ ...s })));
    };
    for (const wd of kids(child(c, 'WeekDays'), 'WeekDay')) {
      const dt = Number(val(wd, 'DayType'));
      const ss = dayShifts(wd);
      if (dt >= 1 && dt <= 7) cal.week[dt - 1] = ss;
      else if (dt === 0) { const tp = child(wd, 'TimePeriod'); if (tp) setRange(val(tp, 'FromDate'), val(tp, 'ToDate'), ss); } // legacy exception
    }
    for (const ex of kids(child(c, 'Exceptions'), 'Exception')) {
      const tp = child(ex, 'TimePeriod');
      if (!tp) continue;
      const { days, known, long } = exceptionDays(ex);
      for (const [d, ss] of days) cal.exceptions.set(d, ss);
      if (long) findings.push({ severity: 'warning', code: 'MSP_CAL_RANGE', table: 'CALENDAR', key: uid, message: `Calendar ${cal.name}: exception ${val(tp, 'FromDate')}..${val(tp, 'ToDate')} is longer than 20000 days; truncated.`, p6: 'P6 stores exceptions day by day.' });
      if (!known) findings.push({ severity: 'warning', code: 'MSP_CAL_RECURRING', table: 'CALENDAR', key: uid, message: `Calendar ${cal.name}: recurring exception type ${val(ex, 'Type')} is not supported; only its first day was imported.`, p6: 'P6 stores exceptions day by day.' });
    }
    cal.keep = { kids: [], xml: raw(c), seq: calendars.length };
    calendars.push(cal);
  }
  };

  // tasks
  const tasks: MTask[] = [];
  const lagFormats = new Set<string>();
  let taskNo = 0;
  const task = (t: XNode) => {
    const i = taskNo++;
    const uid = val(t, 'UID');
    const seq = num(val(t, 'ID')) ?? i;
    // the project summary task (UID 0) and blank rows are not activities: kept as they are, in their place
    if (flag(val(t, 'IsNull')) || uid === '0' || val(t, 'OutlineLevel') === '0') { if (uid) ghosts.tasks.push({ seq, uid, xml: raw(t) }); return; }
    if (!uid) return;
    const m = emptyTask(uid, num(val(t, 'ID')) ?? tasks.length + 1);
    m.keep = { kids: kidsOf(t), xml: '', seq, id: val(t, 'ID') };
    const outline = val(t, 'OutlineNumber');
    m.name = val(t, 'Name');
    m.level = num(val(t, 'OutlineLevel')) ?? (outline ? outline.split('.').length : 1);
    m.outline = outline;
    m.wbs = val(t, 'WBS');
    m.summary = flag(val(t, 'Summary'));
    m.milestone = flag(val(t, 'Milestone'));
    m.type = num(val(t, 'Type'));
    m.durHrs = hrs(val(t, 'Duration'));
    m.remHrs = hrs(val(t, 'RemainingDuration'));
    m.actHrs = hrs(val(t, 'ActualDuration'));
    m.pct = num(val(t, 'PercentComplete'));
    m.start = toP6Date(val(t, 'Start'));
    m.finish = toP6Date(val(t, 'Finish'));
    m.earlyStart = toP6Date(val(t, 'EarlyStart'));
    m.earlyFinish = toP6Date(val(t, 'EarlyFinish'));
    m.lateStart = toP6Date(val(t, 'LateStart'));
    m.lateFinish = toP6Date(val(t, 'LateFinish'));
    m.actualStart = toP6Date(val(t, 'ActualStart'));
    m.actualFinish = toP6Date(val(t, 'ActualFinish'));
    m.constraintType = num(val(t, 'ConstraintType'));
    m.constraintDate = toP6Date(val(t, 'ConstraintDate'));
    m.deadline = toP6Date(val(t, 'Deadline'));
    const cu = val(t, 'CalendarUID');
    m.calUid = cu && cu !== '-1' ? cu : '';
    const ts = num(val(t, 'TotalSlack')), fs = num(val(t, 'FreeSlack'));
    m.totalSlackHrs = ts == null ? null : ts / 600;
    m.freeSlackHrs = fs == null ? null : fs / 600;
    m.critical = val(t, 'Critical') ? flag(val(t, 'Critical')) : null;
    for (const e of kids(t, 'ExtendedAttribute')) {
      const k = extKey.get(val(e, 'FieldID'));
      if (k && k !== 'rsrcType') m.extra[k] = val(e, 'Value');
    }
    m.links = [];
    for (const l of kids(t, 'PredecessorLink')) {
      m.links.push(null); // replaced below by the link read from it; null: a link the clone does not import
      const pu = val(l, 'PredecessorUID');
      if (!pu) continue;
      if (flag(val(l, 'CrossProject'))) { findings.push({ severity: 'warning', code: 'MSP_CROSS_PROJECT_LINK', table: 'TASKPRED', key: uid, message: `"${m.name}" has a cross-project predecessor (${val(l, 'CrossProjectName')}); link dropped.`, p6: 'P6 cannot resolve links to other MS Project files.' }); continue; }
      const type = (['FF', 'FS', 'SF', 'SS'] as RelType[])[num(val(l, 'Type')) ?? 1] ?? 'FS';
      const lag = num(val(l, 'LinkLag')) ?? 0;
      const fmt = num(val(l, 'LagFormat')) ?? 7;
      const base = fmt > 32 ? fmt - 32 : fmt; // 35.. = estimated variants
      const lagHrs = lag / 600; // tenths of minutes
      // Assumption (as MPXJ reads it): percentage lags store the plain percentage in LinkLag.
      if (base === 19 || base === 20) { lagFormats.add('percent'); m.preds.push({ uid: pu, type, lagHrs: 0, lagPct: lag }); m.links[m.links.length - 1] = m.preds[m.preds.length - 1]; continue; }
      if ([4, 6, 8, 10, 12].includes(base) && lag) lagFormats.add('elapsed');
      m.preds.push({ uid: pu, type, lagHrs });
      m.links[m.links.length - 1] = m.preds[m.preds.length - 1];
    }
    tasks.push(m);
  };

  // resources
  const resources: MRes[] = [];
  let resNo = 0;
  const resource = (r: XNode) => {
    const seq = resNo++;
    const uid = val(r, 'UID');
    const name = val(r, 'Name');
    if (flag(val(r, 'IsNull')) || !uid || (uid === '0' && !name)) { if (uid) ghosts.resources.push({ seq, uid, xml: raw(r) }); return; }
    const t = num(val(r, 'Type')) ?? 1;
    const cu = val(r, 'CalendarUID');
    let p6Type: string | undefined;
    for (const e of kids(r, 'ExtendedAttribute')) if (extKey.get(val(e, 'FieldID')) === 'rsrcType') p6Type = val(e, 'Value');
    const fmt = num(val(r, 'StandardRateFormat')) ?? 2;
    let rate = num(val(r, 'StandardRate'));
    // StandardRateFormat: 1 per minute, 2 hour, 3 day, 4 week, 5 month (8 h days assumed for day/week/month)
    if (rate != null && t !== 0) rate = fmt === 1 ? rate * 60 : fmt === 3 ? rate / (minutesPerDay / 60) : fmt === 4 ? rate / (minutesPerDay / 12) : fmt === 5 ? rate / (minutesPerDay / 3) : rate;
    resType?.set(uid, t === 0 ? 'material' : t === 2 ? 'cost' : 'work'); // (an assignment written before its resource)
    resources.push({ uid, id: num(val(r, 'ID')) ?? resources.length + 1, name, code: val(r, 'Code') || val(r, 'Initials'), type: t === 0 ? 'material' : t === 2 ? 'cost' : 'work', maxUnits: num(val(r, 'MaxUnits')), rate, calUid: cu && cu !== '-1' ? cu : '', p6Type, keep: { kids: kidsOf(r), xml: '', seq, id: val(r, 'ID') } });
  };

  // assignments
  let resType: Map<string, MRes['type']> | null = null;
  const assignments: MAssign[] = [];
  let asgNo = 0;
  const assignment = (a: XNode) => {
    const seq = asgNo++;
    resType ??= new Map(resources.map((r) => [r.uid, r.type]));
    const uid = val(a, 'UID');
    if (!uid) return;
    const ru = val(a, 'ResourceUID');
    const work = hrs(val(a, 'Work'));
    assignments.push({
      uid, taskUid: val(a, 'TaskUID'), resUid: ru, units: resType!.get(ru) === 'material' && work != null ? null : num(val(a, 'Units')),
      workHrs: work, actualWorkHrs: hrs(val(a, 'ActualWork')), remainingWorkHrs: hrs(val(a, 'RemainingWork')),
      cost: num(val(a, 'Cost')), actualCost: num(val(a, 'ActualCost')), remainingCost: num(val(a, 'RemainingCost')),
      start: toP6Date(val(a, 'Start')), finish: toP6Date(val(a, 'Finish')), actualStart: toP6Date(val(a, 'ActualStart')), actualFinish: toP6Date(val(a, 'ActualFinish')),
      keep: { kids: kidsOf(a), xml: raw(a), seq },
    });
  };

  const split = (parents: string[], name: string) => parents.length === 2 && parents[0] === 'Project' && ((parents[1] === 'Tasks' && name === 'Task') || (parents[1] === 'Resources' && name === 'Resource') || (parents[1] === 'Assignments' && name === 'Assignment'));
  const emit = (_parents: string[], n: XNode) => {
    if (!headDone) { p = doc?.children.find((c) => c.name === 'Project') ?? null; if (p) head(p); }
    if (n.name === 'Task') task(n); else if (n.name === 'Resource') resource(n); else assignment(n);
  };
  const finish = (p: XNode): MProject => {
  if (!headDone) head(p);
  tasks.sort((a, b) => a.id - b.id);
  // percentage lags: percent of the predecessor's duration
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  for (const t of tasks) for (const l of t.preds) if (l.lagPct != null) l.lagHrs = (l.lagPct / 100) * (byUid.get(l.uid)?.durHrs ?? 0);
  if (lagFormats.has('elapsed')) findings.push({ severity: 'info', code: 'MSP_ELAPSED_LAG', table: 'TASKPRED', message: 'Some links use elapsed lags; they were converted to working-hour lags.', p6: 'P6 has no elapsed lags; P6 converts them and counts lags on the scheduling option\'s lag calendar.' });
  if (lagFormats.has('percent')) findings.push({ severity: 'info', code: 'MSP_PERCENT_LAG', table: 'TASKPRED', message: 'Some links use percentage lags; they were converted to hours of the predecessor\'s duration.', p6: 'P6 has no percentage lags.' });

  const sip = val(p, 'SplitsInProgressTasks');
  return {
    name: val(p, 'Name'), title: val(p, 'Title'), start: toP6Date(val(p, 'StartDate')), finish: toP6Date(val(p, 'FinishDate')),
    statusDate: toP6Date(val(p, 'StatusDate')), calUid: val(p, 'CalendarUID'), minutesPerDay, minutesPerWeek: num(val(p, 'MinutesPerWeek')) || minutesPerDay * 5,
    splitsInProgress: sip ? flag(sip) : null, criticalHrs: (num(val(p, 'CriticalSlackLimit')) ?? 0) * (minutesPerDay / 60),
    calendars, tasks, resources, assignments,
    keep: { kids: p.children.map((c): [string, string | null] => [c.name, COLLECTIONS.has(c.name) ? null : raw(c)]), ghosts, p6ext: extKey.size > 0 },
    // dates made by P6 (a file the clone wrote from P6): F9 keeps P6's rules; dates made by Microsoft Project: its rule
    // for started tasks, unless the file moves remaining work after the status date (then it is P6's rule too)
    // (a file the clone wrote before it named the rules: P6 5-7 builds leave dates one minute into or before a period)
    rules: p6rules ?? (extKey.size > 0 ? { ver: '', legacy: tasks.some((t) => [t.earlyStart, t.earlyFinish, t.lateStart, t.lateFinish].some((d) => /:(01|59)$/.test(d))), known: true } : { resume: val(p, 'MoveRemainingStartsForward') !== '1' && val(p, 'MoveRemainingStartsForward').toLowerCase() !== 'true' }),
  };
  };
  return { split, emit, finish, onRoot: (r: XNode) => { doc = r; } };
}

// ---------- writer

/** A link read from the file whose type or lag an edit changed: the same element with the new type and lag, in its own
 *  lag format (a percentage lag stays a percentage of the predecessor's duration). */
function relink(xml: string, l: MPred, predHrs: number): string {
  const fmt = Number(/<LagFormat>\s*(\d+)/.exec(xml)?.[1] ?? 7), base = fmt > 32 ? fmt - 32 : fmt;
  const lag = base === 19 || base === 20 ? Math.round(predHrs > 0 ? (l.lagHrs / predHrs) * 100 : 0) : Math.round(l.lagHrs * 600);
  let x = xml.replace(/<Type>[^<]*<\/Type>/, `<Type>${['FF', 'FS', 'SF', 'SS'].indexOf(l.type)}</Type>`);
  x = /<LinkLag>/.test(x) ? x.replace(/<LinkLag>[^<]*<\/LinkLag>/, `<LinkLag>${lag}</LinkLag>`) : x.replace(/<\/Type>/, `</Type><LinkLag>${lag}</LinkLag>`);
  return x;
}

const times = (ss: Shift[]) => (ss.length ? `<WorkingTimes>${ss.map((s) => `<WorkingTime><FromTime>${hms(s.start)}</FromTime><ToTime>${hms(s.end)}</ToTime></WorkingTime>`).join('')}</WorkingTimes>` : '');
const day10 = (d: number) => formatP6Date(serialToMinutes(d)).slice(0, 10);
const exceptionXml = (from: number, to: number, ss: Shift[], name: string) => `<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${day10(from)}T00:00:00</FromDate><ToDate>${day10(to)}T23:59:00</ToDate></TimePeriod><Occurrences>${to - from + 1}</Occurrences><Name>${esc(name)}</Name><Type>1</Type><DayWorking>${ss.length ? 1 : 0}</DayWorking>${times(ss)}</Exception>`;
/** Days (with the same hours and name) as exception ranges. */
function exceptionRanges(days: [number, Shift[], string][]): string {
  const out: string[] = [];
  const sorted = [...days].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[j][0] + 1 && JSON.stringify(sorted[j + 1][1]) === JSON.stringify(sorted[i][1]) && sorted[j + 1][2] === sorted[i][2]) j++;
    out.push(exceptionXml(sorted[i][0], sorted[j][0], sorted[i][1], sorted[i][2]));
    i = j + 1;
  }
  return out.join('');
}

/**
 * An edited calendar written back: the element as the file had it (UID, GUID, base calendar, work weeks, exceptions
 * with their names and recurrences), with only what changed written anew: the week days whose hours changed, and the
 * exceptions on days whose hours changed (an exception that covers a changed day goes on for its other days, under
 * its own name, as day ranges).
 */
function patchCalendar(xml: string, before: CalendarDef, after: CalendarDef, name: string | null, baseUid: string | null): string {
  const cal = parseXml(xml).children[0];
  const raw = (n: XNode) => xml.slice(n.s, n.e);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const days = [0, 1, 2, 3, 4, 5, 6].filter((i) => !same(before.week[i], after.week[i]));
  const exDays = new Set([...before.exceptions.keys(), ...after.exceptions.keys()].filter((d) => !same(before.exceptions.get(d), after.exceptions.get(d))));
  const dayXml = (i: number) => `<WeekDay><DayType>${i + 1}</DayType><DayWorking>${after.week[i].length ? 1 : 0}</DayWorking>${times(after.week[i])}</WeekDay>`;
  const weekXml = (n?: XNode) => {
    const seen = new Set<number>(), o: string[] = [];
    for (const wd of n?.children ?? []) { const dt = Number(val(wd, 'DayType')); seen.add(dt); o.push(dt >= 1 && dt <= 7 && days.includes(dt - 1) ? dayXml(dt - 1) : raw(wd)); }
    for (const i of days) if (!seen.has(i + 1)) o.push(dayXml(i));
    return `<WeekDays>${o.join('')}</WeekDays>`;
  };
  const exXml = (n?: XNode) => {
    const o: string[] = [], nameOf = new Map<number, string>();
    for (const ex of n?.children ?? []) {
      const covers = exceptionDays(ex).days;
      if (![...covers.keys()].some((d) => exDays.has(d))) { o.push(raw(ex)); continue; }
      const nm = val(ex, 'Name');
      for (const d of covers.keys()) nameOf.set(d, nm);
      o.push(exceptionRanges([...covers].filter(([d]) => !exDays.has(d)).map(([d, ss]) => [d, ss, nm])));
    }
    o.push(exceptionRanges([...exDays].filter((d) => after.exceptions.has(d)).map((d) => { const ss = after.exceptions.get(d)!; return [d, ss, nameOf.get(d) || (ss.length ? 'Working exception' : 'Nonworking')]; })));
    return `<Exceptions>${o.join('')}</Exceptions>`;
  };
  const out: string[] = [];
  let week = false, exc = false;
  for (const c of cal.children) {
    if (c.name === 'Name' && name != null) out.push(`<Name>${esc(name)}</Name>`);
    else if (c.name === 'BaseCalendarUID' && baseUid != null) out.push(`<BaseCalendarUID>${esc(baseUid)}</BaseCalendarUID>`);
    else if (c.name === 'WeekDays' && days.length) { week = true; out.push(weekXml(c)); }
    else if (c.name === 'Exceptions' && exDays.size) { exc = true; out.push(exXml(c)); }
    else out.push(raw(c));
    // the file had none: they go where Microsoft Project writes them
    if (c.name === 'BaseCalendarUID' && days.length && !cal.children.some((x) => x.name === 'WeekDays')) { week = true; out.push(weekXml()); }
    if ((c.name === 'WeekDays' || (c.name === 'BaseCalendarUID' && !cal.children.some((x) => x.name === 'WeekDays'))) && exDays.size && !cal.children.some((x) => x.name === 'Exceptions')) { exc = true; out.push(exXml()); }
  }
  if (days.length && !week) out.push(weekXml());
  if (exDays.size && !exc) out.push(exXml());
  return `<Calendar>${out.join('')}</Calendar>`;
}

/** report: what the save did that the caller should know (e.g. WBS codes that follow the outline). */
export function writeMspdi(db: Db, opts: { projIds?: string[]; report?: string[] } = {}): string {
  const parts: string[] = [];
  writeMspdiTo(db, opts, (piece) => parts.push(piece));
  return parts.join('');
}

/** The MSPDI file in pieces, in order, to `put` (a file of any size is never one string): the four collections
 *  (calendars, tasks, resources, assignments) are kept as their elements' pieces and stand in the project's own
 *  element list as a marker until they are written. */
export function writeMspdiTo(db: Db, opts: { projIds?: string[]; report?: string[] }, put: (piece: string) => void): void {
  const sections: string[][] = [];
  const section = (pieces: string[]) => { sections.push(pieces); return `\u0001P6C-SECTION:${sections.length - 1}\u0001`; };
  const m = projectFromDb(db, opts.projIds);
  const blNumbers = m.row ? baselineNumbers(db, m.row) : new Map<number, string>();
  // each element's children are collected as [name, xml] pairs, so a project read from MSPDI can be merged back
  // into what the file had (keep.ts): unchanged elements go out as they came in
  let cur: [string, string][] = [];
  const el = (tag: string, v: string | number | null | undefined) => { if (v != null && v !== '') cur.push([tag, `<${tag}>${esc(String(v))}</${tag}>`]); };
  const dt = (tag: string, s: string) => el(tag, xmlDate(s));
  const b = (x: boolean) => (x ? 1 : 0);
  const now = formatP6Date(Math.floor(Date.now() / 60000));
  const k = keepCtx(db);
  const fromMsp = !!m.keep;
  // the clone's own custom fields (P6 Activity ID, ...) go into a Microsoft Project file only when it has them: in a
  // customer's file, Text1 may be their own field
  const p6ext = !fromMsp || m.keep!.p6ext;
  const ourField = new Set([...TASK_TEXT.map((x) => x[1]), RES_TYPE_FIELD[0]]);
  const notOurs = (n: string, x: string) => n === 'ExtendedAttribute' && !ourField.has(/<FieldID>\s*(\d+)\s*<\/FieldID>/.exec(x)?.[1] ?? '');
  const P6_FIELDS = ['task_code', 'task_type', 'cstr_type', 'cstr_date', 'cstr_type2', 'cstr_date2', 'duration_type'];
  /** An element: the file's own merged with the clone's (kept), else the clone's. */
  const element = (name: string, kept: Kept | undefined, row: Row | undefined, table: string, deps: Parameters<typeof mergeKids>[2], keepAlso?: (n: string, x: string) => boolean) =>
    `<${name}>${kept && row ? mergeKids(kept.kids, cur, deps, changedSince(table, row, k), ORDER[name], keepAlso) : cur.map((c) => c[1]).join('')}</${name}>`;
  /** Elements that are not rows (keep.ts Ghost) go back among the others where they were in the file: before the
   *  first kept element that came after them. The others keep their order (for tasks, the outline's). */
  const withGhosts = (items: { seq?: number; xml: () => string }[], ghosts: { seq: number; xml: string }[]): string[] => {
    const g = [...ghosts].sort((x, y) => x.seq - y.seq), out: string[] = [];
    let i = 0;
    for (const it of items) { if (it.seq != null) while (i < g.length && g[i].seq < it.seq) out.push(g[i++].xml); out.push(it.xml()); }
    while (i < g.length) out.push(g[i++].xml);
    return out;
  };
  const seqOf = (x: { keep?: Kept }, _i: number) => x.keep?.seq;
  const ghosts = m.keep?.ghosts ?? { tasks: [], resources: [], assignments: [], calendars: [] };
  // kept elements that point at a task may only come back if that task is still written
  const taskUids = new Set([...m.tasks.map((t) => t.uid), ...ghosts.tasks.map((g) => g.uid)]);
  const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
  const masked = /<WBSMask>/.test(m.keep?.kids.find((x) => x[0] === 'WBSMasks')?.[1] ?? '');
  const followed: string[] = [];
  const durOf = new Map(m.tasks.map((t) => [t.uid, t.durHrs ?? 0]));

  const proj: [string, string][] = [];
  cur = proj;
  el('SaveVersion', 14);
  el('Name', m.name);
  el('Title', m.title);
  el('Author', 'Primavera P6 Clone');
  dt('CreationDate', now);
  dt('LastSaved', now);
  el('ScheduleFromStart', 1);
  dt('StartDate', m.start);
  dt('FinishDate', m.finish || m.start);
  el('CriticalSlackLimit', Math.round((m.criticalHrs / (m.minutesPerDay / 60)) || 0));
  el('CalendarUID', m.calUid);
  el('DefaultStartTime', '08:00:00');
  el('DefaultFinishTime', '17:00:00');
  el('MinutesPerDay', m.minutesPerDay);
  el('MinutesPerWeek', m.minutesPerWeek);
  el('DaysPerMonth', 20);
  el('DefaultTaskType', 1);
  el('DurationFormat', 7);
  el('WorkFormat', 2);
  el('HonorConstraints', 1);
  el('MultipleCriticalPaths', 0);
  el('NewTasksEffortDriven', 0);
  el('NewTasksEstimated', 0);
  el('SplitsInProgressTasks', b(m.splitsInProgress ?? true));
  el('WeekStartDay', 1);
  dt('StatusDate', m.statusDate);
  el('NewTaskStartDate', 0);
  const pr = m.row ?? {};
  const rules = `<ExtendedAttribute><FieldID>${RULES_FIELD[0]}</FieldID><FieldName>${RULES_FIELD[1]}</FieldName><Alias>${esc(rulesAlias(pr._p6_ver || db.header?.version || '', pr._legacy_ms ? pr._legacy_ms === 'Y' : isLegacyLayout(db)))}</Alias></ExtendedAttribute>`;
  if (p6ext) proj.push(['ExtendedAttributes', `<ExtendedAttributes>${TASK_TEXT.map(([, id, name, alias]) => `<ExtendedAttribute><FieldID>${id}</FieldID><FieldName>${name}</FieldName><Alias>${alias}</Alias></ExtendedAttribute>`).join('')}<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><FieldName>${RES_TYPE_FIELD[1]}</FieldName><Alias>${RES_TYPE_FIELD[2]}</Alias></ExtendedAttribute>${fromMsp ? '' : rules}</ExtendedAttributes>`]);

  // Calendars: base calendars, then one resource calendar per work resource (MS Project requires it). A calendar read
  // from the file and not changed since goes back as it was (derived calendars and resource calendars included).
  const uidOfCal = new Map(m.calendars.filter((c) => c.row).map((c) => [c.row!.clndr_id, c.uid]));
  // a resource read from the file whose calendar changed keeps its own resource calendar: that calendar now derives
  // from the new one (resource calendars are per resource in Microsoft Project)
  const ownCal = (r: MProject['resources'][number]) => r.keep?.kids.find((x) => x[0] === 'CalendarUID')?.[1].replace(/<[^>]+>/g, '').trim();
  const resCals = new Set([...ghosts.calendars.map((g) => g.uid), ...m.calendars.filter((c) => c.row?.clndr_type === 'CA_Rsrc').map((c) => c.uid)]);
  const rebased = new Map<string, string>(), reusedCal = new Set<string>();
  for (const r of m.resources) {
    if (!r.keep || !r.row || !changedSince('RSRC', r.row, k)(['clndr_id'])) continue;
    const own = ownCal(r);
    if (own && resCals.has(own) && own !== r.calUid) { rebased.set(own, r.calUid || m.calUid); reusedCal.add(r.uid); }
  }
  const rebase = (uid: string, xml: string) => (rebased.has(uid) ? xml.replace(/<BaseCalendarUID>[^<]*<\/BaseCalendarUID>/, `<BaseCalendarUID>${esc(rebased.get(uid)!)}</BaseCalendarUID>`) : xml);
  const calXml = (c: MProject['calendars'][number]) => rebase(c.uid, calXml0(c));
  const calXml0 = (c: MProject['calendars'][number]) => {
    if (c.keep?.xml && c.row) {
      const ch = changedSince('CALENDAR', c.row, k);
      if (!ch(['clndr_name', 'clndr_data', 'base_clndr_id'])) return c.keep.xml;
      // edited: the calendar as the file had it, with only what changed written anew
      const before = JSON.parse(c.row._msp_snap) as Record<string, string>;
      return patchCalendar(c.keep.xml, parseClndrData(before.clndr_data ?? ''), parseClndrData(c.row.clndr_data ?? ''), ch(['clndr_name']) ? c.row.clndr_name : null,
        ch(['base_clndr_id']) ? (c.row.base_clndr_id ? uidOfCal.get(c.row.base_clndr_id) ?? '-1' : '-1') : null);
    }
    const o: string[] = [`<Calendar><UID>${esc(c.uid)}</UID><Name>${esc(c.name)}</Name><IsBaseCalendar>1</IsBaseCalendar><IsBaselineCalendar>0</IsBaselineCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>`];
    c.week.forEach((ss, i) => o.push(`<WeekDay><DayType>${i + 1}</DayType><DayWorking>${ss && ss.length ? 1 : 0}</DayWorking>${times(ss ?? [])}</WeekDay>`));
    o.push('</WeekDays>');
    // consecutive days with identical hours become one exception range
    const days = [...c.exceptions.entries()].sort((x, y) => x[0] - y[0]);
    const ranges: { from: number; to: number; ss: Shift[] }[] = [];
    for (const [d, ss] of days) {
      const last = ranges[ranges.length - 1];
      if (last && last.to === d - 1 && JSON.stringify(last.ss) === JSON.stringify(ss)) last.to = d;
      else ranges.push({ from: d, to: d, ss });
    }
    if (ranges.length) {
      o.push('<Exceptions>');
      for (const r of ranges) {
        const from = formatP6Date(serialToMinutes(r.from)).slice(0, 10), to = formatP6Date(serialToMinutes(r.to)).slice(0, 10);
        o.push(`<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${from}T00:00:00</FromDate><ToDate>${to}T23:59:00</ToDate></TimePeriod><Occurrences>${r.to - r.from + 1}</Occurrences><Name>${r.ss.length ? 'Working exception' : 'Nonworking'}</Name><Type>1</Type><DayWorking>${r.ss.length ? 1 : 0}</DayWorking>${times(r.ss)}</Exception>`);
      }
      o.push('</Exceptions>');
    }
    o.push('</Calendar>');
    return o.join('');
  };
  // calendars in the file's order (kept ones by their place; new ones after)
  const calOrder = m.calendars.map((c, i) => ({ c, i })).sort((x, y) => (x.c.keep?.seq ?? 1e9 + x.i) - (y.c.keep?.seq ?? 1e9 + y.i)).map((x) => x.c);
  const cals = withGhosts(calOrder.map((c, i) => ({ seq: seqOf(c, i), xml: () => calXml(c) })), ghosts.calendars.map((g) => ({ ...g, xml: rebase(g.uid, g.xml) })));
  let calUid = [...m.calendars.map((c) => c.uid), ...ghosts.calendars.map((g) => g.uid)].reduce((x, u) => Math.max(x, Number(u) || 0), 0);
  const resCal = new Map<string, number>();
  for (const r of m.resources) {
    // a resource read from the file keeps its own resource calendar while its calendar did not change
    if (r.type !== 'work' || reusedCal.has(r.uid) || (r.keep && r.row && !changedSince('RSRC', r.row, k)(['clndr_id']))) continue;
    resCal.set(r.uid, ++calUid);
    cals.push(`<Calendar><UID>${calUid}</UID><Name>${esc(r.name)}</Name><IsBaseCalendar>0</IsBaseCalendar><IsBaselineCalendar>0</IsBaselineCalendar><BaseCalendarUID>${esc(r.calUid || m.calUid)}</BaseCalendarUID></Calendar>`);
  }
  proj.push(['Calendars', section(['<Calendars>', ...cals, '</Calendars>'])]);

  const taskXml = (t: MProject['tasks'][number]) => {
    cur = [];
    el('UID', t.uid);
    el('ID', t.id);
    el('Name', t.name);
    el('Type', t.type ?? 1);
    el('IsNull', 0);
    if (t.summary) el('WBS', t.wbs);
    el('OutlineNumber', t.outline);
    el('OutlineLevel', t.level);
    el('Priority', 500);
    dt('Start', t.start);
    dt('Finish', t.finish);
    el('Duration', hoursToIso(t.summary ? 0 : t.durHrs ?? 0));
    el('DurationFormat', 7);
    el('EffortDriven', 0);
    el('Estimated', 0);
    el('Milestone', b(t.milestone));
    el('Summary', b(t.summary));
    if (!t.summary) {
      if (t.critical != null) el('Critical', b(t.critical));
      dt('EarlyStart', t.earlyStart);
      dt('EarlyFinish', t.earlyFinish);
      dt('LateStart', t.lateStart);
      dt('LateFinish', t.lateFinish);
      if (t.freeSlackHrs != null) el('FreeSlack', Math.round(t.freeSlackHrs * 600));
      if (t.totalSlackHrs != null) el('TotalSlack', Math.round(t.totalSlackHrs * 600));
      el('PercentComplete', t.pct ?? 0);
      dt('ActualStart', t.actualStart);
      dt('ActualFinish', t.actualFinish);
      el('RemainingDuration', hoursToIso(t.remHrs ?? t.durHrs ?? 0));
      el('ConstraintType', t.constraintType ?? 0);
      el('CalendarUID', t.calUid || -1);
      if (t.constraintType && t.constraintType > 1) dt('ConstraintDate', t.constraintDate);
      dt('Deadline', t.deadline);
      el('IgnoreResourceCalendar', b(t.ignoreRsrcCal ?? true));
      const ourLink = (l: MPred) => `<PredecessorLink><PredecessorUID>${esc(l.uid)}</PredecessorUID><Type>${['FF', 'FS', 'SF', 'SS'].indexOf(l.type)}</Type><CrossProject>0</CrossProject><LinkLag>${Math.round(l.lagHrs * 600)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`;
      if (t.keep && t.row?._msp_links) {
        // a task read from the file: each link as it was written unless an edit changed it (then only its type and
        // lag, in its own lag format); removed links go, added ones follow; links the clone does not read stay
        const keys = JSON.parse(t.row._msp_links) as string[], now = new Map(t.preds.map((l) => [l.uid, l])), done = new Set<string>();
        t.keep.kids.filter((x) => x[0] === 'PredecessorLink').forEach(([, x], i) => {
          const key = keys[i];
          if (!key) { const pu = tag(x, 'PredecessorUID'); if (tag(x, 'CrossProject') === '1' || !pu || taskUids.has(pu)) cur.push(['PredecessorLink', x]); return; }
          const uid = key.slice(0, key.indexOf(':')), l = now.get(uid);
          if (!l || done.has(uid)) return;
          done.add(uid);
          cur.push(['PredecessorLink', linkKey(uid, `PR_${l.type}`, p6num(l.lagHrs)) === key ? x : relink(x, l, durOf.get(uid) ?? 0)]);
        });
        for (const l of t.preds) if (!done.has(l.uid)) cur.push(['PredecessorLink', ourLink(l)]);
      } else for (const l of t.preds) cur.push(['PredecessorLink', ourLink(l)]);
      if (p6ext) for (const [key, id] of TASK_TEXT) { const v = t.extra[key]; if (v) cur.push(['ExtendedAttribute', `<ExtendedAttribute><FieldID>${id}</FieldID><Value>${esc(v)}</Value></ExtendedAttribute>`]); }
    } else {
      el('CalendarUID', -1);
    }
    if (t.summary) return element('Task', t.keep, t.row, 'PROJWBS', SUMMARY_DEPS);
    // a leaf's WBS code: with a WBS code mask it is the task's own code, kept when the task moves (as in Project); without
    // one, Project's WBS is the outline number, so a moved task's code follows its new place
    const outlineWas = t.keep?.kids.find((x) => x[0] === 'OutlineNumber')?.[1].replace(/<[^>]+>/g, '').trim();
    const moved = !!t.keep && outlineWas !== t.outline && t.keep.kids.some((x) => x[0] === 'WBS');
    if (moved && !masked) { cur.push(['WBS', `<WBS>${esc(t.outline)}</WBS>`]); followed.push(`${t.extra.activityId ?? t.name} (UID ${t.uid}) ${outlineWas} -> ${t.outline}`); }
    // finished in the file and still: its early and late dates stay Project's (F9 puts P6's at the data date); started
    // in a Microsoft Project file: its early and late start are its actual start in Project's terms
    const ch = t.row ? changedSince('TASK', t.row, k) : () => true;
    const finished = !!t.row?.act_end_date && !ch(['act_end_date']);
    const started = !finished && m.row?._msp_resume === 'Y' && !!t.row?.act_start_date;
    const never = () => false;
    const datesDeps: Parameters<typeof mergeKids>[2] = finished ? { EarlyStart: never, EarlyFinish: never, LateStart: never, LateFinish: never, TotalSlack: never, FreeSlack: never, Critical: never } : started ? { EarlyStart: ['act_start_date'], LateStart: ['act_start_date'] } : {};
    if (started) for (const c of cur) if (c[0] === 'EarlyStart' || c[0] === 'LateStart') c[1] = `<${c[0]}>${xmlDate(t.actualStart)}</${c[0]}>`;
    // the clone's saved baselines, unless the file's own <Baseline> elements are kept for this task
    if (t.row && blNumbers.size && !t.keep?.kids.some((x) => x[0] === 'Baseline')) for (const x of baselineXml(db, blNumbers, t.row, xmlDate)) cur.push(['Baseline', x]);
    return element('Task', t.keep, t.row, 'TASK', { ...TASK_DEPS, ...datesDeps, WBS: () => moved && !masked, ExtendedAttribute: p6ext ? P6_FIELDS : () => false }, notOurs);
  };
  // Microsoft Project's ID is the row number: after the outline and the kept rows are in place, rows are numbered in
  // order (the project summary task stays 0), so a task added or moved renumbers the rows after it, as in Project
  const rowsInOrder: ({ t: MProject['tasks'][number] } | { g: { seq: number; uid: string; xml: string } })[] = [];
  { const g = [...ghosts.tasks].sort((x, y) => x.seq - y.seq); let i = 0;
    for (const t of m.tasks) { if (t.keep) while (i < g.length && g[i].seq < t.keep.seq) rowsInOrder.push({ g: g[i++] }); rowsInOrder.push({ t }); }
    while (i < g.length) rowsInOrder.push({ g: g[i++] }); }
  let rowNo = 0;
  const taskRows = rowsInOrder.map((e) => {
    if ('t' in e) { e.t.id = ++rowNo; return taskXml(e.t); }
    if (e.g.uid === '0') return e.g.xml;
    const id = ++rowNo;
    return e.g.xml.replace(/<ID>\s*\d+\s*<\/ID>/, `<ID>${id}</ID>`);
  });
  taskRows.unshift('<Tasks>'); taskRows.push('</Tasks>');
  proj.push(['Tasks', section(taskRows)]);

  const resXml = (r: MProject['resources'][number]) => {
    cur = [];
    el('UID', r.uid);
    el('ID', r.id);
    el('Name', r.name);
    el('Type', r.type === 'material' ? 0 : r.type === 'cost' ? 2 : 1);
    el('IsNull', 0);
    el('Code', r.code);
    if (r.type !== 'material') el('MaxUnits', p6num(r.maxUnits ?? 1));
    el('StandardRate', p6num(r.rate ?? 0));
    el('StandardRateFormat', 2);
    el('OvertimeRate', 0);
    el('OvertimeRateFormat', 2);
    el('CalendarUID', resCal.get(r.uid));
    if (r.p6Type && p6ext) cur.push(['ExtendedAttribute', `<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><Value>${esc(r.p6Type)}</Value></ExtendedAttribute>`]);
    return element('Resource', r.keep, r.row, 'RSRC', { ...RES_DEPS, ...(reusedCal.has(r.uid) ? { CalendarUID: () => false } : {}), ExtendedAttribute: p6ext ? ['rsrc_type'] : () => false }, notOurs);
  };
  { const r = withGhosts(m.resources.map((r, i) => ({ seq: seqOf(r, i), xml: () => resXml(r) })), ghosts.resources); r.unshift('<Resources>'); r.push('</Resources>'); proj.push(['Resources', section(r)]); }

  const asgXml = (a: MProject['assignments'][number]) => {
    cur = [];
    el('UID', a.uid);
    el('TaskUID', a.taskUid);
    el('ResourceUID', a.resUid);
    if (a.actualCost != null) el('ActualCost', p6num(a.actualCost));
    dt('ActualFinish', a.actualFinish);
    dt('ActualStart', a.actualStart);
    if (a.actualWorkHrs != null) el('ActualWork', hoursToIso(a.actualWorkHrs));
    if (a.cost != null) el('Cost', p6num(a.cost));
    dt('Finish', a.finish);
    if (a.remainingCost != null) el('RemainingCost', p6num(a.remainingCost));
    if (a.remainingWorkHrs != null) el('RemainingWork', hoursToIso(a.remainingWorkHrs));
    dt('Start', a.start);
    if (a.units != null) el('Units', p6num(a.units));
    if (a.workHrs != null) el('Work', hoursToIso(a.workHrs));
    return element('Assignment', a.keep, a.row, 'TASKRSRC', ASG_DEPS);
  };
  // a kept assignment goes with its task; a task's "unassigned" placeholder (resource -65535) goes once an edit assigns
  // a resource to it (Microsoft Project keeps the placeholder only while a task has no resource)
  const assigned = new Set(m.assignments.filter((a) => !a.keep).map((a) => a.taskUid));
  const keptAsg = ghosts.assignments.filter((g) => { const tu = tag(g.xml, 'TaskUID'); return !tu || (taskUids.has(tu) && !(tag(g.xml, 'ResourceUID') === '-65535' && assigned.has(tu))); });
  { const r = withGhosts(m.assignments.map((a, i) => ({ seq: seqOf(a, i), xml: () => asgXml(a) })), keptAsg); r.unshift('<Assignments>'); r.push('</Assignments>'); proj.push(['Assignments', section(r)]); }

  if (followed.length) opts.report?.push(`This file has no WBS code mask, so Microsoft Project's WBS code is the outline number: the WBS of ${followed.length} moved task(s) follows the new place: ${followed.slice(0, 20).join('; ')}.`);
  const body = m.keep && m.row ? mergeKids(m.keep.kids, proj, PROJECT_DEPS, changedSince('PROJECT', m.row, k), ORDER.Project) : proj.map((x) => x[1]).join('\n');
  put(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Project xmlns="${MSPDI_NS}">\n`);
  // the project's elements, each collection's pieces where its marker stands (each written once, then let go)
  const re = /\u0001P6C-SECTION:(\d+)\u0001/g;
  let at = 0;
  for (let mm = re.exec(body); mm; mm = re.exec(body)) {
    if (mm.index > at) put(body.slice(at, mm.index));
    const i = Number(mm[1]), pieces = sections[i];
    sections[i] = [];
    for (let j = 0; j < pieces.length; j++) put(pieces[j]);
    at = mm.index + mm[0].length;
  }
  if (at < body.length) put(body.slice(at));
  put('\n</Project>\n');
}
