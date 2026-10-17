#!/usr/bin/env node
// P6 Clone MCP server (stdio): a headless Primavera P6 for AI agents. Projects stay open in memory between calls
// (a 70 MB XER is read once, then edited, scheduled and reviewed many times), every change can be undone, and
// nothing reaches disk until `save`. Same engine as the desktop app and the CLI. No dependencies.
// Run: node mcp/server.ts   (or the bundled dist-cli/p6clone-mcp.cjs on older Node)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { detectFormat, importChecks, readRaw, type Format } from '../renderer/io.ts';
import { writeXer } from '../core/xer/write.ts';
import { writeP6Xml } from '../core/xml/p6xml.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { updateProgress } from '../core/progress/update.ts';
import { levelResources } from '../core/level/level.ts';
import { applyOps } from '../core/project/ops.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { TOOLS as LOOKUPS, runTool } from '../core/query/tools.ts';
import { reviewSchedule } from '../core/query/review.ts';
import { record, rollback, type Journal } from '../core/journal.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';
import { worst, type Finding } from '../core/findings.ts';
import type { Db } from '../core/db.ts';
import { compareSchedules } from '../core/diff.ts';
import { printPages, printableColumns } from '../renderer/print/schedule.ts';
import { pagesToHtml, pagesToPdf } from '../renderer/print/output.ts';
import { PRINT_GUIDE } from '../renderer/print/layout.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { listReports, parseSpec, runReport, runSpec } from '../renderer/reports/engine.ts';
import { reportHtml, reportPages, reportText, reportXlsx } from '../renderer/reports/output.ts';
import { nowStamp } from '../core/report/reports.ts';

const VERSION = '1.0.0';
interface Session { db: Db; path: string | null; format: Format; undo: { label: string; j: Journal }[]; dirty: boolean; hpd: number }
const sessions = new Map<string, Session>();
let seq = 0;

const handleProp = { handle: { type: 'string', description: 'The handle returned by open_file or new_project' } };
const withHandle = (schema: Record<string, unknown>) => ({ ...schema, properties: { ...handleProp, ...((schema.properties as object) ?? {}) }, required: ['handle', ...(((schema.required as string[]) ?? []))] });
const OPS_DOC = `Operations (all optional fields omitted unless needed; durations in days, dates "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; activities by Activity ID, WBS by code, resources by resource ID, calendars by name; "project" only when the file holds several projects):
- {op:"add_project", id, name, start, must_finish_by?, calendar?}   - {op:"set_project", project?, name?, data_date?, planned_start?, must_finish_by?, calendar?}
- {op:"add_calendar", name, work_week?: {sat:[["07:00","12:00"],["13:00","16:00"]], ...}, holidays?: [dates], work_exceptions?: {date: periods}}   - {op:"add_holidays", calendar, dates}
- {op:"add_wbs", code, name?, parent?}
- {op:"add_activity", id?, name, wbs?, duration_days?, type?: task|resource_dependent|start_milestone|finish_milestone|level_of_effort|wbs_summary, calendar?, constraint?: {type: start_on|start_on_or_after|start_on_or_before|finish_on|finish_on_or_before|finish_on_or_after|mandatory_start|mandatory_finish|alap|none, date}, secondary_constraint?, priority?, start?}
- {op:"update_activity", id, new_id?, name?, wbs?, duration_days?, remaining_days?, type?, calendar?, constraint?, start?, finish?, actual_start?, actual_finish?, percent_complete?, expected_finish?, priority?}
- {op:"delete_activity", id}   - {op:"dissolve_activity", id}  (links its predecessors to its successors)
- {op:"add_relationship", pred, succ, type?: FS|SS|FF|SF, lag_days?}   - {op:"update_relationship", pred, succ, type?, new_type?, lag_days?}   - {op:"delete_relationship", pred, succ, type?}
- {op:"add_resource", id, name?, type?: labor|nonlabor|material, units_per_day?, max_units_per_day?, price_per_unit?, calendar?}
- {op:"assign_resource", activity, resource, units_per_day?, units?}   - {op:"unassign_resource", activity, resource}`;

