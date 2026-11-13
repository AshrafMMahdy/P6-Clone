// What an edit changed, read from the undo journal the edit was recorded in: per activity (or relationship, resource ...) the field, the old value and the new one, so the answer can say
// "A1010 duration: 8 -> 10 days". Only what a person sets is listed (names, durations, dates they gave, status, constraints, calendars, resource limits ...), never the dates the scheduler works out.
import { ABSENT, realOf, type Journal } from '../journal.ts';
import { KEYS, type Db, type Row } from '../db.ts';
import { dayHours } from './units.ts';
import { cstrName } from '../notes.ts';
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
const TASK_FIELDS: Record<string, { label: string; days?: boolean; number?: boolean }> = {
  task_name: { label: 'Activity Name' }, task_code: { label: 'Activity ID' }, target_drtn_hr_cnt: { label: 'Original Duration (days)', days: true }, remain_drtn_hr_cnt: { label: 'Remaining Duration (days)', days: true },
  proj_id: { label: 'Project' }, act_start_date: { label: 'Actual Start' }, act_end_date: { label: 'Actual Finish' }, status_code: { label: 'Activity Status' }, task_type: { label: 'Activity Type' }, clndr_id: { label: 'Calendar' }, wbs_id: { label: 'WBS' },
  cstr_type: { label: 'Primary Constraint' }, cstr_date: { label: 'Primary Constraint Date' }, cstr_type2: { label: 'Secondary Constraint' }, cstr_date2: { label: 'Secondary Constraint Date' },
  complete_pct_type: { label: 'Percent Complete Type' }, phys_complete_pct: { label: 'Physical % Complete' }, priority_type: { label: 'Leveling Priority' },
  expect_end_date: { label: 'Expected Finish' }, rsrc_id: { label: 'Primary Resource' },
  act_this_per_work_qty: { label: 'Actual This Period Labor Units', number: true }, act_this_per_equip_qty: { label: 'Actual This Period Nonlabor Units', number: true },
  duration_type: { label: 'Duration Type' }, suspend_date: { label: 'Suspend Date' }, resume_date: { label: 'Resume Date' }, est_wt: { label: 'Est Weight', number: true },
  target_work_qty: { label: 'Budgeted Labor Units', number: true }, remain_work_qty: { label: 'Remaining Labor Units', number: true }, act_work_qty: { label: 'Actual Labor Units', number: true },
  target_equip_qty: { label: 'Budgeted Nonlabor Units', number: true }, remain_equip_qty: { label: 'Remaining Nonlabor Units', number: true }, act_equip_qty: { label: 'Actual Nonlabor Units', number: true },
  auto_compute_act_flag: { label: 'Auto Compute Actuals' }, external_early_start_date: { label: 'External Early Start' }, external_late_end_date: { label: 'External Late Finish' },
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
  PROJECT: { critical_path_type: 'Define critical activities as', _eps_id: 'EPS', clndr_id: 'Default Calendar', fintmpl_id: 'Financial Period Calendar', last_fin_dates_id: 'Last Financial Period Stored', proj_id: 'Internal project number', act_this_per_link_flag: 'Link actual to date and actual this period units and costs' },
  TASKRSRC: { task_id: 'Activity', rsrc_id: 'Resource', curv_id: 'Curve', cost_qty_link_flag: 'Calculate costs from units', target_cost: 'Budgeted Cost', act_reg_cost: 'Actual Regular Cost', act_ot_cost: 'Actual Overtime Cost', remain_cost: 'Remaining Cost', acct_id: 'Cost Account', role_id: 'Role',
    target_qty: 'Budgeted Units', remain_qty: 'Remaining Units', act_reg_qty: 'Actual Regular Units', act_ot_qty: 'Actual Overtime Units', act_start_date: 'Actual Start', act_end_date: 'Actual Finish',
    target_qty_per_hr: 'Budgeted Units/Time (units a day)', remain_qty_per_hr: 'Remaining Units/Time (units a day)', target_lag_drtn_hr_cnt: 'Original Lag (days)', relag_drtn_hr_cnt: 'Remaining Lag (days)',
    target_drtn_hr_cnt: 'Original Duration (days)', remain_drtn_hr_cnt: 'Remaining Duration (days)', act_this_per_qty: 'Actual This Period Units', act_this_per_cost: 'Actual This Period Cost' },
  UDFVALUE: { udf_text: 'User Defined Field Value', udf_number: 'User Defined Field Value', udf_date: 'User Defined Field Value', udf_code_id: 'User Defined Field Value' },
  PROJWBS: { parent_wbs_id: 'Parent WBS' },
  RSRC: { clndr_id: 'Calendar', parent_rsrc_id: 'Parent Resource', rsrc_title_name: 'Resource Title' },
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
  RSRCROLE: { skill_level: 'Proficiency' }, ROLERATE: { cost_per_qty: 'Price / Unit', start_date: 'Effective Date', max_qty_per_hr: 'Max Units/Time (units an hour)' }, THRSPARM: { thresh_parm_name: 'Threshold Parameter' },
  RSRCCURVDATA: { curv_name: 'Resource Curve Name' },
  FINDATES: { fin_dates_name: 'Financial Period Name', start_date: 'Start Date', end_date: 'End Date' }, FINTMPL: { fintmpl_name: 'Financial Period Calendar Name', default_flag: 'Default' },
  TASKMEMO: { task_memo: 'Notebook Text' }, WBSMEMO: { wbs_memo: 'Notebook Text' },
};
const TABLE_WORDS: Record<string, Record<string, (v: string) => string>> = {
  RSRCROLE: { skill_level: (v) => ({ 1: '1 - Master', 2: '2 - Expert', 3: '3 - Skilled', 4: '4 - Proficient', 5: '5 - Inexperienced' } as Record<string, string>)[v] ?? v },
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
/** The kinds of row an edit adds or removes, in P6's words (a row of one of these is said as added or deleted, by the name the agent uses for it). */
const ROW_KIND: Record<string, string> = {
  PROJCOST: 'expense', TASKPROC: 'step', ACTVTYPE: 'activity code', PCATTYPE: 'project code', RCATTYPE: 'resource code', ASGNMNTCATTYPE: 'assignment code',
  ACTVCODE: 'activity code value', PCATVAL: 'project code value', RCATVAL: 'resource code value', ASGNMNTCATVAL: 'assignment code value', UDFTYPE: 'user defined field',
  ACCOUNT: 'cost account', EPS: 'EPS', OBS: 'OBS', POBS: 'performing organization', ROLES: 'role', RSRCCURVDATA: 'resource curve', FINDATES: 'financial period', FINTMPL: 'financial period calendar',
  CURRTYPE: 'currency', MEMOTYPE: 'notebook topic', ROLERATE: 'role price', THRSPARM: 'threshold parameter',
};
/** The rows that ARE a value of another row (a custom field's value, a code assigned, a notebook's text, a period's actuals): said as that value, from nothing or to nothing. */
const CODE_ASSIGNED: Record<string, { type: string; typeKey: string; typeName: string; val: string; valKey: string; valName: string; field: string }> = {
  TASKACTV: { type: 'ACTVTYPE', typeKey: 'actv_code_type_id', typeName: 'actv_code_type', val: 'ACTVCODE', valKey: 'actv_code_id', valName: 'short_name', field: 'Activity Code Value' },
  PROJPCAT: { type: 'PCATTYPE', typeKey: 'proj_catg_type_id', typeName: 'proj_catg_type', val: 'PCATVAL', valKey: 'proj_catg_id', valName: 'proj_catg_short_name', field: 'Project Code Value' },
  RSRCRCAT: { type: 'RCATTYPE', typeKey: 'rsrc_catg_type_id', typeName: 'rsrc_catg_type', val: 'RCATVAL', valKey: 'rsrc_catg_id', valName: 'rsrc_catg_short_name', field: 'Resource Code Value' },
  ASGNMNTACAT: { type: 'ASGNMNTCATTYPE', typeKey: 'asgnmnt_catg_type_id', typeName: 'asgnmnt_catg_type', val: 'ASGNMNTCATVAL', valKey: 'asgnmnt_catg_id', valName: 'asgnmnt_catg_short_name', field: 'Assignment Code Value' },
};
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
/** The columns of an activity the scheduler writes (its dates, floats and float paths; the planned dates of work not started follow them). */
const SCHEDULED = new Set(['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'target_start_date', 'target_end_date',
  'total_float_hr_cnt', 'free_float_hr_cnt', 'float_path', 'float_path_order', 'driving_path_flag']);
const OLE_DAY0 = 25569; // 1970-01-01 as an OLE serial day
const dayText = (serial: number): string => new Date((serial - OLE_DAY0) * 86400000).toISOString().slice(0, 10);

/** What a calendar's data change did: the work week, and the days made an exception or no longer one (dates, by the list rule). */
function calendarChange(was: string, now: string): { field: string; old: string | null; new: string }[] {
  const a = parseClndrDataLeniently(was), b = parseClndrDataLeniently(now), out: { field: string; old: string | null; new: string }[] = [];
  if (!a || !b) return [{ field: 'Work Time', old: null, new: 'changed' }];
  const shifts = (l: { start: number; end: number }[]) => l.map((x) => `${x.start}-${x.end}`).join(',');
  // the work week as its work hours per day, Sunday to Saturday (as P6's Workweek dialog lists them)
  const hours = (w: { start: number; end: number }[][]) => w.map((d, i) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]} ${Math.round((d.reduce((n, x) => n + x.end - x.start, 0) / 60) * 100) / 100}`).join(', ');
  const times = (w: { start: number; end: number }[][]) => w.map((d, i) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]} ${d.map((x) => `${clock(x.start)}-${clock(x.end)}`).join(' ') || 'no work'}`).join(', ');
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if (a.week.map(shifts).join('|') !== b.week.map(shifts).join('|')) out.push(hours(a.week) !== hours(b.week) ? { field: 'Standard Work Week (hours a day)', old: hours(a.week), new: hours(b.week) } : { field: 'Standard Work Week (work time)', old: times(a.week), new: times(b.week) });
  const added = [...b.exceptions].filter(([d, sh]) => shifts(a.exceptions.get(d) ?? [{ start: -1, end: -1 }]) !== shifts(sh)).map(([d]) => dayText(d)).sort();
  const removed = [...a.exceptions.keys()].filter((d) => !b.exceptions.has(d)).map(dayText).sort();
  // (every date: the change is one value, and the list of changes is what is cut, into a file that holds all of them)
  if (added.length) out.push({ field: 'Calendar Exceptions Added', old: null, new: added.join(', ') });
  if (removed.length) out.push({ field: 'Calendar Exceptions Removed', old: null, new: removed.join(', ') });
  return out;
}

