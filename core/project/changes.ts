// What an edit changed, read from the undo journal the edit was recorded in: per activity (or relationship, resource ...) the field, the old value and the new one, so the answer can say
// "A1010 duration: 8 -> 10 days". Only what a person sets is listed (names, durations, dates they gave, status, constraints, calendars, resource limits ...), never the dates the scheduler works out.
import { ABSENT, type Journal } from '../journal.ts';
import type { Db, Row } from '../db.ts';
import { dayHours } from './units.ts';
import { cstrName, namesText } from '../notes.ts';
import { humanizeField, STATUS_WORDS } from '../p6words.ts';
import { parseClndrDataLeniently } from '../calendar/clndr-data.ts';

export interface FieldChange { id: string; field: string; old: string | number | null; new: string | number | null }
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
  proj_short_name: 'Project ID', proj_name: 'Project Name', last_recalc_date: 'Data Date', plan_start_date: 'Planned Start', plan_end_date: 'Must Finish By', clndr_id: 'Default Calendar',
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
  PROJECT: { critical_path_type: 'Define critical activities as' },
  TASKRSRC: { curv_id: 'Curve', cost_qty_link_flag: 'Calculate costs from units', target_cost: 'Budgeted Cost', act_reg_cost: 'Actual Regular Cost', remain_cost: 'Remaining Cost', acct_id: 'Cost Account', role_id: 'Role' },
  ACTVTYPE: { actv_code_type: 'Activity Code Name' }, PCATTYPE: { proj_catg_type: 'Project Code Name' }, RCATTYPE: { rsrc_catg_type: 'Resource Code Name' }, ASGNMNTCATTYPE: { asgnmnt_catg_type: 'Assignment Code Name' },
  ACTVCODE: { short_name: 'Code Value', actv_code_name: 'Description' }, PCATVAL: { proj_catg_short_name: 'Code Value', proj_catg_name: 'Description' }, RCATVAL: { rsrc_catg_short_name: 'Code Value', rsrc_catg_name: 'Description' },
  ASGNMNTCATVAL: { asgnmnt_catg_short_name: 'Code Value', asgnmnt_catg_name: 'Description' },
  UDFTYPE: { udf_type_label: 'User Defined Field Title' },
  PROJCOST: { cost_name: 'Expense Item', acct_id: 'Cost Account', target_qty: 'Budgeted Units', cost_per_qty: 'Price / Unit', target_cost: 'Budgeted Cost', act_cost: 'Actual Cost', remain_cost: 'Remaining Cost', vendor_name: 'Vendor',
    po_number: 'Document Number', cost_descr: 'Expense Description', qty_name: 'Unit of Measure' },
  TASKPROC: { proc_name: 'Step Name', proc_wt: 'Step Weight', complete_pct: 'Step % Complete', complete_flag: 'Completed', proc_descr: 'Step Description' },
  ACCOUNT: { acct_short_name: 'Cost Account ID', acct_name: 'Cost Account Name', acct_descr: 'Cost Account Description' },
  EPS: { eps_short_name: 'EPS ID', eps_name: 'EPS Name' },
  OBS: { obs_name: 'OBS Name', obs_descr: 'OBS Description' },
  POBS: { pobs_name: 'Performing Organization Name', pobs_descr: 'Performing Organization Description', pobs_manager: 'Performing Organization Manager' },
  ROLES: { role_short_name: 'Role ID', role_name: 'Role Name', role_descr: 'Role Description' },
  RSRCCURVDATA: { curv_name: 'Resource Curve Name' },
  FINDATES: { fin_dates_name: 'Financial Period Name', start_date: 'Start Date', end_date: 'End Date' }, FINTMPL: { fintmpl_name: 'Financial Period Calendar Name', default_flag: 'Default' },
  TASKMEMO: { task_memo: 'Notebook Topic' }, WBSMEMO: { wbs_memo: 'Notebook Topic' },
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
  TASKRSRC: { cost_qty_link_flag: yesNo }, TASKPROC: { complete_flag: yesNo }, FINTMPL: { default_flag: yesNo },
};
/** Notebook text as a person reads it: the HTML P6 stores without its tags. */
const plainText = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
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
  const all: FieldChange[] = [];
  let datesAffected = false;
  const dh = dayHours(db, 8, true);
  const tasks = new Map<string, Row>();
  const task = (id: string) => { if (!tasks.size) for (const t of db.tables.TASK?.rows ?? []) tasks.set(t.task_id, t); return tasks.get(id); };
  const projects = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
  const calendars = new Map((db.tables.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c]));
  const resources = new Map((db.tables.RSRC?.rows ?? []).map((r) => [r.rsrc_id, r]));
  const gone = new Map<string, Row>();
  /** rows this edit removed, by table-like kind: an id that pointed at one is still named by what the agent called it */
  const goneProjects = new Map<string, Row>(), goneCalendars = new Map<string, Row>(), goneAccounts = new Map<string, Row>(), goneCurves = new Map<string, Row>();
  const unnamed = new Set<string>();
  // which table a row is of (looked up only when a row of another kind than an activity or a relationship changed)
  let tableByRow: Map<unknown, string> | null = null;
  const tableOf = (r: unknown): string => {
    if (!tableByRow) { tableByRow = new Map(); for (const [name, t] of Object.entries(db.tables)) if (name !== 'TASK' && name !== 'TASKPRED') for (const x of t.rows) tableByRow.set(x, name); }
    return tableByRow.get(r) ?? '';
  };
  const find = (tbl: string, key: string, v: unknown): Row | undefined => (db.tables[tbl]?.rows ?? []).find((x) => x[key] === text(v));
  const projectId = (id: unknown): string => text((projects.get(text(id)) ?? goneProjects.get(text(id)))?.proj_short_name ?? id);
  const calendarName = (id: unknown): string => text((calendars.get(text(id)) ?? goneCalendars.get(text(id)))?.clndr_name ?? id);
  const accountId = (id: unknown): string => text((find('ACCOUNT', 'acct_id', id) ?? goneAccounts.get(text(id)))?.acct_short_name ?? id);
  const curveName = (id: unknown): string => text((find('RSRCCURVDATA', 'curv_id', id) ?? goneCurves.get(text(id)))?.curv_name ?? id);
  const roleId = (id: unknown): string => text(find('ROLES', 'role_id', id)?.role_short_name ?? id);
  const topicName = (id: unknown): string => text(find('MEMOTYPE', 'memo_type_id', id)?.memo_type ?? 'Notes');
  const wbsCode = (id: unknown): string => text(find('PROJWBS', 'wbs_id', id)?.wbs_short_name ?? id);
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
      default: return text(r.rsrc_short_name ?? r.proj_short_name ?? r.wbs_short_name ?? r.clndr_name ?? r.actv_code_name ?? r.udf_type_label ?? r.task_pred_id ?? r.taskrsrc_id ?? r.rsrc_id ?? '');
    }
  };
  /** An activity as the agent names it: its Activity ID, and the baseline it is a row of when it is one (an edit reaches a stored baseline's copy, e.g. replace_text). */
  const taskName = (t: Obj): string => { const p = projects.get(text(t.proj_id)); return p?._baseline_of ? `${text(t.task_code)} in baseline ${p.proj_short_name}` : text(t.task_code); };
  const code = (id: string) => { const t = task(id) ?? gone.get(id); return t ? taskName(t) : id; };
  const rsrcName = (id: unknown) => text(resources.get(text(id))?.rsrc_short_name ?? id);
  const out = (c: FieldChange) => all.push(c);
  // rows added or removed: a table made or dropped by this edit (its rows), or an array that grew or shrank
  const added = new Set<unknown>(), seen = new Set<unknown>(), madeProjects = new Set<string>();
  // (the project rows first: what belongs to a project this edit made is not listed row by row)
  for (const [row, keys] of j.fields) { const tbl = row as { name?: unknown; rows?: Obj[] }; if (tbl.name !== 'PROJECT' || !Array.isArray(tbl.rows)) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const was = new Set(keys[i + 1] as Obj[]); for (const r of tbl.rows) if (!was.has(r)) madeProjects.add(text(r.proj_id)); } }
  for (const [arr, before] of j.arrays) if (arr === db.tables.PROJECT?.rows) { const was = new Set(before as Obj[]); for (const r of arr as Obj[]) if (!was.has(r)) madeProjects.add(text(r.proj_id)); }
  // (and the projects this edit deleted, a baseline with them: found before any row is listed, so their activities, WBS and relationships are not listed one by one)
  const removedProjects = new Set<string>();
  for (const [arr, before] of j.arrays) if (arr === db.tables.PROJECT?.rows) { const now = new Set(arr as Obj[]); for (const r of before as Obj[]) if (!now.has(r)) removedProjects.add(text(r.proj_id)); }
  for (const [row, keys] of j.fields) { const tbl = row as { name?: unknown; rows?: Obj[] }; if (tbl.name !== 'PROJECT' || !Array.isArray(tbl.rows)) continue; for (let i = 0; i < keys.length; i += 2) if (keys[i] === 'rows' && Array.isArray(keys[i + 1])) { const now = new Set(tbl.rows); for (const r of keys[i + 1] as Obj[]) if (!now.has(r)) removedProjects.add(text(r.proj_id)); } }
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
    if (what === 'removed') { if ('clndr_name' in r && 'clndr_id' in r) goneCalendars.set(text(r.clndr_id), r as Row); else if ('acct_short_name' in r) goneAccounts.set(text(r.acct_id), r as Row); else if ('curv_name' in r) goneCurves.set(text(r.curv_id), r as Row); }
    if ('proj_short_name' in r && 'proj_id' in r && !('task_id' in r) && !('wbs_id' in r)) { if (what === 'added') madeProjects.add(text(r.proj_id)); else goneProjects.set(text(r.proj_id), r as Row); out({ id: text(r.proj_short_name), field: r._baseline_of ? 'baseline' : 'project', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }); return; }
    if ('proj_id' in r && (madeProjects.has(text(r.proj_id)) || removedProjects.has(text(r.proj_id)))) return; // the contents of a project this edit made or deleted (a baseline's copy of every activity): said by the project's own line
    const row = (id: string, field: string) => out({ id, field, old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' });
    if ('task_code' in r && 'task_id' in r && 'proj_id' in r && !('pred_task_id' in r)) { row(taskName(r), 'activity'); datesAffected = true; }
    else if ('pred_task_id' in r) { row(`${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, 'relationship'); datesAffected = true; }
    else if ('rsrc_id' in r && 'task_id' in r) row(`${code(text(r.task_id))} ${rsrcName(r.rsrc_id)}`, 'resource assignment');
    else if ('rsrc_short_name' in r) row(text(r.rsrc_short_name), 'resource');
    else if ('wbs_short_name' in r) row(text(r.wbs_short_name), 'WBS');
    else if ('clndr_name' in r) row(text(r.clndr_name), 'calendar');
  }
  // fields a person set on a row that existed
  for (const [row, keys] of j.fields) {
    const r = row as Obj;
    if (row === db.tables || (Array.isArray(r.rows) && Array.isArray(r.fields))) continue; // said above (a table, or its list of rows)
    if ('proj_id' in r && madeProjects.has(text(r.proj_id))) continue; // a project this edit made: its one line says it
    if (added.has(r) && !('task_code' in r)) continue; // a row made by this edit is said as added
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
        out({ id: k === 'task_code' ? text(keys[i + 1]) : taskName(r), field: f.label, old: f.days ? (was === '' ? null : Math.round((Number(was) / hpd) * 100) / 100) : name(was), new: f.days ? Math.round((Number(now) / hpd) * 100) / 100 : name(now) });
        if (DATE_DRIVING.has(k)) datesAffected = true;
      }
    } else if ('pred_task_id' in r) {
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k !== 'lag_hr_cnt' && k !== 'pred_type') continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        const hpd = dh.rel(r as Row), days = (v: string) => Math.round((Number(v || 0) / hpd) * 100) / 100;
        out({ id: `${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, field: k === 'lag_hr_cnt' ? 'Lag (days)' : 'Relationship Type', old: k === 'lag_hr_cnt' ? days(was) : wordOf(k, was), new: k === 'lag_hr_cnt' ? days(now) : wordOf(k, now) });
        datesAffected = true;
      }
    } else {
      // any other row (a resource, an assignment, a calendar, a project, a schedule option, a code, an expense ...): named by what the agent uses
      // (Resource ID, calendar name, Project ID, "activity / expense" ...), the fields and their coded values as P6 names them
      const assignment = 'rsrc_id' in r && 'task_id' in r && 'taskrsrc_id' in r, rate = 'rsrc_rate_id' in r;
      const tbl = tableOf(r), labels = TABLE_FIELDS[tbl], words = TABLE_WORDS[tbl];
      if ('proj_id' in r && removedProjects.has(text(r.proj_id))) continue; // a project this edit deleted: its one line says it
      const id = assignment ? `${code(text(r.task_id))} ${r.rsrc_id ? rsrcName(r.rsrc_id) : roleId(r.role_id)}` : rate ? rsrcName(r.rsrc_id) : rowId(tbl, r);
      const projectNode = tbl === 'PROJWBS' && r.proj_node_flag === 'Y';
      const wasOf = (k: string): string => { const at = keys.findIndex((x, n) => n % 2 === 0 && x === k); return at < 0 ? text(r[k]) : text(keys[at + 1]); };
      let logicSaid = false;
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        const baselineSlot = 'proj_short_name' in r ? BASELINE_SLOTS[k] : undefined;
        if ((k.startsWith('_') && !baselineSlot) || /(?:^|_)(?:early|late|total_float|free_float|reend|restart|rem_late|rem_early|scd_)/.test(k)) continue;
        if (keys[i + 1] !== ABSENT && keys[i + 1] != null && typeof keys[i + 1] === 'object') continue; // not a value a person sets
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        if (baselineSlot) { const bl = (v: string) => (v === '' ? null : projectId(v)); out({ id, field: baselineSlot, old: bl(was), new: bl(now) }); continue; }
        if (k === 'critical_drtn_hr_cnt' && 'proj_short_name' in r) { const days = (v: string) => Math.round((Number(v || 0) / hoursPerDay) * 100) / 100; out({ id, field: 'Critical activities: Total Float at or below (days)', old: days(was), new: days(now) }); continue; }
        if (('proj_short_name' in r && /^(last_recalc_date|plan_start_date|plan_end_date)$/.test(k)) || ('clndr_name' in r && k === 'clndr_data')) datesAffected = true; // the data date, the planned start, Must Finish By and the work time of a calendar decide the dates F9 gives
        // P6's one option "When scheduling progressed activities use" is two columns in the file: said once, by its three choices
        if (tbl === 'SCHEDOPTIONS' && (k === 'sched_retained_logic' || k === 'sched_progress_override')) {
          if (logicSaid) continue;
          logicSaid = true;
          const choice = (retained: string, override: string) => (retained === 'Y' ? 'Retained Logic' : override === 'Y' ? 'Progress Override' : 'Actual Dates');
          const before = choice(wasOf('sched_retained_logic'), wasOf('sched_progress_override')), after = choice(text(r.sched_retained_logic), text(r.sched_progress_override));
          if (before !== after) out({ id, field: 'When scheduling progressed activities use', old: before, new: after });
          continue;
        }
        if (tbl === 'SCHEDOPTIONS' && k === 'key_activity_for_multiple_longest_paths') { out({ id, field: labels![k], old: was === '' ? null : code(was), new: now === '' ? null : code(now) }); continue; }
        // an assignment's quantities and costs worked out from the units a day are not what a person set; a cost a person entered (costs no longer calculated from units) is
        const costEntered = assignment && text(r.cost_qty_link_flag) === 'N' && /^(target_cost|act_reg_cost|remain_cost)$/.test(k);
        if (assignment && !costEntered && /^(target|remain|act)_(qty|cost|equip_qty|drtn|work_qty|ot_qty|reg_qty|reg_cost|ot_cost)|^remain_qty_per_hr$|_per_hr_rate$/.test(k) && k !== 'target_qty_per_hr') continue;
        if (assignment && k === 'target_qty_per_hr') { const hpd = hoursPerDay; out({ id, field: 'Budgeted Units/Time (units a day)', old: was === '' ? null : Math.round(Number(was) * hpd * 100) / 100, new: Math.round(Number(now) * hpd * 100) / 100 }); continue; }
        if (k === 'clndr_data' && 'clndr_name' in r) { for (const c of calendarChange(was, now)) out({ id, ...c }); continue; }
        if (k === 'max_qty_per_hr' && ('rsrc_name' in r || rate)) { const hpd = hoursPerDay; out({ id, field: OTHER_FIELDS[k], old: was === '' ? null : Math.round(Number(was) * hpd * 100) / 100, new: Math.round(Number(now) * hpd * 100) / 100 }); continue; }
        // a project's root WBS node carries the project's name and repeats its ID: the name is the Project Name, the ID is said by the project's own line
        if (projectNode && k === 'wbs_short_name' && renamedProjects.has(text(r.proj_id))) continue;
        if (projectNode && k === 'wbs_name') { out({ id: projectId(r.proj_id), field: 'Project Name', old: was === '' ? null : was, new: now === '' ? null : now }); continue; }
        // a notebook: the text as a person reads it
        if ((tbl === 'TASKMEMO' && k === 'task_memo') || (tbl === 'WBSMEMO' && k === 'wbs_memo')) { out({ id, field: labels![k], old: was === '' ? null : plainText(was), new: now === '' ? null : plainText(now) }); continue; }
        const name = (v: string) => (v === '' ? null : k === 'clndr_id' ? calendarName(v) : k === 'acct_id' ? accountId(v) : k === 'curv_id' ? curveName(v) : k === 'role_id' ? roleId(v) : words?.[k] ? words[k](v) : wordOf(k, v));
        const label = labels?.[k] ?? OTHER_FIELDS[k];
        if (label == null) unnamed.add(k);
        out({ id, field: label ?? humanize(k), old: name(was), new: name(now) });
      }
    }
  }
  // each change once (the same row can be journalled twice, a resource's limit lives on the resource and on its price row)
  const seenChange = new Set<string>();
  return { changes: all.filter((c) => { const key = `${c.id}\u0000${c.field}\u0000${c.old}\u0000${c.new}`; if (seenChange.has(key)) return false; seenChange.add(key); return true; }), datesAffected, unnamed: [...unnamed] };
}
