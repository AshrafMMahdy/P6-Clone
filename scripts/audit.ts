// Consistency audit of the dates P6 stored in an XER: finds records that a P6 schedule run cannot have produced,
// which means the file was edited after P6 last scheduled it (so rescheduling it cannot reproduce those dates).
// Usage: node scripts/audit.ts [fileSubstring] [--detail N]
import { parseXer } from '../core/xer/parse.ts';
import { calendarResolver } from '../core/schedule/cpm.ts';
import { findLoops } from '../core/xer/validate.ts';
import { parseP6Date } from '../core/dates.ts';
import { realSamples } from '../tests/helpers.ts';

export interface Audit { file: string; checks: Record<string, string[]> }

export function audit(filter?: string): Audit[] {
  const out: Audit[] = [];
  for (const s of realSamples()) {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const db = parseXer(s.bytes).db;
    const cals = calendarResolver(db, []);
    const tasks = db.tables.TASK?.rows ?? [];
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const proj = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p]));
    const calOf = (t: Record<string, string>) => cals.get(t.clndr_id) ?? cals.fallback(proj.get(t.proj_id)?.clndr_id);
    const checks: Record<string, string[]> = { remainingDates: [], logicBroken: [], unexplainedDelay: [], loops: [] };

    // 1. P6 writes a not-started activity's remaining dates and early dates together on every schedule run.
    for (const t of tasks) {
      if (t.status_code !== 'TK_NotStart' || !t.restart_date || !t.early_start_date) continue;
      if (t.restart_date !== t.early_start_date || t.reend_date !== t.early_end_date)
        checks.remainingDates.push(`${t.task_code}: early ${t.early_start_date} → ${t.early_end_date}, remaining ${t.restart_date} → ${t.reend_date} (last edited ${t.update_date} by ${t.update_user})`);
    }

    // 2/3. Plain finish-to-start links (no lag, both not started, same calendar, successor unconstrained):
    // P6 never stores a successor starting before its predecessor finishes, and an activity driven only by such
    // links starts at the first work time after the latest of them (or the data date).
    const preds = new Map<string, Record<string, string>[]>();
    for (const r of db.tables.TASKPRED?.rows ?? []) { let l = preds.get(r.task_id); if (!l) preds.set(r.task_id, (l = [])); l.push(r); }
    for (const t of tasks) {
      if (t.status_code !== 'TK_NotStart' || t.cstr_type || t.cstr_type2 || !['TT_Task', 'TT_Mile', 'TT_FinMile'].includes(t.task_type)) continue;
      const es = parseP6Date(t.early_start_date); if (es == null) continue;
      const ps = preds.get(t.task_id) ?? [];
      const simple = ps.length > 0 && ps.every((r) => {
        const p = byId.get(r.pred_task_id);
        return p && r.pred_type === 'PR_FS' && Number(r.lag_hr_cnt || 0) === 0 && p.status_code === 'TK_NotStart' && p.clndr_id === t.clndr_id && p.task_type !== 'TT_LOE' && p.task_type !== 'TT_WBS';
      });
      if (!simple) continue;
      const cal = calOf(t);
      let rel = parseP6Date(proj.get(t.proj_id)?.last_recalc_date) ?? -Infinity; let by = 'the data date';
      for (const r of ps) {
        const p = byId.get(r.pred_task_id)!, f = parseP6Date(p.early_end_date);
        if (f == null) continue;
        if (es < f) checks.logicBroken.push(`${t.task_code} starts ${t.early_start_date} before its predecessor ${p.task_code} finishes ${p.early_end_date}`);
        if (f > rel) { rel = f; by = `${p.task_code} (finishes ${p.early_end_date})`; }
      }
      const expect = t.task_type === 'TT_FinMile' ? rel : cal.nextWorkStart(rel);
      if (es > expect && cal.workBetween(expect, es) > 0) checks.unexplainedDelay.push(`${t.task_code} starts ${t.early_start_date} although its only driver ${by} releases it at the next work time`);
    }

    // 4. Loops: P6 refuses to schedule a network with a circular relationship.
    const succ = new Map<string, string[]>();
    for (const r of db.tables.TASKPRED?.rows ?? []) { const p = byId.get(r.pred_task_id), q = byId.get(r.task_id); if (!p || !q) continue; let l = succ.get(p.task_code); if (!l) succ.set(p.task_code, (l = [])); l.push(q.task_code); }
    for (const loop of findLoops(succ)) checks.loops.push(`${loop.join(' → ')} → ${loop[0]}`);
    out.push({ file: s.name, checks });
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--detail');
  const detail = di >= 0 ? Number(args[di + 1]) : 3;
  const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--detail');
  for (const a of audit(filter)) {
    const bad = Object.entries(a.checks).filter(([, v]) => v.length);
    console.log(`${a.file.padEnd(44)} ${bad.length ? bad.map(([k, v]) => `${k}=${v.length}`).join(' ') : 'consistent'}`);
    for (const [k, v] of bad) for (const m of v.slice(0, detail)) console.log(`    [${k}] ${m}`);
  }
}
