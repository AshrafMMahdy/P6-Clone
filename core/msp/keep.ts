// A Microsoft Project XML file edited through the clone keeps everything the clone does not edit. Each task,
// resource, assignment and calendar (and the project) read from MSPDI keeps its elements as written, with a snapshot
// of the row it became. Writing the file back, an element goes out exactly as it came in unless something it is made
// from changed since (then the clone writes its own); elements the clone has no model for (notes, baselines, fixed
// costs, contours, custom fields, timephased data, outline codes, views...) always go out as they came in. Elements
// the clone would add that the file did not have are left out unless they carry a change. UIDs are kept.
import type { Db, Row } from '../db.ts';

/** An element as the file had it: its children (name, XML) in order, the element's own XML, its place, its ID. */
export interface Kept { kids: [string, string][]; xml: string; seq: number; id?: string }
/** Elements that are not P6 rows (the project summary task, blank rows, the blank resource, unassigned assignments,
 *  resource calendars folded into their base): written back in their place. */
export interface Ghost { seq: number; uid: string; xml: string }
export interface Ghosts { tasks: Ghost[]; resources: Ghost[]; assignments: Ghost[]; calendars: Ghost[] }
export interface ProjectKept { kids: [string, string | null][]; ghosts: Ghosts; p6ext: boolean }
export const COLLECTIONS = new Set(['Calendars', 'Tasks', 'Resources', 'Assignments']);

/** What decides an element: row fields (written anew only when one of them changed), 'struct' (written anew when
 *  the clone's text differs: outline place, IDs), or a test. */
type Dep = string[] | 'struct' | (() => boolean);

const D = {
  start: ['act_start_date', 'early_start_date', 'target_start_date'], finish: ['act_end_date', 'early_end_date', 'target_end_date'],
  dur: ['target_drtn_hr_cnt', 'task_type'], rem: ['remain_drtn_hr_cnt', 'target_drtn_hr_cnt', 'act_start_date', 'act_end_date', 'task_type'],
};
export const TASK_DEPS: Record<string, Dep> = {
  ID: 'struct', OutlineNumber: 'struct', OutlineLevel: 'struct', Summary: 'struct',
  Name: ['task_name'], Type: ['duration_type'], Milestone: ['task_type'],
  Start: D.start, Finish: D.finish, Duration: D.dur, RemainingDuration: D.rem, PercentComplete: [...D.rem, 'phys_complete_pct'],
  EarlyStart: ['early_start_date', 'act_end_date'], EarlyFinish: ['early_end_date', 'act_end_date'], LateStart: ['late_start_date', 'act_end_date'], LateFinish: ['late_end_date', 'act_end_date'],
  ActualStart: ['act_start_date'], ActualFinish: ['act_end_date'], ConstraintType: ['cstr_type'], ConstraintDate: ['cstr_type', 'cstr_date'],
  Deadline: ['cstr_type2', 'cstr_date2'], CalendarUID: ['clndr_id'], TotalSlack: ['total_float_hr_cnt', 'act_end_date'], FreeSlack: ['free_float_hr_cnt', 'act_end_date'],
  Critical: ['driving_path_flag', 'total_float_hr_cnt'], PredecessorLink: ['~preds'],
  // the work done so far no longer matches when the durations or actuals changed: Microsoft Project recalculates it
  ActualDuration: D.rem, PercentWorkComplete: D.rem,
};
/** A summary task (a WBS element): the clone edits its name and place; its dates and totals are Microsoft Project's. */
export const SUMMARY_DEPS: Record<string, Dep> = { ID: 'struct', OutlineNumber: 'struct', OutlineLevel: 'struct', Summary: 'struct', Name: ['wbs_name'], WBS: ['wbs_short_name', 'parent_wbs_id'] };
export const RES_DEPS: Record<string, Dep> = { ID: 'struct', Name: ['rsrc_name'], Code: ['rsrc_short_name'], Type: ['rsrc_type'], MaxUnits: ['~max'], StandardRate: ['~cost'], StandardRateFormat: ['~cost'], CalendarUID: ['clndr_id'] };
const WORK = ['target_qty', 'remain_qty', 'act_reg_qty', 'act_ot_qty'];
export const ASG_DEPS: Record<string, Dep> = {
  TaskUID: ['task_id'], ResourceUID: ['rsrc_id'], Units: ['target_qty_per_hr', 'remain_qty_per_hr'], Work: WORK, ActualWork: ['act_reg_qty', 'act_ot_qty'], RemainingWork: ['remain_qty'],
  Cost: ['target_cost', 'remain_cost', 'act_reg_cost', 'act_ot_cost'], ActualCost: ['act_reg_cost', 'act_ot_cost'], RemainingCost: ['remain_cost'],
  Start: ['act_start_date', 'restart_date', 'target_start_date'], Finish: ['act_end_date', 'reend_date', 'target_end_date'], ActualStart: ['act_start_date'], ActualFinish: ['act_end_date'],
  // the work spread over time is stale once the work or its dates changed: left out, Microsoft Project spreads it again
  TimephasedData: [...WORK, 'target_qty_per_hr', 'act_start_date', 'restart_date', 'target_start_date', 'act_end_date', 'reend_date', 'target_end_date'],
  PercentWorkComplete: WORK,
};
export const PROJECT_DEPS: Record<string, Dep> = {
  Name: ['proj_short_name'], Title: ['~title'], StartDate: ['plan_start_date'], FinishDate: ['scd_end_date'], StatusDate: ['last_recalc_date'], CalendarUID: ['clndr_id'],
  MinutesPerDay: ['clndr_id'], MinutesPerWeek: ['clndr_id'],
};

