// 4D tools of the MCP server: an IFC model attached to the project, element links (by hand and by rules), their
// gaps, the 4D key, and the packages for Navisworks, SYNCHRO and IFC4 4D tools (and back). Kept apart from server.ts.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { rows, type Db, type Row } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeP6Xml } from '../core/xml/p6xml.ts';
import { cachedModel, loadModel, type Model } from '../core/bim/model.ts';
import { attachModel, elementValue, export4dState, import4dState, linkByRules, linkElements, linkMaps, links, linkStatus, modelRow, t4d, T4D, type Rule } from '../core/bim/link4d.ts';
import { ifc4dText, items4d, linksCsv, parseIfc4d, parseSearchSets, parseTimelinerCsv, README, resolveSet, searchSetsXml, sheetToCsv, tagIfc, timelinerCsv, type Imported4d } from '../core/bim/exchange4d.ts';
import { readXlsx } from '../core/excel/xlsx.ts';
import { fail, pathArg, type Session } from './runtime.ts';
import type { AnalysisHelpers } from './analysis.ts';
import { nextId } from '../core/db.ts';
import { readNwfTimeliner } from '../core/bim/nwf.ts';
import { calendarResolver } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';

const ro = { readOnlyHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: the file’s only project)' };

export const FOURD_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'open_model', annotations: edit, description: 'Attach an IFC model to the project (4D). Parses it once (cached by content; geometry in a separate process, so a huge model cannot take the server down) and answers schema, element count, storeys, classes, units, geometry status and warnings. One model per project; a new one replaces it and keeps the links whose elements are still there. geometry: false is faster (no 3D view or derived volumes). Large models: pass async: true.', inputSchema: withHandle({ type: 'object', properties: { project, path: { type: 'string' }, geometry: { type: 'boolean' } }, required: ['path'] }) },
  { name: 'list_elements', annotations: ro, description: 'Model elements with GlobalId, class, storey, name, type, material and the activities linked to each. Filters: storey, class (prefix, e.g. IfcWall), where [{property, op: = | != | contains | like (* and ?), value}] (property: name, type, material, class, storey, system, or "Pset.Prop"), linked: true | false | <Activity ID>. fields adds properties. Paged by limit (default 200) and offset.', inputSchema: withHandle({ type: 'object', properties: { project, storey: { type: 'string' }, class: { type: 'string' }, where: { type: 'array', items: { type: 'object' } }, linked: {}, fields: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, offset: { type: 'number' } } }) },
  { name: 'element_info', annotations: ro, description: 'Every property, authored quantity, owner stamp and geometry fingerprint of the given elements (up to 200 GlobalIds), and their links.', inputSchema: withHandle({ type: 'object', properties: { project, guids: { type: 'array', items: { type: 'string' } } }, required: ['guids'] }) },
  { name: 'quantities', annotations: ro, description: 'Quantities from the model, grouped by class, storey, class+storey, material, activity or wbs: element count, derived volume (m³, from the geometry) and every authored quantity summed (IfcElementQuantity: NetVolume, NetArea, Length, ...). Grouped by activity it feeds productivity and duration checks against the BOQ.', inputSchema: withHandle({ type: 'object', properties: { project, group_by: { type: 'string' }, classes: { type: 'array', items: { type: 'string' } }, storeys: { type: 'array', items: { type: 'string' } } } }) },
  { name: 'link_elements', annotations: edit, description: 'Link model elements to activities: links [{activity, guids, role?: built (default) | removed | temporary, profile?}]. mode add (default), replace (the activity’s links of that role), remove (the named pairs; every link of the activity when guids is empty). An element may belong to several activities (formwork, concrete, finishes). Every ID is checked and unknown ones are listed. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, links: { type: 'array', items: { type: 'object' } }, mode: { type: 'string' } }, required: ['links'] }) },
  { name: 'link_by_rules', annotations: edit, description: 'Link by rules (Navisworks Auto-Attach, SYNCHRO Auto-Matching). Rules: {type: property, property: <element property: name, type, material, class, storey, "Pset.Prop">, equals: activity_id | name | 4d_key | wbs | code:<code type> | udf:<UDF>}; {type: scope, activity, storey?, class?, name? (wildcards)}; {type: set_name, equals?: name} (selection sets imported with import_4d, named after activities). Each may set role. dry_run: true answers what each rule would link, conflicts and what stays unlinked, without changing anything; run it first. Applied rules are kept with the project.', inputSchema: withHandle({ type: 'object', properties: { project, rules: { type: 'array', items: { type: 'object' } }, dry_run: { type: 'boolean' } }, required: ['rules'] }) },
  { name: 'link_status', annotations: ro, description: 'Gaps in the 4D links: elements no activity builds (by class and storey), task activities with no elements, elements on several activities, links to elements no longer in the model.', inputSchema: withHandle({ type: 'object', properties: { project } }) },
  { name: 'set_4d_keys', annotations: edit, description: 'Write a "4D Key" user-defined field on every activity, from activity_id (default), wbs, code:<code type> or udf:<UDF>. The key travels inside XER and P6 XML; Navisworks rules and SYNCHRO Auto-Matching use it. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, from: { type: 'string' } } }) },
  { name: 'export_4d', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'Write a ready-linked 4D package into the folder path. target navisworks: the IFC with a WHIQ_4D property set on every linked element (Task = 4D key), search-set XML (one set per activity), timeliner.csv (UniqueId = P6 task_id, User 1 = key) and a README with the click path. synchro: P6 XML with the 4D Key field, the tagged IFC, README. ifc4d: the model with the schedule inside, IFC4 (Bonsai): work schedule, tasks with planned/early/late/actual dates, logic, task-to-element links, and baselines (baselines: [names]) as BASELINE schedules. csv: the link table. planned: current (default) or a baseline name, for the planned dates (TimeLiner Planned vs Actual).', inputSchema: withHandle({ type: 'object', properties: { project, target: { type: 'string' }, path: { type: 'string', description: 'folder to write into' }, planned: { type: 'string' }, baselines: { type: 'array', items: { type: 'string' } }, key: { type: 'string', description: 'activity field used as the key (default 4d_key, else the Activity ID)' } }, required: ['target', 'path'] }) },
  { name: 'import_4d', annotations: edit, description: 'Read 4D work from another tool and link it to this project: an IFC 4D file (Bonsai/IFC4 task outputs, or SYNCHRO/IFC2X3 assignments; SYNCHRO-renamed elements "name_(#id)" are matched to the attached design model by that id), a Navisworks search-set XML (kept as selection sets, resolved against the model; link them with link_by_rules set_name), a TimeLiner CSV (or its task grid copied to Excel, .xlsx), or the TimeLiner inside a Navisworks .nwf/.nwd (tasks with planned and actual dates, task type and attached set names, read without Navisworks). Tasks match activities by Activity ID, then by unique name; create_activities: true adds the TimeLiner tasks that match none (planned dates as duration and a start-on-or-after constraint). Attached sets link through selection sets of the same name. link: false only reports. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, path: { type: 'string' }, link: { type: 'boolean' }, create_activities: { type: 'boolean' } }, required: ['path'] }) },
];
export const FOURD_FILES: Record<string, { read: string[]; opens: boolean }> = { open_model: { read: ['path'], opens: false }, import_4d: { read: ['path'], opens: false } };
export const FOURD_NAMES = new Set(['open_model', 'list_elements', 'element_info', 'quantities', 'link_elements', 'link_by_rules', 'link_status', 'set_4d_keys', 'export_4d', 'import_4d']);

/** The model attached to the project: from memory or the disk cache, else reopened from its file. */
async function modelOf(db: Db, projId: string, required = true): Promise<Model | null> {
  const r = modelRow(db, projId);
  if (!r) return required ? fail('no_model', 'No model is attached to this project.', 'Attach one with open_model {path}.') : null;
  const m = cachedModel(r.hash) ?? (existsSync(r.path) ? await loadModel(r.path) : null);
  if (!m && required) return fail('model_missing', `The attached model ${r.path} is not cached and the file is gone.`, 'Attach it again with open_model {path}.');
  return m;
}

export async function runFourD(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers): Promise<unknown> {
  if (!FOURD_NAMES.has(name)) return undefined;
  const ids = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  if (ids.length !== 1) fail('bad_input', `The file holds ${ids.length} projects; say which with project.`, 'Pass project (a Project ID).');
  const projId = ids[0];
  switch (name) {
    case 'open_model': {
      const path = pathArg(a.path);
      let m: Model;
      try { m = await loadModel(path, { geometry: a.geometry !== false }); } catch (e) { return fail('model_unreadable', `Cannot read the model: ${(e as Error).message}`, 'Give the path of an .ifc file inside the storage root.'); }
      await h.tick(1, 1, 'model parsed');
      const ix = m.index;
      const kept = h.apply(`Attach model ${basename(path)}`, (d) => {
        attachModel(d, projId, ix, m.hash);
        // links to elements the new model no longer has are dropped, the rest kept
        const T = t4d(d, T4D.link);
        const before = T.rows.length;
        T.rows = T.rows.filter((r) => r.proj_id !== projId || m.byGuid.has(r.guid));
        return { dropped_links: before - T.rows.length };
      });
      return { model: basename(path), schema: ix.schema, elements: ix.elements.length, storeys: ix.storeys, classes: ix.classCounts, length_unit: ix.lengthScaleSource === 'unit-assignment' ? `${ix.lengthScale} m` : `${ix.lengthScale} m (${ix.lengthScaleSource})`, geometry: ix.geometryStatus, meshed_elements: ix.meshedElements ?? 0, geometry_failures: ix.geometryFailures, ...(ix.geometryNote ? { geometry_note: ix.geometryNote } : {}), quantified_elements: ix.quantifiedElements, header: ix.header, ...kept };
    }
    case 'list_elements': {
      const m = (await modelOf(s.db, projId))!;
      const { byGuid } = linkMaps(s.db, projId);
      const code = new Map(rows(s.db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t.task_code]));
      const where = (Array.isArray(a.where) ? a.where : []) as { property: string; op?: string; value: unknown }[];
      const like = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const test = (e: Model['index']['elements'][number]) => where.every((w) => { const v = elementValue(e, String(w.property)) ?? ''; const x = String(w.value ?? ''); switch (w.op ?? '=') { case '=': return v.toLowerCase() === x.toLowerCase(); case '!=': return v.toLowerCase() !== x.toLowerCase(); case 'contains': return v.toLowerCase().includes(x.toLowerCase()); case 'like': return like(x).test(v); default: return fail('bad_input', `Unknown op "${w.op}".`, 'Use =, !=, contains or like.'); } });
      const hit = m.index.elements.filter((e) => (!a.storey || e.storey.toLowerCase() === String(a.storey).toLowerCase()) && (!a.class || e.ifcClass.toLowerCase().startsWith(String(a.class).toLowerCase())) && test(e) && (a.linked == null || (a.linked === true ? byGuid.has(e.guid) : a.linked === false ? !byGuid.has(e.guid) : (byGuid.get(e.guid) ?? []).some((l) => code.get(l.task_id) === a.linked))));
      const limit = Math.min(5000, Number(a.limit) || 200), offset = Math.max(0, Number(a.offset) || 0);
      return { total: hit.length, offset, elements: hit.slice(offset, offset + limit).map((e) => ({ guid: e.guid, class: e.ifcClass, storey: e.storey, name: e.name, ...(e.typeName ? { type: e.typeName } : {}), ...(e.material ? { material: e.material } : {}), activities: (byGuid.get(e.guid) ?? []).map((l) => `${code.get(l.task_id)}${l.role !== 'built' ? ` (${l.role})` : ''}`), ...(Array.isArray(a.fields) ? { fields: Object.fromEntries(a.fields.map((f: string) => [f, elementValue(e, f) ?? null])) } : {}) })) };
    }
    case 'element_info': {
      const m = (await modelOf(s.db, projId))!;
      const guids = (Array.isArray(a.guids) ? a.guids : []).slice(0, 200).map(String);
      const { byGuid } = linkMaps(s.db, projId);
      const code = new Map(rows(s.db, 'TASK').map((t) => [t.task_id, t.task_code]));
      return { elements: guids.map((g) => { const e = m.byGuid.get(g); return e ? { ...e, activities: (byGuid.get(g) ?? []).map((l) => ({ activity: code.get(l.task_id), role: l.role })) } : { guid: g, error: 'not in the model' }; }) };
    }
    case 'quantities': {
      const m = (await modelOf(s.db, projId))!;
      const by = String(a.group_by ?? 'class');
      const { byGuid } = linkMaps(s.db, projId);
      const tasks = new Map(rows(s.db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
      const wbs = new Map(rows(s.db, 'PROJWBS').map((w) => [w.wbs_id, w.wbs_short_name]));
      const keyOf = (e: Model['index']['elements'][number]): string[] => {
        switch (by) {
          case 'class': return [e.ifcClass]; case 'storey': return [e.storey || '(none)']; case 'class+storey': return [`${e.ifcClass} | ${e.storey || '(none)'}`]; case 'material': return [e.material || '(none)'];
          case 'activity': { const ls = byGuid.get(e.guid) ?? []; return ls.length ? ls.map((l) => tasks.get(l.task_id)?.task_code ?? '?') : ['(unlinked)']; }
          case 'wbs': { const ls = byGuid.get(e.guid) ?? []; return ls.length ? [...new Set(ls.map((l) => wbs.get(tasks.get(l.task_id)?.wbs_id ?? '') ?? '?'))] : ['(unlinked)']; }
          default: return fail('bad_input', `Unknown group_by "${by}".`, 'Use class, storey, class+storey, material, activity or wbs.');
        }
      };
      const cls = (a.classes as string[] | undefined)?.map((c) => c.toLowerCase()), sts = (a.storeys as string[] | undefined)?.map((c) => c.toLowerCase());
      const groups = new Map<string, { count: number; volume_m3: number; authored: Record<string, number> }>();
      for (const e of m.index.elements) {
        if (cls && !cls.some((c) => e.ifcClass.toLowerCase().startsWith(c))) continue;
        if (sts && !sts.includes(e.storey.toLowerCase())) continue;
        for (const k of keyOf(e)) { const g = groups.get(k) ?? groups.set(k, { count: 0, volume_m3: 0, authored: {} }).get(k)!; g.count++; g.volume_m3 += e.derivedVolumeM3 ?? 0; for (const [q, v] of Object.entries(e.authored)) g.authored[q] = (g.authored[q] ?? 0) + v; }
      }
      const r2 = (v: number) => Math.round(v * 1000) / 1000;
      return { group_by: by, geometry: m.index.geometryStatus, groups: [...groups].sort((x, y) => y[1].count - x[1].count).map(([k, g]) => ({ group: k, count: g.count, volume_m3: r2(g.volume_m3), authored: Object.fromEntries(Object.entries(g.authored).map(([q, v]) => [q, r2(v)])) })) };
    }
    case 'link_elements': {
      const m = await modelOf(s.db, projId, false);
      const mode = String(a.mode ?? 'add');
      if (!['add', 'replace', 'remove'].includes(mode)) fail('bad_input', `Unknown mode "${mode}".`, 'Use add, replace or remove.');
      if (!Array.isArray(a.links) || !a.links.length) fail('bad_input', 'links must list {activity, guids}.', 'e.g. [{"activity": "A1000", "guids": ["2O2Fr$t4X7Zf8NOew3FLOH"]}]');
      try { return h.apply('Link elements', (d) => linkElements(d, projId, a.links, mode as 'add', m?.index ?? null)); } catch (e) { return fail('bad_input', (e as Error).message, 'Roles: built, removed, temporary.'); }
    }
    case 'link_by_rules': {
      const m = (await modelOf(s.db, projId))!;
      if (!Array.isArray(a.rules) || !a.rules.length) fail('bad_input', 'rules must list at least one rule.', 'e.g. [{"type": "property", "property": "Pset_X.TaskCode", "equals": "activity_id"}]');
      if (a.dry_run === true) return linkByRules(s.db, projId, m.index, a.rules as Rule[], true);
      return h.apply('Link by rules', (d) => linkByRules(d, projId, m.index, a.rules as Rule[], false));
    }
    case 'link_status': return linkStatus(s.db, projId, (await modelOf(s.db, projId, false))?.index ?? null);
    case 'set_4d_keys': {
      const from = String(a.from ?? 'activity_id');
      const { activityValue } = await import('../core/bim/link4d.ts');
      const tasks = rows(s.db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS');
      const code = rows(s.db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name;
      const values = tasks.map((t) => [t.task_code, activityValue(s.db, t, from)] as const);
      const missing = values.filter(([, v]) => !v).length;
      if (missing === values.length) fail('bad_input', `No activity has a value for "${from}".`, 'Use activity_id, wbs, code:<code type> or udf:<UDF>.');
      const exists = rows(s.db, 'UDFTYPE').some((u) => u.table_name === 'TASK' && u.udf_type_label === '4D Key');
      const ops = [...(exists ? [] : [{ op: 'add_udf', name: '4D Key', subject: 'activity', data_type: 'text' }]), ...values.filter(([, v]) => v).map(([id, v]) => ({ op: 'set_udf', udf: '4D Key', value: v, activity: id, project: code }))];
      h.apply('Set 4D keys', (d) => { const r = applyOps(d, ops, { hoursPerDay: s.hpd }); if (!r.ok) fail('bad_input', r.error!.message, ''); });
      return { from, set: values.length - missing, without_value: missing };
    }
    case 'export_4d': {
      const target = String(a.target ?? '');
      if (!['navisworks', 'synchro', 'ifc4d', 'csv'].includes(target)) fail('bad_input', `Unknown target "${a.target}".`, 'Use navisworks, synchro, ifc4d or csv.');
      const dir = pathArg(a.path, 'path', 'write');
      mkdirSync(dir, { recursive: true }); // inside the write root (pathArg checked it)
      const m = await modelOf(s.db, projId, target !== 'csv');
      const row = modelRow(s.db, projId);
      const key = a.key ?? (rows(s.db, 'UDFTYPE').some((u) => u.table_name === 'TASK' && u.udf_type_label === '4D Key') ? '4d_key' : 'activity_id');
      let items;
      try { items = items4d(s.db, projId, m?.index ?? null, { planned: a.planned, key }); } catch (e) { return fail('bad_input', (e as Error).message, 'planned: current, or the name of a saved baseline.'); }
      if (!items.length && target !== 'csv') fail('no_links', 'No activity has linked elements.', 'Link elements first (link_elements or link_by_rules).');
      const code = rows(s.db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name;
      const stem = basename(row?.path ?? code).replace(/\.ifc$/i, '');
      const written: string[] = [];
      const put = (file: string, data: string) => { const p = join(dir, file); h.writeOut(p, data); written.push(p); };
      const ifcText = () => { if (!row || !existsSync(row.path)) return fail('model_missing', `The model file ${row?.path ?? ''} is gone.`, 'Attach it again with open_model.'); return readFileSync(row.path, 'latin1'); };
      if (target === 'csv') { put(`${code}-4d-links.csv`, linksCsv(s.db, projId, m?.index ?? null)); return { target, written, activities: items.length }; }
      if (target === 'navisworks' || target === 'synchro') {
        const tagged = tagIfc(ifcText(), items);
        put(`${stem}-4D.ifc`, tagged.text);
        if (target === 'navisworks') { put(`${code}-4D-sets.xml`, searchSetsXml(items, code)); put('timeliner.csv', timelinerCsv(items)); }
        else put(`${code}.xml`, writeP6Xml(s.db, { projIds: [projId], version: '19.12' }));
        put('README.txt', README[target]);
        return { target, written, activities: items.length, elements_tagged: tagged.elements, key, planned: a.planned ?? 'current' };
      }
      try { const r = ifc4dText(s.db, projId, ifcText(), items, Array.isArray(a.baselines) ? a.baselines : []); put(`${stem}-4D-IFC4.ifc`, r.text); put('README.txt', README.ifc4d); return { target, written, tasks: r.tasks, element_links: r.links }; }
      catch (e) { return fail('bad_input', (e as Error).message, 'Use the navisworks or synchro target for IFC2X3 models.'); }
    }
    case 'import_4d': {
      const path = pathArg(a.path);
      let text: string;
      try { text = readFileSync(path, 'latin1'); } catch { return fail('file_unreadable', `Cannot read ${path}.`, 'Check the path.'); }
      const nwf = text.startsWith('#LcUStream') ? readNwfTimeliner(readFileSync(path)) : null;
      const imp: Imported4d = nwf ? { source: 'nwf', tasks: nwf.tasks.map((t) => ({ name: t.name, id: t.name, start: t.plannedStart ?? undefined, finish: t.plannedFinish ?? undefined, actualStart: t.actualStart ?? undefined, actualFinish: t.actualFinish ?? undefined, type: t.type, attached: t.attached[0] })), links: [], notes: nwf.notes }
        : /^ISO-10303-21/m.test(text.slice(0, 200)) ? parseIfc4d(text) : /<exchange\b/.test(text.slice(0, 2000)) ? parseSearchSets(text)
        : /\.xlsx$/i.test(path) ? parseTimelinerCsv(sheetToCsv((await readXlsx(new Uint8Array(readFileSync(path))))[0]?.rows ?? [])) : parseTimelinerCsv(readFileSync(path, 'utf8'));
      const tasksOnly = imp.source === 'timeliner_csv' || imp.source === 'nwf';
      const m = await modelOf(s.db, projId, !tasksOnly);
      const T = rows(s.db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS');
      const byId = new Map(T.map((t) => [t.task_code.toLowerCase(), t])), names = new Map<string, Row | null>();
      for (const t of T) { const k = t.task_name.trim().toLowerCase(); names.set(k, names.has(k) ? null : t); }
      const match = (id: string, name?: string) => byId.get(id.toLowerCase()) ?? (name ? names.get(name.trim().toLowerCase()) ?? undefined : names.get(id.trim().toLowerCase()) ?? undefined);
      const byExpress = m ? new Map(m.index.elements.map((e) => [e.expressId, e.guid])) : new Map<number, string>();
      const nameOf = new Map(imp.tasks.map((t) => [t.id, t.name]));
      const proposals: { activity: string; guids: string[] }[] = [];
      const unmatchedTasks: string[] = [], unknownElements = { count: 0 };
      for (const l of imp.links) {
        const t = match(l.task, nameOf.get(l.task));
        if (!t) { unmatchedTasks.push(l.task); continue; }
        const guids = [...(l.guids ?? []).filter((g) => !m || m.byGuid.has(g) || (unknownElements.count++, false)), ...(l.expressIds ?? []).flatMap((x) => { const g = byExpress.get(x); if (!g) unknownElements.count++; return g ? [g] : []; })];
        if (guids.length) proposals.push({ activity: t.task_code, guids });
      }
      const sets = (imp.sets ?? []).map((st) => ({ name: st.name, guids: m ? resolveSet(m.index, st) : [] }));
      // TimeLiner: a task's attached set links the set's elements (sets imported before)
      const knownSets = new Map(rows(s.db, T4D.set).filter((r) => r.proj_id === projId).map((r) => [r.name.toLowerCase(), JSON.parse(r.guids || '[]') as string[]]));
      if (tasksOnly) for (const t of imp.tasks) { const a0 = match(t.id, t.name); if (!a0) { unmatchedTasks.push(t.id); continue; } const g = t.attached ? knownSets.get(t.attached.toLowerCase()) : undefined; if (g?.length) proposals.push({ activity: a0.task_code, guids: g }); }
      // TimeLiner tasks with no activity: created on request (planned dates as the duration and a start-on-or-after)
      const toCreate = a.create_activities === true && tasksOnly ? imp.tasks.filter((t) => !match(t.id, t.name)) : [];
      const summary = { source: imp.source, tasks: imp.tasks.length, matched_activities: new Set(proposals.map((p) => p.activity)).size, unmatched_tasks: [...new Set(unmatchedTasks)].slice(0, 100), proposed_links: proposals.reduce((n, p) => n + p.guids.length, 0), ...(unknownElements.count ? { elements_not_in_model: unknownElements.count } : {}), ...(sets.length ? { sets: sets.map((x) => ({ name: x.name, elements: x.guids.length })) } : {}), ...(tasksOnly ? { attached_sets: [...new Set(imp.tasks.map((t) => t.attached).filter(Boolean))].map((n) => ({ name: n, known: knownSets.has(n!.toLowerCase()) })) } : {}), notes: imp.notes };
      if (a.link === false) return { ...summary, linked: false, ...(toCreate.length ? { would_create: toCreate.map((t) => t.name) } : {}) };
      const applied = h.apply(`Import 4D ${basename(path)}`, (d) => {
        if (sets.length) { const S = t4d(d, T4D.set); for (const st of sets) { S.rows = S.rows.filter((r) => !(r.proj_id === projId && r.name === st.name)); S.rows.push({ set_id: String(nextId(d, T4D.set)), proj_id: projId, name: st.name, guids: JSON.stringify(st.guids), source: basename(path) }); } }
        const created: { id: string; name: string }[] = [];
        if (toCreate.length) {
          const proj = rows(d, 'PROJECT').find((p) => p.proj_id === projId)!;
          const cal = calendarResolver(d, []).fallback(proj.clndr_id);
          const hpd = cal.hoursPerDay() || s.hpd;
          const used = new Set(rows(d, 'TASK').filter((t) => t.proj_id === projId).map((t) => t.task_code));
          let n = 0;
          const ops = toCreate.map((t) => {
            let id = '';
            do id = `TL${String(++n * 10).padStart(4, '0')}`; while (used.has(id));
            used.add(id);
            const st = parseP6Date(t.start ?? ''), fi = parseP6Date(t.finish ?? '');
            const days = st != null && fi != null ? Math.max(0, Math.round((cal.workBetween(st, fi) / 60 / hpd) * 10) / 10) : 1;
            created.push({ id, name: t.name });
            const g = t.attached ? knownSets.get(t.attached.toLowerCase()) : undefined;
            if (g?.length) proposals.push({ activity: id, guids: g });
            return { op: 'add_activity', id, name: t.name, duration_days: days, project: proj.proj_short_name, ...(t.start ? { constraint: { type: 'start_on_or_after', date: t.start } } : {}) };
          });
          const r = applyOps(d, ops, { hoursPerDay: s.hpd, calendarDays: true });
          if (!r.ok) fail('bad_input', r.error!.message, '');
        }
        return { ...(created.length ? { created_activities: created } : {}), ...(proposals.length ? linkElements(d, projId, proposals, 'add', m?.index ?? null) : { added: 0 }) };
      });
      return { ...summary, linked: true, ...applied };
    }
  }
  return undefined;
}

/** <file>.4d.json beside a saved XER/XML: the 4D model, links, rules and sets of each project, by Project ID. */
export function save4dSidecar(db: Db, path: string, projIds: string[], write: (p: string, data: string) => void): string | null {
  const projects: Record<string, unknown> = {};
  for (const id of projIds) { const code = rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name; if (code && (modelRow(db, id) || links(db, id).length)) projects[code] = export4dState(db, id); }
  if (!Object.keys(projects).length) return null;
  const p = `${path}.4d.json`;
  write(p, JSON.stringify({ format: 'p6clone-4d', version: 1, projects }, null, 1));
  return p;
}
export function load4dSidecar(db: Db, path: string): number {
  const p = `${path}.4d.json`;
  if (!existsSync(p)) return 0;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { projects?: Record<string, { tables?: Record<string, Row[]> }> };
    let n = 0;
    for (const [code, state] of Object.entries(j.projects ?? {})) { const proj = rows(db, 'PROJECT').find((x) => x.proj_short_name === code && !x._baseline_of); if (proj) n += import4dState(db, proj.proj_id, state); }
    return n;
  } catch { return 0; }
}
