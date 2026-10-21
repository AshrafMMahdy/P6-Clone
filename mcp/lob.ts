// LOB tools of the MCP server: a location-based plan as its own project in the same file as the CPM projects (it
// travels in the XER: a project UDF flag and a notebook real P6 keeps), built and changed in small calls on the handle.
// The model is the source of the plan's structure; its activities and logic are ordinary P6 data, scheduled with
// everything else (continuity on top). Kept apart from server.ts.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { rows, type Db, type Row } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { LobRefused, type LobModel } from '../core/lob/model.ts';
import { applyLobOps, buildLocations, type LobOp } from '../core/lob/input.ts';
import { expandLob } from '../core/lob/expand.ts';
import { scheduleLob } from '../core/lob/pace.ts';
import { isLobProject, loadLobModels, reconcile, saveLobOps } from '../core/lob/store.ts';
import { lobView } from '../core/lob/view.ts';
import { flowlineSvg } from '../core/lob/svg.ts';
import { taktApply, taktCheck } from '../core/lob/takt.ts';
import { forecastLob } from '../core/lob/forecast.ts';
import { readVicoDpp } from '../core/lob/vico.ts';
import { lobFromVico, vicoCalendarOp } from '../core/lob/fromVico.ts';
import { readTactplan, writeTactplan } from '../core/lob/tactplan.ts';
import { effectiveBudget, fail, pathArg, type Session } from './runtime.ts';
import type { AnalysisHelpers } from './analysis.ts';

const ro = { readOnlyHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'the LOB project (Project ID; default the file’s only LOB project)' };
const obj = { type: 'object' }, arr = (items: object = obj) => ({ type: 'array', items });
const TASK_HELP = 'A task: {code, name, trade?, level? (name or number; default the deepest), locations? (in working order; default every location of its level), unit?, consumption (hours per unit), quantity (every location) or quantities {location: qty}, crew_size, crews?, productivity?, driver? (crew | rate | duration: what is held when another value changes), rate?, duration_days?, timing? (asap | paced | asap_paced, default asap_paced: the crew never waits)}.';
const OPS_HELP = 'Operations, applied in order (one refused refuses all): set_crew {task, segment?, crews?, crew_size?, productivity?}, set_rate {task, segment?, rate}, set_duration {task, segment?, days, crew_follows?} (under the crew driver refused unless crew_follows: true, which sizes the crew to it), set_driver {task, segment?, driver}, set_timing {task, segment?, timing}, set_quantity {task, item?, location, quantity}, set_consumption {task, item?, consumption}, set_location_duration {task, location, days} (sets its production factor), set_factor {task, location, factor}, split {task, at: location} (the locations from there get their own crew), merge {task, at}, set_start {task, segment?, date | null} (a manual start), add_location {code, name?, parent?, after?}, remove_location {code}, add_task {...task}, remove_task {task}, set_order {task, order}, add_link {pred, succ, type?, lag_days?, location_lag? (+n: the successor in a location waits for the predecessor n locations further on, e.g. +1: the floor above done first; the last n wait for its last location), buffer_days?, buffer_locations?, precision? (level number), pred_location?, succ_location? (one location to another), project? (the other end is an activity of that project: CPM or another LOB plan)}, remove_link {pred, succ}, set_takt {takt_days, zone_level?, zones?, train?, buffer_periods?}, rename {task, name?, trade?} | {task, item, name?, unit?} | {location, name} | {level (number or name), name} (names only: codes are the activity IDs; the activities and Location / Trade codes follow, the old trade value goes). A refused edit says which value is held by the task’s driver.';

