// Transfer progress from another schedule (a subcontractor's update) onto this project's activities in one step:
// activities matched by Activity ID, name, an activity code, a UDF or given pairs; one GC activity may stand for several
// of theirs (a summary of a package), or one of theirs for several GC activities.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num } from '../schedule/cpm.ts';
import { calOf, refreshOwnDates, statusOf } from '../project/edit.ts';
import { assignResource, recomputeCosts } from '../resource/assign.ts';

export type MatchBy = 'activity_id' | 'name' | 'code' | 'udf' | 'pairs';
export const PARTS = ['dates', 'percent', 'remaining', 'expected', 'suspend', 'units', 'assignments', 'expenses', 'steps'] as const;
export type Part = typeof PARTS[number];
export interface TransferSpec {
  from: Db; fromProjIds: string[]; toProjId: string;
  by: MatchBy;
  /** code / udf: the code type or UDF on this project's activities whose value names their activity (or their package). */
  codeType?: string; udf?: string;
  /** code / udf: the code type or UDF on their activities to compare with (default: their Activity ID). */
  fromCodeType?: string; fromUdf?: string;
  pairs?: { from: string; to: string }[];
  /** What is transferred (default all). */
  include?: Partial<Record<Part, boolean>>;
  /** Assignment costs: recompute from this project's own rates (default) or copy theirs. */
  costs?: 'recompute' | 'copy';
  /** A resource of theirs this activity has no assignment for, when this project has that resource: assign it. */
  addAssignments?: boolean;
  /** Move this project's data date: 'from' (theirs) or a date. */
  dataDate?: string;
}
export interface TransferResult {
  matched: number; updated: number;
  changes: { id: string; from: string[]; changed: Record<string, [string, string]> }[];
  unmatched_from: string[]; ambiguous: { from: string; to: string[] }[];
  assignments: { updated: number; added: number; unmatched: { activity: string; resource: string }[] };
  expenses: { updated: number; unmatched: { activity: string; expense: string }[] };
  steps: { updated: number; unmatched: { activity: string; step: string }[] };
  data_date?: string; warnings: string[];
}