/** The changes a journal holds, and whether any of them can change the dates F9 gives. */
export function describeChanges(db: Db, j: Journal, hoursPerDay = 8): { changes: FieldChange[]; datesAffected: boolean; /** the edit emptied calculated dates of an activity (a raw edit): the answer then says which projects have none */ datesCleared: boolean; /** columns named by their own words: no P6 name is recorded for them */ unnamed: string[] } {
  const all: FieldChange[] = [], rowOfChange = new Map<FieldChange, unknown>();
  let datesAffected = false, datesCleared = false;
  const dh = dayHours(db, hoursPerDay, true);
  const tasks = new Map<string, Row>();
  const task = (id: string) => { if (!tasks.size) for (const t of db.tables.TASK?.rows ?? []) tasks.set(t.task_id, t); return tasks.get(id); };
  const projects = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
  const calendars = new Map((db.tables.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c]));
  const resources = new Map((db.tables.RSRC?.rows ?? []).map((r) => [r.rsrc_id, r]));
  const gone = new Map<string, Row>();
  /** rows this edit removed, by table-like kind: an id that pointed at one is still named by what the agent called it */
  const goneProjects = new Map<string, Row>(), goneResources = new Map<string, Row>();
  const unnamed = new Set<string>();
  const removedRows: Obj[] = [], removedTable = new Map<unknown, string>();
  // which table a row is of (looked up only when a row of another kind than an activity or a relationship changed)
  let tableByRow: Map<unknown, string> | null = null;
  const tableOf = (r: unknown): string => {
    if (!tableByRow) { tableByRow = new Map(); for (const [name, t] of Object.entries(db.tables)) if (name !== 'TASK' && name !== 'TASKPRED') for (const x of t.rows) tableByRow.set(x, name); }
    return tableByRow.get(r) ?? removedTable.get(r) ?? '';
  };
  /** The table a row is of. An activity and a relationship are known by their columns (no other table has them, and a large file is not walked for a plain edit); every other row by the table that holds it. */
  const kindOf = (r: Obj): string => ('pred_task_id' in r ? 'TASKPRED' : 'task_code' in r && 'task_id' in r ? 'TASK' : tableOf(r));
  // (a row this edit removed is still found by its key: what pointed at it is named by what the agent called it)
  const byKey = new Map<string, Map<string, Row>>();
  const find = (tbl: string, key: string, v: unknown): Row | undefined => {
    let ix = byKey.get(`${tbl}|${key}`);
    if (!ix) { ix = new Map(); for (const x of removedRows) if (removedTable.get(x) === tbl && key in x) ix.set(text(x[key]), x as Row); for (const x of db.tables[tbl]?.rows ?? []) ix.set(text(x[key]), x); byKey.set(`${tbl}|${key}`, ix); }
    return ix.get(text(v));
  };
  /** What a row points at when the file does not hold it (a baseline exported without, a calendar left out): said as that, never by its internal number. */
  const missing = (what: string): string => `${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} that is not in the file`;
  const named = (r: Row | undefined, column: string, what: string): string => (r ? text(r[column]) : missing(what));
  const projectId = (id: unknown, what = 'project'): string => named(projects.get(text(id)) ?? goneProjects.get(text(id)), 'proj_short_name', what);
  const calendarName = (id: unknown): string => named(calendars.get(text(id)) ?? find('CALENDAR', 'clndr_id', id), 'clndr_name', 'calendar');
  const accountId = (id: unknown): string => named(find('ACCOUNT', 'acct_id', id), 'acct_short_name', 'cost account');
  const curveName = (id: unknown): string => named(find('RSRCCURVDATA', 'curv_id', id), 'curv_name', 'resource curve');
  const roleId = (id: unknown): string => named(find('ROLES', 'role_id', id), 'role_short_name', 'role');
  const topicName = (id: unknown): string => named(find('MEMOTYPE', 'memo_type_id', id), 'memo_type', 'notebook topic');
  /** A WBS element as the agent names it: its dotted code path under the project (the project's own node by its code), with the baseline it is a row of when it is one. */
  const wbsPath = (w: Obj): string => {
    const parts: string[] = [];
    // (a node already passed ends the walk: a damaged file can make a node its own ancestor)
    for (let x: Obj | undefined = w, passed = new Set<Obj>(); x && !passed.has(x); ) { passed.add(x); if (x.proj_node_flag === 'Y' && parts.length) break; parts.unshift(text(x.wbs_short_name)); if (x.proj_node_flag === 'Y') break; const up = text(x.parent_wbs_id); x = find('PROJWBS', 'wbs_id', up); }
    const p = projects.get(text(w.proj_id)) ?? goneProjects.get(text(w.proj_id));
    return `${parts.join('.')}${p?._baseline_of ? ` in baseline ${p.proj_short_name}` : ''}`;
  };
  const wbsCode = (id: unknown): string => { const w = find('PROJWBS', 'wbs_id', id); return w ? wbsPath(w) : missing('WBS'); };
  /** A relationship as the agent names it: predecessor, type, successor; an end that is in another project than the other says its Project ID. */
  const relName = (r: Obj): string => {
    const a = task(text(r.pred_task_id)) ?? gone.get(text(r.pred_task_id)), b = task(text(r.task_id)) ?? gone.get(text(r.task_id));
    const cross = !!a && !!b && a.proj_id !== b.proj_id;
    const end = (t: Row | undefined) => (t ? `${taskName(t)}${cross && !(projects.get(t.proj_id) ?? goneProjects.get(t.proj_id))?._baseline_of ? ` in ${projectId(t.proj_id)}` : ''}` : missing('activity'));
    return `${end(a)} ${text(r.pred_type || 'PR_FS').slice(3)} ${end(b)}`;
  };
  const inChangedProject = (r: Obj): boolean => {
    const changed = (id: string) => madeProjects.has(id) || removedProjects.has(id);
    // a relationship: both its ends (one that ties the project to ANOTHER project is that project's logic too, and is said)
    if ('pred_task_id' in r) return ['task_id', 'pred_task_id'].every((k) => changed(text((task(text(r[k])) ?? gone.get(text(r[k])))?.proj_id)));
    // a value of a project-level activity code belongs to the code's project
    if (!('proj_id' in r) && 'actv_code_type_id' in r && 'short_name' in r) return changed(text(find('ACTVTYPE', 'actv_code_type_id', r.actv_code_type_id)?.proj_id));
    const pids = ['proj_id' in r ? text(r.proj_id) : '', 'task_id' in r ? text((task(text(r.task_id)) ?? gone.get(text(r.task_id)))?.proj_id) : ''].filter(Boolean);
    return pids.some(changed);
  };
  const assignmentName = (a: Obj): string => `${code(text(a.task_id))} ${a.rsrc_id ? rsrcName(a.rsrc_id) : roleId(a.role_id)}`;
  const assignmentOf = (id: unknown): string => ((x) => (x ? assignmentName(x) : missing('assignment')))(find('TASKRSRC', 'taskrsrc_id', id));
  /** The row a custom field's value belongs to, by the name the agent uses for it. */
  const udfOwner = (v: Obj): string => {
    const tbl = text(find('UDFTYPE', 'udf_type_id', v.udf_type_id)?.table_name), id = v.fk_id;
    return tbl === 'TASK' ? code(text(id)) : tbl === 'PROJWBS' ? wbsCode(id) : tbl === 'PROJECT' ? projectId(id) : tbl === 'RSRC' ? rsrcName(id) : tbl === 'ROLE' ? roleId(id)
      : tbl === 'TASKRSRC' ? assignmentOf(id) : tbl === 'PROJCOST' ? ((x) => (x ? `${code(text(x.task_id))} / ${text(x.cost_name)}` : missing('expense')))(find('PROJCOST', 'cost_item_id', id))
      : tbl === 'TASKPROC' ? ((x) => (x ? `${code(text(x.task_id))} / ${text(x.proc_name)}` : missing('step')))(find('TASKPROC', 'proc_id', id)) : missing('row');
  };
  const udfValue = (v: Obj): string | number | null => (text(v.udf_text) !== '' ? text(v.udf_text) : text(v.udf_number) !== '' ? Number(v.udf_number) : text(v.udf_date) !== '' ? text(v.udf_date) : text(v.udf_code_id) !== '' ? named(find('UDFCODE', 'udf_code_id', v.udf_code_id), 'short_name', 'code value') : null);
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
      case 'UDFVALUE': return `${udfOwner(r)} / ${named(find('UDFTYPE', 'udf_type_id', r.udf_type_id), 'udf_type_label', 'user defined field')}`;
      case 'TASKACTV': case 'PROJPCAT': case 'RSRCRCAT': case 'ASGNMNTACAT': { const c = CODE_ASSIGNED[tbl]; const owner = tbl === 'TASKACTV' ? code(text(r.task_id)) : tbl === 'PROJPCAT' ? projectId(r.proj_id) : tbl === 'RSRCRCAT' ? rsrcName(r.rsrc_id) : assignmentOf(r.taskrsrc_id); return `${owner} / ${named(find(c.type, c.typeKey, r[c.typeKey]), c.typeName, 'code')}`; }
      case 'RSRCRATE': { const n = prices().get(text(r.rsrc_id)) ?? 0; return `${rsrcName(r.rsrc_id)}${n > 1 && text(r.start_date) !== '' ? ` (price from ${text(r.start_date).slice(0, 10)})` : ''}`; }
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
      case 'TASKFIN': return `${code(text(r.task_id))} / ${named(find('FINDATES', 'fin_dates_id', r.fin_dates_id), 'fin_dates_name', 'financial period')}`;
      case 'TRSRCFIN': return `${assignmentOf(r.taskrsrc_id)} / ${named(find('FINDATES', 'fin_dates_id', r.fin_dates_id), 'fin_dates_name', 'financial period')}`;
      case 'CURRTYPE': return text(r.curr_short_name ?? r.curr_type);
      case 'MEMOTYPE': return text(r.memo_type);
      case 'RSRC': return text(r.rsrc_short_name);
      case 'PROJECT': return text(r.proj_short_name);
      case 'CALENDAR': return text(r.clndr_name);
      case 'TASKRSRC': return assignmentName(r);
      case 'RSRCROLE': return `${rsrcName(r.rsrc_id)} / ${roleId(r.role_id)}`;
      case 'ROLERATE': return `${roleId(r.role_id)}${text(r.start_date) !== '' ? ` (price from ${text(r.start_date).slice(0, 10)})` : ''}`;
      case 'THRSPARM': return text(r.thresh_parm_name);
      case 'UMEASURE': return text(r.unit_abbrev || r.unit_name);
      case 'COSTTYPE': return text(r.cost_type);
      case 'PROJISSU': return text(r.issue_name);
      // a table no operation of edit names (reached by add_row, set_fields, delete_rows, which name the table themselves): the table and the row's key, as read_table shows them
      default: return `${tbl} ${KEYS[tbl] ? text(r[KEYS[tbl]]) : 'row'}`;
    }
  };
  /** An activity as the agent names it: its Activity ID, and the baseline it is a row of when it is one (an edit reaches a stored baseline's copy, e.g. replace_text). */
  const taskName = (t: Obj): string => { const p = projects.get(text(t.proj_id)) ?? goneProjects.get(text(t.proj_id)); return p?._baseline_of ? `${text(t.task_code)} in baseline ${p.proj_short_name}` : text(t.task_code); };
  const code = (id: string) => { const t = task(id) ?? gone.get(id); return t ? taskName(t) : missing('activity'); };
  const rsrcName = (id: unknown) => named(resources.get(text(id)) ?? find('RSRC', 'rsrc_id', id), 'rsrc_short_name', 'resource');
  let priceRows: Map<string, number> | null = null;
  const prices = () => { if (!priceRows) { priceRows = new Map(); for (const x of db.tables.RSRCRATE?.rows ?? []) priceRows.set(x.rsrc_id, (priceRows.get(x.rsrc_id) ?? 0) + 1); } return priceRows; };
  // a file with several projects: each change says whose it is (an Activity ID, a WBS code or an expense name can be in more than one)
  const several = [...projects.values()].filter((p) => !p._baseline_of).length > 1;
  const out = (c: FieldChange, r?: unknown) => {
    const o = r && typeof r === 'object' ? r as Obj : undefined;
    const pid = o ? text('proj_id' in o ? o.proj_id : 'task_id' in o ? (task(text(o.task_id)) ?? gone.get(text(o.task_id)))?.proj_id : '') : '';
    const p = pid ? projects.get(pid) ?? goneProjects.get(pid) : undefined;
    const owner = p ? (p._baseline_of ? projects.get(text(p._baseline_of)) ?? p : p) : undefined;
    const kind = o ? kindOf(o) : '';
    // the project's own line (its ID is the name of the row): the project, its schedule options, its root WBS node, its codes and its custom fields
    const itsOwn = kind === 'PROJECT' || kind === 'SCHEDOPTIONS' || kind === 'PROJPCAT' || (kind === 'PROJWBS' && o!.proj_node_flag === 'Y') || (kind === 'UDFVALUE' && find('UDFTYPE', 'udf_type_id', o!.udf_type_id)?.table_name === 'PROJECT');
    if (c.old === c.new) return; // (the file's text changed and the value did not: "450.00" to "450")
    if (c.id === '') c = { ...c, id: 'a row with no name' };
    // a relationship between two projects names the project of each end: it belongs to both, and carries no project of its own
    const twoProjects = kind === 'TASKPRED' && ((a, b) => !!a && !!b && a.proj_id !== b.proj_id)(task(text(o!.pred_task_id)) ?? gone.get(text(o!.pred_task_id)), task(text(o!.task_id)) ?? gone.get(text(o!.task_id)));
    const ch = several && owner && c.project == null && !itsOwn && !twoProjects ? { id: c.id, project: text(owner.proj_short_name), field: c.field, old: c.old, new: c.new } : c;
    all.push(ch); rowOfChange.set(ch, r);
  };
  /** the value lines of a row that IS a value (a custom field's value, a code assigned, a notebook's text, estimates, period actuals): from nothing when added, to nothing when removed */
  const valueLines = (tbl: string, r: Obj): { field: string; value: string | number | null }[] => {
    if (tbl === 'UDFVALUE') return [{ field: 'User Defined Field Value', value: udfValue(r) }];
    const c = CODE_ASSIGNED[tbl];
    if (c) return [{ field: c.field, value: named(find(c.val, c.valKey, r[c.valKey]), c.valName, 'code value') }];
    if (tbl === 'TASKMEMO' || tbl === 'WBSMEMO') return [{ field: 'Notebook Text', value: plainText(text(tbl === 'TASKMEMO' ? r.task_memo : r.wbs_memo)) }];
    if (tbl === '_RISKEST') { const t = task(text(r.task_id)) ?? gone.get(text(r.task_id)); const hpd = t ? dh.task(t) : hoursPerDay; return Object.entries(TABLE_FIELDS._RISKEST).map(([k, field]) => ({ field, value: text(r[k]) === '' ? null : k === 'dist' ? text(r[k]) : Math.round((Number(r[k]) / hpd) * 100) / 100 })); }
    if (tbl === 'TASKFIN' || tbl === 'TRSRCFIN') return Object.entries(TABLE_FIELDS[tbl]).filter(([k]) => Number(r[k] || 0) !== 0).map(([k, field]) => ({ field, value: Number(r[k]) }));
    return [];
  };
  const VALUE_ROWS = new Set(['UDFVALUE', 'TASKACTV', 'PROJPCAT', 'RSRCRCAT', 'ASGNMNTACAT', 'TASKMEMO', 'WBSMEMO', '_RISKEST', 'TASKFIN', 'TRSRCFIN']);
  const valueChange = new Set<FieldChange>();
  // (a resource's price rows and roles wait until every added row is known: those of a resource this edit made or deleted are said by the resource's own line)
  const ofResource: ['added' | 'removed', Obj, string][] = [];
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
  const gather = (r: Obj, table: string) => { removedRows.push(r); removedTable.set(r, table); if ('task_id' in r && 'task_code' in r && !('pred_task_id' in r)) gone.set(text(r.task_id), r as Row); };
  const tableWithRows = (arr: unknown): string => Object.keys(db.tables).find((n) => db.tables[n].rows === arr || realOf(db.tables[n].rows) === arr) ?? '';
  for (const [arr, before] of j.arrays) { const now = new Set(arr as Obj[]), name = tableWithRows(arr); for (const r of before as Obj[]) if (r && typeof r === 'object' && !now.has(r)) gather(r, name); }
  for (const [row, keys] of j.fields) {
    const tbl = row as { name?: unknown; rows?: Obj[]; fields?: unknown };
    if (row === db.tables) { for (let i = 0; i < keys.length; i += 2) { const was = keys[i + 1] as { rows?: Obj[] } | typeof ABSENT; if (was !== ABSENT && was?.rows && !db.tables[keys[i] as string]) for (const r of was.rows) gather(r, keys[i] as string); } continue; }
    if (!Array.isArray(tbl.rows) || !Array.isArray(tbl.fields)) continue;
    for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const now = new Set(tbl.rows); for (const r of keys[i + 1] as Obj[]) if (!now.has(r)) gather(r, text(tbl.name)); }
  }
  for (const r of removedRows) { const t = removedTable.get(r); if (t === 'PROJECT') goneProjects.set(text(r.proj_id), r as Row); else if (t === 'RSRC') goneResources.set(text(r.rsrc_id), r as Row); }
  // the projects whose Project ID this edit changed: their root WBS node's code follows it and is not said a second time
  const renamedProjects = new Set<string>();
  for (const [row, keys] of j.fields) { const r = row as Obj; if (!('proj_short_name' in r) || 'wbs_id' in r || 'task_id' in r || 'rows' in r) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'proj_short_name') renamedProjects.add(text(r.proj_id)); }
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
    for (const r of before as Obj[]) if (!now.has(r) && !seen.has(r)) { seen.add(r); add('removed', r); }
    for (const r of arr as Obj[]) if (!was.has(r) && !seen.has(r)) { seen.add(r); added.add(r); add('added', r); }
  }
  { const madeResources = new Set([...added].filter((x) => tableOf(x) === 'RSRC').map((x) => text((x as Obj).rsrc_id)));
    for (const [what, r, tbl] of ofResource) if (!madeResources.has(text(r.rsrc_id)) && !goneResources.has(text(r.rsrc_id))) out({ id: rowId(tbl, r), field: tbl === 'RSRCRATE' ? 'resource price' : 'resource role', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }, r); }
  function add(what: 'added' | 'removed', r: Obj) {
    if (!r || typeof r !== 'object') return; // a table's field list grew (a column name), not a row
    const tbl = kindOf(r);
    if (tbl === 'PROJECT') { if (what === 'added') madeProjects.add(text(r.proj_id)); out({ id: text(r.proj_short_name), field: r._baseline_of ? 'baseline' : 'project', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }, r); return; }
    // the contents of a project this edit made or deleted (a baseline's copy of every activity), and what ties another project to it: said by the project's own line
    if (inChangedProject(r)) return;
    const row = (id: string, field: string) => out({ id, field, old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }, r);
    if (tbl === 'TASK') { row(taskName(r), 'activity'); datesAffected = true; return; }
    if (tbl === 'TASKPRED') { row(relName(r), 'relationship'); datesAffected = true; return; }
    if (tbl === 'TASKRSRC') { row(assignmentName(r), 'resource assignment'); return; }
    if (tbl === 'RSRC') { row(text(r.rsrc_short_name), 'resource'); return; }
    if (tbl === 'PROJWBS') { row(wbsPath(r), 'WBS'); return; }
    if (tbl === 'CALENDAR') { row(text(r.clndr_name), 'calendar'); return; }
    if (tbl === 'SCHEDOPTIONS') {
      if (what !== 'added') return;
      // a project's first saved schedule options (the file held none): each option now saved is said, from nothing saved
      const labels = TABLE_FIELDS.SCHEDOPTIONS, words = TABLE_WORDS.SCHEDOPTIONS, id = projectId(r.proj_id);
      datesAffected = true;
      if (text(r.sched_retained_logic) !== '' || text(r.sched_progress_override) !== '') out({ id, field: 'When scheduling progressed activities use', old: null, new: logicChoice(text(r.sched_retained_logic), text(r.sched_progress_override)) }, r);
      for (const [k, label] of Object.entries(labels)) { const v = text(r[k]); if (v !== '') out({ id, field: label, old: null, new: k === 'key_activity_for_multiple_longest_paths' ? code(v) : words[k] ? words[k](v) : NUMERIC.test(k) && Number.isFinite(Number(v)) ? Number(v) : v }, r); }
      return;
    }
    if (VALUE_ROWS.has(tbl)) {
      const id = rowId(tbl, r);
      for (const v of valueLines(tbl, r)) { if (v.value == null || v.value === '') continue; const c = { id, field: v.field, old: what === 'added' ? null : v.value, new: what === 'added' ? v.value : null }; out(c, r); valueChange.add(all[all.length - 1]); }
      return;
    }
    // (a new resource's first price row, a deleted resource's price rows and roles: said by the resource)
    if (tbl === 'RSRCRATE' || tbl === 'RSRCROLE') { ofResource.push([what, r, tbl]); return; }
    if (ROW_KIND[tbl]) { row(rowId(tbl, r), ROW_KIND[tbl]); return; }
    // any other table (one that add_row and delete_rows reach, and no named operation writes): the row by P6's word for its table when there is one, else by the table
    if (!tbl) return;
    if (!TABLE_WORD[tbl]) unnamed.add(`${tbl} (a row ${what})`);
    row(rowId(tbl, r), TABLE_WORD[tbl] ? TABLE_WORD[tbl].toLowerCase() : `${tbl} row`);
  }
  // fields a person set on a row that existed
  for (const [row, keys] of j.fields) {
    const r = row as Obj;
    if (row === db.tables || (Array.isArray(r.rows) && Array.isArray(r.fields))) continue; // said above (a table, or its list of rows)
    if ('proj_id' in r && madeProjects.has(text(r.proj_id))) continue; // a project this edit made: its one line says it
    if (kindOf(r) === 'TASK') {
      if (added.has(r)) continue;
      const hpd = dh.task(r as Row);
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string, known = TASK_FIELDS[k];
        // (not said line by line: the dates and floats the scheduler writes. A change of one leaves the saved dates to be judged again, and the sentence about them speaks for it)
        if (SCHEDULED.has(k)) { if (text(keys[i + 1]) !== text(r[k])) { datesAffected = true; if (text(r[k]) === '' && (k === 'early_start_date' || k === 'early_end_date')) datesCleared = true; } continue; }
        if (!known && (k.startsWith('_') || BOOKKEEPING.test(k) || k === 'task_id')) continue;
        if (!known) unnamed.add(`TASK.${k}`);
        const f = known ?? { label: humanize(k), number: NUMERIC.test(k) };
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        if ((f.number || f.days) && Number(was || 0) === 0 && Number(now || 0) === 0) continue;
        if (k === 'proj_id' && !projects.has(was) && !goneProjects.has(was)) continue; // its project's internal number changed (said once, on the project): the activity has not moved
        const name = (v: string) => (v === '' ? null : f.number ? Number(v) : k === 'clndr_id' ? calendarName(v) : k === 'wbs_id' ? wbsCode(v) : k === 'rsrc_id' ? rsrcName(v) : k === 'proj_id' ? projectId(v) : wordOf(k, v));
        out({ id: k === 'task_code' && now === '' ? taskName({ ...r, task_code: was }) : taskName(r), field: f.label, old: f.days ? (was === '' ? null : Math.round((Number(was) / hpd) * 100) / 100) : name(was), new: f.days ? Math.round((Number(now) / hpd) * 100) / 100 : name(now) }, r);
        if (DATE_DRIVING.has(k)) datesAffected = true;
      }
    } else if (kindOf(r) === 'TASKPRED') {
      if (added.has(r)) continue; // a relationship made by this edit is said as added
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k === 'task_id' || k === 'pred_task_id') { const was = text(keys[i + 1]); if (was !== text(r[k])) { out({ id: relName(r), field: k === 'task_id' ? 'Successor' : 'Predecessor', old: code(was), new: code(text(r[k])) }, r); datesAffected = true; } continue; }
        if (k !== 'lag_hr_cnt' && k !== 'pred_type') continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        const hpd = dh.rel(r as Row), days = (v: string) => Math.round((Number(v || 0) / hpd) * 100) / 100;
        out({ id: relName(r), field: k === 'lag_hr_cnt' ? 'Lag (days)' : 'Relationship Type', old: k === 'lag_hr_cnt' ? days(was) : wordOf(k, was), new: k === 'lag_hr_cnt' ? days(now) : wordOf(k, now) }, r);
        datesAffected = true;
      }
    } else {
      // any other row (a resource, an assignment, a calendar, a project, a schedule option, a code, an expense ...): named by what the agent uses
      // (Resource ID, calendar name, Project ID, "activity / expense" ...), the fields and their coded values as P6 names them
      const tbl = tableOf(r), labels = TABLE_FIELDS[tbl], words = TABLE_WORDS[tbl];
      const assignment = tbl === 'TASKRSRC', rate = tbl === 'RSRCRATE';
      if ('proj_id' in r && removedProjects.has(text(r.proj_id))) continue; // a project this edit deleted: its one line says it
      if (added.has(r)) continue; // a row made by this edit is said as added (a project's first schedule options: option by option, in add)
      const id = rate ? rsrcName(r.rsrc_id) : rowId(tbl, r);
      const projectNode = tbl === 'PROJWBS' && r.proj_node_flag === 'Y';
      const changed = (k: string): boolean => keys.some((x, n) => n % 2 === 0 && x === k);
      const wasOf = (k: string): string => { const at = keys.findIndex((x, n) => n % 2 === 0 && x === k); return at < 0 ? text(r[k]) : text(keys[at + 1]); };
      const cols = keys.filter((_, n) => n % 2 === 0) as string[];
      let logicSaid = false, restoreSaid = false;
      for (const k of cols) {
        const baselineSlot = tbl === 'PROJECT' ? BASELINE_SLOTS[k] : undefined;
        if (!labels?.[k] && BOOKKEEPING.test(k)) continue; // the file's own bookkeeping (who and when, generated keys): the operation's answer says what it did
        const label = (tbl === 'PROJECT' && k === 'proj_short_name' && r._baseline_of ? 'Baseline Name' : undefined) ?? labels?.[k] ?? (tbl === 'PROJECT' || tbl === 'RSRC' || tbl === 'CALENDAR' || tbl === 'PROJWBS' || tbl === 'RSRCRATE' || tbl === 'TASKRSRC' || tbl === 'PROJCOST' ? OTHER_FIELDS[k] : undefined) ?? nameByKind(tbl, k) ?? undefined;
        // the file's own bookkeeping, and the dates and floats the scheduler works out (a column P6 names for a person is never one of these)
        const restores = tbl === 'PROJECT' && (k === '_baseline_of' || k === 'orig_proj_id');
        if (!baselineSlot && !label && !restores && (k.startsWith('_') || BOOKKEEPING.test(k) || k === KEYS[tbl] || /(?:^|_)(?:early|late|total_float|free_float|reend|restart|rem_late|rem_early|scd_)/.test(k))) continue;
        if (k === 'proj_id' && tbl !== 'PROJECT') continue; // rows follow their project's internal number: said once, on the project
        if (tbl === 'RSRCROLE' && /^(rsrc|role)_(short_)?name$/.test(k)) continue; // the copy of a resource's or a role's name the file keeps beside their pairing: said on the resource or the role
        const before = keys[keys.findIndex((x, n) => n % 2 === 0 && x === k) + 1];
        if (before !== ABSENT && before != null && typeof before === 'object') continue; // not a value a person sets
        const was = text(before), now = text(r[k]);
        if (was === now && !(tbl === 'SCHEDOPTIONS' && (k === 'sched_retained_logic' || k === 'sched_progress_override'))) continue;
        // (a text that reads as nothing — an empty HTML body, blanks — is nothing: a change from nothing to nothing is not said)
        const seen = (v: FieldChange['old']): FieldChange['old'] => (typeof v === 'string' && v.trim() === '' ? null : v);
        // (nothing to nothing is no change; nor is a quantity, a cost or a count between nothing and 0: P6 shows both as 0. A row whose name this change emptied is named by the name it had)
        const say = (field: string, old: FieldChange['old'], nw: FieldChange['new']) => { const o = seen(old), n = seen(nw); if (o == null && n == null) return; if (NUMERIC.test(k) && (o ?? 0) === 0 && (n ?? 0) === 0) return; out({ id: id !== '' ? id : rate ? '' : rowId(tbl, { ...r, [k]: was }), field, old: o, new: n }, r); };
        if (baselineSlot) { const bl = (v: string) => (v === '' ? null : projectId(v, 'baseline')); say(baselineSlot, bl(was), bl(now)); continue; }
        // a baseline restored: it is a project again (the file marks a baseline in two columns: both are this one change)
        if (restores) { if (!restoreSaid && was !== '' && now === '') { restoreSaid = true; say('baseline', `baseline of ${projectId(was)}`, 'restored as a project'); datesAffected = true; } continue; }
        if (tbl === 'PROJECT' && k === 'proj_id') { say(labels![k], Number(was), Number(now)); continue; }
        if (k === 'critical_drtn_hr_cnt' && tbl === 'PROJECT') { const days = (v: string) => Math.round((Number(v || 0) / hoursPerDay) * 100) / 100; say('Critical activities: Total Float at or below (days)', days(was), days(now)); continue; }
        if ((tbl === 'PROJECT' && /^(last_recalc_date|plan_start_date|plan_end_date)$/.test(k)) || (tbl === 'CALENDAR' && k === 'clndr_data') || (tbl === 'SCHEDOPTIONS' && /^sched_/.test(k))) datesAffected = true; // the data date, the planned start, Must Finish By and the work time of a calendar decide the dates F9 gives
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
          // every named value of the assignment that moved is said (the units a day and the totals that follow them alike: P6 shows each as its own column); its dates are the scheduler's
          if (/_date$/.test(k) && !label) continue;
          const t = task(text(r.task_id)), hpd = t ? dh.task(t) : hoursPerDay;
          const num2 = (v: string, f = 1) => (v === '' ? null : Math.round(Number(v) * f * 100) / 100);
          if (/_qty_per_hr$/.test(k)) { say(label, num2(was, hoursPerDay), num2(now, hoursPerDay)); continue; }
          if (/_drtn_hr_cnt$/.test(k)) { say(label, num2(was, 1 / hpd), num2(now, 1 / hpd)); continue; }
          if (/_(qty|cost)$/.test(k)) { say(label, num2(was), num2(now)); continue; }
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
          : k === 'rsrc_id' || k === 'parent_rsrc_id' ? rsrcName(v) : k === 'task_id' ? code(v) : k === 'parent_wbs_id' ? wbsCode(v) : k === 'parent_eps_id' || k === '_eps_id' ? named(find('EPS', 'eps_id', v), 'eps_short_name', 'EPS') : k === 'parent_obs_id' ? named(find('OBS', 'obs_id', v), 'obs_name', 'OBS')
          : k === 'fintmpl_id' ? named(find('FINTMPL', 'fintmpl_id', v), 'fintmpl_name', 'financial period calendar') : k === 'last_fin_dates_id' ? named(find('FINDATES', 'fin_dates_id', v), 'fin_dates_name', 'financial period')
          : words?.[k] ? words[k](v) : NUMERIC.test(k) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : /(_descr|_notes)$/.test(k) && /<[a-zA-Z!\/][^>]*>/.test(v) ? plainText(v) || null : wordOf(k, v));
        if (label == null) unnamed.add(`${tbl || '?'}.${k}`);
        say(label ?? humanize(k), name(was), name(now));
      }
    }
  }
  // a value replaced by another (the value row removed and a new one added in its place: a custom field's value, a code assigned, a notebook's text) is ONE change, old -> new
  {
    const at = (c: FieldChange) => `${c.id}\u0000${c.project ?? ''}\u0000${c.field}`;
    const put = new Map<string, FieldChange>(); for (const c of all) if (valueChange.has(c) && c.old === null && !put.has(at(c))) put.set(at(c), c);
    const drop = new Set<FieldChange>(), instead = new Map<FieldChange, FieldChange>();
    for (const c of all) {
      if (!valueChange.has(c) || c.new !== null) continue;
      const p = put.get(at(c)); if (!p || drop.has(p) || instead.has(p)) continue;
      drop.add(c);
      if (c.old === p.new) drop.add(p); else { const merged: FieldChange = { ...p, old: c.old }; rowOfChange.set(merged, rowOfChange.get(p)); instead.set(p, merged); }
    }
    if (drop.size || instead.size) { const kept = all.filter((c) => !drop.has(c)).map((c) => instead.get(c) ?? c); all.length = 0; for (const c of kept) all.push(c); }
  }
  // each change once (the same row can be journalled twice, a resource's limit lives on the resource and on its price row)
  const seenChange = new Set<string>(), rowNo = new Map<unknown, number>();
  return { changes: all.filter((c) => { const r0 = rowOfChange.get(c), r = r0 && typeof r0 === 'object' && ('rsrc_rate_id' in (r0 as Obj) || 'rsrc_short_name' in (r0 as Obj)) ? null : r0; /* a resource's limit lives on the resource and on its price row: one change */ let n = r == null ? 0 : rowNo.get(r); if (r != null && n == null) rowNo.set(r, (n = rowNo.size + 1)); const key = `${n}\u0000${c.id}\u0000${c.project ?? ''}\u0000${c.field}\u0000${c.old}\u0000${c.new}`; if (seenChange.has(key)) return false; seenChange.add(key); return true; }), datesAffected, datesCleared, unnamed: [...unnamed] };
}
