// P6's words for the tables and columns of the file, for the places that name a value to an agent (what a save did not write, what an edit changed): the agent knows
// "Resource", "Activity", "Max Units/Time", never the table or column the file keeps it in.

/** The thing a table holds, in P6's word. */
export const TABLE_WORD: Record<string, string> = {
  PROJECT: 'Project', TASK: 'Activity', TASKPRED: 'Relationship', TASKRSRC: 'Resource assignment', RSRC: 'Resource', RSRCRATE: 'Resource price', CALENDAR: 'Calendar', PROJWBS: 'WBS',
  POBS: 'Project OBS', OBS: 'OBS', ERMHDR: 'Export header', UDFTYPE: 'User-defined field', UDFVALUE: 'User-defined field value', ROLES: 'Role', RSRCROLE: 'Resource role', PROJCOST: 'Project expense',
  ACTVCODE: 'Activity code value', ACTVTYPE: 'Activity code type', TASKACTV: 'Activity code assignment', PCATTYPE: 'Project code type', PCATVAL: 'Project code value', TASKPROC: 'Activity step', CURRTYPE: 'Currency',
  SCHEDOPTIONS: 'Schedule option', FINDATES: 'Financial period', TASKMEMO: 'Activity notebook topic', WBSMEMO: 'WBS notebook topic', MEMOTYPE: 'Notebook topic', RSRCCURVDATA: 'Resource curve', ACCOUNT: 'Cost account',
  RISKTYPE: 'Risk type', DOCUMENT: 'Document', RSRCROLE_RATE: 'Role price', APPLYACTOPTIONS: 'Apply Actuals option', EPS: 'EPS', THRSPARM: 'Threshold parameter', WBSRSRC: 'WBS resource summary',
};
/** A column's words: the trailing "_id", "_flag", "_cnt", "_date", "_num" dropped, the rest as words ("risk_level" -> "Risk level"). */
export const humanizeField = (column: string): string => { const w = column.replace(/_(id|flag|cnt|date|num|hr_cnt)$/, '').split('_').filter(Boolean); return w.length ? w[0][0].toUpperCase() + w.join(' ').slice(1) : column; };
/** What a loss says of a table's values, in P6's words, each kind once with its total: "Project fields (3)", "Project OBS rows (2)" (a whole table). `lost`: {table, field, rows}; a field "(whole table)" is its rows. */
export function lostKinds(lost: { table: string; field: string; rows: number }[]): string[] {
  const by = new Map<string, number>();
  for (const l of lost) { const k = `${TABLE_WORD[l.table] ?? `${l.table.toLowerCase()} value`} ${/^\(/.test(l.field) ? 'rows' : 'fields'}`; by.set(k, (by.get(k) ?? 0) + l.rows); }
  return [...by].map(([k, n]) => `${k} (${n})`);
}
/** A value of the file as P6 names it: "Project risk level", "Project OBS" (a whole table: "(whole table)"), "Export header database name". */
export const p6Name = (table: string, field: string): string => { const t = TABLE_WORD[table] ?? `${table.toLowerCase()} value`; return /^\(/.test(field) ? t : `${t} ${humanizeField(field).toLowerCase()}`; };

/** The subjects and data types of a user defined field as the add_udf operation takes them, against what the file keeps. */
export const UDF_SUBJECT: Record<string, string> = { activity: 'TASK', wbs: 'PROJWBS', project: 'PROJECT', resource: 'RSRC', assignment: 'TASKRSRC', expense: 'PROJCOST' };
export const UDF_TYPE: Record<string, string> = { text: 'FT_TEXT', number: 'FT_FLOAT_2_DECIMALS', integer: 'FT_INT', cost: 'FT_MONEY', start_date: 'FT_START_DATE', finish_date: 'FT_END_DATE', date: 'FT_START_DATE' };
/** A UDF's subject and data type as add_udf takes them (the file keeps a table name and an FT_ code), so an answer names what a caller can send back.
 *  An indicator (P6's traffic light) cannot be made by add_udf: it is named by P6's word. */
/** (A table or a type that is none of P6's: the file's own word without its prefix, in small letters: "FT_DATE" is said "date", never the code.) */
export const udfSubjectWord = (table: string): string => Object.keys(UDF_SUBJECT).find((k) => UDF_SUBJECT[k] === table) ?? (TABLE_WORD[table] ?? table).toLowerCase();
export const udfTypeWord = (ft: string): string => (ft === 'FT_STATICTYPE' ? 'indicator' : /^FT_FLOAT/.test(ft) ? 'number' : Object.keys(UDF_TYPE).find((k) => UDF_TYPE[k] === ft) ?? String(ft ?? '').replace(/^FT_/, '').toLowerCase());

/** P6's words for an activity's status (the file keeps codes). */
export const STATUS_WORDS: Record<string, string> = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' };
/** P6's words for the coded values of a column (the file keeps codes), by the column's name. */
export const CODE_WORDS: Record<string, Record<string, string>> = {
  priority_type: { PT_Top: 'Top', PT_High: 'High', PT_Normal: 'Normal', PT_Low: 'Low', PT_Lowest: 'Lowest' },
  status_code: STATUS_WORDS,
  task_type: { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_LOE: 'Level of Effort', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_WBS: 'WBS Summary' },
  complete_pct_type: { CP_Drtn: 'Duration', CP_Phys: 'Physical', CP_Units: 'Units' },
  duration_type: { DT_FixedDUR2: 'Fixed Duration & Units', DT_FixedQty: 'Fixed Units', DT_FixedDrtn: 'Fixed Duration & Units/Time', DT_FixedRate: 'Fixed Units/Time' },
  pred_type: { PR_FS: 'Finish to Start', PR_SS: 'Start to Start', PR_FF: 'Finish to Finish', PR_SF: 'Start to Finish' },
  rsrc_type: { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' },
};
/** The progress fields transfer_progress can change, by P6's names (the remaining duration in days of the activity's calendar). */
export const PROGRESS_FIELDS: Record<string, string> = {
  act_start_date: 'Actual Start', act_end_date: 'Actual Finish', phys_complete_pct: 'Physical % Complete', remain_drtn_hr_cnt: 'Remaining Duration (days)', expect_end_date: 'Expected Finish',
  suspend_date: 'Suspend Date', resume_date: 'Resume Date', status_code: 'Activity Status', act_work_qty: 'Actual Labor Units', remain_work_qty: 'Remaining Labor Units', act_equip_qty: 'Actual Nonlabor Units', remain_equip_qty: 'Remaining Nonlabor Units',
};
