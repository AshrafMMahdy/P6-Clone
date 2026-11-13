// Project > Maintain Baselines: a baseline is a copy of the project stored as its own (hidden) project.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { namesText } from '../notes.ts';
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
  // a baseline is a snapshot of this project alone: a relationship to an activity of another project is not copied (it would tie
  // that project's activity to the baseline's saved dates); the baseline's activities keep the dates they were saved with
  const own = new Set((src.tables.TASK?.rows ?? []).map((t) => t.task_id));
  if (src.tables.TASKPRED) src.tables.TASKPRED.rows = src.tables.TASKPRED.rows.filter((r) => own.has(r.task_id) && own.has(r.pred_task_id));
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

/** A baseline is a snapshot of its project alone: a relationship between a baseline and another project is not part of it. A file can hold one (this engine made
 *  them before whiq-v0.1.80 when it saved a baseline of a project tied to another project; P6 is reported to leave them too), and it would tie the other project's
 *  activity to the baseline's saved dates. Such relationships are taken out when a file is read, and the reader says how many (the returned rows). */
export function dropBaselineTies(db: Db): Row[] {
  const snapshots = baselineProjectIds(db), T = db.tables.TASKPRED;
  if (!snapshots.size || !T) return [];
  const proj = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.proj_id]));
  const tie = (r: Row) => { const a = proj.get(r.task_id), b = proj.get(r.pred_task_id); return a != null && b != null && a !== b && (snapshots.has(a) || snapshots.has(b)); };
  const gone = T.rows.filter(tie);
  if (gone.length) T.rows = T.rows.filter((r) => !tie(r));
  return gone;
}
/** The reader's sentence for them: how many, and which (by the list rule). */
export function baselineTiesFinding(db: Db, ties: Row[]): Finding {
  const proj = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name])), task = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const end = (id: string) => { const t = task.get(id); return t ? `${t.task_code} in ${proj.get(t.proj_id) ?? 'a project that is not in the file'}` : 'an activity that is not in the file'; };
  const n = ties.length;
  return { severity: 'warning', code: 'BASELINE_TIE_LEFT_OUT', table: 'TASKPRED', message: `${n} ${n === 1 ? 'relationship that ties' : 'relationships that tie'} a baseline to an activity outside it ${n === 1 ? 'was' : 'were'} left out (${namesText(ties.map((r) => `${end(r.pred_task_id)} ${(r.pred_type || 'PR_FS').slice(3)} ${end(r.task_id)}`))}): a baseline is a snapshot of its own project and takes no part in the schedule.`, p6: '' };
}

/** Baselines in an XER: P6 writes each as a PROJECT row whose orig_proj_id names the project it is a baseline of. */
export function markBaselines(db: Db): void {
  const P = rows(db, 'PROJECT'), ids = new Set(P.map((p) => p.proj_id));
  for (const p of P) if (p.orig_proj_id && p.orig_proj_id !== p.proj_id && ids.has(p.orig_proj_id) && !p._baseline_of) { addField(table(db, 'PROJECT'), '_baseline_of'); p._baseline_of = p.orig_proj_id; }
}
