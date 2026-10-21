// Editing a P6 database the way P6 does: new project, activities, relationships, WBS, dates, progress.
// Shared by the desktop app (renderer/model.ts re-exports these) and the command-line tool.
import { addField, dropIndexes, groupBy, indexBy, nextId, refTarget, rowIndex, rows, table, tableCache, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num, calendarResolver } from '../schedule/cpm.ts';
import { ENUMS } from '../xer/schema.ts';
import { pick, realOf, removeWhere } from '../journal.ts';

export const isMilestone = (r: Row) => r.task_type === 'TT_Mile' || r.task_type === 'TT_FinMile';
export const statusOf = (r: Row) => (r.act_end_date ? 'TK_Complete' : r.act_start_date ? 'TK_Active' : 'TK_NotStart');

export function normDate(v: string): string | null {
  if (!v) return '';
  const t = parseP6Date(v.replace('T', ' '));
  return t == null ? null : formatP6Date(t);
}

/** The activity's work calendar (its own, else the project's). */
export function calOf(db: Db, r: Row) {
  const cals = calendarResolver(db, []);
  return cals.get(r.clndr_id) ?? cals.fallback(rows(db, 'PROJECT').find((p) => p.proj_id === r.proj_id)?.clndr_id);
}
/**
 * After an edit, P6 shows the activity's own new dates at once (other activities move on the next F9):
 * the finish is the start plus the remaining duration on the activity's calendar.
 */
export function refreshOwnDates(db: Db, r: Row): void {
  if (r.act_end_date) return;
  const start = parseP6Date(r.act_start_date ? r.restart_date || r.early_start_date : r.early_start_date || r.restart_date || r.target_start_date);
  if (start == null) return;
  const cal = calOf(db, r);
  const dur = Number(r.remain_drtn_hr_cnt || 0) * 60;
  const s = r.task_type === 'TT_FinMile' ? start : cal.nextWorkStart(start);
  const f = dur > 0 ? cal.addWork(s, dur) : s;
  if (!r.act_start_date) { r.early_start_date = r.restart_date = r.target_start_date = formatP6Date(s); r.target_end_date = formatP6Date(f); }
  r.early_end_date = r.reend_date = formatP6Date(f);
}

/** Typing a start date on a not-started activity moves it there with a Start On or After constraint (P6 behaviour). */
export function setStart(db: Db, r: Row, v: string): string | void {
  const d = normDate(v);
  if (d == null) return 'Invalid date.';
  if (r.act_start_date) return setActual(r, 'start', v);
  r.cstr_type = d ? 'CS_MSOA' : '';
  r.cstr_date = d ?? '';
  if (d) { r.early_start_date = d; refreshOwnDates(db, r); }
}
/** Typing a finish date on a not-started activity changes its duration to fit (P6 behaviour; no constraint). */
export function setFinish(db: Db, r: Row, v: string): string | void {
  const d = normDate(v);
  if (d == null) return 'Invalid date.';
  if (r.act_end_date) return setActual(r, 'finish', v);
  if (!d) return;
  const start = parseP6Date(r.act_start_date ? r.restart_date || r.early_start_date : r.early_start_date || r.target_start_date);
  if (start == null) return 'The activity has no start date yet; schedule it first (F9).';
  if (isMilestone(r)) return 'A milestone has no duration; change its start instead.';
  const cal = calOf(db, r);
  let fin = parseP6Date(d)!;
  if (!/\s\d\d:\d\d$/.test(v.trim())) fin = cal.prevWorkEnd(fin + 1440); // a date without a time means the end of that work day
  const work = cal.workBetween(cal.nextWorkStart(start), fin);
  if (!(work > 0)) return 'The finish must be after the start.';
  const h = work / 60;
  r.remain_drtn_hr_cnt = p6num(h);
  if (!r.act_start_date) r.target_drtn_hr_cnt = p6num(h);
  refreshOwnDates(db, r);
}

export function setActual(r: Row, which: 'start' | 'finish', v: string): string | void {
  const d = normDate(v);
  if (d == null) return 'Invalid date.';
  if (which === 'start') {
    if (!d && r.act_end_date) return 'Clear the actual finish first.';
    if (d && r.act_end_date && d > r.act_end_date) return 'Actual start must be on or before actual finish.';
    r.act_start_date = d;
  } else {
    if (d && !r.act_start_date) return 'Set the actual start first.';
    if (d && d < r.act_start_date) return 'Actual finish must be on or after actual start.';
    r.act_end_date = d;
    if (d) r.remain_drtn_hr_cnt = '0';
    else if (Number(r.remain_drtn_hr_cnt || 0) === 0) r.remain_drtn_hr_cnt = r.target_drtn_hr_cnt;
  }
  r.status_code = statusOf(r);
}

