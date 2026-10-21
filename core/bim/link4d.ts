// 4D links: which model elements each activity builds, removes or uses temporarily. Kept in the project database
// (tables _4D_MODEL, _4D_LINK, _4D_RULE, _4D_SET), so links are undoable edits like any other, travel with the desktop
// database, and go to a <file>.4d.json beside an XER/XML the MCP server saves. Pure code: the model index comes in as
// data (core/bim/model.ts reads IFC files in Node; the desktop's main process does the same).
import { addField, nextId, rows, table, type Db, type Row } from '../db.ts';
import { realOf } from '../journal.ts';
import { elementsByGuid, ordinalOf } from './lookup.ts';
import type { IfcElement, IfcIndex } from './parse.ts';

export const T4D = { model: '_4D_MODEL', link: '_4D_LINK', rule: '_4D_RULE', set: '_4D_SET', status: '_4D_STATUS', view: '_4D_VIEW' } as const;
const FIELDS: Record<string, string[]> = {
  _4D_MODEL: ['model_id', 'proj_id', 'path', 'hash', 'name', 'schema', 'elements', 'length_scale', 'storeys', 'opened'],
  _4D_LINK: ['link_id', 'proj_id', 'task_id', 'guid', 'role', 'profile'],
  _4D_RULE: ['rule_id', 'proj_id', 'json'],
  _4D_SET: ['set_id', 'proj_id', 'name', 'guids', 'source'],
  _4D_STATUS: ['status_id', 'proj_id', 'guid', 'status', 'date'],
  _4D_VIEW: ['view_id', 'proj_id', 'name', 'json'],
};
export const ROLES = ['built', 'removed', 'temporary'] as const;
export type Role = (typeof ROLES)[number];

export function t4d(db: Db, name: string) { const t = table(db, name); for (const f of FIELDS[name] ?? []) addField(t, f); return t; }
const of = (db: Db, name: string, projId: string) => rows(db, name).filter((r) => r.proj_id === projId);

/** The model attached to a project (one per project; a new one replaces it). */
export function modelRow(db: Db, projId: string): Row | undefined { return of(db, T4D.model, projId)[0]; }

