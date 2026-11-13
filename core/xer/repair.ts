// Repairs for a file opened leniently (MCP open_file lenient: true): what can be fixed without guessing, so the next
// save is a file P6 imports. A key column whose name is misspelled is renamed when its values are unique ids; empty,
// missing and duplicated keys get fresh ids where nothing in the file points at them. What cannot be fixed safely
// is reported, not touched.
import { KEYS, refTarget, type Db, type Row } from '../db.ts';
import { knownFields } from './schema.ts';
import { sameRow, suggest, wordOf } from './validate.ts';
import { namesText, plural } from '../notes.ts';

export interface Repairs { repaired: string[]; not_repaired: string[] }

export function repairKeys(db: Db): Repairs {
  const out: Repairs = { repaired: [], not_repaired: [] };
  for (const t of Object.values(db.tables)) {
    const key = KEYS[t.name];
    if (!key || !t.rows.length) continue;
    // is the table's key used by another field of the file? then its ids cannot be renumbered
    const referenced = Object.values(db.tables).some((o) => o.fields.some((f) => refTarget(f, o.name) === t.name && o.rows.some((r) => r[f])));
    if (!t.fields.includes(key)) {
      const kf = knownFields(t.name);
      const cand = suggest(key, t.fields.filter((f) => !kf.has(f) && !f.startsWith('_')));
      const vals = cand ? t.rows.map((r) => r[cand] ?? '') : [];
      if (cand && vals.every(Boolean) && new Set(vals).size === vals.length) {
        t.fields[t.fields.indexOf(cand)] = key;
        for (const r of t.rows) { r[key] = r[cand]; delete r[cand]; }
        out.repaired.push(`${t.name}: column "${cand}" renamed ${key} (its ${vals.length} values are unique ids).`);
        continue;
      }
      if (referenced) { out.not_repaired.push(`${t.name} has no ${key} column${cand ? ` ("${cand}" has empty or repeated values)` : ''}, and other tables point at its rows, so new ids would break those links.`); continue; }
      t.fields.unshift(key);
      if (cand) out.not_repaired.push(`${t.name}: column "${cand}" was not taken as ${key} (empty or repeated values); fresh ids were given instead.`);
    }
    // empty and repeated keys: fresh ids (a repeated id that something points at is ambiguous: left alone)
    let next = t.rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);
    const seen = new Set<string>();
    let minted = 0, dup = 0;
    const first = new Map<string, Row>(), ignored: Row[] = [];
    for (const r of t.rows) {
      const v = r[key] ?? '';
      if (v && !seen.has(v)) { seen.add(v); first.set(v, r); continue; }
      // the same row twice (every field equal) is one row: the copy is ignored, nothing is lost
      if (v && first.has(v) && sameRow(first.get(v)!, r)) { ignored.push(r); continue; }
      if (v && referenced) { dup++; continue; }
      r[key] = String(++next); seen.add(r[key]); minted++;
    }
    if (ignored.length) {
      const gone = new Set(ignored);
      t.rows = t.rows.filter((r) => !gone.has(r));
      const who = t.name === 'TASK' ? `Activity ${ignored.length === 1 ? 'ID' : 'IDs'} ${namesText(ignored.map((r) => r.task_code || r.task_id))}` : `id ${namesText(ignored.map((r) => r[key]))}`;
      out.repaired.push(`${plural(ignored.length, `identical duplicate ${wordOf(t.name)} row`)} ${ignored.length === 1 ? 'was' : 'were'} ignored (${who}): the same row twice is one row.`);
    }
    if (minted) out.repaired.push(`${plural(minted, wordOf(t.name))} with an empty, missing or repeated id ${minted === 1 ? 'was' : 'were'} given a fresh id.`);
    if (dup) out.not_repaired.push(`${plural(dup, `${wordOf(t.name)} row`)} ${dup === 1 ? 'repeats' : 'repeat'} an id that other rows point at and ${dup === 1 ? 'differs' : 'differ'} from ${dup === 1 ? 'its' : 'their'} twin, so which row is meant cannot be told: ${dup === 1 ? 'it was' : 'they were'} left (P6 refuses repeated ids). Compare them with read_table, then keep one.`);
  }
  return out;
}
