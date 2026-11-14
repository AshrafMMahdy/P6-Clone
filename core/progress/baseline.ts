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
  // (the copy is complete, as P6's: a relationship to an activity of another project is in it too. It is a baseline's link: nothing schedules or analyses
  // with it (core/progress/snapshots.ts), and restoring the baseline makes it a relationship like any other)
  const { projIds: [bid] } = importIntoDb(db, src, { projects: [{ srcProjId: projId, action: 'new' }], sameFile: true });
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId)!;
  const b = rows(db, 'PROJECT').find((x) => x.proj_id === bid)!;
  const n = rows(db, 'PROJECT').filter((x) => x._baseline_of === projId).length + 1;
  b._baseline_of = projId;
  // (a baseline has no baselines of its own: the copy does not carry the project's assignments)
  for (const f of ['sum_base_proj_id', '_bl1', '_bl2', '_bl3']) if (b[f]) b[f] = '';
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

/** The slots a baseline is assigned in, as P6 names them with the project ("Project Baseline of P", "Primary Baseline of P"): P6 neither restores nor deletes a
 *  baseline while it is assigned ("You cannot restore a baseline that is designated as the active baseline"). */
export function assignedAs(db: Db, baselineId: string): { project: string; slot: 'project' | 'bl1' | 'bl2' | 'bl3'; words: string }[] {
  const SLOTS = [['sum_base_proj_id', 'project', 'Project Baseline'], ['_bl1', 'bl1', 'Primary Baseline'], ['_bl2', 'bl2', 'Secondary Baseline'], ['_bl3', 'bl3', 'Tertiary Baseline']] as const;
  return rows(db, 'PROJECT').flatMap((p) => SLOTS.filter(([f]) => p[f] === baselineId).map(([, slot, name]) => ({ project: p.proj_short_name, slot, words: `${name} of ${p.proj_short_name}` })));
}

/** Maintain Baselines > Add > "Convert another project to a new baseline of the current project": the project itself becomes the baseline (it is no copy: it keeps
 *  its internal number, its Project ID and name, and everything in it), and is no longer a project of the file. It is added to the baselines of `ofId`, not assigned.
 *  Its relationships to other projects stay with it, as a baseline's links (core/progress/snapshots.ts). The caller checks P6's conditions. */
export function convertToBaseline(db: Db, projId: string, ofId: string): void {
  const P = table(db, 'PROJECT');
  for (const f of ['_baseline_of', '_baseline_date']) addField(P, f);
  const b = rows(db, 'PROJECT').find((x) => x.proj_id === projId)!;
  b._baseline_of = ofId;
  b._baseline_date = formatP6Date(Date.now() / 60000);
}

/** Restore: the baseline becomes a normal project again, in every respect: it is no baseline of any project (no project's baseline slot names it), and its
 *  orig_proj_id (how an XER marks a baseline, and what baselineProjectIds reads) is cleared, so saving it as XER and opening that does not turn it back into one. */
export function restoreBaseline(db: Db, baselineId: string): void {
  for (const p of rows(db, 'PROJECT')) { if (p.sum_base_proj_id === baselineId) p.sum_base_proj_id = ''; for (const f of ['_bl1', '_bl2', '_bl3']) if (p[f] === baselineId) p[f] = ''; }
  const b = rows(db, 'PROJECT').find((x) => x.proj_id === baselineId);
  if (b) { b._baseline_of = ''; if (b.orig_proj_id) b.orig_proj_id = ''; }
}

/** The baseline projects of a file: a project saved as a baseline (_baseline_of) or, in an XER read without markBaselines (the desktop's reader), a project row whose
 *  orig_proj_id names another project of the file (the way P6 writes a baseline). Every project not in this set is a project of its own. */
export function baselineProjectIds(db: Db): Set<string> {
  const P = rows(db, 'PROJECT'), ids = new Set(P.map((p) => p.proj_id));
  return new Set(P.filter((p) => p._baseline_of || (p.orig_proj_id && p.orig_proj_id !== p.proj_id && ids.has(p.orig_proj_id))).map((p) => p.proj_id));
}

/** Baselines in an XER: P6 writes each as a PROJECT row whose orig_proj_id names the project it is a baseline of. */
export function markBaselines(db: Db): void {
  const P = rows(db, 'PROJECT'), ids = new Set(P.map((p) => p.proj_id));
  for (const p of P) if (p.orig_proj_id && p.orig_proj_id !== p.proj_id && ids.has(p.orig_proj_id) && !p._baseline_of) { addField(table(db, 'PROJECT'), '_baseline_of'); p._baseline_of = p.orig_proj_id; }
}
