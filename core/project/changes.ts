// What an edit changed, read from the undo journal the edit was recorded in: per activity (or relationship, resource ...) the field, the old value and the new one, so the answer can say
// "A1010 duration: 8 -> 10 days". Only what a person sets is listed (names, durations, dates they gave, status, constraints, calendars, resource limits ...), never the dates the scheduler works out.
import { ABSENT, type Journal } from '../journal.ts';
import type { Db, Row } from '../db.ts';
import { dayHours } from './units.ts';

export interface FieldChange { id: string; field: string; old: string | number | null; new: string | number | null }
type Obj = Record<string, unknown>;

/** The fields of an activity a person sets, with the name the answer gives them (hours as days on the activity's calendar). */
const TASK_FIELDS: Record<string, { label: string; days?: boolean }> = {
  task_name: { label: 'name' }, task_code: { label: 'Activity ID' }, target_drtn_hr_cnt: { label: 'duration (days)', days: true }, remain_drtn_hr_cnt: { label: 'remaining duration (days)', days: true },
  act_start_date: { label: 'actual start' }, act_end_date: { label: 'actual finish' }, status_code: { label: 'status' }, task_type: { label: 'type' }, clndr_id: { label: 'calendar' }, wbs_id: { label: 'WBS' },
  cstr_type: { label: 'constraint' }, cstr_date: { label: 'constraint date' }, cstr_type2: { label: 'secondary constraint' }, cstr_date2: { label: 'secondary constraint date' },
  complete_pct_type: { label: 'percent complete type' }, phys_complete_pct: { label: 'physical percent complete' }, priority_type: { label: 'priority' },
};
/** The fields that decide the dates F9 gives: an edit of one leaves the saved dates not current. */
const DATE_DRIVING = new Set(['target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'act_start_date', 'act_end_date', 'status_code', 'task_type', 'clndr_id', 'cstr_type', 'cstr_date', 'cstr_type2', 'cstr_date2', 'lag_hr_cnt', 'pred_type']);
const text = (v: unknown): string => (v === ABSENT || v == null ? '' : String(v));

/** The changes a journal holds, and whether any of them can change the dates F9 gives. */
export function describeChanges(db: Db, j: Journal): { changes: FieldChange[]; datesAffected: boolean } {
  const out: FieldChange[] = [];
  let datesAffected = false;
  const dh = dayHours(db, 8, true);
  const tasks = new Map<string, Row>();
  const task = (id: string) => { if (!tasks.size) for (const t of db.tables.TASK?.rows ?? []) tasks.set(t.task_id, t); return tasks.get(id); };
  const code = (id: string) => task(id)?.task_code ?? id;
  // rows added or removed (an array that grew or shrank)
  const added = new Set<unknown>();
  for (const [arr, before] of j.arrays) {
    const was = new Set(before as Obj[]), now = new Set(arr as Obj[]);
    for (const r of arr as Obj[]) if (!was.has(r)) { added.add(r); add('added', r); }
    for (const r of before as Obj[]) if (!now.has(r)) add('removed', r);
  }
  function add(what: 'added' | 'removed', r: Obj) {
    if ('task_code' in r && 'task_id' in r && 'proj_id' in r && !('pred_task_id' in r)) { out.push({ id: text(r.task_code), field: 'activity', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }); datesAffected = true; }
    else if ('pred_task_id' in r) { out.push({ id: `${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, field: 'relationship', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' }); datesAffected = true; }
    else if ('rsrc_id' in r && 'task_id' in r) out.push({ id: `${code(text(r.task_id))} ${text((db.tables.RSRC?.rows ?? []).find((x) => x.rsrc_id === r.rsrc_id)?.rsrc_short_name ?? r.rsrc_id)}`, field: 'resource assignment', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' });
    else if ('rsrc_short_name' in r) out.push({ id: text(r.rsrc_short_name), field: 'resource', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' });
    else if ('wbs_short_name' in r) out.push({ id: text(r.wbs_short_name), field: 'WBS', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' });
    else if ('clndr_name' in r) out.push({ id: text(r.clndr_name), field: 'calendar', old: what === 'added' ? null : 'exists', new: what === 'added' ? 'added' : 'deleted' });
  }
  // fields a person set on a row that existed
  for (const [row, keys] of j.fields) {
    const r = row as Obj;
    if (added.has(r) && !('task_code' in r)) continue; // a row made by this edit is said as added
    if ('task_code' in r && 'task_id' in r && 'proj_id' in r && !('pred_task_id' in r)) {
      if (added.has(r)) continue;
      const hpd = dh.task(r as Row);
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string, f = TASK_FIELDS[k];
        if (!f) continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        const id = text(r.task_code);
        out.push({ id: k === 'task_code' ? text(keys[i + 1]) : id, field: f.label, old: f.days ? (was === '' ? null : Math.round((Number(was) / hpd) * 100) / 100) : was, new: f.days ? Math.round((Number(now) / hpd) * 100) / 100 : now });
        if (DATE_DRIVING.has(k)) datesAffected = true;
      }
    } else if ('pred_task_id' in r) {
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k !== 'lag_hr_cnt' && k !== 'pred_type') continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was === now) continue;
        out.push({ id: `${code(text(r.pred_task_id))} ${text(r.pred_type || 'PR_FS').slice(3)} ${code(text(r.task_id))}`, field: k === 'lag_hr_cnt' ? 'lag (hours)' : 'type', old: was, new: now });
        datesAffected = true;
      }
    } else {
      // any other row (a resource, an assignment, a calendar, a project ...): the id is its short name or code, the fields as they are named in the file
      const id = text(r.rsrc_short_name ?? r.proj_short_name ?? r.wbs_short_name ?? r.clndr_name ?? r.actv_code_name ?? r.udf_type_label ?? r.task_pred_id ?? r.taskrsrc_id ?? r.rsrc_id ?? '');
      for (let i = 0; i < keys.length; i += 2) {
        const k = keys[i] as string;
        if (k.startsWith('_') || /(?:^|_)(?:early|late|total_float|free_float|reend|restart|rem_late|rem_early|scd_)/.test(k)) continue;
        const was = text(keys[i + 1]), now = text(r[k]);
        if (was !== now) out.push({ id, field: k, old: was, new: now });
      }
    }
  }
  return { changes: out, datesAffected };
}