/** Setting % complete (duration type) adjusts remaining duration; physical sets the physical %. */
export function setPercent(r: Row, pct: number): string | void {
  if (!(pct >= 0 && pct <= 100)) return 'Enter 0 to 100.';
  if (pct > 0 && !r.act_start_date) return 'Mark the activity as started (actual start) before entering % complete.';
  if (r.complete_pct_type === 'CP_Phys') { r.phys_complete_pct = p6num(pct); return; }
  const orig = Number(r.target_drtn_hr_cnt || 0);
  r.remain_drtn_hr_cnt = p6num(orig * (1 - pct / 100));
}

// ---- structural edits

export function ensureEps(db: Db): Row {
  const eps = table(db, 'EPS');
  if (!eps.fields.length) eps.fields = ['eps_id', 'parent_eps_id', 'eps_short_name', 'eps_name', 'seq_num'];
  if (!eps.rows.length) eps.rows.push({ eps_id: '1', parent_eps_id: '', eps_short_name: 'Enterprise', eps_name: 'All Initiatives', seq_num: '0' });
  return eps.rows[0];
}

export const STD_CAL = '(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))(0||3()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))(0||4()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))(0||5()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))(0||6()((0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())))(0||7()())))(0||VIEW(ShowTotal|Y)())(0||Exceptions()())))';

