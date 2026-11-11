// What an apply writes down beside each activity it changed (owner 2026-11-10): user-defined fields P6 can show as columns, so the
// plan's reader sees which durations the reasoner or the crashing changed, from what, and why, without the chat. Written in the same
// undoable change as the apply itself, so undo takes them back. A field that is not in the project yet is added. The ORIGINAL duration is
// written once: an activity that already holds one keeps it (a second apply must not turn "10" into the crashed "6"), the change is
// always the latest duration minus that original, the note the latest change, the rank the latest order. Values an earlier run wrote on
// activities this run did not touch stay (nothing is cleared); fields_written says how many (kept_from_earlier).
import { rows, type Db, type Row } from '../db.ts';
import { dayHours } from '../project/units.ts';
import { applyOps } from '../project/ops.ts';

/** An activity whose duration the run changed: its task_id, Activity ID, its project's ID, the remaining days before and after (of its
 *  own calendar's days, to 2 decimals), the crash cost. */
export interface FieldChange { task_id: string; id: string; project: string; from_days: number; to_days: number; cost: number }
/** An activity the leveler was given in a placement order: 1 = placed first. */
export interface FieldRank { task_id: string; id: string; project: string; rank: number }

const FIELDS = { original: 'WHIQ original duration (d)', change: 'WHIQ duration change (d)', note: 'WHIQ change note', rank: 'WHIQ leveling rank' } as const;
/** Today's date as YYYY-MM-DD, on the clock of the machine the clone runs on. */
export const today = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const r2 = (v: number) => Math.round(v * 100) / 100;
/** An activity's change as the fields show it, from the HOURS: the remaining hours before and the hours actually written, in days of the
 *  activity's own calendar, to 2 decimals. One function for crash_schedule and optimize_schedule, so both say the same of the same write. */
export function fieldChange(db: Db, task: Row, project: string | undefined, fromHours: number, toHours: number, cost: number, hoursPerDay: number): FieldChange {
  const h = dayHours(db, hoursPerDay, true).task(task);
  return { task_id: task.task_id, id: task.task_code, project: project as string, from_days: r2(fromHours / h), to_days: r2(toHours / h), cost: r2(cost) };
}
const money = (v: number) => r2(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** The UDF data type each field needs, as add_udf names it (made as that when it does not exist), and the logical types of the file that hold it. */
const NEEDS: Record<keyof typeof FIELDS, { type: 'number' | 'integer' | 'text'; is: RegExp }> = {
  original: { type: 'number', is: /^FT_FLOAT/ }, change: { type: 'number', is: /^FT_FLOAT/ }, note: { type: 'text', is: /^FT_TEXT$/ }, rank: { type: 'integer', is: /^(FT_INT$|FT_FLOAT)/ }, // (a whole-number rank fits a number field exactly: an integer field comes back from Microsoft Project as one)
};
const typeOf = (db: Db, label: string) => rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label.toLowerCase() === label.toLowerCase());
const typeWords = (logical: string) => (/^FT_FLOAT/.test(logical) ? 'number' : logical === 'FT_INT' ? 'integer' : logical === 'FT_TEXT' ? 'text' : logical === 'FT_MONEY' ? 'cost' : /DATE/.test(logical) ? 'date' : logical === 'FT_STATICTYPE' ? 'indicator' : logical.replace(/^FT_/, '').toLowerCase());

/** A field of the project that has one of the fields' labels with another data type: an apply would fail half way (a text value into a
 *  number field), so it is refused before anything is changed. Only the fields this run would write are looked at. */
export function whiqFieldClash(db: Db, o: { changes: unknown[]; ranks?: unknown[] }): { field: string; found: string; needed: string; message: string; hint: string } | undefined {
  const writes: (keyof typeof FIELDS)[] = [...(o.changes.length ? (['original', 'change', 'note'] as const) : []), ...(o.ranks?.length ? (['rank'] as const) : [])];
  for (const k of writes) {
    const u = typeOf(db, FIELDS[k]);
    if (!u || NEEDS[k].is.test(u.logical_data_type)) continue;
    const found = typeWords(u.logical_data_type);
    return { field: u.udf_type_label, found, needed: NEEDS[k].type,
      message: `The project already has an activity field "${u.udf_type_label}" of type ${found}; the apply writes ${NEEDS[k].type === 'text' ? 'text' : `a ${NEEDS[k].type}`} into a field of that name, and nothing was changed.`,
      hint: `Rename or remove that field with the edit tool (update_udf {"udf": "${u.udf_type_label}", "new_name": ...} or delete_udf {"udf": "${u.udf_type_label}"}) and apply again, or apply the proposal's ops with the edit tool without these fields.` };
  }
  return undefined;
}

