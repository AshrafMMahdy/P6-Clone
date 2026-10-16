// Reschedule real P6 exports and compare against the dates P6 computed.
// Usage: node scripts/oracle.ts [fileSubstring] [--detail N] [--json]
import { parseXer } from '../core/xer/parse.ts';
import { scheduleProjects, calendarResolver } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { realSamples } from '../tests/helpers.ts';

/**
 * Stale-data repair: where P6's own stored early dates contradict an activity's remaining duration (the file was
 * edited after P6 last scheduled it), put back the duration P6 actually used: work time between its stored early
 * start and early finish. Returns the activities changed.
 */
export function repairStale(db: ReturnType<typeof parseXer>['db']): string[] {
  const cals = calendarResolver(db, []);
  const out: string[] = [];
  for (const t of db.tables.TASK?.rows ?? []) {
    if (t.act_start_date || t.act_end_date || (t.task_type !== 'TT_Task' && t.task_type !== 'TT_Rsrc')) continue;
    const es = parseP6Date(t.early_start_date), ef = parseP6Date(t.early_end_date);
    if (es == null || ef == null) continue;
    const proj = db.tables.PROJECT.rows.find((p) => p.proj_id === t.proj_id);
    const cal = cals.get(t.clndr_id) ?? cals.fallback(proj?.clndr_id);
    const used = cal.workBetween(es, ef) / 60;
    if (Math.abs(used - Number(t.remain_drtn_hr_cnt || 0)) > 0.02) {
      out.push(`${t.task_code}: remaining ${t.remain_drtn_hr_cnt} h, P6 dates imply ${Math.round(used * 100) / 100} h`);
      t.remain_drtn_hr_cnt = String(used);
      t.target_drtn_hr_cnt = String(used);
      // the same edit stretched its rate-less assignments; put them back on the activity's dates
      for (const r of db.tables.TASKRSRC?.rows ?? []) if (r.task_id === t.task_id && !(Number(r.remain_qty_per_hr) > 0)) { r.restart_date = t.early_start_date; r.reend_date = t.early_end_date; }
    }
  }
  return out;
}

export const FIELDS = ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt'];

export interface OracleResult { file: string; n: number; match: Record<string, number>; overall: number; wrong: number; mismatches: string[]; repaired?: string[] }

export function oracle(filter?: string, detail = 0, repair = false): OracleResult[] {
  const out: OracleResult[] = [];
  for (const s of realSamples()) {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const orig = parseXer(s.bytes).db;
    const db = parseXer(s.bytes).db;
    const projIds = (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id);
    const repaired = repair ? repairStale(db) : [];
    const res = scheduleProjects(db, projIds);
    if (!res.ok) { out.push({ file: s.name, n: 0, match: {}, overall: 0, wrong: Infinity, mismatches: res.findings.filter((f) => f.severity === 'error').map((f) => f.message) }); continue; }
    const after = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
    const match: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    const mismatches: string[] = [];
    let n = 0, wrong = 0;
    for (const o of orig.tables.TASK?.rows ?? []) {
      if (!process.env.ORACLE_ALL && (o.status_code === 'TK_Complete' || o.act_end_date)) continue;
      const a = after.get(o.task_id)!;
      n++;
      for (const f of FIELDS) {
        const ok = f.endsWith('_cnt') ? Math.abs(Number(o[f] || 0) - Number(a[f] || 0)) < 0.02 : o[f] === a[f];
        if (ok) match[f]++;
        else if (++wrong <= detail) mismatches.push(`${o.task_code} ${o.task_type} ${o.status_code} ${f}: P6=${o[f]} ours=${a[f]}`);
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
    out.push({ file: s.name, n, match, overall, wrong, mismatches, repaired });
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--detail');
  const detail = di >= 0 ? Number(args[di + 1]) : 0;
  const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--detail');
  const res = oracle(filter, detail, args.includes('--repair'));
  if (args.includes('--json')) console.log(JSON.stringify(Object.fromEntries(res.map((r) => [r.file, r.wrong])), null, 1));
  else for (const r of res) {
    console.log(`${r.file.padEnd(44)} n=${String(r.n).padStart(5)} overall=${String(r.overall).padStart(5)}% ${r.wrong ? `wrong=${r.wrong}` : 'EXACT'} calOK=${r.match.consistency}% ` + FIELDS.map((f) => `${f.replace(/_date|_hr_cnt/, '')}=${r.match[f]}`).join(' '));
    if (r.repaired?.length) console.log(`    repaired ${r.repaired.length} stale activit${r.repaired.length > 1 ? 'ies' : 'y'}: ${r.repaired.slice(0, 3).join('; ')}${r.repaired.length > 3 ? '; ...' : ''}`);
    for (const m of r.mismatches) console.log('    ' + m);
  }
}
