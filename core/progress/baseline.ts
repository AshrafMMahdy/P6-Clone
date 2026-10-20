// Project > Maintain Baselines: a baseline is a copy of the project stored as its own (hidden) project.
import { addField, rows, table, type Db } from '../db.ts';
import { selectRows } from '../xer/write.ts';
import { importIntoDb, deleteProject } from '../xer/import.ts';
import { formatP6Date } from '../dates.ts';
import { rawOf } from '../journal.ts';

/** Copy a project as a baseline. Returns the baseline's proj_id. */
export function saveBaseline(db: Db, projId: string, name?: string): string {
  const src: Db = { tables: {} };
  // read-only copy: read the real rows, not the undo journal's recording view
  const rdb = rawOf(db);
  for (const [t, rs] of selectRows(rdb, [projId])) src.tables[t] = { name: t, fields: [...(rdb.tables[t]?.fields ?? [])], rows: rs.map((r) => ({ ...r })) };
  const { projIds: [bid] } = importIntoDb(db, src, { projects: [{ srcProjId: projId, action: 'new' }] });
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId)!;
  const b = rows(db, 'PROJECT').find((x) => x.proj_id === bid)!;
  const n = rows(db, 'PROJECT').filter((x) => x._baseline_of === projId).length + 1;
  b._baseline_of = projId;
  b.proj_short_name = name || `${p.proj_short_name} - B${n}`;
  b._baseline_date = formatP6Date(Date.now() / 60000);
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === bid && w.proj_node_flag === 'Y');
  if (root) root.wbs_short_name = b.proj_short_name;
  for (const f of ['_baseline_of', '_baseline_date']) if (!table(db, 'PROJECT').fields.includes(f)) table(db, 'PROJECT').fields.push(f);
  return bid;
}

export function assignBaseline(db: Db, projId: string, baselineId: string): void {
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId)!;
  if (!table(db, 'PROJECT').fields.includes('sum_base_proj_id')) table(db, 'PROJECT').fields.push('sum_base_proj_id');
  p.sum_base_proj_id = baselineId;
}

export function deleteBaseline(db: Db, baselineId: string): void {
  for (const p of rows(db, 'PROJECT')) if (p.sum_base_proj_id === baselineId) p.sum_base_proj_id = '';
  deleteProject(db, baselineId);
}

/** Restore: the baseline becomes a normal project again. */
export function restoreBaseline(db: Db, baselineId: string): void {
  const b = rows(db, 'PROJECT').find((x) => x.proj_id === baselineId);
  if (b) b._baseline_of = '';
}

/** Baselines in an XER: P6 writes each as a PROJECT row whose orig_proj_id names the project it is a baseline of. */
export function markBaselines(db: Db): void {
  const P = rows(db, 'PROJECT'), ids = new Set(P.map((p) => p.proj_id));
  for (const p of P) if (p.orig_proj_id && p.orig_proj_id !== p.proj_id && ids.has(p.orig_proj_id) && !p._baseline_of) { addField(table(db, 'PROJECT'), '_baseline_of'); p._baseline_of = p.orig_proj_id; }
}