export function attachModel(db: Db, projId: string, ix: IfcIndex, hash: string): Row {
  const T = t4d(db, T4D.model);
  const old = T.rows.findIndex((r) => r.proj_id === projId);
  const row: Row = {
    model_id: old >= 0 ? T.rows[old].model_id : String(nextId(db, T4D.model)), proj_id: projId, path: ix.sourcePath, hash,
    name: ix.header.project || ix.sourcePath.split(/[\\/]/).pop() || 'model', schema: ix.schema, elements: String(ix.elements.length),
    length_scale: String(ix.lengthScale), storeys: JSON.stringify(ix.storeys), opened: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
  if (old >= 0) T.rows[old] = row; else T.rows.push(row);
  return row;
}

export interface LinkRow { activity: string; name: string; task_id: string; guid: string; role: Role; profile: string }
export function links(db: Db, projId: string): LinkRow[] {
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
  return of(db, T4D.link, projId).map((l) => ({ activity: tasks.get(l.task_id)?.task_code ?? `#${l.task_id}`, name: tasks.get(l.task_id)?.task_name ?? '', task_id: l.task_id, guid: l.guid, role: (l.role || 'built') as Role, profile: l.profile || '' }));
}

/** Activity lookup by Activity ID (exact, then case-insensitive). */
function activityFinder(db: Db, projId: string) {
  const T = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS');
  const exact = new Map(T.map((t) => [t.task_code, t])), lower = new Map(T.map((t) => [t.task_code.toLowerCase(), t]));
  return (id: string) => exact.get(id) ?? lower.get(String(id).toLowerCase());
}

export interface LinkInput { activity: string; guids: string[]; role?: string; profile?: string }
/** add (default): new pairs are added, existing ones kept; replace: each named activity's links of that role are
 *  replaced; remove: the named pairs (or every link of an activity when guids is empty) are removed. */
export function linkElements(db: Db, projId: string, input: LinkInput[], mode: 'add' | 'replace' | 'remove', ix: IfcIndex | null) {
  const find = activityFinder(db, projId), known = ix ? elementsByGuid(ix) : null;
  const T = t4d(db, T4D.link);
  const unknownActivities: string[] = [], unknownGuids: string[] = [];
  let added = 0, removed = 0;
  // the GlobalIds an activity already has in a role, built for the activities this call touches (a Set of every
  // link of a big model, keyed by a string made per link, took hundreds of MB)
  const haveOf = new Map<string, Set<string>>();
  if (mode !== 'remove') {
    for (const l of input) { const t = find(String(l.activity ?? '')); if (t) haveOf.set(`${t.task_id}|${l.role ?? 'built'}`, new Set()); }
    for (const r of realOf(T.rows)) if (r.proj_id === projId) haveOf.get(`${r.task_id}|${r.role || 'built'}`)?.add(r.guid);
  }
  const have = (taskId: string, role: string) => { const k = `${taskId}|${role}`; let h = haveOf.get(k); if (!h) haveOf.set(k, h = new Set()); return h; };
  for (const l of input) {
    const t = find(String(l.activity ?? ''));
    if (!t) { unknownActivities.push(String(l.activity)); continue; }
    const role = (l.role ?? 'built') as Role;
    if (!ROLES.includes(role)) throw new Error(`role must be built, removed or temporary (activity ${t.task_code}).`);
    const guids = (Array.isArray(l.guids) ? l.guids : []).map(String);
    if (mode === 'remove') {
      const drop = new Set(guids);
      const before = T.rows.length;
      T.rows = T.rows.filter((r) => !(r.proj_id === projId && r.task_id === t.task_id && (!guids.length || drop.has(r.guid)) && (l.role == null || (r.role || 'built') === role)));
      removed += before - T.rows.length;
      continue;
    }
    if (mode === 'replace') {
      const before = T.rows.length;
      T.rows = T.rows.filter((r) => !(r.proj_id === projId && r.task_id === t.task_id && (r.role || 'built') === role));
      removed += before - T.rows.length;
      haveOf.set(`${t.task_id}|${role}`, new Set());
    }
    const h = have(t.task_id, role);
    for (const g of guids) {
      if (known && !known.has(g)) { unknownGuids.push(g); continue; }
      if (h.has(g)) continue;
      h.add(g);
      T.rows.push({ link_id: String(nextId(db, T4D.link)), proj_id: projId, task_id: t.task_id, guid: g, role, profile: l.profile ?? '' });
      added++;
    }
  }
  return { added, removed, links: realOf(T.rows).reduce((n, r) => n + (r.proj_id === projId ? 1 : 0), 0), ...(unknownActivities.length ? { unknown_activities: unknownActivities } : {}), ...(unknownGuids.length ? { unknown_guids: unknownGuids.slice(0, 200), unknown_guid_count: unknownGuids.length } : {}) };
}

// ── rules (Navisworks Auto-Attach, SYNCHRO Auto-Matching) ──────────────────────────────────────────────────────────
export type Rule =
  | { type: 'property'; property: string; equals: string; role?: Role }
  | { type: 'scope'; activity: string; storey?: string; class?: string; name?: string; role?: Role }
  | { type: 'set_name'; equals?: string; role?: Role };

/** An element's value of a property: name, type, material, class, storey, system, guid, or a "Pset.Prop" property. */
export function elementValue(e: IfcElement, property: string): string | undefined {
  const p = property.trim();
  const direct: Record<string, string | undefined> = { name: e.name, type: e.typeName, material: e.material, class: e.ifcClass, storey: e.storey, system: e.system, guid: e.guid, discipline: e.discipline };
  if (p.toLowerCase() in direct) return direct[p.toLowerCase()];
  const v = e.props[p] ?? Object.entries(e.props).find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1];
  return v == null ? undefined : String(v);
}

