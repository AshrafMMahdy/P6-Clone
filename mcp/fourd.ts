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
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { compareAt, criticalChanges, simulate, sourceTasks, viewerTimeline } from '../core/bim/sim4d.ts';
import { writeViewer, type ViewerOptions } from '../core/bim/render4d.ts';
import { chromiumPath, ENCODE, inChromium, PNGS } from '../core/bim/headless.ts';
import { activityCosts, earnedValue } from '../core/cost/rollup.ts';
import { mkdtempSync, writeFileSync as writeRaw } from 'node:fs';
import { tmpdir } from 'node:os';

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
  { name: 'simulate_4d', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'The 4D state of the model on dates: element counts by state (not started, in progress, complete, removed, temporary in place, unlinked), optionally by storey or class, and the activities under way in each step. date, or from/to/step (days). source: best (default: actuals up to the data date, then the forecast), planned, actual, late, or a saved baseline name. Dates come from the schedule itself (F9: calendars, actuals, data date). snapshots: [dates] renders PNG frames into path (needs a Chromium: chromium_path or P6CLONE_CHROMIUM; without one, use render_4d kind viewer and look at it).', inputSchema: withHandle({ type: 'object', properties: { project, date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, step: { type: 'number' }, source: { type: 'string' }, by: { type: 'string' }, snapshots: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, view: { type: 'string' }, chromium_path: { type: 'string' } } }) },
  { name: 'compare_4d', annotations: ro, description: 'Progress against a baseline on a date, element by element (TimeLiner Early/Late appearance): ahead, on time, late, not started, complete. late_means start (default: started later than the baseline, as TimeLiner) or finish (finished later). by storey (default), class or wbs: counts and percentages per zone, the elements behind each late figure (max_ids), planned value vs earned value per zone (each activity\u2019s PV/EV shared over its elements), and the activities that became or stopped being critical since the baseline.', inputSchema: withHandle({ type: 'object', properties: { project, date: { type: 'string' }, against: { type: 'string' }, late_means: { type: 'string' }, by: { type: 'string' }, max_ids: { type: 'number' } }, required: ['against'] }) },
  { name: 'set_element_status', annotations: edit, description: 'Element-level progress from site (walkdowns, reality capture): guids, status installed | in_progress | not_installed, date. It overrides the activity\u2019s progress for those elements in simulate_4d, compare_4d and the viewer (actual and best dates), and proposes each touched activity\u2019s % complete from its installed share; apply_percent: true writes it. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, guids: { type: 'array', items: { type: 'string' } }, status: { type: 'string' }, date: { type: 'string' }, apply_percent: { type: 'boolean' } }, required: ['guids', 'status', 'date'] }) },
  { name: 'render_4d', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'The 4D model for people. kind viewer (default): an HTML viewer with the model as a separate file (index.html, viewer4d.js, model.glb, timeline.json) in the folder path, or one self-contained file with embed: true; it plays the schedule, switches sources, and exposes WHIQ4D_EXPORT hooks for a client render. kind images / video: PNG frames or an MP4 (H.264; WebM when the browser has no H.264 encoder) rendered in a headless Chromium (chromium_path or P6CLONE_CHROMIUM); without one the answer gives the self-contained viewer and a client_render request so it is rendered on a GPU (the platform\u2019s client render, or the desktop app). layout single or side_by_side (left: baseline name, right: best; one camera, one date), compare: true colours the right side against left (ahead blue, on time green, late red). from, to, step (days per frame), fps, width, height, view (iso, top, front, side), growth (none, bottom_up, top_down, left_right, right_left: elements appear in that order within their activity), overlays (date, legend, activity_list, gantt_strip, s_curve).', inputSchema: withHandle({ type: 'object', properties: { project, kind: { type: 'string' }, path: { type: 'string' }, embed: { type: 'boolean' }, layout: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' }, compare: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, step: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, view: { type: 'string' }, growth: { type: 'string' }, overlays: { type: 'array', items: { type: 'string' } }, chromium_path: { type: 'string' } }, required: ['path'] }) },
];
export const FOURD_FILES: Record<string, { read: string[]; opens: boolean }> = { open_model: { read: ['path'], opens: false }, import_4d: { read: ['path'], opens: false } };
export const FOURD_NAMES = new Set(['open_model', 'list_elements', 'element_info', 'quantities', 'link_elements', 'link_by_rules', 'link_status', 'set_4d_keys', 'export_4d', 'import_4d', 'simulate_4d', 'compare_4d', 'set_element_status', 'render_4d']);

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
    case 'simulate_4d': {
      const m = (await modelOf(s.db, projId))!;
      const source = String(a.source ?? 'best');
      try { sourceTasks(s.db, projId, source); } catch (e) { return fail('bad_input', (e as Error).message, 'source: best, planned, actual, late, or a saved baseline name.'); }
      if (a.by != null && a.by !== 'storey' && a.by !== 'class') fail('bad_input', 'by must be storey or class.', 'Leave it out for totals.');
      const at = (v: unknown, what: string) => h.dd(v) ?? fail('bad_input', `${what} is not a date.`, 'YYYY-MM-DD');
      const step = Math.max(1, Number(a.step) || 7);
      let dates: number[];
      if (a.date) dates = [at(a.date, 'date')!];
      else {
        const tl = viewerTimeline(s.db, projId, m.index, [source]);
        const from = a.from ? at(a.from, 'from')! : parseP6Date(tl.start ?? '') ?? fail('no_links', 'No linked activity has dates.', 'Link elements and schedule (F9) first.');
        const to = a.to ? at(a.to, 'to')! : parseP6Date(tl.finish ?? '') ?? from;
        dates = []; for (let d = from; d <= to && dates.length < 400; d += step * 1440) dates.push(d);
        if (dates.at(-1)! < to && dates.length < 400) dates.push(to);
      }
      const r = simulate(s.db, projId, m.index, { source, dates, by: a.by, stepDays: step });
      let snapshots: string[] | undefined, note: string | undefined;
      if (Array.isArray(a.snapshots) && a.snapshots.length) {
        const chrome = chromiumPath(a.chromium_path);
        if (!chrome) note = 'No Chromium to render snapshots (pass chromium_path or set P6CLONE_CHROMIUM): render_4d kind viewer gives a page to look at.';
        else if (!m.glb) note = 'The model was opened without geometry: open_model again with geometry for snapshots.';
        else {
          const dir = pathArg(a.path ?? fail('bad_input', 'path (a folder) is needed for snapshots.', 'Pass path.'), 'path', 'write');
          mkdirSync(dir, { recursive: true });
          const page = writeViewer({ dir: mkdtempSync(join(tmpdir(), 'p6c4d-')), glb: m.glb, timeline: viewerTimeline(s.db, projId, m.index, [source]), options: { left: source, interactive: false, view: a.view ?? 'iso', overlays: ['date', 'legend', 'activity_list'] }, title: 'snapshot', embed: true })[0];
          const pngs = await inChromium<string[]>(chrome, page, PNGS(a.snapshots.map(String)));
          snapshots = pngs.map((b64, i) => { const p = join(dir, `snapshot-${String(a.snapshots[i]).slice(0, 10)}.png`); h.writeOut(p, Buffer.from(b64, 'base64')); return p; });
        }
      }
      return { ...r, step_days: step, ...(snapshots ? { snapshots } : {}), ...(note ? { note } : {}) };
    }
    case 'compare_4d': {
      const m = (await modelOf(s.db, projId))!;
      const proj = rows(s.db, 'PROJECT').find((p) => p.proj_id === projId)!;
      const date = a.date ? h.dd(a.date) ?? fail('bad_input', 'date is not a date.', 'YYYY-MM-DD') : parseP6Date(proj.last_recalc_date) ?? Math.floor(Date.now() / 60000);
      const by = (a.by ?? 'storey') as 'storey' | 'class' | 'wbs';
      if (!['storey', 'class', 'wbs'].includes(by)) fail('bad_input', 'by must be storey, class or wbs.', '');
      let r;
      try { r = compareAt(s.db, projId, m.index, { at: date, against: String(a.against), lateMeans: a.late_means === 'finish' ? 'finish' : 'start', by }); } catch (e) { return fail('bad_input', (e as Error).message, 'against: a saved baseline name (or planned).'); }
      const max = Math.min(2000, Number(a.max_ids) || 100);
      const totals = { ahead: 0, on_time: 0, late: 0, not_started: 0, complete: 0 } as Record<string, number>;
      for (const v of r.result.values()) totals[v]++;
      const n = r.result.size || 1;
      // PV and EV by zone: each activity's figures shared over its elements
      const costs = activityCosts(s.db, [projId]);
      const { byTask } = linkMaps(s.db, projId);
      const zoneOf = new Map<string, string>();
      const wbs = new Map(rows(s.db, 'PROJWBS').map((w) => [w.wbs_id, w.wbs_short_name]));
      const tasks = new Map(rows(s.db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
      for (const e of m.index.elements) zoneOf.set(e.guid, by === 'class' ? e.ifcClass : by === 'storey' ? e.storey || '(none)' : '');
      const money: Record<string, { pv: number; ev: number }> = {};
      for (const [taskId, ls] of byTask) {
        const c = costs.get(taskId); if (!c) continue;
        const ev = earnedValue(c);
        for (const l of ls) { const z = by === 'wbs' ? wbs.get(tasks.get(taskId)?.wbs_id ?? '') ?? '(none)' : zoneOf.get(l.guid) ?? '(none)'; const zz = money[z] ?? (money[z] = { pv: 0, ev: 0 }); zz.pv += ev.pv / ls.length; zz.ev += ev.ev / ls.length; }
      }
      const r2 = (v: number) => Math.round(v * 100) / 100;
      return {
        date: formatP6Date(date), against: String(a.against), late_means: a.late_means === 'finish' ? 'finish' : 'start', by, totals, percent: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round((v / n) * 1000) / 10])),
        zones: Object.entries(r.zones).map(([zone, c]) => ({ zone, ...c, ...(money[zone] ? { pv: r2(money[zone].pv), ev: r2(money[zone].ev), spi: money[zone].pv ? r2(money[zone].ev / money[zone].pv) : null } : {}) })),
        late_elements: [...r.result].filter(([, v]) => v === 'late').slice(0, max).map(([g]) => g), ahead_elements: [...r.result].filter(([, v]) => v === 'ahead').slice(0, max).map(([g]) => g),
        critical_path: criticalChanges(s.db, projId, String(a.against)),
      };
    }
    case 'set_element_status': {
      const status = String(a.status ?? '');
      if (!['installed', 'in_progress', 'not_installed'].includes(status)) fail('bad_input', `Unknown status "${a.status}".`, 'Use installed, in_progress or not_installed.');
      const date = h.dd(a.date) ?? fail('bad_input', 'date is not a date.', 'YYYY-MM-DD');
      const m = await modelOf(s.db, projId, false);
      const guids = (Array.isArray(a.guids) ? a.guids : []).map(String);
      const unknown = m ? guids.filter((g) => !m.byGuid.has(g)) : [];
      const ok = guids.filter((g) => !unknown.includes(g));
      const { byGuid, byTask } = linkMaps(s.db, projId);
      return h.apply('Element status', (d) => {
        const T = t4d(d, T4D.status);
        for (const g of ok) T.rows.push({ status_id: String(nextId(d, T4D.status)), proj_id: projId, guid: g, status, date: formatP6Date(date!) });
        // each touched activity: the share of its built elements now installed
        const latest = new Map<string, string>();
        for (const r of rows(d, T4D.status).filter((x) => x.proj_id === projId).sort((x, y) => x.date.localeCompare(y.date))) latest.set(r.guid, r.status);
        const touched = new Set(ok.flatMap((g) => (byGuid.get(g) ?? []).filter((l) => l.role === 'built').map((l) => l.task_id)));
        const code = new Map(rows(d, 'TASK').map((t) => [t.task_id, t]));
        const proposals = [...touched].map((taskId) => { const els = (byTask.get(taskId) ?? []).filter((l) => l.role === 'built'); const inst = els.filter((l) => latest.get(l.guid) === 'installed').length; return { activity: code.get(taskId)!.task_code, installed: inst, elements: els.length, proposed_percent: Math.round((inst / Math.max(1, els.length)) * 1000) / 10, current_percent: Number(code.get(taskId)!.phys_complete_pct || 0) }; });
        if (a.apply_percent === true) {
          // installed elements mean the work began: an activity not yet started gets the earliest status date as its actual start
          const pcode = rows(d, 'PROJECT').find((x) => x.proj_id === projId)!.proj_short_name;
          const first = new Map<string, string>();
          for (const r of rows(d, T4D.status).filter((x) => x.proj_id === projId && x.status !== 'not_installed')) for (const l of byGuid.get(r.guid) ?? []) if (l.role === 'built' && (!first.has(l.task_id) || r.date < first.get(l.task_id)!)) first.set(l.task_id, r.date);
          const ops = proposals.flatMap((p) => { const t = rows(d, 'TASK').find((x) => x.proj_id === projId && x.task_code === p.activity)!; return [...(!t.act_start_date && p.proposed_percent > 0 ? [{ op: 'update_activity', id: p.activity, project: pcode, actual_start: first.get(t.task_id) }] : []), ...(t.act_start_date || p.proposed_percent > 0 ? [{ op: 'update_activity', id: p.activity, project: pcode, percent_complete: p.proposed_percent }] : [])]; });
          const r = applyOps(d, ops, { hoursPerDay: s.hpd });
          if (!r.ok) fail('bad_input', r.error!.message, '');
        }
        return { recorded: ok.length, ...(unknown.length ? { unknown_guids: unknown.slice(0, 100) } : {}), activities: proposals, applied_percent: a.apply_percent === true };
      });
    }
    case 'render_4d': {
      const m = (await modelOf(s.db, projId))!;
      if (!m.glb) fail('no_geometry', 'The model was opened without geometry.', 'open_model again without geometry: false.');
      const kind = String(a.kind ?? 'viewer');
      if (!['viewer', 'images', 'video'].includes(kind)) fail('bad_input', `Unknown kind "${kind}".`, 'Use viewer, images or video.');
      const layout = a.layout === 'side_by_side' ? 'side_by_side' : 'single';
      const left = String(a.left ?? (layout === 'side_by_side' ? '' : 'best')) || fail('bad_input', 'side_by_side needs left (a saved baseline name, or planned).', 'e.g. {"layout": "side_by_side", "left": "BL-2026-03"}');
      const right = String(a.right ?? 'best');
      const sources = [...new Set([left, right, 'best', 'planned'])];
      let timeline;
      try { timeline = viewerTimeline(s.db, projId, m.index, sources); } catch (e) { return fail('bad_input', (e as Error).message, 'left/right: best, planned, actual, late, or a saved baseline name.'); }
      if (!timeline.activities.length) fail('no_links', 'No activity has linked elements.', 'Link elements first (link_elements or link_by_rules).');
      const growth = String(a.growth ?? 'none');
      if (!['none', 'bottom_up', 'top_down', 'left_right', 'right_left'].includes(growth)) fail('bad_input', `Unknown growth "${growth}".`, 'Use none, bottom_up, top_down, left_right or right_left.');
      const options: ViewerOptions = { layout, left, right, compare: a.compare === true, step: Math.max(1, Number(a.step) || 7), growth, overlays: Array.isArray(a.overlays) ? a.overlays : ['date', 'legend', 'activity_list', ...(kind === 'video' ? ['gantt_strip'] : [])], view: a.view ?? 'iso', interactive: kind === 'viewer', title: rows(s.db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name };
      const dir = pathArg(a.path, 'path', 'write');
      const title = `${options.title} 4D`;
      if (kind === 'viewer') return { kind, written: writeViewer({ dir, glb: m.glb!, timeline, options, title, embed: a.embed === true, file: `${options.title}-4D.html` }), activities: timeline.activities.length, linked_elements: Object.keys(timeline.elements).length, hooks: 'WHIQ4D_EXPORT (ready, max, setStep, frame) and P6C4D_API (setDate, setSource, highlight, encode, png)' };
      const width = Math.min(3840, Number(a.width) || 1280), height = Math.min(2160, Number(a.height) || 720), fps = Math.min(60, Math.max(1, Number(a.fps) || 4));
      const page = writeViewer({ dir, glb: m.glb!, timeline, options, title, embed: true, file: `${options.title}-4D-render.html` })[0];
      const chrome = chromiumPath(a.chromium_path);
      if (!chrome) return { kind, rendered: false, viewer: page, client_render: { artifact: page, hooks: 'WHIQ4D_EXPORT', step: options.step, width, height }, note: 'No Chromium here (pass chromium_path or set P6CLONE_CHROMIUM), so nothing was rendered: the self-contained viewer is written; render it on a GPU with the WHIQ4D_EXPORT hooks (the platform\u2019s client render) or the desktop app (Extensions > 4D > Video), or call P6C4D_API.encode() in a browser.' };
      await h.tick(0, 1, `rendering the ${kind} in Chromium`);
      if (kind === 'images') {
        const from = parseP6Date(a.from ? String(a.from) : timeline.start ?? '')!, to = parseP6Date(a.to ? String(a.to) : timeline.finish ?? '')!;
        const dates: string[] = []; for (let d = from; d <= to && dates.length < 500; d += options.step! * 1440) dates.push(formatP6Date(d));
        const pngs = await inChromium<string[]>(chrome, page, PNGS(dates), { width, height });
        return { kind, rendered: true, written: pngs.map((b64, i) => { const p = join(dir, `frame-${String(i).padStart(4, '0')}-${dates[i].slice(0, 10)}.png`); h.writeOut(p, Buffer.from(b64, 'base64')); return p; }) };
      }
      const v = await inChromium<{ mime: string; frames: number; b64: string }>(chrome, page, ENCODE({ from: a.from, to: a.to, step: options.step, fps, width, height }), { width, height });
      const file = join(dir, `${options.title}-4D.${v.mime.includes('mp4') ? 'mp4' : 'webm'}`);
      h.writeOut(file, Buffer.from(v.b64, 'base64'));
      return { kind, rendered: true, written: [file], frames: v.frames, mime: v.mime, fps, size: [width, height] };
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
