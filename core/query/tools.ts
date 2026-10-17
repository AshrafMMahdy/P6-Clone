// Read-only project lookups, used by the AI assistant (as tools) and by the command-line `query`/`review` commands. A 100k-activity programme does not fit in one prompt,
// so the model asks for what it needs: a summary, filtered activity lists, one activity in full, the WBS, the critical
// path, a schedule health check and resource usage. Read-only.
import type { Db, Row } from '../db.ts';
import { rows } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { isCritical, traceLogic, type Ctx } from '../project/ctx.ts';
import { relationshipFloat } from '../schedule/cpm.ts';
import { statusOf, projectName } from '../project/edit.ts';
import { activityCosts, earnedValue, sumLines } from '../cost/rollup.ts';

/** A lookup described for a language model (JSON Schema parameters). */
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

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
    activity_code: { type: 'string', description: 'Activity code value, optionally with its type: "civil" or "TYPE OF WORK=civil" (code value or description)' },
    sort: { type: 'string', enum: ['start', 'finish', 'total_float', 'duration'], description: 'Default: start' },
    limit: { type: 'number', description: 'Default 25, at most 100' },
  } } },
  { name: 'get_activity', description: 'Everything about one activity: dates (early, late, actual, baseline), durations, float, constraints, calendar, predecessors and successors (with type, lag, driving and relationship free float), resource assignments, activity codes, user defined fields (UDFs), notes.', parameters: { type: 'object', properties: { activity_id: { type: 'string' } }, required: ['activity_id'] } },
  { name: 'list_wbs', description: 'The WBS tree with activity counts and date ranges. Optionally only below a WBS code, to a depth.', parameters: { type: 'object', properties: { under: { type: 'string', description: 'WBS code' }, depth: { type: 'number', description: 'Default 2' } } } },
  { name: 'critical_path', description: 'Activities on the longest path / critical (lowest total float), in start order.', parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Default 50' } } } },
  { name: 'schedule_health', description: 'Schedule quality checks a planning reviewer uses: open ends (missing predecessors/successors), negative float, hard constraints, long durations, lags and leads, FS vs other relationship types, out-of-sequence progress, activities with dates before the data date. Gives counts and examples.', parameters: { type: 'object', properties: {} } },
  { name: 'list_projects', description: 'Every project in the database (not only the open one): ID, name, status, start and finish, activity count, WBS top-level names, calendar. Use it to find past projects similar to the one being planned or asked about; then read one with the other lookups by passing its ID as "project".', parameters: { type: 'object', properties: { text: { type: 'string', description: 'only projects whose ID or name contains this' } } } },
  { name: 'trace_logic', description: 'Trace Logic (View > Show on Bottom > Trace Logic): an activity\'s predecessors and successors several levels deep, with each link\'s type, lag, relationship free float and whether it is driving. Use it to explain why an activity is where it is.', parameters: { type: 'object', properties: { activity_id: { type: 'string' }, predecessors: { type: 'number', description: 'levels back (default 3, max 10)' }, successors: { type: 'number', description: 'levels forward (default 3, max 10)' }, driving_only: { type: 'boolean' } }, required: ['activity_id'] } },
  { name: 'earned_value', description: 'Earned value as P6 calculates it (baseline budget, planned value at the data date, earned value from % complete, actual cost): project totals, each top-level WBS, and the activities with the worst cost and schedule performance (CPI/SPI). Money in the project currency.', parameters: { type: 'object', properties: { worst: { type: 'number', description: 'how many weakest activities to list (default 10)' } } } },
  { name: 'list_dictionaries', description: 'The dictionaries edit operations refer to by name: baselines (with which is the project baseline and BL1-BL3), activity/project/resource code types and their values, UDFs, cost accounts, calendars, resource curves, EPS, OBS and roles.', parameters: { type: 'object', properties: { only: { type: 'string', description: 'one of baselines, codes, udfs, accounts, calendars, curves, eps, obs, roles' }, max_values: { type: 'number', description: 'code values listed per type (default 50)' } } } },
  { name: 'resource_summary', description: 'Resources with their assignments: total budgeted/remaining units and cost, first/last use. With `resource`, the activities that resource is assigned to.', parameters: { type: 'object', properties: { resource: { type: 'string' }, limit: { type: 'number' } } } },
];
// every lookup can read a project other than the open one
for (const t of TOOLS) if (t.name !== 'list_projects') (t.parameters as { properties: Record<string, unknown> }).properties.project = { type: 'string', description: 'project ID to read instead of the open project(s), e.g. a past project from list_projects' };

