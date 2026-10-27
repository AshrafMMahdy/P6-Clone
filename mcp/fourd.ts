// 4D tools of the MCP server: an IFC model attached to the project, element links (by hand and by rules), their
// gaps, the 4D key, and the packages for Navisworks, SYNCHRO and IFC4 4D tools (and back). Kept apart from server.ts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { rows, type Db, type Row } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeP6XmlTo } from '../core/xml/p6xml.ts';
import { fenceListedModels, isNavisworks } from '../core/bim/nwd.ts';
import { cachedModel, fileHash, ifcOf, loadModel, loadNeeds, modelBytes, releaseModels, type LoadNeeds, type Model } from '../core/bim/model.ts';
import { checkRevitSize, isRevit, RevitTooLarge } from '../core/bim/rvt.ts';
import { attachModel, elementValue, export4dState, import4dState, linkByRules, linkElements, linkMaps, links, linkStatus, modelRow, t4d, T4D, type Rule } from '../core/bim/link4d.ts';
import { items4d, README, searchSetsXml, timelinerCsv, type Imported4d } from '../core/bim/exchange4d.ts';
import { admit, countMemory, effectiveBudget, fail, freeMemory, pathArg, readFenced, reserveMemory, sessions, type Session } from './runtime.ts';

// a server with a storage root reads an .nwf's models only beside it and inside the root (realpath checked by pathArg)
fenceListedModels(() => (readFenced() ? (p) => { try { pathArg(p); return true; } catch { return false; } } : null));
import type { AnalysisHelpers } from './analysis.ts';
import type { QuantityKind } from '../core/bim/parse.ts';
import { nextId } from '../core/db.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { compareAt, criticalChanges, simulate, sourceTasks, viewerTimeline } from '../core/bim/sim4d.ts';
import { EmbedTooBig, writeViewer, type ViewerOptions } from '../core/bim/render4d.ts';
import { ifc4dFile, linksCsvFile, tagIfcFile } from '../core/bim/exchange4dFile.ts';
import { compactHeap, plainElement } from '../core/bim/element.ts';
import { embedMaxBytes, readManifest } from '../core/bim/tiles.ts';
import { relinkPlan } from '../core/bim/relink.ts';
import { applyImport as applyImport4d, planImport as planImport4d } from '../core/bim/import4d.ts';
import { readImport4d } from '../core/bim/read4d.ts';
import { runSynchroCloud, SYNCHRO_CLOUD_TOOL } from './synchroCloud.ts';
import { diffIndexes } from '../core/bim/diff.ts';
import { chromiumPath, ffmpegPath, inChromium, probeRenderer, RenderFailed, renderPngs, renderVideo, webmToMp4, type Renderer } from '../core/bim/headless.ts';
import { activityCosts, earnedValue } from '../core/cost/rollup.ts';
import { mkdtempSync, writeFileSync as writeRaw } from 'node:fs';
import { tmpdir } from 'node:os';

const ro = { readOnlyHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: the file’s only project)' };

