// Reschedule real P6 exports and compare against the dates P6 computed.
// Usage: node scripts/oracle.ts [fileSubstring] [--detail N] [--json]
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects, calendarResolver } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { realSamples } from '../tests/helpers.ts';

export const FIELDS = ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt'];

export interface OracleResult { file: string; n: number; match: Record<string, number>; overall: number; mismatches: string[] }

export function oracle(filter?: string, detail = 0): OracleResult[] {
  const out: OracleResult[] = [];
  for (const s of realSamples()) {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const orig = parseXer(s.bytes).db;
    const db = parseXer(s.bytes).db;
    const projIds = (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id);
    const res = scheduleProjects(db, projIds);
    if (!res.ok) { out.push({ file: s.name, n: 0, match: {}, overall: 0, mismatches: res.findings.filter((f) => f.severity === 'error').map((f) => f.message) }); continue; }
    const after = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
    const match: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    const mismatches: string[] = [];
    let n = 0;
    for (const o of orig.tables.TASK?.rows ?? []) {
      if (!process.env.ORACLE_ALL && (o.status_code === 'TK_Complete' || o.act_end_date)) continue;
      const a = after.get(o.task_id)!;
      n++;
      for (const f of FIELDS) {
        const ok = f.endsWith('_cnt') ? Math.abs(Number(o[f] || 0) - Number(a[f] || 0)) < 0.02 : o[f] === a[f];
        if (ok) match[f]++;
        else if (mismatches.length < detail) mismatches.push(`${o.task_code} ${o.task_type} ${o.status_code} ${f}: P6=${o[f]} ours=${a[f]}`);
      }
    }
    // Self-consistency of P6's own dates with the calendars: low values mean the file was not
    // rescheduled after edits (stale dates), so mismatches there are not engine errors.
    const cals = calendarResolver(orig, []);
    let consistent = 0, checked = 0;
    for (const o of orig.tables.TASK?.rows ?? []) {
      if (o.status_code !== 'TK_NotStart' || o.task_type !== 'TT_Task') continue;
      const es = parseP6Date(o.early_start_date), ef = parseP6Date(o.early_end_date);
      if (es == null || ef == null) continue;
      checked++;
      const proj = orig.tables.PROJECT.rows.find((p) => p.proj_id === o.proj_id);
      const cal = cals.get(o.clndr_id) ?? cals.fallback(proj?.clndr_id);
      if (Math.abs(cal.workBetween(es, ef) - Number(o.remain_drtn_hr_cnt || 0) * 60) < 2) consistent++;
    }
    match.consistency = checked ? Math.round((1000 * consistent) / checked) / 10 : 100;
    for (const f of FIELDS) match[f] = n ? Math.round((1000 * match[f]) / n) / 10 : 100;
    const overall = Math.round(10 * FIELDS.reduce((x, f) => x + match[f], 0) / FIELDS.length) / 10;
    out.push({ file: s.name, n, match, overall, mismatches });
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--detail');
  const detail = di >= 0 ? Number(args[di + 1]) : 0;
  const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--detail');
  const res = oracle(filter, detail);
  if (args.includes('--json')) console.log(JSON.stringify(Object.fromEntries(res.map((r) => [r.file, r.overall])), null, 1));
  else for (const r of res) {
    console.log(`${r.file.padEnd(44)} n=${String(r.n).padStart(5)} overall=${String(r.overall).padStart(5)}% calOK=${r.match.consistency}% ` + FIELDS.map((f) => `${f.replace(/_date|_hr_cnt/, '')}=${r.match[f]}`).join(' '));
    for (const m of r.mismatches) console.log('    ' + m);
  }
}