export function ensureDefaultCalendar(db: Db): Row {
  const cal = table(db, 'CALENDAR');
  for (const f of ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data']) addField(cal, f);
  const def = cal.rows.find((c) => c.default_flag === 'Y') ?? cal.rows[0];
  if (def) return def;
  const r: Row = { clndr_id: String(nextId(db, 'CALENDAR')), default_flag: 'Y', clndr_name: 'Standard 5 Day Workweek', proj_id: '', base_clndr_id: '', last_chng_date: formatP6Date(Date.now() / 60000), clndr_type: 'CA_Base', day_hr_cnt: '8', week_hr_cnt: '40', month_hr_cnt: '172', year_hr_cnt: '2000', rsrc_private: 'N', clndr_data: STD_CAL };
  cal.rows.push(r);
  return r;
}

export function ensureCurrency(db: Db): void {
  const c = table(db, 'CURRTYPE');
  if (c.rows.length) return;
  c.fields = ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'];
  c.rows.push({ curr_id: '1', decimal_digit_cnt: '2', curr_symbol: '$', decimal_symbol: '.', digit_group_symbol: ',', pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)', curr_type: 'US Dollar', curr_short_name: 'USD', group_digit_cnt: '3', base_exch_rate: '1' });
}

export function newProject(db: Db, o: { id: string; name: string; start: string; epsId?: string }): string {
  ensureEps(db); ensureCurrency(db);
  const cal = ensureDefaultCalendar(db);
  const P = table(db, 'PROJECT');
  const pid = String(nextId(db, 'PROJECT'));
  for (const f of ['proj_id', 'proj_short_name', 'clndr_id', 'plan_start_date', 'plan_end_date', 'scd_end_date', 'last_recalc_date', 'add_date', 'def_duration_type', 'def_complete_pct_type', 'def_task_type', 'task_code_prefix', 'task_code_base', 'task_code_step', 'critical_drtn_hr_cnt', 'critical_path_type', 'def_qty_type', 'def_rate_type', 'name_sep_char', 'sum_base_proj_id', 'guid', 'project_flag', '_eps_id', '_name']) addField(P, f);
  P.rows.push({
    proj_id: pid, proj_short_name: o.id, clndr_id: cal.clndr_id, plan_start_date: o.start, plan_end_date: '', scd_end_date: '', last_recalc_date: o.start,
    add_date: formatP6Date(Date.now() / 60000), def_duration_type: 'DT_FixedDUR2', def_complete_pct_type: 'CP_Drtn', def_task_type: 'TT_Task',
    task_code_prefix: 'A', task_code_base: '1000', task_code_step: '10', critical_drtn_hr_cnt: '0', critical_path_type: 'CT_TotFloat',
    def_qty_type: 'QT_Hour', def_rate_type: 'COST_PER_QTY', name_sep_char: '.', sum_base_proj_id: '', guid: '', project_flag: 'Y', _eps_id: o.epsId ?? '1', _name: o.name,
  });
  const W = table(db, 'PROJWBS');
  for (const f of ['wbs_id', 'proj_id', 'obs_id', 'seq_num', 'proj_node_flag', 'sum_data_flag', 'status_code', 'wbs_short_name', 'wbs_name', 'parent_wbs_id']) addField(W, f);
  W.rows.push({ wbs_id: String(nextId(db, 'PROJWBS')), proj_id: pid, obs_id: '', seq_num: '0', proj_node_flag: 'Y', sum_data_flag: 'Y', status_code: 'WS_Open', wbs_short_name: o.id, wbs_name: o.name, parent_wbs_id: '' });
  const S = table(db, 'SCHEDOPTIONS');
  for (const f of ['schedoptions_id', 'proj_id', 'sched_outer_depend_type', 'sched_open_critical_flag', 'sched_lag_early_start_flag', 'sched_retained_logic', 'sched_setplantoforecast', 'sched_float_type', 'sched_calendar_on_relationship_lag', 'sched_use_expect_end_flag', 'sched_progress_override']) addField(S, f);
  S.rows.push({ schedoptions_id: String(nextId(db, 'SCHEDOPTIONS')), proj_id: pid, sched_outer_depend_type: 'SD_Both', sched_open_critical_flag: 'N', sched_lag_early_start_flag: 'Y', sched_retained_logic: 'Y', sched_setplantoforecast: 'N', sched_float_type: 'FT_FF', sched_calendar_on_relationship_lag: 'rcal_Predecessor', sched_use_expect_end_flag: 'Y', sched_progress_override: 'N' });
  return pid;
}

/** Why n cannot be project projId's new internal number (undefined: it can). P6 takes any whole number. */
export function projectNumberProblem(db: Db, projId: string, n: string): string | undefined {
  if (!/^[1-9]\d{0,8}$/.test(n)) return 'A project number must be a positive whole number (the internal proj_id the XER carries; P6 gives the project its own on import).';
  const other = n !== projId && rows(db, 'PROJECT').find((x) => x.proj_id === n);
  return other ? `Project number ${n} is already ${other.proj_short_name}'s.` : undefined;
}

/** Give a project another internal number (the proj_id the XER carries): every field of every table that points at a
 *  project follows (activities, WBS, relationships of other projects, calendars, codes, UDF values, baselines). */
export function renumberProject(db: Db, from: string, to: string): number {
  const projUdf = new Set(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'PROJECT').map((u) => u.udf_type_id));
  let n = 0;
  for (const name of Object.keys(db.tables)) {
    const fs = realOf(db.tables[name].fields).filter((f) => refTarget(f, name) === 'PROJECT' || (name === 'PROJECT' && (f === 'proj_id' || /^_bl[123]$/.test(f))));
    const udf = (x: Row) => name === 'UDFVALUE' && x.fk_id === from && projUdf.has(x.udf_type_id);
    if (!fs.length && name !== 'UDFVALUE') continue;
    const hit = pick(rows(db, name), (x) => udf(x) || fs.some((f) => x[f] === from));
    for (const x of hit) { if (udf(x)) x.fk_id = to; for (const f of fs) if (x[f] === from) x[f] = to; }
    if (hit.length) { dropIndexes(realOf(rows(db, name))); n += hit.length; }
  }
  return n;
}

/** Project's display name: PROJECT has no name column in XER; P6 keeps it on the root WBS node. */
export function projectName(db: Db, p: Row): string {
  return rows(db, 'PROJWBS').find((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y')?.wbs_name || p._name || p.proj_short_name;
}

export function nextTaskCode(db: Db, projId: string): string {
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId);
  const prefix = p?.task_code_prefix ?? 'A';
  const step = Number(p?.task_code_step || 10);
  let n = Number(p?.task_code_base || 1000);
  const used = new Set(realOf(rows(db, 'TASK')).filter((t) => t.proj_id === projId).map((t) => t.task_code)); // read only
  for (const t of used) {
    if (!t.startsWith(prefix)) continue;
    const k = Number(t.slice(prefix.length));
    if (Number.isFinite(k) && k >= n) n = k + step;
  }
  while (used.has(prefix + n)) n += step;
  return prefix + n;
}

export const TASK_FIELDS = ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'phys_complete_pct', 'complete_pct_type', 'task_type', 'duration_type', 'status_code', 'task_code', 'task_name', 'total_float_hr_cnt', 'free_float_hr_cnt', 'remain_drtn_hr_cnt', 'target_drtn_hr_cnt', 'cstr_date', 'act_start_date', 'act_end_date', 'late_start_date', 'late_end_date', 'expect_end_date', 'early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_type', 'priority_type', 'suspend_date', 'resume_date', 'cstr_date2', 'cstr_type2', 'driving_path_flag', 'create_date', 'update_date', 'create_user', 'update_user'];

/** A new activity; its Activity ID is `code` (the caller checked it is free), else the project's next one. */
export function addActivity(db: Db, projId: string, wbsId: string, hoursPerDay = 8, code?: string): Row {
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId)!;
  const T = table(db, 'TASK');
  for (const f of TASK_FIELDS) addField(T, f);
  const now = formatP6Date(Date.now() / 60000);
  const start = p.last_recalc_date || p.plan_start_date;
  const r: Row = {
    task_id: String(nextId(db, 'TASK')), proj_id: projId, wbs_id: wbsId, clndr_id: p.clndr_id, phys_complete_pct: '0',
    complete_pct_type: p.def_complete_pct_type || 'CP_Drtn', task_type: p.def_task_type || 'TT_Task', duration_type: p.def_duration_type || 'DT_FixedDUR2',
    status_code: 'TK_NotStart', task_code: code ?? nextTaskCode(db, projId), task_name: 'New Activity', total_float_hr_cnt: '', free_float_hr_cnt: '',
    remain_drtn_hr_cnt: String(5 * hoursPerDay), target_drtn_hr_cnt: String(5 * hoursPerDay), cstr_date: '', act_start_date: '', act_end_date: '',
    late_start_date: '', late_end_date: '', expect_end_date: '', early_start_date: start, early_end_date: '', restart_date: '', reend_date: '',
    target_start_date: start, target_end_date: '', rem_late_start_date: '', rem_late_end_date: '', cstr_type: '', priority_type: 'PT_Normal',
    suspend_date: '', resume_date: '', cstr_date2: '', cstr_type2: '', driving_path_flag: 'N', create_date: now, update_date: now, create_user: 'admin', update_user: 'admin',
  };
  T.rows.push(r);
  return r;
}

