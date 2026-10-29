import { KEYS, refTarget, type Db, type Row } from '../db.ts';
import { encodeText, encodingLabel, keepOrChoose, type TextEncodingName } from '../encoding.ts';
import { formatDay } from '../dates.ts';
import { fieldsFor, variantsFor, tableOrderFor, knownFields, verification } from './schema.ts';

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
  /** Output text encoding. Default: the code page P6 would use for this text (Windows-1252, or e.g. Windows-1256
   *  when there is Arabic), UTF-8 only when no single code page can hold it. */
  encoding?: TextEncodingName | 'auto';
  /** Without an encoding: the one the file was read in, kept while the text fits it (a note in report when not). */
  readAs?: TextEncodingName;
  report?: string[];
}

/** Child tables kept whenever their parent row is kept. */
const CHILD_OF: Record<string, string> = {
  RSRCRATE: 'rsrc_id', ROLERATE: 'role_id', RSRCROLE: 'rsrc_id', ACTVCODE: 'actv_code_type_id',
  PCATVAL: 'proj_catg_type_id', RCATVAL: 'rsrc_catg_type_id', RSRCRCAT: 'rsrc_id', SHIFTPER: 'shift_id',
};
// P6 writes these dictionary tables whole in a project export (the real samples carry every POBS row)
const ALWAYS = new Set(['CURRTYPE', 'POBS', 'PHASE']);
/** References kept out of refTarget (they often point outside a file) that still pull their row into an export. */
const SOFT_REFS: [table: string, field: string, target: string][] = [['RSRC', 'shift_id', 'SHIFT'], ['RSRC', 'pobs_id', 'POBS'], ['TASKRSRC', 'pobs_id', 'POBS'], ['TASK', 'rsrc_id', 'RSRC']];
/** UDFTYPE.table_name -> the table a UDF value's fk_id points into (values of non-project UDFs have no proj_id). */
const UDF_TABLE: Record<string, string> = { RSRC: 'RSRC', ROLE: 'ROLES', ROLES: 'ROLES', TASKRSRC: 'TASKRSRC', PROJCOST: 'PROJCOST', PROJWBS: 'PROJWBS', TASK: 'TASK', PROJECT: 'PROJECT' };

export function selectRows(db: Db, projIds?: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  if (!projIds) {
    for (const t of Object.values(db.tables)) out.set(t.name, t.rows);
    return out;
  }
  const projs = new Set(projIds);
  const kept = new Map<string, Set<string>>(); // table -> kept keys
  const keptRows = new Set<Row>(); // a row once (a Set: arr.includes was quadratic, minutes on millions of 4D links)
  const keep = (t: string, r: Row) => {
    let arr = out.get(t);
    if (!arr) out.set(t, (arr = []));
    if (keptRows.has(r)) return false;
    keptRows.add(r);
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
    for (const [t, f, target] of SOFT_REFS) {
      const tk = KEYS[target];
      for (const r of out.get(t) ?? []) {
        const v = r[f];
        if (!v || isKept(target, v)) continue;
        const hit = tk && db.tables[target]?.rows.find((x) => x[tk] === v);
        if (hit && keep(target, hit)) changed = true;
      }
    }
    // values of resource / role / ... UDFs (no proj_id) follow the rows they belong to
    const udfTable = new Map((db.tables.UDFTYPE?.rows ?? []).map((u) => [u.udf_type_id, UDF_TABLE[u.table_name]]));
    for (const v of db.tables.UDFVALUE?.rows ?? []) {
      if (v.proj_id) continue;
      const target = udfTable.get(v.udf_type_id);
      if (target && isKept(target, v.fk_id) && keep('UDFVALUE', v)) changed = true;
    }
    for (const [child, pf] of Object.entries(CHILD_OF)) {
      const parent = refTarget(pf) ?? (pf === 'shift_id' ? 'SHIFT' : undefined);
      for (const r of db.tables[child]?.rows ?? []) if (parent && isKept(parent, r[pf]) && keep(child, r)) changed = true;
    }
  }
  return out;
}

function clean(v: string | undefined): string {
  // P6 itself leaves lone CRs inside memo values; only tabs/newlines would break the format.
  return v == null ? '' : v.replace(/\r\n|[\t\n]/g, ' ');
}

