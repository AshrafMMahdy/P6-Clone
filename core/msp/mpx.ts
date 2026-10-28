// Microsoft Project MPX 4.0 (record-based text) import/export.
//
// Record numbers follow the published MPX 4.0 layout (as also implemented by MPXJ):
//   MPX header line ("MPX,<program>,4.0,ANSI"; the character after "MPX" is the field delimiter)
//   10 currency settings, 11 default settings, 12 date/time settings,
//   20 base calendar definition, 25 base calendar hours, 26 base calendar exception,
//   30 project header, 40/41 resource model (field names / field numbers), 50 resource,
//   55/56/57 resource calendar definition/hours/exception, 60/61 task model (names / numbers),
//   70 task, 71 task notes, 75 resource assignment.
// Assumptions where the spec is not at hand (documented so they can be checked against a real file):
//   - Task field numbers: 1 Name, 2 WBS, 3 Outline Level, 4..13 Text1..Text10, 40 Duration, 43 Remaining Duration,
//     44 % Complete, 50 Start, 51 Finish, 52/53 Early Start/Finish, 54/55 Late Start/Finish, 58/59 Actual Start/Finish,
//     68 Constraint Date, 70 Predecessors (by ID), 74 Unique ID Predecessors, 90 ID, 91 Constraint Type,
//     93 Free Slack, 94 Total Slack, 98 Unique ID, 99 Outline Number, 121 Milestone.
//   - Resource field numbers: 1 Name, 2 Initials, 4 Code, 5 Text1, 40 ID, 41 Max Units, 42 Standard Rate,
//     48 Base Calendar, 49 Unique ID.
//   - Record 75 fields: Resource ID, Units, Work, Baseline Work, Actual Work, Overtime Work, Cost, Baseline Cost,
//     Actual Cost, Start, Finish, Delay, Resource Unique ID. Units "250%" or 2.5 (fraction) are both read.
//   - Constraint Type is written as its number (0 ASAP .. 7 FNLT); names ("Start No Earlier Than") are also read.
//   - MPX 4.0 has no task calendars and no status date: the clone writes the activity calendar name in Text4
//     and the P6 data date as the project "Current Date". P6 values (Activity ID, activity type, P6 constraint
//     codes, secondary constraint, duration type) travel in Text1..Text6; they are read back only from files whose
//     project Keywords carry the P6CLONE marker, so Text fields of other MPX files are left alone.
//   - Durations are written in hours ("40h"); d/w/mo units are read with record 11's hours per day/week.
//   - At most three working periods per day exist in MPX; extra P6 shifts are merged into the third period.
import type { Db } from '../db.ts';
import type { Finding } from '../findings.ts';
import type { Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../dates.ts';
import { p6num } from '../schedule/cpm.ts';
import { defaultShifts, emptyTask, projectFromDb, projectToDb, type MAssign, type MCal, type MPred, type MProject, type MRes, type MTask, type P6Extra, type RelType } from './shared.ts';

const MARKER = 'P6CLONE: Text1=Activity ID, Text2=Activity Type, Text3=Constraint, Text4=Calendar, Text5=Secondary Constraint, Text6=Duration Type';

const TASK_FIELDS = { name: 1, wbs: 2, level: 3, text1: 4, text2: 5, text3: 6, text4: 7, text5: 8, text6: 9, duration: 40, remaining: 43, pct: 44, start: 50, finish: 51, earlyStart: 52, earlyFinish: 53, lateStart: 54, lateFinish: 55, actualStart: 58, actualFinish: 59, constraintDate: 68, preds: 70, uidPreds: 74, id: 90, constraintType: 91, freeSlack: 93, totalSlack: 94, uid: 98, outline: 99, milestone: 121 };
const TASK_NAMES: Record<string, number> = {
  'name': 1, 'wbs': 2, 'outline level': 3, 'notes': 14, 'duration': 40, 'remaining duration': 43, '% complete': 44, 'percent complete': 44, 'start': 50, 'finish': 51,
  'early start': 52, 'early finish': 53, 'late start': 54, 'late finish': 55, 'actual start': 58, 'actual finish': 59, 'constraint date': 68, 'predecessors': 70,
  'unique id predecessors': 74, 'id': 90, 'constraint type': 91, 'free slack': 93, 'total slack': 94, 'unique id': 98, 'outline number': 99, 'milestone': 121,
};
for (let i = 1; i <= 10; i++) TASK_NAMES[`text${i}`] = 3 + i;
const RES_FIELDS = { name: 1, initials: 2, code: 4, text1: 5, id: 40, maxUnits: 41, rate: 42, calendar: 48, uid: 49 };
const RES_NAMES: Record<string, number> = { 'name': 1, 'initials': 2, 'code': 4, 'text1': 5, 'id': 40, 'max units': 41, 'standard rate': 42, 'base calendar': 48, 'unique id': 49 };
const CSTR_NAMES = ['as soon as possible', 'as late as possible', 'must start on', 'must finish on', 'start no earlier than', 'start no later than', 'finish no earlier than', 'finish no later than'];

// ---------- record tokenizer

/** Split MPX text into records (arrays of fields). Quoted fields may contain the delimiter, "" and newlines. */
export function mpxRecords(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let rec: string[] = [], cur = '', q = false, quoted = false;
  const endField = () => { rec.push(quoted ? cur : cur.trim()); cur = ''; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"' && cur.trim() === '') { q = true; quoted = true; cur = ''; }
    else if (c === delim) endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endField();
      if (rec.some((f) => f !== '')) out.push(rec);
      rec = [];
    } else cur += c;
  }
  endField();
  if (rec.some((f) => f !== '')) out.push(rec);
  return out;
}

