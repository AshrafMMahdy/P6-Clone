// Project > Maintain Baselines: a baseline is a copy of the project stored as its own (hidden) project.
import { rows, table, type Db } from '../db.ts';
import { selectRows } from '../xer/write.ts';
import { importIntoDb, deleteProject } from '../xer/import.ts';
import { formatP6Date } from '../dates.ts';

/** Copy a project as a baseline. Returns the baseline's proj_id. */
export function saveBaseline(db: Db, projId: string, name?: string): string {
  const src: Db = { tables: {} };
  for (const [t, rs] of selectRows(db, [projId])) src.tables[t] = { name: t, fields: [...(db.tables[t]?.fields ?? [])], rows: rs.map((r) => ({ ...r })) };
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
