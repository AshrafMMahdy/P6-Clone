// What an apply writes down beside each activity it changed (owner 2026-11-10): user-defined fields P6 can show as columns, so the
// plan's reader sees which durations the reasoner or the crashing changed, from what, and why, without the chat. Written in the same
// undoable change as the apply itself, so undo takes them back. A field that is not in the project yet is added; a value from an earlier
// apply on the same activity is replaced (set_udf replaces the activity's value of a field).
import { rows, type Db } from '../db.ts';

/** An activity whose duration the run changed: its Activity ID, its project's ID, the remaining days before and after, the crash cost. */
export interface FieldChange { id: string; project: string; from_days: number; to_days: number; cost: number }
/** An activity the leveler was given in a placement order: 1 = placed first. */
export interface FieldRank { id: string; project: string; rank: number }

const FIELDS = { original: 'WHIQ original duration (d)', change: 'WHIQ duration change (d)', note: 'WHIQ change note', rank: 'WHIQ leveling rank' } as const;
/** Today's date as YYYY-MM-DD, on the clock of the machine the clone runs on. */
export const today = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const money = (v: number) => r2(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** The edit operations that write the fields, and what they write (`fields_written`: each field with the number of activities).
 *  who: how the note names the run ("Crashed by the schedule reasoner"); on: the date of the run (YYYY-MM-DD). */
export function whiqFieldOps(db: Db, o: { changes: FieldChange[]; ranks?: FieldRank[]; who: string; on: string }) {
  const has = (label: string) => rows(db, 'UDFTYPE').some((u) => u.table_name === 'TASK' && u.udf_type_label.toLowerCase() === label.toLowerCase());
  const ops: Record<string, unknown>[] = [], written: { name: string; activities: number }[] = [];
  const field = (name: string, type: 'number' | 'integer' | 'text', values: { id: string; project: string; value: string | number }[]) => {
    if (!values.length) return;
    if (!has(name)) ops.push({ op: 'add_udf', name, subject: 'activity', data_type: type });
    for (const v of values) ops.push({ op: 'set_udf', udf: name, value: v.value, activity: v.id, project: v.project });
    written.push({ name, activities: values.length });
  };
  const each = (value: (c: FieldChange) => string | number) => o.changes.map((c) => ({ id: c.id, project: c.project, value: value(c) }));
  field(FIELDS.original, 'number', each((c) => r2(c.from_days)));
  field(FIELDS.change, 'number', each((c) => r2(c.to_days - c.from_days)));
  field(FIELDS.note, 'text', each((c) => `${o.who} ${o.on}: ${r2(c.from_days)} d to ${r2(c.to_days)} d, cost ${money(c.cost)}`));
  field(FIELDS.rank, 'integer', (o.ranks ?? []).map((r) => ({ id: r.id, project: r.project, value: r.rank })));
  return { ops, fields_written: written };
}
