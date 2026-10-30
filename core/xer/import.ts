// Merge a parsed XER into the clone database the way P6's Import wizard does.
import { rawOf, removeWhere } from '../journal.ts';
import { KEYS, refTarget, rows, table, type Db, type Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { isLegacyLayout } from '../schedule/cpm.ts';
import { deleteActivities } from '../project/edit.ts';
import { defaultCalendarId, financialPeriods } from '../progress/period.ts';

/**
 * P6's import action for a project in the file.
 * - new: Create New Project (a Project ID already used gets -1, -2…, as P6 appends a number).
 * - replace: Replace Existing Project. The target's content is replaced; activities of the same Activity ID keep their
 *   identity, so relationships from other projects to them survive (those to activities that are gone are reported).
 * - update: Update Existing Project. Each object is matched (activities by Activity ID, WBS by code path, relationships
 *   by predecessor, successor and type, assignments by activity, resource and role…) and updated or kept per data type
 *   (ImportPlan.data); objects not in the file are inserted; objects the file lacks are kept unless remove_missing.
 * - add_into: Add Into Existing Project. The file's project becomes a WBS node of the target (under wbsId, default the
 *   target's root); an Activity ID the target already has gets -1, -2….
 */
export type ProjectAction = 'new' | 'replace' | 'update' | 'add_into' | 'skip';
/** Workspace data matched by name: keep existing, update existing, insert new (a copy), or skip (P6's Do Not Import: a
 *  match is used, the rest is left out and what points at it dropped or cleared). */
export type DictAction = 'keep' | 'update' | 'insert' | 'skip';
/** Project data on update: update existing, keep existing, skip (Do Not Import), or remove_missing (update existing, and
 *  what the file lacks is removed from the project; P6 offers it for activities, relationships and assignments). */
export type DataAction = 'update' | 'keep' | 'skip' | 'remove_missing';
export const REMOVABLE = ['TASK', 'TASKPRED', 'TASKRSRC'];

export interface ImportPlan {
  projects: { srcProjId: string; action: ProjectAction; targetProjId?: string; epsId?: string; wbsId?: string }[];
  /** How matching dictionary rows (same name) are treated. Default keep. */
  dict?: Partial<Record<string, DictAction>>;
  /** update / add_into: per project table (TASK, PROJWBS, TASKPRED, TASKRSRC, TASKACTV, UDFVALUE…). Default update. */
  data?: Partial<Record<string, DataAction>>;
}
export type ImportCounts = Record<string, { inserted: number; updated: number; kept: number; removed: number; skipped: number }>;
export interface ImportResult { projIds: string[]; findings: Finding[]; map: Record<string, Record<string, string>>; counts: ImportCounts }

/** Name used to match dictionary rows with existing ones. */
const MATCH: Record<string, (r: Row) => string> = {
  CALENDAR: (r) => r.clndr_name, RSRC: (r) => r.rsrc_short_name, ROLES: (r) => r.role_short_name, ACCOUNT: (r) => r.acct_short_name,
  ACTVTYPE: (r) => `${r.actv_code_type}|${r.actv_code_type_scope ?? ''}`, UDFTYPE: (r) => `${r.table_name}|${r.udf_type_label}`,
  OBS: (r) => r.obs_name, CURRTYPE: (r) => r.curr_short_name, UMEASURE: (r) => r.unit_abbrev, MEMOTYPE: (r) => r.memo_type,
  COSTTYPE: (r) => r.cost_type, RSRCCURVDATA: (r) => r.curv_name, PCATTYPE: (r) => r.proj_catg_type, RCATTYPE: (r) => r.rsrc_catg_type,
  POBS: (r) => r.pobs_name, FINDATES: (r) => r.fin_dates_name, FINTMPL: (r) => r.fintmpl_name,
  EPS: (r) => r.eps_short_name, // (an EPS ID is unique in P6: the node of the same ID is the one used, so a baseline or a merged file does not add a second "Enterprise")
};
/** Child dictionary rows matched within their (mapped) parent. */
const CHILD: Record<string, { parent: string; name: (r: Row) => string }> = {
  ACTVCODE: { parent: 'actv_code_type_id', name: (r) => r.short_name },
  PCATVAL: { parent: 'proj_catg_type_id', name: (r) => r.proj_catg_short_name },
  RCATVAL: { parent: 'rsrc_catg_type_id', name: (r) => r.rsrc_catg_short_name },
  RSRCRATE: { parent: 'rsrc_id', name: (r) => r.start_date ?? '' },
  ROLERATE: { parent: 'role_id', name: (r) => r.start_date ?? '' },
};
/** How a project row is recognised in the target on update (on the row with the target's ids). PROJWBS: by code path. */
const NATURAL: Record<string, (r: Row) => string> = {
  TASK: (r) => r.task_code,
  CALENDAR: (r) => r.clndr_name, ACTVTYPE: (r) => r.actv_code_type, PROJISSU: (r) => r.issue_name, // the project's own calendars, code types, issues
  TASKPRED: (r) => `${r.pred_task_id}|${r.task_id}|${r.pred_type}`, // P6 keeps one relationship per pair and type
  TASKRSRC: (r) => `${r.task_id}|${r.rsrc_id ?? ''}|${r.role_id ?? ''}`,
  TASKACTV: (r) => `${r.task_id}|${r.actv_code_type_id}`, // one value per code type per activity
  UDFVALUE: (r) => `${r.udf_type_id}|${r.fk_id}`,
  TASKMEMO: (r) => `${r.task_id}|${r.memo_type_id}`, WBSMEMO: (r) => `${r.wbs_id}|${r.memo_type_id}`,
  TASKPROC: (r) => `${r.task_id}|${r.proc_name}`, PROJCOST: (r) => `${r.task_id}|${r.cost_name}`,
  TASKFIN: (r) => `${r.task_id}|${r.fin_dates_id}`, TRSRCFIN: (r) => `${r.taskrsrc_id}|${r.fin_dates_id}`,
  PROJPCAT: (r) => `${r.proj_id}|${r.proj_catg_type_id}`, TASKDOC: (r) => `${r.task_id}|${r.doc_id}`,
};
const UDF_FK_TABLE: Record<string, string> = { TASK: 'TASK', PROJWBS: 'PROJWBS', PROJECT: 'PROJECT', RSRC: 'RSRC', TASKRSRC: 'TASKRSRC', ROLE: 'ROLES', PROJCOST: 'PROJCOST', TASKPROC: 'TASKPROC', PROJISSU: 'PROJISSU' };
/** Fields kept out of refTarget (they often point outside the file, so they are not checked or pulled in on export) that still follow their row when it is renumbered. */
const SOFT_REFS: Record<string, string> = { 'TASK|rsrc_id': 'RSRC', pobs_id: 'POBS', shift_id: 'SHIFT' };
/** A reference that a row cannot exist without: when what it points at is left out, the row is left out too. */
const OWNER = new Set(['task_id', 'pred_task_id', 'taskrsrc_id', 'udf_type_id', 'actv_code_type_id', 'memo_type_id', 'fin_dates_id', 'proj_catg_type_id', 'rsrc_catg_type_id',
  'TASKACTV|actv_code_id', 'TASKRSRC|rsrc_id', 'RSRCRATE|rsrc_id', 'RSRCROLE|rsrc_id', 'RSRCROLE|role_id', 'ROLERATE|role_id', 'PROJPCAT|proj_catg_id', 'RSRCRCAT|rsrc_catg_id', 'RSRCRCAT|rsrc_id', 'TASKDOC|doc_id']);

/** Default plan: every project in the file as a new project. */
export function defaultPlan(src: Db): ImportPlan {
  return { projects: rows(src, 'PROJECT').map((p) => ({ srcProjId: p.proj_id, action: 'new' })) };
}

/** A WBS node's code path inside its project ("" for the project node), e.g. "B1/L2". */
function wbsPaths(db: Db, projId: string): Map<string, string> {
  const ws = rows(db, 'PROJWBS').filter((w) => w.proj_id === projId), by = new Map(ws.map((w) => [w.wbs_id, w])), out = new Map<string, string>();
  const path = (w: Row, depth = 0): string => {
    if (out.has(w.wbs_id)) return out.get(w.wbs_id)!;
    const parent = w.proj_node_flag === 'Y' ? undefined : by.get(w.parent_wbs_id);
    const p = w.proj_node_flag === 'Y' ? '' : parent && depth < ws.length ? `${path(parent, depth + 1)}/${w.wbs_short_name}` : `/${w.wbs_short_name}`;
    out.set(w.wbs_id, p);
    return p;
  };
  for (const w of ws) path(w);
  return out;
}

export function importIntoDb(db: Db, src: Db, plan: ImportPlan): ImportResult {
  const findings: Finding[] = [];
  const map: Record<string, Record<string, string>> = {};
  const m = (t: string) => (map[t] ??= {});
  const counts: ImportCounts = {};
  const count = (t: string, k: keyof ImportCounts[string], n = 1) => { (counts[t] ??= { inserted: 0, updated: 0, kept: 0, removed: 0, skipped: 0 })[k] += n; };
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
  for (const a of plan.projects) {
    if (a.action === 'new' || a.action === 'skip') continue;
    const t = rows(db, 'PROJECT').find((p) => p.proj_id === a.targetProjId);
    if (!t) throw new Error(`${a.action}: no target project ${a.targetProjId ?? '(none given)'}.`);
    if (t._baseline_of) throw new Error(`${a.action}: ${t.proj_short_name} is a baseline; import into the project itself.`);
  }
  /** Projects of the file merged into an existing project (rows matched against it): src proj_id -> target proj_id. */
  const merging = new Map(plan.projects.filter((p) => p.action === 'update' || p.action === 'add_into').map((p) => [p.srcProjId, p.targetProjId!]));
  const addInto = new Set(plan.projects.filter((p) => p.action === 'add_into').map((p) => p.srcProjId));
  const act = (t: string): DataAction => plan.data?.[t] ?? 'update';

  // Replace: the target's content goes; activities of the same Activity ID (and WBS of the same path) keep their ids,
  // so what other projects hold (relationships, a TIA copy's links) still finds them
  const reuse: Record<string, Map<string, string>> = { TASK: new Map(), PROJWBS: new Map() };
  const outside: { row: Row; inner: string; code: string; other: string }[] = []; // replace: relationships to other projects
  const keepProject = new Map<string, Row>(); // replace: the target project's own fields (its ID, EPS, baselines' assignment)
  for (const a of plan.projects) {
    if (a.action === 'skip') continue;
    if (a.action === 'new') { m('PROJECT')[a.srcProjId] = alloc('PROJECT'); continue; }
    m('PROJECT')[a.srcProjId] = a.targetProjId!;
    if (a.action !== 'replace') continue;
    const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === a.targetProjId).map((t) => [t.task_code, t.task_id]));
    for (const t of rows(src, 'TASK')) if (t.proj_id === a.srcProjId && byCode.has(t.task_code)) reuse.TASK.set(t.task_id, byCode.get(t.task_code)!);
    const tp = wbsPaths(db, a.targetProjId!), byPath = new Map([...tp].map(([id, p]) => [p, id]));
    for (const [id, p] of wbsPaths(src, a.srcProjId)) if (byPath.has(p)) reuse.PROJWBS.set(id, byPath.get(p)!);
    const mine = new Map(rows(db, 'TASK').filter((t) => t.proj_id === a.targetProjId).map((t) => [t.task_id, t.task_code]));
    const codeOf = (id: string) => rows(db, 'TASK').find((t) => t.task_id === id)?.task_code ?? id;
    for (const r of rows(db, 'TASKPRED')) {
      const s = mine.has(r.task_id), p = mine.has(r.pred_task_id);
      if (s !== p) outside.push({ row: { ...rawOf(r) }, inner: s ? r.task_id : r.pred_task_id, code: mine.get(s ? r.task_id : r.pred_task_id)!, other: codeOf(s ? r.pred_task_id : r.task_id) });
    }
    keepProject.set(a.targetProjId!, { ...rawOf(rows(db, 'PROJECT').find((p) => p.proj_id === a.targetProjId)!) });
    deleteProject(db, a.targetProjId!, true);
  }

  const isProjectRow = (t: string, r: Row) => !!r.proj_id && t !== 'PROJECT';
  const inSkipped = (t: string, r: Row) => (t === 'PROJECT' ? skipped.has(r.proj_id) : !!r.proj_id && skipped.has(r.proj_id));
  const dropped = new Set<string>(); // "TABLE|srcKey": left out (skip, or what it needs was left out)
  const keepExisting = new Set<string>(); // "TABLE|srcKey" rows not inserted because an existing row is used
  const updates: [string, Row, Row][] = [];
  const matchedTarget: Record<string, Set<string>> = {}; // update: target keys a file row was matched to

  // the target's rows of a merged project, by natural key (built once per table)
  const targetIx = new Map<string, Map<string, Row>>();
  const indexOf = (t: string, projId: string, key: (r: Row) => string) => {
    const ck = `${t}|${projId}`;
    let ix = targetIx.get(ck);
    if (!ix) {
      ix = new Map();
      const has = (db.tables[t]?.fields ?? []).includes('proj_id');
      for (const r of rows(db, t)) if (!has || r.proj_id === projId) ix.set(key(r), r);
      targetIx.set(ck, ix);
    }
    return ix;
  };
  const wbsTarget = new Map<string, Map<string, string>>(); // target proj -> path -> wbs_id
  const wbsSrc = new Map<string, Map<string, string>>(); // src proj -> wbs_id -> path
  const targetCodes = new Map<string, Set<string>>(); // add_into: Activity IDs the target already has

  // one field of a source row, with the target's ids (undefined: points at something not imported)
  const udfTable = new Map(rows(src, 'UDFTYPE').map((u) => [u.udf_type_id, u.table_name]));
  const targetCache = new Map<string, string | undefined>(); // table|field -> referenced table (millions of lookups on big files)
  const targetOf = (t: string, f: string) => { const ck = t + '|' + f; let x = targetCache.get(ck); if (x === undefined && !targetCache.has(ck)) targetCache.set(ck, (x = refTarget(f, t))); return x; };
  const goneRef = (t: string, r: Row): boolean => {
    for (const f in r) {
      const v = r[f];
      if (!v || !(OWNER.has(f) || OWNER.has(`${t}|${f}`))) continue;
      const target = t === 'UDFVALUE' && f === 'fk_id' ? UDF_FK_TABLE[udfTable.get(r.udf_type_id) ?? ''] : targetOf(t, f);
      if (target && dropped.has(`${target}|${v}`)) return true;
    }
    return t === 'UDFVALUE' && !!r.fk_id && dropped.has(`${UDF_FK_TABLE[udfTable.get(r.udf_type_id) ?? ''] ?? ''}|${r.fk_id}`);
  };
  const remap = (t: string, r: Row, quiet = false): Row => {
    const out: Row = { ...rawOf(r) }; // a copy keeps the source row's shape (built key by key, a 60-field row is a dictionary 6x the size)
    const k = KEYS[t];
    for (const f in r) {
      const v = r[f];
      if (f === k) { out[f] = (t === 'PROJECT' ? m('PROJECT')[v] : m(t)[v]) ?? v; continue; }
      const target = targetOf(t, f);
      if (!target && v) { const st = SOFT_REFS[t + '|' + f] ?? SOFT_REFS[f]; const nv = st && map[st]?.[v]; if (nv) { out[f] = nv; continue; } if (st && dropped.has(`${st}|${v}`)) { out[f] = ''; continue; } }
      if (t === 'UDFVALUE' && f === 'fk_id') { const ft = UDF_FK_TABLE[udfTable.get(r.udf_type_id) ?? ''] ?? ''; out[f] = map[ft]?.[v] ?? v; continue; }
      if (target && v) {
        const nv = map[target]?.[v];
        if (nv == null && dropped.has(`${target}|${v}`)) {
          // what it points at was left out: a calendar falls back to the project's, a WBS to the project node, the rest is cleared
          const pid = m('PROJECT')[r.proj_id] ?? '';
          out[f] = target === 'CALENDAR' ? rows(db, 'PROJECT').find((p) => p.proj_id === pid)?.clndr_id ?? rows(db, 'CALENDAR').find((c) => c.default_flag === 'Y')?.clndr_id ?? ''
            : target === 'PROJWBS' && t === 'TASK' ? rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y')?.wbs_id ?? '' : '';
          continue;
        }
        if (nv == null && !quiet && target !== 'PROJECT' && src.tables[target]) findings.push({ severity: 'warning', code: 'IMPORT_UNRESOLVED', table: t, field: f, key: r[k ?? ''] ?? '', message: `${t}.${f} = ${v} has no matching ${target} row; kept as is.`, p6: 'P6 would drop or default this reference.' });
        out[f] = nv ?? (target === 'PROJWBS' && f === 'parent_wbs_id' && r.proj_node_flag === 'Y' ? '' : v);
      } else out[f] = v;
    }
    return out;
  };
  /** The target row a merged project's row is matched to, if any. */
  const matchMerged = (t: string, r: Row, target: string): Row | undefined => {
    if (t === 'PROJWBS') {
      if (addInto.has(r.proj_id)) return undefined; // added as new nodes under the chosen one
      if (!wbsTarget.has(target)) wbsTarget.set(target, new Map([...wbsPaths(db, target)].map(([id, p]) => [p, id])));
      if (!wbsSrc.has(r.proj_id)) wbsSrc.set(r.proj_id, wbsPaths(src, r.proj_id));
      const id = wbsTarget.get(target)!.get(wbsSrc.get(r.proj_id)!.get(r.wbs_id) ?? '\0');
      return id ? rows(db, 'PROJWBS').find((w) => w.wbs_id === id) : undefined;
    }
    if (t === 'TASK' && addInto.has(r.proj_id)) return undefined;
    const key = NATURAL[t];
    if (!key) return undefined; // a project row the file and the project cannot share an identity for: inserted
    return indexOf(t, target, key).get(key(remap(t, r, true)));
  };

  // Pass 1: allocate keys, match dictionaries and (update) the merged projects' rows; parents before their children
  // (child dictionaries last: a code type can name a WBS, so it comes after PROJWBS, and its values after it)
  const names = Object.keys(src.tables);
  // (periods after their financial period calendars: a period is matched within its calendar)
  const rank = (n: string) => (CHILD[n] ? 6 : n === 'FINDATES' ? 1 : n === 'PROJWBS' ? 2 : n === 'TASK' ? 3 : n === 'TASKRSRC' ? 4 : src.tables[n].fields.includes('task_id') || src.tables[n].fields.includes('wbs_id') ? 5 : 0);
  const order = [...names].sort((x, y) => rank(x) - rank(y));
  for (const t of order) {
    const k = KEYS[t];
    if (!k || t === 'PROJECT') continue;
    for (const r of src.tables[t].rows) {
      if (inSkipped(t, r) || !r[k]) continue;
      if (goneRef(t, r)) { dropped.add(`${t}|${r[k]}`); count(t, 'skipped'); continue; }
      const dictRow = !isProjectRow(t, r) || (t === 'CALENDAR' && !r.proj_id);
      if (dictRow && MATCH[t]) {
        const name = MATCH[t](r);
        // a financial period by name within its calendar (the one its calendar maps to; none: the default)
        const finCal = () => { const c = r.fintmpl_id || defaultCalendarId(src); return (c ? m('FINTMPL')[c] : '') || defaultCalendarId(db); };
        const hit = t === 'FINDATES' ? financialPeriods(db, finCal()).find((x) => x.fin_dates_name === r.fin_dates_name) : rows(db, t).find((x) => MATCH[t](x) === name && (t !== 'CALENDAR' || !x.proj_id));
        const a = plan.dict?.[t] ?? 'keep';
        if (hit && a !== 'insert') {
          m(t)[r[k]] = hit[k];
          keepExisting.add(`${t}|${r[k]}`);
          if (a === 'update') updates.push([t, hit, r]);
          if (t === 'EPS') {
            // an EPS node of the same ID is the one used: its name and parent stay as they are here; say so for every node, and which differ
            const parentOf = (db0: Db, x: Row) => (x.parent_eps_id ? rows(db0, 'EPS').find((e) => e.eps_id === x.parent_eps_id)?.eps_short_name ?? `(eps_id ${x.parent_eps_id})` : '(top level)');
            const imp = { name: r.eps_name ?? '', parent: parentOf(src, r) }, kept = { name: hit.eps_name ?? '', parent: parentOf(db, hit) };
            const differs = imp.name !== kept.name || imp.parent !== kept.parent;
            findings.push({ severity: differs ? 'warning' : 'info', code: 'IMPORT_EPS_MATCHED', table: 'EPS', key: hit.eps_id, message: `EPS "${r.eps_short_name}": the imported node (name "${imp.name}", parent ${imp.parent}) was matched to the existing node of the same ID and the existing one is kept (name "${kept.name}", parent ${kept.parent})${differs ? '; the imported name / parent were NOT applied' : ''}.`, p6: 'An EPS ID is unique in P6: the import uses the node of that ID that is already there.' });
          }
          continue;
        }
        if (!hit && a === 'skip') { dropped.add(`${t}|${r[k]}`); count(t, 'skipped'); continue; }
      } else if (CHILD[t]) {
        const c = CHILD[t];
        const parentTable = refTarget(c.parent)!;
        const parentKept = keepExisting.has(`${parentTable}|${r[c.parent]}`);
        if (parentKept) {
          const newParent = m(parentTable)[r[c.parent]];
          const hit = rows(db, t).find((x) => x[c.parent] === newParent && c.name(x) === c.name(r));
          if (hit) { m(t)[r[k]] = hit[k]; keepExisting.add(`${t}|${r[k]}`); if ((plan.dict?.[t] ?? plan.dict?.[parentTable]) === 'update') updates.push([t, hit, r]); continue; }
        }
        if (plan.dict?.[t] === 'skip') { dropped.add(`${t}|${r[k]}`); count(t, 'skipped'); continue; }
      } else if (isProjectRow(t, r) && merging.has(r.proj_id)) {
        const hit = matchMerged(t, r, merging.get(r.proj_id)!);
        const a = act(t);
        if (hit) {
          m(t)[r[k]] = hit[k];
          keepExisting.add(`${t}|${r[k]}`);
          (matchedTarget[t] ??= new Set()).add(hit[k]);
          if (a === 'update' || a === 'remove_missing') updates.push([t, hit, r]); else count(t, 'kept');
          continue;
        }
        if (a === 'skip') { dropped.add(`${t}|${r[k]}`); count(t, 'skipped'); continue; }
      }
      m(t)[r[k]] = (t === 'TASK' || t === 'PROJWBS') && reuse[t].get(r[k]) ? reuse[t].get(r[k])! : alloc(t);
    }
  }

  // Pass 2: copy rows with remapped references
  for (const t of names) { const dst = table(db, t); for (const f of src.tables[t].fields) if (!dst.fields.includes(f)) dst.fields.push(f); }
  for (const [t, hit, r] of updates) {
    const nr = remap(t, r);
    if (t === 'PROJWBS' && hit.proj_node_flag === 'Y') { delete nr.wbs_short_name; delete nr.wbs_name; } // the project node is named by its project
    delete nr[KEYS[t]];
    Object.assign(hit, nr);
    count(t, 'updated');
  }
  for (const t of names) {
    const dst = table(db, t);
    const k = KEYS[t];
    const add: Row[] = [];
    for (const r of src.tables[t].rows) {
      if (inSkipped(t, r)) continue;
      if (k && (keepExisting.has(`${t}|${r[k]}`) || dropped.has(`${t}|${r[k]}`))) continue;
      if (!k && goneRef(t, r)) { count(t, 'skipped'); continue; }
      const nr = remap(t, r);
      if (t === 'PROJECT') {
        const a = actions.get(r.proj_id)!;
        if (a.action === 'add_into') continue; // its WBS and activities go into the target
        if (a.action === 'update') {
          // Update Existing Project: the project's own data from the file; its ID, EPS and the clone's own fields stay
          const p = rows(db, 'PROJECT').find((x) => x.proj_id === a.targetProjId)!;
          for (const f of Object.keys(nr)) if (f !== 'proj_id' && f !== 'proj_short_name' && !f.startsWith('_')) p[f] = nr[f];
          count(t, 'updated');
          continue;
        }
        const kept = keepProject.get(nr.proj_id);
        if (kept) { nr.proj_short_name = kept.proj_short_name; for (const f of Object.keys(kept)) if (f.startsWith('_') && !(f in nr)) nr[f] = kept[f]; }
        if (a.epsId) nr._eps_id = a.epsId;
        if (a.action === 'new') {
          const used = new Set(rows(db, 'PROJECT').map((p) => p.proj_short_name).concat(add.map((p) => p.proj_short_name)));
          if (used.has(nr.proj_short_name)) {
            let n = 1; while (used.has(`${r.proj_short_name}-${n}`)) n++;
            nr.proj_short_name = `${r.proj_short_name}-${n}`;
            findings.push({ severity: 'info', code: 'IMPORT_ID_RENAMED', table: 'PROJECT', key: nr.proj_id, message: `Project ID ${r.proj_short_name} is already used here: imported as ${nr.proj_short_name}.`, p6: 'P6 appends a number to a Project ID that already exists.' });
          }
        }
        // remember which P6 build wrote the file: 6.x builds place milestones differently
        nr._legacy_ms = isLegacyLayout(src) ? 'Y' : 'N';
        nr._p6_ver = src.header?.version ?? '';
        if (nr._baseline_of) nr._baseline_of = m('PROJECT')[nr._baseline_of] ?? nr._baseline_of;
        if (r.sum_base_proj_id && !m('PROJECT')[r.sum_base_proj_id]) nr.sum_base_proj_id = kept?.sum_base_proj_id ?? ''; // its baseline is not in the file: the one it had (replace), or none
      } else if (r.proj_id && addInto.has(r.proj_id)) {
        const target = merging.get(r.proj_id)!;
        if (t === 'PROJWBS' && r.proj_node_flag === 'Y') {
          // the file's project node becomes a WBS node of the target
          const into = actions.get(r.proj_id)!.wbsId ?? rows(db, 'PROJWBS').find((w) => w.proj_id === target && w.proj_node_flag === 'Y')?.wbs_id ?? '';
          nr.proj_node_flag = 'N'; nr.parent_wbs_id = into;
        }
        if (t === 'TASK') {
          const codes = targetCodes.get(target) ?? targetCodes.set(target, new Set(rows(db, 'TASK').filter((x) => x.proj_id === target).map((x) => x.task_code))).get(target)!;
          if (codes.has(nr.task_code)) {
            let n = 1; while (codes.has(`${r.task_code}-${n}`)) n++;
            nr.task_code = `${r.task_code}-${n}`;
            findings.push({ severity: 'info', code: 'IMPORT_ID_RENAMED', table: 'TASK', key: nr.task_id, message: `Activity ID ${r.task_code} is already used in the project: added as ${nr.task_code}.`, p6: 'An Activity ID is unique within a project.' });
          }
          codes.add(nr.task_code);
        }
      } else if (!k && r.proj_id && merging.has(r.proj_id) && NATURAL[t]) {
        // a row without its own key (code and UDF values, period figures): matched on update like the rest
        const hit = indexOf(t, merging.get(r.proj_id)!, NATURAL[t]).get(NATURAL[t](nr));
        const a = act(t);
        if (hit) { if (a === 'update' || a === 'remove_missing') { Object.assign(hit, nr); count(t, 'updated'); } else count(t, 'kept'); continue; }
        if (a === 'skip') { count(t, 'skipped'); continue; }
      }
      add.push(nr);
    }
    // attach in one step (one undo record instead of one per row on million-row tables)
    if (add.length) { dst.rows = rawOf(dst.rows).concat(add); count(t, 'inserted', add.length); }
  }

  // Update with remove_missing: what the project has and the file does not is taken out (activities with their own rows)
  for (const a of plan.projects.filter((p) => p.action === 'update')) {
    const inserted = (t: string) => new Set(Object.entries(map[t] ?? {}).filter(([s]) => !keepExisting.has(`${t}|${s}`)).map(([, d]) => d));
    if (act('TASK') === 'remove_missing') {
      const keep = new Set([...(matchedTarget.TASK ?? []), ...inserted('TASK')]);
      const gone = rows(db, 'TASK').filter((t) => t.proj_id === a.targetProjId && !keep.has(t.task_id)).map((t) => t.task_id);
      if (gone.length) { deleteActivities(db, gone); count('TASK', 'removed', gone.length); }
    }
    for (const t of ['TASKPRED', 'TASKRSRC']) {
      if (act(t) !== 'remove_missing') continue;
      const keep = new Set([...(matchedTarget[t] ?? []), ...inserted(t)]), k = KEYS[t];
      const gone = new Set(rows(db, t).filter((r) => r.proj_id === a.targetProjId && !keep.has(r[k])).map((r) => r[k]));
      if (!gone.size) continue;
      removeWhere(rows(db, t), (r) => gone.has(r[k]));
      if (t === 'TASKRSRC') {
        removeWhere(rows(db, 'TRSRCFIN'), (r) => gone.has(r.taskrsrc_id));
        const udf = new Set(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASKRSRC').map((u) => u.udf_type_id));
        removeWhere(rows(db, 'UDFVALUE'), (r) => udf.has(r.udf_type_id) && gone.has(r.fk_id));
      }
      count(t, 'removed', gone.size);
    }
  }

  // Replace: relationships from other projects come back when their activity is still there (same Activity ID)
  if (outside.length) {
    const ids = new Set(rows(db, 'TASK').map((t) => t.task_id));
    const back: Row[] = [];
    for (const o of outside) {
      if (ids.has(o.inner)) back.push(o.row);
      else findings.push({ severity: 'warning', code: 'IMPORT_LINK_DROPPED', table: 'TASKPRED', key: o.row.task_pred_id, message: `The relationship between ${o.code} and ${o.other} (another project) was removed: ${o.code} is not in the imported file.`, p6: 'Replace Existing Project removes what the file does not have.' });
    }
    if (back.length) table(db, 'TASKPRED').rows = rawOf(rows(db, 'TASKPRED')).concat(back);
  }

  // baselines that came with the file are attached to their projects, not opened as projects
  const baseline = new Set(rows(src, 'PROJECT').filter((p) => p._baseline_of).map((p) => p.proj_id));
  const projIds = [...new Set(plan.projects.filter((p) => p.action !== 'skip' && !baseline.has(p.srcProjId)).map((p) => m('PROJECT')[p.srcProjId]))];
  // financial period calendars: one default (the one this file had, else the first), and a project imported without a
  // calendar gets the default, as P6 assigns it to imported projects
  const cals = rows(db, 'FINTMPL');
  for (const c of cals.filter((x) => x.default_flag === 'Y').slice(1)) c.default_flag = 'N';
  if (cals.length) { const def = defaultCalendarId(db); for (const p of rows(db, 'PROJECT')) if (projIds.includes(p.proj_id) && !p.fintmpl_id) { if (!db.tables.PROJECT.fields.includes('fintmpl_id')) table(db, 'PROJECT').fields.push('fintmpl_id'); p.fintmpl_id = def; } }
  return { projIds, findings, map, counts };
}

/** Delete a project and every row that belongs to it. keepDictionaries keeps global rows. */
export function deleteProject(db: Db, projId: string, _keepDictionaries = true): void {
  const taskIds = new Set(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => t.task_id));
  const codeTypes = new Set(rows(db, 'ACTVTYPE').filter((t) => t.proj_id === projId).map((t) => t.actv_code_type_id)); // its project code types
  for (const t of Object.values(db.tables)) {
    if (t.name === 'TASKPRED') { t.rows = t.rows.filter((r) => !taskIds.has(r.task_id) && !taskIds.has(r.pred_task_id)); continue; }
    if (t.name === 'ACTVCODE') { if (codeTypes.size) t.rows = t.rows.filter((r) => !codeTypes.has(r.actv_code_type_id)); continue; } // their values with them
    if (t.fields.includes('proj_id')) t.rows = t.rows.filter((r) => r.proj_id !== projId);
    else if (t.fields.includes('task_id')) t.rows = t.rows.filter((r) => !taskIds.has(r.task_id));
  }
}
