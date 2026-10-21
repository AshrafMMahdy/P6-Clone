// P6 XML (APIBusinessObjects) import/export, mapped onto the same P6 tables the XER layer uses.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { selectRows } from '../xer/write.ts';
import { parseClndrData, serializeClndrData, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, parseP6Date, minutesToSerial, serialToMinutes } from '../dates.ts';

// ---------- minimal XML tree

/** s / e: where the element starts and ends in the parsed text (to keep an element verbatim). */
export interface XNode { name: string; children: XNode[]; text: string; s?: number; e?: number }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The document tree. With `split`, an element split(parents, name) names (parents: the open elements' names, outside
 *  in) is handed to `emit` as soon as it closes and is not kept in the tree: a big document is held one element at a
 *  time, never whole (elements inside a split one are not split again). */
/** A string of its own: a value cut from a big document would otherwise keep the whole document alive (V8 keeps a
 *  piece of 13 characters or more as a view of the string it was cut from). */
const own = (s: string) => (s.length < 13 ? s : (s + ' ').slice(0, -1));
export function parseXml(text: string, split?: (parents: string[], name: string) => boolean, emit?: (parents: string[], n: XNode) => void, onRoot?: (root: XNode) => void): XNode {
  const root: XNode = { name: '#root', children: [], text: '' };
  onRoot?.(root);
  const stack = [root];
  const names: string[] = []; // the open elements' names (root excluded)
  let inSplit = 0; // stack depth of the open split element (0: none)
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^\w+:/, '');
      if (top.name !== name) throw new Error(`unexpected </${name}> (open <${top.name}>)`);
      top.e = re.lastIndex;
      stack.pop(); names.pop();
      if (inSplit && stack.length === inSplit - 1) { inSplit = 0; emit!(names, top); }
    } else if (m[3]) {
      const n: XNode = { name: m[3].replace(/^\w+:/, ''), children: [], text: '', s: m.index };
      const cut = !inSplit && !!split?.(names, n.name);
      if (!cut) top.children.push(n);
      if (!m[5]) { stack.push(n); names.push(n.name); if (cut) inSplit = stack.length; }
      else { n.e = re.lastIndex; if (cut) emit!(names, n); }
    } else if (m[6] != null) { if (!split) top.text += unesc(m[6]); else if (inSplit || /\S/.test(m[6])) top.text += own(unesc(m[6])); } // (the whitespace between kept elements is not kept)
  }
  if (stack.length > 1) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

const child = (n: XNode, name: string) => n.children.find((c) => c.name === name);
const kids = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
const val = (n: XNode, name: string) => child(n, name)?.text.trim() ?? '';

// ---------- field maps (XML tag <-> XER field)

type Conv = 'str' | 'date' | 'num' | 'bool' | `enum:${string}`;
type FieldMap = [tag: string, field: string, conv?: Conv][];