const norm = (s: string | undefined) => (s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const num = (v: string | undefined) => Number(v || 0);
const minOf = (xs: string[]) => xs.filter(Boolean).sort()[0] ?? '';
const maxOf = (xs: string[]) => xs.filter(Boolean).sort().at(-1) ?? '';

/** The value an activity holds for a code type (by its name) or a UDF (by its label), keyed by task_id. */
function valuesOf(db: Db, codeType?: string, udf?: string): Map<string, string> | string {
  const out = new Map<string, string>();
  if (codeType) {
    const types = new Set(rows(db, 'ACTVTYPE').filter((t) => norm(t.actv_code_type) === norm(codeType)).map((t) => t.actv_code_type_id));
    if (!types.size) return `No activity code type "${codeType}".`;
    const code = new Map(rows(db, 'ACTVCODE').filter((c) => types.has(c.actv_code_type_id)).map((c) => [c.actv_code_id, c.short_name]));
    for (const a of rows(db, 'TASKACTV')) if (types.has(a.actv_code_type_id) && code.has(a.actv_code_id)) out.set(a.task_id, code.get(a.actv_code_id)!);
    return out;
  }
  const types = new Map(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK' && norm(u.udf_type_label) === norm(udf)).map((u) => [u.udf_type_id, u]));
  if (!types.size) return `No activity UDF "${udf}".`;
  const codes = new Map(rows(db, 'UDFCODE').map((c) => [c.udf_code_id, c.short_name || c.udf_code_name]));
  for (const v of rows(db, 'UDFVALUE')) if (types.has(v.udf_type_id)) {
    const x = v.udf_text || v.udf_number || v.udf_date || (v.udf_code_id ? codes.get(v.udf_code_id) : '') || '';
    if (x !== '') out.set(v.fk_id, x);
  }
  return out;
}

export function transferProgress(db: Db, spec: TransferSpec): TransferResult | { error: string } {
  const on = (p: Part) => spec.include?.[p] !== false;
  const theirs = rows(spec.from, 'TASK').filter((t) => spec.fromProjIds.includes(t.proj_id));
  const mine = rows(db, 'TASK').filter((t) => t.proj_id === spec.toProjId);
  const warnings: string[] = [];

  // their key -> my activities
  const toKey = new Map<string, Row[]>(), fromKey = (t: Row): string | undefined => t.task_code;
  let keyOf: (t: Row) => string | undefined = fromKey;
  const add = (k: string, t: Row) => { const l = toKey.get(k); if (l) l.push(t); else toKey.set(k, [t]); };
  if (spec.by === 'activity_id') for (const t of mine) add(t.task_code, t);
  else if (spec.by === 'name') { for (const t of mine) add(norm(t.task_name), t); keyOf = (t) => norm(t.task_name); }
  else if (spec.by === 'pairs') {
    const byCode = new Map(mine.map((t) => [t.task_code, t]));
    for (const p of spec.pairs ?? []) { const t = byCode.get(p.to); if (!t) return { error: `pairs: this project has no activity ${p.to}.` }; add(`${p.from}`, t); }
  } else {
    const v = valuesOf(db, spec.by === 'code' ? spec.codeType : undefined, spec.by === 'udf' ? spec.udf : undefined);
    if (typeof v === 'string') return { error: v };
    for (const t of mine) { const x = v.get(t.task_id); if (x) add(norm(x), t); }
    if (spec.fromCodeType || spec.fromUdf) {
      const w = valuesOf(spec.from, spec.fromCodeType, spec.fromUdf);
      if (typeof w === 'string') return { error: `Their schedule: ${w}` };
      keyOf = (t) => (w.has(t.task_id) ? norm(w.get(t.task_id)) : undefined);
    } else keyOf = (t) => norm(t.task_code);
  }

  // my activity -> their activities
  const groups = new Map<Row, Row[]>();
  const unmatched: string[] = [], ambiguous: { from: string; to: string[] }[] = [];
  for (const t of theirs) {
    const k = keyOf(t);
    const hits = k == null ? undefined : toKey.get(k);
    if (!hits) { unmatched.push(t.task_code); continue; }
    if (spec.by === 'name' && hits.length > 1) { ambiguous.push({ from: t.task_code, to: hits.map((h) => h.task_code) }); continue; }
    for (const h of hits) { const g = groups.get(h); if (g) g.push(t); else groups.set(h, [t]); }
  }

  const res: TransferResult = { matched: groups.size, updated: 0, changes: [], unmatched_from: unmatched, ambiguous, assignments: { updated: 0, added: 0, unmatched: [] }, expenses: { updated: 0, unmatched: [] }, steps: { updated: 0, unmatched: [] }, warnings };
  const theirDataDates = [...new Set(rows(spec.from, 'PROJECT').filter((p) => spec.fromProjIds.includes(p.proj_id)).map((p) => p.last_recalc_date).filter(Boolean))];
  const theirDD = parseP6Date(maxOf(theirDataDates));
  const T = table(db, 'TASK');
  for (const f of ['act_start_date', 'act_end_date', 'phys_complete_pct', 'remain_drtn_hr_cnt', 'expect_end_date', 'suspend_date', 'resume_date', 'status_code', 'act_work_qty', 'remain_work_qty', 'act_equip_qty', 'remain_equip_qty']) addField(T, f);

  const byTask = (d: Db, n: string) => { const m = new Map<string, Row[]>(); for (const r of rows(d, n)) { const l = m.get(r.task_id); if (l) l.push(r); else m.set(r.task_id, [r]); } return m; };
  const theirA = byTask(spec.from, 'TASKRSRC'), mineA = byTask(db, 'TASKRSRC');
  const theirC = byTask(spec.from, 'PROJCOST'), mineC = byTask(db, 'PROJCOST');
  const theirS = byTask(spec.from, 'TASKPROC'), mineS = byTask(db, 'TASKPROC');
  const theirR = new Map(rows(spec.from, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name])), theirRole = new Map(rows(spec.from, 'ROLES').map((r) => [r.role_id, r.role_short_name]));
  const myR = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name])), myRole = new Map(rows(db, 'ROLES').map((r) => [r.role_id, r.role_short_name]));
  const myRByName = new Map(rows(db, 'RSRC').map((r) => [norm(r.rsrc_short_name), r.rsrc_id])), myRoleByName = new Map(rows(db, 'ROLES').map((r) => [norm(r.role_short_name), r.role_id]));
  const aKey = (a: Row, R: Map<string, string>, Ro: Map<string, string>) => `${norm(R.get(a.rsrc_id))}|${norm(Ro.get(a.role_id))}`;

  for (const [t, subs] of groups) {
    const before: Record<string, string> = { ...t };
    const one = subs.length === 1 ? subs[0] : undefined;
    if (on('dates')) {
      const done = subs.every((s) => s.act_end_date);
      t.act_start_date = minOf(subs.map((s) => s.act_start_date));
      t.act_end_date = done && t.act_start_date ? maxOf(subs.map((s) => s.act_end_date)) : '';
    }
    if (on('remaining')) {
      if (t.act_end_date) t.remain_drtn_hr_cnt = '0';
      else if (one) t.remain_drtn_hr_cnt = one.remain_drtn_hr_cnt || '0';
      else {
        // several of theirs: until the last of them finishes, on this activity's calendar, from their data date
        const open = subs.filter((s) => !s.act_end_date);
        const last = parseP6Date(maxOf(open.map((s) => s.reend_date || s.early_end_date || s.expect_end_date)));
        const cal = calOf(db, t);
        const from = theirDD ?? parseP6Date(rows(db, 'PROJECT').find((p) => p.proj_id === t.proj_id)?.last_recalc_date);
        t.remain_drtn_hr_cnt = last != null && from != null && last > from ? p6num(cal.workBetween(cal.nextWorkStart(from), last) / 60) : p6num(Math.max(...open.map((s) => num(s.remain_drtn_hr_cnt))));
      }
    }
    if (on('percent')) {
      const w = subs.reduce((a, s) => a + num(s.target_drtn_hr_cnt), 0);
      t.phys_complete_pct = p6num(w > 0 ? subs.reduce((a, s) => a + num(s.phys_complete_pct) * num(s.target_drtn_hr_cnt), 0) / w : subs.reduce((a, s) => a + num(s.phys_complete_pct), 0) / subs.length);
    }
    if (on('expected')) t.expect_end_date = maxOf(subs.map((s) => s.expect_end_date));
    if (on('suspend') && one) { t.suspend_date = one.suspend_date ?? ''; t.resume_date = one.resume_date ?? ''; }
    if (on('units')) for (const f of ['act_work_qty', 'remain_work_qty', 'act_equip_qty', 'remain_equip_qty']) t[f] = p6num(subs.reduce((a, s) => a + num(s[f]), 0));
    t.status_code = statusOf(t);
    if (!t.act_start_date && t.act_end_date) { t.act_end_date = before.act_end_date ?? ''; warnings.push(`${t.task_code}: their activities have a finish without a start; the finish was not taken.`); }
    refreshOwnDates(db, t);

    if (on('assignments')) {
      const agg = new Map<string, Row[]>();
      for (const s of subs) for (const a of theirA.get(s.task_id) ?? []) { const k = aKey(a, theirR, theirRole); const l = agg.get(k); if (l) l.push(a); else agg.set(k, [a]); }
      const have = new Map((mineA.get(t.task_id) ?? []).map((a) => [aKey(a, myR, myRole), a]));
      for (const [k, as] of agg) {
        let a = have.get(k);
        if (!a) {
          const [rn, ro] = k.split('|'), rid = myRByName.get(rn) ?? '', roid = myRoleByName.get(ro) ?? '';
          if (spec.addAssignments && (rid || roid) && (!rn || rid) && (!ro || roid)) { a = assignResource(db, t, rid, roid); res.assignments.added++; }
          else { res.assignments.unmatched.push({ activity: t.task_code, resource: theirR.get(as[0].rsrc_id) || theirRole.get(as[0].role_id) || '(none)' }); continue; }
        }
        const sum = (f: string) => p6num(as.reduce((x, r) => x + num(r[f]), 0));
        for (const f of ['act_reg_qty', 'act_ot_qty', 'remain_qty', 'act_this_per_qty']) a[f] = sum(f);
        a.target_qty = p6num(Math.max(num(a.target_qty), num(a.act_reg_qty) + num(a.act_ot_qty) + num(a.remain_qty)));
        a.act_start_date = minOf(as.map((r) => r.act_start_date));
        a.act_end_date = as.every((r) => r.act_end_date) ? maxOf(as.map((r) => r.act_end_date)) : '';
        if (spec.costs === 'copy') { a.cost_qty_link_flag = 'N'; for (const f of ['act_reg_cost', 'act_ot_cost', 'remain_cost', 'act_this_per_cost']) a[f] = sum(f); }
        else recomputeCosts(db, a);
        res.assignments.updated++;
      }
    }
    if (on('expenses')) {
      const have = new Map((mineC.get(t.task_id) ?? []).map((c) => [norm(c.cost_name), c]));
      const agg = new Map<string, Row[]>();
      for (const s of subs) for (const c of theirC.get(s.task_id) ?? []) { const k = norm(c.cost_name); const l = agg.get(k); if (l) l.push(c); else agg.set(k, [c]); }
      for (const [k, cs] of agg) {
        const c = have.get(k);
        if (!c) { res.expenses.unmatched.push({ activity: t.task_code, expense: cs[0].cost_name }); continue; }
        for (const f of ['act_cost', 'remain_cost']) c[f] = p6num(cs.reduce((x, r) => x + num(r[f]), 0));
        res.expenses.updated++;
      }
    }
    if (on('steps')) {
      const have = new Map((mineS.get(t.task_id) ?? []).map((c) => [norm(c.proc_name), c]));
      const agg = new Map<string, Row[]>();
      for (const s of subs) for (const c of theirS.get(s.task_id) ?? []) { const k = norm(c.proc_name); const l = agg.get(k); if (l) l.push(c); else agg.set(k, [c]); }
      for (const [k, cs] of agg) {
        const c = have.get(k);
        if (!c) { res.steps.unmatched.push({ activity: t.task_code, step: cs[0].proc_name }); continue; }
        c.complete_flag = cs.every((r) => r.complete_flag === 'Y') ? 'Y' : 'N';
        c.complete_pct = p6num(cs.reduce((x, r) => x + num(r.complete_pct), 0) / cs.length);
        res.steps.updated++;
      }
    }

    const changed: Record<string, [string, string]> = {};
    for (const f of ['act_start_date', 'act_end_date', 'phys_complete_pct', 'remain_drtn_hr_cnt', 'expect_end_date', 'suspend_date', 'resume_date', 'status_code', 'act_work_qty', 'remain_work_qty', 'act_equip_qty', 'remain_equip_qty'])
      if ((before[f] ?? '') !== (t[f] ?? '') && !(num(before[f]) === num(t[f]) && /qty|cnt|pct/.test(f))) changed[f] = [before[f] ?? '', t[f] ?? ''];
    if (Object.keys(changed).length) { res.updated++; res.changes.push({ id: t.task_code, from: subs.map((s) => s.task_code), changed }); }
  }

  // the data date: theirs, or the one given
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === spec.toProjId)!;
  if (spec.dataDate) {
    const d = spec.dataDate === 'from' ? (theirDataDates.length === 1 ? theirDataDates[0] : theirDataDates.length ? null : '') : formatP6Date(parseP6Date(spec.dataDate) ?? NaN);
    if (d === null) warnings.push(`Their projects have different data dates (${theirDataDates.join(', ')}): the data date was not moved; give one.`);
    else if (!d || d.includes('NaN')) warnings.push('Their schedule has no data date: the data date was not moved.');
    else { addField(table(db, 'PROJECT'), 'last_recalc_date'); p.last_recalc_date = d; res.data_date = d; }
  }
  const dd = p.last_recalc_date ?? '';
  const after = res.changes.filter((c) => [c.changed.act_start_date?.[1], c.changed.act_end_date?.[1]].some((x) => x && dd && x > dd)).map((c) => c.id);
  if (after.length) warnings.push(`${after.length} activit${after.length === 1 ? 'y has' : 'ies have'} actual dates after this project's data date (${dd}): move it (data_date) before scheduling, as P6's log would report them (${after.slice(0, 20).join(', ')}${after.length > 20 ? '…' : ''}).`);
  return res;
}
