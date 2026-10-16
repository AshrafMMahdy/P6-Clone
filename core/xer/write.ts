import { KEYS, refTarget, type Db, type Row } from '../db.ts';
import { encodeCp1252 } from '../encoding.ts';
import { formatDay } from '../dates.ts';
import { fieldsFor, variantsFor, tableOrderFor } from './schema.ts';

export interface WriteOptions {
  version: string;
  /** Projects to export; all when omitted. */
  projIds?: string[];
  user?: string;
  userName?: string;
  /** yyyy-mm-dd; today when omitted. */
  exportDate?: string;
  dbName?: string;
  currency?: string;
  /** Output text encoding. P6 writes windows-1252. */
  encoding?: 'windows-1252' | 'utf-8';
}

/** Child tables kept whenever their parent row is kept. */
const CHILD_OF: Record<string, string> = {
  RSRCRATE: 'rsrc_id', ROLERATE: 'role_id', RSRCROLE: 'rsrc_id', ACTVCODE: 'actv_code_type_id',
  PCATVAL: 'proj_catg_type_id', RCATVAL: 'rsrc_catg_type_id', RSRCRCAT: 'rsrc_id', SHIFTPER: 'shift_id',
};
const ALWAYS = new Set(['CURRTYPE']);

export function selectRows(db: Db, projIds?: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  if (!projIds) {
    for (const t of Object.values(db.tables)) out.set(t.name, t.rows);
    return out;
  }
  const projs = new Set(projIds);
  const kept = new Map<string, Set<string>>(); // table -> kept keys
  const keep = (t: string, r: Row) => {
    let arr = out.get(t);
    if (!arr) out.set(t, (arr = []));
    if (arr.includes(r)) return false;
    arr.push(r);
    const k = KEYS[t];
    if (k) {
      let s = kept.get(t);
      if (!s) kept.set(t, (s = new Set()));
      s.add(r[k]);
    }
    return true;
  };
  const isKept = (t: string, key: string) => kept.get(t)?.has(key) ?? false;

  // 1. project-scoped rows
  for (const t of Object.values(db.tables)) {
    if (t.name === 'TASKPRED') continue;
    if (ALWAYS.has(t.name)) { t.rows.forEach((r) => keep(t.name, r)); continue; }
    if (!t.fields.includes('proj_id')) continue;
    for (const r of t.rows) if (r.proj_id && projs.has(r.proj_id)) keep(t.name, r);
  }
  for (const r of db.tables.TASKPRED?.rows ?? []) {
    if (isKept('TASK', r.task_id) || isKept('TASK', r.pred_task_id)) keep('TASKPRED', r);
  }
  // 2. referenced dictionary rows, to fixpoint
  for (let changed = true; changed; ) {
    changed = false;
    for (const [t, rs] of [...out]) {
      const fields = db.tables[t]?.fields ?? [];
      for (const r of [...rs]) {
        for (const f of fields) {
          const target = refTarget(f, t);
          const v = r[f];
          if (!target || !v || isKept(target, v)) continue;
          if (t === 'TASKPRED' && (f === 'task_id' || f === 'pred_task_id' || f === 'pred_proj_id' || f === 'proj_id')) continue;
          const tk = KEYS[target];
          const hit = tk && db.tables[target]?.rows.find((x) => x[tk] === v);
          if (hit && (!hit.proj_id || projs.has(hit.proj_id) || target !== 'PROJECT') && keep(target, hit)) changed = true;
        }
      }
    }
    for (const [child, pf] of Object.entries(CHILD_OF)) {
      const parent = refTarget(pf);
      for (const r of db.tables[child]?.rows ?? []) if (parent && isKept(parent, r[pf]) && keep(child, r)) changed = true;
    }
  }
  return out;
}

function clean(v: string | undefined): string {
  // P6 itself leaves lone CRs inside memo values; only tabs/newlines would break the format.
  return v == null ? '' : v.replace(/\r\n|[\t\n]/g, ' ');
}

export function writeXer(db: Db, opts: WriteOptions): Uint8Array {
  const sel = selectRows(db, opts.projIds);
  const cur = opts.currency ?? db.tables.CURRTYPE?.rows[0]?.curr_short_name ?? 'USD';
  const lines: string[] = [[
    'ERMHDR', opts.version, opts.exportDate ?? formatDay(Date.now() / 60000), 'Project',
    opts.user ?? 'admin', opts.userName ?? 'admin', opts.dbName ?? 'dbxDatabaseNoName', 'Project Management', cur,
  ].join('\t')];
  const names = [...sel.keys()].filter((n) => !n.startsWith('_'));
  const vo = tableOrderFor(opts.version);
  const order = [...vo.filter((n) => names.includes(n)), ...names.filter((n) => !vo.includes(n)).sort()];
  for (const name of order) {
    const rs = sel.get(name)!;
    if (!rs.length) continue;
    const src = db.tables[name]?.fields.filter((f) => !f.startsWith('_')) ?? [];
    const variant = variantsFor(opts.version, name).find((v) => v.join() === src.join());
    const fields = variant ?? fieldsFor(opts.version, name) ?? src;
    lines.push(`%T\t${name}`, `%F\t${fields.join('\t')}`);
    for (const r of rs) lines.push('%R\t' + fields.map((f) => clean(r[f])).join('\t'));
  }
  lines.push('%E');
  const text = lines.join('\r\n') + '\r\n';
  return opts.encoding === 'utf-8' ? new TextEncoder().encode(text) : encodeCp1252(text);
}