/** Microsoft Project's element order (mspdi_pj12.xsd), for an element the file did not have. */
export const ORDER: Record<string, string[]> = {
  Task: ['UID', 'GUID', 'ID', 'Name', 'Active', 'Manual', 'Type', 'IsNull', 'CreateDate', 'Contact', 'WBS', 'WBSLevel', 'OutlineNumber', 'OutlineLevel', 'Priority', 'Start', 'Finish', 'Duration', 'ManualStart', 'ManualFinish', 'ManualDuration', 'DurationFormat', 'Work', 'Stop', 'Resume', 'ResumeValid', 'EffortDriven', 'Recurring', 'OverAllocated', 'Estimated', 'Milestone', 'Summary', 'DisplayAsSummary', 'Critical', 'IsSubproject', 'IsSubprojectReadOnly', 'SubprojectName', 'ExternalTask', 'ExternalTaskProject', 'EarlyStart', 'EarlyFinish', 'LateStart', 'LateFinish', 'StartVariance', 'FinishVariance', 'WorkVariance', 'FreeSlack', 'TotalSlack', 'StartSlack', 'FinishSlack', 'FixedCost', 'FixedCostAccrual', 'PercentComplete', 'PercentWorkComplete', 'Cost', 'OvertimeCost', 'OvertimeWork', 'ActualStart', 'ActualFinish', 'ActualDuration', 'ActualCost', 'ActualOvertimeCost', 'ActualWork', 'ActualOvertimeWork', 'RegularWork', 'RemainingDuration', 'RemainingCost', 'RemainingWork', 'RemainingOvertimeCost', 'RemainingOvertimeWork', 'ACWP', 'CV', 'ConstraintType', 'CalendarUID', 'ConstraintDate', 'Deadline', 'LevelAssignments', 'LevelingCanSplit', 'LevelingDelay', 'LevelingDelayFormat', 'PreLeveledStart', 'PreLeveledFinish', 'Hyperlink', 'HyperlinkAddress', 'HyperlinkSubAddress', 'IgnoreResourceCalendar', 'Notes', 'HideBar', 'Rollup', 'BCWS', 'BCWP', 'PhysicalPercentComplete', 'EarnedValueMethod', 'PredecessorLink', 'ActualWorkProtected', 'ActualOvertimeWorkProtected', 'ExtendedAttribute', 'Baseline', 'OutlineCode', 'IsPublished', 'StatusManager', 'CommitmentStart', 'CommitmentFinish', 'CommitmentType', 'TimephasedData'],
  Resource: ['UID', 'GUID', 'ID', 'Name', 'Type', 'IsNull', 'Initials', 'Phonetics', 'NTAccount', 'MaterialLabel', 'Code', 'Group', 'WorkGroup', 'EmailAddress', 'Hyperlink', 'HyperlinkAddress', 'HyperlinkSubAddress', 'MaxUnits', 'PeakUnits', 'OverAllocated', 'AvailableFrom', 'AvailableTo', 'Start', 'Finish', 'CanLevel', 'AccrueAt', 'Work', 'RegularWork', 'OvertimeWork', 'ActualWork', 'RemainingWork', 'ActualOvertimeWork', 'RemainingOvertimeWork', 'PercentWorkComplete', 'StandardRate', 'StandardRateFormat', 'Cost', 'OvertimeRate', 'OvertimeRateFormat', 'OvertimeCost', 'CostPerUse', 'ActualCost', 'ActualOvertimeCost', 'RemainingCost', 'RemainingOvertimeCost', 'WorkVariance', 'CostVariance', 'SV', 'CV', 'ACWP', 'CalendarUID', 'Notes', 'BCWS', 'BCWP', 'IsGeneric', 'IsInactive', 'IsEnterprise', 'BookingType', 'ActualWorkProtected', 'ActualOvertimeWorkProtected', 'ActiveDirectoryGUID', 'CreationDate', 'ExtendedAttribute', 'Baseline', 'OutlineCode', 'IsCostResource', 'AssnOwner', 'AssnOwnerGuid', 'IsBudget', 'AvailabilityPeriods', 'Rates', 'TimephasedData'],
  Assignment: ['UID', 'GUID', 'TaskUID', 'ResourceUID', 'PercentWorkComplete', 'ActualCost', 'ActualFinish', 'ActualOvertimeCost', 'ActualOvertimeWork', 'ActualStart', 'ActualWork', 'ACWP', 'Confirmed', 'Cost', 'CostRateTable', 'RateScale', 'CostVariance', 'CV', 'Delay', 'Finish', 'FinishVariance', 'Hyperlink', 'HyperlinkAddress', 'HyperlinkSubAddress', 'WorkVariance', 'HasFixedRateUnits', 'FixedMaterial', 'LevelingDelay', 'LevelingDelayFormat', 'LinkedFields', 'Milestone', 'Notes', 'Overallocated', 'OvertimeCost', 'OvertimeWork', 'PeakUnits', 'RegularWork', 'RemainingCost', 'RemainingOvertimeCost', 'RemainingOvertimeWork', 'RemainingWork', 'ResponsePending', 'Start', 'Stop', 'Resume', 'StartVariance', 'Summary', 'SV', 'Units', 'UpdateNeeded', 'VAC', 'Work', 'WorkContour', 'BCWS', 'BCWP', 'BookingType', 'ActualWorkProtected', 'ActualOvertimeWorkProtected', 'CreationDate', 'AssnOwner', 'AssnOwnerGuid', 'BudgetCost', 'BudgetWork', 'ExtendedAttribute', 'Baseline', 'TimephasedData'],
  Project: ['SaveVersion', 'BuildNumber', 'Name', 'GUID', 'Title', 'Subject', 'Category', 'Company', 'Manager', 'Author', 'CreationDate', 'Revision', 'LastSaved', 'ScheduleFromStart', 'StartDate', 'FinishDate', 'FYStartDate', 'CriticalSlackLimit', 'CurrencyDigits', 'CurrencySymbol', 'CurrencyCode', 'CurrencySymbolPosition', 'CalendarUID', 'DefaultStartTime', 'DefaultFinishTime', 'MinutesPerDay', 'MinutesPerWeek', 'DaysPerMonth', 'DefaultTaskType', 'DefaultFixedCostAccrual', 'DefaultStandardRate', 'DefaultOvertimeRate', 'DurationFormat', 'WorkFormat', 'EditableActualCosts', 'HonorConstraints', 'EarnedValueMethod', 'InsertedProjectsLikeSummary', 'MultipleCriticalPaths', 'NewTasksEffortDriven', 'NewTasksEstimated', 'SplitsInProgressTasks', 'SpreadActualCost', 'SpreadPercentComplete', 'TaskUpdatesResource', 'FiscalYearStart', 'WeekStartDay', 'MoveCompletedEndsBack', 'MoveRemainingStartsBack', 'MoveRemainingStartsForward', 'MoveCompletedEndsForward', 'BaselineForEarnedValue', 'AutoAddNewResourcesAndTasks', 'StatusDate', 'CurrentDate', 'MicrosoftProjectServerURL', 'Autolink', 'NewTaskStartDate', 'NewTasksAreManual', 'DefaultTaskEVMethod', 'ProjectExternallyEdited', 'ExtendedCreationDate', 'ActualsInSync', 'RemoveFileProperties', 'AdminProject', 'UpdateManuallyScheduledTasksWhenEditingLinks', 'KeepTaskOnNearestWorkingTimeWhenMadeAutoScheduled', 'OutlineCodes', 'WBSMasks', 'ExtendedAttributes', 'Calendars', 'Tasks', 'Resources', 'Assignments'],
};