export function deleteActivities(db: Db, ids: string[]): void {
  const s = new Set(ids);
  // in place (removeWhere): one journal copy per change, however many operations delete activities
  removeWhere(rows(db, 'TASK'), (t) => s.has(t.task_id));
  removeWhere(rows(db, 'TASKPRED'), (r) => s.has(r.task_id) || s.has(r.pred_task_id));
  for (const t of Object.values(db.tables)) if (t.name !== 'TASK' && t.fields.includes('task_id')) removeWhere(t.rows, (r) => s.has(r.task_id));
}

/**
 * Edit > Dissolve: delete activities but keep the chain: each predecessor is linked to each successor
 * (with the predecessor link's type and lag), as P6 does.
 */
export function dissolveActivities(db: Db, ids: string[]): number {
  const s = new Set(ids);
  const P = rows(db, 'TASKPRED');
  const add: [string, string, string, number][] = [];
  // each link into the removed set is carried to every activity the set leads on to, through chains inside it
  // (a whole floor dissolved at once still joins the floor below to the floor above)
  const out = new Map<string, Row[]>();
  for (const r of P) if (s.has(r.pred_task_id)) (out.get(r.pred_task_id) ?? out.set(r.pred_task_id, []).get(r.pred_task_id)!).push(r);
  for (const p of P.filter((r) => s.has(r.task_id) && !s.has(r.pred_task_id))) {
    const seen = new Set([p.task_id]), todo = [p.task_id], exits = new Set<string>();
    while (todo.length) for (const q of out.get(todo.pop()!) ?? []) {
      if (!s.has(q.task_id)) exits.add(q.task_id);
      else if (!seen.has(q.task_id)) { seen.add(q.task_id); todo.push(q.task_id); }
    }
    for (const b of exits) add.push([p.pred_task_id, b, p.pred_type || 'PR_FS', Number(p.lag_hr_cnt || 0)]);
  }
  deleteActivities(db, ids);
  let n = 0;
  for (const [a, b, type, lag] of add) if (!addRelationship(db, a, b, type, lag)) n++;
  return n;
}