export const FOURD_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'open_model', annotations: edit, description: 'Attach a model to the project (4D): an IFC, or a Revit .rvt / .rfa (read without Revit by rvt-rs and made into IFC4; the answer’s source says the Revit version, how it was read and what was approximated or skipped; element GlobalIds are those Revit’s own IFC export writes), or a Navisworks .nwd / .nwc / .nwf (the clone’s own reader: each element with its Revit category, family, type, level, ElementId, parameters and the lengths, areas and volumes Revit computed, and the GlobalId Revit’s IFC export writes; an .nwf opens the files it lists from beside it; the geometry read as its triangles, placed, so derived volumes, the 3D view and the 4D video work: Revit elements’ mesh volumes match Revit’s to 1%; read as it is, with no IFC in between, by a reader in a process of its own whose peak memory the answer’s source gives as peak_memory_mb; an IFC4 of it is written, streamed, only for the export_4d targets that deliver one). Without a handle the file opens into a new model-only workspace (no schedule needed: list_elements, element_info and quantities on it) and the answer gives its handle and owner_key. Parses it once (cached by content; geometry in separate processes, chunk by chunk, so a huge model cannot take the server down) and answers schema, element count, storeys, classes, units, geometry status, the display tiles (display: tiles, MB, triangles, instances) and warnings. One model per project; a new one replaces it and keeps the links whose elements are still there. geometry: false is faster and needs only the index: linking, rules, keys and every export_4d work in full on it; the 3D view, video and derived volumes mesh it when asked. A model that does not fit the memory budget is refused (memory_budget) with what it needs and the budget. Large models: pass async: true.', inputSchema: { ...withHandle({ type: 'object', properties: { project, path: { type: 'string' }, geometry: { type: 'boolean' } }, required: ['path'] }), required: ['path'] } },
  { name: 'list_elements', annotations: ro, description: 'Model elements with GlobalId, class, storey, name, type, material and the activities linked to each. Filters: storey, class (prefix, e.g. IfcWall), where [{property, op: = | != | contains | like (* and ?), value}] (property: name, type, material, class, storey, system, or "Pset.Prop"), linked: true | false | <Activity ID>. fields adds properties. Paged by limit (default 200, at most 1000) and offset.', inputSchema: withHandle({ type: 'object', properties: { project, storey: { type: 'string' }, class: { type: 'string' }, where: { type: 'array', items: { type: 'object' } }, linked: {}, fields: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, offset: { type: 'number' } } }) },
  { name: 'element_info', annotations: ro, description: 'Every property, authored quantity, owner stamp and geometry fingerprint of the given elements (up to 200 GlobalIds), and their links.', inputSchema: withHandle({ type: 'object', properties: { project, guids: { type: 'array', items: { type: 'string' } } }, required: ['guids'] }) },
  { name: 'quantities', annotations: ro, description: 'Quantities from the model, grouped by class, storey, class+storey, material, activity or wbs: element count, derived volume (m³, from the geometry) and every authored quantity summed (IfcElementQuantity: NetVolume, NetArea, Length, ...). Grouped by activity it feeds productivity and duration checks against the BOQ. Per group also: figures (each total with its kind, unit, how many elements carry it and its source: base_quantity = an IfcElementQuantity, with its set; geometry = derived from the shape; property_set = a property typed as a measure), and for the asked kind (volume default; area, length, count, weight, time) how many elements are quantified and how many have no figure of that kind at all (unquantified).', inputSchema: withHandle({ type: 'object', properties: { project, group_by: { type: 'string' }, kind: { type: 'string', enum: ['volume', 'area', 'length', 'count', 'weight', 'time'] }, classes: { type: 'array', items: { type: 'string' } }, storeys: { type: 'array', items: { type: 'string' } } } }) },
  { name: 'link_elements', annotations: edit, description: 'Link model elements to activities: links [{activity, guids, role?: built (default) | removed | temporary, profile?}]. mode add (default), replace (the activity’s links of that role), remove (the named pairs; every link of the activity when guids is empty). An element may belong to several activities (formwork, concrete, finishes). Every ID is checked and unknown ones are listed. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, links: { type: 'array', items: { type: 'object' } }, mode: { type: 'string' } }, required: ['links'] }) },
  { name: 'link_by_rules', annotations: edit, description: 'Link by rules (Navisworks Auto-Attach, SYNCHRO Auto-Matching). Rules: {type: property, property: <element property: name, type, material, class, storey, "Pset.Prop">, equals: activity_id | name | 4d_key | wbs | code:<code type> | udf:<UDF>}; {type: scope, activity, storey?, class?, name? (wildcards)}; {type: set_name, equals?: name} (selection sets imported with import_4d, named after activities). Each may set role. dry_run: true answers what each rule would link, conflicts and what stays unlinked, without changing anything; run it first. Applied rules are kept with the project.', inputSchema: withHandle({ type: 'object', properties: { project, rules: { type: 'array', items: { type: 'object' } }, dry_run: { type: 'boolean' } }, required: ['rules'] }) },
  { name: 'link_status', annotations: ro, description: 'Gaps in the 4D links: elements no activity builds (by class and storey), task activities with no elements, elements on several activities, links to elements no longer in the model.', inputSchema: withHandle({ type: 'object', properties: { project } }) },
  { name: 'set_4d_keys', annotations: edit, description: 'Write a "4D Key" user-defined field on every activity, from activity_id (default), wbs, code:<code type> or udf:<UDF>. The key travels inside XER and P6 XML; Navisworks rules and SYNCHRO Auto-Matching use it. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, from: { type: 'string' } } }) },
  { name: 'export_4d', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'Write a ready-linked 4D package into the folder path. target navisworks: the IFC with a WHIQ_4D property set on every linked element (Task = 4D key), search-set XML (one set per activity), timeliner.csv (UniqueId = P6 task_id, User 1 = key) and a README with the click path. synchro: P6 XML with the 4D Key field, the tagged IFC, README. ifc4d: the model with the schedule inside, IFC4 (Bonsai): work schedule, tasks with planned/early/late/actual dates, logic, task-to-element links, and baselines (baselines: [names]) as BASELINE schedules. csv: the link table. planned: current (default) or a baseline name, for the planned dates (TimeLiner Planned vs Actual).', inputSchema: withHandle({ type: 'object', properties: { project, target: { type: 'string' }, path: { type: 'string', description: 'folder to write into' }, planned: { type: 'string' }, baselines: { type: 'array', items: { type: 'string' } }, key: { type: 'string', description: 'activity field used as the key (default 4d_key, else the Activity ID)' } }, required: ['target', 'path'] }) },
  { name: 'import_4d', annotations: edit, description: 'Read 4D work from another tool and link it to this project: an IFC 4D file (Bonsai/IFC4 task outputs, or SYNCHRO/IFC2X3 assignments; SYNCHRO-renamed elements "name_(#id)" are matched to the attached design model by that id), a Navisworks search-set XML (kept as selection sets, resolved against the model; link them with link_by_rules set_name), a TimeLiner CSV (or its task grid copied to Excel, .xlsx), or the TimeLiner inside a Navisworks .nwf/.nwd (read without Navisworks: tasks with planned and actual dates and task type; their selection sets and explicit selections resolved to the elements of the model the file holds or lists, as the GlobalIds open_model gives that file; Demolish and Temporary tasks link as removed and temporary; search sets are named, their conditions not read), or a SYNCHRO project .sp (5.1 to 6.5, read without SYNCHRO: tasks with their IDs and dates, and the 3D objects assigned to them, matched to the attached design model by the "(#id)" in their names). Tasks match activities by Activity ID, then by unique name; create_activities: true adds the TimeLiner and SYNCHRO tasks that match none, with their planned dates as the duration and a start-on-or-after constraint (SYNCHRO task IDs are kept as Activity IDs). Attached sets link through selection sets of the same name; a task with none links the set named like it (TimeLiner’s attach-by-task-name rule). link: false only reports, with the file’s own task list (dates, actual dates, type, attached set and its element count): the review of another tool’s 4D schedule. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, path: { type: 'string' }, link: { type: 'boolean' }, create_activities: { type: 'boolean' } }, required: ['path'] }) },
  { name: 'simulate_4d', annotations: ro, description: 'The 4D state of the model on dates: element counts by state (not started, in progress, complete, removed, temporary in place, unlinked), optionally by storey or class, and the activities under way in each step. date, or from/to/step (days). source: best (default: actuals up to the data date, then the forecast), planned, actual, late, or a saved baseline name. Dates come from the schedule itself (F9: calendars, actuals, data date). snapshots: [dates] renders PNG frames into path (needs the server’s P6CLONE_CHROMIUM; without it, use render_4d kind viewer and look at it). Reads the project only.', inputSchema: withHandle({ type: 'object', properties: { project, date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, step: { type: 'number' }, source: { type: 'string' }, by: { type: 'string' }, snapshots: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, view: { type: 'string' } } }) },
  { name: 'compare_4d', annotations: ro, description: 'Progress against a baseline on a date, element by element (TimeLiner Early/Late appearance): ahead, on time, late, not started, complete. late_means start (default: started later than the baseline, as TimeLiner) or finish (finished later). by storey (default), class or wbs: counts and percentages per zone, the elements behind each late figure (max_ids), planned value vs earned value per zone (each activity\u2019s PV/EV shared over its elements), and the activities that became or stopped being critical since the baseline.', inputSchema: withHandle({ type: 'object', properties: { project, date: { type: 'string' }, against: { type: 'string' }, late_means: { type: 'string' }, by: { type: 'string' }, max_ids: { type: 'number' } }, required: ['against'] }) },
  { name: 'set_element_status', annotations: edit, description: 'Element-level progress from site (walkdowns, reality capture): guids, status installed | in_progress | not_installed, date. It overrides the activity\u2019s progress for those elements in simulate_4d, compare_4d and the viewer (actual and best dates), and proposes each touched activity\u2019s % complete from its installed share; apply_percent: true writes it. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, guids: { type: 'array', items: { type: 'string' } }, status: { type: 'string' }, date: { type: 'string' }, apply_percent: { type: 'boolean' } }, required: ['guids', 'status', 'date'] }) },
  { name: 'render_4d', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'The 4D model for people, from the FULL geometry (display tiles; docs/4d-tiles-contract.md). kind viewer (default): an HTML viewer in the folder path (index.html, viewer4d.js, and the model\u2019s tiles in model-<hash>/: manifest.json, tile-NNNNN.glb, elements.txt), or one self-contained file with embed: true (models up to P6CLONE_EMBED_MAX_MB, 64 MB of tiles; past it too_big_to_embed); it plays the schedule, switches sources, and exposes WHIQ4D_EXPORT hooks for a client render. kind images / video: PNG frames or a video rendered in a headless Chromium (the server’s P6CLONE_CHROMIUM; a tool argument never names a program). format mp4 (default: H.264 from the browser, or its WebM converted with the server’s P6CLONE_FFMPEG; without ffmpeg the WebM is returned with a note) or webm. Progress per frame; cancel_job stops it; without one the answer gives the viewer page (self-contained for a small model, else with its model-<hash>/ tile folder beside it, every file in written) and a client_render request so it is rendered on a GPU (the platform\u2019s client render, or the desktop app). A browser that cannot hold the model fails the render in words naming its size (render_failed); boxes: true draws each element as its bounding box, only when asked. quality (images, video): auto (default), draft (854x480, each element a simple box: quick on any machine), standard (full geometry, 1280x720) or high (1920x1080); auto is standard unless that would take longer than about 10 minutes on this server (it draws on its graphics card when it has one, else with the processor, much slower on a big model), then draft. The answer gives quality, estimated_minutes, renderer and, when the user should hear it, quality_note: ALWAYS tell the user what quality_note says, in plain words (a draft is a quick preview by choice, not how their model looks; standard gives the full detail and how long it takes), so a simplified video is never taken for the model’s real quality. layout single or side_by_side (left: baseline name, right: best; one camera, one date), compare: true colours the right side against left (ahead blue, on time green, late red). from, to, step (days per frame), fps (below 1 holds frames longer) or seconds_per_frame, file_name, width, height, view (iso, top, front, side), growth (none, bottom_up, top_down, left_right, right_left: elements appear in that order within their activity), overlays (date, legend, activity_list, gantt_strip, s_curve).', inputSchema: withHandle({ type: 'object', properties: { project, kind: { type: 'string' }, path: { type: 'string' }, embed: { type: 'boolean' }, layout: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' }, compare: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, step: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, view: { type: 'string' }, growth: { type: 'string' }, overlays: { type: 'array', items: { type: 'string' } }, format: { type: 'string', enum: ['mp4', 'webm'] }, seconds_per_frame: { type: 'number' }, file_name: { type: 'string' }, boxes: { type: 'boolean' }, quality: { type: 'string', enum: ['auto', 'draft', 'standard', 'high'] } }, required: ['path'] }) },
  { name: 'relink_model', annotations: edit, description: 'Bring the 4D links over to a revised model (M4). Each linked element is found in the new model by its GlobalId; else, in the same IFC class, by name and storey (the nearest one when there are several), else by shape (size and position within tolerance_m, default 0.05). Answers what was kept, matched (and how), and lost (no counterpart: those links are dropped), plus the model diff summary (added, removed, modified, re-identified). dry_run: true only reports. One undoable change.', inputSchema: withHandle({ type: 'object', properties: { project, path: { type: 'string' }, tolerance_m: { type: 'number' }, dry_run: { type: 'boolean' } }, required: ['path'] }) },
  SYNCHRO_CLOUD_TOOL(withHandle, project),
];
export const FOURD_FILES: Record<string, { read: string[]; opens: boolean }> = { open_model: { read: ['path'], opens: false }, import_4d: { read: ['path'], opens: false }, relink_model: { read: ['path'], opens: false } };
export const FOURD_NAMES = new Set(['open_model', 'list_elements', 'element_info', 'quantities', 'link_elements', 'link_by_rules', 'link_status', 'set_4d_keys', 'export_4d', 'import_4d', 'simulate_4d', 'compare_4d', 'set_element_status', 'render_4d', 'relink_model', 'synchro_cloud']);

// models in memory count in the server's budget; when room is needed, those no project in memory uses are let go
countMemory(() => modelBytes(), () => releaseModels(new Set([...sessions.values()].flatMap((x) => rows(x.db, T4D.model).map((r) => r.hash)))));

const mbs = (b: number) => `${Math.round(b / 1048576).toLocaleString('en')} MB`;
/** Read a model with its memory reserved first: a model that does not fit is refused (naming the budget and what it
 *  needs), not run out of memory on. Meshing is cut into chunks sized to the memory left (loadNeeds), so a model is
 *  refused only when its index, or its index and the smallest chunk, do not fit. */
async function readModel(path: string, o: { geometry?: boolean; tick?: AnalysisHelpers['tick'] } = {}): Promise<Model> {
  if (!existsSync(path)) return fail('model_unreadable', `No file at ${path}.`, 'Give the path of a model file (.ifc, .rvt, .nwd, .nwc or .nwf) inside the storage root.');
  // a Revit file is made into an IFC4 first, with memory of its own; its meshing is then sized from that IFC, not from
  // the source file. A Navisworks file is read as it is: its need comes from its sections (loadNeeds)
  let ifc = path;
  if (isRevit(path)) {
    try { checkRevitSize(path); } catch (e) { if (e instanceof RevitTooLarge) tooLarge(e); throw e; }
    const conv = fits(path, loadNeeds(path, { geometry: false }), false, () => loadNeeds(path, { geometry: false }));
    const release = reserveMemory(conv.total);
    try { ifc = await ifcOf(path); } finally { release(); }
  }
  const hash = isNavisworks(path) ? undefined : await fileHash(ifc);
  const need = fits(path, loadNeeds(ifc, { geometry: o.geometry, free: freeMemory(), hash }), o.geometry, () => loadNeeds(ifc, { geometry: o.geometry, free: freeMemory(), hash }));
  const release = reserveMemory(need.total);
  try { return await loadModel(path, { geometry: o.geometry, ...(need.chunkBytes ? { chunkBytes: need.chunkBytes } : {}), ...(ifc === path ? { hash } : {}), ...(o.tick ? { onProgress: (d, t, n) => o.tick!(d, t, n) } : {}) }); } finally { release(); }
}

/** A Revit file too big for its reader: refused with its own code, what to ask the user for, and how to say why. */
const tooLarge = (e: RevitTooLarge): never => fail('model_too_large', e.message,
  'Ask the user for an NWC (Navisworks) or IFC export of this model, made in Revit (File > Export); either opens at any size here with the same element GlobalIds, so links already made on it carry over. When you tell the user, assume they are not technical: explain why in plain words (explain_to_user, in this error, says it), not only that it failed.',
  { data: { size_mb: Math.round(e.bytes / 1048576), max_mb: Math.round(e.max / 1048576), alternatives: ['nwc', 'ifc'],
    explain_to_user: `This Revit file is ${Math.round(e.bytes / 1048576)} MB. The part of the app that reads Revit files works inside a fixed amount of working memory (4 GB), and reading a Revit file takes about 8 times its size, so files above about ${Math.round(e.max / 1048576)} MB do not fit. This is a limit of reading the Revit format directly, not a problem with your model. If you export the same model from Revit as an NWC (Navisworks) or IFC file (File > Export), the app can open it at any size, and every element keeps its ID, so nothing already linked to the schedule is lost.` } });

/** What to do about a model that could not be read, by its kind */
const unreadableHint = (path: string) => (existsSync(path) && (isRevit(path) || isNavisworks(path))
  ? `The ${isRevit(path) ? 'Revit' : 'Navisworks'} file is read without ${isRevit(path) ? 'Revit' : 'Navisworks'}, and the message says what stopped it; saving it again from a current version usually helps, and an IFC exported from it always opens.`
  : 'Give the path of a model file (.ifc, .rvt, .nwd, .nwc or .nwf) inside the storage root.');

/** The need, when it fits the memory free (idle projects moved out first, as for any file); else refused in words. */
export function fits(path: string, first: LoadNeeds, geometry: boolean | undefined, again: () => LoadNeeds): LoadNeeds {
  const budget = effectiveBudget();
  let free = freeMemory(), need = first;
  // idle projects moved out make room first (as for any file); only what still does not fit is refused
  if (need.total <= budget && need.total > free) { try { admit(need.total); } catch { /* refused below, in words */ } free = freeMemory(); need = again(); }
  if (need.total > budget || need.total > free) {
    const size = existsSync(path) ? statSync(path).size : 0;
    const parts = [need.index ? `${mbs(need.index)} for the index` : '', need.mesh ? (need.chunkBytes ? `${mbs(need.mesh)} for meshing it in chunks of ${mbs(need.chunkBytes)} of the IFC` : `${mbs(need.mesh)} for reading it (the Navisworks reader's own process)`) : ''].filter(Boolean).join(' and ');
    const indexOnly = geometry !== false && need.index && need.index <= Math.min(budget, free);
    fail('memory_budget', `Opening this ${mbs(size)} model needs about ${mbs(need.total)} of memory (${parts}; measured, docs/4d-tiles-contract.md "Memory"); the memory budget is ${mbs(budget)} (P6CLONE_MEM_BUDGET_MB) and ${mbs(Math.max(0, free))} of it is free now.`,
      need.total > budget ? (indexOnly ? 'The index fits without geometry: open_model with geometry: false links and exports in full (no 3D view, video or derived volumes); or raise P6CLONE_MEM_BUDGET_MB.' : (isRevit(path) ? 'Export an IFC from Revit (File > Export > IFC); an IFC opens at any size here. Administrators: the Revit file needs more than the whole memory budget; raise P6CLONE_MEM_BUDGET_MB (and the Node heap with --max-old-space-size) to read it directly.' : 'The model is larger than the whole memory budget: raise P6CLONE_MEM_BUDGET_MB (and the Node heap with --max-old-space-size) or split the model.')) : 'Retry when the running calls have finished; idle projects are moved out automatically.',
      { retryAfter: need.total > budget ? undefined : 10, data: { needed_mb: Math.round(need.total / 1048576), index_mb: Math.round(need.index / 1048576), mesh_mb: Math.round(need.mesh / 1048576), chunk_mb: Math.round(need.chunkBytes / 1048576), budget_mb: Math.round(budget / 1048576), free_mb: Math.round(Math.max(0, free) / 1048576) } });
  }
  return need;
}

/** Minutes a render takes, from the triangles drawn per frame and the frames, plus loading the tiles (measured on a
 *  509 MB federation, 320 million triangles, 24 frames at 1280x720: 60 min with the processor drawing, about 2 million
 *  triangles a second; 34 s on this machine's graphics card, about 400 million, the tiles at about 200 MB/s). */
export function renderMinutes(kind: 'gpu' | 'software', triangles: number, frames: number, tileBytes: number, pixels = 1280 * 720): number {
  const perFrame = kind === 'gpu' ? 0.15 + triangles / RENDER_GPU_TRIANGLES_PER_S : 0.5 * (pixels / (1280 * 720)) + triangles / RENDER_SOFTWARE_TRIANGLES_PER_S;
  return (frames * perFrame + tileBytes / (200 * 1048576)) / 60;
}
export const RENDER_SOFTWARE_TRIANGLES_PER_S = 2.1e6, RENDER_GPU_TRIANGLES_PER_S = 400e6;
/** Past this many minutes for the full model, quality auto renders a draft (P6CLONE_RENDER_DRAFT_MINUTES, 10). */
const draftLimitMinutes = () => Number(process.env.P6CLONE_RENDER_DRAFT_MINUTES) || 10;

/** Where a render the browser could not hold would fit: a crashed page ran out of the machine's memory, the rest out of the GPU's */
const roomFor = (code: string) => (code === 'browser_out_of_memory' ? 'render it where more memory is free for the browser beside the server' : 'render it where there is more GPU memory');

/** No 3D model to draw: say why, never draw an empty building. */
const noGeometry = (m: Model): never => m.index.geometryStatus === 'skipped'
  ? fail('no_geometry', 'The model was opened without geometry.', 'open_model again without geometry: false.')
  : fail('no_geometry', `The model has no 3D geometry: ${m.index.geometryNote ?? 'its geometry did not build'}`, 'Everything without 3D still works (simulate_4d, compare_4d, quantities, links, export_4d); for pictures, fix or split the model and open it again.');

/** The model attached to the project: from memory or the disk cache, else reopened from its file — the index only
 *  (linking, rules, keys and every export need nothing else), unless geometry is asked for (derived volumes,
 *  fingerprints, shape matching): then an index cached without geometry is meshed now. */
async function modelOf(db: Db, projId: string, required = true, o: { geometry?: boolean } = {}): Promise<Model | null> {
  const r = modelRow(db, projId);
  if (!r) return required ? fail('no_model', 'No model is attached to this project.', 'Attach one with open_model {path}.') : null;
  let m = cachedModel(r.hash) ?? (existsSync(r.path) ? await readModel(r.path, { geometry: !!o.geometry }) : null);
  if (m && o.geometry && m.index.geometryStatus === 'skipped' && existsSync(r.path)) m = await readModel(r.path);
  if (!m && required) return fail('model_missing', `The attached model ${r.path} is not cached and the file is gone.`, 'Attach it again with open_model {path}.');
  return m;
}
/** The attached model with its display tiles: meshed now when it was opened without geometry (or its tiles left the
 *  cache); a model whose geometry did not build is refused in words (no_geometry), never drawn empty. */
async function modelWithTiles(db: Db, projId: string, tick?: AnalysisHelpers['tick']): Promise<Model> {
  const m = (await modelOf(db, projId))!;
  if (m.tiles) return m;
  const r = modelRow(db, projId)!;
  // a model whose meshing failed is tried again once a run of the server (loadModel), then refused in words
  if (m.index.geometryStatus === 'unavailable' && !existsSync(r.path)) return noGeometry(m);
  if (!existsSync(r.path)) return fail('model_missing', `The model ${r.path} has no display tiles in the cache and its file is gone.`, 'Attach it again with open_model {path}.');
  const g = await readModel(r.path, { geometry: true, tick });
  return g.tiles ? g : noGeometry(g);
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
      try { m = await readModel(path, { geometry: a.geometry !== false, tick: h.tick }); } catch (e) { if (['memory_budget', 'model_too_large'].includes((e as { code?: string }).code ?? '')) throw e; return fail('model_unreadable', `Cannot read the model: ${(e as Error).message}`, unreadableHint(path)); }
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
      return { model: basename(path), ...(m.source ? { source: m.source } : {}), schema: ix.schema, elements: ix.elements.length, storeys: ix.storeys, classes: ix.classCounts, length_unit: ix.lengthScaleSource === 'unit-assignment' ? `${ix.lengthScale} m` : `${ix.lengthScale} m (${ix.lengthScaleSource})`, geometry: ix.geometryStatus, meshed_elements: ix.meshedElements ?? 0, geometry_failures: ix.geometryFailures, ...(ix.geometryNote ? { geometry_note: ix.geometryNote } : {}), ...((() => { let n = 0; for (const e of ix.elements) if (e.geom && e.derivedVolumeM3 == null) n++; return n ? { meshed_without_volume: n, volume_note: 'open meshes (a surface, a fitting open at its ends) and stand-in bounding boxes enclose no volume to measure, so they give no derived volume; their authored quantities stand' } : {}; })()), quantified_elements: ix.quantifiedElements, ...(m.tiles ? { display: (() => { const t = readManifest(m.tiles!)!; return { tiles: t.tiles.length, mb: Math.round(t.bytes / 1048576), triangles: t.triangles, instances: t.instances }; })() } : {}), header: ix.header, ...kept };
    }
    case 'list_elements': {
      const m = (await modelOf(s.db, projId))!;
      const { byGuid } = linkMaps(s.db, projId);
      const code = new Map(rows(s.db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t.task_code]));
      const where = (Array.isArray(a.where) ? a.where : []) as { property: string; op?: string; value: unknown }[];
      const like = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const test = (e: Model['index']['elements'][number]) => where.every((w) => { const v = elementValue(e, String(w.property)) ?? ''; const x = String(w.value ?? ''); switch (w.op ?? '=') { case '=': return v.toLowerCase() === x.toLowerCase(); case '!=': return v.toLowerCase() !== x.toLowerCase(); case 'contains': return v.toLowerCase().includes(x.toLowerCase()); case 'like': return like(x).test(v); default: return fail('bad_input', `Unknown op "${w.op}".`, 'Use =, !=, contains or like.'); } });
      const hit = m.index.elements.filter((e) => (!a.storey || e.storey.toLowerCase() === String(a.storey).toLowerCase()) && (!a.class || e.ifcClass.toLowerCase().startsWith(String(a.class).toLowerCase())) && test(e) && (a.linked == null || (a.linked === true ? byGuid.has(e.guid) : a.linked === false ? !byGuid.has(e.guid) : (byGuid.get(e.guid) ?? []).some((l) => code.get(l.task_id) === a.linked))));
      const limit = Math.min(1000, Number(a.limit) || 200), offset = Math.max(0, Number(a.offset) || 0);
      return { total: hit.length, offset, elements: hit.slice(offset, offset + limit).map((e) => ({ guid: e.guid, class: e.ifcClass, storey: e.storey, name: e.name, ...(e.typeName ? { type: e.typeName } : {}), ...(e.material ? { material: e.material } : {}), activities: (byGuid.get(e.guid) ?? []).map((l) => `${code.get(l.task_id)}${l.role !== 'built' ? ` (${l.role})` : ''}`), ...(Array.isArray(a.fields) ? { fields: Object.fromEntries(a.fields.map((f: string) => [f, elementValue(e, f) ?? null])) } : {}) })) };
    }
    case 'element_info': {
      const m = (await modelOf(s.db, projId, true, { geometry: true }))!;
      const guids = (Array.isArray(a.guids) ? a.guids : []).slice(0, 200).map(String);
      const { byGuid } = linkMaps(s.db, projId);
      const code = new Map(rows(s.db, 'TASK').map((t) => [t.task_id, t.task_code]));
      return { elements: guids.map((g) => { const e = m.byGuid.get(g); return e ? { ...plainElement(e), activities: (byGuid.get(g) ?? []).map((l) => ({ activity: code.get(l.task_id), role: l.role })) } : { guid: g, error: 'not in the model' }; }) };
    }
    case 'quantities': {
      const m = (await modelOf(s.db, projId, true, { geometry: true }))!;
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
      const kind = String(a.kind ?? 'volume') as QuantityKind;
      if (!['volume', 'area', 'length', 'count', 'weight', 'time'].includes(kind)) fail('bad_input', `Unknown kind "${a.kind}".`, 'Use volume, area, length, count, weight or time.');
      const units: Record<string, string> = { length: 'm', area: 'm²', volume: 'm³', count: 'no.', weight: 'kg', time: 's', ...m.index.units };
      type One = { name: string; kind: QuantityKind; source: 'base_quantity' | 'geometry' | 'property_set'; unit: string; value: number; set?: string };
      type Fig = One & { sets: Set<string>; elements: number };
      /** An element's figures: its derived volume, its authored quantities, its properties typed as measures. */
      const figuresOf = (e: Model['index']['elements'][number]): One[] => [
        ...(e.derivedVolumeM3 ? [{ name: 'derived volume', kind: 'volume' as const, source: 'geometry' as const, unit: 'm³', value: e.derivedVolumeM3 }] : []),
        ...Object.entries(e.authored).map(([q, v]) => { const i = e.quantityInfo?.[q]; const k = i?.kind ?? 'volume'; return { name: q, kind: k, source: 'base_quantity' as const, set: i?.set, unit: i?.unit ?? units[k], value: v }; }),
        ...Object.entries(e.measures ?? {}).filter(([p]) => typeof e.props[p] === 'number').map(([p, mm]) => ({ name: p, kind: mm.kind, source: 'property_set' as const, unit: mm.unit ?? units[mm.kind], value: e.props[p] as number })),
      ];
      const groups = new Map<string, { count: number; volume_m3: number; authored: Record<string, number>; unquantified: number; figures: Map<string, Fig> }>();
      for (const e of m.index.elements) {
        if (cls && !cls.some((c) => e.ifcClass.toLowerCase().startsWith(c))) continue;
        if (sts && !sts.includes(e.storey.toLowerCase())) continue;
        const figs = figuresOf(e), has = figs.some((f) => f.kind === kind && f.value > 0);
        for (const k of keyOf(e)) {
          const g = groups.get(k) ?? groups.set(k, { count: 0, volume_m3: 0, authored: {}, unquantified: 0, figures: new Map() }).get(k)!;
          g.count++; g.volume_m3 += e.derivedVolumeM3 ?? 0; if (!has) g.unquantified++;
          for (const [q, v] of Object.entries(e.authored)) g.authored[q] = (g.authored[q] ?? 0) + v;
          for (const f of figs) {
            const fk = `${f.source}|${f.name}|${f.unit}`, x = g.figures.get(fk) ?? g.figures.set(fk, { ...f, sets: new Set(), value: 0, elements: 0 }).get(fk)!;
            x.value += f.value; x.elements++; if (f.set) x.sets.add(f.set);
          }
        }
      }
      const r2 = (v: number) => Math.round(v * 1000) / 1000;
      const SRC = { geometry: 0, base_quantity: 1, property_set: 2 };
      // derived volumes come from the geometry: without it they are absent (null), said so, never a silent zero
      const noGeom = m.index.geometryStatus !== 'ok';
      return {
        group_by: by, geometry: m.index.geometryStatus, kind, units,
        ...(noGeom ? { derived_volume: `unavailable: ${m.index.geometryStatus === 'skipped' ? 'the model was opened with geometry: false (open_model again with geometry for volumes from the shapes)' : `the model's geometry did not build (${m.index.geometryNote ?? 'no reason given'})`}; volume_m3 is null and the authored quantities stand alone` } : {}),
        groups: [...groups].sort((x, y) => y[1].count - x[1].count).map(([k, g]) => ({
          group: k, count: g.count, volume_m3: noGeom ? null : r2(g.volume_m3), authored: Object.fromEntries(Object.entries(g.authored).map(([q, v]) => [q, r2(v)])),
          quantified: g.count - g.unquantified, unquantified: g.unquantified,
          figures: [...g.figures.values()].sort((x, y) => (x.kind === kind ? 0 : 1) - (y.kind === kind ? 0 : 1) || SRC[x.source] - SRC[y.source] || x.name.localeCompare(y.name))
            .map((f) => ({ name: f.name, kind: f.kind, value: r2(f.value), unit: f.unit, source: f.source, ...(f.sets.size ? { set: [...f.sets].join(', ') } : {}), elements: f.elements })),
        })),
      };
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
      const stem = basename(row?.path ?? code).replace(/\.(ifc|rvt|rfa|nwd|nwc|nwf)$/i, '');
      const written: string[] = [];
      const put = (file: string, data: string) => { const p = join(dir, file); h.writeOut(p, data); written.push(p); };
      // the model's IFC is streamed into the package (a model of any size: never one string); a Revit or Navisworks
      // model's is the IFC4 it was made into, whose GlobalIds the links hold
      const ifcPath = async () => { if (!row || !existsSync(row.path)) return fail('model_missing', `The model file ${row?.path ?? ''} is gone.`, 'Attach it again with open_model.'); return ifcOf(row.path); };
      if (target === 'csv') { const f = join(dir, `${code}-4d-links.csv`); linksCsvFile(s.db, projId, m?.index ?? null, f); written.push(f); return { target, written, activities: items.length }; }
      if (target === 'navisworks' || target === 'synchro') {
        const ifcOut = join(dir, `${stem}-4D.ifc`);
        const tagged = tagIfcFile(await ifcPath(), ifcOut, items);
        written.push(ifcOut);
        if (target === 'navisworks') { put(`${code}-4D-sets.xml`, searchSetsXml(items, code)); put('timeliner.csv', timelinerCsv(items)); }
        else { const p = join(dir, `${code}.xml`); h.writeOutWith(p, (w) => writeP6XmlTo(s.db, { projIds: [projId], version: '19.12' }, w)); written.push(p); } // as it is made (a big schedule)
        put('README.txt', README[target]);
        return { target, written, activities: items.length, elements_tagged: tagged.elements, key, planned: a.planned ?? 'current' };
      }
      try { const ifcOut = join(dir, `${stem}-4D-IFC4.ifc`); const r = ifc4dFile(s.db, projId, await ifcPath(), ifcOut, items, Array.isArray(a.baselines) ? a.baselines : []); written.push(ifcOut); put('README.txt', README.ifc4d); return { target, written, tasks: r.tasks, element_links: r.links }; }
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
        const chrome = chromiumPath();
        if (!chrome) note = 'No Chromium to render snapshots (the server’s P6CLONE_CHROMIUM is not set): render_4d kind viewer gives a page to look at.';
        else if (m.index.geometryStatus === 'unavailable') note = `The model has no 3D geometry, so there are no snapshots: ${m.index.geometryNote ?? 'its geometry did not build'}.`;
        else {
          const g = await modelWithTiles(s.db, projId, h.tick);
          const dir = pathArg(a.path ?? fail('bad_input', 'path (a folder) is needed for snapshots.', 'Pass path.'), 'path', 'write');
          mkdirSync(dir, { recursive: true });
          const page = writeViewer({ dir: mkdtempSync(join(tmpdir(), 'p6c4d-')), model: { tiles: g.tiles!, hash: g.hash, index: g.index }, timeline: viewerTimeline(s.db, projId, g.index, [source]), options: { left: source, interactive: false, view: a.view ?? 'iso', overlays: ['date', 'legend', 'activity_list'] }, title: 'snapshot', inlineScript: true, file: 'snapshot.html' })[0];
          let pngs: Buffer[];
          try { pngs = await inChromium(chrome, page, (ev) => renderPngs(ev, a.snapshots.map(String), (d, t, n) => h.tick(d, t, `snapshot ${n}`))); } catch (e) { if (e instanceof RenderFailed) return fail('render_failed', e.message, e.code ? `The browser could not hold the model (${e.code}): ${roomFor(e.code)}.` : 'Check the server’s P6CLONE_CHROMIUM (a Chromium or Chrome executable).', e.code ? { data: { reason: e.code } } : undefined); throw e; } finally { rmSync(dirname(page), { recursive: true, force: true }); }
          snapshots = pngs.map((png, i) => { const p = join(dir, `snapshot-${String(a.snapshots[i]).slice(0, 10)}.png`); h.writeOut(p, png); return p; });
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
      const kind = String(a.kind ?? 'viewer');
      if (!['viewer', 'images', 'video'].includes(kind)) fail('bad_input', `Unknown kind "${kind}".`, 'Use viewer, images or video.');
      // the full geometry, as display tiles (meshed now if the model was opened without geometry)
      const m = await modelWithTiles(s.db, projId, h.tick);
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
      mkdirSync(dir, { recursive: true }); // inside the write root (pathArg checked it)
      const title = `${options.title} 4D`;
      const model = { tiles: m.tiles!, hash: m.hash, index: m.index };
      const manifest = readManifest(m.tiles!)!;
      // images and video: standard (the full geometry, 1280x720), high (1920x1080) or draft (854x480, each element drawn
      // as its bounding box: quick on any machine); auto (the default) is standard unless that would take longer than
      // P6CLONE_RENDER_DRAFT_MINUTES (10) on this machine's renderer, then draft. The answer says which, and why
      const asked = String(a.quality ?? 'auto');
      if (!['auto', 'draft', 'standard', 'high'].includes(asked)) fail('bad_input', `Unknown quality "${asked}".`, 'Use auto, draft, standard or high.');
      const chrome = kind === 'viewer' ? null : chromiumPath();
      const renderer = chrome ? await probeRenderer(chrome) : null;
      const span = (() => { const f = parseP6Date(a.from ? String(a.from) : timeline.start ?? ''), t = parseP6Date(a.to ? String(a.to) : timeline.finish ?? ''); return f != null && t != null && t >= f ? t - f : 30 * 1440; })();
      const frames = Math.min(kind === 'images' ? 500 : 100_000, Math.floor(span / (options.step! * 1440)) + 1);
      const hd = asked === 'high' ? 1920 * 1080 : 1280 * 720;
      const fullMinutes = renderMinutes(renderer?.kind ?? 'software', manifest.triangles, frames, manifest.bytes, hd), boxTriangles = m.index.elements.length * 12;
      const draftMinutes = renderMinutes(renderer?.kind ?? 'software', boxTriangles, frames, 0, 854 * 480);
      const quality = asked !== 'auto' ? asked : a.boxes === true || fullMinutes <= draftLimitMinutes() ? 'standard' : 'draft';
      const boxes = a.boxes === true || quality === 'draft'; // a stand-in when asked for, or for a draft
      const about = (min: number) => (min < 1 ? 'under a minute' : `about ${Math.round(min)} minute${Math.round(min) === 1 ? '' : 's'}`);
      const where = renderer?.kind === 'gpu' ? `on this server's graphics card (${renderer.name})` : 'drawn by the processor (this server has no graphics card the browser can use)';
      const qualityNote = kind === 'viewer' ? undefined : quality === 'draft'
        ? `${asked === 'auto' ? `Draft quality was chosen because the full model would take ${about(fullMinutes)} to render ${where}` : 'Draft quality, as asked'}: 854x480, each element drawn as a simple box, so it renders in ${about(draftMinutes)}. Tell the user it is a quick preview by choice, not how their model really looks, so they do not take it for the model's quality; quality: "standard" gives the full detail (${about(fullMinutes)} here).`
        : fullMinutes > draftLimitMinutes() ? `Full detail, as asked: expect ${about(fullMinutes)} ${where}; quality: "draft" gives a quick preview in ${about(draftMinutes)}. Tell the user it will take a while, and why.` : undefined;
      const linked = timeline.elements.linked;
      const display = (() => { const t = readManifest(m.tiles!)!; return { tiles: t.tiles.length, mb: Math.round(t.bytes / 1048576), triangles: t.triangles, instances: t.instances, ...(boxes ? { boxes: true } : {}) }; })();
      const tooBig = (e: unknown) => { if (e instanceof EmbedTooBig) return fail('too_big_to_embed', e.message, 'Leave embed out: the viewer is written as a page with the model\u2019s tiles in a folder beside it (served together).'); throw e; };
      if (kind === 'viewer') { let written: string[]; try { written = writeViewer({ dir, model, timeline, options, title, embed: a.embed === true, boxes, file: `${options.title}-4D.html` }); } catch (e) { return tooBig(e); } return { kind, written, activities: timeline.activities.length, linked_elements: linked, display, hooks: 'WHIQ4D_EXPORT (started, status, ready, max, setStep, frame) and P6C4D_API (ready, status, setDate, setSource, highlight, encode, png)' }; }
      const [w0, h0] = quality === 'draft' ? [854, 480] : quality === 'high' ? [1920, 1080] : [1280, 720];
      const width = Math.min(3840, Number(a.width) || w0), height = Math.min(2160, Number(a.height) || h0);
      const how = { quality, ...(qualityNote ? { quality_note: qualityNote } : {}), estimated_minutes: Math.round((quality === 'draft' ? draftMinutes : fullMinutes) * 10) / 10, ...(renderer ? { renderer } : {}) };
      // fps below 1 holds each frame longer (0.25 = 4 s a frame)
      const fps = a.seconds_per_frame != null ? 1 / Math.min(60, Math.max(1 / 60, Number(a.seconds_per_frame) || 0.25)) : Math.min(60, Math.max(1 / 60, Number(a.fps) || 4));
      const format = a.format === 'webm' ? 'webm' : 'mp4';
      const name = a.file_name ? basename(String(a.file_name)).replace(/\.(mp4|webm)$/i, '') : `${options.title}-4D`;
      // the render page: the viewer script inside it (it is served alone), the model inline when small enough (a page
      // that needs nothing else), else its tiles in model-<hash>/ beside it (docs/4d-tiles-contract.md)
      const small = (readManifest(m.tiles!)?.bytes ?? Infinity) <= embedMaxBytes();
      // with a Chromium here the page is only the render's means: written apart, gone after; without one it is what the
      // client route renders, so it goes to the outputs (the platform serves it from there)
      const pageDir = chrome ? mkdtempSync(join(tmpdir(), 'p6c4d-render-')) : dir;
      const pageFiles = writeViewer({ dir: pageDir, model, timeline, options, title, embed: small || boxes, inlineScript: true, boxes, file: `${options.title}-4D-render.html` });
      const page = pageFiles[0];
      try {
      if (!chrome) return { kind, rendered: false, ...how, viewer: page, ...(pageFiles.length > 1 ? { written: pageFiles } : {}), display, client_render: { artifact: page, hooks: 'WHIQ4D_EXPORT', step: options.step, width, height, ...(pageFiles.length > 1 ? { model_folder: dirname(pageFiles[1]), files: pageFiles.slice(1), contract: 'docs/4d-tiles-contract.md (p6c-4d-tiles v1)' } : {}) }, note: `No Chromium here (the server’s P6CLONE_CHROMIUM is not set), so nothing was rendered: the viewer page is written${pageFiles.length > 1 ? ' with the model\u2019s tiles in a folder beside it' : ' (self-contained)'}; render it on a GPU with the WHIQ4D_EXPORT hooks (the platform\u2019s client render) or the desktop app (Extensions > 4D > Video), or call P6C4D_API.encode() in a browser.` };
      if (m.index.elements.length > 200_000) compactHeap(); // the timeline's garbage goes before the browser takes its memory
      await h.tick(0, 1, `loading the model (${display.mb} MB in ${display.tiles} tiles) in Chromium`);
      const failed = (e: unknown) => { if (e instanceof RenderFailed) return fail('render_failed', e.message, e.code ? `The browser could not hold the model (${e.code}): ${roomFor(e.code)}${boxes ? '' : ', or ask for boxes: true (each element drawn as its bounding box)'}.` : 'Check the server’s P6CLONE_CHROMIUM (a Chromium or Chrome executable), or render on a GPU with the client_render route.', e.code ? { data: { reason: e.code } } : undefined); throw e; };
      const onLoad = (d: number, t: number) => h.tick(d, Math.max(1, t), `loading tile ${d} of ${t} in Chromium`);
      // the graphics card when the probe found one; a render it could not finish (its memory, its driver) goes again
      // with the processor drawing, once, and the answer says so
      let fellBack: Renderer | null = null;
      const onRenderer = async <T>(run: (gpu: boolean) => Promise<T>): Promise<T> => {
        if (renderer?.kind !== 'gpu') return run(false);
        try { return await run(true); } catch (e) {
          if (!(e instanceof RenderFailed)) throw e;
          fellBack = { kind: 'software', name: `SwiftShader, after the graphics card could not finish: ${e.message.slice(0, 160)}` };
          await h.tick(0, 1, 'the graphics card could not finish the render: drawing it with the processor');
          return run(false);
        }
      };
      const timeoutMs = 120 * 60_000;
      const what = `the model: ${display.tiles} tiles, ${display.mb} MB, ${display.triangles.toLocaleString('en-US')} triangles`;
      if (kind === 'images') {
        const from = parseP6Date(a.from ? String(a.from) : timeline.start ?? '')!, to = parseP6Date(a.to ? String(a.to) : timeline.finish ?? '')!;
        const dates: string[] = []; for (let d = from; d <= to && dates.length < 500; d += options.step! * 1440) dates.push(formatP6Date(d));
        let pngs: Buffer[];
        try { pngs = await onRenderer((gpu) => inChromium(chrome, page, (ev) => renderPngs(ev, dates, h.tick), { width, height, onLoad, timeoutMs, what, gpu })); } catch (e) { return failed(e); }
        return { kind, rendered: true, ...how, ...(fellBack ? { renderer: fellBack } : {}), display, written: pngs.map((png, i) => { const p = join(dir, `${name}-${String(i).padStart(4, '0')}-${dates[i].slice(0, 10)}.png`); h.writeOut(p, png); return p; }) };
      }
      let v: { mime: string; frames: number; bytes: Buffer };
      try { v = await onRenderer((gpu) => inChromium(chrome, page, (ev) => renderVideo(ev, { from: a.from, to: a.to, step: options.step, fps, width, height, ...(format === 'webm' || process.env.P6CLONE_RECORD_WEBM === '1' ? { codec: 'vp9' } : {}) }, h.tick), { width, height, onLoad, timeoutMs, what, gpu })); } catch (e) { return failed(e); }
      let note: string | undefined;
      // MP4 everywhere: a browser without an H.264 encoder (Chromium for Testing) records WebM, which ffmpeg turns into MP4
      if (format === 'mp4' && !v.mime.includes('mp4')) {
        if (ffmpegPath()) await h.tick(1, 1, 'converting the WebM to MP4'); // without ffmpeg there is nothing to convert with
        const mp4 = await webmToMp4(v.bytes).catch((e) => { note = `The WebM could not be converted: ${(e as Error).message}`; return null; });
        if (mp4) v = { mime: 'video/mp4', frames: v.frames, bytes: mp4 };
        else note ??= ffmpegPath() ? undefined : 'This Chromium has no H.264 encoder and the server has no ffmpeg (P6CLONE_FFMPEG), so the video is WebM. Set P6CLONE_FFMPEG for MP4.';
      }
      const file = join(dir, `${name}.${v.mime.includes('mp4') ? 'mp4' : 'webm'}`);
      h.writeOut(file, v.bytes);
      return { kind, rendered: true, ...how, ...(fellBack ? { renderer: fellBack } : {}), written: [file], frames: v.frames, mime: v.mime, fps, size: [width, height], display, ...(note ? { note } : {}) };
      } finally { if (chrome) rmSync(pageDir, { recursive: true, force: true }); }
    }
    case 'relink_model': {
      const old = (await modelOf(s.db, projId, true, { geometry: true }))!;
      const path = pathArg(a.path);
      let m: Model;
      try { m = await readModel(path); } catch (e) { if (['memory_budget', 'model_too_large'].includes((e as { code?: string }).code ?? '')) throw e; return fail('model_unreadable', `Cannot read the model: ${(e as Error).message}`, unreadableHint(path)); }
      await h.tick(1, 2, 'model parsed');
      const linkedGuids = new Set(rows(s.db, T4D.link).filter((r) => r.proj_id === projId).map((r) => r.guid));
      const plan = relinkPlan(old.index, m.index, linkedGuids, a.tolerance_m != null ? Number(a.tolerance_m) : undefined);
      const diff = diffIndexes(old.index, m.index);
      const report = { model: basename(path), linked_elements: linkedGuids.size, kept: plan.kept, matched: plan.matched.length, by_name_and_storey: plan.matched.filter((x) => x.how === 'name+storey').length, by_shape: plan.matched.filter((x) => x.how === 'shape').length, lost: plan.lost.length, lost_elements: plan.lost.slice(0, 200), matched_examples: plan.matched.slice(0, 50), model_diff: diff.summary };
      if (a.dry_run === true) return { ...report, dry_run: true };
      h.apply(`Relink to ${basename(path)}`, (d) => {
        const T = t4d(d, T4D.link);
        T.rows = T.rows.flatMap((r) => { if (r.proj_id !== projId) return [r]; const to = plan.mapping.get(r.guid); return to ? [{ ...r, guid: to }] : []; });
        for (const tbl of [T4D.status]) { const X = t4d(d, tbl); X.rows = X.rows.flatMap((r) => { if (r.proj_id !== projId) return [r]; const to = plan.mapping.get(r.guid); return to ? [{ ...r, guid: to }] : []; }); }
        attachModel(d, projId, m.index, m.hash);
      });
      return { ...report, dry_run: false };
    }
    case 'synchro_cloud': return runSynchroCloud(s.db, projId, a, h.tick);
    case 'import_4d': {
      const path = pathArg(a.path);
      // the file is read whole, with its text and what is read from it: counted in the budget while it is held (C16);
      // past the longest string a JavaScript engine holds (about 512 MB) an IFC or CSV cannot be read as text at all
      const size = (() => { try { return statSync(path).size; } catch { return -1; } })();
      if (size < 0) return fail('file_unreadable', `Cannot read ${path}.`, 'Check the path.');
      if (size > 0x1fffffe8 && !/\.(nwf|nwd|sp|xlsx)$/i.test(path)) return fail('too_large', `${basename(path)} is ${Math.round(size / 1048576)} MB: more text than one string can hold (about 512 MB), so it cannot be read as a 4D file.`, 'Export the 4D data on its own (the links or the TimeLiner list, without the model geometry), or split it.');
      const releaseRead = reserveMemory(size * 4 + 8 * 1048576, `Reading ${basename(path)} (${Math.round(size / 1048576)} MB) for import_4d`, 'export the 4D data on its own (without the model geometry), or split it', s.handle);
      let bytes: Uint8Array;
      let imp: Imported4d;
      try {
      try { bytes = new Uint8Array(readFileSync(path)); } catch { return fail('file_unreadable', `Cannot read ${path}.`, 'Check the path.'); }
      try { imp = await readImport4d(path, bytes); } catch (e) { return fail('bad_input', `Cannot read ${basename(path)} as 4D: ${(e as Error).message}`, 'Give an IFC 4D, search-set XML, TimeLiner CSV/xlsx, Navisworks .nwf/.nwd or SYNCHRO .sp file.'); }
      const tasksOnly = imp.source === 'timeliner_csv' || imp.source === 'nwf' || imp.source === 'nwd';
      const m = await modelOf(s.db, projId, !tasksOnly);
      const plan = planImport4d(s.db, projId, imp, m?.index ?? null, { createActivities: a.create_activities === true });
      const summary = { source: imp.source, tasks: imp.tasks.length, matched_activities: plan.matched.size, activities_with_links: new Set(plan.proposals.map((p) => p.activity)).size, unmatched_tasks: plan.unmatchedTasks.slice(0, 100), proposed_links: plan.proposals.reduce((n, p) => n + p.guids.length, 0), ...(plan.elementsNotInModel ? { elements_not_in_model: plan.elementsNotInModel } : {}), ...(plan.sets.length ? { sets: plan.sets.map((x) => ({ name: x.name, elements: x.guids.length })) } : {}), ...(tasksOnly ? { attached_sets: plan.attachedSets } : {}), notes: imp.notes };
      // a dry run is also the review of the other tool's schedule: its tasks as that tool holds them
      const setSize = new Map(plan.sets.map((x) => [x.name, x.guids.length]));
      const taskList = imp.tasks.slice(0, 300).map((t) => ({ name: t.name, ...(t.id !== t.name ? { id: t.id } : {}), start: t.start ?? null, finish: t.finish ?? null, ...(t.actualStart || t.actualFinish ? { actual_start: t.actualStart ?? null, actual_finish: t.actualFinish ?? null } : {}), ...(t.type ? { type: t.type } : {}), ...(t.attached ? { attached: t.attached, elements: setSize.get(t.attached) ?? null } : {}) }));
      if (a.link === false) return { ...summary, linked: false, task_list: taskList, ...(imp.tasks.length > taskList.length ? { task_list_truncated: imp.tasks.length - taskList.length } : {}), ...(plan.toCreate.length ? { would_create: plan.toCreate.map((t) => t.name) } : {}) };
      // an activity the edit refuses (a bad name, a clash) refuses the whole import
      const applied = h.apply(`Import 4D ${basename(path)}`, (d) => { try { return applyImport4d(d, projId, plan, m?.index ?? null, { source: basename(path), hoursPerDay: s.hpd, calendarDays: true }); } catch (e) { return fail('bad_input', `Not imported: ${(e as Error).message}`, 'Fix the task in the other tool, or import with create_activities: false.'); } });
      return { ...summary, linked: true, ...applied };
      } finally { releaseRead(); }
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