const inner = (xml: string) => /^<[^>]*>([\s\S]*)<\/[^>]*>$/.exec(xml.trim())?.[1].trim() ?? '';

/**
 * Children of a kept element written back: the file's own, except those whose inputs changed (`changed`), which are
 * the clone's (`ours`). `keepAlso` keeps a file element of a replaced name (custom fields among the clone's own).
 */
export function mergeKids(orig: [string, string | null][], ours: [string, string][], deps: Record<string, Dep>, changed: (fields: string[]) => boolean, order: string[], keepAlso?: (name: string, xml: string) => boolean): string {
  const mine = new Map<string, string[]>();
  for (const [n, x] of ours) { const l = mine.get(n); if (l) l.push(x); else mine.set(n, [x]); }
  const fresh = (n: string) => { const d = deps[n]; return d === 'struct' ? (mine.get(n) ?? []).map(inner).join('|') !== orig.filter((o) => o[0] === n).map((o) => inner(o[1] ?? '')).join('|') : typeof d === 'function' ? d() : d ? changed(d) : false; };
  const out: [string, string][] = [];
  const done = new Set<string>(), seen = new Set(orig.map((o) => o[0]));
  for (const [n, x] of orig) {
    if (x === null) { if (!done.has(n)) for (const y of mine.get(n) ?? []) out.push([n, y]); done.add(n); continue; }
    if (n in deps && fresh(n)) {
      if (!done.has(n)) for (const y of mine.get(n) ?? []) out.push([n, y]);
      done.add(n);
      if (keepAlso?.(n, x)) out.push([n, x]);
      continue;
    }
    out.push([n, x]);
  }
  // the clone's own elements the file did not have: only when they carry a change, in Microsoft Project's order
  for (const [n, xs] of mine) {
    if (seen.has(n) || !(n in deps) || !fresh(n)) continue;
    const at = order.indexOf(n);
    let i = out.length;
    if (at >= 0) { const j = out.findIndex(([m]) => order.indexOf(m) > at); if (j >= 0) i = j; }
    out.splice(i, 0, ...xs.map((x): [string, string] => [n, x]));
  }
  return out.map((o) => o[1]).join('');
}

