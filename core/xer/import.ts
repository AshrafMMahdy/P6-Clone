// Merge a parsed XER into the clone database the way P6's Import wizard does.
import { rawOf } from '../journal.ts';
import { KEYS, refTarget, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { isLegacyLayout } from '../schedule/cpm.ts';

export type ProjectAction = 'new' | 'replace' | 'update' | 'skip';
export type DictAction = 'keep' | 'update' | 'insert';

export interface ImportPlan {
  projects: { srcProjId: string; action: ProjectAction; targetProjId?: string; epsId?: string }[];
  /** How matching dictionary rows (same name) are treated. Default keep. */
  dict?: Partial<Record<string, DictAction>>;
}
export interface ImportResult { projIds: string[]; findings: Finding[]; map: Record<string, Record<string, string>> }

/** Name used to match dictionary rows with existing ones. */
const MATCH: Record<string, (r: Row) => string> = {
  CALENDAR: (r) => r.clndr_name, RSRC: (r) => r.rsrc_short_name, ROLES: (r) => r.role_short_name, ACCOUNT: (r) => r.acct_short_name,
  ACTVTYPE: (r) => `${r.actv_code_type}|${r.actv_code_type_scope ?? ''}`, UDFTYPE: (r) => `${r.table_name}|${r.udf_type_label}`,
  OBS: (r) => r.obs_name, CURRTYPE: (r) => r.curr_short_name, UMEASURE: (r) => r.unit_abbrev, MEMOTYPE: (r) => r.memo_type,
  COSTTYPE: (r) => r.cost_type, RSRCCURVDATA: (r) => r.curv_name, PCATTYPE: (r) => r.proj_catg_type, RCATTYPE: (r) => r.rsrc_catg_type,
  POBS: (r) => r.pobs_name, FINDATES: (r) => r.fin_dates_name,
};
/** Child dictionary rows matched within their (mapped) parent. */
const CHILD: Record<string, { parent: string; name: (r: Row) => string }> = {
  ACTVCODE: { parent: 'actv_code_type_id', name: (r) => r.short_name },
  PCATVAL: { parent: 'proj_catg_type_id', name: (r) => r.proj_catg_short_name },
  RCATVAL: { parent: 'rsrc_catg_type_id', name: (r) => r.rsrc_catg_short_name },
  RSRCRATE: { parent: 'rsrc_id', name: (r) => r.start_date ?? '' },
  ROLERATE: { parent: 'role_id', name: (r) => r.start_date ?? '' },
};
const UDF_FK_TABLE: Record<string, string> = { TASK: 'TASK', PROJWBS: 'PROJWBS', PROJECT: 'PROJECT', RSRC: 'RSRC', TASKRSRC: 'TASKRSRC', ROLE: 'ROLES', PROJCOST: 'PROJCOST', TASKPROC: 'TASKPROC', PROJISSU: 'PROJISSU' };
/** Fields kept out of refTarget (they often point outside the file, so they are not checked or pulled in on export) that still follow their row when it is renumbered. */
const SOFT_REFS: Record<string, string> = { 'TASK|rsrc_id': 'RSRC', pobs_id: 'POBS', shift_id: 'SHIFT' };

/** Default plan: every project in the file as a new project. */
export function defaultPlan(src: Db): ImportPlan {
  return { projects: rows(src, 'PROJECT').map((p) => ({ srcProjId: p.proj_id, action: 'new' })) };
}

export function importIntoDb(db: Db, src: Db, plan: ImportPlan): ImportResult {
  const findings: Finding[] = [];
  const map: Record<string, Record<string, string>> = {};
  const m = (t: string) => (map[t] ??= {});
  const counters: Record<string, number> = {};
  const alloc = (t: string) => {
    if (counters[t] == null) {
      const k = KEYS[t];
      let max = 0;
      for (const r of rows(db, t)) { const n = Number(r[k]) || 0; if (n > max) max = n; }
      counters[t] = max + 1;
    }
    return String(counters[t]++);
  };

  const actions = new Map(plan.projects.map((p) => [p.srcProjId, p]));
  const skipped = new Set(plan.projects.filter((p) => p.action === 'skip').map((p) => p.srcProjId));
  for (const p of rows(src, 'PROJECT')) if (!actions.has(p.proj_id)) skipped.add(p.proj_id);

  // Target project ids; replace/update clears the target's rows first (keeping matched ids for update)
  const reuse: Record<string, Map<string, string>> = { TASK: new Map(), PROJWBS: new Map() };
  for (const a of plan.projects) {
    if (a.action === 'skip') continue;
    if ((a.action === 'replace' || a.action === 'update') && a.targetProjId) {
      m('PROJECT')[a.srcProjId] = a.targetProjId;
      if (a.action === 'update') {
        const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === a.targetProjId).map((t) => [t.task_code, t.task_id]));
        for (const t of rows(src, 'TASK')) if (t.proj_id === a.srcProjId && byCode.has(t.task_code)) reuse.TASK.set(t.task_id, byCode.get(t.task_code)!);
        const byWbs = new Map(rows(db, 'PROJWBS').filter((w) => w.proj_id === a.targetProjId).map((w) => [`${w.proj_node_flag}|${w.wbs_short_name}`, w.wbs_id]));
        for (const w of rows(src, 'PROJWBS')) if (w.proj_id === a.srcProjId && byWbs.has(`${w.proj_node_flag}|${w.wbs_short_name}`)) reuse.PROJWBS.set(w.wbs_id, byWbs.get(`${w.proj_node_flag}|${w.wbs_short_name}`)!);
      }
      deleteProject(db, a.targetProjId, true);
    } else {
      m('PROJECT')[a.srcProjId] = alloc('PROJECT');
    }
  }

  const isProjectRow = (t: string, r: Row) => !!r.proj_id && t !== 'PROJECT';
  const inSkipped = (t: string, r: Row) => (t === 'PROJECT' ? skipped.has(r.proj_id) : !!r.proj_id && skipped.has(r.proj_id));

  // Pass 1: allocate keys (or match dictionaries)
  const names = Object.keys(src.tables);
  const keepExisting = new Set<string>(); // "TABLE|srcKey" rows not inserted because an existing row is used
  const updates: [string, Row, Row][] = [];
  const order = [...names.filter((n) => !CHILD[n]), ...names.filter((n) => CHILD[n])];
  for (const t of order) {
    const k = KEYS[t];
    if (!k || t === 'PROJECT') continue;
    for (const r of src.tables[t].rows) {
      if (inSkipped(t, r) || !r[k]) continue;
      const dictRow = !isProjectRow(t, r) || (t === 'CALENDAR' && !r.proj_id);
      if (dictRow && MATCH[t]) {
        const name = MATCH[t](r);
        const hit = rows(db, t).find((x) => MATCH[t](x) === name && (t !== 'CALENDAR' || !x.proj_id));
        const act = plan.dict?.[t] ?? 'keep';
        if (hit && act !== 'insert') {
          m(t)[r[k]] = hit[k];
          keepExisting.add(`${t}|${r[k]}`);
          if (act === 'update') updates.push([t, hit, r]);
          continue;
        }
      } else if (CHILD[t]) {
        const c = CHILD[t];
        const parentTable = refTarget(c.parent)!;
        const parentKept = keepExisting.has(`${parentTable}|${r[c.parent]}`);
        if (parentKept) {
          const newParent = m(parentTable)[r[c.parent]];
          const hit = rows(db, t).find((x) => x[c.parent] === newParent && c.name(x) === c.name(r));
          if (hit) { m(t)[r[k]] = hit[k]; keepExisting.add(`${t}|${r[k]}`); continue; }
        }
      }
      m(t)[r[k]] = (t === 'TASK' || t === 'PROJWBS') && reuse[t].get(r[k]) ? reuse[t].get(r[k])! : alloc(t);
    }
  }

  // Pass 2: copy rows with remapped references
  const udfTable = new Map(rows(src, 'UDFTYPE').map((u) => [u.udf_type_id, u.table_name]));
  const targetCache = new Map<string, string | undefined>(); // table|field -> referenced table (millions of lookups on big files)
  const remap = (t: string, r: Row): Row => {
    const out: Row = { ...rawOf(r) }; // a copy keeps the source row's shape (built key by key, a 60-field row is a dictionary 6x the size)
    const k = KEYS[t];
    for (const f in r) {
      const v = r[f];
      if (f === k) { out[f] = (t === 'PROJECT' ? m('PROJECT')[v] : m(t)[v]) ?? v; continue; }
      const ck = t + '|' + f;
      let target = targetCache.get(ck);
      if (target === undefined && !targetCache.has(ck)) targetCache.set(ck, (target = refTarget(f, t)));
      if (!target && v) { const st = SOFT_REFS[ck] ?? SOFT_REFS[f]; const nv = st && map[st]?.[v]; if (nv) { out[f] = nv; continue; } }
      if (t === 'UDFVALUE' && f === 'fk_id') { const ft = UDF_FK_TABLE[udfTable.get(r.udf_type_id) ?? ''] ?? ''; out[f] = map[ft]?.[v] ?? v; continue; }
      if (target && v) {
        const nv = map[target]?.[v];
        if (nv == null && target !== 'PROJECT' && src.tables[target]) findings.push({ severity: 'warning', code: 'IMPORT_UNRESOLVED', table: t, field: f, key: r[k ?? ''] ?? '', message: `${t}.${f} = ${v} has no matching ${target} row; kept as is.`, p6: 'P6 would drop or default this reference.' });
        out[f] = nv ?? (target === 'PROJWBS' && f === 'parent_wbs_id' && r.proj_node_flag === 'Y' ? '' : v);
      } else out[f] = v;
    }
    return out;
  };
  for (const [t, hit, r] of updates) Object.assign(hit, remap(t, r));

  for (const t of names) {
    const dst = table(db, t);
    for (const f of src.tables[t].fields) if (!dst.fields.includes(f)) dst.fields.push(f);
    const k = KEYS[t];
    const add: Row[] = [];
    for (const r of src.tables[t].rows) {
      if (inSkipped(t, r)) continue;
      if (k && keepExisting.has(`${t}|${r[k]}`)) continue;
      const nr = remap(t, r);
      if (t === 'PROJECT') {
        const a = actions.get(r.proj_id);
        if (a?.epsId) nr._eps_id = a.epsId;
        // remember which P6 build wrote the file: 6.x builds place milestones differently
        nr._legacy_ms = isLegacyLayout(src) ? 'Y' : 'N';
        nr._p6_ver = src.header?.version ?? '';
        if (nr._baseline_of) nr._baseline_of = m('PROJECT')[nr._baseline_of] ?? nr._baseline_of;
      }
      add.push(nr);
    }
    // attach in one step (one undo record instead of one per row on million-row tables)
    if (add.length) dst.rows = rawOf(dst.rows).concat(add);
  }
  // baselines that came with the file are attached to their projects, not opened as projects
  const baseline = new Set(rows(src, 'PROJECT').filter((p) => p._baseline_of).map((p) => p.proj_id));
  const projIds = plan.projects.filter((p) => p.action !== 'skip' && !baseline.has(p.srcProjId)).map((p) => m('PROJECT')[p.srcProjId]);
  return { projIds, findings, map };
}

/** Delete a project and every row that belongs to it. keepDictionaries keeps global rows. */
export function deleteProject(db: Db, projId: string, _keepDictionaries = true): void {
  const taskIds = new Set(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => t.task_id));
  for (const t of Object.values(db.tables)) {
    if (t.name === 'TASKPRED') { t.rows = t.rows.filter((r) => !taskIds.has(r.task_id) && !taskIds.has(r.pred_task_id)); continue; }
    if (t.fields.includes('proj_id')) t.rows = t.rows.filter((r) => r.proj_id !== projId);
    else if (t.fields.includes('task_id')) t.rows = t.rows.filter((r) => !taskIds.has(r.task_id));
  }
}