// ---------- parser

export function parseMpx(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const empty: Db = { tables: {} };
  const src = text.replace(/^﻿/, '');
  if (!/^MPX[^\w\s]/.test(src)) {
    findings.push({ severity: 'fatal', code: 'MPX_HEADER', message: 'File does not start with an "MPX" header record.', p6: 'P6 rejects the file: not an MPX file.' });
    return { db: empty, findings };
  }
  try {
    const m = readMpx(src, findings);
    if (!m.tasks.length) findings.push({ severity: 'warning', code: 'MSP_NO_TASKS', message: 'The MPX file contains no tasks.', p6: 'P6 imports an empty project.' });
    return { db: projectToDb(m, findings, 'The MPX file'), findings };
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'MPX_READ', message: `Could not read the MPX file: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db: empty, findings };
  }
}

function readMpx(text: string, findings: Finding[]): MProject {
  const delim = text[3];
  const recs = mpxRecords(text, delim);
  let decimal = '.', thousands = ',', currency = '$';
  let hpd = 8, hpw = 40, dateOrder = 0, pmText = 'pm', amText = 'am';
  let splits: boolean | null = null;
  const m: MProject = { name: '', title: '', start: '', finish: '', statusDate: '', calUid: '', minutesPerDay: 480, minutesPerWeek: 2400, splitsInProgress: null, criticalHrs: 0, calendars: [], tasks: [], resources: [], assignments: [] };
  const calByName = new Map<string, MCal>();
  let cal: MCal | null = null;
  let taskModel: number[] | null = null, resModel: number[] | null = null;
  let task: MTask | null = null, res: MRes | null = null;
  let marked = false, projCalName = '';
  const resCalName = new Map<MRes, string>();
  const idPreds: { t: MTask; v: string }[] = [];
  const asgResId: { a: MAssign; id: string }[] = [];

  const numv = (s: string | undefined): number | null => {
    if (s == null) return null;
    let v = s.trim().replace(currency, '');
    if (!v) return null;
    if (thousands && thousands !== decimal) v = v.split(thousands).join('');
    if (decimal !== '.') v = v.replace(decimal, '.');
    v = v.replace(/[%\s]/g, '');
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const durH = (s: string | undefined): number | null => {
    if (!s || !s.trim()) return null;
    const mm = /^(-?[\d.,]+)\s*(e?)(mo|m|h|d|w|y|%)?\??$/i.exec(s.trim());
    if (!mm) return null;
    const v = numv(mm[1]);
    if (v == null) return null;
    const el = !!mm[2], u = (mm[3] ?? 'd').toLowerCase();
    const f = el ? { m: 1 / 60, h: 1, d: 24, w: 168, mo: 720, y: 8760, '%': 0 }[u] : { m: 1 / 60, h: 1, d: hpd, w: hpw, mo: hpd * 20, y: hpd * 260, '%': 0 }[u];
    return v * (f ?? hpd);
  };
  const date = (s: string | undefined): string => {
    if (!s || !s.trim() || /^na$/i.test(s.trim())) return '';
    const mm = /^\s*(\d{1,4})\D(\d{1,2})\D(\d{1,4})(?:\s+(\d{1,2})(?:[:.](\d{2}))?\s*([a-z.]+)?)?/i.exec(s);
    if (!mm) return '';
    let y: number, mo: number, d: number;
    const [a, b, c] = [+mm[1], +mm[2], +mm[3]];
    if (dateOrder === 2 || mm[1].length === 4) { y = a; mo = b; d = c; } else if (dateOrder === 1) { d = a; mo = b; y = c; } else { mo = a; d = b; y = c; }
    if (y < 100) y += y >= 50 ? 1900 : 2000;
    let h = mm[4] ? +mm[4] : 0;
    const min = mm[5] ? +mm[5] : 0;
    const ap = (mm[6] ?? '').toLowerCase();
    if (ap && ap === pmText.toLowerCase() && h < 12) h += 12;
    if (ap && ap === amText.toLowerCase() && h === 12) h = 0;
    const t = parseP6Date(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
    return t == null ? '' : formatP6Date(t);
  };
  const time = (s: string | undefined, isEnd: boolean): number | null => {
    const mm = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*([a-z.]+)?/i.exec(s ?? '');
    if (!mm) return null;
    let h = +mm[1];
    const ap = (mm[3] ?? '').toLowerCase();
    if (ap && ap === pmText.toLowerCase() && h < 12) h += 12;
    if (ap && ap === amText.toLowerCase() && h === 12) h = 0;
    const v = h * 60 + (mm[2] ? +mm[2] : 0);
    return isEnd && (v === 0 || v >= 1440) ? 1440 : v;
  };
  const shifts = (f: string[], from: number): Shift[] => {
    const out: Shift[] = [];
    for (let i = from; i + 1 < f.length && i < from + 6; i += 2) {
      const s = time(f[i], false), e = time(f[i + 1], true);
      if (s != null && e != null && e > s) out.push({ start: s, end: e });
    }
    return out.sort((x, y) => x.start - y.start);
  };
  const yes = (s: string | undefined) => /^(yes|y|1|true)$/i.test((s ?? '').trim());
  const addException = (c: MCal, f: string[]) => {
    const a = parseP6Date(date(f[1])), b = parseP6Date(date(f[2]) || date(f[1]));
    if (a == null || b == null) return;
    const working = yes(f[3]);
    let ss = working ? shifts(f, 4) : [];
    if (working && !ss.length) ss = defaultShifts();
    for (let d = minutesToSerial(a); d <= Math.min(minutesToSerial(b), minutesToSerial(a) + 20000); d++) c.exceptions.set(d, ss.map((x) => ({ ...x })));
  };
  const newCal = (name: string, isBase: boolean, days: string[], baseName?: string): MCal => {
    const c: MCal = { uid: String(m.calendars.length + 1), name: name || `Calendar ${m.calendars.length + 1}`, isBase, week: [null, null, null, null, null, null, null], exceptions: new Map() };
    if (baseName) c.baseUid = calByName.get(baseName.toLowerCase())?.uid;
    days.forEach((d, i) => { if (i < 7) { const v = d.trim(); c.week[i] = v === '0' ? [] : v === '1' ? defaultShifts() : isBase ? (i === 0 || i === 6 ? [] : defaultShifts()) : null; } });
    for (let i = days.length; i < 7; i++) if (isBase) c.week[i] = i === 0 || i === 6 ? [] : defaultShifts();
    m.calendars.push(c);
    if (!calByName.has(c.name.toLowerCase())) calByName.set(c.name.toLowerCase(), c);
    return c;
  };
  const model = (f: string[], names: Record<string, number> | null) => f.slice(1).filter((x) => x !== '').map((x) => (names ? names[x.trim().toLowerCase()] ?? -1 : Number(x)));

  for (const f of recs) {
    const rt = f[0].trim();
    switch (rt) {
      case '10': currency = f[1] ?? '$'; thousands = f[4] ?? ','; decimal = f[5] || '.'; break;
      case '11': hpd = numv(f[4]) || 8; hpw = numv(f[5]) || hpd * 5; if (f[9] != null && f[9] !== '') splits = yes(f[9]); break;
      case '12': dateOrder = Number(f[1]) || 0; amText = f[6] || 'am'; pmText = f[7] || 'pm'; break;
      case '20': cal = newCal(f[1] ?? '', true, f.slice(2, 9)); break;
      case '25': case '56': {
        const c = rt === '25' ? cal : res ? m.calendars.find((x) => x.name === `${res!.name}`) ?? null : null;
        const d = Number(f[1]);
        if (c && d >= 1 && d <= 7) c.week[d - 1] = shifts(f, 2);
        break;
      }
      case '26': if (cal) addException(cal, f); break;
      case '57': { const c = res ? m.calendars.find((x) => x.name === res!.name) : undefined; if (c) addException(c, f); break; }
      case '30':
        m.title = f[1] ?? ''; projCalName = f[4] ?? ''; m.start = date(f[5]); m.finish = date(f[6]); m.statusDate = date(f[8]);
        m.name = f[27] || f[1] || ''; marked = (f[29] ?? '').startsWith('P6CLONE');
        break;
      case '40': resModel = model(f, RES_NAMES); break;
      case '41': resModel = model(f, null); break;
      case '60': taskModel = model(f, TASK_NAMES); break;
      case '61': taskModel = model(f, null); break;
      case '50': {
        const mod = resModel ?? [RES_FIELDS.id, RES_FIELDS.name];
        const v = (n: number) => { const i = mod.indexOf(n); return i >= 0 ? f[i + 1] ?? '' : ''; };
        const uid = v(RES_FIELDS.uid) || v(RES_FIELDS.id) || String(m.resources.length + 1);
        let rate = numv(v(RES_FIELDS.rate).split('/')[0]);
        const per = (v(RES_FIELDS.rate).split('/')[1] ?? 'h').trim().toLowerCase();
        if (rate != null) rate = per.startsWith('mo') ? rate / (hpd * 20) : per.startsWith('m') ? rate * 60 : per.startsWith('d') ? rate / hpd : per.startsWith('w') ? rate / hpw : per.startsWith('y') ? rate / (hpd * 260) : rate;
        const mu = v(RES_FIELDS.maxUnits);
        const maxUnits = numv(mu);
        res = { uid, id: numv(v(RES_FIELDS.id)) ?? m.resources.length + 1, name: v(RES_FIELDS.name), code: v(RES_FIELDS.code) || v(RES_FIELDS.initials), type: 'work', maxUnits: maxUnits == null ? null : mu.includes('%') ? maxUnits / 100 : maxUnits, rate, calUid: '', p6Type: marked ? v(RES_FIELDS.text1) || undefined : undefined };
        if (res.p6Type === 'RT_Mat') res.type = 'material';
        if (v(RES_FIELDS.calendar)) resCalName.set(res, v(RES_FIELDS.calendar));
        m.resources.push(res);
        task = null;
        break;
      }
      case '55': if (res) { const c = newCal(res.name, false, f.slice(2, 9), f[1]); res.calUid = c.uid; resCalName.delete(res); } break;
      case '70': {
        if (!taskModel) { findings.push({ severity: 'warning', code: 'MPX_NO_TASK_MODEL', message: 'Task records appear before a task model record (60/61); the clone default field order was assumed.', p6: 'P6 cannot map task fields without the model record.' }); taskModel = Object.values(TASK_FIELDS); }
        const mod = taskModel;
        const v = (n: number) => { const i = mod.indexOf(n); return i >= 0 ? f[i + 1] ?? '' : ''; };
        const id = numv(v(TASK_FIELDS.id)) ?? m.tasks.length + 1;
        const t = emptyTask(v(TASK_FIELDS.uid) || String(id), id);
        const F = TASK_FIELDS;
        t.name = v(F.name); t.wbs = v(F.wbs); t.outline = v(F.outline);
        t.level = numv(v(F.level)) ?? (t.outline ? t.outline.split('.').length : 1);
        t.durHrs = durH(v(F.duration)); t.remHrs = durH(v(F.remaining)); t.pct = numv(v(F.pct));
        t.start = date(v(F.start)); t.finish = date(v(F.finish)); t.earlyStart = date(v(F.earlyStart)); t.earlyFinish = date(v(F.earlyFinish));
        t.lateStart = date(v(F.lateStart)); t.lateFinish = date(v(F.lateFinish)); t.actualStart = date(v(F.actualStart)); t.actualFinish = date(v(F.actualFinish));
        const ct = v(F.constraintType).trim();
        t.constraintType = ct === '' ? null : /^\d+$/.test(ct) ? Number(ct) : CSTR_NAMES.indexOf(ct.toLowerCase());
        t.constraintDate = date(v(F.constraintDate));
        t.totalSlackHrs = durH(v(F.totalSlack)); t.freeSlackHrs = durH(v(F.freeSlack));
        t.milestone = yes(v(F.milestone));
        if (marked) {
          const x: P6Extra = { activityId: v(F.text1) || undefined, taskType: v(F.text2) || undefined, cstr: v(F.text3) || undefined, calName: v(F.text4) || undefined, cstr2: v(F.text5) || undefined, durType: v(F.text6) || undefined };
          if (x.taskType === 'WBS') { t.summary = true; x.taskType = undefined; }
          t.extra = x;
        }
        const up = v(F.uidPreds), ip = v(F.preds);
        if (up) t.preds = parsePreds(up, durH, findings, t);
        else if (ip) idPreds.push({ t, v: ip });
        m.tasks.push(t);
        task = t; res = null;
        break;
      }
      case '75': {
        if (!task) break;
        const work = durH(f[3]);
        const u = (f[2] ?? '').trim();
        const units = numv(u);
        const a: MAssign = {
          uid: String(m.assignments.length + 1), taskUid: task.uid, resUid: (f[13] ?? '').trim(), units: units == null ? null : u.includes('%') ? units / 100 : units,
          workHrs: work, actualWorkHrs: durH(f[5]), remainingWorkHrs: work != null ? Math.max(0, work - (durH(f[5]) ?? 0)) : null,
          cost: numv(f[7]), actualCost: numv(f[9]), remainingCost: numv(f[7]) != null ? Math.max(0, (numv(f[7]) ?? 0) - (numv(f[9]) ?? 0)) : null,
          start: date(f[10]), finish: date(f[11]), actualStart: '', actualFinish: '',
        };
        if (!a.resUid) asgResId.push({ a, id: (f[1] ?? '').trim() });
        m.assignments.push(a);
        break;
      }
      default: break;
    }
  }
  // Resolve references made by name / ID
  for (const [r, name] of resCalName) r.calUid = calByName.get(name.toLowerCase())?.uid ?? '';
  for (const t of m.tasks) if (t.extra.calName) t.calUid = calByName.get(t.extra.calName.toLowerCase())?.uid ?? '';
  const uidById = new Map(m.tasks.map((t) => [String(t.id), t.uid]));
  for (const { t, v } of idPreds) t.preds = parsePreds(v, durH, findings, t).map((p) => ({ ...p, uid: uidById.get(p.uid) ?? `?${p.uid}` }));
  const resById = new Map(m.resources.map((r) => [String(r.id), r.uid]));
  for (const { a, id } of asgResId) a.resUid = resById.get(id) ?? '';
  const byUid = new Map(m.tasks.map((t) => [t.uid, t]));
  for (const t of m.tasks) for (const l of t.preds) if (l.lagPct != null) l.lagHrs = (l.lagPct / 100) * (byUid.get(l.uid)?.durHrs ?? 0);
  m.calUid = calByName.get(projCalName.toLowerCase())?.uid ?? m.calendars.find((c) => c.isBase)?.uid ?? '';
  m.minutesPerDay = Math.round(hpd * 60);
  m.minutesPerWeek = Math.round(hpw * 60);
  m.splitsInProgress = splits;
  return m;
}

function parsePreds(s: string, durH: (s: string) => number | null, findings: Finding[], t: MTask) {
  const out: MPred[] = [];
  for (const part of s.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const mm = /^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(.+))?$/i.exec(p);
    if (!mm) { findings.push({ severity: 'warning', code: 'MPX_BAD_PREDECESSOR', table: 'TASKPRED', key: t.uid, message: `Task "${t.name}": predecessor "${p}" not understood; dropped.`, p6: 'P6 drops links it cannot read.' }); continue; }
    const type = (mm[2]?.toUpperCase() ?? 'FS') as RelType;
    const sign = mm[3] === '-' ? -1 : 1;
    if (mm[4] && mm[4].trim().endsWith('%')) { out.push({ uid: mm[1], type, lagHrs: 0, lagPct: sign * Number(mm[4].trim().slice(0, -1)), lagFile: { value: `${mm[3] ?? ''}${mm[4].trim()}`, format: '%' } }); continue; }
    const lag = mm[4] ? durH(mm[4]) : 0;
    out.push({ uid: mm[1], type, lagHrs: sign * (lag ?? 0) });
  }
  return out;
}

// ---------- writer

export function writeMpx(db: Db, opts: { projIds?: string[] } = {}): string {
  const m = projectFromDb(db, opts.projIds);
  const D = ',';
  const q = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  const rec = (...f: (string | number | null | undefined)[]) => {
    while (f.length > 1 && (f[f.length - 1] == null || f[f.length - 1] === '')) f.pop();
    lines.push(f.map(q).join(D));
  };
  const date = (s: string) => { const t = parseP6Date(s); return t == null ? '' : formatP6Date(t).replace(/-/g, '/'); };
  const day = (serial: number) => formatP6Date(serialToMinutes(serial)).slice(0, 10).replace(/-/g, '/');
  const hm = (x: number) => `${String(Math.floor((x % 1440) / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  const three = (ss: Shift[]): Shift[] => (ss.length <= 3 ? ss : [ss[0], ss[1], { start: ss[2].start, end: ss[ss.length - 1].end }]);
  const times = (ss: Shift[]) => three(ss).flatMap((s) => [hm(s.start), hm(s.end)]);
  const dur = (h: number | null) => (h == null ? '' : `${p6num(h)}h`);
  const hpd = m.minutesPerDay / 60, hpw = m.minutesPerWeek / 60;

  lines.push(['MPX', 'Microsoft Project for Windows', '4.0', 'ANSI'].join(D));
  rec(10, '$', 1, 2, ',', '.');
  rec(11, 1, 1, 1, p6num(hpd), p6num(hpw), '0/h', '0/h', 1, m.splitsInProgress === false ? 0 : 1);
  rec(12, 2, 1, 480, '/', ':', 'am', 'pm', 20, 20);

  const calName = new Map(m.calendars.map((c) => [c.uid, c.name]));
  for (const c of m.calendars) {
    rec(20, c.name, ...c.week.map((ss) => (ss && ss.length ? 1 : 0)));
    c.week.forEach((ss, i) => { if (ss && ss.length) rec(25, i + 1, ...times(ss)); });
    const days = [...c.exceptions.entries()].sort((x, y) => x[0] - y[0]);
    const ranges: { from: number; to: number; ss: Shift[] }[] = [];
    for (const [d, ss] of days) {
      const last = ranges[ranges.length - 1];
      if (last && last.to === d - 1 && JSON.stringify(last.ss) === JSON.stringify(ss)) last.to = d;
      else ranges.push({ from: d, to: d, ss });
    }
    for (const r of ranges) rec(26, day(r.from), day(r.to), r.ss.length ? 1 : 0, ...times(r.ss));
  }

  rec(30, m.title, '', '', calName.get(m.calUid) ?? '', date(m.start), date(m.finish || m.start), 0, date(m.statusDate), '',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', m.name, 'Primavera P6 Clone', MARKER);

  const R = RES_FIELDS;
  const resModel = [R.id, R.uid, R.name, R.code, R.text1, R.maxUnits, R.rate, R.calendar];
  rec(41, ...resModel);
  for (const r of m.resources) {
    rec(50, r.id, r.uid, r.name, r.code, r.p6Type ?? '', `${p6num((r.maxUnits ?? 1) * 100)}%`, `${p6num(r.rate ?? 0)}/h`, calName.get(r.calUid) ?? '');
  }

  const F = TASK_FIELDS;
  const taskModel = [F.id, F.uid, F.name, F.level, F.outline, F.wbs, F.text1, F.text2, F.text3, F.text4, F.text5, F.text6, F.duration, F.remaining, F.pct,
    F.start, F.finish, F.earlyStart, F.earlyFinish, F.lateStart, F.lateFinish, F.actualStart, F.actualFinish, F.constraintType, F.constraintDate, F.uidPreds,
    F.freeSlack, F.totalSlack, F.milestone];
  rec(61, ...taskModel);
  const asgByTask = new Map<string, MAssign[]>();
  for (const a of m.assignments) { let l = asgByTask.get(a.taskUid); if (!l) asgByTask.set(a.taskUid, (l = [])); l.push(a); }
  const resId = new Map(m.resources.map((r) => [r.uid, r.id]));
  for (const t of m.tasks) {
    const preds = t.preds.map((p) => `${p.uid}${p.type === 'FS' && !p.lagHrs ? '' : p.type}${p.lagHrs ? (p.lagHrs > 0 ? '+' : '-') + p6num(Math.abs(p.lagHrs)) + 'h' : ''}`).join(',');
    if (t.summary) {
      rec(70, t.id, t.uid, t.name, t.level, t.outline, t.wbs, '', 'WBS', '', '', '', '', dur(0), dur(0), '0%', date(t.start), date(t.finish));
      continue;
    }
    rec(70, t.id, t.uid, t.name, t.level, t.outline, '', t.extra.activityId, t.extra.taskType, t.extra.cstr, calName.get(t.calUid) ?? '', t.extra.cstr2, t.extra.durType,
      dur(t.durHrs ?? 0), dur(t.remHrs ?? t.durHrs ?? 0), `${p6num(t.pct ?? 0)}%`, date(t.start), date(t.finish), date(t.earlyStart), date(t.earlyFinish), date(t.lateStart), date(t.lateFinish),
      date(t.actualStart), date(t.actualFinish), t.constraintType ?? 0, t.constraintType && t.constraintType > 1 ? date(t.constraintDate) : '', preds,
      dur(t.freeSlackHrs), dur(t.totalSlackHrs), t.milestone ? 'Yes' : 'No');
    for (const a of asgByTask.get(t.uid) ?? []) {
      rec(75, resId.get(a.resUid), a.units == null ? '' : p6num(a.units), dur(a.workHrs), '', dur(a.actualWorkHrs), '', a.cost == null ? '' : p6num(a.cost), '',
        a.actualCost == null ? '' : p6num(a.actualCost), date(a.start), date(a.finish), '', a.resUid);
    }
  }
  return lines.join('\r\n') + '\r\n';
}
