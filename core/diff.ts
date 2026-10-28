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

/**
 * Schedule comparison in the spirit of P6's Claim Digger: projects matched by Project ID (or the only project of
 * each file), WBS by code path, activities by Activity ID, relationships by predecessor, successor and type,
 * so two exports whose internal ids were renumbered compare cleanly. Durations, lags and floats in days.
 */
export function compareSchedules(a: Db, b: Db, hoursPerDay = 8, calendarDays = false): ScheduleChange[] {
  const projs = (d: Db) => (d.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  const pa = projs(a), pb = projs(b);
  const up = (p: Row) => (p.proj_short_name ?? '').toUpperCase();
  // by Project ID; files whose Project IDs all differ but have as many projects are compared in file order
  const none = !pa.some((x) => pb.some((y) => up(x) === up(y)));
  const pairs: [Row | undefined, Row | undefined][] = pa.length === pb.length && (pa.length === 1 || none) ? pa.map((x, i) => [x, pb[i]])
    : [...new Set([...pa, ...pb].map(up))].map((n) => [pa.find((p) => up(p) === n), pb.find((p) => up(p) === n)]);
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
