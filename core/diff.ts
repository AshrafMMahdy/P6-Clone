import { KEYS, type Db, type Row } from './db.ts';

export interface DiffEntry { table: string; key: string; kind: 'added' | 'removed' | 'changed'; field?: string; a?: string; b?: string }

/** Row identity: table key, else activity code / names for readability, else all values. */
function rowKey(table: string, r: Row): string {
  const k = KEYS[table];
  if (k && r[k]) return r[k];
  if (table === 'TASKACTV') return `${r.task_id}/${r.actv_code_type_id}`;
  if (table === 'UDFVALUE') return `${r.udf_type_id}/${r.fk_id}`;
  return Object.values(r).join('|');
}

/** Field-level differences between two databases (b relative to a). */
export function diffDbs(a: Db, b: Db, opts: { ignoreFields?: string[] } = {}): DiffEntry[] {
  const ignore = new Set(opts.ignoreFields ?? []);
  const out: DiffEntry[] = [];
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  for (const t of names) {
    const ma = new Map((a.tables[t]?.rows ?? []).map((r) => [rowKey(t, r), r]));
    const mb = new Map((b.tables[t]?.rows ?? []).map((r) => [rowKey(t, r), r]));
    for (const [k, ra] of ma) {
      const rb = mb.get(k);
      if (!rb) { out.push({ table: t, key: k, kind: 'removed' }); continue; }
      for (const f of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (ignore.has(f) || f.startsWith('_')) continue;
        const va = ra[f] ?? '', vb = rb[f] ?? '';
        if (va !== vb) out.push({ table: t, key: k, kind: 'changed', field: f, a: va, b: vb });
      }
    }
    for (const k of mb.keys()) if (!ma.has(k)) out.push({ table: t, key: k, kind: 'added' });
  }
  return out;
}
