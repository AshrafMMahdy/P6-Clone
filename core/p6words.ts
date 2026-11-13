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
