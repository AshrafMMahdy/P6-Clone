// Microsoft Project XML (MSPDI, namespace http://schemas.microsoft.com/project) import/export.
// Elements are written in the order of the MSPDI schema (mspdi_pj12.xsd), which Microsoft Project enforces.
import type { Db, Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import type { Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../dates.ts';
import { parseXml, type XNode } from '../xml/p6xml.ts';
import { p6num } from '../schedule/cpm.ts';
import { ASG_DEPS, COLLECTIONS, ORDER, PROJECT_DEPS, RES_DEPS, SUMMARY_DEPS, TASK_DEPS, changedSince, keepCtx, mergeKids, snapshotKept, type Ghosts, type Kept } from './keep.ts';
import { defaultShifts, emptyTask, num, projectFromDb, projectToDb, toP6Date, type MAssign, type MCal, type MProject, type MRes, type MTask, type P6Extra, type RelType } from './shared.ts';

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

// ---------- parser

export function parseMspdi(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const empty: Db = { tables: {} };
  let root: XNode;
  const src = text.replace(/^﻿/, '');
  try {
    root = parseXml(src);
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
    const m = readProject(p, findings, src);
    if (!m.tasks.length) findings.push({ severity: 'warning', code: 'MSP_NO_TASKS', message: 'The Microsoft Project file contains no tasks.', p6: 'P6 imports an empty project.' });
    const db = projectToDb(m, findings, 'The Microsoft Project XML file');
    snapshotKept(db);
    return { db, findings };
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'MSP_READ', message: `Could not read the Microsoft Project XML file: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
}

function readProject(p: XNode, findings: Finding[], src: string): MProject {
  const minutesPerDay = num(val(p, 'MinutesPerDay')) || 480;
  // every element is also kept as written, so what the model does not hold goes back into the file unchanged (keep.ts)
  const raw = (n: XNode) => src.slice(n.s, n.e);
  const kidsOf = (n: XNode): [string, string][] => n.children.map((c) => [c.name, raw(c)]);
  const ghosts: Ghosts = { tasks: [], resources: [], assignments: [], calendars: [] };
  const hrs = (s: string) => (s ? isoDurationHours(s, minutesPerDay) : null);

  // custom field aliases
  const extKey = new Map<string, keyof P6Extra | 'rsrcType'>();
  for (const e of kids(child(p, 'ExtendedAttributes'), 'ExtendedAttribute')) {
    const alias = val(e, 'Alias');
    const hit = TASK_TEXT.find((x) => x[3] === alias);
    if (hit) extKey.set(val(e, 'FieldID'), hit[0]);
    else if (alias === RES_TYPE_FIELD[2]) extKey.set(val(e, 'FieldID'), 'rsrcType');
  }

  // calendars
  const calendars: MCal[] = [];
  for (const c of kids(child(p, 'Calendars'), 'Calendar')) {
    const uid = val(c, 'UID');
    if (!uid) continue;
    const isBase = flag(val(c, 'IsBaseCalendar'));
    const baseUid = val(c, 'BaseCalendarUID');
    const cal: MCal = { uid, name: val(c, 'Name') || `Calendar ${uid}`, isBase, baseUid: baseUid && baseUid !== '-1' ? baseUid : undefined, week: [null, null, null, null, null, null, null], exceptions: new Map() };
    const shifts = (n: XNode | undefined): Shift[] => kids(child(n ?? { name: '', children: [], text: '' }, 'WorkingTimes'), 'WorkingTime')
      .map((w) => ({ start: parseTime(val(w, 'FromTime'), false), end: parseTime(val(w, 'ToTime'), true) }))
      .filter((s): s is Shift => s.start != null && s.end != null && s.end > s.start).sort((a, b) => a.start - b.start);
    const setRange = (from: string, to: string, ss: Shift[], every = 1) => {
      const a = parseP6Date(toP6Date(from)), b = parseP6Date(toP6Date(to) || toP6Date(from));
      if (a == null || b == null) return;
      const d0 = minutesToSerial(a), d1 = minutesToSerial(b);
      if (d1 - d0 > 20000) { findings.push({ severity: 'warning', code: 'MSP_CAL_RANGE', table: 'CALENDAR', key: uid, message: `Calendar ${cal.name}: exception ${from}..${to} is longer than 20000 days; truncated.`, p6: 'P6 stores exceptions day by day.' }); }
      for (let d = d0; d <= Math.min(d1, d0 + 20000); d += Math.max(1, every)) cal.exceptions.set(d, ss.map((s) => ({ ...s })));
    };
    for (const wd of kids(child(c, 'WeekDays'), 'WeekDay')) {
      const dt = Number(val(wd, 'DayType'));
      const working = flag(val(wd, 'DayWorking'));
      let ss = working ? shifts(wd) : [];
      if (working && !ss.length) ss = defaultShifts();
      if (dt >= 1 && dt <= 7) cal.week[dt - 1] = ss;
      else if (dt === 0) { const tp = child(wd, 'TimePeriod'); if (tp) setRange(val(tp, 'FromDate'), val(tp, 'ToDate'), ss); } // legacy exception
    }
    for (const ex of kids(child(c, 'Exceptions'), 'Exception')) {
      const tp = child(ex, 'TimePeriod');
      if (!tp) continue;
      const working = flag(val(ex, 'DayWorking'));
      let ss = working ? shifts(ex) : [];
      if (working && !ss.length) ss = defaultShifts();
      const type = Number(val(ex, 'Type') || '1');
      const from = val(tp, 'FromDate'), to = val(tp, 'ToDate');
      if (type === 1) { setRange(from, to, ss, Number(val(ex, 'Period')) || 1); continue; }
      // Recurring exceptions: expand inside the time period
      const a = parseP6Date(toP6Date(from)), b = parseP6Date(toP6Date(to));
      if (a == null || b == null) continue;
      const d0 = minutesToSerial(a), d1 = Math.min(minutesToSerial(b), d0 + 20000);
      const dow = Number(val(ex, 'DaysOfWeek')) || 0, month = Number(val(ex, 'Month')), mday = Number(val(ex, 'MonthDay'));
      let hit = 0;
      for (let d = d0; d <= d1; d++) {
        const dt = new Date(serialToMinutes(d) * 60000);
        const ok = type === 6 ? (dow & (1 << dt.getUTCDay())) !== 0
          : type === 2 || type === 4 ? dt.getUTCDate() === mday && (type === 4 || dt.getUTCMonth() === month)
          : false;
        if (ok) { cal.exceptions.set(d, ss.map((s) => ({ ...s }))); hit++; }
      }
      if (!hit && type !== 6 && type !== 2 && type !== 4) {
        setRange(from, from, ss);
        findings.push({ severity: 'warning', code: 'MSP_CAL_RECURRING', table: 'CALENDAR', key: uid, message: `Calendar ${cal.name}: recurring exception type ${type} is not supported; only its first day was imported.`, p6: 'P6 stores exceptions day by day.' });
      }
    }
    cal.keep = { kids: [], xml: raw(c), seq: calendars.length };
    calendars.push(cal);
  }

  // tasks
  const tasks: MTask[] = [];
  const lagFormats = new Set<string>();
  for (const [i, t] of kids(child(p, 'Tasks'), 'Task').entries()) {
    const uid = val(t, 'UID');
    const seq = num(val(t, 'ID')) ?? i;
    // the project summary task (UID 0) and blank rows are not activities: kept as they are, in their place
    if (flag(val(t, 'IsNull')) || uid === '0' || val(t, 'OutlineLevel') === '0') { if (uid) ghosts.tasks.push({ seq, uid, xml: raw(t) }); continue; }
    if (!uid) continue;
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
    for (const l of kids(t, 'PredecessorLink')) {
      const pu = val(l, 'PredecessorUID');
      if (!pu) continue;
      if (flag(val(l, 'CrossProject'))) { findings.push({ severity: 'warning', code: 'MSP_CROSS_PROJECT_LINK', table: 'TASKPRED', key: uid, message: `"${m.name}" has a cross-project predecessor (${val(l, 'CrossProjectName')}); link dropped.`, p6: 'P6 cannot resolve links to other MS Project files.' }); continue; }
      const type = (['FF', 'FS', 'SF', 'SS'] as RelType[])[num(val(l, 'Type')) ?? 1] ?? 'FS';
      const lag = num(val(l, 'LinkLag')) ?? 0;
      const fmt = num(val(l, 'LagFormat')) ?? 7;
      const base = fmt > 32 ? fmt - 32 : fmt; // 35.. = estimated variants
      const lagHrs = lag / 600; // tenths of minutes
      // Assumption (as MPXJ reads it): percentage lags store the plain percentage in LinkLag.
      if (base === 19 || base === 20) { lagFormats.add('percent'); m.preds.push({ uid: pu, type, lagHrs: 0, lagPct: lag }); continue; }
      if ([4, 6, 8, 10, 12].includes(base) && lag) lagFormats.add('elapsed');
      m.preds.push({ uid: pu, type, lagHrs });
    }
    tasks.push(m);
  }
  tasks.sort((a, b) => a.id - b.id);
  // percentage lags: percent of the predecessor's duration
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  for (const t of tasks) for (const l of t.preds) if (l.lagPct != null) l.lagHrs = (l.lagPct / 100) * (byUid.get(l.uid)?.durHrs ?? 0);
  if (lagFormats.has('elapsed')) findings.push({ severity: 'info', code: 'MSP_ELAPSED_LAG', table: 'TASKPRED', message: 'Some links use elapsed lags; they were converted to working-hour lags.', p6: 'P6 has no elapsed lags; P6 converts them and counts lags on the scheduling option\'s lag calendar.' });
  if (lagFormats.has('percent')) findings.push({ severity: 'info', code: 'MSP_PERCENT_LAG', table: 'TASKPRED', message: 'Some links use percentage lags; they were converted to hours of the predecessor\'s duration.', p6: 'P6 has no percentage lags.' });

  // resources
  const resources: MRes[] = [];
  for (const [seq, r] of kids(child(p, 'Resources'), 'Resource').entries()) {
    const uid = val(r, 'UID');
    const name = val(r, 'Name');
    if (flag(val(r, 'IsNull')) || !uid || (uid === '0' && !name)) { if (uid) ghosts.resources.push({ seq, uid, xml: raw(r) }); continue; }
    const t = num(val(r, 'Type')) ?? 1;
    const cu = val(r, 'CalendarUID');
    let p6Type: string | undefined;
    for (const e of kids(r, 'ExtendedAttribute')) if (extKey.get(val(e, 'FieldID')) === 'rsrcType') p6Type = val(e, 'Value');
    const fmt = num(val(r, 'StandardRateFormat')) ?? 2;
    let rate = num(val(r, 'StandardRate'));
    // StandardRateFormat: 1 per minute, 2 hour, 3 day, 4 week, 5 month (8 h days assumed for day/week/month)
    if (rate != null && t !== 0) rate = fmt === 1 ? rate * 60 : fmt === 3 ? rate / (minutesPerDay / 60) : fmt === 4 ? rate / (minutesPerDay / 12) : fmt === 5 ? rate / (minutesPerDay / 3) : rate;
    resources.push({ uid, id: num(val(r, 'ID')) ?? resources.length + 1, name, code: val(r, 'Code') || val(r, 'Initials'), type: t === 0 ? 'material' : t === 2 ? 'cost' : 'work', maxUnits: num(val(r, 'MaxUnits')), rate, calUid: cu && cu !== '-1' ? cu : '', p6Type, keep: { kids: kidsOf(r), xml: '', seq, id: val(r, 'ID') } });
  }

  // assignments
  const resType = new Map(resources.map((r) => [r.uid, r.type]));
  const assignments: MAssign[] = [];
  for (const [seq, a] of kids(child(p, 'Assignments'), 'Assignment').entries()) {
    const uid = val(a, 'UID');
    if (!uid) continue;
    const ru = val(a, 'ResourceUID');
    const work = hrs(val(a, 'Work'));
    assignments.push({
      uid, taskUid: val(a, 'TaskUID'), resUid: ru, units: resType.get(ru) === 'material' && work != null ? null : num(val(a, 'Units')),
      workHrs: work, actualWorkHrs: hrs(val(a, 'ActualWork')), remainingWorkHrs: hrs(val(a, 'RemainingWork')),
      cost: num(val(a, 'Cost')), actualCost: num(val(a, 'ActualCost')), remainingCost: num(val(a, 'RemainingCost')),
      start: toP6Date(val(a, 'Start')), finish: toP6Date(val(a, 'Finish')), actualStart: toP6Date(val(a, 'ActualStart')), actualFinish: toP6Date(val(a, 'ActualFinish')),
      keep: { kids: kidsOf(a), xml: raw(a), seq },
    });
  }

  const sip = val(p, 'SplitsInProgressTasks');
  return {
    name: val(p, 'Name'), title: val(p, 'Title'), start: toP6Date(val(p, 'StartDate')), finish: toP6Date(val(p, 'FinishDate')),
    statusDate: toP6Date(val(p, 'StatusDate')), calUid: val(p, 'CalendarUID'), minutesPerDay, minutesPerWeek: num(val(p, 'MinutesPerWeek')) || minutesPerDay * 5,
    splitsInProgress: sip ? flag(sip) : null, criticalHrs: (num(val(p, 'CriticalSlackLimit')) ?? 0) * (minutesPerDay / 60),
    calendars, tasks, resources, assignments,
    keep: { kids: p.children.map((c): [string, string | null] => [c.name, COLLECTIONS.has(c.name) ? null : raw(c)]), ghosts, p6ext: extKey.size > 0 },
  };
}

// ---------- writer

export function writeMspdi(db: Db, opts: { projIds?: string[] } = {}): string {
  const m = projectFromDb(db, opts.projIds);
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
  const withGhosts = (items: { seq?: number; xml: () => string }[], ghosts: { seq: number; xml: string }[]) => {
    const g = [...ghosts].sort((x, y) => x.seq - y.seq), out: string[] = [];
    let i = 0;
    for (const it of items) { if (it.seq != null) while (i < g.length && g[i].seq < it.seq) out.push(g[i++].xml); out.push(it.xml()); }
    while (i < g.length) out.push(g[i++].xml);
    return out.join('');
  };
  const seqOf = (x: { keep?: Kept }, _i: number) => x.keep?.seq;
  const ghosts = m.keep?.ghosts ?? { tasks: [], resources: [], assignments: [], calendars: [] };

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
  if (p6ext) proj.push(['ExtendedAttributes', `<ExtendedAttributes>${TASK_TEXT.map(([, id, name, alias]) => `<ExtendedAttribute><FieldID>${id}</FieldID><FieldName>${name}</FieldName><Alias>${alias}</Alias></ExtendedAttribute>`).join('')}<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><FieldName>${RES_TYPE_FIELD[1]}</FieldName><Alias>${RES_TYPE_FIELD[2]}</Alias></ExtendedAttribute></ExtendedAttributes>`]);

  // Calendars: base calendars, then one resource calendar per work resource (MS Project requires it). A calendar read
  // from the file and not changed since goes back as it was (derived calendars and resource calendars included).
  const times = (ss: Shift[]) => (ss.length ? `<WorkingTimes>${ss.map((s) => `<WorkingTime><FromTime>${hms(s.start)}</FromTime><ToTime>${hms(s.end)}</ToTime></WorkingTime>`).join('')}</WorkingTimes>` : '');
  const calXml = (c: MProject['calendars'][number]) => {
    if (c.keep?.xml && c.row && !changedSince('CALENDAR', c.row, k)(['clndr_name', 'clndr_data', 'base_clndr_id'])) return c.keep.xml;
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
  const cals = [withGhosts(calOrder.map((c, i) => ({ seq: seqOf(c, i), xml: () => calXml(c) })), ghosts.calendars)];
  let calUid = [...m.calendars.map((c) => c.uid), ...ghosts.calendars.map((g) => g.uid)].reduce((x, u) => Math.max(x, Number(u) || 0), 0);
  const resCal = new Map<string, number>();
  for (const r of m.resources) {
    // a resource read from the file keeps its own resource calendar while its calendar did not change
    if (r.type !== 'work' || (r.keep && r.row && !changedSince('RSRC', r.row, k)(['clndr_id']))) continue;
    resCal.set(r.uid, ++calUid);
    cals.push(`<Calendar><UID>${calUid}</UID><Name>${esc(r.name)}</Name><IsBaseCalendar>0</IsBaseCalendar><IsBaselineCalendar>0</IsBaselineCalendar><BaseCalendarUID>${esc(r.calUid || m.calUid)}</BaseCalendarUID></Calendar>`);
  }
  proj.push(['Calendars', `<Calendars>${cals.join('')}</Calendars>`]);

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
      for (const l of t.preds) {
        cur.push(['PredecessorLink', `<PredecessorLink><PredecessorUID>${esc(l.uid)}</PredecessorUID><Type>${['FF', 'FS', 'SF', 'SS'].indexOf(l.type)}</Type><CrossProject>0</CrossProject><LinkLag>${Math.round(l.lagHrs * 600)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`]);
      }
      if (p6ext) for (const [key, id] of TASK_TEXT) { const v = t.extra[key]; if (v) cur.push(['ExtendedAttribute', `<ExtendedAttribute><FieldID>${id}</FieldID><Value>${esc(v)}</Value></ExtendedAttribute>`]); }
    } else {
      el('CalendarUID', -1);
    }
    if (t.summary) return element('Task', t.keep, t.row, 'PROJWBS', SUMMARY_DEPS);
    // a leaf's WBS code (Microsoft Project's own) stays while the task keeps its place in the outline
    const outlineWas = t.keep?.kids.find((x) => x[0] === 'OutlineNumber')?.[1].replace(/<[^>]+>/g, '').trim();
    return element('Task', t.keep, t.row, 'TASK', { ...TASK_DEPS, WBS: () => outlineWas !== t.outline, ExtendedAttribute: p6ext ? P6_FIELDS : () => false }, notOurs);
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
  proj.push(['Tasks', `<Tasks>${taskRows.join('')}</Tasks>`]);

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
    return element('Resource', r.keep, r.row, 'RSRC', { ...RES_DEPS, ExtendedAttribute: p6ext ? ['rsrc_type'] : () => false }, notOurs);
  };
  proj.push(['Resources', `<Resources>${withGhosts(m.resources.map((r, i) => ({ seq: seqOf(r, i), xml: () => resXml(r) })), ghosts.resources)}</Resources>`]);

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
  proj.push(['Assignments', `<Assignments>${withGhosts(m.assignments.map((a, i) => ({ seq: seqOf(a, i), xml: () => asgXml(a) })), ghosts.assignments)}</Assignments>`]);

  const body = m.keep && m.row ? mergeKids(m.keep.kids, proj, PROJECT_DEPS, changedSince('PROJECT', m.row, k), ORDER.Project) : proj.map((x) => x[1]).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Project xmlns="${MSPDI_NS}">\n${body}\n</Project>\n`;
}
