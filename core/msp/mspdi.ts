// Microsoft Project XML (MSPDI, namespace http://schemas.microsoft.com/project) import/export.
// Elements are written in the order of the MSPDI schema (mspdi_pj12.xsd), which Microsoft Project enforces.
import type { Db } from '../db.ts';
import type { Finding } from '../findings.ts';
import type { Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../dates.ts';
import { parseXml, type XNode } from '../xml/p6xml.ts';
import { p6num } from '../schedule/cpm.ts';
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
  try {
    root = parseXml(text.replace(/^﻿/, ''));
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
    const m = readProject(p, findings);
    if (!m.tasks.length) findings.push({ severity: 'warning', code: 'MSP_NO_TASKS', message: 'The Microsoft Project file contains no tasks.', p6: 'P6 imports an empty project.' });
    return { db: projectToDb(m, findings, 'The Microsoft Project XML file'), findings };
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'MSP_READ', message: `Could not read the Microsoft Project XML file: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
}

function readProject(p: XNode, findings: Finding[]): MProject {
  const minutesPerDay = num(val(p, 'MinutesPerDay')) || 480;
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
    calendars.push(cal);
  }

  // tasks
  const tasks: MTask[] = [];
  const lagFormats = new Set<string>();
  for (const t of kids(child(p, 'Tasks'), 'Task')) {
    if (flag(val(t, 'IsNull'))) continue;
    const uid = val(t, 'UID');
    if (!uid) continue;
    const m = emptyTask(uid, num(val(t, 'ID')) ?? tasks.length + 1);
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
  for (const r of kids(child(p, 'Resources'), 'Resource')) {
    if (flag(val(r, 'IsNull'))) continue;
    const uid = val(r, 'UID');
    const name = val(r, 'Name');
    if (!uid || (uid === '0' && !name)) continue;
    const t = num(val(r, 'Type')) ?? 1;
    const cu = val(r, 'CalendarUID');
    let p6Type: string | undefined;
    for (const e of kids(r, 'ExtendedAttribute')) if (extKey.get(val(e, 'FieldID')) === 'rsrcType') p6Type = val(e, 'Value');
    const fmt = num(val(r, 'StandardRateFormat')) ?? 2;
    let rate = num(val(r, 'StandardRate'));
    // StandardRateFormat: 1 per minute, 2 hour, 3 day, 4 week, 5 month (8 h days assumed for day/week/month)
    if (rate != null && t !== 0) rate = fmt === 1 ? rate * 60 : fmt === 3 ? rate / (minutesPerDay / 60) : fmt === 4 ? rate / (minutesPerDay / 12) : fmt === 5 ? rate / (minutesPerDay / 3) : rate;
    resources.push({ uid, id: num(val(r, 'ID')) ?? resources.length + 1, name, code: val(r, 'Code') || val(r, 'Initials'), type: t === 0 ? 'material' : t === 2 ? 'cost' : 'work', maxUnits: num(val(r, 'MaxUnits')), rate, calUid: cu && cu !== '-1' ? cu : '', p6Type });
  }

  // assignments
  const resType = new Map(resources.map((r) => [r.uid, r.type]));
  const assignments: MAssign[] = [];
  for (const a of kids(child(p, 'Assignments'), 'Assignment')) {
    const uid = val(a, 'UID');
    if (!uid) continue;
    const ru = val(a, 'ResourceUID');
    const work = hrs(val(a, 'Work'));
    assignments.push({
      uid, taskUid: val(a, 'TaskUID'), resUid: ru, units: resType.get(ru) === 'material' && work != null ? null : num(val(a, 'Units')),
      workHrs: work, actualWorkHrs: hrs(val(a, 'ActualWork')), remainingWorkHrs: hrs(val(a, 'RemainingWork')),
      cost: num(val(a, 'Cost')), actualCost: num(val(a, 'ActualCost')), remainingCost: num(val(a, 'RemainingCost')),
      start: toP6Date(val(a, 'Start')), finish: toP6Date(val(a, 'Finish')), actualStart: toP6Date(val(a, 'ActualStart')), actualFinish: toP6Date(val(a, 'ActualFinish')),
    });
  }

  const sip = val(p, 'SplitsInProgressTasks');
  return {
    name: val(p, 'Name'), title: val(p, 'Title'), start: toP6Date(val(p, 'StartDate')), finish: toP6Date(val(p, 'FinishDate')),
    statusDate: toP6Date(val(p, 'StatusDate')), calUid: val(p, 'CalendarUID'), minutesPerDay, minutesPerWeek: num(val(p, 'MinutesPerWeek')) || minutesPerDay * 5,
    splitsInProgress: sip ? flag(sip) : null, criticalHrs: (num(val(p, 'CriticalSlackLimit')) ?? 0) * (minutesPerDay / 60),
    calendars, tasks, resources, assignments,
  };
}

// ---------- writer

export function writeMspdi(db: Db, opts: { projIds?: string[] } = {}): string {
  const m = projectFromDb(db, opts.projIds);
  const o: string[] = [];
  const el = (tag: string, v: string | number | null | undefined) => { if (v != null && v !== '') o.push(`<${tag}>${esc(String(v))}</${tag}>`); };
  const dt = (tag: string, s: string) => el(tag, xmlDate(s));
  const b = (x: boolean) => (x ? 1 : 0);
  const now = formatP6Date(Math.floor(Date.now() / 60000));

  o.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<Project xmlns="${MSPDI_NS}">`);
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

  o.push('<ExtendedAttributes>');
  for (const [, id, name, alias] of TASK_TEXT) o.push(`<ExtendedAttribute><FieldID>${id}</FieldID><FieldName>${name}</FieldName><Alias>${alias}</Alias></ExtendedAttribute>`);
  o.push(`<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><FieldName>${RES_TYPE_FIELD[1]}</FieldName><Alias>${RES_TYPE_FIELD[2]}</Alias></ExtendedAttribute>`);
  o.push('</ExtendedAttributes>');

  // Calendars: base calendars, then one resource calendar per work resource (MS Project requires it)
  o.push('<Calendars>');
  const times = (ss: Shift[]) => (ss.length ? `<WorkingTimes>${ss.map((s) => `<WorkingTime><FromTime>${hms(s.start)}</FromTime><ToTime>${hms(s.end)}</ToTime></WorkingTime>`).join('')}</WorkingTimes>` : '');
  for (const c of m.calendars) {
    o.push(`<Calendar><UID>${esc(c.uid)}</UID><Name>${esc(c.name)}</Name><IsBaseCalendar>1</IsBaseCalendar><IsBaselineCalendar>0</IsBaselineCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>`);
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
  }
  let calUid = m.calendars.reduce((x, c) => Math.max(x, Number(c.uid) || 0), 0);
  const resCal = new Map<string, number>();
  for (const r of m.resources) {
    if (r.type !== 'work') continue;
    resCal.set(r.uid, ++calUid);
    o.push(`<Calendar><UID>${calUid}</UID><Name>${esc(r.name)}</Name><IsBaseCalendar>0</IsBaseCalendar><IsBaselineCalendar>0</IsBaselineCalendar><BaseCalendarUID>${esc(r.calUid || m.calUid)}</BaseCalendarUID></Calendar>`);
  }
  o.push('</Calendars>');

  o.push('<Tasks>');
  for (const t of m.tasks) {
    o.push('<Task>');
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
        o.push(`<PredecessorLink><PredecessorUID>${esc(l.uid)}</PredecessorUID><Type>${['FF', 'FS', 'SF', 'SS'].indexOf(l.type)}</Type><CrossProject>0</CrossProject><LinkLag>${Math.round(l.lagHrs * 600)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`);
      }
      for (const [k, id] of TASK_TEXT) { const v = t.extra[k]; if (v) o.push(`<ExtendedAttribute><FieldID>${id}</FieldID><Value>${esc(v)}</Value></ExtendedAttribute>`); }
    } else {
      el('CalendarUID', -1);
    }
    o.push('</Task>');
  }
  o.push('</Tasks>');

  o.push('<Resources>');
  for (const r of m.resources) {
    o.push('<Resource>');
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
    if (r.p6Type) o.push(`<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><Value>${esc(r.p6Type)}</Value></ExtendedAttribute>`);
    o.push('</Resource>');
  }
  o.push('</Resources>');

  o.push('<Assignments>');
  for (const a of m.assignments) {
    o.push('<Assignment>');
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
    o.push('</Assignment>');
  }
  o.push('</Assignments>');
  o.push('</Project>');
  return o.join('\n') + '\n';
}
