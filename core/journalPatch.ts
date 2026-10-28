// What a change did to a database, as data: made from the journals a change left (journal.ts) in the process that ran it, applied in
// another as one change of its own (so it is undoable there, key by key). A tool that runs on a COPY of the project in a worker thread
// hands its changes back this way instead of the whole project. A change that the journals cannot place exactly (an object that is not the
// database, a table or a row of one) is handed back as every table in full: never a wrong patch.
import { ABSENT, type Journal } from './journal.ts';
import type { Db, Row, Table } from './db.ts';

export interface TablePatch {
  /** the whole table (rows replaced, or a table that is new) */
  full?: { fields: string[]; rows: Row[] };
  /** columns changed */
  fields?: string[];
  /** rows added at the end */
  append?: Row[];
  /** rows changed in place: [index, keys set, keys removed] */
  set?: [number, Record<string, string>, string[]][];
}
export interface DbPatch { header?: Db['header'] | null; tables: Record<string, TablePatch>; allTables?: boolean }

const same = (a: unknown[], b: unknown[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/** The patch that turns the database as it was before the journals' changes into what it is now. `db` is the real database (not a view). */
export function patchFrom(db: Db, journals: Journal[]): DbPatch {
  const fields = new Map<object, { keys: Set<PropertyKey>; absent: Set<PropertyKey> }>();
  const arrays = new Map<unknown[], unknown[]>();
  for (const j of journals) {
    for (const [o, list] of j.fields) {
      let e = fields.get(o); if (!e) fields.set(o, (e = { keys: new Set(), absent: new Set() }));
      for (let i = 0; i < list.length; i += 2) { const k = list[i] as PropertyKey; if (!e.keys.has(k)) { e.keys.add(k); if (list[i + 1] === ABSENT) e.absent.add(k); } }
    }
    for (const [a, before] of j.arrays) if (!arrays.has(a)) arrays.set(a, before);
  }
  const everything = (): DbPatch => ({ header: db.header ?? null, allTables: true, tables: Object.fromEntries(Object.entries(db.tables).map(([n, t]) => [n, { full: { fields: t.fields, rows: t.rows } }])) });
  const out: DbPatch = { tables: {} };
  const pending = new Set(fields.keys());
  const tableObjs = new Map<object, string>(Object.entries(db.tables).map(([n, t]) => [t, n]));
  // the database itself, its header, and its table list
  if (pending.delete(db)) { const e = fields.get(db)!; for (const k of e.keys) if (k === 'header') out.header = db.header ?? null; else if (k !== 'tables') return everything(); }
  if (db.header && arrays.has(db.header.raw)) out.header = db.header;
  if (db.header && pending.delete(db.header)) out.header = db.header;
  if (pending.delete(db.tables)) { for (const k of fields.get(db.tables)!.keys) { const t = db.tables[k as string]; if (t) out.tables[k as string] = { full: { fields: t.fields, rows: t.rows } }; else return everything(); } }
  for (const [name, t] of Object.entries(db.tables) as [string, Table][]) {
    const tp: TablePatch = out.tables[name] ?? {};
    if (pending.delete(t)) { tp.full = { fields: t.fields, rows: t.rows }; }
    if (!tp.full) {
      if (arrays.has(t.fields)) tp.fields = t.fields;
      const before = arrays.get(t.rows);
      if (before) {
        if (t.rows.length >= before.length && same(before, t.rows)) tp.append = t.rows.slice(before.length);
        else tp.full = { fields: t.fields, rows: t.rows };
      }
    }
    if (!tp.full) {
      const limit = tp.append ? t.rows.length - tp.append.length : t.rows.length;
      for (let i = 0; i < limit; i++) {
        const row = t.rows[i];
        if (!pending.has(row)) continue;
        pending.delete(row);
        const e = fields.get(row)!, set: Record<string, string> = {}, del: string[] = [];
        for (const k of e.keys) { if (Object.prototype.hasOwnProperty.call(row, k)) set[k as string] = (row as Record<string, string>)[k as string]; else del.push(k as string); }
        (tp.set ??= []).push([i, set, del]);
      }
    }
    if (tp.full || tp.fields || tp.append?.length || tp.set?.length) out.tables[name] = tp;
  }
  // rows appended in this change (or tables sent in full) that were also written to afterwards travel whole; anything else we could not place
  if (pending.size) {
    const whole = new Set<object>();
    for (const tp of Object.values(out.tables)) { for (const r of tp.append ?? []) whole.add(r); for (const r of tp.full?.rows ?? []) whole.add(r); }
    for (const o of pending) if (!whole.has(o) && !tableObjs.has(o)) return everything();
  }
  return out;
}

export const isEmptyPatch = (p: DbPatch): boolean => !p.allTables && p.header === undefined && Object.keys(p.tables).length === 0;

/** Apply a patch to a database (a recording view, in a change). */
export function applyPatch(d: Db, p: DbPatch): void {
  if (p.header !== undefined) d.header = p.header ?? undefined;
  for (const [name, tp] of Object.entries(p.tables)) {
    let t = d.tables[name];
    if (tp.full) {
      if (t) { t.fields = tp.full.fields; t.rows = tp.full.rows; } else d.tables[name] = { name, fields: tp.full.fields, rows: tp.full.rows };
      continue;
    }
    if (!t) continue;
    if (tp.fields) t.fields = tp.fields;
    if (tp.set) for (const [i, set, del] of tp.set) { const r = t.rows[i]; if (!r) continue; for (const k of Object.keys(set)) r[k] = set[k]; for (const k of del) delete r[k]; }
    if (tp.append) for (const r of tp.append) t.rows.push(r);
  }
}