const TOOLS = [
  { name: 'open_file', description: 'Open an XER, P6 XML, Microsoft Project XML or MPX file into memory and get a handle. Returns P6 import diagnostics and a project summary. Nothing is written to the file until save.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, hours_per_day: { type: 'number', description: 'Hours in a day for durations given in days (default 8)' } }, required: ['path'] } },
  { name: 'new_project', description: 'Start a new, empty project in memory (WBS root, default calendar, P6 schedule options) and get a handle.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project ID, e.g. TWR-A' }, name: { type: 'string' }, start: { type: 'string', description: 'Planned start / data date, YYYY-MM-DD' }, hours_per_day: { type: 'number' } }, required: ['id', 'start'] } },
  { name: 'list_open', description: 'Projects currently open in memory.', inputSchema: { type: 'object', properties: {} } },
  { name: 'edit', description: `Change the project with a list of operations, applied as ONE transaction: if any fails nothing changes and the error names it. Undo with undo. ${OPS_DOC}`, inputSchema: withHandle({ type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] } } }, required: ['operations'] }) },
  { name: 'schedule', description: 'Schedule (F9) like P6: CPM with calendars, constraints, retained logic. Returns the finish date and the schedule log highlights.', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string', description: 'Optional new data date' } } }) },
  { name: 'update_progress', description: 'Tools > Update Progress: move the data date and statuse activities from their planned dates, then reschedule.', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string' } }, required: ['data_date'] }) },
  { name: 'level_resources', description: 'Tools > Level Resources (resources with a Max Units/Time limit).', inputSchema: withHandle({ type: 'object', properties: { within_float: { type: 'boolean' } } }) },
  { name: 'validate', description: 'P6 import diagnostics for the project as it is now (what real P6 would accept, warn about or reject), plus saved dates that P6 would change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'review', description: 'Schedule quality review (DCMA-style checks graded pass/warn/fail): missing logic, leads, lags, relationship types, hard constraints, float, long durations, invalid dates, resources, out-of-sequence, saved dates P6 would change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  ...LOOKUPS.map((t) => ({ name: t.name, description: t.description, inputSchema: withHandle(t.parameters) })),
  { name: 'undo', description: 'Undo the last edit, schedule, progress update or leveling on this project.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'save', description: 'Write the project to an XER file (P6 version 5.0 to 24.12; default: the version it was read in, else 19.12), or to P6 XML when the path ends in .xml.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string', description: 'Default: the file it was opened from (requires overwrite: true)' }, version: { type: 'string' }, overwrite: { type: 'boolean' } } }) },
  { name: 'export_pdf', description: 'Print the schedule to a PDF file like P6 prints the Activities layout: every activity on as many pages as needed, the chosen columns and/or the Gantt chart, WBS bands, timescale and column titles on every page, header/footer with page numbers, legend. Path ending in .html writes the same pages as HTML instead. Text outside Latin-1 prints as "?" in the PDF (use the desktop app for other scripts). ' + PRINT_GUIDE + ' Layout options: filter (all, critical, not_started, in_progress, completed, ...), group_by (wbs, none), sort_by (task_code, task_name, total_float, finish).', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, settings: { type: 'object', description: 'Print settings (see description)' }, project: { type: 'string', description: 'Project ID when the file holds several (default: all)' }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' } }, required: ['path'] }) },
  { name: 'export_excel', description: 'Export to an Excel workbook (.xlsx) like P6 File > Export > Spreadsheet: sheets TASK (activities), TASKPRED (relationships), RSRC (resources), TASKRSRC (assignments); row 1 field names, row 2 titles, durations and lags in days, dates as Excel dates. Can be edited and brought back with import_excel.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID (default: all projects in the file)' } }, required: ['path'] }) },
  { name: 'import_excel', description: 'Update the project from an Excel workbook in the export_excel / P6 spreadsheet layout: new and changed activities (name, WBS, type, durations, constraint, actual dates, % complete, calendar), relationships, resources and assignments; a "Y" in delete_record_flag deletes the row. Calculated columns (status, start, finish, float) are ignored. Applied as one undoable change; dry_run returns the plan without changing anything.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID to update (default: the only project)' }, dry_run: { type: 'boolean' } }, required: ['path'] }) },
  { name: 'compare', description: 'Compare this project with another open project (other_handle) or a file (path), like P6\'s Claim Digger: projects by Project ID, WBS by code path, activities by Activity ID, relationships by predecessor, successor and type, so renumbered internal ids do not matter. Durations, lags and floats in days. Use it to see exactly what changed between two revisions.', inputSchema: withHandle({ type: 'object', properties: { other_handle: { type: 'string', description: 'the newer revision, already open' }, path: { type: 'string', description: 'or a file to compare against (XER, P6 XML, MSPDI, MPX)' }, max_changes: { type: 'number' } } }) },
  { name: 'list_reports', description: 'Reports available like P6 Tools > Reports: the standard reports by group (Schedule, Progress, Earned Value, Cost, Resources) and reports made with create_report.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'run_report', description: 'Run a report (id or name from list_reports, or an ad-hoc "definition" like create_report takes). Without "path" the rows come back as data; with path it is written as a PDF (.pdf, same pages as printing, settings like export_pdf), HTML (.html), ASCII text/CSV (.csv or .txt) or Excel (.xlsx).', inputSchema: withHandle({ type: 'object', properties: { report: { type: 'string' }, definition: { type: 'object' }, path: { type: 'string' }, settings: { type: 'object', description: 'print settings for PDF (see export_pdf)' }, project: { type: 'string' }, weeks: { type: 'number', description: 'lookahead weeks' }, max_rows: { type: 'number' } } }) },
  { name: 'create_report', description: 'Save a report definition like the P6 Report Wizard (name, subject, columns, filter, group_by, sort_by, sort_desc, title, group). Kept with this open project for run_report (not written into the XER). ' + "Subject areas: activities (columns: any activity column id, e.g. task_code, task_name, orig_dur, rem_dur, pct, start, finish, total_float, bl_finish, var_bl_finish, bud_cost, act_cost, ev_bac, ev_pv, ev_ev, ev_ac, ev_sv, ev_cv, ev_spi, ev_cpi, ev_eac, ev_vac; group_by wbs|none), assignments (task_code, task_name, rsrc_id, rsrc_name, target_qty, act_qty, remain_qty, target_cost, act_cost, remain_cost, start, finish; group_by resource|activity|none), wbs (wbs_code, wbs_name, activities, start, finish, total_float, budget, actual, remaining, ev_*), resources (rsrc_id, rsrc_name, rsrc_type, max_units, price, calendar, assignments, target_qty, act_qty, remain_qty, target_cost; group_by none|type), relationships (pred_code, pred_name, succ_code, succ_name, type, lag, free_float, driving; group_by none|pred). Filters: all, critical, longest, notstarted, inprogress, completed, open, milestones, negfloat, late, constrained, started30, finished30, starting30, finishing30, nopreds.", inputSchema: withHandle({ type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' }, sort_desc: { type: 'boolean' }, title: { type: 'string' }, group: { type: 'string' } }, required: ['name', 'subject'] }) },
  { name: 'close', description: 'Close the project and free its memory (unsaved changes are lost).', inputSchema: withHandle({ type: 'object', properties: {} }) },
];

class UserError extends Error {}
const get = (h: unknown): Session => sessions.get(String(h)) ?? (() => { throw new UserError(`No open project with handle "${h}". Use open_file or new_project; list_open shows the open ones.`); })();
const allIds = (db: Db) => (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id);
const summary = (s: Session) => runTool('project_summary', {}, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd);
const brief = (f: Finding[]) => ({ verdict: worst(f) ?? 'clean', counts: f.reduce<Record<string, number>>((a, x) => ((a[x.severity] = (a[x.severity] ?? 0) + 1), a), {}), findings: f.filter((x) => x.severity !== 'info').slice(0, 40).map((x) => ({ severity: x.severity, code: x.code, where: [x.table, x.field, x.key].filter(Boolean).join(' '), message: x.message, p6: x.p6 })) });
const change = <T>(s: Session, label: string, fn: (db: Db) => T): T => {
  let out!: T;
  const j = record(s.db, (d) => { out = fn(d); });
  s.undo.push({ label, j }); if (s.undo.length > 50) s.undo.shift();
  s.dirty = true;
  return out;
};
const dd = (v: unknown) => { if (v == null || v === '') return null; const t = parseP6Date(String(v)); if (t == null) throw new UserError(`"${v}" is not a date (use YYYY-MM-DD).`); return t; };

const projectIds = (db: Db, id: unknown) => {
  const ps = (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  if (id == null || id === '') return ps.map((p) => p.proj_id);
  const p = ps.find((x) => x.proj_short_name.toLowerCase() === String(id).toLowerCase());
  if (!p) throw new UserError(`No project "${id}" (open: ${ps.map((x) => x.proj_short_name).join(', ')}).`);
  return [p.proj_id];
};

async function callAsync(name: string, a: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'export_pdf': {
      const s = get(a.handle);
      const path = resolve(String(a.path ?? ''));
      const r = printPages(s.db, { projIds: projectIds(s.db, a.project), setup: a.settings ?? {}, filter: a.filter, groupBy: a.group_by, sortBy: a.sort_by, prefs: { hoursPerDay: s.hpd, dateFormat: 'dd-MMM-yy', showTime: false, durationDecimals: 0 } });
      writeFileSync(path, /.html?$/i.test(path) ? pagesToHtml(r.pages, r.title) : await pagesToPdf(r.pages, r.title));
      return { saved: path, pages: r.pages.length, activities: r.activities, ...(r.unknownColumns.length ? { unknown_columns: r.unknownColumns, printable_columns: printableColumns(s.db).map((c) => c.id) } : {}) };
    }
    case 'export_excel': {
      const s = get(a.handle);
      const path = resolve(String(a.path ?? ''));
      writeFileSync(path, await writeXlsx(exportSheets(s.db, projectIds(s.db, a.project), s.hpd)));
      return { saved: path, sheets: ['TASK', 'TASKPRED', 'RSRC', 'TASKRSRC'] };
    }
    case 'compare': {
      const s = get(a.handle);
      let other: Db;
      if (a.other_handle) other = get(a.other_handle).db;
      else if (a.path) {
        const p = resolve(String(a.path));
        let bytes: Uint8Array;
        try { bytes = new Uint8Array(readFileSync(p)); } catch (e) { throw new UserError(`Cannot read ${p}: ${(e as Error).message}`); }
        other = readRaw(bytes, detectFormat(p, bytes)).db;
      } else throw new UserError('Give other_handle or path.');
      const cs = compareSchedules(s.db, other, s.hpd);
      const count = (o: string, k: string) => cs.filter((c) => c.object === o && c.kind === k).length;
      const max = Math.min(5000, Number(a.max_changes) || 500);
      return {
        summary: Object.fromEntries(['project', 'wbs', 'activity', 'relationship'].map((o) => [o, { added: count(o, 'added'), deleted: count(o, 'deleted'), changed: new Set(cs.filter((c) => c.object === o && c.kind === 'changed').map((c) => c.id)).size }])),
        changes: cs.slice(0, max), truncated: cs.length > max,
      };
    }
    case 'list_reports': { const s = get(a.handle); return listReports(s.db).map((e) => ({ id: e.id, name: e.name, group: e.group, kind: e.kind, description: e.description })); }
    case 'create_report': {
      const s = get(a.handle);
      const spec = parseSpec(a);
      if (!spec) throw new UserError('Give the report a "name".');
      const t = (s.db.tables._REPORT ??= { name: '_REPORT', fields: ['report_id', 'name', 'json'], rows: [] });
      const ex = t.rows.find((r) => r.name.toLowerCase() === spec.name.toLowerCase());
      if (ex) ex.json = JSON.stringify(spec);
      else t.rows.push({ report_id: String(t.rows.length + 1), name: spec.name, json: JSON.stringify(spec) });
      return { saved: spec.name, id: `custom:${ex?.report_id ?? t.rows.length}`, replaced: !!ex };
    }
    case 'run_report': {
      const s = get(a.handle);
      const prefs = { hoursPerDay: s.hpd, dateFormat: 'dd-MMM-yy' as const, showTime: false, durationDecimals: 0 };
      const ids = projectIds(s.db, a.project);
      let name: string, report;
      if (a.definition) { const spec = parseSpec({ name: 'Ad hoc report', ...a.definition }); if (!spec) throw new UserError('definition needs a name and subject'); report = runSpec(s.db, ids, spec, { prefs }); name = spec.name; }
      else { try { const r = runReport(s.db, ids, String(a.report ?? ''), { prefs, weeks: Number(a.weeks) || undefined }); report = r.report; name = r.entry.name; } catch (e) { throw new UserError((e as Error).message); } }
      if (!a.path) { const max = Math.min(2000, Number(a.max_rows) || 200); return { report: name, title: report.title, subtitle: report.subtitle, columns: report.columns, total_rows: report.rows.length, rows: report.rows.slice(0, max).map((r) => ({ cells: r.cells, ...(r.bold ? { group: true, level: r.level ?? 0 } : r.level ? { level: r.level } : {}) })), truncated: report.rows.length > max }; }
      const path = resolve(String(a.path));
      const ext = (/\.(\w+)$/.exec(path)?.[1] ?? '').toLowerCase();
      if (ext === 'pdf') { const pages = reportPages(s.db, ids, report, a.settings ?? {}, prefs, name); writeFileSync(path, await pagesToPdf(pages, report.title)); return { saved: path, pages: pages.length, rows: report.rows.length }; }
      if (ext === 'html' || ext === 'htm') writeFileSync(path, reportHtml(report, nowStamp()));
      else if (ext === 'csv' || ext === 'txt') writeFileSync(path, reportText(report));
      else if (ext === 'xlsx') writeFileSync(path, await reportXlsx(report));
      else throw new UserError('path must end in .pdf, .html, .csv, .txt or .xlsx');
      return { saved: path, rows: report.rows.length };
    }
    case 'import_excel': {
      const s = get(a.handle);
      const path = resolve(String(a.path ?? ''));
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(readFileSync(path)); } catch (e) { throw new UserError(`Cannot read ${path}: ${(e as Error).message}`); }
      const ids = projectIds(s.db, a.project);
      if (ids.length !== 1) throw new UserError('The file holds several projects; say which one with "project".');
      const pid = (s.db.tables.PROJECT?.rows ?? []).find((p) => p.proj_id === ids[0])!.proj_short_name;
      let sheets;
      try { sheets = await readXlsx(bytes); } catch (e) { throw new UserError((e as Error).message); }
      const plan = planImport(s.db, sheets, pid, s.hpd);
      if (a.dry_run || !plan.ops.length) return { applied: false, ...(plan.ops.length ? {} : { note: 'Nothing to change.' }), summary: plan.summary, warnings: plan.warnings, operations: plan.ops.slice(0, 200) };
      const r = editCall({ handle: a.handle, operations: plan.ops });
      return (r as { ok?: boolean }).ok === false ? r : { applied: true, summary: plan.summary, warnings: plan.warnings, note: 'Undo with undo. Run schedule to recalculate dates.' };
    }
  }
  return call(name, a);
}

function call(name: string, a: Record<string, any>): unknown {
  switch (name) {
    case 'open_file': {
      const path = resolve(String(a.path ?? ''));
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(readFileSync(path)); } catch (e) { throw new UserError(`Cannot read ${path}: ${(e as Error).message}`); }
      const format = detectFormat(path, bytes);
      const r = readRaw(bytes, format);
      const f = importChecks(r.db, r.findings, format);
      if (worst(f) === 'fatal') return { opened: false, reason: 'P6 would reject this file', diagnostics: brief(f) };
      const handle = `p${++seq}`;
      const s: Session = { db: r.db, path, format, undo: [], dirty: false, hpd: Number(a.hours_per_day) || 8 };
      sessions.set(handle, s);
      return { handle, file: basename(path), format, diagnostics: brief(f), summary: summary(s) };
    }
    case 'new_project': {
      const db: Db = { tables: {} };
      const r = applyOps(db, [{ op: 'add_project', id: a.id, name: a.name ?? a.id, start: a.start }]);
      if (!r.ok) throw new UserError(r.error!.message);
      const handle = `p${++seq}`;
      sessions.set(handle, { db, path: null, format: 'xer', undo: [], dirty: true, hpd: Number(a.hours_per_day) || 8 });
      return { handle, project: a.id };
    }
    case 'list_open': return [...sessions].map(([h, s]) => ({ handle: h, file: s.path, projects: (s.db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of).map((p) => p.proj_short_name), unsaved_changes: s.dirty, undo_steps: s.undo.length }));
    case 'schedule': {
      const s = get(a.handle);
      const t = dd(a.data_date);
      const res = change(s, 'Schedule', (d) => { const x = scheduleProjects(d, allIds(d), t != null ? { dataDate: t } : {}); if (x.ok) syncAssignmentDates(d); return x; });
      if (!res.ok) { rollback(s.undo.pop()!.j); return { ok: false, findings: res.findings.filter((f) => f.severity === 'error').map((f) => f.message) }; }
      return { ok: true, data_date: formatP6Date(res.stats.dataDate), finish: formatP6Date(res.stats.finish), stats: res.stats, warnings: res.findings.filter((f) => f.severity !== 'info').slice(0, 30).map((f) => f.message) };
    }
    case 'update_progress': {
      const s = get(a.handle);
      const t = dd(a.data_date)!;
      const res = change(s, 'Update Progress', (d) => { const by = Object.fromEntries(allIds(d).map((id) => [id, updateProgress(d, id, t)])); const x = scheduleProjects(d, allIds(d), { dataDate: t }); if (x.ok) syncAssignmentDates(d); return { ok: x.ok, finish: formatP6Date(x.stats.finish), progress: by }; });
      // scheduling failed: nothing is kept (progress without a valid schedule would leave the project inconsistent)
      if (!(res as { ok: boolean }).ok) { rollback(s.undo.pop()!.j); return { ...(res as object), note: 'Scheduling failed, so the progress update was undone. Nothing changed.' }; }
      return res;
    }
    case 'level_resources': {
      const s = get(a.handle);
      return change(s, 'Level Resources', (d) => { const r = levelResources(d, allIds(d), { withinFloat: !!a.within_float }); return { delayed: r.delayed, report: r.log }; });
    }
    case 'validate': { const s = get(a.handle); return brief(importChecks(s.db, [], s.format)); } // the opened file's format: no XER field-list notices for P6 XML
    case 'review': { const s = get(a.handle); return reviewSchedule(s.db, { hoursPerDay: s.hpd }); }
    case 'undo': {
      const s = get(a.handle);
      const u = s.undo.pop();
      if (!u) return { undone: null, note: 'Nothing to undo.' };
      rollback(u.j);
      return { undone: u.label, remaining_undo_steps: s.undo.length };
    }
    case 'save': {
      const s = get(a.handle);
      const path = a.path ? resolve(String(a.path)) : s.path;
      if (!path) throw new UserError('Give "path" (this project was created in memory).');
      if (!a.path && !a.overwrite) throw new UserError(`Saving would overwrite ${path}; pass overwrite: true or a new path.`);
      const xml = /\.xml$/i.test(path);
      writeFileSync(path, xml ? writeP6Xml(s.db, {}) : writeXer(s.db, { version: a.version ?? s.db.header?.version ?? '19.12' }));
      s.dirty = false;
      return { saved: path, format: xml ? 'P6 XML' : `XER ${a.version ?? s.db.header?.version ?? '19.12'}` };
    }
    case 'close': { const s = get(a.handle); sessions.delete(String(a.handle)); return { closed: a.handle, had_unsaved_changes: s.dirty }; }
  }
  if (LOOKUPS.some((t) => t.name === name)) {
    const s = get(a.handle);
    const { handle: _h, ...args } = a;
    return runTool(name, args, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd);
  }
  throw new UserError(`Unknown tool ${name}`);
}

// edit: applyOps is one transaction; recording it as well makes it undoable
const editCall = (a: Record<string, any>) => {
  const s = get(a.handle);
  let r!: ReturnType<typeof applyOps>;
  const j = record(s.db, (d) => { r = applyOps(d, a.operations, { hoursPerDay: s.hpd }); });
  if (!r.ok) return { ok: false, error: r.error, note: 'Nothing was changed.' };
  s.undo.push({ label: `Edit (${r.applied} operation${r.applied === 1 ? '' : 's'})`, j }); s.dirty = true;
  return r;
};

// ---- JSON-RPC 2.0 over stdio (one message per line), the MCP transport
type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any };
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
function handle(m: Msg): void {
  const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
  const error = (code: number, message: string) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': return void reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'p6-clone', title: 'P6 Clone (headless Primavera P6)', version: VERSION }, instructions: 'Open an XER with open_file (or new_project), then query, edit, schedule, review; save writes the XER. Projects stay open between calls; undo reverses the last change.' });
    case 'notifications/initialized': case 'notifications/cancelled': return;
    case 'ping': return void reply({});
    case 'tools/list': return void reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(m.params?.name ?? ''), args = (m.params?.arguments ?? {}) as Record<string, any>;
      void (async () => { try {
        const out = name === 'edit' ? editCall(args) : await callAsync(name, args);
        const isError = !!(out && typeof out === 'object' && ((out as { ok?: boolean }).ok === false || (out as { error?: unknown }).error && !(out as { activities?: unknown }).activities));
        return void reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out }, isError });
      } catch (e) {
        return void reply({ content: [{ type: 'text', text: e instanceof UserError ? e.message : `Internal error: ${(e as Error).stack ?? e}` }], isError: true });
      } })();
      return;
    }
    default: return void error(-32601, `Method not found: ${m.method}`);
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m: Msg;
    try { m = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