/** The edit operations that write the fields, and what they write (`fields_written`: each field with the number of activities written
 *  now, and kept_from_earlier: the activities that still hold a value an earlier run wrote and this one did not).
 *  who: how the note names the run ("Crashed by the schedule reasoner"); on: the date of the run (YYYY-MM-DD). */
export function whiqFieldOps(db: Db, o: { changes: FieldChange[]; ranks?: FieldRank[]; who: string; on: string; projIds?: string[] }) {
  const ops: Record<string, unknown>[] = [], written: { name: string; activities: number; kept_from_earlier: number }[] = [];
  /** the value each activity holds of a field now (empty = none) */
  const mine = o.projIds ? new Set(rows(db, 'TASK').filter((t) => o.projIds!.includes(t.proj_id)).map((t) => t.task_id)) : null; // the run's own projects (a file can hold others: their values are not this run's to count)
  const held = (label: string) => { const u = typeOf(db, label); return new Map(u ? rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === u.udf_type_id && (!mine || mine.has(v.fk_id))).map((v) => [v.fk_id, v] as const) : []); };
  const field = (key: keyof typeof FIELDS, values: { task_id: string; id: string; project: string; value: string | number }[]) => {
    const name = FIELDS[key], now = new Set(values.map((v) => v.task_id));
    const kept = [...held(name).keys()].filter((fk) => !now.has(fk)).length;
    if (values.length) {
      if (!typeOf(db, name)) ops.push({ op: 'add_udf', name, subject: 'activity', data_type: NEEDS[key].type });
      for (const v of values) ops.push({ op: 'set_udf', udf: name, value: v.value, activity: v.id, project: v.project });
    }
    if (values.length || kept) written.push({ name, activities: values.length, kept_from_earlier: kept });
  };
  const had = held(FIELDS.original);
  const origin = (c: FieldChange) => { const v = had.get(c.task_id); return v && v.udf_number !== '' && v.udf_number != null ? Number(v.udf_number) : undefined; };
  // the original: only where the activity has none yet (the first change's "before"); every later one is measured against it
  field('original', o.changes.filter((c) => origin(c) == null).map((c) => ({ task_id: c.task_id, id: c.id, project: c.project, value: r2(c.from_days) })));
  field('change', o.changes.map((c) => ({ task_id: c.task_id, id: c.id, project: c.project, value: r2(c.to_days - (origin(c) ?? c.from_days)) })));
  field('note', o.changes.map((c) => { const og = origin(c); return { task_id: c.task_id, id: c.id, project: c.project, value: `${o.who} ${o.on}: ${r2(c.from_days)} d to ${r2(c.to_days)} d, cost ${money(c.cost)}${og != null && og !== r2(c.from_days) ? ` (original ${r2(og)} d)` : ''}` }; }));
  field('rank', (o.ranks ?? []).map((r) => ({ task_id: r.task_id, id: r.id, project: r.project, value: r.rank })));
  return { ops, fields_written: written };
}

/** What a run hands to whoever applies it so the fields can be written (the tool answers it under `field_data: true`; the desktop screens pass that). */
export interface FieldData { changes: FieldChange[]; ranks?: FieldRank[]; who: string }
/** Write the fields into `d` (inside the apply's own undoable change): the one function the tools' apply and the screens' Apply both call.
 *  Returns what it wrote (fields_written); throws an Error in words when a field of the project has another data type (nothing is written). */
export function writeWhiqFields(d: Db, data: FieldData, o: { hoursPerDay?: number; calendarDays?: boolean; projIds?: string[] } = {}) {
  const clash = whiqFieldClash(d, data);
  if (clash) throw new Error(`${clash.message} ${clash.hint}`);
  const w = whiqFieldOps(d, { ...data, on: today(), projIds: o.projIds });
  const r = applyOps(d, w.ops, { hoursPerDay: o.hoursPerDay, calendarDays: o.calendarDays });
  if (!r.ok) throw new Error(r.error!.message);
  return w.fields_written;
}
