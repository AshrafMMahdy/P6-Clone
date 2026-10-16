// Check every XER in a folder (recursively): what wrote it, how big it is, how long the clone takes to parse,
// validate and schedule it, and whether rescheduling reproduces the dates stored in it.
// Usage: node scripts/check-folder.ts <folder> [--detail N]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { worst } from '../core/findings.ts';
import { FIELDS } from './oracle.ts';

const args = process.argv.slice(2);
const dir = args[0];
const di = args.indexOf('--detail');
const detail = di >= 0 ? Number(args[di + 1]) : 0;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.xer$/i.test(f) ? [p] : []; });

for (const file of statSync(dir).isFile() ? [dir] : walk(dir)) {
  const bytes = readFileSync(file);
  const ms = (t: number) => `${Date.now() - t} ms`;
  let t = Date.now();
  const { db, findings } = parseXer(bytes);
  const parse = ms(t);
  const h = db.header;
  const n = (x: string) => db.tables[x]?.rows.length ?? 0;
  t = Date.now();
  const all = validateXer(db, findings);
  const validate = ms(t);
  const verdict = worst(all) ?? 'clean';
  console.log(`\n${(relative(dir, file) || file)}  ${(bytes.length / 1048576).toFixed(1)} MB  ERMHDR ${h?.version} ${h?.exportDate ?? ''} (${h?.raw?.slice(3, 6).join(" ") ?? ""})`);
  console.log(`  projects ${n('PROJECT')}, activities ${n('TASK')}, links ${n('TASKPRED')}, calendars ${n('CALENDAR')}, resources ${n('RSRC')}, assignments ${n('TASKRSRC')}, cost accounts ${n('ACCOUNT')}, activity codes ${n('TASKACTV')}, UDF values ${n('UDFVALUE')}`);
  console.log(`  parse ${parse}, validate ${validate}, verdict ${verdict}${verdict === 'fatal' || verdict === 'error' ? ': ' + all.filter((x) => x.severity === verdict).slice(0, 3).map((x) => x.code + ' ' + x.message.slice(0, 120)).join(' | ') : ''}`);
  if (verdict === 'fatal') continue;
  const orig = parseXer(bytes).db;
  t = Date.now();
  const res = scheduleProjects(db, (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id));
  const sched = ms(t);
  if (!res.ok) { console.log(`  schedule FAILED in ${sched}: ${res.findings.filter((x) => x.severity === 'error').slice(0, 3).map((x) => x.message).join(' | ')}`); continue; }
  const after = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
  let acts = 0, wrong = 0, shown = 0;
  for (const o of orig.tables.TASK?.rows ?? []) {
    if (o.status_code === 'TK_Complete' || o.act_end_date) continue;
    acts++;
    const a = after.get(o.task_id)!;
    for (const f of FIELDS) {
      const ok = f.endsWith('_cnt') ? Math.abs(Number(o[f] || 0) - Number(a[f] || 0)) < 0.02 : o[f] === a[f];
      if (!ok) { wrong++; if (shown++ < detail) console.log(`    ${o.task_code} ${o.task_type} ${o.status_code} ${f}: P6=${o[f]} ours=${a[f]}`); }
    }
  }
  const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
  console.log(`  schedule ${sched}, heap ${mem} MB; open activities ${acts}: ${wrong ? `${wrong} values differ from the saved dates` : 'EXACT match with the saved dates'}`);
}