/** What lies in other tables, looked up once per file (links per activity, rates, WBS roots). */
export interface KeepCtx { preds: Map<string, string>; rates: Map<string, Row>; roots: Map<string, string> }
export function keepCtx(db: Db): KeepCtx {
  const uid = new Map((db.tables.TASK?.rows ?? []).map((t) => [t.task_id, t._msp_uid || t.task_id]));
  const by = new Map<string, string[]>();
  for (const p of db.tables.TASKPRED?.rows ?? []) { const k = `${uid.get(p.pred_task_id)}:${p.pred_type}:${Number(p.lag_hr_cnt) || 0}`; const l = by.get(p.task_id); if (l) l.push(k); else by.set(p.task_id, [k]); }
  const rates = new Map<string, Row>();
  for (const x of db.tables.RSRCRATE?.rows ?? []) if (!rates.has(x.rsrc_id)) rates.set(x.rsrc_id, x);
  return { preds: new Map([...by].map(([k, l]) => [k, l.sort().join(',')])), rates, roots: new Map((db.tables.PROJWBS?.rows ?? []).filter((w) => w.proj_node_flag === 'Y').map((w) => [w.proj_id, w.wbs_name])) };
}

/** The values an element of a row is made from: the row, plus what lies in other tables (rates, the WBS root, links). */
export function snapshotOf(table: string, r: Row, k: KeepCtx): Record<string, string> {
  const s: Record<string, string> = {};
  for (const [f, v] of Object.entries(r)) if (!f.startsWith('_')) s[f] = v;
  if (table === 'RSRC') { const rate = k.rates.get(r.rsrc_id); s['~max'] = rate?.max_qty_per_hr ?? ''; s['~cost'] = rate?.cost_per_qty ?? ''; }
  if (table === 'PROJECT') s['~title'] = k.roots.get(r.proj_id) ?? '';
  if (table === 'TASK') s['~preds'] = k.preds.get(r.task_id) ?? '';
  return s;
}

