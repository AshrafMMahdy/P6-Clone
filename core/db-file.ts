// Database file format: JSON Lines, so a database of any size is saved and loaded in pieces (one JavaScript string
// cannot exceed ~512 MB, which a few large XER imports would). Line 1: {"p6clone":2, meta, ui}; then per table a
// {"table", fields} line followed by {"rows"} lines of at most ROWS_PER_LINE rows.
import type { Db } from './db.ts';

const ROWS_PER_LINE = 5000;

export function dbToLines(db: Db, ui: unknown): string[] {
  const { tables, ...meta } = db;
  const out = [JSON.stringify({ p6clone: 2, meta, ui })];
  for (const [name, t] of Object.entries(tables)) {
    out.push(JSON.stringify({ table: name, fields: t.fields }));
    for (let i = 0; i < t.rows.length; i += ROWS_PER_LINE) out.push(JSON.stringify({ rows: t.rows.slice(i, i + ROWS_PER_LINE) }));
  }
  return out;
}

export function linesToDb(lines: string[]): { db: Db; ui: unknown } {
  const first = JSON.parse(lines[0]);
  if (first.p6clone !== 2) return { db: first.db, ui: first.ui }; // version 1: the whole database on one line
  const db = { ...first.meta, tables: {} } as Db;
  let cur: Db['tables'][string] | undefined;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const x = JSON.parse(lines[i]);
    if (x.table) db.tables[x.table] = cur = { name: x.table, fields: x.fields, rows: [] };
    else if (x.rows && cur) for (const r of x.rows) cur.rows.push(r);
  }
  return { db, ui: first.ui };
}
