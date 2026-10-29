// Database file format: JSON Lines, so a database of any size is saved and loaded in pieces (one JavaScript string
// cannot exceed ~512 MB, which a few large XER imports would). Line 1: {"p6clone":2, meta, ui}; then per table a
// {"table", fields} line followed by {"rows"} lines of at most ROWS_PER_LINE rows.
import { ValuePool, type Db, type PoolColumn } from './db.ts';

const ROWS_PER_LINE = 1000; // (older files have up to 5000; any number reads the same)

/** The lines of a database file, made one at a time (the whole file never has to be in memory as text). */
export function* dbLines(db: Db, ui: unknown): Generator<string> {
  const { tables, ...meta } = db;
  yield JSON.stringify({ p6clone: 2, meta, ui });
  for (const [name, t] of Object.entries(tables)) {
    yield JSON.stringify({ table: name, fields: t.fields });
    for (let i = 0; i < t.rows.length; i += ROWS_PER_LINE) yield JSON.stringify({ rows: t.rows.slice(i, i + ROWS_PER_LINE) });
  }
}

export const dbToLines = (db: Db, ui: unknown): string[] => [...dbLines(db, ui)];

/** Reads a database file line by line (lines can be dropped once added). Repeated values share one string. */
export class DbReader {
  private db: Db | undefined;
  private ui: unknown;
  private cur: Db['tables'][string] | undefined;
  private cols = new Map<string, PoolColumn>();
  private pool = new ValuePool();
  private v1 = false;

  add(line: string): void {
    if (!line || this.v1) return;
    const x = JSON.parse(line);
    if (!this.db) {
      if (x.p6clone !== 2) { this.db = x.db; this.ui = x.ui; this.v1 = true; return; } // version 1: the whole database on one line
      this.db = { ...x.meta, tables: {} } as Db;
      this.ui = x.ui;
    } else if (x.table) {
      this.db.tables[x.table] = this.cur = { name: x.table, fields: x.fields, rows: [] };
      this.cols = new Map();
    } else if (x.rows && this.cur) {
      for (const r of x.rows) {
        for (const k in r) {
          const v = r[k];
          if (typeof v !== 'string' || !v) continue;
          let c = this.cols.get(k);
          if (!c) this.cols.set(k, (c = this.pool.column()));
          r[k] = this.pool.get(c, v);
        }
        this.cur.rows.push(r);
      }
    }
  }

  finish(): { db: Db; ui: unknown } {
    return { db: this.db as Db, ui: this.ui };
  }
}

export function linesToDb(lines: Iterable<string>): { db: Db; ui: unknown } {
  const r = new DbReader();
  for (const l of lines) r.add(l);
  return r.finish();
}
