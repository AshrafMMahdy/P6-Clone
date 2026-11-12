import { KEYS, type Db, type Row } from './db.ts';
import { dayHours } from './project/units.ts';

export interface DiffEntry { table: string; key: string; kind: 'added' | 'removed' | 'changed'; field?: string; a?: string; b?: string }

/** Row identity: table key, else activity code / names for readability, else all values. */
function rowKey(table: string, r: Row): string {
  const k = KEYS[table];
  if (k && r[k]) return r[k];
  if (table === 'TASKACTV') return `${r.task_id}/${r.actv_code_type_id}`;
  if (table === 'UDFVALUE') return `${r.udf_type_id}/${r.fk_id}`;
  return Object.values(r).join('|');
}

/** Field-level differences between two databases (b relative to a). */
export function diffDbs(a: Db, b: Db, opts: { ignoreFields?: string[] } = {}): DiffEntry[] {
  const ignore = new Set(opts.ignoreFields ?? []);
  const out: DiffEntry[] = [];
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  for (const t of names) {
    const ma = new Map((a.tables[t]?.rows ?? []).map((r) => [rowKey(t, r), r]));
    const mb = new Map((b.tables[t]?.rows ?? []).map((r) => [rowKey(t, r), r]));
    for (const [k, ra] of ma) {
      const rb = mb.get(k);
      if (!rb) { out.push({ table: t, key: k, kind: 'removed' }); continue; }
      for (const f of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (ignore.has(f) || f.startsWith('_')) continue;
        const va = ra[f] ?? '', vb = rb[f] ?? '';
        if (va !== vb) out.push({ table: t, key: k, kind: 'changed', field: f, a: va, b: vb });
      }
    }
    for (const k of mb.keys()) if (!ma.has(k)) out.push({ table: t, key: k, kind: 'added' });
  }
  return out;
}

export interface ScheduleChange { object: 'project' | 'wbs' | 'activity' | 'relationship'; kind: 'added' | 'deleted' | 'changed'; id: string; name?: string; field?: string; a?: string; b?: string }

/** The projects of two files matched as compareSchedules matches them: by Project ID; files whose Project IDs all differ but have as many
 *  projects are compared in file order. */
