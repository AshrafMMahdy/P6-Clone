// Microsoft Project XML (MSPDI, namespace http://schemas.microsoft.com/project) import/export.
// Elements are written in the order of the MSPDI schema (mspdi_pj12.xsd), which Microsoft Project enforces.
import { rows, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { parseClndrData, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../dates.ts';
import { parseXml, type Chunked, type XNode } from '../xml/p6xml.ts';
import { isLegacyLayout, p6num } from '../schedule/cpm.ts';
import { baselineNumbers, baselineXml, importMspBaselines, scanTaskBaselines, type FoundBaselines } from './baselines.ts';
import { ASG_DEPS, WORK, COLLECTIONS, ORDER, PROJECT_DEPS, RES_DEPS, SUMMARY_DEPS, TASK_DEPS, changedSince, keepCtx, mergeKids, snapshotKept, type Ghosts, type Kept } from './keep.ts';
import { defaultShifts, emptyTask, linkKey, projectFromDb, projectToDb, type MCustom, type MPred, type MAssign, type MCal, type MProject, type MRes, type MTask, type P6Extra, type RelType } from './shared.ts';
import { CF_KINDS, CF_SLOTS, longTextNote, notNumberNote, planCustomFields, slotName, slotOfField, taskFieldSlots, valueReader, type CfSubject } from './custom-fields.ts';
import { FORMAT_REVISION, LAG_FORMAT, RATE_PER_HOUR, defaultCtx, lagIsElapsed, lagIsPercent, percentLagHours, readDate, readFlag, readLag, readNumber, readRate, readText, readUnits, revisionText, toP6Date, writeLag, writeValue, type Ctx, type Entity } from './values.ts';

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
/** The definition's alias: the P6 build, whether its layout is the legacy one, and the revision of how the clone wrote the file's values (values.ts
 *  FORMAT_REVISION): a file of the clone without the revision is one written before currency was stored as Microsoft Project stores it. */
const RULES_ALIAS = /^P6 Schedule Rules (\S+)( legacy)?(?:, format (\d+))?$/;
const rulesAlias = (ver: string, legacy: boolean) => `P6 Schedule Rules ${ver || '?'}${legacy ? ' legacy' : ''}, ${revisionText()}`;

// ---------- the signature of the clone's OLD writer (every version before values.ts FORMAT_REVISION 2)
// Costs in those files are plain units, not hundredths. A file is read that way only when its bytes are the old writer's own, shown by ALL of:
//   1. <Author> is "Primavera P6 Clone";
//   2. the project's own elements (outside the collections ExtendedAttributes, Calendars, Tasks, Resources, Assignments) are exactly the old writer's list, in its order
//      (OLD_HEADER; the optional ones may be absent). Microsoft Project and MPXJ both add elements to it on every save (CurrencyDigits, CurrencySymbol, FYStartDate,
//      CurrentDate, OutlineCodes, WBSMasks, BuildNumber ...), so a re-saved file no longer has this list;
//   3. the first Task, the first Resource and the first Assignment have no element outside OLD_ELEMENTS (a re-save adds Active, Manual, ResumeValid, ExternalTask,
//      FixedCostAccrual, PeakUnits, CanLevel, IsGeneric, PercentWorkComplete, HasFixedRateUnits, RateScale ... to each of them);
//   4. the file's first six custom field definitions are the clone's own, in its order, with its FieldIDs (OLD_DEFS);
//   5. it has no format stamp (a stamp says revision 2 or later), and it is not an .mpp / MPX read through MPXJ (a conversion is always the format's representation).
// The list of every element the old writer ever wrote is the same in every version of the clone (core/msp/mspdi.ts since its first commit).
const OLD_HEADER = ['SaveVersion', 'Name', 'Title', 'Author', 'CreationDate', 'LastSaved', 'ScheduleFromStart', 'StartDate', 'FinishDate', 'CriticalSlackLimit', 'CalendarUID', 'DefaultStartTime', 'DefaultFinishTime', 'MinutesPerDay', 'MinutesPerWeek', 'DaysPerMonth', 'DefaultTaskType', 'DurationFormat', 'WorkFormat', 'HonorConstraints', 'MultipleCriticalPaths', 'NewTasksEffortDriven', 'NewTasksEstimated', 'SplitsInProgressTasks', 'WeekStartDay', 'StatusDate', 'NewTaskStartDate'];
const OLD_HEADER_OPTIONAL = new Set(['Name', 'Title', 'StartDate', 'FinishDate', 'CalendarUID', 'StatusDate']); // (the writer leaves out an element with no value)
const CLONE_COLLECTIONS = new Set(['ExtendedAttributes', 'Calendars', 'Tasks', 'Resources', 'Assignments']);
const OLD_ELEMENTS: Record<'Task' | 'Resource' | 'Assignment', Set<string>> = {
  Task: new Set(['UID', 'ID', 'Name', 'Type', 'IsNull', 'WBS', 'OutlineNumber', 'OutlineLevel', 'Priority', 'Start', 'Finish', 'Duration', 'DurationFormat', 'EffortDriven', 'Estimated', 'Milestone', 'Summary', 'Critical', 'EarlyStart', 'EarlyFinish', 'LateStart', 'LateFinish', 'FreeSlack', 'TotalSlack', 'PercentComplete', 'ActualStart', 'ActualFinish', 'RemainingDuration', 'ConstraintType', 'CalendarUID', 'ConstraintDate', 'Deadline', 'IgnoreResourceCalendar', 'PredecessorLink', 'ExtendedAttribute', 'Baseline']),
  Resource: new Set(['UID', 'ID', 'Name', 'Type', 'IsNull', 'Code', 'MaxUnits', 'StandardRate', 'StandardRateFormat', 'OvertimeRate', 'OvertimeRateFormat', 'CalendarUID', 'ExtendedAttribute']),
  Assignment: new Set(['UID', 'TaskUID', 'ResourceUID', 'ActualCost', 'ActualFinish', 'ActualStart', 'ActualWork', 'Cost', 'Finish', 'RemainingCost', 'RemainingWork', 'Start', 'Units', 'Work']),
};
const OLD_DEFS: [fieldId: string, alias: string][] = [...TASK_TEXT.map((x): [string, string] => [x[1], x[3]]), [RES_TYPE_FIELD[0], RES_TYPE_FIELD[2]]];
/** Whether the project's own elements and custom field definitions are those of the old writer (points 1, 2 and 4 above). */
function oldWriterHeader(p: XNode): boolean {
  if (val(p, 'Author') !== 'Primavera P6 Clone') return false;
  const own = p.children.map((c) => c.name).filter((n) => !CLONE_COLLECTIONS.has(n));
  if (!own.every((n) => OLD_HEADER.includes(n)) || new Set(own).size !== own.length) return false;
  const required = OLD_HEADER.filter((n) => !OLD_HEADER_OPTIONAL.has(n));
  if (own.filter((n) => !OLD_HEADER_OPTIONAL.has(n)).join() !== required.join()) return false;
  if (own.join() !== OLD_HEADER.filter((n) => own.includes(n)).join()) return false; // (the old writer's order)
  const defs = kids(child(p, 'ExtendedAttributes'), 'ExtendedAttribute');
  return OLD_DEFS.every(([id, alias], i) => defs[i] && val(defs[i], 'FieldID') === id && val(defs[i], 'Alias') === alias);
}
/** A refused save: said in words (the MCP server answers it as a tool error with this message and hint; the desktop shows both). */
export class MspSaveRefused extends Error {
  code: string; hint: string;
  constructor(code: string, message: string, hint: string) { super(message); this.code = code; this.hint = hint; }
}

// ---------- times of day

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

/** Microsoft Project XML as text, or as pieces (Chunked: a document larger than one string, e.g. what MPXJ writes for a big .mpp; its first piece has no BOM). */
/** `converted`: the XML is what MPXJ (or Microsoft Project) made of an .mpp / MPX file: always the format's own representation, never a file of the clone's earlier writer. */
export function parseMspdi(text: string | Chunked, opts: { converted?: boolean } = {}): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const empty: Db = { tables: {} };
  let root: XNode;
  const src = typeof text === 'string' ? text.replace(/^﻿/, '') : text;
  // read as it goes: each task, resource and assignment is read as soon as it closes and let go (readProject)
  const reader = projectReader(findings, src, opts);
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
    const bl = importMspBaselines(db, typeof src === 'string' ? src : reader.baselines, m.minutesPerDay);
    if (bl.length) findings.push({ severity: 'info', code: 'MSP_BASELINES', message: `${bl.length} baseline(s) read: ${bl.join(', ')}.`, p6: 'P6 imports Microsoft Project baselines only through its own conversion; the clone keeps each as a saved baseline.' });
    return { db, findings };
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'MSP_READ', message: `Could not read the Microsoft Project XML file: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
}

/** The project read element by element: the project's own fields, its custom fields and its calendars when the first
 *  task, resource or assignment arrives (Microsoft Project writes them first), then each of those as it closes. */
function projectReader(findings: Finding[], src: string | Chunked, opts: { converted?: boolean }) {
  const baselines: FoundBaselines = new Map(); // (a document in pieces: collected task by task as they are read)
  let doc: XNode | null = null, p: XNode | null = null, headDone = false;
  // what the conversions of values.ts need of the file: the length of its day (set by head), whether it is a file of the clone's revision 1
  const ctx: Ctx = defaultCtx();
  // an element's value as the model holds it, by the type values.ts gives the element (the conversion is never done here)
  const rNum = (e: Entity, n: XNode, name: string) => readNumber(e, name, val(n, name), ctx);
  const rDate = (e: Entity, n: XNode, name: string) => readDate(e, name, val(n, name));
  const rFlag = (e: Entity, n: XNode, name: string) => readFlag(e, name, val(n, name));
  // every element is also kept as written, so what the model does not hold goes back into the file unchanged (keep.ts)
  const raw = (n: XNode) => src.slice(n.s, n.e);
  const kidsOf = (n: XNode): [string, string][] => n.children.map((c) => [c.name, raw(c)]);
  const ghosts: Ghosts = { tasks: [], resources: [], assignments: [], calendars: [] };
  const extKey = new Map<string, keyof P6Extra | 'rsrcType'>();
  // custom fields of the file that are not the clone's own (custom-fields.ts): the definitions of the slots it carries (FieldID -> alias),
  // the FieldIDs with a value, every FieldID the file has, and the aliased fields of kinds P6 has no field type for
  const cfDefs = new Map<string, string>(), cfValued = new Set<string>(), cfUsed = new Set<string>(), cfUnread: string[] = [];
  // custom field values on summary tasks (and the project summary task): not activities, so not read; they stay in the file
  const sumFields = new Map<string, number>(), sumTasks = new Set<string>();
  const summaryValues = (eas: XNode[], uid: string) => {
    for (const e of eas) {
      const fid = val(e, 'FieldID');
      if (extKey.has(fid) || slotOfField(fid)?.subject !== 'Task' || !(child(e, 'Value')?.text ?? '').trim()) continue;
      sumFields.set(fid, (sumFields.get(fid) ?? 0) + 1);
      sumTasks.add(uid);
    }
  };
  let p6rules: { ver: string; legacy: boolean; known: boolean } | null = null, revision = 1;
  let headSig = false, shapeOk = true, plainDecided = false;
  const shapeSeen = new Set<string>();
  /** the first Task, Resource and Assignment must have only the elements the old writer wrote */
  const shape = (kind: 'Task' | 'Resource' | 'Assignment', n: XNode) => { if (shapeSeen.has(kind)) return; shapeSeen.add(kind); if (!n.children.every((c) => OLD_ELEMENTS[kind].has(c.name))) shapeOk = false; };
  const decidePlain = () => {
    if (plainDecided) return;
    plainDecided = true;
    if (!headSig || !shapeOk) return;
    ctx.plainCurrency = true;
    findings.push({ severity: 'info', code: 'MSP_OLD_CLONE_FILE', message: 'This file was written by an earlier version of the clone: its costs were stored in plain units (not in hundredths of the currency unit, as Microsoft Project stores them) and were read accordingly. Saving it again writes Microsoft Project\'s representation.', p6: 'P6 has no such files: Microsoft Project would show these costs one hundredth of what they are.' });
  };
  const calendars: MCal[] = [];
  const head = (p: XNode) => {
  headDone = true;
  ctx.minutesPerDay = readNumber('Project', 'MinutesPerDay', val(p, 'MinutesPerDay'), ctx) || 480;
  ctx.minutesPerWeek = readNumber('Project', 'MinutesPerWeek', val(p, 'MinutesPerWeek'), ctx) || ctx.minutesPerDay * 5;
  // custom field aliases
  for (const e of kids(child(p, 'ExtendedAttributes'), 'ExtendedAttribute')) {
    const alias = val(e, 'Alias'), fid = val(e, 'FieldID');
    cfUsed.add(fid);
    const hit = TASK_TEXT.find((x) => x[3] === alias);
    const rules = RULES_ALIAS.exec(alias);
    if (rules) { p6rules = { ver: rules[1] === '?' ? '' : rules[1], legacy: !!rules[2], known: true }; revision = Number(rules[3] ?? 1); continue; }
    if (hit) extKey.set(fid, hit[0]);
    else if (alias === RES_TYPE_FIELD[2]) extKey.set(fid, 'rsrcType');
    else if (slotOfField(fid)) cfDefs.set(fid, alias);
    else if (alias) cfUnread.push(`${alias} (${val(e, 'FieldName') || fid})`);
  }
  // A file of the clone's OLD writer (oldWriterHeader and the shape of its first elements: see "the signature" above) without the stamp of the current revision
  // holds currency in plain units, not hundredths: decided when the first assignment is read (decidePlain). Any other file is read by the format's rule.
  headSig = revision < FORMAT_REVISION && !opts.converted && oldWriterHeader(p);

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
    shape('Task', t);
    const uid = val(t, 'UID');
    const eas = kids(t, 'ExtendedAttribute');
    for (const e of eas) cfUsed.add(val(e, 'FieldID'));
    const seq = rNum('Task', t, 'ID') ?? i;
    // the project summary task (UID 0) and blank rows are not activities: kept as they are, in their place
    if (rFlag('Task', t, 'IsNull') || uid === '0' || val(t, 'OutlineLevel') === '0') { if (uid) { ghosts.tasks.push({ seq, uid, xml: raw(t) }); if (!rFlag('Task', t, 'IsNull')) summaryValues(eas, uid); } return; }
    if (!uid) return;
    const m = emptyTask(uid, rNum('Task', t, 'ID') ?? tasks.length + 1);
    m.keep = { kids: kidsOf(t), xml: '', seq, id: val(t, 'ID') };
    const outline = val(t, 'OutlineNumber');
    m.name = val(t, 'Name');
    m.level = rNum('Task', t, 'OutlineLevel') ?? (outline ? outline.split('.').length : 1);
    m.outline = outline;
    m.wbs = val(t, 'WBS');
    m.summary = !!rFlag('Task', t, 'Summary');
    m.milestone = !!rFlag('Task', t, 'Milestone');
    m.type = rNum('Task', t, 'Type');
    m.durHrs = rNum('Task', t, 'Duration');
    m.remHrs = rNum('Task', t, 'RemainingDuration');
    m.actHrs = rNum('Task', t, 'ActualDuration');
    m.pct = rNum('Task', t, 'PercentComplete');
    m.start = rDate('Task', t, 'Start');
    m.finish = rDate('Task', t, 'Finish');
    m.earlyStart = rDate('Task', t, 'EarlyStart');
    m.earlyFinish = rDate('Task', t, 'EarlyFinish');
    m.lateStart = rDate('Task', t, 'LateStart');
    m.lateFinish = rDate('Task', t, 'LateFinish');
    m.actualStart = rDate('Task', t, 'ActualStart');
    m.actualFinish = rDate('Task', t, 'ActualFinish');
    m.constraintType = rNum('Task', t, 'ConstraintType');
    m.constraintDate = rDate('Task', t, 'ConstraintDate');
    m.deadline = rDate('Task', t, 'Deadline');
    const cu = val(t, 'CalendarUID');
    m.calUid = cu && cu !== '-1' ? cu : '';
    m.totalSlackHrs = rNum('Task', t, 'TotalSlack');
    m.freeSlackHrs = rNum('Task', t, 'FreeSlack');
    m.critical = rFlag('Task', t, 'Critical');
    if (m.summary) summaryValues(eas, uid);
    for (const e of eas) {
      const fid = val(e, 'FieldID'), k = extKey.get(fid);
      if (k) { if (k !== 'rsrcType') m.extra[k] = val(e, 'Value'); continue; }
      // a custom field of the file's own: an activity's value (a WBS element's stays in the file as it is)
      const text = child(e, 'Value')?.text ?? '';
      if (!m.summary && slotOfField(fid)?.subject === 'Task' && text.trim()) { (m.udf ??= []).push([fid, text]); cfValued.add(fid); }
    }
    m.links = [];
    for (const l of kids(t, 'PredecessorLink')) {
      m.links.push(null); // replaced below by the link read from it; null: a link the clone does not import
      const pu = val(l, 'PredecessorUID');
      if (!pu) continue;
      if (rFlag('PredecessorLink', l, 'CrossProject')) { findings.push({ severity: 'warning', code: 'MSP_CROSS_PROJECT_LINK', table: 'TASKPRED', key: uid, message: `"${m.name}" has a cross-project predecessor (${val(l, 'CrossProjectName')}); link dropped.`, p6: 'P6 cannot resolve links to other MS Project files.' }); continue; }
      const type = (['FF', 'FS', 'SF', 'SS'] as RelType[])[rNum('PredecessorLink', l, 'Type') ?? 1] ?? 'FS';
      const fmt = rNum('PredecessorLink', l, 'LagFormat') ?? LAG_FORMAT;
      const { hours: lagHrs, percent } = readLag(val(l, 'LinkLag'), fmt);
      // Assumption (as MPXJ reads it): percentage lags store the plain percentage in LinkLag.
      if (lagIsPercent(fmt)) { lagFormats.add('percent'); m.preds.push({ uid: pu, type, lagHrs: 0, lagPct: percent, lagFile: { value: val(l, 'LinkLag'), format: String(fmt) } }); m.links[m.links.length - 1] = m.preds[m.preds.length - 1]; continue; }
      if (lagIsElapsed(fmt) && lagHrs) lagFormats.add('elapsed');
      m.preds.push({ uid: pu, type, lagHrs, ...(lagHrs && lagIsElapsed(fmt) ? { lagFile: { value: val(l, 'LinkLag'), format: String(fmt) } } : {}) });
      m.links[m.links.length - 1] = m.preds[m.preds.length - 1];
    }
    tasks.push(m);
  };

  // resources
  const resources: MRes[] = [];
  let resNo = 0;
  const resource = (r: XNode) => {
    const seq = resNo++;
    shape('Resource', r);
    const uid = val(r, 'UID');
    const eas = kids(r, 'ExtendedAttribute');
    for (const e of eas) cfUsed.add(val(e, 'FieldID'));
    const name = val(r, 'Name');
    if (rFlag('Resource', r, 'IsNull') || !uid || (uid === '0' && !name)) { if (uid) ghosts.resources.push({ seq, uid, xml: raw(r) }); return; }
    const t = rNum('Resource', r, 'Type') ?? 1;
    const cu = val(r, 'CalendarUID');
    let p6Type: string | undefined;
    const udf: [string, string][] = [];
    for (const e of eas) {
      const fid = val(e, 'FieldID'), text = child(e, 'Value')?.text ?? '';
      if (extKey.get(fid) === 'rsrcType') p6Type = val(e, 'Value');
      else if (!extKey.has(fid) && slotOfField(fid)?.subject === 'Resource' && text.trim()) { udf.push([fid, text]); cfValued.add(fid); }
    }
    const rate = readRate(val(r, 'StandardRate'));
    resType?.set(uid, t === 0 ? 'material' : t === 2 ? 'cost' : 'work'); // (an assignment written before its resource)
    resources.push({ uid, id: rNum('Resource', r, 'ID') ?? resources.length + 1, name, code: val(r, 'Code') || val(r, 'Initials'), type: t === 0 ? 'material' : t === 2 ? 'cost' : 'work', maxUnits: rNum('Resource', r, 'MaxUnits'), rate, calUid: cu && cu !== '-1' ? cu : '', p6Type, ...(udf.length ? { udf } : {}), keep: { kids: kidsOf(r), xml: '', seq, id: val(r, 'ID') } });
  };

  // assignments
  let resType: Map<string, MRes['type']> | null = null;
  const assignments: MAssign[] = [];
  let asgNo = 0;
  const assignment = (a: XNode) => {
    const seq = asgNo++;
    shape('Assignment', a);
    decidePlain();
    resType ??= new Map(resources.map((r) => [r.uid, r.type]));
    const uid = val(a, 'UID');
    if (!uid) return;
    const ru = val(a, 'ResourceUID');
    const work = rNum('Assignment', a, 'Work');
    assignments.push({
      uid, taskUid: val(a, 'TaskUID'), resUid: ru, units: readUnits(val(a, 'Units'), resType!.get(ru) === 'material', work),
      workHrs: work, actualWorkHrs: rNum('Assignment', a, 'ActualWork'), remainingWorkHrs: rNum('Assignment', a, 'RemainingWork'),
      cost: rNum('Assignment', a, 'Cost'), actualCost: rNum('Assignment', a, 'ActualCost'), remainingCost: rNum('Assignment', a, 'RemainingCost'),
      start: rDate('Assignment', a, 'Start'), finish: rDate('Assignment', a, 'Finish'), actualStart: rDate('Assignment', a, 'ActualStart'), actualFinish: rDate('Assignment', a, 'ActualFinish'),
      keep: { kids: kidsOf(a), xml: raw(a), seq },
    });
  };

  const split = (parents: string[], name: string) => parents.length === 2 && parents[0] === 'Project' && ((parents[1] === 'Tasks' && name === 'Task') || (parents[1] === 'Resources' && name === 'Resource') || (parents[1] === 'Assignments' && name === 'Assignment'));
  const emit = (_parents: string[], n: XNode) => {
    if (!headDone) { p = doc?.children.find((c) => c.name === 'Project') ?? null; if (p) head(p); }
    if (n.name === 'Task') { task(n); if (typeof src !== 'string') { const x = raw(n); if (x.includes('<Baseline>')) scanTaskBaselines(x, baselines, ctx.minutesPerDay); } } else if (n.name === 'Resource') resource(n); else assignment(n);
  };
  const finish = (p: XNode): MProject => {
  if (!headDone) head(p);
  decidePlain();
  tasks.sort((a, b) => a.id - b.id);
  // percentage lags: percent of the predecessor's duration
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  for (const t of tasks) for (const l of t.preds) if (l.lagPct != null) l.lagHrs = percentLagHours(l.lagPct, byUid.get(l.uid)?.durHrs ?? 0);
  if (lagFormats.has('elapsed')) findings.push({ severity: 'info', code: 'MSP_ELAPSED_LAG', table: 'TASKPRED', message: 'Some links use elapsed lags; they were converted to working-hour lags.', p6: 'P6 has no elapsed lags; P6 converts them and counts lags on the scheduling option\'s lag calendar.' });
  if (lagFormats.has('percent')) findings.push({ severity: 'info', code: 'MSP_PERCENT_LAG', table: 'TASKPRED', message: 'Some links use percentage lags; they were converted to hours of the predecessor\'s duration.', p6: 'P6 has no percentage lags.' });

  // the custom fields that become P6 custom fields: the file's aliased ones in its order, then those with values and no alias, each under its
  // alias (else its Microsoft Project name, as Text7); two of one subject never share a name
  const custom: MCustom[] = [], names = new Set<string>();
  const add = (fieldId: string, alias: string) => {
    const { subject, kind, n } = slotOfField(fieldId)!;
    let name = alias || slotName(kind, n);
    if (names.has(`${subject}|${name.toLowerCase()}`)) name = `${name} (${slotName(kind, n)})`;
    names.add(`${subject}|${name.toLowerCase()}`);
    custom.push({ fieldId, subject, kind, name });
  };
  for (const [fid, alias] of cfDefs) if (alias) add(fid, alias);
  const order = (['Task', 'Resource'] as CfSubject[]).flatMap((s) => CF_KINDS.flatMap((k) => CF_SLOTS[s][k].map(String)));
  const unnamed: string[] = [];
  for (const fid of order) if (!cfDefs.get(fid) && cfValued.has(fid)) { add(fid, ''); unnamed.push(`${custom[custom.length - 1].subject === 'Task' ? 'activity' : 'resource'} ${custom[custom.length - 1].name}`); }
  if (unnamed.length) findings.push({ severity: 'info', code: 'MSP_CUSTOM_FIELD_UNNAMED', message: `${unnamed.length} Microsoft Project custom field(s) have values but no name (alias) in the file, so they were read as P6 custom fields under their Microsoft Project field name (the name Microsoft Project itself shows): ${unnamed.join(', ')}.`, p6: 'P6 custom fields always have a name; a Microsoft Project custom field without an alias is shown under its field name.' });
  if (sumFields.size) findings.push({ severity: 'info', code: 'MSP_CUSTOM_FIELD_SUMMARY', message: `Custom field values on summary tasks were not read as P6 custom fields: ${[...sumFields].map(([fid, n]) => { const { kind, n: i } = slotOfField(fid)!; return `${cfDefs.get(fid) || slotName(kind, i)} (${slotName(kind, i)}, ${n} value${n === 1 ? '' : 's'})`; }).join(', ')} on ${sumTasks.size} summary task(s) (the project summary task counts as one). They stay in the Microsoft Project file when it is saved again as Microsoft Project XML, but they are not in the P6 data, so an XER or P6 XML made from it does not have them.`, p6: 'P6 activities are the non-summary tasks; a summary task is a WBS element, which the clone does not carry custom values on.' });
  if (cfUnread.length) findings.push({ severity: 'info', code: 'MSP_CUSTOM_FIELD_KIND', message: `${cfUnread.length} Microsoft Project custom field(s) of a kind P6 has no custom field type for (flag, duration, outline code) were not read as P6 custom fields: ${cfUnread.join(', ')}. They stay in the file as they are when it is saved again as Microsoft Project XML.`, p6: 'P6 maps Microsoft Project custom fields only through a template set up by hand; the clone reads those with a P6 equivalent (text, number, cost, date) as P6 custom fields.' });

  return {
    name: val(p, 'Name'), title: val(p, 'Title'), start: rDate('Project', p, 'StartDate'), finish: rDate('Project', p, 'FinishDate'),
    statusDate: rDate('Project', p, 'StatusDate'), calUid: val(p, 'CalendarUID'), minutesPerDay: ctx.minutesPerDay, minutesPerWeek: ctx.minutesPerWeek!,
    splitsInProgress: rFlag('Project', p, 'SplitsInProgressTasks'), criticalHrs: rNum('Project', p, 'CriticalSlackLimit') ?? 0,
    calendars, tasks, resources, assignments, custom,
    keep: { kids: p.children.map((c): [string, string | null] => [c.name, COLLECTIONS.has(c.name) ? null : raw(c)]), ghosts, p6ext: extKey.size > 0, plainCurrency: !!ctx.plainCurrency, cfUsed: [...cfUsed], cfRead: custom.map((c) => c.fieldId) },
    // dates made by P6 (a file the clone wrote from P6): F9 keeps P6's rules; dates made by Microsoft Project: its rule
    // for started tasks, unless the file moves remaining work after the status date (then it is P6's rule too)
    // (a file the clone wrote before it named the rules: P6 5-7 builds leave dates one minute into or before a period)
    rules: p6rules ?? (extKey.size > 0 ? { ver: '', legacy: tasks.some((t) => [t.earlyStart, t.earlyFinish, t.lateStart, t.lateFinish].some((d) => /:(01|59)$/.test(d))), known: true } : { resume: !rFlag('Project', p, 'MoveRemainingStartsForward') }),
  };
  };
  return { split, emit, finish, baselines, onRoot: (r: XNode) => { doc = r; } };
}

// ---------- writer

/** A link read from the file whose type or lag an edit changed: the same element with the new type and lag, in its own
 *  lag format (a percentage lag stays a percentage of the predecessor's duration). */
function relink(xml: string, l: MPred, predHrs: number): string {
  const fmt = Number(/<LagFormat>\s*(\d+)/.exec(xml)?.[1] ?? LAG_FORMAT);
  const lag = writeLag(l.lagHrs, fmt, predHrs);
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
  // the value of an element is the model's: the text is made by values.ts from the type it gives the element of the entity being written
  let ent: Entity = 'Project';
  const wctx: Ctx = { minutesPerDay: m.minutesPerDay, minutesPerWeek: m.minutesPerWeek };
  const el = (tag: string, v: string | number | boolean | null | undefined) => { const x = writeValue(ent, tag, v, wctx); if (x !== '') cur.push([tag, `<${tag}>${esc(x)}</${tag}>`]); };
  const dt = el;
  const now = formatP6Date(Math.floor(Date.now() / 60000));
  const k = keepCtx(db);
  const fromMsp = !!m.keep;
  // the clone's own custom fields (P6 Activity ID, ...) go into a Microsoft Project file only when it has them: in a
  // customer's file, Text1 may be their own field
  const p6ext = !fromMsp || m.keep!.p6ext;
  const ourField = new Set([...TASK_TEXT.map((x) => x[1]), RES_TYPE_FIELD[0]]);
  // the P6 custom fields (custom-fields.ts): the slot of each in a free custom field of its kind, never one of the clone's own fields or
  // one the file this was read from already has
  const ownName = (n: string) => TASK_TEXT.some((x) => x[3] === n) || n === RES_TYPE_FIELD[2] || RULES_ALIAS.test(n);
  const rawDefs = m.keep?.kids.find((x) => x[0] === 'ExtendedAttributes')?.[1] ?? null;
  const oldDefs = rawDefs ? parseXml(rawDefs).children[0].children.filter((c) => c.name === 'ExtendedAttribute').map((c) => ({ fid: val(c, 'FieldID'), alias: val(c, 'Alias'), name: val(c, 'FieldName'), xml: rawDefs.slice(c.s, c.e) })) : [];
  const fileHas = new Set([...(m.keep?.cfUsed ?? []), ...oldDefs.map((d) => d.fid)]);
  // which P6 custom fields have a value in the project being written (a customer's file saved in place gets no definition of one that has none)
  const written = { TASK: new Set(m.tasks.flatMap((t) => (t.row?.task_id ? [t.row.task_id] : []))), RSRC: new Set(m.resources.flatMap((r) => (r.row?.rsrc_id ? [r.row.rsrc_id] : []))) };
  const typeTable = new Map(rows(db, 'UDFTYPE').map((u) => [u.udf_type_id, u.table_name]));
  const valued = new Set(rows(db, 'UDFVALUE').filter((v) => (v.udf_text || v.udf_number || v.udf_date || v.udf_code_id) && written[typeTable.get(v.udf_type_id) as 'TASK' | 'RSRC']?.has(v.fk_id)).map((v) => v.udf_type_id));
  // the revision stamp lives in the rules definition's alias, wherever that definition is (read by its alias text); a file of the clone that never had that definition gets it in
  // the clone's own slot, else in the first custom field of ANY kind (Text, Number, Cost, Start, Finish, Date, Flag, Duration) that the file does not use. With none free the
  // file would be read back as one the old writer made (costs 100 times too low), so it is not written.
  const rulesDef = oldDefs.find((d) => RULES_ALIAS.test(d.alias));
  const stampNew = fromMsp && p6ext && !rulesDef;
  const stampSlot = stampNew ? [{ id: RULES_FIELD[0], name: RULES_FIELD[1] }, ...taskFieldSlots()].find((x) => !fileHas.has(x.id)) : { id: RULES_FIELD[0], name: RULES_FIELD[1] };
  // (m.keep.plainCurrency: the file was read as one of the old writer's, so unstamped it would be read so again)
  if (stampNew && !stampSlot && m.keep?.plainCurrency) throw new MspSaveRefused('msp_no_free_custom_field', `Not saved: this Microsoft Project file has no free custom field left to mark it as written in the current format (${revisionText()}), and without that mark the clone would read its costs back a hundred times too low.`, 'Free one custom field of the tasks in the file (in Microsoft Project, clear its name and values), or save the project as XER or P6 XML.');
  const rulesId = stampSlot?.id;
  // the stamp in a field other than the clone's own Text6 sits in a field of the customer's file: say which, what it is for, and that it stays
  if (stampNew && stampSlot && stampSlot.id !== RULES_FIELD[0]) opts.report?.push(`Microsoft Project field ${stampSlot.name} holds the clone's format mark (its name starts "P6 Schedule Rules"), because ${RULES_FIELD[1]} is already in use in this file. It marks the file as written in the current format (${revisionText()}), so its costs are read correctly; leave ${stampSlot.name} as it is.`);
  if (stampNew && !stampSlot) opts.report?.push(`The clone's format stamp (${revisionText()}) was not written: the file has no free custom field for it. This file is not one of the clone's earlier writer's, so it is read back by Microsoft Project's representation without it.`);
  const cf = planCustomFields(db, { valued, newFile: !fromMsp, reserved: { Task: new Set(fromMsp ? (stampNew && rulesId ? [rulesId] : []) : [...TASK_TEXT.map((x) => x[1]), RULES_FIELD[0]]), Resource: new Set(fromMsp ? [] : [RES_TYPE_FIELD[0]]) }, used: fileHas, own: ownName });
  for (const n of cf.notes) opts.report?.push(n);
  const cfRead = new Set(m.keep?.cfRead ?? []), cfCarried = new Set(cf.fields.map((f) => f.fieldId));
  const cfValue = valueReader(db, cf.fields, wctx);
  const cfTask = cf.fields.filter((f) => f.subject === 'Task'), cfRes = cf.fields.filter((f) => f.subject === 'Resource');
  // A file's own element of a custom field whose value did not change goes back untouched (a lookup-table link, <ValueGUID>, and any other
  // child stays); only the element of a field whose value changed is made anew, and what it drops of the file's element is named in the notes.
  const dropped = new Map<(typeof cf.fields)[number], { row: string; what: string[] }[]>();
  const cfValues = (fields: typeof cf.fields, fk: string, who: { table: 'TASK' | 'RSRC'; row: Row; kept?: Kept; label: string }): [string, string][] => {
    const own = new Map<string, string>();
    for (const [n, x] of who.kept?.kids ?? []) if (n === 'ExtendedAttribute' && x) { const id = /<FieldID>\s*(\d+)\s*<\/FieldID>/.exec(x)?.[1]; if (id) own.set(id, x); }
    const ch = changedSince(who.table, who.row, k), out: [string, string][] = [];
    for (const f of fields) {
      const was = own.get(f.fieldId);
      if (was != null && !ch([`~udf:${f.type.udf_type_id}`])) { out.push(['ExtendedAttribute', was]); continue; }
      if (was != null) {
        const lost = parseXml(was).children[0].children.map((c) => c.name).filter((n) => n !== 'FieldID' && n !== 'Value');
        if (lost.length) { const l = dropped.get(f) ?? []; l.push({ row: who.label, what: lost }); dropped.set(f, l); }
      }
      const v = cfValue(f, fk);
      if (v != null) out.push(['ExtendedAttribute', `<ExtendedAttribute><FieldID>${f.fieldId}</FieldID><Value>${esc(v)}</Value></ExtendedAttribute>`]);
    }
    return out;
  };
  const cfDef = (f: (typeof cf.fields)[number]) => `<ExtendedAttribute><FieldID>${f.fieldId}</FieldID><FieldName>${f.fieldName}</FieldName><Alias>${esc(f.alias)}</Alias></ExtendedAttribute>`;
  // a file's own custom field elements go back as they were, except the P6 custom fields read from it (written anew from the fields)
  const ownIds = p6ext ? ourField : new Set<string>();
  const notOurs = (n: string, x: string) => { const id = /<FieldID>\s*(\d+)\s*<\/FieldID>/.exec(x)?.[1] ?? ''; return n === 'ExtendedAttribute' && !ownIds.has(id) && !cfRead.has(id) && !cfCarried.has(id); };
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
  ent = 'Project';
  el('SaveVersion', 14);
  el('Name', m.name);
  el('Title', m.title);
  el('Author', 'Primavera P6 Clone');
  dt('CreationDate', now);
  dt('LastSaved', now);
  el('ScheduleFromStart', 1);
  dt('StartDate', m.start);
  dt('FinishDate', m.finish || m.start);
  el('CriticalSlackLimit', m.criticalHrs);
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
  el('SplitsInProgressTasks', m.splitsInProgress ?? true);
  el('WeekStartDay', 1);
  dt('StatusDate', m.statusDate);
  el('NewTaskStartDate', 0);
  const pr = m.row ?? {};
  const rules = !stampSlot ? '' : `<ExtendedAttribute><FieldID>${rulesId}</FieldID><FieldName>${stampSlot.name}</FieldName><Alias>${esc(rulesAlias(pr._p6_ver || db.header?.version || '', pr._legacy_ms ? pr._legacy_ms === 'Y' : isLegacyLayout(db)))}</Alias></ExtendedAttribute>`;
  let defsChanged = false;
  if (!fromMsp) proj.push(['ExtendedAttributes', `<ExtendedAttributes>${TASK_TEXT.map(([, id, name, alias]) => `<ExtendedAttribute><FieldID>${id}</FieldID><FieldName>${name}</FieldName><Alias>${alias}</Alias></ExtendedAttribute>`).join('')}<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><FieldName>${RES_TYPE_FIELD[1]}</FieldName><Alias>${RES_TYPE_FIELD[2]}</Alias></ExtendedAttribute>${rules}${cf.fields.map(cfDef).join('')}</ExtendedAttributes>`]);
  else {
    // a file's definitions go back as they were; a P6 custom field read from it that was since deleted (or changed kind) goes, one renamed
    // takes its new name, and the fields added since come after them
    const byId = new Map(cf.fields.map((f) => [f.fieldId, f]));
    const out: string[] = [];
    // the name the field was given when it was read: the file's own alias (or its Microsoft Project name), with a suffix where two aliases
    // differ only by case; only a name the user changed since is written back
    const readName = (f: (typeof cf.fields)[number], alias: string) => f.type._msp_name || alias || f.fieldName;
    for (const d of oldDefs) {
      const f = byId.get(d.fid);
      if (!f && cfRead.has(d.fid)) { defsChanged = true; continue; }
      if (f && cfRead.has(d.fid) && f.alias !== readName(f, d.alias)) { defsChanged = true; out.push(/<Alias>/.test(d.xml) ? d.xml.replace(/<Alias>[\s\S]*?<\/Alias>/, `<Alias>${esc(f.alias)}</Alias>`) : d.xml.replace(/<\/ExtendedAttribute>\s*$/, `<Alias>${esc(f.alias)}</Alias></ExtendedAttribute>`)); continue; }
      // a file of the clone from before the revision stamp: stamped now, as its currency is written as Microsoft Project stores it from here on
      if (d === rulesDef && !d.alias.endsWith(`, ${revisionText()}`)) { defsChanged = true; out.push(d.xml.replace(/<Alias>[\s\S]*?<\/Alias>/, `<Alias>${esc(d.alias.replace(/(, format \d+)?$/, `, ${revisionText()}`))}</Alias>`)); continue; }
      out.push(d.xml);
    }
    if (stampNew && stampSlot) { out.push(rules); defsChanged = true; }
    const have = new Set(oldDefs.map((d) => d.fid));
    for (const f of cf.fields) if (!have.has(f.fieldId) && (!cfRead.has(f.fieldId) || f.alias !== readName(f, ''))) { out.push(cfDef(f)); defsChanged = true; }
    if (defsChanged) proj.push(['ExtendedAttributes', `<ExtendedAttributes>${out.join('')}</ExtendedAttributes>`]);
  }

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
    ent = 'Task';
    el('UID', t.uid);
    el('ID', t.id);
    el('Name', t.name);
    el('Type', t.type ?? 1);
    el('IsNull', false);
    if (t.summary) el('WBS', t.wbs);
    el('OutlineNumber', t.outline);
    el('OutlineLevel', t.level);
    el('Priority', 500);
    dt('Start', t.start);
    dt('Finish', t.finish);
    el('Duration', t.summary ? 0 : t.durHrs ?? 0);
    el('DurationFormat', 7);
    el('EffortDriven', false);
    el('Estimated', false);
    el('Milestone', t.milestone);
    el('Summary', t.summary);
    if (!t.summary) {
      if (t.critical != null) el('Critical', t.critical);
      dt('EarlyStart', t.earlyStart);
      dt('EarlyFinish', t.earlyFinish);
      dt('LateStart', t.lateStart);
      dt('LateFinish', t.lateFinish);
      el('FreeSlack', t.freeSlackHrs);
      el('TotalSlack', t.totalSlackHrs);
      el('PercentComplete', t.pct ?? 0);
      dt('ActualStart', t.actualStart);
      dt('ActualFinish', t.actualFinish);
      el('RemainingDuration', t.remHrs ?? t.durHrs ?? 0);
      el('ConstraintType', t.constraintType ?? 0);
      el('CalendarUID', t.calUid || -1);
      if (t.constraintType && t.constraintType > 1) dt('ConstraintDate', t.constraintDate);
      dt('Deadline', t.deadline);
      el('IgnoreResourceCalendar', t.ignoreRsrcCal ?? true);
      const ourLink = (l: MPred) => `<PredecessorLink><PredecessorUID>${esc(l.uid)}</PredecessorUID><Type>${['FF', 'FS', 'SF', 'SS'].indexOf(l.type)}</Type><CrossProject>0</CrossProject><LinkLag>${writeLag(l.lagHrs)}</LinkLag><LagFormat>${LAG_FORMAT}</LagFormat></PredecessorLink>`;
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
      if (t.row) cur.push(...cfValues(cfTask, t.row.task_id, { table: 'TASK', row: t.row, kept: t.keep, label: t.row.task_code }));
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
    if (started) for (const c of cur) if (c[0] === 'EarlyStart' || c[0] === 'LateStart') c[1] = `<${c[0]}>${writeValue('Task', c[0], t.actualStart, wctx)}</${c[0]}>`;
    // the clone's saved baselines, unless the file's own <Baseline> elements are kept for this task
    if (t.row && blNumbers.size && !t.keep?.kids.some((x) => x[0] === 'Baseline')) for (const x of baselineXml(db, blNumbers, t.row, wctx)) cur.push(['Baseline', x]);
    return element('Task', t.keep, t.row, 'TASK', { ...TASK_DEPS, ...datesDeps, WBS: () => moved && !masked, ExtendedAttribute: () => (p6ext && ch(P6_FIELDS)) || ch(['~udf']) }, notOurs);
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
    ent = 'Resource';
    el('UID', r.uid);
    el('ID', r.id);
    el('Name', r.name);
    el('Type', r.type === 'material' ? 0 : r.type === 'cost' ? 2 : 1);
    el('IsNull', false);
    el('Code', r.code);
    if (r.type !== 'material') el('MaxUnits', r.maxUnits ?? 1);
    el('StandardRate', r.rate ?? 0);
    el('StandardRateFormat', RATE_PER_HOUR);
    el('OvertimeRate', 0);
    el('OvertimeRateFormat', RATE_PER_HOUR);
    el('CalendarUID', resCal.get(r.uid));
    if (r.p6Type && p6ext) cur.push(['ExtendedAttribute', `<ExtendedAttribute><FieldID>${RES_TYPE_FIELD[0]}</FieldID><Value>${esc(r.p6Type)}</Value></ExtendedAttribute>`]);
    if (r.row) cur.push(...cfValues(cfRes, r.row.rsrc_id, { table: 'RSRC', row: r.row, kept: r.keep, label: r.name }));
    const ch = r.row ? changedSince('RSRC', r.row, k) : () => true;
    return element('Resource', r.keep, r.row, 'RSRC', { ...RES_DEPS, ...(reusedCal.has(r.uid) ? { CalendarUID: () => false } : {}), ExtendedAttribute: () => (p6ext && ch(['rsrc_type'])) || ch(['~udf']) }, notOurs);
  };
  { const r = withGhosts(m.resources.map((r, i) => ({ seq: seqOf(r, i), xml: () => resXml(r) })), ghosts.resources); r.unshift('<Resources>'); r.push('</Resources>'); proj.push(['Resources', section(r)]); }

  // a file of the clone from before the revision stamp holds plain currency in the assignments' elements: all three are written anew
  const asgDeps = m.keep?.plainCurrency ? { ...ASG_DEPS, Cost: () => true, ActualCost: () => true, RemainingCost: () => true } : ASG_DEPS;
  const materialUids = new Set(m.resources.filter((r) => r.type === 'material').map((r) => r.uid));
  const asgXml = (a: MProject['assignments'][number]) => {
    cur = [];
    ent = 'Assignment';
    el('UID', a.uid);
    el('TaskUID', a.taskUid);
    el('ResourceUID', a.resUid);
    el('ActualCost', a.actualCost);
    dt('ActualFinish', a.actualFinish);
    dt('ActualStart', a.actualStart);
    el('ActualWork', a.actualWorkHrs);
    el('Cost', a.cost);
    dt('Finish', a.finish);
    el('RemainingCost', a.remainingCost);
    el('RemainingWork', a.remainingWorkHrs);
    dt('Start', a.start);
    el('Units', a.units);
    el('Work', a.workHrs);
    // a material's Units are its quantity (values.ts): they follow the quantity (and a file of the clone from before wrote them as a fraction per hour)
    return element('Assignment', a.keep, a.row, 'TASKRSRC', materialUids.has(a.resUid) ? { ...asgDeps, Units: m.keep?.plainCurrency ? () => true : [...(ASG_DEPS.Units as string[]), ...WORK] } : asgDeps);
  };
  // a kept assignment goes with its task; a task's "unassigned" placeholder (resource -65535) goes once an edit assigns
  // a resource to it (Microsoft Project keeps the placeholder only while a task has no resource)
  const assigned = new Set(m.assignments.filter((a) => !a.keep).map((a) => a.taskUid));
  const keptAsg = ghosts.assignments.filter((g) => { const tu = tag(g.xml, 'TaskUID'); return !tu || (taskUids.has(tu) && !(tag(g.xml, 'ResourceUID') === '-65535' && assigned.has(tu))); });
  { const r = withGhosts(m.assignments.map((a, i) => ({ seq: seqOf(a, i), xml: () => asgXml(a) })), keptAsg); r.unshift('<Assignments>'); r.push('</Assignments>'); proj.push(['Assignments', section(r)]); }

  for (const [f, l] of dropped) opts.report?.push(`Custom field "${f.alias}": the value on ${l.map((x) => `${f.subject === 'Task' ? 'activity' : 'resource'} "${x.row}"`).join(', ')} was edited, so it is written as a plain value; the lookup-table link the file held for it (${[...new Set(l.flatMap((x) => x.what))].join(', ')}) was dropped.`);
  const longNote = longTextNote(cfValue.long);
  if (longNote) opts.report?.push(longNote);
  const notNumber = notNumberNote(cfValue.notNumber);
  if (notNumber) opts.report?.push(notNumber);
  if (followed.length) opts.report?.push(`This file has no WBS code mask, so Microsoft Project's WBS code is the outline number: the WBS of ${followed.length} moved task(s) follows the new place: ${followed.slice(0, 20).join('; ')}.`);
  const body = m.keep && m.row ? mergeKids(m.keep.kids, proj, { ...PROJECT_DEPS, ExtendedAttributes: () => defsChanged }, changedSince('PROJECT', m.row, k), ORDER.Project) : proj.map((x) => x[1]).join('\n');
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
