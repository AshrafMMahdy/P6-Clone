// Repairs for a file opened leniently (MCP open_file lenient: true): what can be fixed without guessing, so the next
// save is a file P6 imports. A key column whose name is misspelled is renamed when its values are unique ids; empty,
// missing and duplicated keys get fresh ids where nothing in the file points at them. What cannot be fixed safely
// is reported, not touched.
import { KEYS, refTarget, type Db } from '../db.ts';
import { knownFields } from './schema.ts';
import { suggest } from './validate.ts';

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
    for (const r of t.rows) {
      const v = r[key] ?? '';
      if (v && !seen.has(v)) { seen.add(v); continue; }
      if (v && referenced) { dup++; continue; }
      r[key] = String(++next); seen.add(r[key]); minted++;
    }
    if (minted) out.repaired.push(`${t.name}: ${minted} row(s) with an empty, missing or repeated ${key} given fresh ids.`);
    if (dup) out.not_repaired.push(`${t.name}: ${dup} row(s) repeat a ${key} that other tables point at; which row is meant cannot be told, so they were left (P6 refuses repeated ids).`);
  }
  return out;
}