export const LOB_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'lob_create', annotations: edit, description: `Create a location-based (Line of Balance) plan as a new project in this file, beside its CPM projects; it schedules with them and travels in the XER (real P6 reads it as an ordinary, fully linked project). id, name?, start (YYYY-MM-DD), calendar?, locations: {levels: [names, top first], grid: [count per level] (codes P1, P1F2...) | tree: [{code, name, children}] | list: [{code, name, level, parent}]}, tasks: [task], links?: [add_link fields], takt?: {takt_days, ...}. ${TASK_HELP} Or from_cpm: {project, location_code, trade_code}: a new LOB project from a CPM project's activities grouped by two activity code types (the CPM project stays as it was, to compare); dry_run: true shows the grouping. Answers the plan as lob_view does.`, inputSchema: withHandle({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, start: { type: 'string' }, calendar: { type: 'string' }, locations: obj, tasks: arr(), links: arr(), takt: obj, from_cpm: obj, dry_run: { type: 'boolean' } }, required: ['id'] }) },
  { name: 'lob_edit', annotations: edit, description: `Change an LOB plan. ${OPS_HELP} One undoable change: the plan is expanded into its activities and logic, saved into the file and scheduled. Answers changes (every value that moved, old → new: nothing changes silently), notes, and the schedule (finish, trades that could not be paced).`, inputSchema: withHandle({ type: 'object', properties: { project, operations: arr() }, required: ['operations'] }) },
  { name: 'lob_view', annotations: ro, description: 'An LOB plan as scheduled: each trade with its segments (crew, driver, timing, rate), dates and float, and its locations [location, start, finish, float days]; the critical trades; collisions (two trades in a location at the same time); gaps (a crew waiting between locations); and anything changed outside the clone (reconcile). svg: a path to write the flowline picture to. limit (default 200) per list.', inputSchema: withHandle({ type: 'object', properties: { project, limit: { type: 'number' }, svg: { type: 'string' } } }) },
  { name: 'lob_takt', annotations: edit, description: 'Takt on an LOB plan (set_takt first, with lob_edit). Without apply: the balance check, each trade × zone that does not fit the takt and what would make it fit (read only). apply: true sizes the crews to fit, holds every zone to one takt period, paces the trades and links them as a train with the buffer periods; one undoable change, every value that moved listed.', inputSchema: withHandle({ type: 'object', properties: { project, apply: { type: 'boolean' } } }) },
  { name: 'lob_forecast', annotations: ro, description: 'Control: each trade forecast at the rate it actually achieved over the last window_days (default 21: actual against planned days of the locations finished then, else all finished), with its planned crew; and alarms where a predecessor’s forecast runs into a successor’s planned start (lag counted, buffers absorbed), nearest first with the working days left to react. The plan is not changed.', inputSchema: withHandle({ type: 'object', properties: { project, window_days: { type: 'number' } } }) },
  { name: 'lob_import', annotations: edit, description: 'Bring an LOB plan from another tool into this file as a new project: a Vico Schedule Planner / Vico Control project (.dpp: locations, tasks, quantities, consumption, crews, each line with its start, the calendar; Vico files seen so far carry no logic, and the notes say so), or a Tactplan export (a folder of its Locations, Grid and Quantities CSVs). id: the new Project ID.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, id: { type: 'string' } }, required: ['path'] }) },
  { name: 'lob_export', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: 'Write an LOB plan for Tactplan: a folder with Locations.csv, Grid.csv (a column per location, the durations), Quantities.csv and links-not-exported.txt (Tactplan has no import for links: re-enter them there). decimal: dot | comma, date: dd/MM/yyyy | MM/d/yyyy | d/MM/yyyy | yyyy/MM/dd.', inputSchema: withHandle({ type: 'object', properties: { project, path: { type: 'string' }, decimal: { type: 'string' }, date: { type: 'string' } }, required: ['path'] }) },
];
export const LOB_NAMES = new Set(['lob_create', 'lob_edit', 'lob_view', 'lob_takt', 'lob_forecast', 'lob_import', 'lob_export']);
export const LOB_FILES: Record<string, { read: string[]; opens: boolean }> = { lob_import: { read: ['path'], opens: false } };

