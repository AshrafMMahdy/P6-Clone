// List mismatched values for one project of a file: node scripts/diffs.ts <file.xer> [N]   (PROJ=<proj_short_name>)
import { readFileSync } from 'node:fs';
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { FIELDS } from './oracle.ts';
const [file, n = '40'] = process.argv.slice(2);
const bytes = readFileSync(file);
const o = parseXer(bytes).db, db = parseXer(bytes).db;
scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
const A = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
const P = new Map(o.tables.PROJECT.rows.map((p) => [p.proj_id, p.proj_short_name]));
let shown = 0;
const kinds = new Map<string, number>();
for (const t of o.tables.TASK.rows) {
  if (t.status_code === 'TK_Complete' || t.act_end_date || !t.early_start_date) continue;
  if (process.env.PROJ && P.get(t.proj_id) !== process.env.PROJ) continue;
  const a = A.get(t.task_id)!;
  for (const f of FIELDS) {
    if (f.endsWith('_cnt') ? Math.abs(Number(t[f] || 0) - Number(a[f] || 0)) < 0.02 : t[f] === a[f]) continue;
    const k = `${t.task_type} ${f}`; kinds.set(k, (kinds.get(k) ?? 0) + 1);
    if (shown++ < Number(n)) console.log(`${t.task_code} ${t.task_type} ${t.status_code}${t.cstr_type ? ' ' + t.cstr_type : ''} ${f}: P6=${t[f]} ours=${a[f]}`);
  }
}
console.log(JSON.stringify(Object.fromEntries(kinds)));