/** After a file was read: each kept row's snapshot (what its elements were made from). */
export function snapshotKept(db: Db): void {
  const k = keepCtx(db);
  for (const t of ['PROJECT', 'PROJWBS', 'TASK', 'RSRC', 'TASKRSRC', 'CALENDAR']) {
    const T = db.tables[t];
    if (!T) continue;
    if (!T.fields.includes('_msp_snap')) T.fields.push('_msp_snap');
    for (const r of T.rows) if (r._msp_keep || r._msp_xml) r._msp_snap = JSON.stringify(snapshotOf(t, r, k));
  }
}

/** Which of `fields` differ from the row's snapshot (a row without one: all of them). */
export function changedSince(table: string, r: Row, k: KeepCtx): (fields: string[]) => boolean {
  if (!r._msp_snap) return () => true;
  const before = JSON.parse(r._msp_snap) as Record<string, string>;
  let now: Record<string, string> | null = null;
  return (fields) => { now ??= snapshotOf(table, r, k); return fields.some((f) => (now![f] ?? '') !== (before[f] ?? '')); };
}

/** Activity fields that move dates when changed, and the dates F9 writes. */
const DRIVERS = ['target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'act_start_date', 'act_end_date', 'cstr_type', 'cstr_date', 'cstr_type2', 'cstr_date2', 'clndr_id', 'task_type', 'duration_type', '~preds'];
export const DATES = ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt'];

/** A project read from Microsoft Project XML in which nothing that drives the dates changed since it was read (so
 *  Microsoft Project's own dates still hold); null when it was not read from Microsoft Project XML. */
export function mspUntouched(db: Db, projId: string): boolean | null {
  const p = (db.tables.PROJECT?.rows ?? []).find((x) => x.proj_id === projId);
  if (!p?._msp_keep) return null;
  const k = keepCtx(db);
  if (changedSince('PROJECT', p, k)(['last_recalc_date', 'clndr_id', 'plan_start_date'])) return false;
  const tasks = (db.tables.TASK?.rows ?? []).filter((t) => t.proj_id === projId);
  if (tasks.some((t) => !t._msp_snap || changedSince('TASK', t, k)(DRIVERS))) return false;
  if (tasks.length !== Number(p._msp_ntasks || tasks.length)) return false;
  return !(db.tables.CALENDAR?.rows ?? []).some((c) => c._msp_snap && changedSince('CALENDAR', c, k)(['clndr_data', 'base_clndr_id']));
}

/** The dates F9 changed on activities read from Microsoft Project XML (against what the file said). */
export function mspDateChanges(db: Db, projId: string, max = 25): { activities: number; changes: { id: string; source_uid: string; field: string; ms_project: string; now: string }[] } {
  const out: { id: string; source_uid: string; field: string; ms_project: string; now: string }[] = [];
  let n = 0;
  const resume = (db.tables.PROJECT?.rows ?? []).find((p) => p.proj_id === projId)?._msp_resume === 'Y';
  for (const t of (db.tables.TASK?.rows ?? []).filter((x) => x.proj_id === projId && x._msp_snap)) {
    const before = JSON.parse(t._msp_snap) as Record<string, string>;
    // a finished activity has no dates F9 moves (P6 puts its early and late dates at the data date, Microsoft Project
    // at its actuals: the file keeps Project's); a started one in a Microsoft Project file starts at its actual start
    if (t.act_end_date && before.act_end_date === t.act_end_date) continue;
    const started = resume && t.act_start_date && before.act_start_date === t.act_start_date;
    const diff = DATES.filter((f) => !(started && (f === 'early_start_date' || f === 'late_start_date')) && (t[f] ?? '') !== (before[f] ?? ''));
    if (!diff.length) continue;
    n++;
    for (const f of diff) if (out.length < max) out.push({ id: t.task_code, source_uid: t._msp_uid, field: f, ms_project: before[f] ?? '', now: t[f] ?? '' });
  }
  return { activities: n, changes: out };
}
