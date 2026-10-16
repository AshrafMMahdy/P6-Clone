// Explain one activity: node scripts/explain.ts <fileSubstring> <task_code>
import { parseXer } from '../core/xer/parse.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { realSamples, samples } from '../tests/helpers.ts';

const [filt, code] = process.argv.slice(2);
// a sample name substring, or a path to any .xer
const s = existsSync(filt) && statSync(filt).isFile() ? { name: filt, bytes: readFileSync(filt) } : [...realSamples(), ...samples()].find((x) => x.name.toLowerCase().includes(filt.toLowerCase()))!;
const orig = parseXer(s.bytes).db;
const db = parseXer(s.bytes).db;
scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
const o = new Map(orig.tables.TASK.rows.map((r) => [r.task_id, r]));
const a = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
// every activity with that code (multi-project files repeat codes); PROJ=<proj_short_name> narrows it
for (const t of orig.tables.TASK.rows.filter((r) => r.task_code === code && (!process.env.PROJ || orig.tables.PROJECT.rows.find((x) => x.proj_id === r.proj_id)?.proj_short_name === process.env.PROJ))) {
const cal = orig.tables.CALENDAR.rows.find((c) => c.clndr_id === t.clndr_id);
const p = orig.tables.PROJECT.rows.find((x) => x.proj_id === t.proj_id)!;
console.log(`project ${p.proj_short_name} dd=${p.last_recalc_date} ps=${p.plan_start_date} mfb=${p.plan_end_date}`);
console.log(`${t.task_code} ${t.task_type} ${t.status_code} cal=${cal?.clndr_name} dur=${t.target_drtn_hr_cnt}/${t.remain_drtn_hr_cnt} cstr=${t.cstr_type} ${t.cstr_date} ${t.cstr_type2} ${t.cstr_date2} act=${t.act_start_date}|${t.act_end_date}`);
const show = (r: Record<string, string>, b: Record<string, string>) => `ES ${r.early_start_date}/${b.early_start_date} EF ${r.early_end_date}/${b.early_end_date} LS ${r.late_start_date}/${b.late_start_date} LF ${r.late_end_date}/${b.late_end_date} TF ${r.total_float_hr_cnt}/${b.total_float_hr_cnt}`;
console.log('  ' + show(t, a.get(t.task_id)!));
for (const r of orig.tables.TASKPRED?.rows ?? []) {
  if (r.task_id === t.task_id) { const x = o.get(r.pred_task_id); console.log(`  pred ${x?.task_code ?? r.pred_task_id} ${r.pred_type} lag=${r.lag_hr_cnt} [${x?.status_code} act=${x?.act_start_date}|${x?.act_end_date}] ${x ? show(x, a.get(x.task_id)!) : 'external'}`); }
  if (r.pred_task_id === t.task_id) { const x = o.get(r.task_id); console.log(`  succ ${x?.task_code ?? r.task_id} ${r.pred_type} lag=${r.lag_hr_cnt} ${x ? show(x, a.get(x.task_id)!) : 'external'}`); }
}
if (cal) console.log('  cal data: ' + cal.clndr_data.slice(0, 400));
}
