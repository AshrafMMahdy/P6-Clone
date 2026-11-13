// What an edit changed, read from the undo journal the edit was recorded in: per activity (or relationship, resource ...) the field, the old value and the new one, so the answer can say
// "A1010 duration: 8 -> 10 days". Only what a person sets is listed (names, durations, dates they gave, status, constraints, calendars, resource limits ...), never the dates the scheduler works out.
import { ABSENT, type Journal } from '../journal.ts';
import { KEYS, type Db, type Row } from '../db.ts';
import { dayHours } from './units.ts';
import { cstrName, namesText } from '../notes.ts';
import { humanizeField, STATUS_WORDS, TABLE_WORD } from '../p6words.ts';
import { parseClndrDataLeniently } from '../calendar/clndr-data.ts';

export interface FieldChange { id: string; /** the Project ID of the row, given when the file has several projects (an Activity ID can be in more than one) */ project?: string; field: string; old: string | number | null; new: string | number | null }
type Obj = Record<string, unknown>;

/** P6's words for the coded values an edit can change (the file keeps codes). */
const WORDS: Record<string, Record<string, string>> = {
  priority_type: { PT_Top: 'Top', PT_High: 'High', PT_Normal: 'Normal', PT_Low: 'Low', PT_Lowest: 'Lowest' },
  status_code: STATUS_WORDS,
  task_type: { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_LOE: 'Level of Effort', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_WBS: 'WBS Summary' },
  complete_pct_type: { CP_Drtn: 'Duration', CP_Phys: 'Physical', CP_Units: 'Units' },
  duration_type: { DT_FixedDUR2: 'Fixed Duration & Units/Time', DT_FixedQty: 'Fixed Units', DT_FixedDrtn: 'Fixed Duration & Units', DT_FixedRate: 'Fixed Units/Time' },
  pred_type: { PR_FS: 'Finish to Start', PR_SS: 'Start to Start', PR_FF: 'Finish to Finish', PR_SF: 'Start to Finish' },
  rsrc_type: { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' },
};
/** The wording of a changed value: P6's words for a code, the constraint by its P6 name. */
const wordOf = (column: string, v: string): string => (column === 'cstr_type' || column === 'cstr_type2' ? (v === '' ? '' : cstrName(v)) : WORDS[column]?.[v] ?? v);

/** The fields of an activity a person sets, with the name the answer gives them (hours as days on the activity's calendar). */
const TASK_FIELDS: Record<string, { label: string; days?: boolean }> = {
  task_name: { label: 'Activity Name' }, task_code: { label: 'Activity ID' }, target_drtn_hr_cnt: { label: 'Original Duration (days)', days: true }, remain_drtn_hr_cnt: { label: 'Remaining Duration (days)', days: true },
  act_start_date: { label: 'Actual Start' }, act_end_date: { label: 'Actual Finish' }, status_code: { label: 'Activity Status' }, task_type: { label: 'Activity Type' }, clndr_id: { label: 'Calendar' }, wbs_id: { label: 'WBS' },
  cstr_type: { label: 'Primary Constraint' }, cstr_date: { label: 'Primary Constraint Date' }, cstr_type2: { label: 'Secondary Constraint' }, cstr_date2: { label: 'Secondary Constraint Date' },
  complete_pct_type: { label: 'Percent Complete Type' }, phys_complete_pct: { label: 'Physical % Complete' }, priority_type: { label: 'Leveling Priority' },
  expect_end_date: { label: 'Expected Finish' }, rsrc_id: { label: 'Primary Resource' },
};
/** The fields of the other rows an edit can change, by the name P6 gives them (a column not here is named by its words). */
const OTHER_FIELDS: Record<string, string> = {
  proj_short_name: 'Project ID', proj_name: 'Project Name', last_recalc_date: 'Data Date', plan_start_date: 'Planned Start', plan_end_date: 'Must Finish By',
  rsrc_name: 'Resource Name', rsrc_short_name: 'Resource ID', rsrc_type: 'Resource Type', max_qty_per_hr: 'Max Units/Time (units a day)', cost_per_qty: 'Price / Unit', def_qty_per_hr: 'Units / Time',
  clndr_name: 'Calendar Name', day_hr_cnt: 'Hours per Day', week_hr_cnt: 'Hours per Week', wbs_name: 'WBS Name', wbs_short_name: 'WBS Code', task_name: 'Activity Name',
  target_qty: 'Budgeted Units', remain_qty: 'Remaining Units', act_reg_qty: 'Actual Regular Units', cost_per_qty_rate: 'Price / Unit',
};
/** The baselines a project names, as P6 names them (the project baseline, and the user's primary, secondary and tertiary baselines). */
const BASELINE_SLOTS: Record<string, string> = { sum_base_proj_id: 'Project Baseline', _bl1: 'Primary Baseline', _bl2: 'Secondary Baseline', _bl3: 'Tertiary Baseline' };
const humanize = humanizeField;
const yesNo = (v: string): string => (v === 'Y' ? 'Yes' : v === 'N' ? 'No' : v);
/** P6's names for the fields of the other tables the named operations change, and P6's words for their coded values. A row of one of these
 *  tables is named by `rowId` below. A column that is in none of these lists is named by its own words and reported in `unnamed`: right for
 *  set_fields (the caller named the column itself), a gap for a named operation (the test of every operation fails on it). */
const TABLE_FIELDS: Record<string, Record<string, string>> = {
  SCHEDOPTIONS: {
    sched_calendar_on_relationship_lag: 'Calendar for scheduling Relationship Lag', sched_float_type: 'Compute Total Float as', sched_open_critical_flag: 'Make open-ended activities critical',
    sched_use_expect_end_flag: 'Use Expected Finish Dates', sched_outer_depend_type: 'Ignore relationships to and from other projects', sched_lag_early_start_flag: 'Calculate start-to-start lag from',
    enable_multiple_longest_path_calc: 'Calculate multiple float paths', use_total_float_multiple_longest_paths: 'Calculate multiple paths using', max_multiple_longest_path: 'Specify the number of paths to calculate',
    key_activity_for_multiple_longest_paths: 'Display multiple float paths ending with activity',
  },
  PROJECT: { critical_path_type: 'Define critical activities as', _eps_id: 'EPS', clndr_id: 'Default Calendar', fintmpl_id: 'Financial Period Calendar', last_fin_dates_id: 'Last Financial Period Stored', proj_id: 'Internal project number' },
  TASKRSRC: { curv_id: 'Curve', cost_qty_link_flag: 'Calculate costs from units', target_cost: 'Budgeted Cost', act_reg_cost: 'Actual Regular Cost', act_ot_cost: 'Actual Overtime Cost', remain_cost: 'Remaining Cost', acct_id: 'Cost Account', role_id: 'Role',
    target_qty: 'Budgeted Units', remain_qty: 'Remaining Units', act_reg_qty: 'Actual Regular Units', act_ot_qty: 'Actual Overtime Units', act_start_date: 'Actual Start', act_end_date: 'Actual Finish', target_lag_drtn_hr_cnt: 'Original Lag (hours)' },
  PROJWBS: { parent_wbs_id: 'Parent WBS' },
  RSRC: { clndr_id: 'Calendar', parent_rsrc_id: 'Parent Resource' },
  CALENDAR: { month_hr_cnt: 'Hours per Month', year_hr_cnt: 'Hours per Year', default_flag: 'Default Calendar', base_clndr_id: 'Base Calendar' },
  _RISKEST: { min_hr: 'Minimum Remaining Duration (days)', ml_hr: 'Most Likely Remaining Duration (days)', max_hr: 'Maximum Remaining Duration (days)', dist: 'Distribution' },
  TASKFIN: { act_work_qty: 'Actual Labor Units', act_work_cost: 'Actual Labor Cost', act_equip_qty: 'Actual Nonlabor Units', act_equip_cost: 'Actual Nonlabor Cost', act_mat_cost: 'Actual Material Cost', act_expense_cost: 'Actual Expense Cost',
    bcwp: 'Earned Value Cost', perfm_work_qty: 'Earned Value Labor Units', bcws: 'Planned Value Cost', sched_work_qty: 'Planned Value Labor Units' },
  TRSRCFIN: { act_qty: 'Actual Units', act_cost: 'Actual Cost' },
  CURRTYPE: { curr_type: 'Currency Name', curr_short_name: 'Currency ID', curr_symbol: 'Currency Symbol' },
  MEMOTYPE: { memo_type: 'Notebook Topic' },
  ACTVTYPE: { actv_code_type: 'Activity Code Name' }, PCATTYPE: { proj_catg_type: 'Project Code Name' }, RCATTYPE: { rsrc_catg_type: 'Resource Code Name' }, ASGNMNTCATTYPE: { asgnmnt_catg_type: 'Assignment Code Name' },
  ACTVCODE: { short_name: 'Code Value', actv_code_name: 'Description' }, PCATVAL: { proj_catg_short_name: 'Code Value', proj_catg_name: 'Description' }, RCATVAL: { rsrc_catg_short_name: 'Code Value', rsrc_catg_name: 'Description' },
  ASGNMNTCATVAL: { asgnmnt_catg_short_name: 'Code Value', asgnmnt_catg_name: 'Description' },
  UDFTYPE: { udf_type_label: 'User Defined Field Title' },
  PROJCOST: { cost_name: 'Expense Item', acct_id: 'Cost Account', target_qty: 'Budgeted Units', cost_per_qty: 'Price / Unit', target_cost: 'Budgeted Cost', act_cost: 'Actual Cost', remain_cost: 'Remaining Cost', vendor_name: 'Vendor',
    po_number: 'Document Number', cost_descr: 'Expense Description', qty_name: 'Unit of Measure' },
  TASKPROC: { proc_name: 'Step Name', proc_wt: 'Step Weight', complete_pct: 'Step % Complete', complete_flag: 'Completed', proc_descr: 'Step Description' },
  ACCOUNT: { acct_short_name: 'Cost Account ID', acct_name: 'Cost Account Name', acct_descr: 'Cost Account Description', parent_acct_id: 'Parent Cost Account' },
  EPS: { eps_short_name: 'EPS ID', eps_name: 'EPS Name', parent_eps_id: 'Parent EPS' },
  OBS: { obs_name: 'OBS Name', obs_descr: 'OBS Description', parent_obs_id: 'Parent OBS' },
  POBS: { pobs_name: 'Performing Organization Name', pobs_descr: 'Performing Organization Description', pobs_manager: 'Performing Organization Manager' },
  ROLES: { role_short_name: 'Role ID', role_name: 'Role Name', role_descr: 'Role Description', parent_role_id: 'Parent Role' },
  RSRCCURVDATA: { curv_name: 'Resource Curve Name' },
  FINDATES: { fin_dates_name: 'Financial Period Name', start_date: 'Start Date', end_date: 'End Date' }, FINTMPL: { fintmpl_name: 'Financial Period Calendar Name', default_flag: 'Default' },
  TASKMEMO: { task_memo: 'Notebook Text' }, WBSMEMO: { wbs_memo: 'Notebook Text' },
};
const TABLE_WORDS: Record<string, Record<string, (v: string) => string>> = {
  SCHEDOPTIONS: {
    sched_calendar_on_relationship_lag: (v) => ({ rcal_Predecessor: 'Predecessor Activity Calendar', rcal_Successor: 'Successor Activity Calendar', rcal_24Hour: '24 Hour Calendar', rcal_ProjDefault: 'Project Default Calendar' } as Record<string, string>)[v] ?? v,
    sched_float_type: (v) => ({ FT_SS: 'Start Float = Late Start - Early Start', FT_FF: 'Finish Float = Late Finish - Early Finish', FT_Min: 'Smallest of Start Float and Finish Float' } as Record<string, string>)[v] ?? v,
    sched_open_critical_flag: yesNo, sched_use_expect_end_flag: yesNo, enable_multiple_longest_path_calc: yesNo,
    sched_outer_depend_type: (v) => (v === 'SD_None' ? 'Yes' : v === 'SD_Both' ? 'No' : v),
    sched_lag_early_start_flag: (v) => (v === 'Y' ? 'Early Start' : v === 'N' ? 'Actual Start' : v),
    use_total_float_multiple_longest_paths: (v) => (v === 'Y' ? 'Total Float' : v === 'N' ? 'Free Float' : v),
  },
  PROJECT: { critical_path_type: (v) => (v === 'CT_DrivPath' ? 'Longest Path' : v === 'CT_TotFloat' ? 'Total Float less than or equal to' : v) },
  TASKRSRC: { cost_qty_link_flag: yesNo }, TASKPROC: { complete_flag: yesNo }, FINTMPL: { default_flag: yesNo }, CALENDAR: { default_flag: yesNo },
};
/** What the file keeps for itself, never a value a person sets: the keys P6 generates, and who changed a row and when. The operation that rewrites them
 *  (regenerate_guids, clear_authors) answers what it did with its own counts; they are not listed change by change. */
const BOOKKEEPING = /(^|_)guid$|^(create|update)_(date|user)$|^(add_by_name|user_id|ts_approve_user_id|checkout_user_id|seq_num|last_chng_date)$/;
/** Columns that hold a number (hours, units, money, a percentage, a weight, a count): said as a number, not as the file's text. */
const NUMERIC = /(_cnt|_qty|_cost|_pct|_wt|^cost_per_qty|^max_multiple_longest_path|^bcw[ps])$/;
/** A column the file keeps and derives itself on an assignment (the lag still to run, this period's figures). */
const ASSIGNMENT_DERIVED = /^(relag_drtn_hr_cnt|act_this_per_.*|rem_late_.*|remain_qty_per_hr|.*_per_hr_rate)$/;
/** P6's name for a text column no list above holds, from P6's word for its table: "Role Name", "Currency ID", "Resource Notes" (null: no such name can be made). */
const nameByKind = (table: string, column: string): string | null => {
  const t = TABLE_WORD[table], own = (KEYS[table] ?? '').replace(/_id$/, ''); if (!t || !own) return null;
  // only the table's OWN name, ID, description and notes (the columns named after its key: rsrc_id -> rsrc_name): another "_name" in the row is something else (who added it, a copied name)
  const m = new RegExp(`^${own}_(short_name|name|descr|notes)$`).exec(column);
  return m ? `${t} ${({ short_name: 'ID', name: 'Name', descr: 'Description', notes: 'Notes' } as Record<string, string>)[m[1]]}` : null;
};
/** P6's option "When scheduling progressed activities use", from its two columns as the scheduler reads them (optionsFor in core/schedule/cpm.ts): override wins, then "not retained" is actual dates. */
const logicChoice = (retained: string, override: string): string => (override === 'Y' ? 'Progress Override' : retained === 'N' ? 'Actual Dates' : 'Retained Logic');
/** Notebook text as a person reads it: the HTML P6 stores without its tags. */
const plainText = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, ' ') /* (P6 writes a line break in a file as two DEL characters) */.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
/** The fields that decide the dates F9 gives: an edit of one leaves the saved dates not current. */
const DATE_DRIVING = new Set(['target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'act_start_date', 'act_end_date', 'status_code', 'task_type', 'clndr_id', 'cstr_type', 'cstr_date', 'cstr_type2', 'cstr_date2', 'lag_hr_cnt', 'pred_type']);
const text = (v: unknown): string => (v === ABSENT || v == null ? '' : String(v));
const OLE_DAY0 = 25569; // 1970-01-01 as an OLE serial day
const dayText = (serial: number): string => new Date((serial - OLE_DAY0) * 86400000).toISOString().slice(0, 10);

/** What a calendar's data change did: the work week, and the days made an exception or no longer one (dates, by the list rule). */
function calendarChange(was: string, now: string): { field: string; old: string | null; new: string }[] {
  const a = parseClndrDataLeniently(was), b = parseClndrDataLeniently(now), out: { field: string; old: string | null; new: string }[] = [];
  if (!a || !b) return [{ field: 'Work Time', old: null, new: 'changed' }];
  const shifts = (l: { start: number; end: number }[]) => l.map((x) => `${x.start}-${x.end}`).join(',');
  if (a.week.map(shifts).join('|') !== b.week.map(shifts).join('|')) out.push({ field: 'Standard Work Week', old: null, new: 'changed' });
  const added = [...b.exceptions].filter(([d, sh]) => shifts(a.exceptions.get(d) ?? [{ start: -1, end: -1 }]) !== shifts(sh)).map(([d]) => dayText(d)).sort();
  const removed = [...a.exceptions.keys()].filter((d) => !b.exceptions.has(d)).map(dayText).sort();
  if (added.length) out.push({ field: 'Calendar Exceptions Added', old: null, new: namesText(added) });
  if (removed.length) out.push({ field: 'Calendar Exceptions Removed', old: null, new: namesText(removed) });
  return out;
}

/** The changes a journal holds, and whether any of them can change the dates F9 gives. */
export function describeChanges(db: Db, j: Journal, hoursPerDay = 8): { changes: FieldChange[]; datesAffected: boolean; /** columns named by their own words: no P6 name is recorded for them */ unnamed: string[] } {
  const all: FieldChange[] = [], rowOfChange = new Map<FieldChange, unknown>();
  let datesAffected = false;
  const dh = dayHours(db, 8, true);
  const tasks = new Map<string, Row>();
  const task = (id: string) => { if (!tasks.size) for (const t of db.tables.TASK?.rows ?? []) tasks.set(t.task_id, t); return tasks.get(id); };
  const projects = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
  const calendars = new Map((db.tables.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c]));
  const resources = new Map((db.tables.RSRC?.rows ?? []).map((r) => [r.rsrc_id, r]));
  const gone = new Map<string, Row>();
  /** rows this edit removed, by table-like kind: an id that pointed at one is still named by what the agent called it */
  const goneProjects = new Map<string, Row>(), goneCalendars = new Map<string, Row>(), goneAccounts = new Map<string, Row>(), goneCurves = new Map<string, Row>(), goneResources = new Map<string, Row>();
  const unnamed = new Set<string>();
  const removedRows: Obj[] = [];
  // which table a row is of (looked up only when a row of another kind than an activity or a relationship changed)
  let tableByRow: Map<unknown, string> | null = null;
  const tableOf = (r: unknown): string => {
    if (!tableByRow) { tableByRow = new Map(); for (const [name, t] of Object.entries(db.tables)) if (name !== 'TASK' && name !== 'TASKPRED') for (const x of t.rows) tableByRow.set(x, name); }
    return tableByRow.get(r) ?? '';
  };
  // (a row this edit removed is still found by its key: what pointed at it is named by what the agent called it)
  const find = (tbl: string, key: string, v: unknown): Row | undefined => (db.tables[tbl]?.rows ?? []).find((x) => x[key] === text(v)) ?? (removedRows.find((x) => key in x && x[key] === text(v) && (key !== 'role_id' || 'role_short_name' in x) && (key !== 'fin_dates_id' || 'fin_dates_name' in x)) as Row | undefined);
  const projectId = (id: unknown): string => text((projects.get(text(id)) ?? goneProjects.get(text(id)))?.proj_short_name ?? id);
  const calendarName = (id: unknown): string => text((calendars.get(text(id)) ?? goneCalendars.get(text(id)))?.clndr_name ?? id);
  const accountId = (id: unknown): string => text((find('ACCOUNT', 'acct_id', id) ?? goneAccounts.get(text(id)))?.acct_short_name ?? id);
  const curveName = (id: unknown): string => text((find('RSRCCURVDATA', 'curv_id', id) ?? goneCurves.get(text(id)))?.curv_name ?? id);
  const roleId = (id: unknown): string => text(find('ROLES', 'role_id', id)?.role_short_name ?? id);
  const topicName = (id: unknown): string => text(find('MEMOTYPE', 'memo_type_id', id)?.memo_type ?? 'Notes');
  /** A WBS element as the agent names it: its dotted code path under the project (the project's own node by its code), with the baseline it is a row of when it is one. */
  const wbsPath = (w: Obj): string => {
    const W = db.tables.PROJWBS?.rows ?? [], parts: string[] = [];
    for (let x: Obj | undefined = w, n = 0; x && n < 64; n++) { if (x.proj_node_flag === 'Y' && parts.length) break; parts.unshift(text(x.wbs_short_name)); if (x.proj_node_flag === 'Y') break; x = W.find((y) => y.wbs_id === x!.parent_wbs_id); }
    const p = projects.get(text(w.proj_id)) ?? goneProjects.get(text(w.proj_id));
    return `${parts.join('.')}${p?._baseline_of ? ` in baseline ${p.proj_short_name}` : ''}`;
  };
  const wbsCode = (id: unknown): string => { const w = find('PROJWBS', 'wbs_id', id); return w ? wbsPath(w) : text(id); };
  /** A row of another table, as the agent names it. */
  const rowId = (tbl: string, r: Obj): string => {
    switch (tbl) {
      case 'SCHEDOPTIONS': return projectId(r.proj_id);
      case 'ACTVTYPE': return text(r.actv_code_type);
      case 'PCATTYPE': return text(r.proj_catg_type);
      case 'RCATTYPE': return text(r.rsrc_catg_type);
      case 'ASGNMNTCATTYPE': return text(r.asgnmnt_catg_type);
      case 'ACTVCODE': return `${text(find('ACTVTYPE', 'actv_code_type_id', r.actv_code_type_id)?.actv_code_type)} = ${text(r.short_name)}`;
      case 'PCATVAL': return `${text(find('PCATTYPE', 'proj_catg_type_id', r.proj_catg_type_id)?.proj_catg_type)} = ${text(r.proj_catg_short_name)}`;
      case 'RCATVAL': return `${text(find('RCATTYPE', 'rsrc_catg_type_id', r.rsrc_catg_type_id)?.rsrc_catg_type)} = ${text(r.rsrc_catg_short_name)}`;
      case 'ASGNMNTCATVAL': return `${text(find('ASGNMNTCATTYPE', 'asgnmnt_catg_type_id', r.asgnmnt_catg_type_id)?.asgnmnt_catg_type)} = ${text(r.asgnmnt_catg_short_name)}`;
      case 'UDFTYPE': return text(r.udf_type_label);
      case 'PROJCOST': return `${code(text(r.task_id))} / ${text(r.cost_name)}`;
      case 'TASKPROC': return `${code(text(r.task_id))} / ${text(r.proc_name)}`;
      case 'TASKMEMO': return `${code(text(r.task_id))} / ${topicName(r.memo_type_id)}`;
      case 'WBSMEMO': return `${wbsCode(r.wbs_id)} / ${topicName(r.memo_type_id)}`;
      case 'ACCOUNT': return text(r.acct_short_name);
      case 'EPS': return text(r.eps_short_name);
      case 'OBS': return text(r.obs_name);
      case 'POBS': return text(r.pobs_name);
      case 'ROLES': return text(r.role_short_name);
      case 'RSRCCURVDATA': return text(r.curv_name);
      case 'FINDATES': return text(r.fin_dates_name);
      case 'FINTMPL': return text(r.fintmpl_name);
      case 'PROJWBS': return wbsPath(r);
      case '_RISKEST': return code(text(r.task_id));
      case 'TASKFIN': return `${code(text(r.task_id))} / ${text(find('FINDATES', 'fin_dates_id', r.fin_dates_id)?.fin_dates_name ?? r.fin_dates_id)}`;
      case 'TRSRCFIN': { const a = find('TASKRSRC', 'taskrsrc_id', r.taskrsrc_id); return `${code(text(r.task_id ?? a?.task_id))} ${a ? (a.rsrc_id ? rsrcName(a.rsrc_id) : roleId(a.role_id)) : ''} / ${text(find('FINDATES', 'fin_dates_id', r.fin_dates_id)?.fin_dates_name ?? r.fin_dates_id)}`; }
      case 'CURRTYPE': return text(r.curr_short_name ?? r.curr_type);
      case 'MEMOTYPE': return text(r.memo_type);
      default: return text(r.rsrc_short_name ?? r.proj_short_name ?? r.wbs_short_name ?? r.clndr_name ?? r.actv_code_name ?? r.udf_type_label ?? r.task_pred_id ?? r.taskrsrc_id ?? r.rsrc_id ?? '');
    }
  };
  /** An activity as the agent names it: its Activity ID, and the baseline it is a row of when it is one (an edit reaches a stored baseline's copy, e.g. replace_text). */
  const taskName = (t: Obj): string => { const p = projects.get(text(t.proj_id)); return p?._baseline_of ? `${text(t.task_code)} in baseline ${p.proj_short_name}` : text(t.task_code); };
  const code = (id: string) => { const t = task(id) ?? gone.get(id); return t ? taskName(t) : id; };
  const rsrcName = (id: unknown) => text((resources.get(text(id)) ?? goneResources.get(text(id)))?.rsrc_short_name ?? id);
  // a file with several projects: each change says whose it is (an Activity ID, a WBS code or an expense name can be in more than one)
  const several = [...projects.values()].filter((p) => !p._baseline_of).length > 1;
  const out = (c: FieldChange, r?: unknown) => {
    const o = r && typeof r === 'object' ? r as Obj : undefined;
    const pid = o ? text('proj_id' in o ? o.proj_id : 'task_id' in o ? (task(text(o.task_id)) ?? gone.get(text(o.task_id)))?.proj_id : '') : '';
    const p = pid ? projects.get(pid) ?? goneProjects.get(pid) : undefined;
    const owner = p ? (p._baseline_of ? projects.get(text(p._baseline_of)) ?? p : p) : undefined;
    const ch = several && owner && c.project == null && c.id !== text(owner.proj_short_name) ? { id: c.id, project: text(owner.proj_short_name), field: c.field, old: c.old, new: c.new } : c;
    all.push(ch); rowOfChange.set(ch, r);
  };
  // rows added or removed: a table made or dropped by this edit (its rows), or an array that grew or shrank
  const added = new Set<unknown>(), seen = new Set<unknown>(), madeProjects = new Set<string>();
  // (the project rows first: what belongs to a project this edit made is not listed row by row)
  for (const [row, keys] of j.fields) { const tbl = row as { name?: unknown; rows?: Obj[] }; if (tbl.name !== 'PROJECT' || !Array.isArray(tbl.rows)) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const was = new Set(keys[i + 1] as Obj[]); for (const r of tbl.rows) if (!was.has(r)) madeProjects.add(text(r.proj_id)); } }
  for (const [arr, before] of j.arrays) if (arr === db.tables.PROJECT?.rows) { const was = new Set(before as Obj[]); for (const r of arr as Obj[]) if (!was.has(r)) madeProjects.add(text(r.proj_id)); }
  // (and the projects this edit deleted, a baseline with them: found before any row is listed, so their activities, WBS and relationships are not listed one by one)
  const removedProjects = new Set<string>();
  for (const [arr, before] of j.arrays) if (arr === db.tables.PROJECT?.rows) { const now = new Set(arr as Obj[]); for (const r of before as Obj[]) if (!now.has(r)) removedProjects.add(text(r.proj_id)); }
  for (const [row, keys] of j.fields) { const tbl = row as { name?: unknown; rows?: Obj[] }; if (tbl.name !== 'PROJECT' || !Array.isArray(tbl.rows)) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const now = new Set(tbl.rows); for (const r of keys[i + 1] as Obj[]) if (!now.has(r)) removedProjects.add(text(r.proj_id)); } }
  // every row this edit removed, gathered before anything is listed: what pointed at one (an assignment's resource, a project's calendar, a baseline slot) is named by what the agent called it
  for (const [arr, before] of j.arrays) { const now = new Set(arr as Obj[]); for (const r of before as Obj[]) if (r && typeof r === 'object' && !now.has(r)) removedRows.push(r); }
  for (const [row, keys] of j.fields) {
    const tbl = row as { rows?: Obj[]; fields?: unknown };
    if (row === db.tables) { for (let i = 0; i < keys.length; i += 2) { const was = keys[i + 1] as { rows?: Obj[] } | typeof ABSENT; if (was !== ABSENT && was?.rows && !db.tables[keys[i] as string]) removedRows.push(...was.rows); } continue; }
    if (!Array.isArray(tbl.rows) || !Array.isArray(tbl.fields)) continue;
    for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const now = new Set(tbl.rows); for (const r of keys[i + 1] as Obj[]) if (!now.has(r)) removedRows.push(r); }
  }
  for (const r of removedRows) {
    if ('proj_short_name' in r && 'proj_id' in r && !('task_id' in r) && !('wbs_id' in r)) goneProjects.set(text(r.proj_id), r as Row);
    else if ('clndr_name' in r && 'clndr_id' in r) goneCalendars.set(text(r.clndr_id), r as Row);
    else if ('acct_short_name' in r) goneAccounts.set(text(r.acct_id), r as Row);
    else if ('curv_name' in r) goneCurves.set(text(r.curv_id), r as Row);
    else if ('rsrc_short_name' in r && 'rsrc_id' in r) goneResources.set(text(r.rsrc_id), r as Row);
  }
  // the projects whose Project ID this edit changed: their root WBS node's code follows it and is not said a second time
  const renamedProjects = new Set<string>();
  for (const [row, keys] of j.fields) { const r = row as Obj; if (!('proj_short_name' in r) || 'wbs_id' in r || 'task_id' in r) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'proj_short_name') renamedProjects.add(text(r.proj_id)); }
  for (const [row, keys] of j.fields) {
    if (row !== db.tables) continue;
    for (let i = 0; i < keys.length; i += 2) {
      const k = keys[i] as string, was = keys[i + 1] as { rows?: Obj[] } | typeof ABSENT, now = db.tables[k] as { rows?: Obj[] } | undefined;
      if (was === ABSENT && now?.rows) for (const x of now.rows) { added.add(x); seen.add(x); add('added', x); }
      else if (was !== ABSENT && was?.rows && !now) for (const x of was.rows) { seen.add(x); add('removed', x); }
    }
  }
  // a table whose list of rows was replaced by a new list (a copy made, rows filtered out): the rows only the new list has are added, the ones only the old list had are removed
  for (const [row, keys] of j.fields) {
    const tbl = row as { rows?: Obj[]; fields?: unknown };
    if (row === db.tables || !Array.isArray(tbl.rows) || !Array.isArray(tbl.fields)) continue;
    for (let i = 0; i < keys.length; i += 2) {
      if (keys[i] !== 'rows' || !Array.isArray(keys[i + 1])) continue;
      const was = new Set(keys[i + 1] as Obj[]), now = new Set(tbl.rows);
      for (const r of tbl.rows) if (!was.has(r) && !seen.has(r)) { seen.add(r); added.add(r); add('added', r); }
      for (const r of was) if (!now.has(r) && !seen.has(r)) { seen.add(r); add('removed', r); }
    }
  }
  for (const [, before] of j.arrays) for (const r of before as Obj[]) if (r && typeof r === 'object' && 'task_id' in r && 'task_code' in r) gone.set(text(r.task_id), r as Row); // the activities an edit deleted: their code still names their relationships
  for (const [arr, before] of j.arrays) {
    const was = new Set(before as Obj[]), now = new Set(arr as Obj[]);
    for (const r of arr as Obj[]) if (!was.has(r) && !seen.has(r)) { seen.add(r); added.add(r); add('added', r); }
    for (const r of before as Obj[]) if (!now.has(r) && !seen.has(r)) { seen.add(r); add('removed', r); }
  }
  function add(what: 'added' | 'removed', r: Obj) {
    if (!r || typeof r !== 'object') return; // a table's field list grew (a column name), not a row
    if ('proj_short_name' in r && 'proj_id' in r && !('task_id' in r) && !('wbs_id' in r)) { if (what === 'added') madeProjects.add(text(r.proj_id)); out({ id: text(r.proj_short_name), field: r._baseline_of ? 'baseline' : 'project', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }); return; }
    if ('proj_id' in r && (madeProjects.has(text(r.proj_id)) || removedProjects.has(text(r.proj_id)))) return; // the contents of a project this edit made or deleted (a baseline's copy of every activity): said by the project's own line
    const row = (id: string, field: string) => out({ id, field, old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }, r);
    if ('task_code' in r && 'task_id' in r && 'proj_id' in r && !('pred_task_id' in r)) { row(taskName(r), 'activity'); datesAffected = true; }
    else if ('pred_task_id' in r) { row(`${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, 'relationship'); datesAffected = true; }
    else if ('rsrc_id' in r && 'task_id' in r) row(`${code(text(r.task_id))} ${r.rsrc_id ? rsrcName(r.rsrc_id) : roleId(r.role_id)}`, 'resource assignment');
    else if ('rsrc_short_name' in r) row(text(r.rsrc_short_name), 'resource');
    else if ('wbs_short_name' in r) row(wbsPath(r), 'WBS');
    else if ('clndr_name' in r) row(text(r.clndr_name), 'calendar');
    else if ('schedoptions_id' in r && what === 'added') {
      // a project's first saved schedule options (the file held none): each option now saved is said, from nothing saved
      const labels = TABLE_FIELDS.SCHEDOPTIONS, words = TABLE_WORDS.SCHEDOPTIONS, id = projectId(r.proj_id);
      if (text(r.sched_retained_logic) !== '' || text(r.sched_progress_override) !== '') out({ id, field: 'When scheduling progressed activities use', old: null, new: logicChoice(text(r.sched_retained_logic), text(r.sched_progress_override)) }, r);
      for (const [k, label] of Object.entries(labels)) { const v = text(r[k]); if (v !== '') out({ id, field: label, old: null, new: k === 'key_activity_for_multiple_longest_paths' ? code(v) : words[k] ? words[k](v) : NUMERIC.test(k) && Number.isFinite(Number(v)) ? Number(v) : v }, r); }
    }
  }
  // fields a person set on a row that existed
  const durationChanged = new Set<string>();
  for (const [row, keys] of j.fields) { const r = row as Obj; if ('task_code' in r && 'task_id' in r && !('pred_task_id' in r) && keys.some((x, n) => n % 2 === 0 && (x === 'target_drtn_hr_cnt' || x === 'remain_drtn_hr_cnt' || x === 'act_start_date' || x === 'act_end_date'))) durationChanged.add(text(r.task_id)); }
  for (const [row, keys] of j.fields) {
    const r = row as Obj;
    if (row === db.tables || (Array.isArray(r.rows) && Array.isArray(r.fields))) continue; // said above (a table, or its list of rows)
    if ('proj_id' in r && madeProjects.has(text(r.proj_id))) continue; // a project this edit made: its one line says it
    if ('task_code' in r && 'task_id' in r && 'proj_id' in r && !('pred_task_id' in r)) {
      if (added.has(r)) continue;
      const hpd = dh.task(r as Row);
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string, f = TASK_FIELDS[k];
        if (!f) continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        if (k === 'remain_drtn_hr_cnt' && !r.act_start_date && keys.some((x, n) => n % 2 === 0 && x === 'target_drtn_hr_cnt')) continue; // a task not started: its remaining duration follows the duration, said once
        const name = (v: string) => (v === '' ? null : k === 'clndr_id' ? calendarName(v) : k === 'wbs_id' ? wbsCode(v) : k === 'rsrc_id' ? rsrcName(v) : wordOf(k, v));
        out({ id: k === 'task_code' ? text(keys[i + 1]) : taskName(r), field: f.label, old: f.days ? (was === '' ? null : Math.round((Number(was) / hpd) * 100) / 100) : name(was), new: f.days ? Math.round((Number(now) / hpd) * 100) / 100 : name(now) }, r);
        if (DATE_DRIVING.has(k)) datesAffected = true;
      }
    } else if ('pred_task_id' in r) {
      if (added.has(r)) continue; // a relationship made by this edit is said as added
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k !== 'lag_hr_cnt' && k !== 'pred_type') continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        const hpd = dh.rel(r as Row), days = (v: string) => Math.round((Number(v || 0) / hpd) * 100) / 100;
        out({ id: `${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, field: k === 'lag_hr_cnt' ? 'Lag (days)' : 'Relationship Type', old: k === 'lag_hr_cnt' ? days(was) : wordOf(k, was), new: k === 'lag_hr_cnt' ? days(now) : wordOf(k, now) }, r);
        datesAffected = true;
      }
    } else {
      // any other row (a resource, an assignment, a calendar, a project, a schedule option, a code, an expense ...): named by what the agent uses
      // (Resource ID, calendar name, Project ID, "activity / expense" ...), the fields and their coded values as P6 names them
      const assignment = 'rsrc_id' in r && 'task_id' in r && 'taskrsrc_id' in r, rate = 'rsrc_rate_id' in r;
      const tbl = tableOf(r), labels = TABLE_FIELDS[tbl], words = TABLE_WORDS[tbl];
      if ('proj_id' in r && removedProjects.has(text(r.proj_id))) continue; // a project this edit deleted: its one line says it
      if (added.has(r)) continue; // a row made by this edit is said as added (a project's first schedule options: option by option, in add)
      const id = assignment ? `${code(text(r.task_id))} ${r.rsrc_id ? rsrcName(r.rsrc_id) : roleId(r.role_id)}` : rate ? rsrcName(r.rsrc_id) : rowId(tbl, r);
      const projectNode = tbl === 'PROJWBS' && r.proj_node_flag === 'Y';
      const changed = (k: string): boolean => keys.some((x, n) => n % 2 === 0 && x === k);
      const wasOf = (k: string): string => { const at = keys.findIndex((x, n) => n % 2 === 0 && x === k); return at < 0 ? text(r[k]) : text(keys[at + 1]); };
      // an assignment's units and costs follow its units a day and its activity's duration: they are a person's own change only when neither of those moved in this edit
      const unitsDerived = assignment && durationChanged.has(text(r.task_id));
      const unitsMoved = assignment && ['target_qty_per_hr', 'target_qty', 'remain_qty', 'act_reg_qty', 'act_ot_qty'].some(changed);
      // a cost is a person's own when costs are entered (not calculated from units), or when no units moved with it
      const costsEntered = assignment && text(r.cost_qty_link_flag) === 'N';
      const cols = keys.filter((_, n) => n % 2 === 0) as string[];
      let logicSaid = false;
      for (const k of cols) {
        const baselineSlot = 'proj_short_name' in r ? BASELINE_SLOTS[k] : undefined;
        if (!labels?.[k] && BOOKKEEPING.test(k)) continue; // the file's own bookkeeping (who and when, generated keys): the operation's answer says what it did
        const label = labels?.[k] ?? (tbl === 'PROJECT' || tbl === 'RSRC' || tbl === 'CALENDAR' || tbl === 'PROJWBS' || tbl === 'RSRCRATE' || tbl === 'TASKRSRC' || tbl === 'PROJCOST' ? OTHER_FIELDS[k] : undefined) ?? nameByKind(tbl, k) ?? undefined;
        // the file's own bookkeeping, and the dates and floats the scheduler works out (a column P6 names for a person is never one of these)
        if (!baselineSlot && !label && (k.startsWith('_') || BOOKKEEPING.test(k) || k === KEYS[tbl] || /(?:^|_)(?:early|late|total_float|free_float|reend|restart|rem_late|rem_early|scd_)/.test(k))) continue;
        if (k === 'proj_id' && tbl !== 'PROJECT') continue; // rows follow their project's internal number: said once, on the project
        if (tbl === 'RSRCROLE' && /^(rsrc|role)_(short_)?name$/.test(k)) continue; // the copy of a resource's or a role's name the file keeps beside their pairing: said on the resource or the role
        const before = keys[keys.findIndex((x, n) => n % 2 === 0 && x === k) + 1];
        if (before !== ABSENT && before != null && typeof before === 'object') continue; // not a value a person sets
        const was = text(before), now = text(r[k]);
        if (was === now && !(tbl === 'SCHEDOPTIONS' && (k === 'sched_retained_logic' || k === 'sched_progress_override'))) continue;
        // (a text that reads as nothing — an empty HTML body, blanks — is nothing: a change from nothing to nothing is not said)
        const seen = (v: FieldChange['old']): FieldChange['old'] => (typeof v === 'string' && v.trim() === '' ? null : v);
        const say = (field: string, old: FieldChange['old'], nw: FieldChange['new']) => { const o = seen(old), n = seen(nw); if (o == null && n == null) return; out({ id, field, old: o, new: n }, r); };
        if (baselineSlot) { const bl = (v: string) => (v === '' ? null : projectId(v)); say(baselineSlot, bl(was), bl(now)); continue; }
        if (k === 'critical_drtn_hr_cnt' && tbl === 'PROJECT') { const days = (v: string) => Math.round((Number(v || 0) / hoursPerDay) * 100) / 100; say('Critical activities: Total Float at or below (days)', days(was), days(now)); continue; }
        if ((tbl === 'PROJECT' && /^(last_recalc_date|plan_start_date|plan_end_date)$/.test(k)) || (tbl === 'CALENDAR' && k === 'clndr_data')) datesAffected = true; // the data date, the planned start, Must Finish By and the work time of a calendar decide the dates F9 gives
        // P6's one option "When scheduling progressed activities use" is two columns in the file: said once, by its three choices, read as the scheduler reads them (optionsFor in cpm.ts)
        if (tbl === 'SCHEDOPTIONS' && (k === 'sched_retained_logic' || k === 'sched_progress_override')) {
          if (logicSaid) continue;
          logicSaid = true;
          const b = logicChoice(wasOf('sched_retained_logic'), wasOf('sched_progress_override')), a = logicChoice(text(r.sched_retained_logic), text(r.sched_progress_override));
          if (b !== a) say('When scheduling progressed activities use', b, a);
          continue;
        }
        if (tbl === 'SCHEDOPTIONS' && k === 'key_activity_for_multiple_longest_paths') { say(labels![k], was === '' ? null : code(was), now === '' ? null : code(now)); continue; }
        if (assignment) {
          if (ASSIGNMENT_DERIVED.test(k)) continue;
          if (k === 'target_qty_per_hr') { say('Budgeted Units/Time (units a day)', was === '' ? null : Math.round(Number(was) * hoursPerDay * 100) / 100, Math.round(Number(now) * hoursPerDay * 100) / 100); continue; }
          if (/^(target_qty|remain_qty|act_reg_qty|act_ot_qty)$/.test(k)) { if (unitsDerived) continue; say(labels![k], was === '' ? null : Number(was), Number(now)); continue; }
          if (/^(target_cost|act_reg_cost|act_ot_cost|remain_cost)$/.test(k)) { if (!costsEntered && (unitsDerived || unitsMoved)) continue; say(labels![k], was === '' ? null : Number(was), Number(now)); continue; }
          if (/^(target|remain|act)_(equip_qty|drtn|work_qty|cost|qty)|_drtn_hr_cnt$/.test(k) && !label) continue; // the other totals the file keeps beside them
        }
        if (k === 'clndr_data' && tbl === 'CALENDAR') { for (const c of calendarChange(was, now)) out({ id, ...c }, r); continue; }
        if (k === 'max_qty_per_hr' && (tbl === 'RSRC' || rate)) { say(OTHER_FIELDS[k], was === '' ? null : Math.round(Number(was) * hoursPerDay * 100) / 100, Math.round(Number(now) * hoursPerDay * 100) / 100); continue; }
        // a project's root WBS node carries the project's name and repeats its ID: the name is the Project Name, the ID is said by the project's own line
        if (projectNode && k === 'wbs_short_name' && renamedProjects.has(text(r.proj_id))) continue;
        if (projectNode && k === 'wbs_name') { out({ id: projectId(r.proj_id), field: 'Project Name', old: was === '' ? null : was, new: now === '' ? null : now }, r); continue; }
        // a notebook: the text as a person reads it
        if ((tbl === 'TASKMEMO' && k === 'task_memo') || (tbl === 'WBSMEMO' && k === 'wbs_memo')) { say(labels![k], was === '' ? null : plainText(was), now === '' ? null : plainText(now)); continue; }
        // three-point estimates: days of the activity's calendar
        if (tbl === '_RISKEST' && /_hr$/.test(k)) { const t = task(text(r.task_id)); const hpd = t ? dh.task(t) : hoursPerDay; say(labels![k], was === '' ? null : Math.round((Number(was) / hpd) * 100) / 100, Math.round((Number(now) / hpd) * 100) / 100); continue; }
        const name = (v: string) => (v === '' ? null
          : k === 'clndr_id' || k === 'base_clndr_id' ? calendarName(v) : k === 'acct_id' || k === 'parent_acct_id' ? accountId(v) : k === 'curv_id' ? curveName(v) : k === 'role_id' || k === 'parent_role_id' ? roleId(v)
          : k === 'rsrc_id' || k === 'parent_rsrc_id' ? rsrcName(v) : k === 'parent_wbs_id' ? wbsCode(v) : k === 'parent_eps_id' ? text(find('EPS', 'eps_id', v)?.eps_short_name ?? v) : k === 'parent_obs_id' ? text(find('OBS', 'obs_id', v)?.obs_name ?? v)
          : k === '_eps_id' ? text(find('EPS', 'eps_id', v)?.eps_short_name ?? v) : k === 'fintmpl_id' ? text(find('FINTMPL', 'fintmpl_id', v)?.fintmpl_name ?? v) : k === 'last_fin_dates_id' ? text(find('FINDATES', 'fin_dates_id', v)?.fin_dates_name ?? v)
          : words?.[k] ? words[k](v) : NUMERIC.test(k) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : /(_descr|_notes)$/.test(k) && /<[a-zA-Z!\/][^>]*>/.test(v) ? plainText(v) || null : wordOf(k, v));
        if (label == null) unnamed.add(`${tbl || '?'}.${k}`);
        say(label ?? humanize(k), name(was), name(now));
      }
    }
  }
  // each change once (the same row can be journalled twice, a resource's limit lives on the resource and on its price row)
  const seenChange = new Set<string>(), rowNo = new Map<unknown, number>();
  return { changes: all.filter((c) => { const r0 = rowOfChange.get(c), r = r0 && typeof r0 === 'object' && ('rsrc_rate_id' in (r0 as Obj) || 'rsrc_short_name' in (r0 as Obj)) ? null : r0; /* a resource's limit lives on the resource and on its price row: one change */ let n = r == null ? 0 : rowNo.get(r); if (r != null && n == null) rowNo.set(r, (n = rowNo.size + 1)); const key = `${n}\u0000${c.id}\u0000${c.project ?? ''}\u0000${c.field}\u0000${c.old}\u0000${c.new}`; if (seenChange.has(key)) return false; seenChange.add(key); return true; }), datesAffected, unnamed: [...unnamed] };
}
