// Control: a forecast from what has been produced, and alarms. Each trade goes on at the rate it actually achieved
// over the last weeks (actual working days ÷ planned days of the locations it finished in that window, else of all it
// finished), with its planned crew. Buffers are absorbed: an alarm is raised only when a predecessor's forecast finish
// in a location runs past the successor's planned start there (lag included, buffer not), ranked by the working days
// left to react. The plan is not changed.
import { rows, type Db } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { activityId } from './expand.ts';
import { locationDurations } from './edit.ts';
import type { LobModel } from './model.ts';

export interface LobAlarm { pred: string; succ: string; location: string; predFinish: string; succStart: string; daysToReact: number }
export interface LobForecast { dataDate: string; rates: Record<string, number>; forecast: Record<string, [string, string][]>; alarms: LobAlarm[] }

export function forecastLob(db: Db, projId: string, m: LobModel, o: { windowDays?: number; hoursPerDay: number }): LobForecast {
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const cal = calendarResolver(db, []).fallback(proj.clndr_id);
  const dd = parseP6Date(proj.last_recalc_date) ?? Math.floor(Date.now() / 60000);
  const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  const windowStart = cal.subWork(dd, (o.windowDays ?? 21) * o.hoursPerDay * 60);
  const days = (a: number, b: number) => cal.workBetween(a, b) / 60 / o.hoursPerDay;
  const out: LobForecast = { dataDate: formatP6Date(dd), rates: {}, forecast: {}, alarms: [] };
  const fc = new Map<string, [number, number]>();
  for (const t of m.tasks) {
    const d = locationDurations(m, t), locs = t.order.filter((c) => d.has(c));
    // the ratio actually achieved: recent finished locations, else all finished
    const done = locs.map((c) => byCode.get(activityId(t.code, c))).filter((a) => a?.act_start_date && a.act_end_date);
    const recent = done.filter((a) => parseP6Date(a!.act_end_date)! >= windowStart);
    const basis = recent.length ? recent : done;
    const planned = basis.reduce((n, a) => n + Number(a!.target_drtn_hr_cnt || 0) / o.hoursPerDay, 0);
    const actual = basis.reduce((n, a) => n + days(parseP6Date(a!.act_start_date)!, parseP6Date(a!.act_end_date)!), 0);
    const ratio = planned > 0 ? actual / planned : 1;
    out.rates[t.code] = Math.round(ratio * 100) / 100;
    let cursor: number | null = null;
    const rowsOut: [string, string][] = [];
    for (const c of locs) {
      const a = byCode.get(activityId(t.code, c));
      if (!a) continue;
      if (a.act_end_date) { const s = parseP6Date(a.act_start_date)!, f = parseP6Date(a.act_end_date)!; fc.set(a.task_code, [s, f]); rowsOut.push([formatP6Date(s), formatP6Date(f)]); cursor = f; continue; }
      const remain = (a.act_start_date ? Number(a.remain_drtn_hr_cnt || 0) : Number(a.target_drtn_hr_cnt || 0)) * 60 * ratio;
      const plannedStart = parseP6Date(a.early_start_date) ?? dd;
      const s = a.act_start_date ? parseP6Date(a.act_start_date)! : cal.nextWorkStart(Math.max(dd, cursor ?? (t.order.indexOf(c) === 0 || !rowsOut.length ? plannedStart : dd)));
      const f = cal.addWork(Math.max(s, dd), remain);
      fc.set(a.task_code, [s, f]); rowsOut.push([formatP6Date(s), formatP6Date(f)]); cursor = f;
    }
    out.forecast[t.code] = rowsOut;
  }
  // interference: a predecessor's forecast in a location against the successor's plan there
  for (const l of m.links) {
    if (l.kind !== 'task' || l.project) continue;
    const p = m.tasks.find((x) => x.code === l.pred), s = m.tasks.find((x) => x.code === l.succ);
    if (!p || !s) continue;
    for (const c of s.order) {
      const pa = fc.get(activityId(p.code, c)), sa = byCode.get(activityId(s.code, c));
      if (!pa || !sa || sa.act_start_date) continue;
      const succStart = parseP6Date(sa.early_start_date);
      if (succStart == null) continue;
      const need = l.lagDays ? cal.addWork(pa[1], l.lagDays * o.hoursPerDay * 60) : pa[1];
      if (cal.workBetween(succStart, need) <= 0) continue;
      out.alarms.push({ pred: p.code, succ: s.code, location: c, predFinish: formatP6Date(pa[1]), succStart: formatP6Date(succStart), daysToReact: Math.round(days(dd, succStart) * 10) / 10 });
    }
  }
  out.alarms.sort((a, b) => a.daysToReact - b.daysToReact);
  return out;
}