const d = (s?: string) => (s ? s.slice(0, 16) : '');
const days = (h: string | number | undefined, hpd: number) => (h === '' || h == null ? null : Math.round((Number(h) / hpd) * 10) / 10);

export function runTool(name: string, args: Record<string, any>, db: Db, ctx: Ctx<unknown>, projIds: string[], hpd: number): unknown {
  const all = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  let open = new Set(projIds.length ? projIds : all.map((p) => p.proj_id));
  if (args.project != null && args.project !== '') {
    const p = all.find((x) => x.proj_short_name.toLowerCase() === String(args.project).toLowerCase());
    if (!p) return { error: `No project "${args.project}". list_projects shows the IDs.` };
    open = new Set([p.proj_id]);
  }
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id));
  const wbsById = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const wbsPath = (id: string) => { const out: string[] = []; for (let w = wbsById.get(id), n = 0; w && n < 50; w = wbsById.get(w.parent_wbs_id), n++) if (w.proj_node_flag !== 'Y') out.unshift(w.wbs_short_name); return out.join('.'); };
  const start = (t: Row) => t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date || '';
  const finish = (t: Row) => t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date || '';
  const brief = (t: Row) => ({ id: t.task_code, name: t.task_name, status: STATUS[statusOf(t)] ?? statusOf(t), type: TYPE[t.task_type] ?? t.task_type, start: d(start(t)) + (t.act_start_date ? ' A' : ''), finish: d(finish(t)) + (t.act_end_date ? ' A' : ''), orig_days: days(t.target_drtn_hr_cnt, hpd), rem_days: days(t.remain_drtn_hr_cnt, hpd), total_float_days: t.act_end_date ? null : days(t.total_float_hr_cnt, hpd), critical: isCritical(t, ctx), wbs: wbsPath(t.wbs_id) });
  const byCode = (code: string) => tasks.find((t) => t.task_code.toLowerCase() === String(code).toLowerCase());

  switch (name) {
    case 'list_dictionaries': {
      const want = (k: string) => !args.only || String(args.only).toLowerCase() === k;
      const maxV = Math.min(1000, Number(args.max_values) || 50);
      const P = rows(db, 'PROJECT');
      const nameOf = (id: string) => P.find((p) => p.proj_id === id)?.proj_short_name ?? null;
      const codes = (type: string, tid: string, tname: string, val: string, vshort: string, vname: string) => rows(db, type).map((t) => { const vs = rows(db, val).filter((v) => v[tid] === t[tid]); return { type: t[tname], values: vs.slice(0, maxV).map((v) => ({ code: v[vshort], name: v[vname] })), total_values: vs.length }; });
      const tree = (tb: string, key: string, name: string, id: string, parent: string) => { const R = rows(db, tb); return R.map((r) => ({ id: r[key], name: r[name], parent: R.find((x) => x[id] === r[parent])?.[key] ?? null })); };
      return {
        ...(want('baselines') ? { baselines: all.filter((p) => open.has(p.proj_id)).map((p) => ({ project: p.proj_short_name, project_baseline: nameOf(p.sum_base_proj_id), bl1: nameOf(p._bl1), bl2: nameOf(p._bl2), bl3: nameOf(p._bl3), saved: P.filter((b) => b._baseline_of === p.proj_id).map((b) => ({ name: b.proj_short_name, saved_on: d(b._baseline_date), finish: d(b.scd_end_date || b.plan_end_date) })) })) } : {}),
        ...(want('codes') ? { activity_codes: codes('ACTVTYPE', 'actv_code_type_id', 'actv_code_type', 'ACTVCODE', 'short_name', 'actv_code_name'), project_codes: codes('PCATTYPE', 'proj_catg_type_id', 'proj_catg_type', 'PCATVAL', 'proj_catg_short_name', 'proj_catg_name'), resource_codes: codes('RCATTYPE', 'rsrc_catg_type_id', 'rsrc_catg_type', 'RCATVAL', 'rsrc_catg_short_name', 'rsrc_catg_name') } : {}),
        ...(want('udfs') ? { udfs: rows(db, 'UDFTYPE').map((u) => ({ name: u.udf_type_label, subject: u.table_name, data_type: u.logical_data_type })) } : {}),
        ...(want('accounts') ? { cost_accounts: tree('ACCOUNT', 'acct_short_name', 'acct_name', 'acct_id', 'parent_acct_id') } : {}),
        ...(want('calendars') ? { calendars: rows(db, 'CALENDAR').map((c) => ({ name: c.clndr_name, type: c.clndr_type?.replace(/^CA_/, ''), hours_per_day: Number(c.day_hr_cnt) || null, project: c.proj_id ? nameOf(c.proj_id) : undefined })) } : {}),
        ...(want('curves') ? { resource_curves: rows(db, 'RSRCCURVDATA').map((c) => c.curv_name) } : {}),
        ...(want('eps') ? { eps: tree('EPS', 'eps_short_name', 'eps_name', 'eps_id', 'parent_eps_id') } : {}),
        ...(want('obs') ? { obs: tree('OBS', 'obs_name', 'obs_name', 'obs_id', 'parent_obs_id') } : {}),
        ...(want('roles') ? { roles: tree('ROLES', 'role_short_name', 'role_name', 'role_id', 'parent_role_id') } : {}),
      };
    }
    case 'list_projects': {
      const q = String(args.text ?? '').toLowerCase();
      const count = new Map<string, number>();
      for (const t of rows(db, 'TASK')) count.set(t.proj_id, (count.get(t.proj_id) ?? 0) + 1);
      const W = rows(db, 'PROJWBS');
      const roots = new Map(W.filter((w) => w.proj_node_flag === 'Y').map((w) => [w.proj_id, w.wbs_id]));
      const out = all.filter((p) => !q || p.proj_short_name.toLowerCase().includes(q) || projectName(db, p).toLowerCase().includes(q)).map((p) => ({
        id: p.proj_short_name, name: projectName(db, p), open: projIds.includes(p.proj_id), status: p.status_code?.replace(/^PS_/, '') || undefined,
        start: d(p.plan_start_date), data_date: d(p.last_recalc_date), finish: d(p.scd_end_date || p.plan_end_date), activities: count.get(p.proj_id) ?? 0,
        top_wbs: W.filter((w) => w.parent_wbs_id === roots.get(p.proj_id)).slice(0, 12).map((w) => w.wbs_name),
        calendar: rows(db, 'CALENDAR').find((c) => c.clndr_id === p.clndr_id)?.clndr_name,
      }));
      return { projects: out.slice(0, 200), total: out.length };
    }
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
      if (args.activity_code) {
        const raw = String(args.activity_code), eq = raw.indexOf('=');
        const [ty, val] = (eq >= 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : ['', raw]).map((s) => s.trim().toLowerCase());
        const types = new Set(rows(db, 'ACTVTYPE').filter((x) => !ty || x.actv_code_type.toLowerCase() === ty).map((x) => x.actv_code_type_id));
        const codes = new Set(rows(db, 'ACTVCODE').filter((c) => types.has(c.actv_code_type_id) && (c.short_name.toLowerCase() === val || (c.actv_code_name ?? '').toLowerCase() === val)).map((c) => c.actv_code_id));
        const withC = new Set(rows(db, 'TASKACTV').filter((a) => codes.has(a.actv_code_id)).map((a) => a.task_id));
        list = list.filter((t) => withC.has(t.task_id));
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
      const relFF = relationshipFloat(db, ctx);
      const rel = (r: Row, other: string) => {
        const o = byId.get(other), ff = relFF(r);
        return { id: o?.task_code ?? other, name: o?.task_name ?? '(outside the open projects)', type: r.pred_type.replace('PR_', ''), lag_days: days(r.lag_hr_cnt, hpd), other_start: d(o ? start(o) : ''), other_finish: d(o ? finish(o) : ''), driving: ff == null ? null : ff === 0, rel_free_float_days: ff == null ? null : Math.round((ff / 60 / hpd) * 100) / 100 };
      };
      const bl = ctx.baseline.get(`${t.task_code}|${t.proj_id}`);
      const cal = rows(db, 'CALENDAR').find((c) => c.clndr_id === t.clndr_id);
      const codes = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c])), codeTypes = new Map(rows(db, 'ACTVTYPE').map((c) => [c.actv_code_type_id, c.actv_code_type]));
      const udfTypes = new Map(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK').map((u) => [u.udf_type_id, u.udf_type_label]));
      const udfCodes = new Map(rows(db, 'UDFCODE').map((c) => [c.udf_code_id, c.short_name]));
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
        activity_codes: Object.fromEntries(rows(db, 'TASKACTV').filter((a) => a.task_id === t.task_id).map((a) => {
          const c = codes.get(a.actv_code_id);
          return [codeTypes.get(a.actv_code_type_id || c?.actv_code_type_id || '') ?? a.actv_code_type_id, c ? [c.short_name, c.actv_code_name].filter(Boolean).join(' - ') : a.actv_code_id];
        })),
        udfs: Object.fromEntries(rows(db, 'UDFVALUE').filter((v) => v.fk_id === t.task_id && udfTypes.has(v.udf_type_id))
          .map((v) => [udfTypes.get(v.udf_type_id), v.udf_text || (v.udf_date ? d(v.udf_date) : '') || (v.udf_code_id ? udfCodes.get(v.udf_code_id) ?? v.udf_code_id : '') || v.udf_number || ''])),
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
    case 'trace_logic': {
      const t = byCode(String(args.activity_id ?? ''));
      if (!t) return { error: `No activity with ID "${args.activity_id}" in the open project(s).` };
      const lv = (v: unknown) => Math.max(0, Math.min(10, Number.isFinite(Number(v)) && v != null ? Number(v) : 3));
      const relFF = relationshipFloat(db, ctx);
      const tr = traceLogic(ctx as never, t.task_id, { preds: lv(args.predecessors), succs: lv(args.successors), drivingOnly: !!args.driving_only, maxPerLevel: 40 }, relFF);
      const code = (id: string) => ctx.taskById.get(id)?.task_code ?? id;
      return {
        activity: brief(t),
        levels: [...tr.levels].sort((a, b) => a[0] - b[0]).filter(([l]) => l !== 0).map(([l, ids]) => ({ level: l, direction: l < 0 ? 'predecessors' : 'successors', activities: ids.map((id) => brief(ctx.taskById.get(id)!)), ...(tr.more.get(l) ? { more_not_listed: tr.more.get(l) } : {}) })),
        links: tr.links.map((x) => ({ pred: code(x.from), succ: code(x.to), type: (x.rel.pred_type || 'PR_FS').slice(3), lag_days: days(x.rel.lag_hr_cnt || '0', hpd), free_float_days: x.ff == null ? null : days(x.ff, hpd), driving: x.ff === 0 })),
      };
    }
    case 'earned_value': {
      const costs = activityCosts(db, [...open]);
      const round = (v: number) => Math.round(v * 100) / 100;
      const pack = (l: ReturnType<typeof sumLines>) => { const e = earnedValue(l); return { bac: round(e.bac), pv: round(e.pv), ev: round(e.ev), ac: round(e.ac), sv: round(e.sv), cv: round(e.cv), spi: round(e.spi), cpi: round(e.cpi), etc: round(e.etc), eac: round(e.eac), vac: round(e.vac), schedule_pct: round(e.schedulePct), performance_pct: round(e.performancePct) }; };
      const kids = new Map<string, Row[]>(); for (const w of rows(db, 'PROJWBS')) { const l = kids.get(w.parent_wbs_id); if (l) l.push(w); else kids.set(w.parent_wbs_id, [w]); }
      const under = (id: string): string[] => [id, ...(kids.get(id) ?? []).flatMap((k) => under(k.wbs_id))];
      const projects = [...open].map((pid) => {
        const root = rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
        const top = root ? (kids.get(root.wbs_id) ?? []).filter((w) => w.proj_id === pid) : [];
        return {
          project: ctx.proj.get(pid)?.proj_short_name, data_date: d(ctx.proj.get(pid)?.last_recalc_date), has_baseline: !!ctx.proj.get(pid)?.sum_base_proj_id,
          totals: pack(sumLines(tasks.filter((t) => t.proj_id === pid).map((t) => costs.get(t.task_id)!).filter(Boolean))),
          by_wbs: top.map((w) => { const ids = new Set(under(w.wbs_id)); return { wbs: w.wbs_short_name, name: w.wbs_name, ...pack(sumLines(tasks.filter((t) => ids.has(t.wbs_id)).map((t) => costs.get(t.task_id)!).filter(Boolean))) }; }),
        };
      });
      const scored = tasks.map((t) => ({ t, e: earnedValue(costs.get(t.task_id)!) })).filter((x) => x.e.bac > 0 && (x.e.ac > 0 || x.e.pv > 0));
      const n = Math.min(50, Number(args.worst) || 10);
      return {
        projects,
        worst_cost_performance: scored.filter((x) => x.e.ac > 0).sort((a, b) => a.e.cpi - b.e.cpi).slice(0, n).map((x) => ({ id: x.t.task_code, name: x.t.task_name, cpi: round(x.e.cpi), cv: round(x.e.cv) })),
        worst_schedule_performance: scored.filter((x) => x.e.pv > 0).sort((a, b) => a.e.spi - b.e.spi).slice(0, n).map((x) => ({ id: x.t.task_code, name: x.t.task_name, spi: round(x.e.spi), sv: round(x.e.sv) })),
        note: 'BAC = baseline budget (current budget when no baseline is assigned). PV = BAC x baseline time elapsed at the data date. EV = BAC x % complete. SPI = EV/PV, CPI = EV/AC, EAC = AC + remaining cost, VAC = BAC - EAC.',
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