/** The .lob.json beside an opened file (the models as last saved), by handle. */
export const lobSidecars = new Map<string, Record<string, LobModel>>();
export function readLobSidecar(path: string): Record<string, LobModel> | undefined {
  const p = `${path}.lob.json`;
  if (!existsSync(p)) return undefined;
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return j?.format === 'p6clone-lob' ? j.projects : undefined; } catch { return undefined; }
}
export function lobSidecarText(db: Db, projIds: string[]): string | null {
  const projects: Record<string, LobModel> = {};
  for (const [pid, x] of loadLobModels(db)) if (projIds.includes(pid)) projects[rows(db, 'PROJECT').find((p) => p.proj_id === pid)!.proj_short_name] = x.model;
  return Object.keys(projects).length ? JSON.stringify({ format: 'p6clone-lob', version: 1, projects }, null, 1) : null;
}

/** F9 for the file, with continuity on its LOB projects (used by schedule and update_progress as well). */
export function scheduleWithLob(d: Db, ids: string[], hpd: number, options: Parameters<typeof scheduleProjects>[2] = {}, sidecar?: Record<string, LobModel>) {
  const models = new Map([...loadLobModels(d, sidecar)].filter(([pid]) => ids.includes(pid)).map(([pid, x]) => [pid, x.model]));
  if (!models.size) return { schedule: scheduleProjects(d, ids, options), unpaced: [] as string[] };
  const r = scheduleLob(d, ids, models, { hoursPerDay: hpd, options });
  return { schedule: r.schedule ?? scheduleProjects(d, ids, options), unpaced: r.unpaced, ...(r.error ? { error: r.error } : {}) };
}

