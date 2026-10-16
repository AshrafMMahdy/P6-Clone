// Show how real P6 stores dates for in-progress / completed / not-started activities.
import { parseXer } from '../core/xer/parse.ts';
import { realSamples } from '../tests/helpers.ts';

const F = ['task_code', 'task_type', 'remain_drtn_hr_cnt', 'target_drtn_hr_cnt', 'total_float_hr_cnt', 'free_float_hr_cnt', 'act_start_date', 'act_end_date', 'early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'target_start_date', 'target_end_date'];
const want = process.argv[2] ?? 'TK_Active';
let shown = 0;
for (const s of realSamples()) {
  const { db } = parseXer(s.bytes);
  const projs = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
  const rows = (db.tables.TASK?.rows ?? []).filter((r) => r.status_code === want);
  for (const r of rows.slice(0, 2)) {
    const p = projs.get(r.proj_id);
    console.log(`${s.name} DD=${p?.last_recalc_date}`);
    console.log('  ' + F.map((f) => `${f}=${r[f] ?? '-'}`).join('\n  '));
    if (++shown >= 6) process.exit(0);
  }
}