const CHUNK = 1 << 22; // characters of text encoded at a time
const NON_ASCII = /[^\x00-\x7f]/;

export function writeXer(db: Db, opts: WriteOptions): Uint8Array {
  const parts: Uint8Array[] = [];
  writeXerTo(db, opts, (b) => parts.push(b));
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (let i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; parts[i] = out.subarray(0, 0); }
  return out;
}

/** The XER file to a sink, encoded a chunk at a time (a file larger than memory is never one string or one buffer).
 *  The code page depends only on which non-ASCII characters occur, so unless it is given, a first pass over the rows
 *  collects them (nothing is kept from it) and the second writes. */
export function writeXerTo(db: Db, opts: WriteOptions, put: (bytes: Uint8Array) => void): void {
  const sel = selectRows(db, opts.projIds);
  const cur = opts.currency ?? db.tables.CURRTYPE?.rows[0]?.curr_short_name ?? (db.header?.raw?.[8] || 'USD'); // (a currency the file only names in its ERMHDR line stays)
  const day = opts.exportDate ?? formatDay(Date.now() / 60000);
  const each = (line: (l: string) => void) => {
  const lines = { push(...ls: string[]) { for (const l of ls) line(l); } };
  lines.push([
    'ERMHDR', opts.version, day, 'Project',
    // the user and database a file read in was exported from stay as they were (only the export date is new)
    opts.user ?? (db.header?.raw?.[4] || 'admin'), opts.userName ?? (db.header?.raw?.[5] || 'admin'), opts.dbName ?? (db.header?.raw?.[6] || 'dbxDatabaseNoName'), 'Project Management', cur,
  ].join('\t'));
  // EPS lives in P6's database, never in an XER (P6 asks for it on import and its exports carry no EPS table); the clone
  // keeps its EPS nodes for P6 XML and the portfolio, and writing them here gave every saved XER an unknown table.
  const names = [...sel.keys()].filter((n) => !n.startsWith('_') && n !== 'EPS');
  const vo = tableOrderFor(opts.version);
  const order = [...vo.filter((n) => names.includes(n)), ...names.filter((n) => !vo.includes(n)).sort()];
  for (const name of order) {
    const rs = sel.get(name)!;
    if (!rs.length) continue;
    const src = db.tables[name]?.fields.filter((f) => !f.startsWith('_')) ?? [];
    const variant = variantsFor(opts.version, name).find((v) => v.join() === src.join());
    const base = variant ?? fieldsFor(opts.version, name) ?? src;
    // where the version's layout is only approximated (no real export of that version seen), source fields that
    // real P6 writes in some version are kept rather than dropped
    const known = verification(opts.version, name) === 'exact' ? null : knownFields(name);
    const fields = known ? [...base, ...src.filter((f) => !base.includes(f) && known.has(f))] : base;
    lines.push(`%T\t${name}`, `%F\t${fields.join('\t')}`);
    // a baseline is a PROJECT row whose orig_proj_id names its project (how P6 writes and reads baselines)
    const val = name === 'PROJECT' ? (r: Row, f: string) => (f === 'orig_proj_id' && r._baseline_of ? r._baseline_of : r[f]) : (r: Row, f: string) => r[f];
    for (const r of rs) lines.push('%R\t' + fields.map((f) => clean(val(r, f))).join('\t'));
  }
  lines.push('%E');
  };
  let enc = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : null;
  if (!enc) {
    const chars = new Set<string>();
    each((l) => { if (NON_ASCII.test(l)) for (const ch of l) if (ch.charCodeAt(0) >= 0x80) chars.add(ch); });
    enc = keepOrChoose([...chars].join(''), opts.readAs);
  }
  if (opts.readAs && enc !== opts.encoding && enc !== opts.readAs) opts.report?.push(`Read as ${encodingLabel(opts.readAs)}, but the text no longer fits it: written as ${encodingLabel(enc)}.`);
  let part: string[] = [], size = 0, first = true;
  const out = () => { if (!part.length) return; put(encodeText(part.join('\r\n') + '\r\n', !first && enc === 'utf-8-bom' ? 'utf-8' : enc!)); first = false; part = []; size = 0; };
  each((l) => { part.push(l); size += l.length + 2; if (size >= CHUNK) out(); });
  out();
}