const ENUMS: Record<string, Record<string, string>> = {
  task_type: { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_LOE: 'Level of Effort', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_WBS: 'WBS Summary' },
  duration_type: { DT_FixedDUR2: 'Fixed Duration and Units', DT_FixedDrtn: 'Fixed Duration and Units/Time', DT_FixedQty: 'Fixed Units', DT_FixedRate: 'Fixed Units/Time' },
  complete_pct_type: { CP_Drtn: 'Duration', CP_Phys: 'Physical', CP_Units: 'Units' },
  status_code: { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' },
  cstr_type: { CS_MSO: 'Start On', CS_MSOB: 'Start On or Before', CS_MSOA: 'Start On or After', CS_MEO: 'Finish On', CS_MEOB: 'Finish On or Before', CS_MEOA: 'Finish On or After', CS_ALAP: 'As Late As Possible', CS_MANDSTART: 'Mandatory Start', CS_MANDFIN: 'Mandatory Finish' },
  pred_type: { PR_FS: 'Finish to Start', PR_SS: 'Start to Start', PR_FF: 'Finish to Finish', PR_SF: 'Start to Finish' },
  rsrc_type: { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' },
  clndr_type: { CA_Base: 'Global', CA_Project: 'Project', CA_Rsrc: 'Resource' },
  priority_type: { PT_Top: 'Top', PT_High: 'High', PT_Normal: 'Normal', PT_Low: 'Low', PT_Lowest: 'Lowest' },
  critical_path_type: { CT_TotFloat: 'Critical Float', CT_DrivPath: 'Longest Path' },
  wbs_status: { WS_Planned: 'Planned', WS_Open: 'Active', WS_Closed: 'Inactive', WS_Whatif: 'What-If' },
  udf_table: { TASK: 'Activity', PROJWBS: 'WBS', PROJECT: 'Project', RSRC: 'Resource', TASKRSRC: 'Resource Assignment', PROJCOST: 'Activity Expense', TASKPROC: 'Activity Step' },
  udf_data_type: { FT_TEXT: 'Text', FT_START_DATE: 'Start Date', FT_END_DATE: 'Finish Date', FT_FLOAT_2_DECIMALS: 'Double', FT_INT: 'Integer', FT_MONEY: 'Cost', FT_STATICTYPE: 'Indicator', FT_CODE: 'Code' },
  code_scope: { AS_Global: 'Global', AS_EPS: 'EPS', AS_Project: 'Project' },
  lag_calendar: { rcal_Predecessor: 'Predecessor Activity Calendar', rcal_Successor: 'Successor Activity Calendar', rcal_ProjDefault: 'Project Default Calendar', rcal_24Hour: '24 Hour Calendar' },
  float_type: { FT_FF: 'Finish Float = Late Finish - Early Finish', FT_SS: 'Start Float = Late Start - Early Start', FT_Min: 'Smallest of Start Float and Finish Float', FT_Smallest: 'Smallest of Start Float and Finish Float' },
};

const PROJECT_MAP: FieldMap = [['ObjectId', 'proj_id'], ['Id', 'proj_short_name'], ['PlannedStartDate', 'plan_start_date', 'date'], ['MustFinishByDate', 'plan_end_date', 'date'],
  ['DataDate', 'last_recalc_date', 'date'], ['ScheduledFinishDate', 'scd_end_date', 'date'], ['DefaultCalendarObjectId', 'clndr_id'], ['CriticalActivityFloatLimit', 'critical_drtn_hr_cnt', 'num'],
  ['CriticalActivityPathType', 'critical_path_type', 'enum:critical_path_type'], ['ActivityIdPrefix', 'task_code_prefix'], ['ActivityIdSuffix', 'task_code_base', 'num'], ['ActivityIdIncrement', 'task_code_step', 'num'],
  ['ActivityDefaultDurationType', 'def_duration_type', 'enum:duration_type'], ['ActivityDefaultPercentCompleteType', 'def_complete_pct_type', 'enum:complete_pct_type'], ['ActivityDefaultActivityType', 'def_task_type', 'enum:task_type'],
  ['GUID', 'guid'], ['CurrentBaselineProjectObjectId', 'sum_base_proj_id']];
/** Schedule options as direct Project children: what earlier P6 Clone builds wrote (read for old files only). */
const OLD_SCHED_MAP: FieldMap = [['RelationshipLagCalendar', 'sched_calendar_on_relationship_lag', 'enum:lag_calendar'], ['TotalFloatType', 'sched_float_type', 'enum:float_type'], ['ProgressOverride', 'sched_progress_override', 'bool'],
  ['RetainedLogic', 'sched_retained_logic', 'bool'], ['MakeOpenEndedActivitiesCritical', 'sched_open_critical_flag', 'bool'], ['UseExpectedFinishDates', 'sched_use_expect_end_flag', 'bool'],
  ['IgnoreOtherProjectRelationships', 'sched_outer_depend_type']];
/** P6's <Project><ScheduleOptions> (OutOfSequenceScheduleType sets the two progressed-activity flags, see schedOptions*). */
const SCHED_MAP: FieldMap = [['IgnoreOtherProjectRelationships', 'sched_outer_depend_type'], ['MakeOpenEndedActivitiesCritical', 'sched_open_critical_flag', 'bool'],
  ['UseExpectedFinishDates', 'sched_use_expect_end_flag', 'bool'], ['StartToStartLagCalculationType', 'sched_lag_early_start_flag', 'bool'],
  ['CalculateFloatBasedOnFinishDate', 'sched_use_project_end_date_for_float', 'bool'], ['RelationshipLagCalendar', 'sched_calendar_on_relationship_lag', 'enum:lag_calendar'],
  ['ComputeTotalFloatType', 'sched_float_type', 'enum:float_type']];
const LOGIC: [label: string, retained: string, override: string][] = [['Retained Logic', 'Y', 'N'], ['Progress Override', 'N', 'Y'], ['Actual Dates', 'N', 'N']];
function schedOptionsXml(so: Row): string {
  if (!Object.keys(so).length) return '';
  const logic = so.sched_retained_logic === 'Y' ? LOGIC[0] : so.sched_progress_override === 'Y' ? LOGIC[1] : so.sched_retained_logic || so.sched_progress_override ? LOGIC[2] : null;
  return `<ScheduleOptions>${toXml(so, SCHED_MAP)}${logic ? `<OutOfSequenceScheduleType>${logic[0]}</OutOfSequenceScheduleType>` : ''}</ScheduleOptions>`;
}
function schedOptionsRow(n: XNode): Row {
  const r = fromXml(n, SCHED_MAP);
  const l = LOGIC.find(([label]) => label === val(n, 'OutOfSequenceScheduleType'));
  if (l) { r.sched_retained_logic = l[1]; r.sched_progress_override = l[2]; }
  return r;
}
const WBS_MAP: FieldMap = [['ObjectId', 'wbs_id'], ['ProjectObjectId', 'proj_id'], ['ParentObjectId', 'parent_wbs_id'], ['Code', 'wbs_short_name'], ['Name', 'wbs_name'], ['SequenceNumber', 'seq_num', 'num'],
  ['Status', 'status_code', 'enum:wbs_status'], ['OBSObjectId', 'obs_id'], ['GUID', 'guid']];
const ACT_MAP: FieldMap = [['ObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['WBSObjectId', 'wbs_id'], ['CalendarObjectId', 'clndr_id'], ['Id', 'task_code'], ['Name', 'task_name'],
  ['Type', 'task_type', 'enum:task_type'], ['DurationType', 'duration_type', 'enum:duration_type'], ['PercentCompleteType', 'complete_pct_type', 'enum:complete_pct_type'], ['Status', 'status_code', 'enum:status_code'],
  ['PlannedDuration', 'target_drtn_hr_cnt', 'num'], ['RemainingDuration', 'remain_drtn_hr_cnt', 'num'], ['PhysicalPercentComplete', 'phys_complete_pct', 'num'],
  ['ActualStartDate', 'act_start_date', 'date'], ['ActualFinishDate', 'act_end_date', 'date'], ['PlannedStartDate', 'target_start_date', 'date'], ['PlannedFinishDate', 'target_end_date', 'date'],
  ['EarlyStartDate', 'early_start_date', 'date'], ['EarlyFinishDate', 'early_end_date', 'date'], ['LateStartDate', 'late_start_date', 'date'], ['LateFinishDate', 'late_end_date', 'date'],
  ['RemainingEarlyStartDate', 'restart_date', 'date'], ['RemainingEarlyFinishDate', 'reend_date', 'date'], ['RemainingLateStartDate', 'rem_late_start_date', 'date'], ['RemainingLateFinishDate', 'rem_late_end_date', 'date'],
  ['ExpectedFinishDate', 'expect_end_date', 'date'], ['SuspendDate', 'suspend_date', 'date'], ['ResumeDate', 'resume_date', 'date'],
  ['TotalFloat', 'total_float_hr_cnt', 'num'], ['FreeFloat', 'free_float_hr_cnt', 'num'], ['IsLongestPath', 'driving_path_flag', 'bool'],
  ['PrimaryConstraintType', 'cstr_type', 'enum:cstr_type'], ['PrimaryConstraintDate', 'cstr_date', 'date'], ['SecondaryConstraintType', 'cstr_type2', 'enum:cstr_type'], ['SecondaryConstraintDate', 'cstr_date2', 'date'],
  ['LevelingPriority', 'priority_type', 'enum:priority_type'], ['PrimaryResourceObjectId', 'rsrc_id'], ['ExternalEarlyStartDate', 'external_early_start_date', 'date'], ['ExternalLateFinishDate', 'external_late_end_date', 'date'], ['GUID', 'guid']];
const REL_MAP: FieldMap = [['ObjectId', 'task_pred_id'], ['PredecessorActivityObjectId', 'pred_task_id'], ['SuccessorActivityObjectId', 'task_id'], ['PredecessorProjectObjectId', 'pred_proj_id'],
  ['SuccessorProjectObjectId', 'proj_id'], ['Type', 'pred_type', 'enum:pred_type'], ['Lag', 'lag_hr_cnt', 'num']];
const RSRC_MAP: FieldMap = [['ObjectId', 'rsrc_id'], ['Id', 'rsrc_short_name'], ['Name', 'rsrc_name'], ['ResourceType', 'rsrc_type', 'enum:rsrc_type'], ['CalendarObjectId', 'clndr_id'],
  ['ParentObjectId', 'parent_rsrc_id'], ['DefaultUnitsPerTime', 'def_qty_per_hr', 'num'], ['EmployeeId', 'employee_code'], ['EmailAddress', 'email_addr'], ['Title', 'rsrc_title_name'], ['IsActive', 'active_flag', 'bool'], ['GUID', 'guid']];
const RATE_MAP: FieldMap = [['ObjectId', 'rsrc_rate_id'], ['ResourceObjectId', 'rsrc_id'], ['EffectiveDate', 'start_date', 'date'], ['MaxUnitsPerTime', 'max_qty_per_hr', 'num'], ['PricePerUnit', 'cost_per_qty', 'num']];
const ASSIGN_MAP: FieldMap = [['ObjectId', 'taskrsrc_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['ResourceObjectId', 'rsrc_id'], ['RoleObjectId', 'role_id'], ['CostAccountObjectId', 'acct_id'],
  ['PlannedUnits', 'target_qty', 'num'], ['ActualRegularUnits', 'act_reg_qty', 'num'], ['ActualOvertimeUnits', 'act_ot_qty', 'num'], ['RemainingUnits', 'remain_qty', 'num'],
  ['PlannedUnitsPerTime', 'target_qty_per_hr', 'num'], ['RemainingUnitsPerTime', 'remain_qty_per_hr', 'num'], ['PricePerUnit', 'cost_per_qty', 'num'], ['PlannedCost', 'target_cost', 'num'],
  ['ActualRegularCost', 'act_reg_cost', 'num'], ['ActualOvertimeCost', 'act_ot_cost', 'num'], ['RemainingCost', 'remain_cost', 'num'],
  ['ActualStartDate', 'act_start_date', 'date'], ['ActualFinishDate', 'act_end_date', 'date'], ['PlannedStartDate', 'target_start_date', 'date'], ['PlannedFinishDate', 'target_end_date', 'date'],
  ['RemainingStartDate', 'restart_date', 'date'], ['RemainingFinishDate', 'reend_date', 'date'], ['RateType', 'rate_type'], ['ResourceType', 'rsrc_type', 'enum:rsrc_type']];
const EXP_MAP: FieldMap = [['ObjectId', 'cost_item_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['CostAccountObjectId', 'acct_id'], ['ExpenseItem', 'cost_name'],
  ['PlannedCost', 'target_cost', 'num'], ['ActualCost', 'act_cost', 'num'], ['RemainingCost', 'remain_cost', 'num'], ['Vendor', 'vendor_name'], ['DocumentNumber', 'po_number']];
const CODETYPE_MAP: FieldMap = [['ObjectId', 'actv_code_type_id'], ['Name', 'actv_code_type'], ['Scope', 'actv_code_type_scope', 'enum:code_scope'], ['ProjectObjectId', 'proj_id'], ['Length', 'actv_short_len', 'num'], ['SequenceNumber', 'seq_num', 'num']];
const CODE_MAP: FieldMap = [['ObjectId', 'actv_code_id'], ['CodeTypeObjectId', 'actv_code_type_id'], ['ParentObjectId', 'parent_actv_code_id'], ['CodeValue', 'short_name'], ['Description', 'actv_code_name'], ['SequenceNumber', 'seq_num', 'num']];
const CODEASSIGN_MAP: FieldMap = [['ActivityObjectId', 'task_id'], ['ActivityCodeTypeObjectId', 'actv_code_type_id'], ['ActivityCodeObjectId', 'actv_code_id'], ['ProjectObjectId', 'proj_id']];
const ACCOUNT_MAP: FieldMap = [['ObjectId', 'acct_id'], ['ParentObjectId', 'parent_acct_id'], ['Id', 'acct_short_name'], ['Name', 'acct_name'], ['SequenceNumber', 'acct_seq_num', 'num']];
const OBS_MAP: FieldMap = [['ObjectId', 'obs_id'], ['ParentObjectId', 'parent_obs_id'], ['Name', 'obs_name'], ['SequenceNumber', 'seq_num', 'num']];
const UDFTYPE_MAP: FieldMap = [['ObjectId', 'udf_type_id'], ['SubjectArea', 'table_name', 'enum:udf_table'], ['Title', 'udf_type_label'], ['DataType', 'logical_data_type', 'enum:udf_data_type']];
const UDFVAL_MAP: FieldMap = [['TypeObjectId', 'udf_type_id'], ['ForeignObjectId', 'fk_id'], ['ProjectObjectId', 'proj_id'], ['Text', 'udf_text'], ['Double', 'udf_number', 'num'], ['StartDate', 'udf_date', 'date']];
const CURR_MAP: FieldMap = [['ObjectId', 'curr_id'], ['Id', 'curr_short_name'], ['Name', 'curr_type'], ['Symbol', 'curr_symbol'], ['ExchangeRate', 'base_exch_rate', 'num'], ['DecimalPlaces', 'decimal_digit_cnt', 'num']];
const ROLE_MAP: FieldMap = [['ObjectId', 'role_id'], ['ParentObjectId', 'parent_role_id'], ['Id', 'role_short_name'], ['Name', 'role_name']];
const MEMO_MAP: FieldMap = [['ObjectId', 'memo_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['NotebookTopicObjectId', 'memo_type_id'], ['Note', 'task_memo']];
const STEP_MAP: FieldMap = [['ObjectId', 'proc_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['SequenceNumber', 'seq_num', 'num'], ['Name', 'proc_name'], ['IsCompleted', 'complete_flag', 'bool'], ['Weight', 'proc_wt', 'num'], ['Description', 'proc_descr']];
const PCODETYPE_MAP: FieldMap = [['ObjectId', 'proj_catg_type_id'], ['Name', 'proj_catg_type'], ['SequenceNumber', 'seq_num', 'num'], ['Length', 'proj_catg_short_len', 'num']];
const PCODE_MAP: FieldMap = [['ObjectId', 'proj_catg_id'], ['CodeTypeObjectId', 'proj_catg_type_id'], ['ParentObjectId', 'parent_proj_catg_id'], ['CodeValue', 'proj_catg_short_name'], ['Description', 'proj_catg_name'], ['SequenceNumber', 'seq_num', 'num']];
const RCODETYPE_MAP: FieldMap = [['ObjectId', 'rsrc_catg_type_id'], ['Name', 'rsrc_catg_type'], ['SequenceNumber', 'seq_num', 'num'], ['Length', 'rsrc_catg_short_len', 'num']];
const RCODE_MAP: FieldMap = [['ObjectId', 'rsrc_catg_id'], ['CodeTypeObjectId', 'rsrc_catg_type_id'], ['ParentObjectId', 'parent_rsrc_catg_id'], ['CodeValue', 'rsrc_catg_short_name'], ['Description', 'rsrc_catg_name'], ['SequenceNumber', 'seq_num', 'num']];
const TOPIC_MAP: FieldMap = [['ObjectId', 'memo_type_id'], ['Name', 'memo_type'], ['AvailableForActivity', 'task_flag', 'bool'], ['AvailableForEPS', 'eps_flag', 'bool'], ['AvailableForProject', 'proj_flag', 'bool'], ['AvailableForWBS', 'wbs_flag', 'bool'], ['SequenceNumber', 'seq_num', 'num']];
/** a WBS's or (on the root WBS node, the project's WBSObjectId) the project's notebook */
const WBSMEMO_MAP: FieldMap = [['ObjectId', 'wbs_memo_id'], ['ProjectObjectId', 'proj_id'], ['WBSObjectId', 'wbs_id'], ['NotebookTopicObjectId', 'memo_type_id'], ['Note', 'wbs_memo']];

const xmlDate = (s: string) => { const t = parseP6Date(s); return t == null ? '' : formatP6Date(t).replace(' ', 'T') + ':00'; };
const xerDate = (s: string) => { const t = parseP6Date(s.replace('T', ' ').slice(0, 16)); return t == null ? '' : formatP6Date(t); };

function toXml(r: Row, map: FieldMap): string {
  let out = '';
  for (const [tag, field, conv] of map) {
    let v = r[field];
    if (v == null || v === '') continue;
    if (conv === 'date') v = xmlDate(v);
    else if (conv === 'bool') v = v === 'Y' ? 'true' : 'false';
    else if (conv?.startsWith('enum:')) v = ENUMS[conv.slice(5)]?.[v] ?? v;
    if (field === 'sched_outer_depend_type') v = v === 'SD_None' ? 'true' : 'false';
    if (v) out += `<${tag}>${esc(v)}</${tag}>`;
  }
  return out;
}

function fromXml(n: XNode, map: FieldMap): Row {
  const r: Row = {};
  for (const [tag, field, conv] of map) {
    const c = child(n, tag);
    if (!c) continue;
    let v = c.text.trim();
    if (conv === 'date') v = xerDate(v);
    else if (conv === 'bool') v = v === 'true' || v === '1' ? 'Y' : 'N';
    else if (conv?.startsWith('enum:')) { const e = ENUMS[conv.slice(5)]; v = v === 'None' || v === '<None>' ? '' : Object.entries(e).find(([, l]) => l === v)?.[0] ?? v; }
    if (field === 'sched_outer_depend_type') v = v === 'true' || v === '1' ? 'SD_None' : 'SD_Both';
    r[field] = v;
  }
  return r;
}

// ---------- calendars

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
// P6 writes a shift's Finish as its last working minute (08:00-16:59 for 08:00-17:00).
const shiftsXml = (ss: Shift[]) => ss.map((s) => `<WorkTime><Start>${hm(s.start)}</Start><Finish>${hm(s.end - 1)}</Finish></WorkTime>`).join('');

function calendarXml(r: Row): string {
  let def: CalendarDef | null = null;
  try { def = parseClndrData(r.clndr_data); } catch { def = null; }
  let s = `<Calendar><ObjectId>${esc(r.clndr_id)}</ObjectId><Name>${esc(r.clndr_name)}</Name><Type>${ENUMS.clndr_type[r.clndr_type] ?? 'Global'}</Type><IsDefault>${r.default_flag === 'Y'}</IsDefault>`;
  if (r.rsrc_private) s += `<IsPersonal>${r.rsrc_private === 'Y'}</IsPersonal>`;
  if (r.base_clndr_id) s += `<BaseCalendarObjectId>${esc(r.base_clndr_id)}</BaseCalendarObjectId>`;
  if (r.proj_id) s += `<ProjectObjectId>${esc(r.proj_id)}</ProjectObjectId>`;
  for (const [tag, f] of [['HoursPerDay', 'day_hr_cnt'], ['HoursPerWeek', 'week_hr_cnt'], ['HoursPerMonth', 'month_hr_cnt'], ['HoursPerYear', 'year_hr_cnt']]) if (r[f]) s += `<${tag}>${r[f]}</${tag}>`;
  if (def) {
    s += '<StandardWorkWeek>' + def.week.map((ss, i) => `<StandardWorkHours><DayOfWeek>${DAYS[i]}</DayOfWeek>${shiftsXml(ss)}</StandardWorkHours>`).join('') + '</StandardWorkWeek>';
    s += '<HolidayOrExceptions>' + [...def.exceptions.entries()].sort((a, b) => a[0] - b[0]).map(([d, ss]) => `<HolidayOrException><Date>${xmlDate(formatP6Date(serialToMinutes(d)))}</Date>${shiftsXml(ss)}</HolidayOrException>`).join('') + '</HolidayOrExceptions>';
  }
  return s + '</Calendar>';
}

function calendarRow(n: XNode): Row {
  const parseT = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s); return m ? +m[1] * 60 + +m[2] : NaN; };
  // P6's Finish is the last working minute (hh:59 or hh:29); older P6 Clone files wrote the end itself (hh:00, 00:00 = midnight)
  const endT = (s: string) => { const v = parseT(s); return v % 30 === 29 ? v + 1 : v === 0 ? 1440 : v; };
  const shifts = (x: XNode) => kids(x, 'WorkTime').map((w) => ({ start: parseT(val(w, 'Start')), end: endT(val(w, 'Finish')) })).filter((s) => s.end > s.start);
  const none: XNode = { name: '', children: [], text: '' };
  const def: CalendarDef = { week: [[], [], [], [], [], [], []], exceptions: new Map() };
  for (const d of kids(child(n, 'StandardWorkWeek') ?? none, 'StandardWorkHours')) {
    const i = DAYS.indexOf(val(d, 'DayOfWeek'));
    if (i >= 0) def.week[i] = shifts(d);
  }
  const exceptions = [...kids(child(n, 'HolidayOrExceptions') ?? none, 'HolidayOrException'), ...kids(child(n, 'HolidayExceptions') ?? none, 'HolidayException')];
  for (const h of exceptions) {
    const t = parseP6Date(val(h, 'Date').replace('T', ' ').slice(0, 16));
    if (t == null) continue;
    const ss = shifts(h);
    // a single 00:00-23:59 entry is P6's way of writing a non-working day
    def.exceptions.set(minutesToSerial(t), ss.length === 1 && ss[0].start === 0 && ss[0].end === 1440 ? [] : ss);
  }
  const type = Object.entries(ENUMS.clndr_type).find(([, l]) => l === val(n, 'Type'))?.[0] ?? 'CA_Base';
  const yes = (s: string) => s === 'true' || s === '1';
  return {
    clndr_id: val(n, 'ObjectId'), default_flag: yes(val(n, 'IsDefault')) ? 'Y' : 'N', clndr_name: val(n, 'Name'), proj_id: val(n, 'ProjectObjectId'),
    base_clndr_id: val(n, 'BaseCalendarObjectId'), last_chng_date: '', clndr_type: type, day_hr_cnt: val(n, 'HoursPerDay'), week_hr_cnt: val(n, 'HoursPerWeek'),
    month_hr_cnt: val(n, 'HoursPerMonth'), year_hr_cnt: val(n, 'HoursPerYear'), rsrc_private: yes(val(n, 'IsPersonal')) ? 'Y' : 'N', clndr_data: serializeClndrData(def),
  };
}

// ---------- code and UDF assignments, nested in their object as P6 writes them (<Code>, <UDF>)

const UDF_TAG: Record<string, [tag: string, field: string]> = { FT_START_DATE: ['StartDateValue', 'udf_date'], FT_END_DATE: ['FinishDateValue', 'udf_date'], FT_MONEY: ['CostValue', 'udf_number'], FT_INT: ['IntegerValue', 'udf_number'], FT_FLOAT_2_DECIMALS: ['DoubleValue', 'udf_number'], FT_FLOAT: ['DoubleValue', 'udf_number'] };
const UDF_READ: [tag: string, field: string][] = [['TextValue', 'udf_text'], ['DoubleValue', 'udf_number'], ['IntegerValue', 'udf_number'], ['CostValue', 'udf_number'], ['StartDateValue', 'udf_date'], ['FinishDateValue', 'udf_date'], ['CodeValue', 'udf_code_id']];

/** <Code> assignments of a project or resource (project / resource codes). */
function codeRefsXml(rs: Row[], typeF: string, valF: string): string {
  return rs.map((a) => `<Code><TypeObjectId>${esc(a[typeF] ?? '')}</TypeObjectId><ValueObjectId>${esc(a[valF] ?? '')}</ValueObjectId></Code>`).join('');
}
function codesXml(rs: Row[], codeType: Map<string, string>): string {
  return rs.map((a) => `<Code><TypeObjectId>${esc(a.actv_code_type_id || codeType.get(a.actv_code_id) || '')}</TypeObjectId><ValueObjectId>${esc(a.actv_code_id)}</ValueObjectId></Code>`).join('');
}
function udfsXml(rs: Row[], udfType: Map<string, Row>): string {
  return rs.map((u) => {
    const [tag, f] = UDF_TAG[udfType.get(u.udf_type_id)?.logical_data_type ?? ''] ?? ['TextValue', 'udf_text'];
    const v = f === 'udf_date' ? xmlDate(u[f] ?? '') : u[f] ?? '';
    return v === '' ? '' : `<UDF><TypeObjectId>${esc(u.udf_type_id)}</TypeObjectId><${tag}>${esc(v)}</${tag}></UDF>`;
  }).join('');
}
function udfRows(n: XNode, fk: string, projId: string): Row[] {
  return kids(n, 'UDF').map((u) => {
    const r: Row = { udf_type_id: val(u, 'TypeObjectId'), fk_id: fk, proj_id: projId };
    for (const [tag, f] of UDF_READ) if (child(u, tag)) r[f] = f === 'udf_date' ? xerDate(val(u, tag)) : val(u, tag);
    return r;
  });
}

// ---------- writer

export function writeP6Xml(db: Db, opts: { projIds?: string[]; version?: string }): string {
  const parts: string[] = [];
  writeP6XmlTo(db, opts, (chunk) => parts.push(chunk));
  return parts.join('');
}

/** The P6 XML document piece by piece (put gets whole lines, in order): a file writer streams it, so a big schedule is
 *  never one string (a 98 MB XER made a 330 MB document and a 3.3 GB peak when it was joined). */
export function writeP6XmlTo(db: Db, opts: { projIds?: string[]; version?: string }, put: (chunk: string) => void): void {
  const sel = selectRows(db, opts.projIds);
  const get = (t: string) => sel.get(t) ?? [];
  // the namespace names the P6 release the file is for (P6 XML exists from 8.x; older versions get the 8.1 schema)
  const ver = opts.version && Number(opts.version.split('.')[0]) >= 8 ? opts.version : opts.version ? '8.1' : '19.12';
  const ns = `http://xmlns.oracle.com/Primavera/P6/V${ver}/API/BusinessObjects`;
  const out = { push: (line: string) => put(line + '\n') };
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push(`<APIBusinessObjects xmlns="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${ns} http://xmlns.oracle.com/Primavera/P6/V${ver ?? '19.12'}/API/p6apibo.xsd">`);
  const el = (tag: string, r: Row, map: FieldMap, extra = '') => out.push(`<${tag}>${toXml(r, map)}${extra}</${tag}>`);
  const udfType = new Map(rows(db, 'UDFTYPE').map((u) => [u.udf_type_id, u]));
  const udfsOf = new Map<string, Row[]>();
  for (const u of get('UDFVALUE')) { const k = `${udfType.get(u.udf_type_id)?.table_name}|${u.fk_id}`; const l = udfsOf.get(k); if (l) l.push(u); else udfsOf.set(k, [u]); }
  const udfs = (table: string, id: string) => udfsXml(udfsOf.get(`${table}|${id}`) ?? [], udfType);
  const codeType = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c.actv_code_type_id]));
  const codesOf = new Map<string, Row[]>();
  for (const a of get('TASKACTV')) { const l = codesOf.get(a.task_id); if (l) l.push(a); else codesOf.set(a.task_id, [a]); }
  for (const r of get('CURRTYPE')) el('Currency', r, CURR_MAP);
  for (const r of get('OBS')) el('OBS', r, OBS_MAP);
  for (const r of get('ACCOUNT')) el('CostAccount', r, ACCOUNT_MAP);
  for (const r of get('MEMOTYPE')) el('NotebookTopic', r, TOPIC_MAP);
  for (const r of get('UDFTYPE')) el('UDFType', r, UDFTYPE_MAP);
  for (const r of get('ACTVTYPE').filter((x) => !x.proj_id)) el('ActivityCodeType', r, CODETYPE_MAP);
  const globalTypes = new Set(get('ACTVTYPE').filter((x) => !x.proj_id).map((x) => x.actv_code_type_id));
  for (const r of get('ACTVCODE').filter((x) => globalTypes.has(x.actv_code_type_id))) el('ActivityCode', r, CODE_MAP);
  for (const r of get('CALENDAR').filter((x) => !x.proj_id)) out.push(calendarXml(r));
  for (const r of get('PCATTYPE')) el('ProjectCodeType', r, PCODETYPE_MAP);
  for (const r of get('PCATVAL')) el('ProjectCode', r, PCODE_MAP);
  for (const r of get('RCATTYPE')) el('ResourceCodeType', r, RCODETYPE_MAP);
  for (const r of get('RCATVAL')) el('ResourceCode', r, RCODE_MAP);
  for (const r of get('ROLES')) el('Role', r, ROLE_MAP);
  const rcodes = new Map<string, Row[]>(); for (const a of get('RSRCRCAT')) { const l = rcodes.get(a.rsrc_id); if (l) l.push(a); else rcodes.set(a.rsrc_id, [a]); }
  for (const r of get('RSRC')) el('Resource', r, RSRC_MAP, codeRefsXml(rcodes.get(r.rsrc_id) ?? [], 'rsrc_catg_type_id', 'rsrc_catg_id') + udfs('RSRC', r.rsrc_id));
  for (const r of get('RSRCRATE')) el('ResourceRate', r, RATE_MAP);
  const pcodes = new Map<string, Row[]>(); for (const a of get('PROJPCAT')) { const l = pcodes.get(a.proj_id); if (l) l.push(a); else pcodes.set(a.proj_id, [a]); }
  const projectXml = (tag: 'Project' | 'BaselineProject', p: Row, get: (t: string) => Row[], originalId?: string) => {
    const wbsAll = get('PROJWBS');
    const pid = p.proj_id;
    const root = wbsAll.find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
    const so = get('SCHEDOPTIONS').find((s) => s.proj_id === pid) ?? {};
    let body = toXml(p, PROJECT_MAP) + `<Name>${esc(root?.wbs_name || p._name || p.proj_short_name)}</Name>` + (originalId ? `<OriginalProjectObjectId>${esc(originalId)}</OriginalProjectObjectId>` : '') + codeRefsXml(pcodes.get(pid) ?? [], 'proj_catg_type_id', 'proj_catg_id') + udfs('PROJECT', pid) + schedOptionsXml(so);
    if (root?.wbs_id) body += `<WBSObjectId>${esc(root.wbs_id)}</WBSObjectId>`;
    out.push(`<${tag}>${body}`);
    for (const r of get('CALENDAR').filter((x) => x.proj_id === pid)) out.push(calendarXml(r));
    for (const r of get('ACTVTYPE').filter((x) => x.proj_id === pid)) el('ActivityCodeType', r, CODETYPE_MAP);
    for (const r of get('ACTVCODE').filter((x) => !globalTypes.has(x.actv_code_type_id) && get('ACTVTYPE').some((t) => t.actv_code_type_id === x.actv_code_type_id && t.proj_id === pid))) el('ActivityCode', r, CODE_MAP);
    for (const r of wbsAll.filter((w) => w.proj_id === pid && w.proj_node_flag !== 'Y')) el('WBS', { ...r, parent_wbs_id: r.parent_wbs_id === root?.wbs_id ? '' : r.parent_wbs_id }, WBS_MAP, udfs('PROJWBS', r.wbs_id));
    for (const r of get('TASK').filter((t) => t.proj_id === pid)) // P6 XML percentages are fractions (0.5 = 50%)
      el('Activity', { ...r, wbs_id: r.wbs_id === root?.wbs_id ? '' : r.wbs_id, phys_complete_pct: r.phys_complete_pct ? String(Number(r.phys_complete_pct) / 100) : '' }, ACT_MAP, codesXml(codesOf.get(r.task_id) ?? [], codeType) + udfs('TASK', r.task_id));
    for (const r of get('TASKPRED').filter((t) => t.proj_id === pid)) el('Relationship', r, REL_MAP);
    for (const r of get('TASKRSRC').filter((t) => t.proj_id === pid)) el('ResourceAssignment', r, ASSIGN_MAP);
    for (const r of get('PROJCOST').filter((t) => t.proj_id === pid)) el('ActivityExpense', r, EXP_MAP);
    for (const r of get('TASKMEMO').filter((t) => t.proj_id === pid)) el('ActivityNote', r, MEMO_MAP);
    for (const r of get('TASKPROC').filter((t) => t.proj_id === pid)) // step % complete as a fraction, like activity percentages
      el('ActivityStep', r, STEP_MAP, r.complete_pct ? `<PercentComplete>${Number(r.complete_pct) / 100}</PercentComplete>` : '');
    for (const r of get('WBSMEMO').filter((t) => t.proj_id === pid)) el('ProjectNote', r, WBSMEMO_MAP);
    out.push(`</${tag}>`);
  };
  for (const p of get('PROJECT')) projectXml('Project', p, get);
  // baselines of the exported projects, as P6 writes them with "export baselines"
  const all = (t: string) => rows(db, t);
  for (const p of get('PROJECT')) for (const b of rows(db, 'PROJECT').filter((x) => x._baseline_of === p.proj_id)) projectXml('BaselineProject', b, all, p.proj_id);
  out.push('</APIBusinessObjects>');
}

// ---------- parser

export function parseP6Xml(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  const push = (t: string, r: Row) => { const T = table(db, t); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };
  const topMap: [string, string, FieldMap][] = [['Currency', 'CURRTYPE', CURR_MAP], ['OBS', 'OBS', OBS_MAP], ['CostAccount', 'ACCOUNT', ACCOUNT_MAP], ['NotebookTopic', 'MEMOTYPE', TOPIC_MAP],
    ['UDFType', 'UDFTYPE', UDFTYPE_MAP], ['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Role', 'ROLES', ROLE_MAP], ['Resource', 'RSRC', RSRC_MAP], ['ResourceRate', 'RSRCRATE', RATE_MAP],
    ['ProjectCodeType', 'PCATTYPE', PCODETYPE_MAP], ['ProjectCode', 'PCATVAL', PCODE_MAP], ['ResourceCodeType', 'RCATTYPE', RCODETYPE_MAP], ['ResourceCode', 'RCATVAL', RCODE_MAP]];
  const projMap: [string, string, FieldMap][] = [['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Relationship', 'TASKPRED', REL_MAP], ['ResourceAssignment', 'TASKRSRC', ASSIGN_MAP],
    ['ActivityExpense', 'PROJCOST', EXP_MAP], ['ActivityCodeAssignment', 'TASKACTV', CODEASSIGN_MAP], ['ActivityNote', 'TASKMEMO', MEMO_MAP], ['UDFValue', 'UDFVALUE', UDFVAL_MAP], ['ActivityStep', 'TASKPROC', STEP_MAP], ['ProjectNote', 'WBSMEMO', WBSMEMO_MAP]];
  // Read as it goes: each top-level element, and each activity, WBS element, relationship, ... of a project, is turned
  // into rows as soon as it closes and let go (a big file is never one tree). A project's own rows are pushed after
  // every top-level element's, Projects before BaselineProjects, as a whole tree would order them.
  type Group = { node: XNode; rows: [string, Row][]; held: XNode[]; at: { pid: string; rootId: string } | null; fallback: [Row, string, 'pid' | 'root'][] };
  const groups = new Map<XNode, Group>();
  const HEAVY = new Set(['Calendar', 'WBS', 'Activity', ...projMap.map(([tag]) => tag)]);
  const top = (n: XNode) => {
    const m = topMap.find(([tag]) => tag === n.name);
    if (m) { const r = fromXml(n, m[2]); push(m[1], r); if (n.name === 'Resource') { for (const u of udfRows(n, r.rsrc_id, '')) push('UDFVALUE', u); for (const c of kids(n, 'Code')) push('RSRCRCAT', { rsrc_id: r.rsrc_id, rsrc_catg_type_id: val(c, 'TypeObjectId'), rsrc_catg_id: val(c, 'ValueObjectId') }); } }
    else if (n.name === 'Calendar') push('CALENDAR', calendarRow(n));
  };
  /** One child of a project into its group's rows; a value it takes from the project (it names no project or WBS of
   *  its own) is noted, so it is put right should the project's ObjectId or WBSObjectId come later in the file. */
  const projectChild = (g: Group, n: XNode) => {
    const { pid, rootId } = g.at!;
    const put = (t: string, r: Row) => g.rows.push([t, r]);
    const or = (r: Row, f: string, kind: 'pid' | 'root') => { if (!r[f]) { r[f] = kind === 'pid' ? pid : rootId; g.fallback.push([r, f, kind]); } };
    if (n.name === 'Calendar') { const c = calendarRow(n); or(c, 'proj_id', 'pid'); put('CALENDAR', c); return; }
    if (n.name === 'WBS') { const w = fromXml(n, WBS_MAP); or(w, 'proj_id', 'pid'); or(w, 'parent_wbs_id', 'root'); w.proj_node_flag = 'N'; put('PROJWBS', w); for (const u of udfRows(n, w.wbs_id, w.proj_id)) put('UDFVALUE', u); return; }
    if (n.name === 'Activity') {
      const a = fromXml(n, ACT_MAP); or(a, 'proj_id', 'pid'); or(a, 'wbs_id', 'root'); put('TASK', a);
      for (const c of kids(n, 'Code')) put('TASKACTV', { task_id: a.task_id, actv_code_type_id: val(c, 'TypeObjectId'), actv_code_id: val(c, 'ValueObjectId'), proj_id: a.proj_id });
      for (const u of udfRows(n, a.task_id, a.proj_id)) put('UDFVALUE', u);
      return;
    }
    const m = projMap.find(([tag]) => tag === n.name);
    if (m) { const r = fromXml(n, m[2]); if (m[1] === 'TASKPROC') { const pc = val(n, 'PercentComplete'); if (pc) r.complete_pct = String(Number(pc) > 1 ? Number(pc) : Math.round(Number(pc) * 1e6) / 1e4); } if (m[1] !== 'ACTVCODE') or(r, 'proj_id', 'pid'); if (m[1] === 'TASKPRED') or(r, 'pred_proj_id', 'pid'); if (m[1] === 'WBSMEMO') or(r, 'wbs_id', 'root'); put(m[1], r); }
  };
  const isProject = (name: string) => name === 'Project' || name === 'BaselineProject';
  const split = (parents: string[], name: string) => (parents.length === 1 && parents[0] === 'APIBusinessObjects' && !isProject(name))
    || (parents.length === 2 && parents[0] === 'APIBusinessObjects' && isProject(parents[1]) && HEAVY.has(name));
  let root: XNode;
  // the open project: the last element under APIBusinessObjects (projects are kept in the tree, their children are not)
  let doc: XNode | null = null;
  try {
    root = parseXml(text, split, (parents, n) => {
      if (parents.length === 1) { top(n); return; }
      const api = doc?.children.find((c) => c.name === 'APIBusinessObjects'), p = api?.children[api.children.length - 1];
      if (!p) return;
      let g = groups.get(p);
      if (!g) { g = { node: p, rows: [], held: [], at: null, fallback: [] }; groups.set(p, g); }
      // the project's own fields come before its children in P6's files: known by its first child (else held to the end)
      if (!g.at && val(p, 'ObjectId')) { const pid = val(p, 'ObjectId'); g.at = { pid, rootId: val(p, 'WBSObjectId') || `${pid}00000` }; }
      if (g.at) projectChild(g, n); else g.held.push(n);
    }, (r) => { doc = r; });
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'XML_PARSE', message: `XML is not well formed: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db, findings };
  }
  const api = root.children.find((c) => c.name === 'APIBusinessObjects');
  if (!api) {
    findings.push({ severity: 'fatal', code: 'XML_ROOT', message: 'Root element is not <APIBusinessObjects>.', p6: 'P6 rejects the file: not a P6 XML export.' });
    return { db, findings };
  }
  const baselineOf = new Map<string, string>(kids(api, 'Project').map((p): [string, string] => [val(p, 'CurrentBaselineProjectObjectId'), val(p, 'ObjectId')]).filter(([b]) => !!b));
  for (const p of [...kids(api, 'Project'), ...kids(api, 'BaselineProject')]) {
    const g = groups.get(p) ?? { node: p, rows: [], held: [], at: null, fallback: [] };
    const pr = fromXml(p, PROJECT_MAP);
    const pid = pr.proj_id || String(rows(db, 'PROJECT').length + 1);
    pr.proj_id = pid;
    // a baseline is kept as a baseline of its project (BaselineProject; OriginalProjectObjectId or the project that points to it)
    if (p.name === 'BaselineProject') { pr._baseline_of = val(p, 'OriginalProjectObjectId') || baselineOf.get(pid) || ''; pr._baseline_date = pr.last_recalc_date ?? ''; }
    push('PROJECT', pr);
    for (const c of kids(p, 'Code')) push('PROJPCAT', { proj_id: pid, proj_catg_type_id: val(c, 'TypeObjectId'), proj_catg_id: val(c, 'ValueObjectId') });
    for (const u of udfRows(p, pid, pid)) push('UDFVALUE', u);
    const sox = child(p, 'ScheduleOptions');
    const so = sox ? schedOptionsRow(sox) : fromXml(p, OLD_SCHED_MAP);
    if (Object.keys(so).length) push('SCHEDOPTIONS', { schedoptions_id: pid, proj_id: pid, ...so });
    const rootId = val(p, 'WBSObjectId') || `${pid}00000`;
    push('PROJWBS', { wbs_id: rootId, proj_id: pid, parent_wbs_id: '', proj_node_flag: 'Y', wbs_short_name: pr.proj_short_name, wbs_name: val(p, 'Name'), seq_num: '0', status_code: 'WS_Open', obs_id: '' });
    // what the children took from the project while it was read, as it is now that all of it is read
    for (const [r, f, kind] of g.fallback) r[f] = kind === 'pid' ? pid : rootId;
    if (g.held.length) { g.at = { pid, rootId }; for (const n of g.held) projectChild(g, n); }
    for (const [t, r] of g.rows) push(t, r);
    groups.delete(p);
  }
  // P6 writes percentages as fractions; files from earlier P6 Clone builds wrote 0-100 (told apart by any value over 1)
  const tasks = rows(db, 'TASK');
  if (!tasks.some((t) => Number(t.phys_complete_pct) > 1)) for (const t of tasks) if (t.phys_complete_pct) t.phys_complete_pct = String(Math.round(Number(t.phys_complete_pct) * 1e6) / 1e4);
  if (!rows(db, 'PROJECT').length) findings.push({ severity: 'fatal', code: 'NO_PROJECT', message: 'The XML file contains no <Project>.', p6: 'P6 finds no project to import.' });
  return { db, findings };
}
