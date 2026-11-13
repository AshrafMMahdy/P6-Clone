// What an edit changed, read from the undo journal the edit was recorded in: per activity (or relationship, resource ...) the field, the old value and the new one, so the answer can say
// "A1010 duration: 8 -> 10 days". Only what a person sets is listed (names, durations, dates they gave, status, constraints, calendars, resource limits ...), never the dates the scheduler works out.
import { ABSENT, type Journal } from '../journal.ts';
import type { Db, Row } from '../db.ts';
import { dayHours } from './units.ts';
import { cstrName, namesText } from '../notes.ts';
import { parseClndrDataLeniently } from '../calendar/clndr-data.ts';

export interface FieldChange { id: string; field: string; old: string | number | null; new: string | number | null }
type Obj = Record<string, unknown>;

/** P6's words for the coded values an edit can change (the file keeps codes). */
const WORDS: Record<string, Record<string, string>> = {
  priority_type: { PT_Top: 'Top', PT_High: 'High', PT_Normal: 'Normal', PT_Low: 'Low', PT_Lowest: 'Lowest' },
  status_code: { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' },
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
};
/** The fields of the other rows an edit can change, by the name P6 gives them (a column not here is named by its words). */
const OTHER_FIELDS: Record<string, string> = {
  proj_short_name: 'Project ID', proj_name: 'Project Name', last_recalc_date: 'Data Date', plan_start_date: 'Planned Start', plan_end_date: 'Must Finish By', clndr_id: 'Default Calendar',
  rsrc_name: 'Resource Name', rsrc_short_name: 'Resource ID', rsrc_type: 'Resource Type', max_qty_per_hr: 'Max Units/Time (units a day)', cost_per_qty: 'Price / Unit', def_qty_per_hr: 'Units / Time',
  clndr_name: 'Calendar Name', day_hr_cnt: 'Hours per Day', week_hr_cnt: 'Hours per Week', wbs_name: 'WBS Name', wbs_short_name: 'WBS Code', task_name: 'Activity Name',
  target_qty: 'Budgeted Units', remain_qty: 'Remaining Units', act_reg_qty: 'Actual Regular Units', cost_per_qty_rate: 'Price / Unit',
};
const humanize = (column: string): string => { const w = column.replace(/_(id|flag|cnt|date|num)$/, '').split('_').filter(Boolean); return w.length ? w[0][0].toUpperCase() + w.join(' ').slice(1) : column; };
const fieldName = (column: string): string => OTHER_FIELDS[column] ?? humanize(column);
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
export function describeChanges(db: Db, j: Journal, hoursPerDay = 8): { changes: FieldChange[]; datesAffected: boolean } {
  const all: FieldChange[] = [];
  let datesAffected = false;
  const dh = dayHours(db, 8, true);
  const tasks = new Map<string, Row>();
  const task = (id: string) => { if (!tasks.size) for (const t of db.tables.TASK?.rows ?? []) tasks.set(t.task_id, t); return tasks.get(id); };
  const projects = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
  const calendars = new Map((db.tables.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c]));
  const resources = new Map((db.tables.RSRC?.rows ?? []).map((r) => [r.rsrc_id, r]));
  const gone = new Map<string, Row>();
  /** An activity as the agent names it: its Activity ID, and the baseline it is a row of when it is one (an edit reaches a stored baseline's copy, e.g. replace_text). */
  const taskName = (t: Obj): string => { const p = projects.get(text(t.proj_id)); return p?._baseline_of ? `${text(t.task_code)} in baseline ${p.proj_short_name}` : text(t.task_code); };
  const code = (id: string) => { const t = task(id) ?? gone.get(id); return t ? taskName(t) : id; };
  const rsrcName = (id: unknown) => text(resources.get(text(id))?.rsrc_short_name ?? id);
  const out = (c: FieldChange) => all.push(c);
  // rows added or removed: a table made or dropped by this edit (its rows), or an array that grew or shrank
  const added = new Set<unknown>(), seen = new Set<unknown>();
  for (const [row, keys] of j.fields) {
    if (row !== db.tables) continue;
    for (let i = 0; i < keys.length; i += 2) {
      const k = keys[i] as string, was = keys[i + 1] as { rows?: Obj[] } | typeof ABSENT, now = db.tables[k] as { rows?: Obj[] } | undefined;
      if (was === ABSENT && now?.rows) for (const x of now.rows) { added.add(x); seen.add(x); add('added', x); }
      else if (was !== ABSENT && was?.rows && !now) for (const x of was.rows) { seen.add(x); add('removed', x); }
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
    if (row === db.tables) continue; // said above
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
        const name = (v: string) => (v === '' ? null : k === 'clndr_id' ? text(calendars.get(v)?.clndr_name ?? v) : wordOf(k, v));
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
      // any other row (a resource, an assignment, a calendar, a project ...): named by what the agent uses (Resource ID, calendar name, Project ID), the fields as P6 names them
      const assignment = 'rsrc_id' in r && 'task_id' in r && 'taskrsrc_id' in r, rate = 'rsrc_rate_id' in r;
      const id = assignment ? `${code(text(r.task_id))} ${rsrcName(r.rsrc_id)}` : rate ? rsrcName(r.rsrc_id) : text(r.rsrc_short_name ?? r.proj_short_name ?? r.wbs_short_name ?? r.clndr_name ?? r.actv_code_name ?? r.udf_type_label ?? r.task_pred_id ?? r.taskrsrc_id ?? r.rsrc_id ?? '');
            for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k.startsWith('_') || /(?:^|_)(?:early|late|total_float|free_float|reend|restart|rem_late|rem_early|scd_)/.test(k)) continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        if (('proj_short_name' in r && /^(last_recalc_date|plan_start_date|plan_end_date)$/.test(k)) || ('clndr_name' in r && k === 'clndr_data')) datesAffected = true; // the data date, the planned start, Must Finish By and the work time of a calendar decide the dates F9 gives
        if (assignment && /^(target|remain|act)_(qty|cost|equip_qty|drtn|work_qty|ot_qty|reg_qty)|^remain_qty_per_hr$|_per_hr_rate$/.test(k) && k !== 'target_qty_per_hr') continue; // the quantities and costs worked out from the units a day
        if (assignment && k === 'target_qty_per_hr') { const hpd = hoursPerDay; out({ id, field: 'Budgeted Units/Time (units a day)', old: was === '' ? null : Math.round(Number(was) * hpd * 100) / 100, new: Math.round(Number(now) * hpd * 100) / 100 }); continue; }
        if (k === 'clndr_data' && 'clndr_name' in r) { for (const c of calendarChange(was, now)) out({ id, ...c }); continue; }
        if (k === 'max_qty_per_hr' && ('rsrc_name' in r || rate)) { const hpd = hoursPerDay; out({ id, field: OTHER_FIELDS[k], old: was === '' ? null : Math.round(Number(was) * hpd * 100) / 100, new: Math.round(Number(now) * hpd * 100) / 100 }); continue; }
        const name = (v: string) => (v === '' ? null : k === 'clndr_id' ? text(calendars.get(v)?.clndr_name ?? v) : wordOf(k, v));
        out({ id, field: fieldName(k), old: name(was), new: name(now) });
      }
    }
  }
  // each change once (the same row can be journalled twice, a resource's limit lives on the resource and on its price row)
  const seenChange = new Set<string>();
  return { changes: all.filter((c) => { const key = `${c.id}\u0000${c.field}\u0000${c.old}\u0000${c.new}`; if (seenChange.has(key)) return false; seenChange.add(key); return true; }), datesAffected };
}