/** The relationships from pred to succ (real rows; any type), by an index kept for the edit (db.ts rowIndex). */
export function relationshipsBetween(db: Db, predId: string, succId: string): Row[] {
  const P = realOf(rows(db, 'TASKPRED')); // read only
  return (rowIndex(P, 'pair', (r) => `${r.pred_task_id}|${r.task_id}`).get(`${predId}|${succId}`) ?? []).map((i) => P[i]).filter((r) => r.pred_task_id === predId && r.task_id === succId);
}
export const LOOP_MESSAGE = 'This relationship would create a loop (circular logic).';
/** A project read from Microsoft Project keeps one relationship per pair of activities, as Project does; any other
 *  one per pair and type, as P6. The project's format mark decides: _msp_source Y (the MSPDI and MPX readers since
 *  v0.1.14, or an MCP handle opened from such a file) or N (a P6 project, e.g. a copy_project of one). Without a mark
 *  (read before v0.1.14): _msp_keep (MSPDI) or activities carrying Project task UIDs (_msp_uid: MPX or MSPDI). The one
 *  rule, for edits (MCP, CLI, the desktop assistant and Excel import) and the desktop's own relationship commands. */
export function onePerPair(db: Db, p: Row | undefined): boolean {
  if (!p || p._msp_source === 'N') return false;
  if (p._msp_source === 'Y' || p._msp_keep) return true;
  const T = realOf(rows(db, 'TASK'));
  const add = (s: Set<string>, from: number) => { for (let i = from; i < T.length; i++) if (T[i]._msp_uid) s.add(T[i].proj_id); return true; };
  return tableCache(T, 'msp-projects', () => { const s = new Set<string>(); add(s, 0); return s; }, add).has(p.proj_id);
}
export const ONE_PER_PAIR_MESSAGE = 'These activities are already related, and Microsoft Project keeps one relationship per pair of activities.';
/** Why P6 would refuse this relationship, or undefined if it is allowed. noLoopCheck: the caller checks loops itself
 *  (an edit checks them once, after all its operations). */
export function checkRelationship(db: Db, predId: string, succId: string, type = 'PR_FS', noLoopCheck = false): string | undefined {
  if (predId === succId) return 'An activity cannot be related to itself.';
  const have = relationshipsBetween(db, predId, succId);
  if (have.some((r) => r.pred_type === type)) return 'This relationship already exists.';
  if (have.length) { const T = realOf(rows(db, 'TASK')), i = (rowIndex(T, 'id', (t) => t.task_id).get(succId) ?? []).find((k) => T[k].task_id === succId); if (i != null && onePerPair(db, realOf(rows(db, 'PROJECT')).find((p) => p.proj_id === T[i].proj_id))) return ONE_PER_PAIR_MESSAGE; }
  if (noLoopCheck) return undefined;
  // P6 refuses links that would create a loop
  const P = realOf(rows(db, 'TASKPRED')), succOf = rowIndex(P, 'pred', (r) => r.pred_task_id);
  const stack = [succId], seen = new Set<string>();
  while (stack.length) {
    const x = stack.pop()!;
    if (x === predId) return LOOP_MESSAGE;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const i of succOf.get(x) ?? []) if (P[i].pred_task_id === x) stack.push(P[i].task_id);
  }
  return undefined;
}

export function addRelationship(db: Db, predId: string, succId: string, type = 'PR_FS', lagHrs = 0, noLoopCheck = false): string | void {
  const err = checkRelationship(db, predId, succId, type, noLoopCheck);
  if (err) return err;
  const T = realOf(rows(db, 'TASK')), byId = rowIndex(T, 'id', (t) => t.task_id), proj = (id: string) => T[(byId.get(id) ?? []).find((i) => T[i].task_id === id) ?? T.findIndex((t) => t.task_id === id)].proj_id;
  const P = table(db, 'TASKPRED');
  for (const f of ['task_pred_id', 'task_id', 'pred_task_id', 'proj_id', 'pred_proj_id', 'pred_type', 'lag_hr_cnt']) addField(P, f);
  P.rows.push({ task_pred_id: String(nextId(db, 'TASKPRED')), task_id: succId, pred_task_id: predId, proj_id: proj(succId), pred_proj_id: proj(predId), pred_type: type, lag_hr_cnt: p6num(lagHrs) });
}

export function addWbs(db: Db, projId: string, parentId: string, code?: string, name?: string): Row {
  const W = table(db, 'PROJWBS');
  const sibs = realOf(W.rows).filter((w) => w.parent_wbs_id === parentId);
  const r: Row = { wbs_id: String(nextId(db, 'PROJWBS')), proj_id: projId, obs_id: '', seq_num: String(sibs.length * 10 + 10), proj_node_flag: 'N', sum_data_flag: 'N', status_code: 'WS_Open', wbs_short_name: code ?? `WBS${sibs.length + 1}`, wbs_name: name ?? 'New WBS Element', parent_wbs_id: parentId };
  W.rows.push(r);
  return r;
}

export const enumOk = (table: string, field: string, v: string) => !ENUMS[`${table}.${field}`] || ENUMS[`${table}.${field}`].includes(v);