function pairProjects(a: Db, b: Db): [Row | undefined, Row | undefined][] {
  const projs = (d: Db) => (d.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  const pa = projs(a), pb = projs(b);
  const up = (p: Row) => (p.proj_short_name ?? '').toUpperCase();
  const none = !pa.some((x) => pb.some((y) => up(x) === up(y)));
  return pa.length === pb.length && (pa.length === 1 || none) ? pa.map((x, i) => [x, pb[i]])
    : [...new Set([...pa, ...pb].map(up))].map((n) => [pa.find((p) => up(p) === n), pb.find((p) => up(p) === n)]);
}

/**
 * Schedule comparison in the spirit of P6's Claim Digger: projects matched by Project ID (or the only project of
 * each file), WBS by code path, activities by Activity ID, relationships by predecessor, successor and type,
 * so two exports whose internal ids were renumbered compare cleanly. Durations, lags and floats in days.
 */
export function compareSchedules(a: Db, b: Db, hoursPerDay = 8, calendarDays = false): ScheduleChange[] {
  const pairs = pairProjects(a, b);
  const out: ScheduleChange[] = [];
  // days by units.ts (each activity's own calendar with calendarDays), in the file the row comes from
  const dhA = dayHours(a, hoursPerDay, calendarDays), dhB = dayHours(b, hoursPerDay, calendarDays);
  const days = (h: string | undefined, perDay = hoursPerDay) => (h === '' || h == null ? '' : String(Math.round((Number(h) / perDay) * 100) / 100));
  const diffRows = (object: ScheduleChange['object'], ma: Map<string, Record<string, string>>, mb: Map<string, Record<string, string>>) => {
    for (const [id, ra] of ma) {
      const rb = mb.get(id);
      if (!rb) { out.push({ object, kind: 'deleted', id, name: ra.name }); continue; }
      for (const f of Object.keys(ra)) if ((ra[f] ?? '') !== (rb[f] ?? '')) out.push({ object, kind: 'changed', id, name: rb.name, field: f, a: ra[f], b: rb[f] });
    }
    for (const [id, rb] of mb) if (!ma.has(id)) out.push({ object, kind: 'added', id, name: rb.name });
  };
  for (const [x, y] of pairs) {
    const pre = pairs.length > 1 ? `${(y ?? x)!.proj_short_name}:` : '';
    if (!x || !y) { out.push({ object: 'project', kind: x ? 'deleted' : 'added', id: (x ?? y)!.proj_short_name }); continue; }
    const view = (d: Db, p: Row) => {
      const dh = d === a ? dhA : dhB;
      const wbsRows = (d.tables.PROJWBS?.rows ?? []).filter((w) => w.proj_id === p.proj_id);
      const wbsById = new Map(wbsRows.map((w) => [w.wbs_id, w]));
      const path = (id: string) => { const parts: string[] = []; for (let w = wbsById.get(id), n = 0; w && w.proj_node_flag !== 'Y' && n < wbsById.size; w = wbsById.get(w.parent_wbs_id), n++) parts.unshift(w.wbs_short_name); return parts.join('.'); };
      const cal = new Map((d.tables.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c.clndr_name]));
      const allTasks = new Map((d.tables.TASK?.rows ?? []).map((t) => [t.task_id, t]));
      const tasks = (d.tables.TASK?.rows ?? []).filter((t) => t.proj_id === p.proj_id);
      const root = wbsRows.find((w) => w.proj_node_flag === 'Y');
      const proj = new Map([['', { name: root?.wbs_name ?? '', data_date: p.last_recalc_date ?? '', planned_start: p.plan_start_date ?? '', must_finish_by: p.plan_end_date ?? '', scheduled_finish: p.scd_end_date ?? '' }]]);
      const wbs = new Map(wbsRows.filter((w) => w.proj_node_flag !== 'Y').map((w) => [path(w.wbs_id), { name: w.wbs_name ?? '' }]));
      const acts = new Map(tasks.map((t) => [t.task_code, {
        name: t.task_name ?? '', wbs: path(t.wbs_id), type: t.task_type ?? '', calendar: cal.get(t.clndr_id) ?? '', status: t.status_code ?? '',
        original_duration: days(t.target_drtn_hr_cnt, dh.task(t)), remaining_duration: days(t.remain_drtn_hr_cnt, dh.task(t)),
        start: t.act_start_date || t.early_start_date || '', finish: t.act_end_date || t.early_end_date || '', total_float: days(t.total_float_hr_cnt, dh.task(t)),
        actual_start: t.act_start_date ?? '', actual_finish: t.act_end_date ?? '', physical_pct: t.phys_complete_pct ?? '',
        constraint: [t.cstr_type, t.cstr_date].filter(Boolean).join(' '), secondary_constraint: [t.cstr_type2, t.cstr_date2].filter(Boolean).join(' '),
      }]));
      const code = (id: string) => { const t = allTasks.get(id); return t ? (t.proj_id === p.proj_id ? t.task_code : `${t.task_code} (other project)`) : `#${id}`; };
      const rels = new Map((d.tables.TASKPRED?.rows ?? []).filter((r) => allTasks.get(r.task_id)?.proj_id === p.proj_id)
        .map((r) => [`${code(r.pred_task_id)} -> ${code(r.task_id)} ${(r.pred_type ?? '').replace(/^PR_/, '')}`, { name: '', lag: days(r.lag_hr_cnt, dh.rel(r)) }]));
      return { proj, wbs, acts, rels };
    };
    const va = view(a, x), vb = view(b, y);
    const tag = <T extends Record<string, string>>(m: Map<string, T>) => new Map([...m].map(([k, v]) => [pre + k, v]));
    diffRows('project', tag(va.proj), tag(vb.proj));
    diffRows('wbs', tag(va.wbs), tag(vb.wbs));
    diffRows('activity', tag(va.acts), tag(vb.acts));
    diffRows('relationship', tag(va.rels), tag(vb.rels));
  }
  for (const c of out) if (c.object === 'project' && c.id.endsWith(':')) c.id = c.id.slice(0, -1);
  return out;
}

