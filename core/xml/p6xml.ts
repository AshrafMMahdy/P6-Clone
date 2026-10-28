// P6 XML (APIBusinessObjects) import/export, mapped onto the same P6 tables the XER layer uses.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { selectRows } from '../xer/write.ts';
import SCHEMA_NAMES from './p6apibo-names.json' with { type: 'json' };
import { parseClndrDataLeniently, parseClndrData, serializeClndrData, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, parseP6Date, minutesToSerial, serialToMinutes } from '../dates.ts';

// ---------- minimal XML tree

/** s / e: where the element starts and ends in the parsed text (to keep an element verbatim). */
/** clone: what a <!--p6clone field=CODE--> comment inside the element says (the XER code a text P6 shares between codes came from). */
export interface XNode { name: string; children: XNode[]; text: string; s?: number; e?: number; clone?: Record<string, string> }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The document tree. With `split`, an element split(parents, name) names (parents: the open elements' names, outside
 *  in) is handed to `emit` as soon as it closes and is not kept in the tree: a big document is held one element at a
 *  time, never whole (elements inside a split one are not split again). */
/** A string of its own: a value cut from a big document would otherwise keep the whole document alive (V8 keeps a
 *  piece of 13 characters or more as a view of the string it was cut from). */
const own = (s: string) => (s.length < 13 ? s : (s + ' ').slice(0, -1));
/** Text held in pieces: a document larger than one string can be (about 512 MB) is read as a list of strings. slice(s, e) cuts by position in the whole. */
export class Chunked {
  readonly chunks: string[] = [];
  private starts: number[] = [];
  length = 0;
  push(piece: string): void { if (!piece) return; this.starts.push(this.length); this.chunks.push(piece); this.length += piece.length; }
  slice(s = 0, e = this.length): string {
    if (e <= s) return '';
    let lo = 0, hi = this.chunks.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.starts[m] <= s) lo = m; else hi = m - 1; } // the piece s is in
    let out = '';
    for (let k = lo; k < this.chunks.length && this.starts[k] < e; k++) out += this.chunks[k].slice(Math.max(0, s - this.starts[k]), e - this.starts[k]);
    return out;
  }
}
/** Where an unfinished construct starts at the end of what has been read so far (a tag, comment, CDATA or declaration whose end has not come yet), else -1. */
const unfinishedAt = (buf: string, from: number): number => {
  const i = buf.indexOf('<', from);
  if (i < 0) return -1;
  if (/^<(?:!\[CDATA\[|!--|\?|!DOCTYPE)/.test(buf.slice(i, i + 10))) return i; // (its end would have matched)
  return buf.indexOf('<', i + 1) < 0 ? i : -1; // a tag has no "<" in it: this is the last one
};
export function parseXml(text: string | Chunked, split?: (parents: string[], name: string) => boolean, emit?: (parents: string[], n: XNode) => void, onRoot?: (root: XNode) => void): XNode {
  const root: XNode = { name: '#root', children: [], text: '' };
  onRoot?.(root);
  const stack = [root];
  const names: string[] = []; // the open elements' names (root excluded)
  let inSplit = 0; // stack depth of the open split element (0: none)
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  // a document in pieces is read piece by piece: what the last piece left unfinished (a tag cut in two, half an entity) goes in front of the next
  const pieces = typeof text === 'string' ? [text] : text.chunks;
  let carry = '', offset = 0; // offset: the position, in the whole document, of carry's first character
  for (let k = 0; k < pieces.length; k++) {
    const last = k === pieces.length - 1, buf = carry + pieces[k], base = offset;
    let used = buf.length, prev = 0;
    re.lastIndex = 0;
    while ((m = re.exec(buf))) {
      if (!last && m.index > prev) { const u = unfinishedAt(buf, prev); if (u >= 0) { used = u; break; } }
      prev = re.lastIndex;
      const top = stack[stack.length - 1];
      if (m[0].startsWith('<!--p6clone ')) { for (const kv of m[0].slice(12, -3).trim().split(/\s+/)) { const i = kv.indexOf('='); if (i > 0) (top.clone ??= {})[kv.slice(0, i)] = kv.slice(i + 1); } continue; }
      if (m[1] != null) top.text += m[1];
      else if (m[2]) {
        const name = m[2].replace(/^\w+:/, '');
        if (top.name !== name) throw new Error(`unexpected </${name}> (open <${top.name}>)`);
        top.e = base + re.lastIndex;
        stack.pop(); names.pop();
        if (inSplit && stack.length === inSplit - 1) { inSplit = 0; emit!(names, top); }
      } else if (m[3]) {
        const n: XNode = { name: m[3].replace(/^\w+:/, ''), children: [], text: '', s: base + m.index };
        const cut = !inSplit && !!split?.(names, n.name);
        if (!cut) top.children.push(n);
        if (!m[5]) { stack.push(n); names.push(n.name); if (cut) inSplit = stack.length; }
        else { n.e = base + re.lastIndex; if (cut) emit!(names, n); }
      } else if (m[6] != null) {
        let t = m[6];
        // (an entity cut in two at the end of a piece waits for its other half)
        if (!last && re.lastIndex === buf.length) { const a = t.lastIndexOf('&'); if (a >= 0 && a > t.length - 12 && !t.includes(';', a)) { t = t.slice(0, a); used = buf.length - (m[6].length - a); prev = used; } }
        if (!split) top.text += unesc(t); else if (inSplit || /\S/.test(t)) top.text += own(unesc(t)); // (the whitespace between kept elements is not kept)
      }
    }
    if (!last && used === buf.length && prev < buf.length) { const u = unfinishedAt(buf, prev); if (u >= 0) used = u; }
    carry = buf.slice(used); offset = base + used;
  }
  if (stack.length > 1) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

const child = (n: XNode, name: string) => n.children.find((c) => c.name === name);
const kids = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
const val = (n: XNode, name: string) => child(n, name)?.text.trim() ?? '';

// ---------- field maps (XML tag <-> XER field)

/** legacy: a name earlier clones wrote, still read, never written. strict:<list>: only the codes whose P6 text is verified (the jar's helpers) are written, every other code is left out
 *  (an unverified text could make P6 refuse the file). color: the XER's RRGGBB is "#RRGGBB" in XML. pct: the XER's percent is a fraction in XML (6 -> 0.06). */
type Conv = 'str' | 'date' | 'num' | 'bool' | 'legacy' | 'color' | 'pct' | `enum:${string}` | `strict:${string}`;
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
  wbs_status: { WS_Planned: 'Planned', WS_Open: 'Active', WS_Closed: 'Inactive', WS_Whatif: 'What-If', WBS_Active: 'Active' }, // (WBS_Active: paired by name against Oracle's list, see below; written by other tools)
  udf_table: { TASK: 'Activity', PROJWBS: 'WBS', PROJECT: 'Project', RSRC: 'Resource', TASKRSRC: 'Resource Assignment', PROJCOST: 'Activity Expense', TASKPROC: 'Activity Step' },
  rate_type: { COST_PER_QTY: 'Price / Unit', COST_PER_QTY2: 'Price / Unit 2', COST_PER_QTY3: 'Price / Unit 3', COST_PER_QTY4: 'Price / Unit 4', COST_PER_QTY5: 'Price / Unit 5' },
  skill_level: { '1': '1 - Master', '2': '2 - Expert', '3': '3 - Skilled', '4': '4 - Proficient', '5': '5 - Inexperienced' },
  cost_load_type: { CL_Uniform: 'Uniform Over Activity', CL_End: 'End of Activity', CL_Start: 'Start of Activity' },
  rate_source: { ST_Rsrc: 'Resource', ST_Role: 'Role', ST_Custom: 'Override' },
  // Paired by name against Oracle's own lists of the P6 XML texts (the XER code names the text, one to one; read 2026-10-28, codes as they occur in all samples and the pilot file):
  //  Activity ReviewStatus 'OK'|'For Review'|'Rejected'                    https://docs.oracle.com/cd/F51301_01/English/Integration_Documentation/business_object_events_reference/business_object_events_reference.pdf (ActivityType)
  //  ProjectIssue Status 'Open'|'On Hold'|'Closed'                          same pdf (ProjectIssueType)
  //  ProjectThreshold Status 'Enabled'|'Disabled', DetailToMonitor 'Activity'|'WBS'   https://docs.oracle.com/cd/F88966_01/English/Integration_Documentation/p6_eppm_web_services_reference/42401.htm
  //  WBS EarnedValueETCComputeType 'ETC = Remaining Cost for Activity'|'PF = 1'|'PF = Custom Value'|'PF = 1 / CPI'|'PF = 1 / (CPI * SPI)'   https://docs.oracle.com/cd/F88966_01/English/Integration_Documentation/business_object_events_reference/34274.htm
  // Only the codes the data shows are paired. Two codes for one text (EE_Rem_hr and EE_Rem; WS_Open and WBS_Active) both write that text; the first listed is what the text reads back as, and the
  // other is kept in a <!--p6clone field=CODE--> comment beside it (P6 ignores comments; this clone reads it), so a clone round trip is exact. TM_Task <-> 'Activity' is paired by elimination (TM_WBS <-> 'WBS').
  review_type: { RV_OK: 'OK' }, issue_status: { IS_Open: 'Open' }, thresh_status: { TS_Enable: 'Enabled' }, thresh_type: { TM_WBS: 'WBS', TM_Task: 'Activity' },
  ev_etc: { EE_Rem_hr: 'ETC = Remaining Cost for Activity', EE_Rem: 'ETC = Remaining Cost for Activity', EE_PF_1: 'PF = 1', EE_PF_cpi: 'PF = 1 / CPI' },
  // MPXJ writes this level-priority default as 'priority_type,ASC_BY_FIELD/ASC' in its XER (PrimaveraXERFileWriter, column LevelPriorityList) and as '(0||priority_type(sort_type|ASC)())' in its P6 XML
  // (XmlProjectWriter, ScheduleOptions/PriorityList); both read back into the same MPXJ property. Older XERs write 'priority_type,ASC': a different syntax, not paired.
  level_priority: { 'priority_type,ASC_BY_FIELD/ASC': '(0||priority_type(sort_type|ASC)())' },
  // the strict lists: one pair each, the only one MPXJ's XML writer and XER writer agree on (both write P6's default)
  qty_type: { QT_Hour: 'Hour' }, sum_level: { SL_Taskrsrc: 'Assignment Level' }, ev_compute: { EC_Cmp_pct: 'Activity Percent Complete' }, discount_period: { PD_Month: 'Month' },
  // (UdfHelper: the only types MPXJ knows; FT_FLOAT and FT_FLOAT_2_DECIMALS are both "Double", the second is what a "Double" reads back as)
  udf_data_type: { FT_TEXT: 'Text', FT_START_DATE: 'Start Date', FT_END_DATE: 'Finish Date', FT_FLOAT_2_DECIMALS: 'Double', FT_FLOAT: 'Double', FT_INT: 'Integer', FT_MONEY: 'Cost', FT_STATICTYPE: 'Indicator' },
  code_scope: { AS_Global: 'Global', AS_EPS: 'EPS', AS_Project: 'Project' },
  lag_calendar: { rcal_Predecessor: 'Predecessor Activity Calendar', rcal_Successor: 'Successor Activity Calendar', rcal_ProjDefault: 'Project Default Calendar', rcal_24Hour: '24 Hour Calendar' },
  float_type: { FT_FF: 'Finish Float = Late Finish - Early Finish', FT_SS: 'Start Float = Late Start - Early Start', FT_Min: 'Smallest of Start Float and Finish Float', FT_Smallest: 'Smallest of Start Float and Finish Float' },
};

export const P6XML_ENUMS = ENUMS;
const PROJECT_MAP: FieldMap = [['ObjectId', 'proj_id'], ['Id', 'proj_short_name'], ['PlannedStartDate', 'plan_start_date', 'date'], ['MustFinishByDate', 'plan_end_date', 'date'],
  ['DataDate', 'last_recalc_date', 'date'], ['ScheduledFinishDate', 'scd_end_date', 'date'], ['ActivityDefaultCalendarObjectId', 'clndr_id'], ['DefaultCalendarObjectId', 'clndr_id', 'legacy'], ['CriticalActivityFloatLimit', 'critical_drtn_hr_cnt', 'num'],
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
  ['ComputeTotalFloatType', 'sched_float_type', 'enum:float_type'], ['PriorityList', 'LevelPriorityList', 'strict:level_priority']];
const LOGIC: [label: string, retained: string, override: string][] = [['Retained Logic', 'Y', 'N'], ['Progress Override', 'N', 'Y'], ['Actual Dates', 'N', 'N']];
function schedOptionsXml(so: Row): string {
  if (!Object.keys(so).length) return '';
  const logic = so.sched_retained_logic === 'Y' ? LOGIC[0] : so.sched_progress_override === 'Y' ? LOGIC[1] : so.sched_retained_logic || so.sched_progress_override ? LOGIC[2] : null;
  return `<ScheduleOptions>${inOrder('ScheduleOptions', [...toParts(so, SCHED_MAP), ...(logic ? [['OutOfSequenceScheduleType', `<OutOfSequenceScheduleType>${logic[0]}</OutOfSequenceScheduleType>`] as Part] : [])])}</ScheduleOptions>`;
}
function schedOptionsRow(n: XNode): Row {
  const r = fromXml(n, SCHED_MAP, ['OutOfSequenceScheduleType']);
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
  ['ParentObjectId', 'parent_rsrc_id'], ['DefaultUnitsPerTime', 'def_qty_per_hr', 'num'], ['MaxUnitsPerTime', 'max_qty_per_hr', 'num'], ['UnitOfMeasureObjectId', 'unit_id'], ['CurrencyObjectId', 'curr_id'], ['SequenceNumber', 'rsrc_seq_num', 'num'], ['IsOverTimeAllowed', 'ot_flag', 'bool'], ['UseTimesheets', 'timesheet_flag', 'bool'], ['AutoComputeActuals', 'auto_compute_act_flag', 'bool'], ['EmployeeId', 'employee_code'], ['EmailAddress', 'email_addr'], ['Title', 'rsrc_title_name'], ['IsActive', 'active_flag', 'bool'], ['GUID', 'guid']];
const RATE_MAP: FieldMap = [['ObjectId', 'rsrc_rate_id'], ['ResourceObjectId', 'rsrc_id'], ['EffectiveDate', 'start_date', 'date'], ['MaxUnitsPerTime', 'max_qty_per_hr', 'num'], ['PricePerUnit', 'cost_per_qty', 'num']];
const ASSIGN_MAP: FieldMap = [['ObjectId', 'taskrsrc_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['ResourceObjectId', 'rsrc_id'], ['RoleObjectId', 'role_id'], ['CostAccountObjectId', 'acct_id'],
  ['PlannedUnits', 'target_qty', 'num'], ['ActualRegularUnits', 'act_reg_qty', 'num'], ['ActualOvertimeUnits', 'act_ot_qty', 'num'], ['RemainingUnits', 'remain_qty', 'num'],
  ['PlannedUnitsPerTime', 'target_qty_per_hr', 'num'], ['RemainingUnitsPerTime', 'remain_qty_per_hr', 'num'], ['PricePerUnit', 'cost_per_qty', 'num'], ['PlannedCost', 'target_cost', 'num'],
  ['ActualRegularCost', 'act_reg_cost', 'num'], ['ActualOvertimeCost', 'act_ot_cost', 'num'], ['RemainingCost', 'remain_cost', 'num'],
  ['ActualStartDate', 'act_start_date', 'date'], ['ActualFinishDate', 'act_end_date', 'date'], ['PlannedStartDate', 'target_start_date', 'date'], ['PlannedFinishDate', 'target_end_date', 'date'],
  ['RemainingStartDate', 'restart_date', 'date'], ['RemainingFinishDate', 'reend_date', 'date'], ['RateType', 'rate_type', 'enum:rate_type'], ['ResourceType', 'rsrc_type', 'enum:rsrc_type'], ['ResourceCurveObjectId', 'curv_id']];
const EXP_MAP: FieldMap = [['ObjectId', 'cost_item_id'], ['ActivityObjectId', 'task_id'], ['ProjectObjectId', 'proj_id'], ['CostAccountObjectId', 'acct_id'], ['ExpenseItem', 'cost_name'],
  ['PlannedCost', 'target_cost', 'num'], ['ActualCost', 'act_cost', 'num'], ['RemainingCost', 'remain_cost', 'num'], ['Vendor', 'vendor_name'], ['DocumentNumber', 'po_number'], ['ExpenseCategoryObjectId', 'cost_type_id']];
/** Units of measure, expense categories, resource curves and the links between resources and roles (the dictionaries the activity expenses, resources and assignments point at). */
const UOM_MAP: FieldMap = [['ObjectId', 'unit_id'], ['Abbreviation', 'unit_abbrev'], ['Name', 'unit_name'], ['SequenceNumber', 'seq_num', 'num']];
const EXPCAT_MAP: FieldMap = [['ObjectId', 'cost_type_id'], ['Name', 'cost_type'], ['SequenceNumber', 'seq_num', 'num']];
const CURVE_MAP: FieldMap = [['ObjectId', 'curv_id'], ['Name', 'curv_name'], ['IsDefault', 'default_flag', 'bool']];
/** A resource curve's 21 points (pct_usage_0..20) are <Values><Value0/><Value5/>...<Value100/></Values> in P6's XML. */
const curveValuesXml = (r: Row) => `<Values>${Array.from({ length: 21 }, (_, i) => (r[`pct_usage_${i}`] ? `<Value${i * 5}>${esc(r[`pct_usage_${i}`])}</Value${i * 5}>` : '')).join('')}</Values>`;
const curveValuesRead = (n: XNode, r: Row) => { const v = child(n, 'Values'); for (let i = 0; i < 21; i++) { const x = v ? val(v, `Value${i * 5}`) : ''; r[`pct_usage_${i}`] = x; } };
const RSRCROLE_MAP: FieldMap = [['ResourceObjectId', 'rsrc_id'], ['ResourceId', 'rsrc_short_name'], ['ResourceName', 'rsrc_name'], ['RoleObjectId', 'role_id'], ['RoleId', 'role_short_name'], ['RoleName', 'role_name'], ['Proficiency', 'skill_level', 'enum:skill_level']];
const CODETYPE_MAP: FieldMap = [['ObjectId', 'actv_code_type_id'], ['Name', 'actv_code_type'], ['Scope', 'actv_code_type_scope', 'enum:code_scope'], ['ProjectObjectId', 'proj_id'], ['Length', 'actv_short_len', 'num'], ['SequenceNumber', 'seq_num', 'num']];
const CODE_MAP: FieldMap = [['ObjectId', 'actv_code_id'], ['CodeTypeObjectId', 'actv_code_type_id'], ['ParentObjectId', 'parent_actv_code_id'], ['CodeValue', 'short_name'], ['Description', 'actv_code_name'], ['SequenceNumber', 'seq_num', 'num']];
const CODEASSIGN_MAP: FieldMap = [['ActivityObjectId', 'task_id'], ['ActivityCodeTypeObjectId', 'actv_code_type_id'], ['ActivityCodeObjectId', 'actv_code_id'], ['ProjectObjectId', 'proj_id']];
const ACCOUNT_MAP: FieldMap = [['ObjectId', 'acct_id'], ['ParentObjectId', 'parent_acct_id'], ['Id', 'acct_short_name'], ['Name', 'acct_name'], ['SequenceNumber', 'acct_seq_num', 'num']];
const OBS_MAP: FieldMap = [['ObjectId', 'obs_id'], ['ParentObjectId', 'parent_obs_id'], ['Name', 'obs_name'], ['SequenceNumber', 'seq_num', 'num']];
const UDFTYPE_MAP: FieldMap = [['ObjectId', 'udf_type_id'], ['SubjectArea', 'table_name', 'enum:udf_table'], ['Title', 'udf_type_label'], ['DataType', 'logical_data_type', 'enum:udf_data_type']];
const UDFVAL_MAP: FieldMap = [['UDFTypeObjectId', 'udf_type_id'], ['UDFCodeObjectId', 'udf_code_id'], ['TypeObjectId', 'udf_type_id', 'legacy'], ['ForeignObjectId', 'fk_id'], ['ProjectObjectId', 'proj_id'], ['Text', 'udf_text'], ['Double', 'udf_number', 'num'], ['StartDate', 'udf_date', 'date']];
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

/** The children of each P6 XML element type, in the order P6's schema (p6apibo.xsd, as MPXJ embeds it) lists them: an xsd:sequence, so the writer puts them in that order. */
const SEQUENCE = new Map<string, Map<string, number>>();
const seqOf = (type: string): Map<string, number> => {
  let m = SEQUENCE.get(type);
  if (!m) SEQUENCE.set(type, (m = new Map(((SCHEMA_NAMES as Record<string, string[]>)[type] ?? []).map((n, i) => [n, i]))));
  return m;
};
/** A child element as [its tag, its XML]. */
type Part = [tag: string, xml: string];
/** The parts of an element of `type` in the schema's order (a tag the schema does not have goes last, in the order given; same-tag parts keep theirs). */
const inOrder = (type: string, parts: Part[]): string => {
  const q = seqOf(type);
  return parts.map((x, i) => [x, i] as const).filter(([x]) => x[1] !== '').sort((a, b) => ((q.get(a[0][0]) ?? 1e9) - (q.get(b[0][0]) ?? 1e9)) || a[1] - b[1]).map(([x]) => x[1]).join('');
};
/** The enum / strict value P6 XML has a verified text for, else null (the field is then left out: never the raw XER code). */
const enumText = (list: string, v: string): string | null => ENUMS[list]?.[v] ?? null;

function toParts(r: Row, map: FieldMap): Part[] {
  const out: Part[] = [];
  for (const [tag, field, conv] of map) {
    let v = r[field];
    if (v == null || v === '' || conv === 'legacy') continue;
    if (conv === 'date') v = xmlDate(v);
    else if (conv === 'bool') v = v === 'Y' ? 'true' : 'false';
    else if (conv?.startsWith('enum:') || conv?.startsWith('strict:')) { const t = enumText(conv.slice(conv.indexOf(':') + 1), v); if (t == null) continue; v = t; }
    else if (conv === 'color') v = v.startsWith('#') ? v : `#${v}`;
    else if (conv === 'pct') v = Number.isFinite(Number(v)) ? String(Number(v) / 100) : v;
    if (field === 'sched_outer_depend_type') v = v === 'SD_None' ? 'true' : 'false';
    if (v) out.push([tag, `<${tag}>${esc(v)}</${tag}>`]);
    if (conv?.startsWith('enum:') || conv?.startsWith('strict:')) { // a code that shares its text with an earlier one: kept beside it
      const list = ENUMS[conv.slice(conv.indexOf(':') + 1)], code = r[field];
      if (v && list?.[code] === v && Object.keys(list).find((k) => list[k] === v) !== code && /^\w+$/.test(code)) out.push(['#clone', `<!--p6clone ${field}=${code}-->`]);
    }
  }
  return out;
}
function toXml(r: Row, map: FieldMap): string {
  return toParts(r, map).map((x) => x[1]).join('');
}


// ---- the rest of what an XER holds, in the elements and fields P6's own XML schema (p6apibo.xsd, as MPXJ embeds it) has for it. Only fields whose P6 XML
// field is certain are here; the others are listed in P6XML_NOT_CARRIED with why.
const F = (tag: string, field: string, conv?: Conv): [string, string, Conv?] => (conv ? [tag, field, conv] : [tag, field]);
const AUDIT_DATES: FieldMap = [F('CreateDate', 'create_date', 'date'), F('CreateUser', 'create_user'), F('LastUpdateDate', 'update_date', 'date'), F('LastUpdateUser', 'update_user')];
ACT_MAP.push(F('ReviewStatus', 'review_type', 'enum:review_type'), F('ActualNonLaborUnits', 'act_equip_qty', 'num'), F('ActualThisPeriodNonLaborUnits', 'act_this_per_equip_qty', 'num'), F('ActualThisPeriodLaborUnits', 'act_this_per_work_qty', 'num'), F('ActualLaborUnits', 'act_work_qty', 'num'),
  F('AutoComputeActuals', 'auto_compute_act_flag', 'bool'), F('EstimatedWeight', 'est_wt', 'num'), F('FloatPath', 'float_path', 'num'), F('FloatPathOrder', 'float_path_order', 'num'), F('RemainingNonLaborUnits', 'remain_equip_qty', 'num'),
  F('RemainingLaborUnits', 'remain_work_qty', 'num'), F('PlannedNonLaborUnits', 'target_equip_qty', 'num'), F('PlannedLaborUnits', 'target_work_qty', 'num'), F('LocationObjectId', 'location_id'), F('ReviewFinishDate', 'review_end_date', 'date'), ...AUDIT_DATES);
WBS_MAP.push(F('EstimatedWeight', 'est_wt', 'num'), F('ContainsSummaryData', 'sum_data_flag', 'bool'), F('EarnedValueUserPercent', 'ev_user_pct', 'pct'), F('EarnedValueETCUserValue', 'ev_etc_user_value', 'num'), F('EarnedValueComputeType', 'ev_compute_type', 'strict:ev_compute'), F('EarnedValueETCComputeType', 'ev_etc_compute_type', 'enum:ev_etc'), F('OriginalBudget', 'orig_cost', 'num'),
  F('IndependentETCTotalCost', 'indep_remain_total_cost', 'num'), F('IndependentETCLaborUnits', 'indep_remain_work_qty', 'num'), F('AnticipatedStartDate', 'anticip_start_date', 'date'), F('AnticipatedFinishDate', 'anticip_end_date', 'date'), F('WBSCategoryObjectId', 'phase_id'));
RSRC_MAP.push(F('PrimaryRoleObjectId', 'role_id'), F('OfficePhone', 'office_phone'), F('OtherPhone', 'other_phone'), F('OvertimeFactor', 'ot_factor', 'num'), F('ResourceNotes', 'rsrc_notes'), F('CalculateCostFromUnits', 'def_cost_qty_link_flag', 'bool'),
  F('LocationObjectId', 'location_id'), F('ShiftObjectId', 'shift_id'), F('UserObjectId', 'user_id'), F('TimesheetApprovalManagerObjectId', 'ts_approve_user_id'));
RATE_MAP.push(F('PricePerUnit2', 'cost_per_qty2', 'num'), F('PricePerUnit3', 'cost_per_qty3', 'num'), F('PricePerUnit4', 'cost_per_qty4', 'num'), F('PricePerUnit5', 'cost_per_qty5', 'num'), F('ShiftPeriodObjectId', 'shift_period_id'));
ASSIGN_MAP.push(F('IsCostUnitsLinked', 'cost_qty_link_flag', 'bool'), F('Proficiency', 'skill_level', 'enum:skill_level'), F('PendingRemainingUnits', 'pend_remain_qty', 'num'),
  F('PlannedLag', 'target_lag_drtn_hr_cnt', 'num'), F('RemainingLag', 'relag_drtn_hr_cnt', 'num'), F('OvertimeFactor', 'ot_factor', 'num'), F('RemainingLateStartDate', 'rem_late_start_date', 'date'), F('RemainingLateFinishDate', 'rem_late_end_date', 'date'),
  F('DrivingActivityDatesFlag', 'rollup_dates_flag', 'bool'), F('GUID', 'guid'), F('ActualThisPeriodCost', 'act_this_per_cost', 'num'), F('ActualThisPeriodUnits', 'act_this_per_qty', 'num'), F('RateSource', 'cost_per_qty_source_type', 'enum:rate_source'),
  F('PlannedCurve', 'target_crv'), F('RemainingCurve', 'remain_crv'), F('ActualCurve', 'actual_crv'), // (the same encoding as the XER's: one helper in MPXJ writes both)
  F('PendingActualRegularUnits', 'pend_act_reg_qty', 'num'), F('PendingActualOvertimeUnits', 'pend_act_ot_qty', 'num'), F('IsOvertimeAllowed', 'ot_flag', 'bool'), F('PlannedDuration', 'target_drtn_hr_cnt', 'num'),
  F('CreateDate', 'create_date', 'date'), F('CreateUser', 'create_user'));
EXP_MAP.push(F('PricePerUnit', 'cost_per_qty', 'num'), F('PlannedUnits', 'target_qty', 'num'), F('AutoComputeActuals', 'auto_compute_act_flag', 'bool'), F('UnitOfMeasure', 'qty_name'), F('ExpenseDescription', 'cost_descr'), F('AccrualType', 'cost_load_type', 'enum:cost_load_type'));
ROLE_MAP.push(F('SequenceNumber', 'seq_num', 'num'), F('Responsibilities', 'role_descr'), F('CalculateCostFromUnits', 'def_cost_qty_link_flag', 'bool'));
ACCOUNT_MAP.push(F('Description', 'acct_descr'));
CODE_MAP.push(F('Color', 'color', 'color'));
REL_MAP.push(F('Aref', 'aref', 'date'), F('Arls', 'arls', 'date'), F('Comments', 'comments'));
OBS_MAP.push(F('Description', 'obs_descr'), F('GUID', 'guid'));
PCODETYPE_MAP.push(F('Weight', 'proj_catg_type_wt', 'num'), F('MaxCodeValueWeight', 'max_proj_catg_wt', 'num'));
PCODE_MAP.push(F('Weight', 'proj_catg_wt', 'num'));
CODE_MAP.push(F('ProjectObjectId', 'proj_id'));
CURR_MAP.push(F('DecimalSymbol', 'decimal_symbol'), F('DigitGroupingSymbol', 'digit_group_symbol'), F('PositiveSymbol', 'pos_curr_fmt_type'), F('NegativeSymbol', 'neg_curr_fmt_type'));
PROJECT_MAP.push(F('FiscalYearStartMonth', 'fy_start_month_num', 'num'), F('ActivityDefaultCostAccountObjectId', 'acct_id'), F('SourceProjectObjectId', 'source_proj_id'), F('AddedBy', 'add_by_name'), F('DateAdded', 'add_date', 'date'),
  F('WebSiteRootDirectory', 'web_local_root_path'), F('WebSiteURL', 'proj_url'), F('ExternalCRKey', 'cr_external_key'), F('ActivityIdBasedOnSelectedActivity', 'task_code_prefix_flag', 'bool'), F('AddActualToRemaining', 'add_act_remain_flag', 'bool'),
  F('LinkActualToActualThisPeriod', 'act_this_per_link_flag', 'bool'), F('LinkPercentCompleteWithActual', 'act_pct_link_flag', 'bool'), F('UseProjectBaselineForEarnedValue', 'use_project_baseline_flag', 'bool'),
  F('LinkPlannedAndAtCompletionFlag', 'rem_target_link_flag', 'bool'), F('ResetPlannedToRemainingFlag', 'reset_planned_flag', 'bool'), F('AllowNegativeActualUnitsFlag', 'allow_neg_act_flag', 'bool'), F('CostQuantityRecalculateFlag', 'cost_qty_recalc_flag', 'bool'),
  F('ActivityDefaultPricePerUnit', 'def_cost_per_qty', 'num'), F('LastFinancialPeriodObjectId', 'last_fin_dates_id'), F('LocationObjectId', 'location_id'), F('FinancialPeriodTemplateId', 'fintmpl_id'), F('CheckOutDate', 'checkout_date', 'date'),
  F('CheckOutUserObjectId', 'checkout_user_id'), F('LastApplyActualsDate', 'apply_actuals_date', 'date'), F('LastScheduleDate', 'last_schedule_date', 'date'), F('ProjectForecastStartDate', 'fcst_start_date', 'date'), F('StrategicPriority', 'strgy_priority_num', 'num'),
  F('SummarizeToWBSLevel', 'wbs_max_sum_level', 'num'), F('SummarizedDataDate', 'sum_data_date', 'date'), F('LastSummarizedDate', 'last_tasksum_date', 'date'), F('ContainsSummaryData', 'sum_data_flag', 'bool'),
  F('ResourceCanBeAssignedToSameActivityMoreThanOnce', 'rsrc_multi_assign_flag', 'bool'), F('ResourcesCanAssignThemselvesToActivities', 'rsrc_self_add_flag', 'bool'), F('ResourcesCanViewInactiveActivities', 'ts_rsrc_vw_inact_actv_flag', 'bool'),
  F('EnableSummarization', 'batch_sum_flag', 'bool'), F('ResourcesCanMarkAssignmentAsCompleted', 'allow_complete_flag', 'bool'), F('AssignmentDefaultDrivingFlag', 'def_rollup_dates_flag', 'bool'), F('WBSCodeSeparator', 'name_sep_char'), F('LevelingPriority', 'priority_num', 'num'),
  F('AssignmentDefaultRateType', 'def_rate_type', 'enum:rate_type'), F('DefaultPriceTimeUnits', 'def_qty_type', 'strict:qty_type'), F('SummaryLevel', 'sum_assign_level', 'strict:sum_level'),
  F('ResourcesCanEditAssignmentPercentComplete', 'chng_eff_cmp_pct_flag', 'bool'),
  F('CheckOutStatus', 'checkout_flag', 'bool'), F('PrimaryResourcesCanMarkActivitiesAsCompleted', 'ts_rsrc_mark_act_finish_flag', 'bool'), F('ActivityPercentCompleteBasedOnActivitySteps', 'step_complete_flag', 'bool'));
SCHED_MAP.push(F('LevelAllResources', 'level_all_rsrc_flag', 'bool'), F('LevelWithinFloat', 'level_within_float_flag', 'bool'), F('MinFloatToPreserve', 'level_float_thrs_cnt', 'num'), F('OverAllocationPercentage', 'level_over_alloc_pct', 'num'),
  F('PreserveScheduledEarlyAndLateDates', 'level_keep_sched_date_flag', 'bool'), F('IncludeExternalResAss', 'level_outer_assign_flag', 'bool'), F('ExternalProjectPriorityLimit', 'level_outer_assign_priority', 'num'),
  F('MultipleFloatPathsEnabled', 'enable_multiple_longest_path_calc', 'bool'), F('MaximumMultipleFloatPaths', 'max_multiple_longest_path', 'num'), F('MultipleFloatPathsUseTotalFloat', 'use_total_float_multiple_longest_paths', 'bool'),
  F('MultipleFloatPathsEndingActivityObjectId', 'key_activity_for_multiple_longest_paths'));
/** Tables of their own in P6's XML: role prices, financial periods, threshold parameters, and per project the thresholds, issues, period actuals and resource commitments. */
const ROLERATE_MAP: FieldMap = [F('ObjectId', 'role_rate_id'), F('RoleObjectId', 'role_id'), F('EffectiveDate', 'start_date', 'date'), F('MaxUnitsPerTime', 'max_qty_per_hr', 'num'), F('PricePerUnit', 'cost_per_qty', 'num'),
  F('PricePerUnit2', 'cost_per_qty2', 'num'), F('PricePerUnit3', 'cost_per_qty3', 'num'), F('PricePerUnit4', 'cost_per_qty4', 'num'), F('PricePerUnit5', 'cost_per_qty5', 'num')];
const FINDATES_MAP: FieldMap = [F('ObjectId', 'fin_dates_id'), F('Name', 'fin_dates_name'), F('StartDate', 'start_date', 'date'), F('EndDate', 'end_date', 'date')];
const THRSPARM_MAP: FieldMap = [F('ObjectId', 'thresh_parm_id'), F('Name', 'thresh_parm_name')];
const PROJTHRS_MAP: FieldMap = [F('ObjectId', 'thresh_id'), F('ProjectObjectId', 'proj_id'), F('OBSObjectId', 'obs_id'), F('ThresholdParameterObjectId', 'thresh_parm_id'), F('WBSObjectId', 'wbs_id'), F('LowerThreshold', 'lo_parm_value', 'num'), F('IssuePriority', 'priority_type', 'enum:priority_type'), F('Status', 'status_code', 'enum:thresh_status'), F('DetailToMonitor', 'thresh_type', 'enum:thresh_type'),
  F('UpperThreshold', 'hi_parm_value', 'num'), F('FromDate', 'window_start', 'date'), F('ToDate', 'window_end', 'date'),
  // a window edge is a date or a relative expression (DD, dd+2M): the expression is the XER's own text, and wins on read
  F('FromDateExpression', 'window_start'), F('ToDateExpression', 'window_end')];
const PROJISSU_MAP: FieldMap = [F('ObjectId', 'issue_id'), F('ProjectObjectId', 'proj_id'), F('Name', 'issue_name'), F('ActivityObjectId', 'task_id'), F('WBSObjectId', 'wbs_id'), F('ResourceObjectId', 'rsrc_id'), F('OBSObjectId', 'obs_id'),
  F('ProjectThresholdObjectId', 'thresh_id'), F('ThresholdParameterObjectId', 'thresh_parm_id'), F('Priority', 'priority_type', 'enum:priority_type'), F('Status', 'status_code', 'enum:issue_status'), F('IdentifiedBy', 'add_by_name'), F('DateIdentified', 'add_date', 'date'), F('ResolutionDate', 'resolv_date', 'date'), F('Notes', 'issue_notes'),
  F('UpperThreshold', 'hi_parm_value', 'num'), F('LowerThreshold', 'lo_parm_value', 'num'), F('ActualValue', 'issue_value', 'num')];
const TASKFIN_MAP: FieldMap = [F('FinancialPeriodObjectId', 'fin_dates_id'), F('ActivityObjectId', 'task_id'), F('ProjectObjectId', 'proj_id'), F('ActualLaborUnits', 'act_work_qty', 'num'), F('ActualLaborCost', 'act_work_cost', 'num'),
  F('ActualNonLaborUnits', 'act_equip_qty', 'num'), F('ActualNonLaborCost', 'act_equip_cost', 'num'), F('ActualMaterialCost', 'act_mat_cost', 'num'), F('ActualExpenseCost', 'act_expense_cost', 'num'), F('EarnedValueCost', 'bcwp', 'num'),
  F('PlannedValueCost', 'bcws', 'num'), F('EarnedValueLaborUnits', 'perfm_work_qty', 'num'), F('PlannedValueLaborUnits', 'sched_work_qty', 'num')];
const WBSRSRC_MAP: FieldMap = [F('ObjectId', 'wbsrsrc_id'), F('WBSObjectId', 'wbs_id'), F('ResourceObjectId', 'rsrc_id'), F('RoleObjectId', 'role_id'), F('ProjectObjectId', 'proj_id'), F('StartDate', 'start_date', 'date'),
  F('FinishDate', 'end_date', 'date'), F('CommittedFlag', 'committed_flag', 'bool')];
const TASKNOTE_MAP: FieldMap = [F('ActivityObjectId', 'task_id'), F('ProjectObjectId', 'proj_id'), F('Note', 'task_notes')]; // an activity's note with no notebook topic (the XER's TASKNOTE): ActivityNote without NotebookTopicObjectId
const SPEND_MAP: FieldMap = [F('ObjectId', 'wbs_budg_id'), F('ProjectObjectId', 'proj_id'), F('WBSObjectId', 'wbs_id'), F('Date', 'start_date', 'date'), F('SpendingPlan', 'spend_cost', 'num'), F('BenefitPlan', 'benefit_cost', 'num')];
/** The root WBS node is the Project element (P6's project node): its own fields are the Project's fields of the same meaning. */
export const P6XML_ROOT_MAP: FieldMap = [F('OBSObjectId', 'obs_id'), F('Status', 'status_code', 'enum:wbs_status'), F('OriginalBudget', 'orig_cost', 'num'), F('IndependentETCTotalCost', 'indep_remain_total_cost', 'num'),
  F('IndependentETCLaborUnits', 'indep_remain_work_qty', 'num'), F('AnticipatedStartDate', 'anticip_start_date', 'date'), F('AnticipatedFinishDate', 'anticip_end_date', 'date'), F('WBSCategoryObjectId', 'phase_id'), F('EarnedValueUserPercent', 'ev_user_pct', 'pct'),
  F('EarnedValueETCUserValue', 'ev_etc_user_value', 'num'), F('EarnedValueComputeType', 'ev_compute_type', 'strict:ev_compute'), F('EarnedValueETCComputeType', 'ev_etc_compute_type', 'enum:ev_etc'),
  F('DiscountApplicationPeriod', 'dscnt_period_type', 'strict:discount_period')];
/** What P6's schema gives BaselineProject less than Project (of the tags the maps above write): left out of a baseline. */
const NOT_IN_BASELINE = new Set(['CurrentBaselineProjectObjectId', 'SourceProjectObjectId', 'ExternalCRKey', 'FinancialPeriodTemplateId', 'LastApplyActualsDate', 'AllowNegativeActualUnitsFlag', 'UseProjectBaselineForEarnedValue', 'ResourcesCanMarkAssignmentAsCompleted',
  'ResourcesCanViewInactiveActivities', 'SummaryLevel', 'EarnedValueComputeType', 'EarnedValueETCUserValue', 'EarnedValueUserPercent']);
/** The XER table -> its P6 XML element and field map, for the tables the writer carries field by field (tests/p6xml-coverage.test.ts sweeps every XER field against them). */
export const P6XML_TABLES: Record<string, { element: string; map: FieldMap }> = {
  PROJECT: { element: 'Project', map: PROJECT_MAP }, PROJWBS: { element: 'WBS', map: WBS_MAP }, TASK: { element: 'Activity', map: ACT_MAP }, TASKPRED: { element: 'Relationship', map: REL_MAP },
  RSRC: { element: 'Resource', map: RSRC_MAP }, RSRCRATE: { element: 'ResourceRate', map: RATE_MAP }, TASKRSRC: { element: 'ResourceAssignment', map: ASSIGN_MAP }, PROJCOST: { element: 'ActivityExpense', map: EXP_MAP },
  UMEASURE: { element: 'UnitOfMeasure', map: UOM_MAP }, COSTTYPE: { element: 'ExpenseCategory', map: EXPCAT_MAP }, RSRCCURVDATA: { element: 'ResourceCurve', map: CURVE_MAP }, RSRCROLE: { element: 'ResourceRole', map: RSRCROLE_MAP },
  ACTVTYPE: { element: 'ActivityCodeType', map: CODETYPE_MAP }, ACTVCODE: { element: 'ActivityCode', map: CODE_MAP }, TASKACTV: { element: 'ActivityCodeAssignment', map: CODEASSIGN_MAP }, ACCOUNT: { element: 'CostAccount', map: ACCOUNT_MAP },
  OBS: { element: 'OBS', map: OBS_MAP }, UDFTYPE: { element: 'UDFType', map: UDFTYPE_MAP }, UDFVALUE: { element: 'UDFValue', map: UDFVAL_MAP }, CURRTYPE: { element: 'Currency', map: CURR_MAP }, ROLES: { element: 'Role', map: ROLE_MAP },
  TASKMEMO: { element: 'ActivityNote', map: MEMO_MAP }, TASKPROC: { element: 'ActivityStep', map: STEP_MAP }, PCATTYPE: { element: 'ProjectCodeType', map: PCODETYPE_MAP }, PCATVAL: { element: 'ProjectCode', map: PCODE_MAP },
  ROLERATE: { element: 'RoleRate', map: ROLERATE_MAP }, FINDATES: { element: 'FinancialPeriod', map: FINDATES_MAP }, THRSPARM: { element: 'ThresholdParameter', map: THRSPARM_MAP }, PROJTHRS: { element: 'ProjectThreshold', map: PROJTHRS_MAP },
  PROJISSU: { element: 'ProjectIssue', map: PROJISSU_MAP }, TASKNOTE: { element: 'ActivityNote', map: TASKNOTE_MAP }, WBSBUDG: { element: 'ProjectSpendingPlan', map: SPEND_MAP }, TASKFIN: { element: 'ActivityPeriodActual', map: TASKFIN_MAP }, WBSRSRC: { element: 'ProjectResource', map: WBSRSRC_MAP },
  RCATTYPE: { element: 'ResourceCodeType', map: RCODETYPE_MAP }, RCATVAL: { element: 'ResourceCode', map: RCODE_MAP }, MEMOTYPE: { element: 'NotebookTopic', map: TOPIC_MAP }, WBSMEMO: { element: 'ProjectNote', map: WBSMEMO_MAP },
};


/** Sources for the coded values (all read 2026-10-28):
 *  - Oracle P6 EPPM Business Object Events Reference (ProjectType, ActivityType, WBSType, ProjectIssueType tables: the allowed strings), v22 pdf
 *    https://docs.oracle.com/cd/F51301_01/English/Integration_Documentation/business_object_events_reference/business_object_events_reference.pdf and the v24 page
 *    https://docs.oracle.com/cd/F88966_01/English/Integration_Documentation/business_object_events_reference/34274.htm (WBSType: EarnedValueComputeType, EarnedValueETCComputeType, Status);
 *  - Oracle P6 EPPM Web Services Reference, ProjectThreshold Fields (IssuePriority Top|High|Normal|Low|Lowest, Status Enabled|Disabled, DetailToMonitor Activity|WBS)
 *    https://docs.oracle.com/cd/F88966_01/English/Integration_Documentation/p6_eppm_web_services_reference/42401.htm;
 *  - Oracle XER Import/Export Data Map Guide (Project), column -> field label (phase_id = "WBS Category", chng_eff_cmp_pct_flag = "Resources Edit Percent Complete")
 *    https://docs.oracle.com/cd/F88966_01/English/Mapping_and_Schema/xer_import_export_data_map_project/xer_import_export_data_map_project.pdf;
 *  - MPXJ 16.10 (org.mpxj.primavera: PriorityHelper, XmlProjectWriter, PrimaveraXERFileWriter, UdfHelper, ColorHelper, TimephasedHelper): the only source that links an XER code to an XML text.
 *  A pair is written when MPXJ links the code to the text and Oracle's list has the text (or, for the issue and threshold priorities, when they are the same PT_ codes and the same five texts as
 *  the activity priority MPXJ links). Oracle lists no XER codes anywhere, and the GitHub issue morrisonkuhlsen/mkperth#31 ("Performance Factor = 1" for "PF = 1") disagrees with Oracle's spelling,
 *  so risk level, schedule type, threshold parameter type stay out; history interval and level and integrated type have no code in any sample or the pilot file to pair. Review status, issue
 *  status, threshold status/type and the ETC computation are paired by name against Oracle's lists (see ENUMS), only for the codes the data shows. */
/** SCHEDOPTIONS.limit_multiple_longest_path_calc is Project/LimitMultipleFloatPaths (ScheduleOptions has no such field; paired by name with its siblings MultipleFloatPathsEnabled, MaximumMultipleFloatPaths,
 *  MultipleFloatPathsUseTotalFloat, which are the other three "multiple float paths" columns). */
const LIMIT_PATHS_MAP: FieldMap = [['LimitMultipleFloatPaths', 'limit_multiple_longest_path_calc', 'bool']];
/** What the P6 XML writer does NOT carry, field by field (table.field, or a whole table), with why - checked against P6's own XML schema (p6apibo.xsd, read from the
 *  copy MPXJ embeds) and the helpers MPXJ's XML writer uses for the coded values. Anything an XER holds that is neither in P6XML_TABLES' maps, nor carried by the special
 *  writers (calendars, nested codes, UDFs, notes, schedule options, curves) nor listed here fails tests/p6xml-coverage.test.ts. Reasons:
 *  - NO: P6's XML schema has no field for it (columns P6 keeps for itself, or only older builds have; or the Oracle XER data map gives the column no field of its own: sum_base_cost,
 *    TASKPRED.float_path and rsrc_request_data are not in it, indicator expressions are labelled with their own names, and 'Contains Summarized Data Only' (sum_only_flag) is no field of Project);
 *  - TEXTS: the schema has the field, as free text; Oracle lists its texts but no source links an XER code to one of them (MPXJ links only the pairs in ENUMS), so none is guessed (an unverified text could make P6 refuse the file);
 *  - OLD: a column of older P6 builds only, the newer ones keep the same data under the carried column;
 *  - ROOT: the field is carried on the root node (the Project element) and has no field on the other WBS elements. */
const UNIT = 'P6 XML field exists, its unit (percent or fraction) is not verified';
const NO = 'no element in P6 XML', TEXTS = 'P6 XML field exists, its texts are not verified', OLD = 'column of older P6 builds only';
const ROOT = 'carried on the root node (the Project element); the other WBS elements have no field for it';
export const P6XML_NOT_CARRIED: Record<string, string> = {
  'ACTVCODE.total_assignments': NO, 'ACTVCODE.actv_code_short_len': NO, 'ACTVCODE.wbs_id': NO, 'ACTVCODE.guid': NO, 'ACTVTYPE.wbs_id': NO,
  APPLYACTOPTIONS: NO, 'CURRTYPE.group_digit_cnt': NO, 'CURRTYPE.curr_name': NO, POBS: NO,
  'PROJCOST.pobs_id': NO, 'PROJCOST.contract_manager_import': NO, 'PROJCOST.cost_type': NO,
  'PROJECT.project_flag': NO, 'PROJECT.sum_only_flag': NO, 'PROJECT.orig_proj_id': NO, 'PROJECT.base_type_id': NO, 'PROJECT.risk_level': TEXTS, 'PROJECT.last_checksum': NO,
  'PROJECT.last_baseline_update_date': NO, 'PROJECT.intg_proj_type': TEXTS, 'PROJECT.loaded_scope_level': NO, 'PROJECT.export_flag': NO,
  'PROJECT.new_fin_dates_id': NO, 'PROJECT.next_data_date': NO, 'PROJECT.close_period_flag': NO, 'PROJECT.trsrcsum_loaded': NO, 'PROJECT.sum_refresh_date': NO, 'PROJECT.baselines_to_export': NO,
  'PROJECT.baseline_names_to_export': NO, 'PROJECT.add_month_num': NO, 'PROJECT.add_item_cnt': NO, 'PROJECT.control_updates_flag': NO, 'PROJECT.hist_interval': TEXTS, 'PROJECT.hist_level': TEXTS,
  'PROJECT.schedule_type': TEXTS, 'PROJECT.sum_base_cost': NO, 'PROJECT.proj_name': OLD,
  'PROJISSU.track_view_id': NO, 'PROJISSU.base_proj_id': NO,
  'PROJTHRS.track_view_id': NO, 'PROJTHRS.issue_cnt': NO,
  'PROJWBS.proj_node_flag': 'structure: the root node is the Project element', 'PROJWBS.ann_dscnt_rate_pct': UNIT, 'PROJWBS.dscnt_period_type': ROOT,
  'PROJWBS.tmpl_guid': NO, 'PROJWBS.plan_open_state': NO,
  'ROLES.pobs_id': NO, 'ROLES.cost_qty_type': NO, 'ROLES.last_checksum': NO,
  'RSRC.pobs_id': NO, 'RSRC.cost_qty_type': NO, 'RSRC.xfer_complete_day_cnt': NO, 'RSRC.xfer_notstart_day_cnt': NO, 'RSRC.load_tasks_flag': NO, 'RSRC.level_flag': NO, 'RSRC.last_checksum': NO,
  'RSRC.cost_qty_link_flag': NO, 'RSRC.proj_id': NO, 'RSRC.default_units_per_time': OLD, 'RSRC.max_units_per_time': OLD,
  'RSRCROLE.rsrc_type': 'derived: filled in again from the resource when read', 'RSRCROLE.rsrc_role_id': NO,
  'TASK.rev_fdbk_flag': NO, 'TASK.lock_plan_flag': NO, 'TASK.tmpl_guid': NO, 'TASK.old_restart_date': NO, 'TASK.old_reend_date': NO, 'TASK.old_remain_drtn_hr_cnt': NO, 'TASK.seq_num': NO, 'TASK.control_updates_flag': NO,
  'TASKACTV.taskactv_id': NO, 'TASKPRED.float_path': NO, 'TASKPRED.taskpred_id': OLD,
  'TASKRSRC.pobs_id': NO, 'TASKRSRC.pend_complete_pct': UNIT, 'TASKRSRC.ts_pend_act_end_flag': NO, 'TASKRSRC.has_rsrchours': NO, 'TASKRSRC.taskrsrc_sum_id': NO,
  'TASKRSRC.old_restart_date': NO, 'TASKRSRC.old_reend_date': NO, 'TASKRSRC.old_remain_drtn_hr_cnt': NO, 'TASKRSRC.cur_cost': NO, 'TASKRSRC.cur_v': NO, 'TASKRSRC.rem_late_start_date2': NO, 'TASKRSRC.rem_late_end_date2': NO,
  'TASKRSRC.override_rate_flag': NO, 'TASKRSRC.pend_complete_flag': NO, 'TASKRSRC.pend_remain_cost': NO, 'TASKRSRC.pend_act_cost': NO, 'TASKRSRC.cost_qty_type': NO,
  'TASKRSRC.act_qty': OLD, 'TASKRSRC.act_work_qty': OLD, 'TASKRSRC.act_equip_qty': OLD, 'TASKRSRC.target_work_qty': OLD, 'TASKRSRC.target_equip_qty': OLD, 'TASKRSRC.remain_work_qty': OLD, 'TASKRSRC.remain_equip_qty': OLD,
  'TASKRSRC.remain_reg_qty': OLD, 'TASKRSRC.remain_ot_qty': OLD, 'TASKRSRC.remain_reg_cost': OLD, 'TASKRSRC.remain_ot_cost': OLD,
  'SCHEDOPTIONS.sched_setplantoforecast': NO, // (no field of ScheduleOptions or Project is "set planned to forecast")
  'THRSPARM.seq_num': NO, 'THRSPARM.wbs_flag': NO, 'THRSPARM.task_flag': NO, 'THRSPARM.rsrc_flag': NO, 'THRSPARM.thresh_parm_type': TEXTS, 'THRSPARM.thresh_field_name': NO, 'THRSPARM.thresh_short_name': NO,
  'UDFTYPE.udf_type_name': NO, 'UDFTYPE.super_flag': NO, 'UDFTYPE.indicator_expression': NO, 'UDFTYPE.summary_indicator_expression': NO, 'UDFTYPE.export_flag': NO,
  'WBSRSRC.auto_compute_dates_flag': NO, 'WBSRSRC.rsrc_request_data': NO,
};
/** Coded fields written for the codes whose P6 text is verified only (the one pair MPXJ's XML and XER writers agree on); every other code of the field is left out of the XML. */
export const P6XML_PARTLY_CARRIED: Record<string, string> = {
  'PROJECT.def_qty_type': 'QT_Hour <-> Hour', 'PROJECT.sum_assign_level': 'SL_Taskrsrc <-> Assignment Level', 'PROJWBS.ev_compute_type': 'EC_Cmp_pct <-> Activity Percent Complete (the root node too)',
  'PROJWBS.dscnt_period_type': 'PD_Month <-> Month (the root node only)',
};
/** Fields the WBS element carries that the root node (written as the Project element, whose fields are the project's own) does not. */
export const P6XML_ROOT_NOT_CARRIED: Record<string, string> = {
  est_wt: NO, seq_num: NO, guid: 'the Project element\'s GUID is the project\'s', wbs_short_name: 'the Project element\'s Id is the project\'s', sum_data_flag: 'the Project element\'s ContainsSummaryData is the project\'s',
};
/** One XER field whose values P6 XML has no place for, as far as this export holds them. */
export interface P6XmlLoss { table: string; field: string; rows: number; reason: string; items?: string[] }
/** What an export to P6 XML leaves out of THIS data: every P6XML_NOT_CARRIED field (and every coded value without a verified text, and what a baseline or the root node cannot hold)
 *  that has a non-empty value in the rows the export writes, with the number of rows and the reason. Never silent: the save answer, the CLI and the app's export all say it. */
export function p6xmlLosses(db: Db, projIds?: string[]): P6XmlLoss[] {
  const sel = selectRows(db, projIds);
  const out = new Map<string, P6XmlLoss>();
  const add = (table: string, field: string, reason: string, n = 1, item?: string) => { if (!n) return; const k = `${table}.${field}|${reason}`; let o = out.get(k); if (o) o.rows += n; else out.set(k, (o = { table, field, rows: n, reason })); if (item && (o.items ??= []).length < 10) o.items.push(item); };
  const has = (v: string | undefined) => v != null && v !== '';
  const isRoot = (r: Row) => r.proj_node_flag === 'Y';
  for (const [key, reason] of Object.entries(P6XML_NOT_CARRIED)) {
    if (reason.startsWith('derived') || reason.startsWith('structure')) continue; // written another way, nothing is lost
    const [t, f] = key.split('.');
    const rs = sel.get(t) ?? [];
    if (!f) { add(t, '(whole table)', reason, rs.length); continue; }
    if (reason === ROOT) { // the root node's value is written on the Project element, when its code has a verified text
      const rootMap = P6XML_ROOT_MAP.find((m) => m[1] === f);
      for (const r of rs) if (has(r[f])) { if (!isRoot(r)) add(t, f, reason); else if (rootMap?.[2]?.match(/^(strict|enum):/) && !(r[f] in P6XML_ENUMS[rootMap[2].slice(rootMap[2].indexOf(':') + 1)])) add(t, f, PARTLY_REASON); }
      continue;
    }
    add(t, f, reason, rs.filter((r) => has(r[f])).length);
  }
  // coded values written only for the codes whose text is verified (the strict maps): any other code is left out
  for (const [t, { map }] of [...Object.entries(P6XML_TABLES), ['SCHEDOPTIONS', { map: SCHED_MAP }] as const]) for (const [, f, conv] of map) {
    if (!conv?.startsWith('strict:') && !conv?.startsWith('enum:')) continue;
    const list = ENUMS[conv.slice(conv.indexOf(':') + 1)];
    add(t, f, PARTLY_REASON, (sel.get(t) ?? []).filter((r) => has(r[f]) && !(r[f] in list)).length);
  }
  // a column with data that no map writes (a newer P6 build's, another tool's), and a table nothing writes: found in the data, not from a list
  for (const [t, rs] of sel) {
    if (t.startsWith('_') || P6XML_NOT_CARRIED[t] || !rs.length) continue;
    const fields = writtenFields(t);
    if (!fields) { add(t, '(whole table)', UNMAPPED_REASON, rs.length); continue; }
    for (const f of db.tables[t]?.fields ?? []) {
      if (f.startsWith('_') || fields.has(f) || P6XML_NOT_CARRIED[`${t}.${f}`] || (t === 'RSRCCURVDATA' && /^pct_usage_\d+$/.test(f))) continue;
      add(t, f, UNMAPPED_REASON, rs.filter((r) => has(r[f])).length);
    }
  }
  // a user-defined field value is written under the one value element of its type; the others, and a value on an object with no <UDF> list here, are left out
  const udfType = new Map(rows(db, 'UDFTYPE').map((u) => [u.udf_type_id, u]));
  for (const u of sel.get('UDFVALUE') ?? []) {
    const ty = udfType.get(u.udf_type_id), area = ty?.table_name ?? '';
    if (!['RSRC', 'PROJECT', 'PROJWBS', 'TASK'].includes(area)) { add('UDFVALUE', '(row)', UDF_AREA_REASON, 1, area || '(no type)'); continue; }
    const [, mapped] = UDF_TAG[ty?.logical_data_type ?? ''] ?? ['TextValue', 'udf_text'];
    for (const f of ['udf_text', 'udf_number', 'udf_date', 'udf_code_id']) if (f !== mapped && has(u[f])) add('UDFVALUE', f, UDF_VALUE_REASON);
  }
  // a calendar whose clndr_data is not P6's syntax: its week and exceptions are written from a guess
  for (const c of sel.get('CALENDAR') ?? []) {
    const { how } = calendarReading(c);
    if (how === 'lenient') add('CALENDAR', 'clndr_data', CAL_LENIENT_REASON, 1, c.clndr_name);
    else if (how === 'none') add('CALENDAR', 'clndr_data', CAL_NONE_REASON, 1, c.clndr_name);
  }
  // the root WBS node is the Project element, which has no field for these
  const projName = new Map((sel.get('PROJECT') ?? []).map((p) => [p.proj_id, p.proj_short_name]));
  for (const [f, reason] of Object.entries(P6XML_ROOT_NOT_CARRIED)) {
    if (P6XML_NOT_CARRIED[`PROJWBS.${f}`]) continue; // counted above
    for (const r of (sel.get('PROJWBS') ?? []).filter(isRoot)) if (has(r[f]) && !(f === 'wbs_short_name' && r[f] === projName.get(r.proj_id))) add('PROJWBS', f, `root node: ${reason}`);
  }
  // a baseline is written as BaselineProject, which has fewer fields than Project
  const exported = new Set((sel.get('PROJECT') ?? []).map((p) => p.proj_id));
  const baselines = rows(db, 'PROJECT').filter((b) => b._baseline_of && exported.has(b._baseline_of));
  const rootOf = new Map(rows(db, 'PROJWBS').filter(isRoot).map((w) => [w.proj_id, w]));
  for (const b of baselines) {
    for (const [tag, f] of PROJECT_MAP) if (NOT_IN_BASELINE.has(tag) && has(b[f])) add('PROJECT', f, BASELINE_REASON);
    for (const [tag, f] of P6XML_ROOT_MAP) if (NOT_IN_BASELINE.has(tag) && has(rootOf.get(b.proj_id)?.[f])) add('PROJWBS', f, BASELINE_REASON);
  }
  return [...out.values()].sort((a, b) => a.reason.localeCompare(b.reason) || a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
}
const UNMAPPED_REASON = 'a column (or table) with data that this writer has no map for';
const UDF_AREA_REASON = 'user-defined field value on an object whose P6 XML element this writer gives no UDF list (its type\'s subject area is in items)';
const UDF_VALUE_REASON = 'user-defined field value held in a column other than the one its type writes';
const CAL_LENIENT_REASON = 'calendar whose clndr_data is not P6\'s syntax: its work week and exceptions are written from a guess read from the text (P6 would not take the text itself)';
const CAL_NONE_REASON = 'calendar whose clndr_data could not be read at all: written without a work week';
/** The columns of a table the writer writes (null: the table is not written at all). Anything in the data outside these, and outside P6XML_NOT_CARRIED, is reported. */
function writtenFields(t: string): Set<string> | null {
  const mapped = P6XML_TABLES[t]?.map.filter((m) => m[2] !== 'legacy').map((m) => m[1]);
  const extra: Record<string, string[]> = {
    CALENDAR: ['clndr_id', 'clndr_name', 'clndr_type', 'default_flag', 'rsrc_private', 'last_chng_date', 'base_clndr_id', 'proj_id', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'clndr_data'],
    SCHEDOPTIONS: ['schedoptions_id', 'proj_id', 'sched_retained_logic', 'sched_progress_override', ...SCHED_MAP.map((m) => m[1]), ...LIMIT_PATHS_MAP.map((m) => m[1])],
    PROJPCAT: ['proj_id', 'proj_catg_type_id', 'proj_catg_id'], RSRCRCAT: ['rsrc_id', 'rsrc_catg_type_id', 'rsrc_catg_id'], TASKACTV: ['task_id', 'actv_code_type_id', 'actv_code_id', 'proj_id'],
    UDFVALUE: ['udf_type_id', 'fk_id', 'proj_id', 'udf_text', 'udf_number', 'udf_date', 'udf_code_id'], TASKPROC: ['complete_pct'], PROJWBS: [...P6XML_ROOT_MAP.map((m) => m[1]), 'proj_node_flag'], PROJECT: [],
  };
  if (!mapped && !extra[t]) return null;
  return new Set([...(mapped ?? []), ...(extra[t] ?? [])]);
}
const PARTLY_REASON = 'coded value whose P6 XML text is not verified: only the verified codes are written, the others are left out';
const BASELINE_REASON = 'BaselineProject in P6 XML has no field for it';
/** The losses as plain sentences, one per reason (empty when the export loses nothing). */
export function p6xmlLossNotes(losses: P6XmlLoss[]): string[] {
  const by = new Map<string, P6XmlLoss[]>();
  for (const l of losses) (by.get(l.reason) ?? by.set(l.reason, []).get(l.reason)!).push(l);
  return [...by].map(([reason, ls]) => `Not in the P6 XML (${reason}): ${ls.slice(0, 40).map((l) => `${l.table}.${l.field} ${l.rows} ${l.field === '(whole table)' || l.field === '(row)' ? 'row(s)' : 'value(s)'}${l.items?.length ? ` [${l.items.join(', ')}]` : ''}`).join(', ')}${ls.length > 40 ? `, and ${ls.length - 40} more fields` : ''}. Save as XER to keep them.`);
}

/** Tables the XER-to-XML writer carries by other means than a field map: their fields round-trip in nested elements (checked by tests/p6xml-coverage.test.ts). */
export const P6XML_SPECIAL_TABLES = ['CALENDAR', 'SCHEDOPTIONS', 'PROJPCAT', 'RSRCRCAT', 'TASKACTV', 'UDFVALUE', 'RSRCCURVDATA'];

/** The XML tags the reader turns into the clone's own columns, converting the value (dates, enumerations, flags) or
 *  folding it (a calendar's week and exceptions into clndr_data): every other leaf is kept as it is (xml:<Tag>). */
export function p6xmlConvertedTags(): Set<string> {
  const maps = [PROJECT_MAP, OLD_SCHED_MAP, SCHED_MAP, WBS_MAP, ACT_MAP, REL_MAP, RSRC_MAP, RATE_MAP, UOM_MAP, EXPCAT_MAP, CURVE_MAP, RSRCROLE_MAP, ASSIGN_MAP, EXP_MAP, CODETYPE_MAP, CODE_MAP, CODEASSIGN_MAP, ACCOUNT_MAP, OBS_MAP, UDFTYPE_MAP, UDFVAL_MAP, CURR_MAP, ROLE_MAP, MEMO_MAP, STEP_MAP, PCODETYPE_MAP, PCODE_MAP, RCODETYPE_MAP, RCODE_MAP, TOPIC_MAP, WBSMEMO_MAP, P6XML_ROOT_MAP, TASKNOTE_MAP, SPEND_MAP];
  return new Set([...maps.flatMap((m) => m.map(([tag]) => tag)), 'OutOfSequenceScheduleType', 'IsDefault', 'Type', 'IsPersonal', 'DayOfWeek', 'Start', 'Finish', 'Date', 'TypeObjectId', 'ValueObjectId', 'PercentComplete']);
}

/** An element as XML text (its text, then its children; attributes are not kept by the reader). */
const xmlText = (n: XNode): string => `<${n.name}>${esc(n.text)}${n.children.map(xmlText).join('')}</${n.name}>`;
/** What nothing read (not in used) is kept as _xml_<Tag>: read_table shows it as xml:<Tag>, so nothing the file has is dropped: a leaf as its
 *  text exactly as written (not trimmed), an element with children as its XML, and a tag that repeats once per occurrence (the second
 *  is <Tag>#2, the third <Tag>#3...). Writers leave fields starting with "_" out. */
function keepRest(n: XNode, r: Row, used: Iterable<string>, prefix = '_xml_'): Row {
  const u = new Set(used), seen = new Map<string, number>();
  for (const c of n.children) {
    if (u.has(c.name)) continue;
    const k = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, k);
    const field = `${prefix}${c.name}${k > 1 ? `#${k}` : ''}`;
    if (!(field in r)) r[field] = c.children.length ? xmlText(c) : c.text;
  }
  return r;
}
/** An element the clone has no table for, as a row of _XML_<Element> (read_table: XML:<Element>): its leaves. */
const xmlRow = (n: XNode, extra: Row = {}): Row => keepRest(n, { ...extra }, [], '');

function fromXml(n: XNode, map: FieldMap, alsoUsed: string[] = [], keep = true): Row {
  const r: Row = {};
  for (const [tag, field, conv] of map) {
    const c = child(n, tag);
    if (!c) continue;
    // text values exactly as written (a trailing space or no-break space is part of a name); dates, numbers, flags and codes are read without the whitespace around them
    let v = conv ? c.text.trim() : c.text;
    if (conv === 'date') v = xerDate(v);
    else if (conv === 'bool') v = v === 'true' || v === '1' ? 'Y' : 'N';
    else if (conv?.startsWith('enum:') || conv?.startsWith('strict:')) { const e = ENUMS[conv.slice(conv.indexOf(':') + 1)]; v = v === 'None' || v === '<None>' ? '' : Object.entries(e).find(([, l]) => l === v)?.[0] ?? v; }
    else if (conv === 'color') v = v.replace(/^#/, '');
    else if (conv === 'pct') v = Number.isFinite(Number(v)) && v !== '' && Math.abs(Number(v)) <= 1 ? String(Math.round(Number(v) * 100 * 1e6) / 1e6) : v; // (older P6 Clone files wrote the percent itself; a fraction is at most 1)
    if (field === 'sched_outer_depend_type') v = v === 'true' || v === '1' ? 'SD_None' : 'SD_Both';
    if ((conv?.startsWith('enum:') || conv?.startsWith('strict:')) && n.clone?.[field] && ENUMS[conv.slice(conv.indexOf(':') + 1)]?.[n.clone[field]] === c.text.trim()) v = n.clone[field]; // (the code the text was written for)
    r[field] = v;
  }
  return keep ? keepRest(n, r, [...map.map(([tag]) => tag), ...alsoUsed]) : r;
}

// ---------- calendars

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
// P6 writes a shift's Finish as its last working minute (08:00-16:59 for 08:00-17:00).
// (a whole 24-hour working day is two periods, 00:00-11:59 and 12:00-23:59: one 00:00-23:59 period is how the reader tells a non-working exception)
const shiftsXml = (ss: Shift[]) => ss.flatMap((x) => (x.start === 0 && x.end === 1440 ? [{ start: 0, end: 720 }, { start: 720, end: 1440 }] : [x])).map((s) => `<WorkTime><Start>${hm(s.start)}</Start><Finish>${hm(s.end - 1)}</Finish></WorkTime>`).join('');

/** How a calendar's clndr_data reads: exactly as P6's syntax (strict), as far as non-P6 text allows (lenient: a guess), or not at all. */
export function calendarReading(r: Row): { def: CalendarDef | null; how: 'strict' | 'lenient' | 'none' | 'empty' } {
  if (!r.clndr_data) return { def: null, how: 'empty' };
  try { return { def: parseClndrData(r.clndr_data), how: 'strict' }; } catch {
    const def = parseClndrDataLeniently(r.clndr_data);
    return def ? { def, how: 'lenient' } : { def: null, how: 'none' };
  }
}
function calendarXml(r: Row): string {
  const { def } = calendarReading(r); // (text that is not P6's syntax is written as far as it can be read, never an empty week: p6xmlLosses says so)
  const parts: Part[] = [['ObjectId', `<ObjectId>${esc(r.clndr_id)}</ObjectId>`], ['Name', `<Name>${esc(r.clndr_name)}</Name>`], ['Type', `<Type>${ENUMS.clndr_type[r.clndr_type] ?? 'Global'}</Type>`], ['IsDefault', `<IsDefault>${r.default_flag === 'Y'}</IsDefault>`]];
  if (r.rsrc_private) parts.push(['IsPersonal', `<IsPersonal>${r.rsrc_private === 'Y'}</IsPersonal>`]);
  if (r.last_chng_date) parts.push(['LastUpdateDate', `<LastUpdateDate>${xmlDate(r.last_chng_date)}</LastUpdateDate>`]);
  if (r.base_clndr_id) parts.push(['BaseCalendarObjectId', `<BaseCalendarObjectId>${esc(r.base_clndr_id)}</BaseCalendarObjectId>`]);
  if (r.proj_id) parts.push(['ProjectObjectId', `<ProjectObjectId>${esc(r.proj_id)}</ProjectObjectId>`]);
  for (const [tag, f] of [['HoursPerDay', 'day_hr_cnt'], ['HoursPerWeek', 'week_hr_cnt'], ['HoursPerMonth', 'month_hr_cnt'], ['HoursPerYear', 'year_hr_cnt']]) if (r[f]) parts.push([tag, `<${tag}>${r[f]}</${tag}>`]);
  if (def) {
    parts.push(['StandardWorkWeek', '<StandardWorkWeek>' + def.week.map((ss, i) => `<StandardWorkHours><DayOfWeek>${DAYS[i]}</DayOfWeek>${shiftsXml(ss)}</StandardWorkHours>`).join('') + '</StandardWorkWeek>']);
    parts.push(['HolidayOrExceptions', '<HolidayOrExceptions>' + [...def.exceptions.entries()].sort((a, b) => a[0] - b[0]).map(([d, ss]) => `<HolidayOrException><Date>${xmlDate(formatP6Date(serialToMinutes(d)))}</Date>${shiftsXml(ss)}</HolidayOrException>`).join('') + '</HolidayOrExceptions>']);
  }
  return `<Calendar>${inOrder('Calendar', parts)}</Calendar>`;
}

function calendarRow(n: XNode): Row {
  const parseT = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s); return m ? +m[1] * 60 + +m[2] : NaN; };
  // P6's Finish is the last working minute (hh:59 or hh:29); older P6 Clone files wrote the end itself (hh:00, 00:00 = midnight)
  const endT = (s: string) => { const v = parseT(s); return v % 30 === 29 ? v + 1 : v === 0 ? 1440 : v; };
  const shifts = (x: XNode) => kids(x, 'WorkTime').map((w) => ({ start: parseT(val(w, 'Start')), end: endT(val(w, 'Finish')) })).filter((s) => s.end > s.start);
  const joined = (ss: Shift[]) => [...ss].sort((a, b) => a.start - b.start).reduce<Shift[]>((out, s) => { const l = out[out.length - 1]; if (l && l.end === s.start) l.end = s.end; else out.push({ ...s }); return out; }, []); // (periods that touch are one)
  const none: XNode = { name: '', children: [], text: '' };
  const def: CalendarDef = { week: [[], [], [], [], [], [], []], exceptions: new Map() };
  for (const d of kids(child(n, 'StandardWorkWeek') ?? none, 'StandardWorkHours')) {
    const i = DAYS.indexOf(val(d, 'DayOfWeek'));
    if (i >= 0) def.week[i] = joined(shifts(d));
  }
  const exceptions = [...kids(child(n, 'HolidayOrExceptions') ?? none, 'HolidayOrException'), ...kids(child(n, 'HolidayExceptions') ?? none, 'HolidayException')];
  for (const h of exceptions) {
    const t = parseP6Date(val(h, 'Date').replace('T', ' ').slice(0, 16));
    if (t == null) continue;
    const ss = shifts(h);
    // a single 00:00-23:59 entry is P6's way of writing a non-working day
    def.exceptions.set(minutesToSerial(t), ss.length === 1 && ss[0].start === 0 && ss[0].end === 1440 ? [] : joined(ss));
  }
  const type = Object.entries(ENUMS.clndr_type).find(([, l]) => l === val(n, 'Type'))?.[0] ?? 'CA_Base';
  const yes = (s: string) => s === 'true' || s === '1';
  return keepRest(n, {
    clndr_id: val(n, 'ObjectId'), default_flag: yes(val(n, 'IsDefault')) ? 'Y' : 'N', clndr_name: val(n, 'Name'), proj_id: val(n, 'ProjectObjectId'),
    base_clndr_id: val(n, 'BaseCalendarObjectId'), last_chng_date: ((d) => (d ? xerDate(d) : ''))(val(n, 'LastUpdateDate')), clndr_type: type, day_hr_cnt: val(n, 'HoursPerDay'), week_hr_cnt: val(n, 'HoursPerWeek'),
    month_hr_cnt: val(n, 'HoursPerMonth'), year_hr_cnt: val(n, 'HoursPerYear'), rsrc_private: val(n, 'IsPersonal') ? (yes(val(n, 'IsPersonal')) ? 'Y' : 'N') : '', clndr_data: serializeClndrData(def),
  }, ['ObjectId', 'IsDefault', 'Name', 'ProjectObjectId', 'BaseCalendarObjectId', 'Type', 'HoursPerDay', 'HoursPerWeek', 'HoursPerMonth', 'HoursPerYear', 'IsPersonal', 'LastUpdateDate']);
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
  // an element's children are written in the order P6's schema lists them (extra: its nested <Code>, <UDF>, <Values>... as [tag, xml])
  const el = (tag: string, r: Row, map: FieldMap, extra: Part[] = []) => out.push(`<${tag}>${inOrder(tag, [...toParts(r, map), ...extra])}</${tag}>`);
  const udfType = new Map(rows(db, 'UDFTYPE').map((u) => [u.udf_type_id, u]));
  const udfsOf = new Map<string, Row[]>();
  for (const u of get('UDFVALUE')) { const k = `${udfType.get(u.udf_type_id)?.table_name}|${u.fk_id}`; const l = udfsOf.get(k); if (l) l.push(u); else udfsOf.set(k, [u]); }
  const udfs = (table: string, id: string): Part => ['UDF', udfsXml(udfsOf.get(`${table}|${id}`) ?? [], udfType)];
  const codeType = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c.actv_code_type_id]));
  const codesOf = new Map<string, Row[]>();
  for (const a of get('TASKACTV')) { const l = codesOf.get(a.task_id); if (l) l.push(a); else codesOf.set(a.task_id, [a]); }
  const globalTypes = new Set(get('ACTVTYPE').filter((x) => !x.proj_id).map((x) => x.actv_code_type_id));
  const rcodes = new Map<string, Row[]>(); for (const a of get('RSRCRCAT')) { const l = rcodes.get(a.rsrc_id); if (l) l.push(a); else rcodes.set(a.rsrc_id, [a]); }
  const pcodes = new Map<string, Row[]>(); for (const a of get('PROJPCAT')) { const l = pcodes.get(a.proj_id); if (l) l.push(a); else pcodes.set(a.proj_id, [a]); }
  // the top-level objects, each kind together and the kinds in the schema's order
  const topLevel: [string, () => void][] = [
    ['Currency', () => { for (const r of get('CURRTYPE')) el('Currency', r, CURR_MAP); }],
    ['OBS', () => { for (const r of get('OBS')) el('OBS', r, OBS_MAP); }],
    ['CostAccount', () => { for (const r of get('ACCOUNT')) el('CostAccount', r, ACCOUNT_MAP); }],
    ['NotebookTopic', () => { for (const r of get('MEMOTYPE')) el('NotebookTopic', r, TOPIC_MAP); }],
    ['UDFType', () => { for (const r of get('UDFTYPE')) el('UDFType', r, UDFTYPE_MAP); }],
    ['ActivityCodeType', () => { for (const r of get('ACTVTYPE').filter((x) => !x.proj_id)) el('ActivityCodeType', r, CODETYPE_MAP); }],
    ['ActivityCode', () => { for (const r of get('ACTVCODE').filter((x) => globalTypes.has(x.actv_code_type_id))) el('ActivityCode', r, CODE_MAP); }],
    ['Calendar', () => { for (const r of get('CALENDAR').filter((x) => !x.proj_id)) out.push(calendarXml(r)); }],
    ['ProjectCodeType', () => { for (const r of get('PCATTYPE')) el('ProjectCodeType', r, PCODETYPE_MAP); }],
    ['ProjectCode', () => { for (const r of get('PCATVAL')) el('ProjectCode', r, PCODE_MAP); }],
    ['ResourceCodeType', () => { for (const r of get('RCATTYPE')) el('ResourceCodeType', r, RCODETYPE_MAP); }],
    ['ResourceCode', () => { for (const r of get('RCATVAL')) el('ResourceCode', r, RCODE_MAP); }],
    ['UnitOfMeasure', () => { for (const r of get('UMEASURE')) el('UnitOfMeasure', r, UOM_MAP); }],
    ['ExpenseCategory', () => { for (const r of get('COSTTYPE')) el('ExpenseCategory', r, EXPCAT_MAP); }],
    ['ResourceCurve', () => { for (const r of get('RSRCCURVDATA')) el('ResourceCurve', r, CURVE_MAP, [['Values', curveValuesXml(r)]]); }],
    ['FinancialPeriod', () => { for (const r of get('FINDATES')) el('FinancialPeriod', r, FINDATES_MAP); }],
    ['ThresholdParameter', () => { for (const r of get('THRSPARM')) el('ThresholdParameter', r, THRSPARM_MAP); }],
    ['Role', () => { for (const r of get('ROLES')) el('Role', r, ROLE_MAP); }],
    ['RoleRate', () => { for (const r of get('ROLERATE')) el('RoleRate', r, ROLERATE_MAP); }],
    ['Resource', () => { for (const r of get('RSRC')) el('Resource', r, RSRC_MAP, [['Code', codeRefsXml(rcodes.get(r.rsrc_id) ?? [], 'rsrc_catg_type_id', 'rsrc_catg_id')], udfs('RSRC', r.rsrc_id)]); }],
    ['ResourceRate', () => { for (const r of get('RSRCRATE')) el('ResourceRate', r, RATE_MAP); }],
    ['ResourceRole', () => { for (const r of get('RSRCROLE')) el('ResourceRole', r, RSRCROLE_MAP); }],
  ];
  const projectXml = (tag: 'Project' | 'BaselineProject', p: Row, get: (t: string) => Row[], originalId?: string) => {
    const wbsAll = get('PROJWBS');
    const pid = p.proj_id;
    const root = wbsAll.find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
    const so = get('SCHEDOPTIONS').find((s) => s.proj_id === pid) ?? {};
    const own = (m: FieldMap) => (tag === 'BaselineProject' ? m.filter(([t]) => !NOT_IN_BASELINE.has(t)) : m);
    const head: Part[] = [...toParts(p, own(PROJECT_MAP)), ...(root ? toParts(root, own(P6XML_ROOT_MAP)) : []), ...(tag === 'Project' ? toParts(so, LIMIT_PATHS_MAP) : []), ['Name', `<Name>${esc(root?.wbs_name || p._name || p.proj_short_name)}</Name>`],
      ['OriginalProjectObjectId', originalId ? `<OriginalProjectObjectId>${esc(originalId)}</OriginalProjectObjectId>` : ''], ['Code', codeRefsXml(pcodes.get(pid) ?? [], 'proj_catg_type_id', 'proj_catg_id')], udfs('PROJECT', pid),
      ['WBSObjectId', root?.wbs_id ? `<WBSObjectId>${esc(root.wbs_id)}</WBSObjectId>` : '']];
    out.push(`<${tag}>${inOrder(tag, head)}`);
    // its lists, the kinds in the schema's order
    const lists: [string, () => void][] = [
      ['Calendar', () => { for (const r of get('CALENDAR').filter((x) => x.proj_id === pid)) out.push(calendarXml(r)); }],
      ['ActivityCodeType', () => { for (const r of get('ACTVTYPE').filter((x) => x.proj_id === pid)) el('ActivityCodeType', r, CODETYPE_MAP); }],
      ['ActivityCode', () => { for (const r of get('ACTVCODE').filter((x) => !globalTypes.has(x.actv_code_type_id) && get('ACTVTYPE').some((t) => t.actv_code_type_id === x.actv_code_type_id && t.proj_id === pid))) el('ActivityCode', r, CODE_MAP); }],
      ['WBS', () => { for (const r of wbsAll.filter((w) => w.proj_id === pid && w.proj_node_flag !== 'Y')) el('WBS', { ...r, parent_wbs_id: r.parent_wbs_id === root?.wbs_id ? '' : r.parent_wbs_id }, WBS_MAP, [udfs('PROJWBS', r.wbs_id)]); }],
      ['Activity', () => { for (const r of get('TASK').filter((t) => t.proj_id === pid)) // P6 XML percentages are fractions (0.5 = 50%)
        el('Activity', { ...r, wbs_id: r.wbs_id === root?.wbs_id ? '' : r.wbs_id, phys_complete_pct: r.phys_complete_pct ? String(Number(r.phys_complete_pct) / 100) : '' }, ACT_MAP, [['Code', codesXml(codesOf.get(r.task_id) ?? [], codeType)], udfs('TASK', r.task_id)]); }],
      ['Relationship', () => { for (const r of get('TASKPRED').filter((t) => t.proj_id === pid)) el('Relationship', r, REL_MAP); }],
      ['ResourceAssignment', () => { for (const r of get('TASKRSRC').filter((t) => t.proj_id === pid)) el('ResourceAssignment', r, ASSIGN_MAP); }],
      ['ActivityExpense', () => { for (const r of get('PROJCOST').filter((t) => t.proj_id === pid)) el('ActivityExpense', r, EXP_MAP); }],
      ['ProjectThreshold', () => { for (const r of get('PROJTHRS').filter((t) => t.proj_id === pid)) el('ProjectThreshold', r, PROJTHRS_MAP); }],
      ['ProjectIssue', () => { for (const r of get('PROJISSU').filter((t) => t.proj_id === pid)) el('ProjectIssue', r, PROJISSU_MAP); }],
      ['ActivityPeriodActual', () => { for (const r of get('TASKFIN').filter((t) => t.proj_id === pid)) el('ActivityPeriodActual', r, TASKFIN_MAP); }],
      ['ProjectResource', () => { for (const r of get('WBSRSRC').filter((t) => t.proj_id === pid)) el('ProjectResource', r, WBSRSRC_MAP); }],
      ['ProjectSpendingPlan', () => { for (const r of get('WBSBUDG').filter((t) => t.proj_id === pid)) el('ProjectSpendingPlan', r, SPEND_MAP); }],
      // an activity's notes: with a topic (a notebook note), and without (no ObjectId, no topic: the reader tells it from a notebook note by that)
      ['ActivityNote', () => { for (const r of get('TASKMEMO').filter((t) => t.proj_id === pid)) el('ActivityNote', r, MEMO_MAP); for (const r of get('TASKNOTE').filter((t) => t.proj_id === pid)) el('ActivityNote', r, TASKNOTE_MAP); }],
      ['ActivityStep', () => { for (const r of get('TASKPROC').filter((t) => t.proj_id === pid)) // step % complete as a fraction, like activity percentages
        el('ActivityStep', r, STEP_MAP, [['PercentComplete', r.complete_pct ? `<PercentComplete>${Number(r.complete_pct) / 100}</PercentComplete>` : '']]); }],
      ['ProjectNote', () => { for (const r of get('WBSMEMO').filter((t) => t.proj_id === pid)) el('ProjectNote', r, WBSMEMO_MAP); }],
      ['ScheduleOptions', () => { const x = schedOptionsXml(so); if (x) out.push(x); }],
    ];
    const q = seqOf(tag);
    for (const [, run] of lists.map((l, i) => [l, i] as const).sort((a, b) => ((q.get(a[0][0]) ?? 1e9) - (q.get(b[0][0]) ?? 1e9)) || a[1] - b[1]).map(([l]) => l)) run();
    out.push(`</${tag}>`);
  };
  const baselines = (): [Row, string][] => get('PROJECT').flatMap((p) => rows(db, 'PROJECT').filter((x) => x._baseline_of === p.proj_id).map((b): [Row, string] => [b, p.proj_id]));
  // baselines of the exported projects, as P6 writes them with "export baselines"
  const all = (t: string) => rows(db, t);
  topLevel.push(['Project', () => { for (const p of get('PROJECT')) projectXml('Project', p, get); }], ['BaselineProject', () => { for (const [b, orig] of baselines()) projectXml('BaselineProject', b, all, orig); }]);
  const q = seqOf('APIBusinessObjects');
  for (const [, run] of topLevel.map((l, i) => [l, i] as const).sort((a, b) => ((q.get(a[0][0]) ?? 1e9) - (q.get(b[0][0]) ?? 1e9)) || a[1] - b[1]).map(([l]) => l)) run();
  out.push('</APIBusinessObjects>');
}