/** What an activity is matched by: its ID, name, 4D Key UDF, an activity code (code:<type>) or its WBS code. */
export function activityValue(db: Db, t: Row, field: string): string | undefined {
  const f = field.trim().toLowerCase();
  if (f === 'activity_id' || f === 'id') return t.task_code;
  if (f === 'name') return t.task_name;
  if (f === '4d_key' || f === '4d key') return udfValue(db, t, '4D Key') ?? t.task_code;
  if (f === 'wbs') return rows(db, 'PROJWBS').find((w) => w.wbs_id === t.wbs_id)?.wbs_short_name;
  if (f.startsWith('code:')) {
    const type = rows(db, 'ACTVTYPE').find((x) => x.actv_code_type.toLowerCase() === f.slice(5).trim());
    if (!type) return undefined;
    const vals = new Map(rows(db, 'ACTVCODE').filter((c) => c.actv_code_type_id === type.actv_code_type_id).map((c) => [c.actv_code_id, c.short_name]));
    const a = rows(db, 'TASKACTV').find((x) => x.task_id === t.task_id && vals.has(x.actv_code_id));
    return a ? vals.get(a.actv_code_id) : undefined;
  }
  if (f.startsWith('udf:')) return udfValue(db, t, field.slice(4).trim());
  return undefined;
}