/** Text report of compareSchedules: counts per object, then one line per change. */
export function compareText(cs: ScheduleChange[]): string {
  const L: string[] = [];
  for (const o of ['project', 'wbs', 'activity', 'relationship'] as const) {
    const n = (k: ScheduleChange['kind']) => cs.filter((c) => c.object === o && c.kind === k).length;
    if (o !== 'project') L.push(`${{ wbs: 'WBS', activity: 'Activities', relationship: 'Relationships' }[o]}: ${n('added')} added, ${n('deleted')} deleted, ${new Set(cs.filter((c) => c.object === o && c.kind === 'changed').map((c) => c.id)).size} changed`);
  }
  L.push('');
  for (const c of cs) {
    const what = `${c.object} ${c.id || '(project)'}${c.name && c.kind !== 'changed' ? ` ${c.name}` : ''}`;
    L.push(c.kind === 'changed' ? `~ ${what} ${c.field}: ${c.a || '(blank)'} -> ${c.b || '(blank)'}` : `${c.kind === 'added' ? '+' : '-'} ${what}`);
  }
  return L.join('\n');
}

const has = (v: unknown) => v != null && String(v).trim() !== '';
const num = (v: string | undefined) => Number(v || 0) || 0;
const assignmentsOf = (d: Db) => { const m = new Map<string, Row[]>(); for (const r of d.tables.TASKRSRC?.rows ?? []) (m.get(r.task_id) ?? m.set(r.task_id, []).get(r.task_id)!).push(r); return m; };
/** Which percent complete the activity reports (P6's percent complete type): physical, units (actual over budgeted units of its assignments) or duration. */
export const percentKind = (t: Row): 'physical' | 'units' | 'duration' => (t.complete_pct_type === 'CP_Phys' ? 'physical' : t.complete_pct_type === 'CP_Units' ? 'units' : 'duration');
/** The activity's % complete by its own type (0-100, one decimal), null when a physical % is blank. */
export function percentOf(t: Row, asg: Row[]): number | null {
  const round = (x: number) => Math.round(x * 10) / 10;
  if (t.complete_pct_type === 'CP_Phys') return has(t.phys_complete_pct) ? round(num(t.phys_complete_pct)) : null;
  if (t.complete_pct_type === 'CP_Units') { const bud = asg.reduce((s, x) => s + num(x.target_qty), 0); return bud ? round((100 * asg.reduce((s, x) => s + num(x.act_reg_qty) + num(x.act_ot_qty), 0)) / bud) : 0; }
  const o = num(t.target_drtn_hr_cnt);
  return o ? round(Math.max(0, Math.min(100, (100 * (o - num(t.remain_drtn_hr_cnt))) / o))) : 0;
}

/** One finding of progress_integrity: the compare's own row (or, for a % complete that went down, the figures the compare does not carry). */
export interface IntegrityFinding { object: 'activity'; kind: 'changed'; id: string; name?: string; field: string; a?: string | number; b?: string | number; via?: string }
export interface ProgressIntegrity { retroactive_actuals: IntegrityFinding[]; progress_decreases: IntegrityFinding[]; status_regressions: IntegrityFinding[]; clean: boolean; note: string }

