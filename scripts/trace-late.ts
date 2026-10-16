// Walk forward along the successors that determine P6's late dates; show where ours first diverge.
// node scripts/trace-late.ts <fileSubstring> <task_code>
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
let t = orig.tables.TASK.rows.find((r) => r.task_code === code);
const seen = new Set<string>();
while (t && !seen.has(t.task_id)) {
  seen.add(t.task_id);
  const b = a.get(t.task_id)!;
  console.log(`${t.task_code} ${t.task_type} ${t.status_code} dur=${t.remain_drtn_hr_cnt} cstr=${t.cstr_type}${t.cstr_date} | LS P6 ${t.late_start_date} ours ${b.late_start_date} | LF P6 ${t.late_end_date} ours ${b.late_end_date}`);
  let best: { r: Record<string, string>; d: string } | undefined;
  for (const r of orig.tables.TASKPRED.rows) {
    if (r.pred_task_id !== t.task_id) continue;
    const x = o.get(r.task_id);
    if (!x || x.act_end_date) continue;
    const d = r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF' ? x.late_end_date : x.late_start_date;
    if (!best || d < best.d) best = { r, d };
  }
  if (!best) { console.log('   (no open successor: project late finish / constraint)'); break; }
  console.log(`   -> ${best.r.pred_type} lag ${best.r.lag_hr_cnt}`);
  t = o.get(best.r.task_id);
}