function udfValue(db: Db, t: Row, label: string): string | undefined {
  const type = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label.toLowerCase() === label.toLowerCase());
  if (!type) return undefined;
  const v = rows(db, 'UDFVALUE').find((x) => x.udf_type_id === type.udf_type_id && x.fk_id === t.task_id);
  return v ? v.udf_text || v.udf_number || v.udf_date || v.udf_code_id || undefined : undefined;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const glob = (pattern: string) => new RegExp('^' + pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

export interface RulePreview { rule: number; type: string; matched_elements: number; activities: number; links: number; examples: { activity: string; guids: string[] }[]; problems?: string[] }

/** Apply rules (or only preview them with dryRun). Rules are kept with the project so they can be re-run after a
 *  model revision. Answers what each rule links, elements that end up on activities of another rule (conflicts) and
 *  what is left unlinked, by class. */
export function linkByRules(db: Db, projId: string, ix: IfcIndex, rules: Rule[], dryRun: boolean) {
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS');
  const find = activityFinder(db, projId);
  const sets = of(db, T4D.set, projId);
  // what the rules propose, grouped by activity and role (an object per proposed link was hundreds of MB on a big model)
  const grouped = new Map<string, LinkInput & { guids: string[] }>();
  let proposed = 0;
  const previews: RulePreview[] = [];
  rules.forEach((rule, i) => {
    const problems: string[] = [];
    const role = (rule.role ?? 'built') as Role;
    const out = new Map<string, string[]>();
    const push = (act: string, guid: string) => { (out.get(act) ?? out.set(act, []).get(act)!).push(guid); };
    if (rule.type === 'property') {
      const byValue = new Map<string, Row[]>();
      for (const t of tasks) { const v = norm(activityValue(db, t, rule.equals)); if (v) (byValue.get(v) ?? byValue.set(v, []).get(v)!).push(t); }
      if (!byValue.size) problems.push(`No activity has a value for "${rule.equals}".`);
      for (const e of ix.elements) { const v = norm(elementValue(e, rule.property)); const hit = v ? byValue.get(v) : undefined; if (hit) for (const t of hit) push(t.task_code, e.guid); }
    } else if (rule.type === 'scope') {
      const t = find(rule.activity);
      if (!t) problems.push(`No activity "${rule.activity}".`);
      else {
        const re = rule.name ? glob(rule.name) : null;
        for (const e of ix.elements) {
          if (rule.storey && norm(e.storey) !== norm(rule.storey)) continue;
          if (rule.class && !norm(e.ifcClass).startsWith(norm(rule.class))) continue;
          if (re && !re.test(e.name)) continue;
          push(t.task_code, e.guid);
        }
      }
    } else if (rule.type === 'set_name') {
      if (!sets.length) problems.push('No selection sets: import a Navisworks search-set XML (import_4d) first.');
      for (const s of sets) {
        const hit = tasks.filter((t) => norm(activityValue(db, t, rule.equals ?? 'name')) === norm(s.name) || norm(t.task_code) === norm(s.name));
        for (const t of hit) for (const g of JSON.parse(s.guids || '[]') as string[]) push(t.task_code, g);
      }
    } else problems.push(`Unknown rule type "${(rule as { type: string }).type}": use property, scope or set_name.`);
    let n = 0;
    for (const [act, guids] of out) { const k = `${act}|${role}`; const g = grouped.get(k) ?? grouped.set(k, { activity: act, guids: [], role }).get(k)!; for (const x of guids) g.guids.push(x); n += guids.length; }
    proposed += n;
    // one activity: its GlobalIds are distinct (one push per element); several: counted once each
    const matched = out.size <= 1 ? n : new Set([...out.values()].flat()).size;
    previews.push({ rule: i + 1, type: rule.type, matched_elements: matched, activities: out.size, links: n, examples: [...out].slice(0, 5).map(([a, g]) => ({ activity: a, guids: g.slice(0, 5) })), ...(problems.length ? { problems } : {}) });
  });
  // an element linked as "built" by two different activities from rules is worth a look (many-to-many is allowed);
  // counted by element ordinal, so a model of millions of elements needs a few MB for it
  const ordinal = ordinalOf(ix), N = ix.elements.length;
  const first = new Int32Array(N).fill(-1), clash = new Map<number, Set<string>>(), outside = new Map<string, Set<string>>();
  const acts: string[] = [];
  for (const g of grouped.values()) {
    if (g.role !== 'built') continue;
    const a = acts.push(g.activity) - 1;
    for (const guid of g.guids) {
      const o = ordinal(guid);
      if (o < 0) { (outside.get(guid) ?? outside.set(guid, new Set()).get(guid)!).add(g.activity); continue; }
      if (first[o] < 0) first[o] = a;
      else if (acts[first[o]] !== g.activity) (clash.get(o) ?? clash.set(o, new Set([acts[first[o]]])).get(o)!).add(g.activity);
    }
  }
  const conflicts = [...[...clash].map(([o, set]) => [ix.elements[o].guid, set] as const), ...[...outside].filter(([, set]) => set.size > 1)].slice(0, 100).map(([g, set]) => ({ guid: g, activities: [...set] }));
  let applied: ReturnType<typeof linkElements> | undefined;
  if (!dryRun) {
    applied = linkElements(db, projId, [...grouped.values()], 'add', ix);
    const R = t4d(db, T4D.rule);
    for (const r of rules) R.rows.push({ rule_id: String(nextId(db, T4D.rule)), proj_id: projId, json: JSON.stringify(r) });
  }
  // what stays unlinked: a dry run, after the proposals and the links there are; else after the links now
  const linked = new Uint8Array(N);
  const mark = (guid: string) => { const o = ordinal(guid); if (o >= 0) linked[o] = 1; };
  if (dryRun) for (const g of grouped.values()) for (const guid of g.guids) mark(guid);
  for (const r of realOf(rows(db, T4D.link))) if (r.proj_id === projId) mark(r.guid);
  const unlinked: Record<string, number> = {};
  ix.elements.forEach((e, o) => { if (!linked[o]) unlinked[e.ifcClass] = (unlinked[e.ifcClass] ?? 0) + 1; });

  return { dry_run: dryRun, rules: previews, proposed_links: proposed, conflicts, unlinked_by_class: unlinked, ...(applied ? { applied } : {}) };
}

/** Gaps a 4D model should not have: elements no activity builds, activities with no elements, elements on several
 *  activities, links to elements no longer in the model. */
export function linkStatus(db: Db, projId: string, ix: IfcIndex | null) {
  const L = links(db, projId);
  const T = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
  const byGuid = new Map<string, Set<string>>();
  for (const l of L) (byGuid.get(l.guid) ?? byGuid.set(l.guid, new Set()).get(l.guid)!).add(l.activity);
  const withEls = new Set(L.map((l) => l.task_id));
  const known = ix ? new Map(ix.elements.map((e) => [e.guid, e])) : null;
  const unlinkedBy = (k: (e: IfcElement) => string) => { const o: Record<string, number> = {}; if (ix) for (const e of ix.elements) if (!byGuid.has(e.guid)) o[k(e) || '(none)'] = (o[k(e) || '(none)'] ?? 0) + 1; return o; };
  const unlinked = ix ? ix.elements.filter((e) => !byGuid.has(e.guid)) : [];
  return {
    model: modelRow(db, projId)?.path ?? null, elements: ix?.elements.length ?? null, links: L.length, linked_elements: byGuid.size,
    unlinked_elements: ix ? unlinked.length : null, unlinked_by_class: unlinkedBy((e) => e.ifcClass), unlinked_by_storey: unlinkedBy((e) => e.storey),
    activities_without_elements: T.filter((t) => !withEls.has(t.task_id) && t.task_type === 'TT_Task').slice(0, 200).map((t) => t.task_code),
    elements_on_several_activities: [...byGuid].filter(([, s]) => s.size > 1).slice(0, 200).map(([g, s]) => ({ guid: g, activities: [...s] })),
    links_to_missing_elements: known ? L.filter((l) => !known.has(l.guid)).slice(0, 200).map((l) => ({ activity: l.activity, guid: l.guid })) : null,
  };
}

/** The elements of an activity, and the activities of an element. The link rows themselves (a row of a link with no
 *  role is read as built): millions of links make no object of their own. */
export function linkMaps(db: Db, projId: string) {
  type L = { guid: string; task_id: string; role: Role; profile: string };
  const byTask = new Map<string, L[]>(), byGuid = new Map<string, L[]>();
  for (const r of realOf(rows(db, T4D.link))) {
    if (r.proj_id !== projId) continue;
    const l = (r.role && r.profile != null ? r : { ...r, role: r.role || 'built', profile: r.profile || '' }) as unknown as L;
    const a = byTask.get(l.task_id); if (a) a.push(l); else byTask.set(l.task_id, [l]);
    const b = byGuid.get(l.guid); if (b) b.push(l); else byGuid.set(l.guid, [l]);
  }
  return { byTask, byGuid };
}

/** Every 4D row of a project, for the <file>.4d.json sidecar; and back. */
export function export4dState(db: Db, projId: string) {
  const out: Record<string, Row[]> = {};
  for (const name of Object.values(T4D)) out[name] = of(db, name, projId).map(({ proj_id: _p, ...r }) => r);
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t.task_code]));
  // links carry the Activity ID too, so the sidecar still matches after the XER is re-imported with new task ids
  out[T4D.link] = out[T4D.link].map((l) => ({ ...l, activity: tasks.get(l.task_id) ?? '' }));
  return { format: 'p6clone-4d', version: 1, tables: out };
}

export function import4dState(db: Db, projId: string, state: { tables?: Record<string, Row[]> }) {
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t.task_id]));
  let n = 0;
  for (const name of Object.values(T4D)) {
    const T = t4d(db, name);
    T.rows = T.rows.filter((r) => r.proj_id !== projId);
    for (const r of state.tables?.[name] ?? []) {
      const row: Row = { ...r, proj_id: projId };
      if (name === T4D.link) { const id = tasks.get(String(r.activity ?? '')); if (!id) continue; row.task_id = id; delete row.activity; }
      T.rows.push(row); n++;
    }
  }
  return n;
}
