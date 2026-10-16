// Walk back along P6's driving predecessors and show where our dates first diverge.
// node scripts/trace.ts <fileSubstring> <task_code>
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { samples } from '../tests/helpers.ts';

const [filt, code] = process.argv.slice(2);
const s = samples().find((x) => x.name.toLowerCase().includes(filt.toLowerCase()))!;
const orig = parseXer(s.bytes).db;
const db = parseXer(s.bytes).db;
scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
const o = new Map(orig.tables.TASK.rows.map((r) => [r.task_id, r]));
const a = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
const cal = new Map(orig.tables.CALENDAR.rows.map((c) => [c.clndr_id, c.clndr_name]));
let t = orig.tables.TASK.rows.find((r) => r.task_code === code);
const seen = new Set<string>();
while (t && !seen.has(t.task_id)) {
  seen.add(t.task_id);
  const b = a.get(t.task_id)!;
  console.log(`${t.task_code} ${t.task_type} ${t.status_code} cal=${cal.get(t.clndr_id)} dur=${t.remain_drtn_hr_cnt} cstr=${t.cstr_type}${t.cstr_date} | ES P6 ${t.early_start_date} ours ${b.early_start_date} | EF P6 ${t.early_end_date} ours ${b.early_end_date}`);
  // driving pred per P6: the pred whose relationship best explains P6's ES
  let best: { r: Record<string, string>; d: string } | undefined;
  for (const r of orig.tables.TASKPRED.rows) {
    if (r.task_id !== t.task_id) continue;
    const p = o.get(r.pred_task_id);
    if (!p) continue;
    const d = r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF' ? (p.act_start_date || p.early_start_date) : (p.act_end_date || p.early_end_date);
    if (!best || d > best.d) best = { r, d };
  }
  if (!best) break;
  console.log(`   <- ${best.r.pred_type} lag ${best.r.lag_hr_cnt}`);
  t = o.get(best.r.pred_task_id);
}