/**
 * The evidence-integrity check between an earlier update (a) and a later one (b), ported from the platform's progressIntegrity (review M4):
 * an actual start / finish the earlier update already held that the later one changes or clears (a retroactive edit), a % complete that
 * goes DOWN, and a status that goes back (complete -> under way or not started, under way -> not started). `changes` is the field-by-field
 * compare (compareSchedules); the % complete is read from the two sides themselves, per each activity's own percent complete type
 * (physical: the physical %; units: actual over budgeted units of its assignments; duration: from the original and remaining duration),
 * so a duration or units % that fell is seen as the percentage, not as the remaining duration moving. Deterministic; who did it and why is
 * the reviewer's to ask. Lists are whole here; the answer cuts them.
 */
export function progressIntegrity(a: Db, b: Db, changes: ScheduleChange[]): ProgressIntegrity {
  const acts = changes.filter((c) => c.object === 'activity' && c.kind === 'changed');
  const finding = (c: ScheduleChange): IntegrityFinding => ({ object: 'activity', kind: 'changed', id: c.id, ...(c.name != null ? { name: c.name } : {}), field: c.field!, a: c.a, b: c.b });
  const retro = acts.filter((c) => (c.field === 'actual_start' || c.field === 'actual_finish') && has(c.a) && String(c.a) !== String(c.b ?? '')).map(finding);
  const rank: Record<string, number> = { TK_NotStart: 0, TK_Active: 1, TK_Complete: 2 };
  const back = acts.filter((c) => c.field === 'status' && rank[String(c.a)] != null && rank[String(c.b)] != null && rank[String(c.b)] < rank[String(c.a)]).map(finding);
  const backIds = new Set(back.map((c) => c.id));
  const down: IntegrityFinding[] = [];
  const asgA = assignmentsOf(a), asgB = assignmentsOf(b);
  const type = percentKind;
  const pairs = pairProjects(a, b);
  for (const [x, y] of pairs) {
    if (!x || !y) continue;
    const pre = pairs.length > 1 ? `${y.proj_short_name}:` : '';
    const byCode = (d: Db, p: Row) => new Map((d.tables.TASK?.rows ?? []).filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
    const ta = byCode(a, x), tb = byCode(b, y);
    for (const [code, ra] of ta) {
      const rb = tb.get(code);
      if (!rb) continue;
      const pa = percentOf(ra, asgA.get(ra.task_id) ?? []), pb = percentOf(rb, asgB.get(rb.task_id) ?? []);
      if (pa == null || pb == null || !(pb < pa)) continue;
      const id = pre + code, kind = type(rb);
      if (backIds.has(id) && kind !== 'physical') continue; // a status that went back is counted there, not twice
      down.push({ object: 'activity', kind: 'changed', id, ...(rb.task_name != null ? { name: rb.task_name } : {}), field: `${kind}_pct`, a: pa, b: pb, via: `${kind} % complete went from ${pa} to ${pb}` });
    }
  }
  const clean = !retro.length && !down.length && !back.length;
  return { retroactive_actuals: retro, progress_decreases: down, status_regressions: back, clean,
    note: clean ? 'no actual date the earlier update held was changed or cleared, no % complete went down, no status went back'
      : `${retro.length} retroactive actual-date change(s), ${down.length} progress decrease(s), ${back.length} status regression(s) between the updates \u2014 evidence-integrity findings that MUST be disclosed (a claim relies on contemporaneous records)` };
}

/** An activity's % complete (by its own type, percentOf) that differs between an earlier and a later update, activities matched by Activity ID as compareSchedules matches them. A physical % blank on either side is not compared (as progressIntegrity). */
export interface PercentChange { id: string; name: string; kind: 'physical' | 'units' | 'duration'; a: number; b: number }
export function percentChanges(a: Db, b: Db): PercentChange[] {
  const asgA = assignmentsOf(a), asgB = assignmentsOf(b), out: PercentChange[] = [];
  const pairs = pairProjects(a, b);
  for (const [x, y] of pairs) {
    if (!x || !y) continue;
    const pre = pairs.length > 1 ? `${y.proj_short_name}:` : '';
    const byCode = (d: Db, p: Row) => new Map((d.tables.TASK?.rows ?? []).filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
    const ta = byCode(a, x), tb = byCode(b, y);
    for (const [code, ra] of ta) {
      const rb = tb.get(code);
      if (!rb) continue;
      const pa = percentOf(ra, asgA.get(ra.task_id) ?? []), pb = percentOf(rb, asgB.get(rb.task_id) ?? []);
      if (pa == null || pb == null || pa === pb) continue;
      out.push({ id: pre + code, name: rb.task_name ?? '', kind: percentKind(rb), a: pa, b: pb });
    }
  }
  return out;
}

/** A resource (or role) on an activity in one update and not the other. */
export interface AssignmentChange { id: string; name: string; kind: 'added' | 'removed'; resource: string }
/** The assignments (TASKRSRC) that were added to or removed from an activity between an earlier (a) and a later (b) update, activities matched by Activity ID as compareSchedules matches them,
 *  a resource told by its short name in each file (so renumbered resource ids still match), a role-only assignment by the role's. Quantities and costs are not compared: only who is assigned. */
export function assignmentChanges(a: Db, b: Db): AssignmentChange[] {
  const label = (d: Db) => {
    const rs = new Map((d.tables.RSRC?.rows ?? []).map((r) => [r.rsrc_id, r.rsrc_short_name || r.rsrc_name || r.rsrc_id]));
    const ro = new Map((d.tables.ROLES?.rows ?? []).map((r) => [r.role_id, r.role_short_name || r.role_name || r.role_id]));
    return (r: Row) => (r.rsrc_id ? rs.get(r.rsrc_id) ?? r.rsrc_id : r.role_id ? `role ${ro.get(r.role_id) ?? r.role_id}` : '');
  };
  const la = label(a), lb = label(b), asgA = assignmentsOf(a), asgB = assignmentsOf(b), out: AssignmentChange[] = [];
  const pairs = pairProjects(a, b);
  for (const [x, y] of pairs) {
    if (!x || !y) continue;
    const pre = pairs.length > 1 ? `${y.proj_short_name}:` : '';
    const byCode = (d: Db, p: Row) => new Map((d.tables.TASK?.rows ?? []).filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
    const ta = byCode(a, x), tb = byCode(b, y);
    for (const [code, ra] of ta) {
      const rb = tb.get(code);
      if (!rb) continue;
      const before = new Set((asgA.get(ra.task_id) ?? []).map(la).filter(Boolean)), after = new Set((asgB.get(rb.task_id) ?? []).map(lb).filter(Boolean));
      for (const r of after) if (!before.has(r)) out.push({ id: pre + code, name: rb.task_name ?? '', kind: 'added', resource: r });
      for (const r of before) if (!after.has(r)) out.push({ id: pre + code, name: rb.task_name ?? '', kind: 'removed', resource: r });
    }
  }
  return out;
}

/** The baseline start / finish of an activity that differ between the baseline an earlier update carries and the one a later update carries (a and b: each baseline's activities by Activity ID; start and
 *  finish: how a baseline activity's date is read, the caller's: referenceStart / baselineFinish). Only activities in both baselines; times in minutes, null where a baseline activity has no such date. */
export interface BaselineDateChange { id: string; name: string; field: 'baseline_start' | 'baseline_finish'; a: number | null; b: number | null }
export function baselineDateChanges(a: Map<string, Row>, b: Map<string, Row>, start: (r: Row) => number | null, finish: (r: Row) => number | null): BaselineDateChange[] {
  const out: BaselineDateChange[] = [];
  for (const [code, ra] of a) {
    const rb = b.get(code);
    if (!rb) continue;
    for (const [field, read] of [['baseline_start', start], ['baseline_finish', finish]] as const) { const x = read(ra), y = read(rb); if (x !== y) out.push({ id: code, name: rb.task_name ?? '', field, a: x, b: y }); }
  }
  return out;
}
