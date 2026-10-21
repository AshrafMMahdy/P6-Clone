// "Repair to valid" (MCP save repair: true): after a lenient open that P6 would still reject, field by field, never by
// guessing, so the file written is one P6 imports. Every change is listed (row, field, old value, new value, why).
//  - A value P6 cannot read or cannot accept is taken from the activity's own other fields when they agree (original
//    and remaining duration, the planned start-finish span on its calendar, the status its actual dates give), else
//    P6's neutral value (never a blind 0: a zero duration turns a task into a milestone).
//  - Actual dates are the customer's recorded facts: only one P6 REFUSES on import is cleared (never invented), the
//    list being REFUSED_ACTUALS; one P6 imports but a reviewer flags (after the data date, a finish without a start) is
//    kept and reported as an invalid-date finding, as DCMA's check 9 does, not changed.
//  - A whole row goes only when it cannot be identified (no readable id, Activity ID or WBS; a row made from a damaged
//    line, its columns shifted), and with it every row that pointed at it.
import { KEYS, refTarget, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { calendarResolver, p6num } from '../schedule/cpm.ts';
import { ENUMS, fieldType, knownFields } from './schema.ts';
import { MAX_LEN } from './validate.ts';
import { realOf, removeWhere } from '../journal.ts';

/** row: the row's place in its table as the file had it (1-based); key: its id then (before a fresh one). */
export interface RepairChange { table: string; row: number; key: string; field: string; old: string; new: string; reason: string }
/** Kept as recorded, reported (DCMA check 9, invalid dates): P6 imports it. */
export interface RepairFinding { table: string; row: number; key: string; field: string; value: string; code: 'ACTUAL_AFTER_DD' | 'FINISH_WITHOUT_START'; message: string }

/** The actual dates P6 refuses on import, so the repair clears them (the clone's validator rates each an error):
 *  - unreadable: not a yyyy-mm-dd hh:mm date, or no such day (BAD_DATE: "P6 import fails on unparseable dates");
 *  - outside what a P6 database stores: before 1753-01-01 (SQL Server's datetime, the narrowest P6 database);
 *    after 9999 cannot be written in four digits, so it is unreadable;
 *  - an actual finish before the actual start (ACT_DATES_ORDER: "P6 rejects the actual dates"): the finish goes, the
 *    start stays (in progress).
 *  Imported by P6, so kept and reported: an actual after the data date (ACTUAL_AFTER_DD: "P6 imports them; the
 *  schedule log reports actuals in the future"), an actual finish without a start (P6 fills the start in). */
export const REFUSED_ACTUALS = ['unreadable (not a date, or no such day)', 'before 1753-01-01 (outside what a P6 database stores)', 'an actual finish before the actual start (the finish is cleared)'];
const MIN_DB_DATE = parseP6Date('1753-01-01')!;

const ACTUALS = new Set(['act_start_date', 'act_end_date']);
const COMPUTED = new Set(['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'rem_late_start_date', 'rem_late_end_date', 'restart_date', 'reend_date', 'total_float_hr_cnt', 'free_float_hr_cnt', 'external_early_start_date', 'external_late_end_date', 'float_path', 'float_path_order']);
const NEUTRAL: Record<string, string> = { 'TASK.task_type': 'TT_Task', 'TASK.duration_type': 'DT_FixedDUR2', 'TASK.complete_pct_type': 'CP_Drtn', 'TASK.priority_type': 'PT_Normal', 'TASKPRED.pred_type': 'PR_FS', 'RSRC.rsrc_type': 'RT_Labor', 'CALENDAR.clndr_type': 'CA_Base', 'PROJWBS.status_code': 'WS_Open' };
const MAX_HOURS = 20 * 365 * 24; // no activity lasts twenty years of round-the-clock work
const isNum = (v: string) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v);
const goodDate = (v: string | undefined) => { const t = v ? parseP6Date(v) : null; return t != null && t >= parseP6Date('1900-01-01')! && t <= parseP6Date('2200-12-31')! ? t : null; };

/** What in a row P6 cannot take: unreadable values by the validator's own rules (each field's rule worked out once per
 *  table: a file has hundreds of thousands of rows). */
type Check = (v: string) => boolean;
const checks = new Map<string, Map<string, Check>>();
function checksOf(table: string): Map<string, Check> {
  let m = checks.get(table);
  if (m) return m;
  m = new Map();
  for (const f of knownFields(table)) {
    if (f.startsWith('_')) continue;
    const en = ENUMS[`${table}.${f}`], ty = fieldType(f), max = MAX_LEN[`${table}.${f}`];
    if (en) { const s = new Set(en); m.set(f, (v) => !s.has(v) && !(table === 'TASKPRED' && /^PR_(FS|SS|FF|SF)\d$/.test(v))); }
    else if (ty === 'date') m.set(f, (v) => parseP6Date(v) == null);
    else if (ty === 'number') m.set(f, (v) => !isNum(v));
    else if (ty === 'flag') m.set(f, (v) => v !== 'Y' && v !== 'N');
    else if (max) m.set(f, (v) => v.length > max);
  }
  checks.set(table, m);
  return m;
}
function badFields(table: string, r: Row): string[] {
  const out: string[] = [];
  for (const [f, bad] of checksOf(table)) { const v = r[f]; if (v !== '' && v != null && bad(v)) out.push(f); }
  return out;
}

export function repairToValid(db: Db): { changes: RepairChange[]; findings: RepairFinding[] } {
  const changes: RepairChange[] = [], findings: RepairFinding[] = [];
  const T = db.tables;
  // rows are named by where they were in the file (1-based), whatever the repair removes before them
  const origin = new Map<Row, number>();
  for (const tb of Object.values(T)) realOf(tb.rows).forEach((r, i) => origin.set(r, i + 1));
  const rowNo = (_t: string, r: Row) => origin.get(realOf(r)) ?? 0;
  const firstKey = new Map<Row, string>();
  for (const tb of Object.values(T)) if (KEYS[tb.name]) for (const r of realOf(tb.rows)) firstKey.set(r, r[KEYS[tb.name]] ?? '');
  const keyOf = (t: string, r: Row) => (KEYS[t] ? firstKey.get(realOf(r)) ?? r[KEYS[t]] ?? '' : '');
  const set = (t: string, r: Row, f: string, v: string, reason: string) => { if ((r[f] ?? '') === v) return; changes.push({ table: t, row: rowNo(t, r), key: keyOf(t, r), field: f, old: r[f] ?? '', new: v, reason }); r[f] = v; };
  const drop = (t: string, gone: Set<Row>, reason: (r: Row) => string) => {
    if (!gone.size || !T[t]) return;
    for (const r of gone) changes.push({ table: t, row: rowNo(t, r), key: keyOf(t, r), field: '*', old: summary(t, r), new: '(row removed)', reason: reason(r) });
    const raw = new Set([...gone].map((r) => realOf(r)));
    removeWhere(T[t].rows, (x) => raw.has(x));
  };
  const summary = (t: string, r: Row) => (t === 'TASK' ? `${r.task_code || '(no Activity ID)'} ${r.task_name ?? ''}`.trim().slice(0, 80) : Object.values(r).slice(0, 4).join(' ').slice(0, 80));

  // ---- activities that cannot be identified (and duplicates: the damaged copy of an id goes)
  const projIds = new Set(rows(db, 'PROJECT').map((p) => p.proj_id)), wbsById = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const tasks = rows(db, 'TASK');
  const bad = new Map(tasks.map((t, i) => [t, badFields('TASK', realOf(tasks)[i])])); // read the real rows: a scan through the undo journal is slow
  const why = new Map<Row, string>();
  // a code of one field found in another (task_type "DT_FixedDUR2", status "TK_..." in duration_type): its columns shifted
  const domains = ['task_type', 'status_code', 'duration_type', 'complete_pct_type'].map((f) => [f, new Set(ENUMS[`TASK.${f}`])] as const);
  const shifted = (t: Row) => domains.filter(([f, own]) => t[f] && !own.has(t[f]) && domains.some(([g, other]) => g !== f && other.has(t[f]))).length;
  for (const t of tasks) {
    const b = bad.get(t)!;
    if (!/^\d+$/.test(t.task_id ?? '')) why.set(t, `no readable task_id ("${t.task_id}")`);
    else if (!t.task_code) why.set(t, 'no Activity ID');
    else if (t.task_code.length > MAX_LEN['TASK.task_code']) why.set(t, `a row made from a damaged line: its Activity ID column holds "${t.task_code.slice(0, 40)}…", longer than any ID (its columns are shifted)`);
    else if (!wbsById.has(t.wbs_id)) why.set(t, `no readable WBS (wbs_id "${t.wbs_id}")`);
    else if (isNum(t.task_name ?? '') && b.length) why.set(t, `a row made from a damaged line: its name is the number "${t.task_name}" and ${b.slice(0, 4).join(', ')} cannot be read`);
    else if (shifted(t) >= 2) why.set(t, `a row made from a damaged line: ${domains.filter(([f]) => t[f] && !ENUMS[`TASK.${f}`].includes(t[f])).map(([f]) => `${f} holds "${t[f]}"`).join(', ')} (its columns are shifted)`);
  }
  // a task_id two rows claim: the cleanest copy keeps it; another copy that its Activity ID identifies gets a fresh id
  // (what points at that id is the other copy's), else it cannot be identified
  const byId = new Map<string, Row[]>();
  for (const t of tasks) if (!why.has(t)) (byId.get(t.task_id) ?? byId.set(t.task_id, []).get(t.task_id)!).push(t);
  const codeCount = new Map<string, number>();
  for (const t of tasks) if (!why.has(t)) codeCount.set(`${t.proj_id}|${t.task_code}`, (codeCount.get(`${t.proj_id}|${t.task_code}`) ?? 0) + 1);
  let next = tasks.reduce((m, t) => Math.max(m, /^\d+$/.test(t.task_id ?? '') ? Number(t.task_id) : 0), 0);
  for (const [id, same] of byId) if (same.length > 1) {
    const keep = [...same].sort((a, b) => bad.get(a)!.length - bad.get(b)!.length)[0];
    for (const t of same) {
      if (t === keep) continue;
      if (codeCount.get(`${t.proj_id}|${t.task_code}`) === 1) set('TASK', t, 'task_id', String(++next), `task_id ${id} is also ${keep.task_code}'s (row ${rowNo('TASK', keep)}), whose copy is the readable one: this activity, ${t.task_code}, gets a fresh id (links to ${id} stay with ${keep.task_code})`);
      else why.set(t, `task_id ${id} repeated, and its Activity ID ${t.task_code} does not tell it apart`);
    }
  }
  drop('TASK', new Set(why.keys()), (r) => `cannot be identified: ${why.get(r)}`);
  // ---- rows pointing at activities that are not there (removed above, or lost with a damaged line)
  const taskIds = new Set(rows(db, 'TASK').map((t) => t.task_id));
  const taskUdf = new Set(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK').map((u) => u.udf_type_id));
  for (const t of Object.values(T)) {
    if (t.name === 'TASK') continue;
    const fs = t.fields.filter((f) => refTarget(f, t.name) === 'TASK');
    const gone = new Set(realOf(t.rows).filter((r) => fs.some((f) => r[f] && !taskIds.has(r[f])) || (t.name === 'UDFVALUE' && taskUdf.has(r.udf_type_id) && r.fk_id && !taskIds.has(r.fk_id))));
    drop(t.name, gone, (r) => `points at activity ${fs.map((f) => r[f]).find((v) => v && !taskIds.has(v)) ?? r.fk_id}, which is not in the file`);
  }

  // ---- field by field
  const cals = calendarResolver(db, []);
  const calIds = new Set(rows(db, 'CALENDAR').map((c) => c.clndr_id));
  const proj = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  for (const t of rows(db, 'TASK')) {
    const b = new Set(badFields('TASK', t));
    // the project: from its WBS element
    const w = wbsById.get(t.wbs_id)!;
    if (!projIds.has(t.proj_id) && projIds.has(w.proj_id)) set('TASK', t, 'proj_id', w.proj_id, 'its WBS element\'s project');
    const p = proj.get(t.proj_id);
    const dd = goodDate(p?.last_recalc_date) ?? goodDate(p?.plan_start_date);
    if (t.clndr_id && !calIds.has(t.clndr_id) && p?.clndr_id && calIds.has(p.clndr_id)) set('TASK', t, 'clndr_id', p.clndr_id, 'not a calendar of the file: the project\'s default calendar, as P6 assigns it');
    // Activity ID too long: P6 cuts it; a cut that collides would merge two activities, so it is refused (the row goes below)
    if (b.has('task_code')) { set('TASK', t, 'task_code', t.task_code.slice(0, MAX_LEN['TASK.task_code']), `longer than P6's ${MAX_LEN['TASK.task_code']} characters: cut, as P6 does`); b.delete('task_code'); }
    if (b.has('task_name')) { set('TASK', t, 'task_name', t.task_name.slice(0, MAX_LEN['TASK.task_name']), `longer than P6's ${MAX_LEN['TASK.task_name']} characters: cut, as P6 does`); b.delete('task_name'); }
    // actual dates: the customer's facts. Only what P6 refuses is cleared (REFUSED_ACTUALS), never invented
    const actualsWere = `${t.act_start_date ?? ''}|${t.act_end_date ?? ''}`;
    for (const f of ['act_start_date', 'act_end_date']) {
      const v = t[f];
      if (!v) continue;
      const at = parseP6Date(v);
      if (at == null) set('TASK', t, f, '', `"${v}" is not a date P6 can read (P6 refuses it): an actual cannot be guessed, so it is cleared`);
      else if (at < MIN_DB_DATE) set('TASK', t, f, '', `${v.slice(0, 16)} is before 1753, outside what a P6 database stores (P6 refuses it): an actual cannot be guessed, so it is cleared`);
      b.delete(f);
    }
    if (t.act_end_date && t.act_start_date && parseP6Date(t.act_end_date)! < parseP6Date(t.act_start_date)!) set('TASK', t, 'act_end_date', '', 'the actual finish is before the actual start, which P6 refuses: the finish is cleared (the activity stays in progress)');
    // kept as recorded, reported as invalid dates (P6 imports them)
    for (const f of ['act_start_date', 'act_end_date']) {
      const at = parseP6Date(t[f]);
      if (at != null && dd != null && at > dd) findings.push({ table: 'TASK', row: rowNo('TASK', t), key: keyOf('TASK', t), field: f, value: t[f], code: 'ACTUAL_AFTER_DD', message: `${t.task_code}: actual ${f === 'act_start_date' ? 'start' : 'finish'} ${t[f].slice(0, 16)} is after the data date ${formatP6Date(dd)} (an invalid date for a reviewer; P6 imports it, so it is kept as recorded)` });
    }
    if (t.act_end_date && !t.act_start_date) findings.push({ table: 'TASK', row: rowNo('TASK', t), key: keyOf('TASK', t), field: 'act_end_date', value: t.act_end_date, code: 'FINISH_WITHOUT_START', message: `${t.task_code}: an actual finish without an actual start (P6 imports it and fills the start in; kept as recorded)` });
    // the status: from the actual dates when the repair changed them or the status cannot be read (P6 derives it so)
    const status = t.act_end_date ? 'TK_Complete' : t.act_start_date ? 'TK_Active' : 'TK_NotStart';
    if (t.status_code !== status && (b.has('status_code') || `${t.act_start_date ?? ''}|${t.act_end_date ?? ''}` !== actualsWere)) set('TASK', t, 'status_code', status, `the status its actual dates give (${t.act_end_date ? 'finished' : t.act_start_date ? 'started' : 'not started'})`);
    b.delete('status_code');
    // constraints: an unreadable type or date clears that constraint
    for (const [ty, dt] of [['cstr_type', 'cstr_date'], ['cstr_type2', 'cstr_date2']] as const) {
      if (b.has(ty) || b.has(dt) || (t[ty] && t[ty] !== 'CS_ALAP' && !goodDate(t[dt]))) { const was = `${t[ty] ?? ''} ${t[dt] ?? ''}`.trim(); set('TASK', t, ty, '', `constraint "${was}" cannot be read: cleared`); set('TASK', t, dt, '', `constraint "${was}" cannot be read: cleared`); }
      b.delete(ty); b.delete(dt);
    }
    // durations: an unreadable or impossible one from the activity's other duration or its planned span, else P6's default
    const cal = cals.get(t.clndr_id) ?? cals.fallback(p?.clndr_id);
    const h = (f: string) => { const v = t[f]; return v !== '' && v != null && isNum(v) && Number(v) >= 0 && Number(v) <= MAX_HOURS ? Number(v) : null; };
    const span = (() => { const s = goodDate(t.target_start_date), f = goodDate(t.target_end_date); if (s == null || f == null || f < s) return null; const x = cal.workBetween(s, f) / 60; return x <= MAX_HOURS ? x : null; })();
    const mile = t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile';
    const neutral = mile ? 0 : 5 * (cal.hoursPerDay() || 8);
    if (h('target_drtn_hr_cnt') == null) {
      const v = t.target_drtn_hr_cnt, rem = h('remain_drtn_hr_cnt');
      const [nv, how] = mile ? [0, 'a milestone has no duration'] : status === 'TK_NotStart' && rem != null ? [rem, 'its remaining duration (not started: the same)'] : span != null ? [span, 'its planned start-finish span on its calendar'] : [neutral, 'nothing in the row gives it: P6\'s default for a new activity (5 days)'];
      set('TASK', t, 'target_drtn_hr_cnt', p6num(nv), `"${v}" is ${isNum(v ?? '') ? 'impossible' : 'not a number'}: ${how}`);
    }
    if (h('remain_drtn_hr_cnt') == null) {
      const v = t.remain_drtn_hr_cnt, orig = h('target_drtn_hr_cnt')!;
      const [nv, how] = status === 'TK_Complete' ? [0, 'finished: nothing remains'] : status === 'TK_NotStart' ? [orig, 'not started: its original duration'] : [orig, 'in progress, nothing gives what remains: its original duration (F9 and progress update correct it)'];
      set('TASK', t, 'remain_drtn_hr_cnt', p6num(nv), `"${v}" is ${isNum(v ?? '') ? 'impossible' : 'not a number'}: ${how}`);
    }
    b.delete('target_drtn_hr_cnt'); b.delete('remain_drtn_hr_cnt');
    if (b.has('phys_complete_pct')) { set('TASK', t, 'phys_complete_pct', status === 'TK_Complete' ? '100' : status === 'TK_NotStart' ? '0' : p6num(Math.max(0, Math.min(100, 100 * (1 - Number(t.remain_drtn_hr_cnt) / (Number(t.target_drtn_hr_cnt) || 1))))), `"${t.phys_complete_pct}" is not a number: from its status and durations`); b.delete('phys_complete_pct'); }
    // the rest: dates and floats F9 computes are cleared; codes and flags take P6's default; amounts 0
    for (const f of b) generic('TASK', t, f);
  }
  // every other table: the same rules for single fields
  for (const tb of Object.values(T)) {
    if (tb.name === 'TASK') continue;
    const view = tb.rows, raw = realOf(view);
    for (let i = 0; i < raw.length; i++) { const b = badFields(tb.name, raw[i]); if (b.length) for (const f of b) generic(tb.name, view[i], f); }
  }
  // activity IDs cut to the same value in one project: the later one cannot be told apart
  const seen = new Set<string>(), dupCode = new Set<Row>();
  for (const t of rows(db, 'TASK')) { const k = `${t.proj_id}|${t.task_code}`; if (seen.has(k)) dupCode.add(t); seen.add(k); }
  drop('TASK', dupCode, (r) => `its Activity ID ${r.task_code} (after cutting) is another activity's: cannot be identified`);
  return { changes, findings };

  function generic(table: string, r: Row, f: string) {
    const v = r[f] ?? '', en = ENUMS[`${table}.${f}`], ty = fieldType(f), max = MAX_LEN[`${table}.${f}`];
    if (en) set(table, r, f, en.includes('') ? '' : NEUTRAL[`${table}.${f}`] ?? en[0], `"${v}" is not a P6 code: P6's default`);
    else if (ty === 'date') set(table, r, f, '', ACTUALS.has(f) ? `"${v}" is not a date: an actual cannot be guessed, so it is cleared` : COMPUTED.has(f) ? `"${v}" is not a date: F9 computes it` : `"${v}" is not a date: cleared`);
    else if (ty === 'number') set(table, r, f, COMPUTED.has(f) ? '' : '0', COMPUTED.has(f) ? `"${v}" is not a number: F9 computes it` : `"${v}" is not a number: P6's default (0)`);
    else if (ty === 'flag') set(table, r, f, 'N', `"${v}" is not Y or N: P6's default (N)`);
    else if (max && v.length > max) set(table, r, f, v.slice(0, max), `longer than P6's ${max} characters: cut, as P6 does`);
  }
}
