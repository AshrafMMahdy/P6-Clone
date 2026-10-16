// Root-cause mismatches: activities whose saved dates differ from ours while none of their predecessors differ.
// node scripts/roots.ts <file.xer> [N]
import { readFileSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
const [file, n = '25'] = process.argv.slice(2);
const bytes = readFileSync(file);
const o = parseXer(bytes).db, db = parseXer(bytes).db;
scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
const A = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
const early = (t: Record<string, string>) => { const a = A.get(t.task_id)!; return t.early_start_date !== a.early_start_date || t.early_end_date !== a.early_end_date; };
const projOk = (t: Record<string, string>) => !process.env.PROJ || o.tables.PROJECT.rows.find((p) => p.proj_id === t.proj_id)?.proj_short_name === process.env.PROJ; // PROJ=<proj_short_name>
const open = o.tables.TASK.rows.filter((t) => projOk(t) && (process.env.ALL || (t.status_code !== 'TK_Complete' && !t.act_end_date)) && t.early_start_date); // ALL=1: completed too
const bad = new Set(open.filter(early).map((t) => t.task_id));
const preds = new Map<string, string[]>();
for (const r of o.tables.TASKPRED.rows) { let l = preds.get(r.task_id); if (!l) preds.set(r.task_id, (l = [])); l.push(r.pred_task_id); }
const roots = open.filter((t) => bad.has(t.task_id) && !(preds.get(t.task_id) ?? []).some((p) => bad.has(p)));
console.log(`early-date mismatches ${bad.size} of ${open.length}, roots ${roots.length}`);
const by = new Map<string, number>();
for (const t of roots) { const k = `${t.task_type} ${t.status_code}${t.cstr_type ? ' ' + t.cstr_type : ''}`; by.set(k, (by.get(k) ?? 0) + 1); }
console.log('roots by kind:', JSON.stringify(Object.fromEntries(by)));
for (const t of roots.slice(0, Number(n))) { const a = A.get(t.task_id)!; console.log(t.task_code, t.task_type, t.status_code, t.cstr_type || '', 'ES', t.early_start_date, a.early_start_date, 'EF', t.early_end_date, a.early_end_date, 'act', t.act_start_date || '-'); }

// LATE=1: also list late-date roots (late dates differ, but no successor's late dates differ)
if (process.env.LATE) {
  const lateBad = (t: Record<string, string>) => { const a = A.get(t.task_id)!; return t.late_start_date !== a.late_start_date || t.late_end_date !== a.late_end_date; };
  const lb = new Set(open.filter(lateBad).map((t) => t.task_id));
  const succs = new Map<string, string[]>();
  for (const r of o.tables.TASKPRED.rows) { let l = succs.get(r.pred_task_id); if (!l) succs.set(r.pred_task_id, (l = [])); l.push(r.task_id); }
  const lroots = open.filter((t) => lb.has(t.task_id) && !(succs.get(t.task_id) ?? []).some((s) => lb.has(s)));
  console.log(`late-date mismatches ${lb.size}, late roots ${lroots.length}`);
  for (const t of lroots.slice(0, Number(n))) { const a = A.get(t.task_id)!; console.log(' ', t.task_code, t.task_type, t.cstr_type || '', 'LS', t.late_start_date, a.late_start_date, 'LF', t.late_end_date, a.late_end_date); }
}