// ---------- parser

export function parseP6Xml(text: string): { db: Db; findings: Finding[] } {
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  const push = (t: string, r: Row) => { const T = table(db, t); for (const f of Object.keys(r)) addField(T, f); T.rows.push(r); };
  const topMap: [string, string, FieldMap][] = [['Currency', 'CURRTYPE', CURR_MAP], ['OBS', 'OBS', OBS_MAP], ['CostAccount', 'ACCOUNT', ACCOUNT_MAP], ['NotebookTopic', 'MEMOTYPE', TOPIC_MAP],
    ['UDFType', 'UDFTYPE', UDFTYPE_MAP], ['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Role', 'ROLES', ROLE_MAP], ['Resource', 'RSRC', RSRC_MAP], ['ResourceRate', 'RSRCRATE', RATE_MAP], ['ResourceRole', 'RSRCROLE', RSRCROLE_MAP], ['RoleRate', 'ROLERATE', ROLERATE_MAP], ['FinancialPeriod', 'FINDATES', FINDATES_MAP], ['ThresholdParameter', 'THRSPARM', THRSPARM_MAP], ['UnitOfMeasure', 'UMEASURE', UOM_MAP], ['ExpenseCategory', 'COSTTYPE', EXPCAT_MAP], ['ResourceCurve', 'RSRCCURVDATA', CURVE_MAP],
    ['ProjectCodeType', 'PCATTYPE', PCODETYPE_MAP], ['ProjectCode', 'PCATVAL', PCODE_MAP], ['ResourceCodeType', 'RCATTYPE', RCODETYPE_MAP], ['ResourceCode', 'RCATVAL', RCODE_MAP]];
  const projMap: [string, string, FieldMap][] = [['ActivityCodeType', 'ACTVTYPE', CODETYPE_MAP], ['ActivityCode', 'ACTVCODE', CODE_MAP], ['Relationship', 'TASKPRED', REL_MAP], ['ResourceAssignment', 'TASKRSRC', ASSIGN_MAP],
    ['ActivityExpense', 'PROJCOST', EXP_MAP], ['ProjectThreshold', 'PROJTHRS', PROJTHRS_MAP], ['ProjectIssue', 'PROJISSU', PROJISSU_MAP], ['ActivityPeriodActual', 'TASKFIN', TASKFIN_MAP], ['ProjectResource', 'WBSRSRC', WBSRSRC_MAP], ['ProjectSpendingPlan', 'WBSBUDG', SPEND_MAP], ['ActivityCodeAssignment', 'TASKACTV', CODEASSIGN_MAP], ['ActivityNote', 'TASKMEMO', MEMO_MAP], ['UDFValue', 'UDFVALUE', UDFVAL_MAP], ['ActivityStep', 'TASKPROC', STEP_MAP], ['ProjectNote', 'WBSMEMO', WBSMEMO_MAP]];
  // Read as it goes: each top-level element, and each activity, WBS element, relationship, ... of a project, is turned
  // into rows as soon as it closes and let go (a big file is never one tree). A project's own rows are pushed after
  // every top-level element's, Projects before BaselineProjects, as a whole tree would order them.
  type Group = { node: XNode; rows: [string, Row][]; held: XNode[]; at: { pid: string; rootId: string } | null; fallback: [Row, string, 'pid' | 'root'][] };
  const groups = new Map<XNode, Group>();
  const HEAVY = new Set(['Calendar', 'WBS', 'Activity', ...projMap.map(([tag]) => tag)]);
  const top = (n: XNode) => {
    const m = topMap.find(([tag]) => tag === n.name);
    if (m) { const r = fromXml(n, m[2]); if (n.name === 'ResourceCurve') curveValuesRead(n, r); push(m[1], r); if (n.name === 'Resource') { for (const u of udfRows(n, r.rsrc_id, '')) push('UDFVALUE', u); for (const c of kids(n, 'Code')) push('RSRCRCAT', { rsrc_id: r.rsrc_id, rsrc_catg_type_id: val(c, 'TypeObjectId'), rsrc_catg_id: val(c, 'ValueObjectId') }); } }
    else if (n.name === 'Calendar') push('CALENDAR', calendarRow(n));
    else if (n.name !== 'Project' && n.name !== 'BaselineProject') push(`_XML_${n.name}`, xmlRow(n)); // an object the clone has no table for: kept
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
    const m = n.name === 'ActivityNote' && !child(n, 'NotebookTopicObjectId') && !child(n, 'ObjectId') ? (['ActivityNote', 'TASKNOTE', TASKNOTE_MAP] as [string, string, FieldMap]) : projMap.find(([tag]) => tag === n.name);
    if (m) { const r = fromXml(n, m[2]); if (m[1] === 'TASKPROC') { const pc = val(n, 'PercentComplete'); if (pc) r.complete_pct = String(Number(pc) > 1 ? Number(pc) : Math.round(Number(pc) * 1e6) / 1e4); } if (m[1] !== 'ACTVCODE') or(r, 'proj_id', 'pid'); if (m[1] === 'TASKPRED') or(r, 'pred_proj_id', 'pid'); if (m[1] === 'WBSMEMO' || m[1] === 'WBSBUDG') or(r, 'wbs_id', 'root'); put(m[1], r); }
    else put(`_XML_${n.name}`, xmlRow(n, { proj_id: pid })); // an object the clone has no table for: kept
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
    const pr = fromXml(p, PROJECT_MAP, [...OLD_SCHED_MAP, ...P6XML_ROOT_MAP, ...LIMIT_PATHS_MAP].map(([tag]) => tag));
    const pid = pr.proj_id || String(rows(db, 'PROJECT').length + 1);
    pr.proj_id = pid;
    // a baseline is kept as a baseline of its project (BaselineProject; OriginalProjectObjectId or the project that points to it)
    if (p.name === 'BaselineProject') { pr._baseline_of = val(p, 'OriginalProjectObjectId') || baselineOf.get(pid) || ''; pr._baseline_date = pr.last_recalc_date ?? ''; }
    push('PROJECT', pr);
    for (const c of kids(p, 'Code')) push('PROJPCAT', { proj_id: pid, proj_catg_type_id: val(c, 'TypeObjectId'), proj_catg_id: val(c, 'ValueObjectId') });
    for (const u of udfRows(p, pid, pid)) push('UDFVALUE', u);
    const sox = child(p, 'ScheduleOptions');
    const so = sox ? schedOptionsRow(sox) : fromXml(p, OLD_SCHED_MAP, [], false);
    if (p.name === 'Project') Object.assign(so, fromXml(p, LIMIT_PATHS_MAP, [], false));
    // the project's own objects the clone has no table for (its leaves are kept on its row, its heavy children above)
    for (const c of p.children) if (c.children.length && !['ScheduleOptions', 'Code', 'UDF'].includes(c.name) && !HEAVY.has(c.name)) push(`_XML_${c.name}`, xmlRow(c, { proj_id: pid }));
    if (Object.keys(so).length) push('SCHEDOPTIONS', { schedoptions_id: pid, proj_id: pid, ...so });
    const rootId = val(p, 'WBSObjectId') || `${pid}00000`;
    push('PROJWBS', { wbs_id: rootId, proj_id: pid, parent_wbs_id: '', proj_node_flag: 'Y', wbs_short_name: pr.proj_short_name, wbs_name: val(p, 'Name'), seq_num: '0', status_code: 'WS_Open', obs_id: '', ...fromXml(p, P6XML_ROOT_MAP, [], false) });
    // what the children took from the project while it was read, as it is now that all of it is read
    for (const [r, f, kind] of g.fallback) r[f] = kind === 'pid' ? pid : rootId;
    if (g.held.length) { g.at = { pid, rootId }; for (const n of g.held) projectChild(g, n); }
    for (const [t, r] of g.rows) push(t, r);
    groups.delete(p);
  }
  // P6 writes percentages as fractions; files from earlier P6 Clone builds wrote 0-100 (told apart by any value over 1)
  const tasks = rows(db, 'TASK');
  if (!tasks.some((t) => Number(t.phys_complete_pct) > 1)) for (const t of tasks) if (t.phys_complete_pct) t.phys_complete_pct = String(Math.round(Number(t.phys_complete_pct) * 1e6) / 1e4);
  // an XER's RSRCROLE row also names the resource and the role (their IDs, names and the resource's type): the XML says only which two are linked
  if (db.tables.RSRCROLE?.rows.length) {
    const roles = new Map(rows(db, 'ROLES').map((x) => [x.role_id, x])), rs = new Map(rows(db, 'RSRC').map((x) => [x.rsrc_id, x]));
    const T = db.tables.RSRCROLE;
    for (const f of ['role_short_name', 'role_name', 'rsrc_short_name', 'rsrc_name', 'rsrc_type']) addField(T, f);
    for (const l of T.rows) { const ro = roles.get(l.role_id), re = rs.get(l.rsrc_id); l.role_short_name = ro?.role_short_name ?? ''; l.role_name = ro?.role_name ?? ''; l.rsrc_short_name = re?.rsrc_short_name ?? ''; l.rsrc_name = re?.rsrc_name ?? ''; l.rsrc_type = re?.rsrc_type ?? ''; }
  }
  if (!rows(db, 'PROJECT').length) findings.push({ severity: 'fatal', code: 'NO_PROJECT', message: 'The XML file contains no <Project>.', p6: 'P6 finds no project to import.' });
  return { db, findings };
}
