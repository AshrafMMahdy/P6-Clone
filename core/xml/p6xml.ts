// P6 XML (APIBusinessObjects) import/export, mapped onto the same P6 tables the XER layer uses.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { selectRows } from '../xer/write.ts';
import { parseClndrData, serializeClndrData, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, parseP6Date, minutesToSerial, serialToMinutes } from '../dates.ts';

// ---------- minimal XML tree

export interface XNode { name: string; children: XNode[]; text: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parseXml(text: string): XNode {
  const root: XNode = { name: '#root', children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^\w+:/, '');
      if (top.name !== name) throw new Error(`unexpected </${name}> (open <${top.name}>)`);
      stack.pop();
    } else if (m[3]) {
      const n: XNode = { name: m[3].replace(/^\w+:/, ''), children: [], text: '' };
      top.children.push(n);
      if (!m[5]) stack.push(n);
    } else if (m[6] != null) top.text += unesc(m[6]);
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
const TOPIC_MAP: FieldMap = [['ObjectId', 'memo_type_id'], ['Name', 'memo_type'], ['AvailableForActivity', 'task_flag', 'bool']];

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
  const sel = selectRows(db, opts.projIds);
  const get = (t: string) => sel.get(t) ?? [];
  const ns = `http://xmlns.oracle.com/Primavera/P6/V${opts.version ?? '19.12'}/API/BusinessObjects`;
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<APIBusinessObjects xmlns="${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${ns} http://xmlns.oracle.com/Primavera/P6/V${opts.version ?? '19.12'}/API/p6apibo.xsd">`];
  const el = (tag: string, r: Row, map: FieldMap, extra = '') => out.push(`<${tag}>${toXml(r, map)}${extra}</${tag}>`);
  const udfType = new Map(rows(db, 'UDFTYPE').map((u) => [u.udf_type_id, u]));
  const udfsOf = new Map<string, Row[]>();
  for (const u of get('UDFVALUE')) { const k = `${udfType.get(u.udf_type_id)?.table_name}|${u.fk_id}`; udfsOf.set(k, [...(udfsOf.get(k) ?? []), u]); }
  const udfs = (table: string, id: string) => udfsXml(udfsOf.get(`${table}|${id}`) ?? [], udfType);
  const codeType = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c.actv_code_type_id]));
  const codesOf = new Map<string, Row[]>();
  for (const a of get('TASKACTV')) codesOf.set(a.task_id, [...(codesOf.get(a.task_id) ?? []), a]);
  for (const r of get('CURRTYPE')) el('Currency', r, CURR_MAP);
  for (const r of get('OBS')) el('OBS', r, OBS_MAP);
  for (const r of get('ACCOUNT')) el('CostAccount', r, ACCOUNT_MAP);
  for (const r of get('MEMOTYPE')) el('NotebookTopic', r, TOPIC_MAP);
  for (const r of get('UDFTYPE')) el('UDFType', r, UDFTYPE_MAP);
  for (const r of get('ACTVTYPE').filter((x) => !x.proj_id)) el('ActivityCodeType', r, CODETYPE_MAP);
  const globalTypes = new Set(get('ACTVTYPE').filter((x) => !x.proj_id).map((x) => x.actv_code_type_id));
  for (const r of get('ACTVCODE').filter((x) => globalTypes.has(x.actv_code_type_id))) el('ActivityCode', r, CODE_MAP);
  for (const r of get('CALENDAR').filter((x) => !x.proj_id)) out.push(calendarXml(r));
  for (const r of get('ROLES')) el('Role', r, ROLE_MAP);
  for (const r of get('RSRC')) el('Resource', r, RSRC_MAP, udfs('RSRC', r.rsrc_id));
  for (const r of get('RSRCRATE')) el('ResourceRate', r, RATE_MAP);
  const wbsAll = get('PROJWBS');
  for (const p of get('PROJECT')) {
    const pid = p.proj_id;
    const root = wbsAll.find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
    const so = get('SCHEDOPTIONS').find((s) => s.proj_id === pid) ?? {};
    let body = toXml(p, PROJECT_MAP) + `<Name>${esc(root?.wbs_name || p._name || p.proj_short_name)}</Name>` + udfs('PROJECT', pid) + schedOptionsXml(so);
    if (root?.wbs_id) body += `<WBSObjectId>${esc(root.wbs_id)}</WBSObjectId>`;
    out.push(`<Project>${body}`);
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
    out.push('</Project>');
  }
  out.push('</APIBusinessObjects>');
  return out.join('\n') + '\n';
}

// ---------- parser

export function parseP6Xml(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  let root: XNode;
  try {
    root = parseXml(text);
  } catch (e) {
    findings.push({ severity: 'fatal', code: 'XML_PARSE', message: `XML is not well formed: ${(e as Error).message}.`, p6: 'P6 rejects the file.' });
    return { db, findings };
  }
  const api = root.children.find((c) => c.name === 'APIBusinessObjects');
  if (!api) {
    findings.push({ severity: 'fatal', code: 'XML_ROOT', message: 'Root element is not <APIBusinessObjects>.', p6: 'P6 rejects the file: not a P6 XML export.' });
    return { db, findings };
  }
  const push = (t: string, r: Row) => { const T = table(db, t); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };
  const topMap: [string, string, FieldMap][] = [['Currency', 'CURRTYPE', CURR_MAP], ['OBS', 'OBS', OBS_MAP], ['CostAccount', 'ACCOUNT', ACCOUNT_MAP], ['NotebookTopic', 'MEMOTYPE', TOPIC_MAP],
    ['UDFType', 'UDFTYPE', UDFTYPE_MAP], ['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Role', 'ROLES', ROLE_MAP], ['Resource', 'RSRC', RSRC_MAP], ['ResourceRate', 'RSRCRATE', RATE_MAP]];
  for (const n of api.children) {
    const m = topMap.find(([tag]) => tag === n.name);
    if (m) { const r = fromXml(n, m[2]); push(m[1], r); if (n.name === 'Resource') for (const u of udfRows(n, r.rsrc_id, '')) push('UDFVALUE', u); }
    else if (n.name === 'Calendar') push('CALENDAR', calendarRow(n));
  }
  const projMap: [string, string, FieldMap][] = [['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Relationship', 'TASKPRED', REL_MAP], ['ResourceAssignment', 'TASKRSRC', ASSIGN_MAP],
    ['ActivityExpense', 'PROJCOST', EXP_MAP], ['ActivityCodeAssignment', 'TASKACTV', CODEASSIGN_MAP], ['ActivityNote', 'TASKMEMO', MEMO_MAP], ['UDFValue', 'UDFVALUE', UDFVAL_MAP]];
  for (const p of kids(api, 'Project')) {
    const pr = fromXml(p, PROJECT_MAP);
    const pid = pr.proj_id || String(rows(db, 'PROJECT').length + 1);
    pr.proj_id = pid;
    push('PROJECT', pr);
    for (const u of udfRows(p, pid, pid)) push('UDFVALUE', u);
    const sox = child(p, 'ScheduleOptions');
    const so = sox ? schedOptionsRow(sox) : fromXml(p, OLD_SCHED_MAP);
    if (Object.keys(so).length) push('SCHEDOPTIONS', { schedoptions_id: pid, proj_id: pid, ...so });
    const rootId = val(p, 'WBSObjectId') || `${pid}00000`;
    push('PROJWBS', { wbs_id: rootId, proj_id: pid, parent_wbs_id: '', proj_node_flag: 'Y', wbs_short_name: pr.proj_short_name, wbs_name: val(p, 'Name'), seq_num: '0', status_code: 'WS_Open', obs_id: '' });
    for (const n of p.children) {
      if (n.name === 'Calendar') { const c = calendarRow(n); c.proj_id ||= pid; push('CALENDAR', c); continue; }
      if (n.name === 'WBS') { const w = fromXml(n, WBS_MAP); w.proj_id ||= pid; w.parent_wbs_id ||= rootId; w.proj_node_flag = 'N'; push('PROJWBS', w); for (const u of udfRows(n, w.wbs_id, w.proj_id)) push('UDFVALUE', u); continue; }
      if (n.name === 'Activity') {
        const a = fromXml(n, ACT_MAP); a.proj_id ||= pid; a.wbs_id ||= rootId; push('TASK', a);
        for (const c of kids(n, 'Code')) push('TASKACTV', { task_id: a.task_id, actv_code_type_id: val(c, 'TypeObjectId'), actv_code_id: val(c, 'ValueObjectId'), proj_id: a.proj_id });
        for (const u of udfRows(n, a.task_id, a.proj_id)) push('UDFVALUE', u);
        continue;
      }
      const m = projMap.find(([tag]) => tag === n.name);
      if (m) { const r = fromXml(n, m[2]); if (m[1] !== 'ACTVCODE') r.proj_id ||= pid; if (m[1] === 'TASKPRED') { r.pred_proj_id ||= pid; } if (m[1] === 'ACTVTYPE') r.proj_id ||= pid; push(m[1], r); }
    }
  }
  // P6 writes percentages as fractions; files from earlier P6 Clone builds wrote 0-100 (told apart by any value over 1)
  const tasks = rows(db, 'TASK');
  if (!tasks.some((t) => Number(t.phys_complete_pct) > 1)) for (const t of tasks) if (t.phys_complete_pct) t.phys_complete_pct = String(Math.round(Number(t.phys_complete_pct) * 1e6) / 1e4);
  if (!rows(db, 'PROJECT').length) findings.push({ severity: 'fatal', code: 'NO_PROJECT', message: 'The XML file contains no <Project>.', p6: 'P6 finds no project to import.' });
  return { db, findings };
}