export async function runLob(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers): Promise<unknown> {
  if (!LOB_NAMES.has(name)) return undefined;
  const side = () => lobSidecars.get(s.handle);
  const lobOf = (code?: string) => {
    const all = loadLobModels(s.db, side());
    if (code) { const pid = h.projectIds(s.db, code)[0]; const x = all.get(pid) ?? fail('not_lob', `${code} is not an LOB project.`, 'lob_create makes one; lob_view lists the plan of an LOB project.'); return { projId: pid, ...x }; }
    if (all.size !== 1) fail('bad_input', all.size ? `The file holds ${all.size} LOB projects; say which with project.` : 'The file holds no LOB project.', all.size ? 'Pass project (its Project ID).' : 'lob_create (or lob_import) makes one.');
    const [projId, x] = [...all][0];
    return { projId, ...x };
  };
  /** Expand, save into the file and schedule, inside one change. */
  const commit = async (d: Db, projId: string, m: LobModel, previous: LobModel | null) => {
    // in steps, each a yield (server_status and cancel_job answer between them; cancelled: nothing is kept, L-3)
    await h.tick(0, 3, 'expanding the plan into activities and logic');
    const ex = expandLob(d, projId, m, { hoursPerDay: s.hpd, previous });
    if (!ex.ok) throw new LobRefused(ex.error!);
    await h.tick(1, 3, 'saving the plan into the file');
    const sv = applyOps(d, saveLobOps(d, projId, m), { hoursPerDay: s.hpd });
    if (!sv.ok) throw new LobRefused(sv.error!.message);
    await h.tick(2, 3, 'scheduling (F9, crews kept continuous)');
    const sc = scheduleWithLob(d, h.allIds(d), s.hpd, {}, undefined);
    if (!sc.schedule.ok) throw new LobRefused(`the plan cannot be scheduled: ${sc.schedule.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ')}`);
    const fin = sc.schedule.projects[projId]?.finish;
    return { activities: { added: ex.added, updated: ex.updated, deleted: ex.deleted, ...(ex.keptWithProgress.length ? { kept_with_progress: ex.keptWithProgress } : {}) }, schedule: { finish: fin != null ? new Date(fin * 60000).toISOString().slice(0, 16).replace('T', ' ') : null, ...(sc.unpaced.length ? { unpaced: sc.unpaced, note: 'continuity fights the logic for these trades: they were left as soon as possible' } : {}) } };
  };
  const refused = (e: unknown) => { if (e instanceof LobRefused) return fail('lob_refused', e.message, 'Change the operation (the message says what holds it) and send it again; nothing was changed.'); throw e; };
  const view = (projId: string, m: LobModel, limit?: number) => ({ project: rows(s.db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name, ...lobView(s.db, projId, m, { hoursPerDay: s.hpd, limit }) });

  switch (name) {
    case 'lob_create': {
      const id = String(a.id ?? '') || fail('bad_input', 'Give id (the new Project ID).', 'e.g. {"id": "TOWER-LOB"}');
      if (rows(s.db, 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase())) fail('bad_input', `A project ${id} is already in the file.`, 'Give another id.');
      let model: LobModel;
      if (a.from_cpm) {
        const plan = fromCpm(s.db, h.projectIds(s.db, String(a.from_cpm.project))[0], String(a.from_cpm.location_code ?? ''), String(a.from_cpm.trade_code ?? ''), id, s.hpd);
        if (a.dry_run === true) return { dry_run: true, tasks: plan.model.tasks.map((t) => ({ code: t.code, locations: t.order.length })), locations: plan.model.locations.length, links: plan.model.links.length, ungrouped: plan.ungrouped };
        model = plan.model;
      } else {
        try { model = { version: 1, project: id, levels: a.locations?.levels ?? [], locations: buildLocations(a.locations ?? {}), tasks: [], links: [] }; }
        catch (e) { return refused(e); }
      }
      const start = a.start ?? rows(s.db, 'PROJECT').find((p) => !p._baseline_of)?.plan_start_date?.slice(0, 10) ?? fail('bad_input', 'Give start (YYYY-MM-DD).', 'The plan’s start date.');
      return h.applyAsync(`LOB plan ${id}`, async (d) => {
        const r = applyOps(d, [{ op: 'add_project', id, name: a.name ?? id, start, ...(a.calendar ? { calendar: a.calendar } : {}) }], { hoursPerDay: s.hpd });
        if (!r.ok) fail('bad_input', r.error!.message, 'Check id, start and calendar.');
        const projId = rows(d, 'PROJECT').find((p) => p.proj_short_name === id)!.proj_id;
        try {
          const ops: LobOp[] = [...(a.from_cpm ? [] : (a.tasks ?? []).map((t: object) => ({ op: 'add_task', ...t }))), ...(a.links ?? []).map((l: object) => ({ op: 'add_link', ...l })), ...(a.takt ? [{ op: 'set_takt', ...a.takt }] : [])];
          const built = ops.length ? applyLobOps(model, ops) : { model, changes: [], notes: [] };
          const c = await commit(d, projId, built.model, null);
          return { created: id, ...c, notes: built.notes };
        } catch (e) { return refused(e); }
      });
    }
    case 'lob_edit': {
      const { projId, model } = lobOf(a.project);
      if (!Array.isArray(a.operations) || !a.operations.length) fail('bad_input', 'operations: a list of operations.', OPS_HELP);
      let next;
      try { next = applyLobOps(model, a.operations); } catch (e) { return refused(e); }
      return h.applyAsync(`LOB edit (${a.operations.length} operation${a.operations.length === 1 ? '' : 's'})`, async (d) => { try { return { changes: next.changes, notes: next.notes, ...(await commit(d, projId, next.model, model)) }; } catch (e) { return refused(e); } });
    }
    case 'lob_view': {
      const { projId, model, from, problems } = lobOf(a.project);
      const v = view(projId, model, a.limit);
      const outside = reconcile(s.db, projId, model, { hoursPerDay: s.hpd });
      let written: string | undefined;
      if (a.svg) { written = pathArg(a.svg, 'svg', 'write'); h.writeOut(written, flowlineSvg(s.db, projId, model, { critical: v.critical, title: `${v.project}: flowline` })); }
      return { ...v, ...(from !== 'notebook' ? { model_from: from, problems } : {}), ...(outside.length ? { changed_outside: outside } : {}), ...(written ? { svg: written } : {}) };
    }
    case 'lob_takt': {
      const { projId, model } = lobOf(a.project);
      if (!model.takt) fail('bad_input', 'No takt is set on this plan.', 'lob_edit {"operations": [{"op": "set_takt", "takt_days": 5}]} first.');
      if (a.apply !== true) return taktCheck(model);
      const r = taktApply(model);
      return h.applyAsync('LOB takt', async (d) => { try { return { changes: r.changes, ...(await commit(d, projId, r.model, model)) }; } catch (e) { return refused(e); } });
    }
    case 'lob_forecast': { const { projId, model } = lobOf(a.project); return forecastLob(s.db, projId, model, { hoursPerDay: s.hpd, windowDays: a.window_days }); }
    case 'lob_import': {
      const path = pathArg(a.path);
      const id = String(a.id ?? '') || basename(path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 20).toUpperCase();
      if (rows(s.db, 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase())) fail('bad_input', `A project ${id} is already in the file.`, 'Pass id.');
      let model: LobModel, start: string, calOps: unknown[] = [], notes: string[] = [], hpd = s.hpd;
      if (/\.dpp$/i.test(path)) {
        let v;
        try { v = readVicoDpp(new Uint8Array(readFileSync(path)), { maxBytes: Math.min(256 * 1048576, effectiveBudget() / 8) }); } catch (e) { return fail('bad_input', (e as Error).message, 'Give a Vico Schedule Planner .dpp file.'); }
        const r = lobFromVico(v, id);
        model = r.model; notes = r.notes; hpd = r.hoursPerDay;
        start = v.start ?? model.tasks.flatMap((t) => t.segments.map((g) => g.start ?? '')).filter(Boolean).sort()[0] ?? new Date().toISOString().slice(0, 10);
        if (r.calendar) { const name = `${id} (Vico)`; calOps = [vicoCalendarOp(r.calendar, name, [Number(start.slice(0, 4)) - 1, Number(start.slice(0, 4)) + 5])]; for (const t of model.tasks) t.calendar = name; }
      } else {
        let r;
        try { r = readTactplan(path); } catch (e) { return fail('bad_input', (e as Error).message, 'Give a Tactplan export: the folder holding its Grid.csv (and Locations.csv, Quantities.csv), or the Grid.csv itself; or a Vico .dpp.'); }
        model = { ...r.model, project: id }; notes = r.notes; start = r.start ?? new Date().toISOString().slice(0, 10);
      }
      return h.applyAsync(`LOB import ${basename(path)}`, async (d) => {
        const cal = calOps.length ? (calOps[0] as { name: string }).name : undefined;
        const r = applyOps(d, [...calOps, { op: 'add_project', id, name: model.project === id ? id : id, start, ...(cal ? { calendar: cal } : {}) }], { hoursPerDay: hpd });
        if (!r.ok) fail('bad_input', r.error!.message, '');
        const projId = rows(d, 'PROJECT').find((p) => p.proj_short_name === id)!.proj_id;
        try { return { imported: id, tasks: model.tasks.length, locations: model.locations.length, ...(await commit(d, projId, model, null)), notes }; } catch (e) { return refused(e); }
      });
    }
    case 'lob_export': {
      const { projId, model } = lobOf(a.project);
      const dir = pathArg(a.path, 'path', 'write');
      mkdirSync(dir, { recursive: true }); // inside the write root (pathArg checked it)
      const files = writeTactplan(model, { decimal: a.decimal === 'comma' ? 'comma' : 'dot', date: a.date ?? 'dd/MM/yyyy', scheduled: lobView(s.db, projId, model, { hoursPerDay: s.hpd, limit: Infinity }).tasks });
      const written = files.map((f) => { const p = join(dir, f.name); h.writeOut(p, f.text); return p; });
      return { written, note: 'Tactplan imports each grid from its Import dialog (paste or choose the file); links between tasks have no import there: links-not-exported.txt lists them.' };
    }
  }
  return undefined;
}

/** A CPM project's activities grouped into an LOB plan by a location code and a trade code. */
function fromCpm(db: Db, projId: string, locType: string, tradeType: string, id: string, hpd: number): { model: LobModel; ungrouped: number } {
  const type = (n: string) => rows(db, 'ACTVTYPE').find((t) => t.actv_code_type.toLowerCase() === n.toLowerCase()) ?? fail('bad_input', `No activity code type "${n}".`, 'Give the names of the location code and the trade code (list_dictionaries shows them).');
  const lt = type(locType), tt = type(tradeType);
  const codes = new Map(rows(db, 'ACTVCODE').map((c) => [c.actv_code_id, c]));
  const of = (taskId: string, t: Row) => rows(db, 'TASKACTV').filter((x) => x.task_id === taskId && x.actv_code_type_id === t.actv_code_type_id).map((x) => codes.get(x.actv_code_id)).find(Boolean);
  const acts = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS').sort((a, b) => (a.early_start_date || '').localeCompare(b.early_start_date || ''));
  const used = new Map<string, Row>();
  const tasks = new Map<string, LobModel['tasks'][number]>();
  const where = new Map<string, [string, string]>();
  let ungrouped = 0;
  for (const a of acts) {
    const loc = of(a.task_id, lt), tr = of(a.task_id, tt);
    if (!loc || !tr) { ungrouped++; continue; }
    for (let c: typeof loc | undefined = loc; c; c = codes.get(c.parent_actv_code_id)) used.set(c.actv_code_id, c);
    const t = tasks.get(tr.short_name) ?? tasks.set(tr.short_name, { code: tr.short_name.replace(/[^A-Za-z0-9]+/g, '').slice(0, 12) || 'T', name: tr.actv_code_name || tr.short_name, trade: tr.short_name, precision: 0, order: [], items: [{ name: tr.actv_code_name || tr.short_name, unit: 'h', consumption: 1, quantities: [] }], segments: [] }).get(tr.short_name)!;
    if (t.order.includes(loc.short_name)) continue;
    t.order.push(loc.short_name);
    // the CPM duration kept: one person-hour per hour on a crew of one
    t.items[0].quantities.push({ location: loc.short_name, quantity: Number(a.target_drtn_hr_cnt || 0) });
    where.set(a.task_id, [t.code, loc.short_name]);
  }
  const depth = (c: Row): number => { let d = 1; for (let p = used.get(c.parent_actv_code_id); p; p = used.get(p.parent_actv_code_id)) d++; return d; };
  const locations = [...used.values()].map((c) => ({ code: c.short_name, name: c.actv_code_name || c.short_name, level: depth(c), parent: used.get(c.parent_actv_code_id)?.short_name ?? null }));
  const levelOf = new Map(locations.map((l) => [l.code, l.level]));
  for (const t of tasks.values()) { t.precision = Math.max(...t.order.map((c) => levelOf.get(c) ?? 1)); t.order = t.order.filter((c) => levelOf.get(c) === t.precision); t.segments = [{ from: t.order[0], to: t.order.at(-1)!, crews: 1, crewSize: 1, productivity: 1, driver: 'crew', timing: 'asap', }]; t.hoursPerDay = hpd; }
  // trade-to-trade logic from the CPM relationships between them (one link per pair of trades)
  const links = new Map<string, LobModel['links'][number]>();
  for (const r of rows(db, 'TASKPRED')) { const p = where.get(r.pred_task_id), q = where.get(r.task_id); if (p && q && p[0] !== q[0]) links.set(`${p[0]}>${q[0]}`, { kind: 'task', pred: p[0], succ: q[0], type: 'FS', lagDays: 0 }); }
  const levels = [...Array(Math.max(1, ...locations.map((l) => l.level))).keys()].map((k) => `Level ${k + 1}`);
  return { model: { version: 1, project: id, levels, locations, tasks: [...tasks.values()].map((t) => ({ ...t, code: t.code })), links: [...links.values()] }, ungrouped };
}

export { isLobProject };
