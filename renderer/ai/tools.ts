// What the AI assistant can look up in the open project(s). A 100k-activity programme does not fit in one prompt,
// so the model asks for what it needs: a summary, filtered activity lists, one activity in full, the WBS, the critical
// path, a schedule health check and resource usage. Read-only.
import type { Db, Row } from '../../core/db.ts';
import { rows } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import type { ToolDef } from '../../main/ai.ts';
import { isCritical, statusOf, projectName, type Ctx } from '../model.ts';

const STATUS: Record<string, string> = { TK_NotStart: 'not started', TK_Active: 'in progress', TK_Complete: 'completed' };
const TYPE: Record<string, string> = { TT_Task: 'task', TT_Rsrc: 'resource dependent', TT_Mile: 'start milestone', TT_FinMile: 'finish milestone', TT_LOE: 'level of effort', TT_WBS: 'WBS summary' };

export const TOOLS: ToolDef[] = [
  { name: 'project_summary', description: 'Overview of the open project(s): names, data date, start/finish, activity counts by status, critical and negative-float counts, WBS top level, calendars and resources. Call this first.', parameters: { type: 'object', properties: {} } },
  { name: 'find_activities', description: 'Search activities. All filters are optional and combined. Returns up to `limit` rows (ID, name, status, start, finish, durations in days, total float in days, WBS).', parameters: { type: 'object', properties: {
    text: { type: 'string', description: 'Text in the activity ID or name (case-insensitive)' },
    status: { type: 'string', enum: ['not_started', 'in_progress', 'completed'] },
    critical: { type: 'boolean' },
    wbs: { type: 'string', description: 'WBS code or name (matches the WBS and everything under it)' },
    resource: { type: 'string', description: 'Resource ID or name assigned to the activity' },
    starts_after: { type: 'string', description: 'YYYY-MM-DD' }, starts_before: { type: 'string', description: 'YYYY-MM-DD' },
    finishes_after: { type: 'string', description: 'YYYY-MM-DD' }, finishes_before: { type: 'string', description: 'YYYY-MM-DD' },
    max_total_float_days: { type: 'number' }, min_total_float_days: { type: 'number' },
    milestones_only: { type: 'boolean' },
    sort: { type: 'string', enum: ['start', 'finish', 'total_float', 'duration'], description: 'Default: start' },
    limit: { type: 'number', description: 'Default 25, at most 100' },
  } } },
  { name: 'get_activity', description: 'Everything about one activity: dates (early, late, actual, baseline), durations, float, constraints, calendar, predecessors and successors (with type and lag), resource assignments, notes.', parameters: { type: 'object', properties: { activity_id: { type: 'string' } }, required: ['activity_id'] } },
  { name: 'list_wbs', description: 'The WBS tree with activity counts and date ranges. Optionally only below a WBS code, to a depth.', parameters: { type: 'object', properties: { under: { type: 'string', description: 'WBS code' }, depth: { type: 'number', description: 'Default 2' } } } },
  { name: 'critical_path', description: 'Activities on the longest path / critical (lowest total float), in start order.', parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Default 50' } } } },
  { name: 'schedule_health', description: 'Schedule quality checks a planning reviewer uses: open ends (missing predecessors/successors), negative float, hard constraints, long durations, lags and leads, FS vs other relationship types, out-of-sequence progress, activities with dates before the data date. Gives counts and examples.', parameters: { type: 'object', properties: {} } },
  { name: 'resource_summary', description: 'Resources with their assignments: total budgeted/remaining units and cost, first/last use. With `resource`, the activities that resource is assigned to.', parameters: { type: 'object', properties: { resource: { type: 'string' }, limit: { type: 'number' } } } },
];

const d = (s?: string) => (s ? s.slice(0, 16) : '');
const days = (h: string | number | undefined, hpd: number) => (h === '' || h == null ? null : Math.round((Number(h) / hpd) * 10) / 10);

export function runTool(name: string, args: Record<string, any>, db: Db, ctx: Ctx, projIds: string[], hpd: number): unknown {
  const open = new Set(projIds.length ? projIds : rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id));
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id));
  const wbsById = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const wbsPath = (id: string) => { const out: string[] = []; for (let w = wbsById.get(id), n = 0; w && n < 50; w = wbsById.get(w.parent_wbs_id), n++) if (w.proj_node_flag !== 'Y') out.unshift(w.wbs_short_name); return out.join('.'); };
  const start = (t: Row) => t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date || '';
  const finish = (t: Row) => t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date || '';
  const brief = (t: Row) => ({ id: t.task_code, name: t.task_name, status: STATUS[statusOf(t)] ?? statusOf(t), type: TYPE[t.task_type] ?? t.task_type, start: d(start(t)) + (t.act_start_date ? ' A' : ''), finish: d(finish(t)) + (t.act_end_date ? ' A' : ''), orig_days: days(t.target_drtn_hr_cnt, hpd), rem_days: days(t.remain_drtn_hr_cnt, hpd), total_float_days: t.act_end_date ? null : days(t.total_float_hr_cnt, hpd), critical: isCritical(t, ctx), wbs: wbsPath(t.wbs_id) });
  const byCode = (code: string) => tasks.find((t) => t.task_code.toLowerCase() === String(code).toLowerCase());

  switch (name) {
    case 'project_summary': {
      const projs = [...open].map((id) => ctx.proj.get(id)).filter((p): p is Row => !!p);
      const count = (s: string) => tasks.filter((t) => statusOf(t) === s).length;
      const top = rows(db, 'PROJWBS').filter((w) => open.has(w.proj_id) && wbsById.get(w.parent_wbs_id)?.proj_node_flag === 'Y');
      return {
        projects: projs.map((p) => ({ id: p.proj_short_name, name: projectName(db, p), data_date: d(p.last_recalc_date), planned_start: d(p.plan_start_date), must_finish_by: d(p.plan_end_date), scheduled_finish: d(p.scd_end_date) })),
        activities: tasks.length, not_started: count('TK_NotStart'), in_progress: count('TK_Active'), completed: count('TK_Complete'),
        critical: tasks.filter((t) => !t.act_end_date && isCritical(t, ctx)).length,
        negative_float: tasks.filter((t) => !t.act_end_date && Number(t.total_float_hr_cnt) < 0).length,
        milestones: tasks.filter((t) => t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile').length,
        relationships: rows(db, 'TASKPRED').filter((r) => open.has(r.proj_id)).length,
        earliest_start: d(tasks.map(start).filter(Boolean).sort()[0]), latest_finish: d(tasks.map(finish).filter(Boolean).sort().pop()),
        wbs_top_level: top.slice(0, 40).map((w) => `${w.wbs_short_name} ${w.wbs_name}`),
        calendars: rows(db, 'CALENDAR').length, resources: new Set(rows(db, 'TASKRSRC').filter((a) => open.has(a.proj_id)).map((a) => a.rsrc_id)).size,
        hours_per_day_used_for_days: hpd,
      };
    }
    case 'find_activities': {
      let list = tasks.filter((t) => t.task_type !== 'TT_WBS');
      if (args.text) { const q = String(args.text).toLowerCase(); list = list.filter((t) => t.task_code.toLowerCase().includes(q) || t.task_name.toLowerCase().includes(q)); }
      if (args.status) list = list.filter((t) => statusOf(t) === ({ not_started: 'TK_NotStart', in_progress: 'TK_Active', completed: 'TK_Complete' } as Record<string, string>)[args.status]);
      if (args.critical != null) list = list.filter((t) => !t.act_end_date && isCritical(t, ctx) === !!args.critical);
      if (args.milestones_only) list = list.filter((t) => t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile');
      if (args.wbs) {
        const q = String(args.wbs).toLowerCase();
        const roots = new Set([...wbsById.values()].filter((w) => open.has(w.proj_id) && (wbsPath(w.wbs_id).toLowerCase() === q || w.wbs_short_name.toLowerCase() === q || w.wbs_name.toLowerCase().includes(q))).map((w) => w.wbs_id));
        const under = (id: string) => { for (let w: string | undefined = id, n = 0; w && n < 50; w = wbsById.get(w)?.parent_wbs_id, n++) if (roots.has(w)) return true; return false; };
        list = list.filter((t) => under(t.wbs_id));
      }
      if (args.resource) {
        const q = String(args.resource).toLowerCase();
        const ids = new Set(rows(db, 'RSRC').filter((r) => r.rsrc_short_name.toLowerCase() === q || r.rsrc_name.toLowerCase().includes(q)).map((r) => r.rsrc_id));
        const withR = new Set(rows(db, 'TASKRSRC').filter((a) => ids.has(a.rsrc_id)).map((a) => a.task_id));
        list = list.filter((t) => withR.has(t.task_id));
      }
      const day = (s?: string) => (s ? parseP6Date(s) : null);
      if (args.starts_after) list = list.filter((t) => (day(start(t)) ?? -Infinity) >= day(args.starts_after)!);
      if (args.starts_before) list = list.filter((t) => (day(start(t)) ?? Infinity) <= day(args.starts_before)! + 1439);
      if (args.finishes_after) list = list.filter((t) => (day(finish(t)) ?? -Infinity) >= day(args.finishes_after)!);
      if (args.finishes_before) list = list.filter((t) => (day(finish(t)) ?? Infinity) <= day(args.finishes_before)! + 1439);
      const tf = (t: Row) => (t.total_float_hr_cnt === '' || t.act_end_date ? null : Number(t.total_float_hr_cnt) / hpd);
      if (args.max_total_float_days != null) list = list.filter((t) => tf(t) != null && tf(t)! <= Number(args.max_total_float_days));
      if (args.min_total_float_days != null) list = list.filter((t) => tf(t) != null && tf(t)! >= Number(args.min_total_float_days));
      const key: Record<string, (t: Row) => number | string> = { start: (t) => start(t), finish: (t) => finish(t), total_float: (t) => tf(t) ?? 1e9, duration: (t) => -Number(t.target_drtn_hr_cnt || 0) };
      const k = key[args.sort] ?? key.start;
      list.sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : 0; });
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
      return { total_matches: list.length, shown: Math.min(limit, list.length), activities: list.slice(0, limit).map(brief) };
    }
    case 'get_activity': {
      const t = byCode(args.activity_id);
      if (!t) return { error: `No activity with ID "${args.activity_id}" in the open project(s).` };
      const byId = ctx.taskById;
      const rel = (r: Row, other: string) => { const o = byId.get(other); return { id: o?.task_code ?? other, name: o?.task_name ?? '(outside the open projects)', type: r.pred_type.replace('PR_', ''), lag_days: days(r.lag_hr_cnt, hpd), other_start: d(o ? start(o) : ''), other_finish: d(o ? finish(o) : '') }; };
      const bl = ctx.baseline.get(`${t.task_code}|${t.proj_id}`);
      const cal = rows(db, 'CALENDAR').find((c) => c.clndr_id === t.clndr_id);
      return {
        ...brief(t),
        early_start: d(t.early_start_date), early_finish: d(t.early_end_date), late_start: d(t.late_start_date), late_finish: d(t.late_end_date),
        actual_start: d(t.act_start_date), actual_finish: d(t.act_end_date), free_float_days: days(t.free_float_hr_cnt, hpd),
        baseline_start: bl ? d(bl.act_start_date || bl.target_start_date) : null, baseline_finish: bl ? d(bl.act_end_date || bl.target_end_date) : null,
        percent_complete: t.phys_complete_pct, duration_type: t.duration_type, calendar: cal?.clndr_name ?? t.clndr_id,
        constraint: t.cstr_type ? `${t.cstr_type} ${d(t.cstr_date)}` : null, constraint2: t.cstr_type2 ? `${t.cstr_type2} ${d(t.cstr_date2)}` : null,
        predecessors: (ctx.predsOf.get(t.task_id) ?? []).slice(0, 60).map((r) => rel(r, r.pred_task_id)),
        successors: (ctx.succsOf.get(t.task_id) ?? []).slice(0, 60).map((r) => rel(r, r.task_id)),
        resources: rows(db, 'TASKRSRC').filter((a) => a.task_id === t.task_id).slice(0, 40).map((a) => ({ resource: ctx.rsrc.get(a.rsrc_id)?.rsrc_short_name ?? a.rsrc_id, name: ctx.rsrc.get(a.rsrc_id)?.rsrc_name ?? '', budgeted_units: Number(a.target_qty || 0), remaining_units: Number(a.remain_qty || 0), units_per_day: Math.round(Number(a.remain_qty_per_hr || a.target_qty_per_hr || 0) * hpd * 100) / 100, budgeted_cost: Number(a.target_cost || 0) })),
        notes: rows(db, 'TASKMEMO').filter((m) => m.task_id === t.task_id).map((m) => (m.task_memo ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)).filter(Boolean),
      };
    }
    case 'list_wbs': {
      const depth = Math.min(6, Math.max(1, Number(args.depth) || 2));
      const kids = new Map<string, Row[]>();
      for (const w of wbsById.values()) if (open.has(w.proj_id)) { let l = kids.get(w.parent_wbs_id); if (!l) kids.set(w.parent_wbs_id, (l = [])); l.push(w); }
      const tasksUnder = new Map<string, Row[]>();
      for (const t of tasks) for (let w: string | undefined = t.wbs_id, n = 0; w && n < 50; w = wbsById.get(w)?.parent_wbs_id, n++) { let l = tasksUnder.get(w); if (!l) tasksUnder.set(w, (l = [])); l.push(t); }
      const roots = args.under ? [...wbsById.values()].filter((w) => open.has(w.proj_id) && (wbsPath(w.wbs_id).toLowerCase() === String(args.under).toLowerCase() || w.wbs_short_name.toLowerCase() === String(args.under).toLowerCase())) : [...wbsById.values()].filter((w) => open.has(w.proj_id) && w.proj_node_flag === 'Y');
      const out: unknown[] = [];
      const walk = (w: Row, lvl: number) => {
        const ts = tasksUnder.get(w.wbs_id) ?? [];
        if (out.length < 200) out.push({ level: lvl, code: wbsPath(w.wbs_id) || w.wbs_short_name, name: w.wbs_name, activities: ts.length, start: d(ts.map(start).filter(Boolean).sort()[0]), finish: d(ts.map(finish).filter(Boolean).sort().pop()), critical: ts.filter((t) => !t.act_end_date && isCritical(t, ctx)).length });
        if (lvl < depth) for (const c of (kids.get(w.wbs_id) ?? []).sort((a, b) => Number(a.seq_num) - Number(b.seq_num))) walk(c, lvl + 1);
      };
      for (const r of roots) walk(r, 0);
      return { wbs: out, truncated: out.length >= 200 };
    }
    case 'critical_path': {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const crit = tasks.filter((t) => !t.act_end_date && t.task_type !== 'TT_WBS' && (t.driving_path_flag === 'Y' || isCritical(t, ctx))).sort((a, b) => start(a).localeCompare(start(b)));
      return { total: crit.length, longest_path_flags_present: tasks.some((t) => t.driving_path_flag === 'Y'), activities: crit.slice(0, limit).map(brief) };
    }
    case 'schedule_health': {
      const live = tasks.filter((t) => !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
      const P = rows(db, 'TASKPRED').filter((r) => open.has(r.proj_id));
      const ex = (l: Row[]) => ({ count: l.length, examples: l.slice(0, 8).map((t) => `${t.task_code} ${t.task_name}`) });
      const dd = parseP6Date([...open].map((id) => ctx.proj.get(id)?.last_recalc_date).find(Boolean));
      const noPred = live.filter((t) => !(ctx.predsOf.get(t.task_id)?.length));
      const noSucc = live.filter((t) => !(ctx.succsOf.get(t.task_id)?.length));
      const hard = live.filter((t) => /MANDSTART|MANDFIN|CS_MSO$|CS_MEO$/.test(t.cstr_type ?? '') || /MANDSTART|MANDFIN/.test(t.cstr_type2 ?? ''));
      const anyCstr = live.filter((t) => t.cstr_type || t.cstr_type2);
      const longDur = live.filter((t) => Number(t.remain_drtn_hr_cnt) / hpd > 44);
      const neg = live.filter((t) => Number(t.total_float_hr_cnt) < 0);
      const highTf = live.filter((t) => Number(t.total_float_hr_cnt) / hpd > 44);
      const leads = P.filter((r) => Number(r.lag_hr_cnt) < 0), lags = P.filter((r) => Number(r.lag_hr_cnt) > 0);
      const types = P.reduce<Record<string, number>>((a, r) => ((a[r.pred_type] = (a[r.pred_type] ?? 0) + 1), a), {});
      const stale = dd == null ? [] : live.filter((t) => !t.act_start_date && (parseP6Date(t.early_start_date) ?? Infinity) < dd);
      const oos = live.filter((t) => t.act_start_date && (ctx.predsOf.get(t.task_id) ?? []).some((r) => { const p = ctx.taskById.get(r.pred_task_id); return r.pred_type === 'PR_FS' && p && !p.act_end_date; }));
      return {
        open_activities: live.length, relationships: P.length,
        missing_predecessors: ex(noPred), missing_successors: ex(noSucc),
        negative_float: ex(neg), high_float_over_44_days: ex(highTf),
        hard_constraints: ex(hard), any_constraints: ex(anyCstr),
        remaining_duration_over_44_days: ex(longDur),
        leads_negative_lag: leads.length, positive_lags: lags.length, relationship_types: types,
        started_out_of_sequence: ex(oos), not_started_but_dated_before_data_date: ex(stale),
        note: 'Thresholds follow the common DCMA 14-point guidance (44 working days, 5% limits).',
      };
    }
    case 'resource_summary': {
      const A = rows(db, 'TASKRSRC').filter((a) => open.has(a.proj_id));
      if (args.resource) {
        const q = String(args.resource).toLowerCase();
        const r = rows(db, 'RSRC').find((x) => x.rsrc_short_name.toLowerCase() === q) ?? rows(db, 'RSRC').find((x) => x.rsrc_name.toLowerCase().includes(q));
        if (!r) return { error: `No resource "${args.resource}".` };
        const mine = A.filter((a) => a.rsrc_id === r.rsrc_id);
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        return { resource: r.rsrc_short_name, name: r.rsrc_name, type: r.rsrc_type, assignments: mine.length, activities: mine.slice(0, limit).map((a) => { const t = ctx.taskById.get(a.task_id); return { ...(t ? brief(t) : { id: a.task_id }), budgeted_units: Number(a.target_qty || 0), remaining_units: Number(a.remain_qty || 0) }; }) };
      }
      const by = new Map<string, Row[]>();
      for (const a of A) { let l = by.get(a.rsrc_id); if (!l) by.set(a.rsrc_id, (l = [])); l.push(a); }
      return { resources: [...by].map(([id, l]) => ({ resource: ctx.rsrc.get(id)?.rsrc_short_name ?? id, name: ctx.rsrc.get(id)?.rsrc_name ?? '', type: ctx.rsrc.get(id)?.rsrc_type ?? '', assignments: l.length, budgeted_units: Math.round(l.reduce((x, a) => x + Number(a.target_qty || 0), 0)), remaining_units: Math.round(l.reduce((x, a) => x + Number(a.remain_qty || 0), 0)), budgeted_cost: Math.round(l.reduce((x, a) => x + Number(a.target_cost || 0), 0)) })).sort((a, b) => b.assignments - a.assignments).slice(0, 80) };
    }
  }
  return { error: `Unknown tool ${name}` };
}
