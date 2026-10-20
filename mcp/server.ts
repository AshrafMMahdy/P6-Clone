#!/usr/bin/env node
// P6 Clone MCP server: a headless Primavera P6 for AI agents, shared by many agents without dead stops.
// Projects stay open in memory between calls, every change is undoable (per caller), nothing reaches disk until
// `save`, and every failure comes back with a code and a next step. Same engine as the desktop app and the CLI.
//   stdio (one agent):  node mcp/server.ts            (or the bundled dist-cli/p6clone-mcp.cjs)
//   HTTP (many agents): node mcp/server.ts --http --root <storage dir> [--port 8765] [--host 127.0.0.1] [--token T]
//   Either: [--automation-read-root DIR] [--automation-write-root DIR] fence reads and writes like the craft forks.
//   On stdin EOF, SIGTERM or SIGINT every project with unsaved changes is saved as <name>.recovered-<stamp>.xer in the
//   write root (else the storage root, else the project's folder) before the process exits.
//   Environment: P6CLONE_ROOT, P6CLONE_TOKEN, P6CLONE_PORT, P6CLONE_MAX_HANDLES, P6CLONE_MEM_BUDGET_MB,
//   P6CLONE_IDLE_MINUTES. Run Node with --max-old-space-size above the memory budget for very large files.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { detectFormat, exportFile, importChecks, readRaw, type Format } from '../renderer/io.ts';
import { writeXer } from '../core/xer/write.ts';
import { writeP6Xml } from '../core/xml/p6xml.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { updateProgress } from '../core/progress/update.ts';
import { levelResources } from '../core/level/level.ts';
import { applyOps, OP_GUIDE } from '../core/project/ops.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { TOOLS as LOOKUPS, runTool } from '../core/query/tools.ts';
import { reviewSchedule } from '../core/query/review.ts';
import { record, rollback } from '../core/journal.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';
import { worst, type Finding } from '../core/findings.ts';
import type { Db } from '../core/db.ts';
import { findUnicodeFont } from '../renderer/print/system-font.ts';
import { compareSchedules } from '../core/diff.ts';
import { printPages, printableColumns } from '../renderer/print/schedule.ts';
import { pagesToHtml, pagesToPdf } from '../renderer/print/output.ts';
import { PRINT_GUIDE } from '../renderer/print/layout.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { listReports, parseSpec, runReport, runSpec } from '../renderer/reports/engine.ts';
import { reportHtml, reportPages, reportText, reportXlsx } from '../renderer/reports/output.ts';
import { nowStamp } from '../core/report/reports.ts';
import { defaultEstimates, runMonteCarlo } from '../core/risk/montecarlo.ts';
import {
  ToolError, fail, config, setRoot, setRoots, writeBase, unsavedEvicted, isDirty, pathArg, createSession, estimateBytes, getSession, closeSession, forgetEvicted, requireOwner,
  exclusive, change, dropLast, undo, redo, startJob, jobView, getJob, sweepIdle, sweepJobs, status, sessions, loadIndex, evictedList, type Session,
} from './runtime.ts';

const VERSION = '2.0.0';
const prefsOf = (s: Session) => ({ hoursPerDay: s.hpd, dateFormat: 'dd-MMM-yy' as const, showTime: false, durationDecimals: 0 });

// ---------------------------------------------------------------- tool list
const handleProp = { handle: { type: 'string', description: 'The handle returned by open_file or new_project' } };
const common = { caller: { type: 'string', description: 'Who is calling (set by the bridge); undo and redo act on your own changes' }, async: { type: 'boolean', description: 'Run as a job and return a job_id at once (job_status gives the result)' } };
const ownerProp = { owner_key: { type: 'string', description: 'The owner key returned when the project was opened' } };
const withHandle = (schema: Record<string, unknown>, owner = false) => ({ ...schema, properties: { ...handleProp, ...(owner ? ownerProp : {}), ...((schema.properties as object) ?? {}), ...common }, required: ['handle', ...(((schema.required as string[]) ?? []))] });
const ro = { readOnlyHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const ERRORS_DOC = ' Errors come back as {error: {code, reason, next_step, retry_after_ms?}} (also message, hint, retry_after in seconds): follow next_step (e.g. busy -> retry, unknown_handle -> open_file again). Answers of tools that can change a project carry unsaved_changes.';

const TOOLS = [
  { name: 'open_file', annotations: edit, description: 'Open an XER, P6 XML, Microsoft Project XML or MPX file and get a handle (for editing) and an owner_key (for save, close and undoing others\' changes). Returns P6 import diagnostics and a project summary. A file P6 would reject is refused (error p6_would_reject, with the fatal findings) unless lenient: true, which opens it anyway when its data could be read (the findings stay in diagnostics: fix them before P6 gets the file). Nothing is written until save. Large files can take a while: pass async: true to get a job_id.' + ERRORS_DOC, inputSchema: { type: 'object', properties: { path: { type: 'string' }, hours_per_day: { type: 'number' }, lenient: { type: 'boolean', description: 'open a file P6 would reject, to repair it' }, encoding: { type: 'string', description: 'XER/MPX text encoding (default: recognised automatically): windows-1252, windows-1256 (Arabic), windows-1251, windows-1253, windows-1255, windows-1250, windows-1254, gbk, big5, shift_jis, utf-8' }, ...common }, required: ['path'] } },
  { name: 'new_project', annotations: edit, description: 'Start a new, empty project in memory (WBS root, default calendar, P6 schedule options); returns handle and owner_key.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project ID' }, name: { type: 'string' }, start: { type: 'string', description: 'Planned start YYYY-MM-DD' }, hours_per_day: { type: 'number' }, ...common }, required: ['id', 'start'] } },
  { name: 'list_open', annotations: ro, description: 'Projects open in memory, and projects moved out of memory to recovery files (they come back on their next call).', inputSchema: { type: 'object', properties: {} } },
  { name: 'server_status', annotations: ro, description: 'Memory use and budget, limits, open projects (busy, idle, unsaved), projects moved out, running jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'job_status', annotations: ro, description: 'Result of a job started with async: true (or one that outlived the call time). wait_seconds (max 20) waits for it to finish.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, wait_seconds: { type: 'number' } }, required: ['job_id'] } },
  { name: 'cancel_job', annotations: edit, description: 'Stop a running job (Monte Carlo stops at once; open_file, save and schedule stop between their phases, keeping or writing nothing; other work finishes its current step). MCP notifications/cancelled stops a running call the same way.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
  { name: 'edit', annotations: edit, description: `Change the project with a list of operations, applied as ONE transaction: if any fails nothing changes and the error names it. Undo with undo.\n${OP_GUIDE}`, inputSchema: withHandle({ type: 'object', properties: { operations: { type: 'array', items: { type: 'object' } } }, required: ['operations'] }) },
  { name: 'schedule', annotations: edit, description: 'Schedule (F9) like P6: CPM with calendars, constraints, retained logic. Returns the finish date and the schedule log highlights. data_date moves the data date of every project in the file first, or with project of that project only (the others schedule on their own data dates).', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string' }, project: { type: 'string', description: 'Project ID: data_date applies to this project only' } } }) },
  { name: 'update_progress', annotations: edit, description: 'Tools > Update Progress: move the data date and statuse activities from their planned dates, then reschedule. If scheduling fails nothing is kept.', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string' } }, required: ['data_date'] }) },
  { name: 'level_resources', annotations: edit, description: 'Tools > Level Resources (resources with a Max Units/Time limit).', inputSchema: withHandle({ type: 'object', properties: { within_float: { type: 'boolean' } } }) },
  { name: 'monte_carlo', annotations: ro, description: 'Schedule risk analysis (Monte Carlo) like Primavera Risk Analysis: samples each activity\'s remaining duration from its three-point estimate (set with the set_estimates edit operation; default_estimates applies min/max percentages to activities without one, for this run only) and risk events from the risk register, schedules every iteration. Returns finish percentiles P10-P90, mean, std dev, chance of meeting the deterministic finish, a histogram (buckets), milestone percentiles, activity criticality index, sensitivity ranking and risk-event impact. The project is not changed. Big projects: pass async: true.', inputSchema: withHandle({ type: 'object', properties: { iterations: { type: 'number', description: 'default 1000' }, seed: { type: 'number', description: 'same seed, same result' }, risk_events: { type: 'string', description: 'pre (default), post or off' }, project: { type: 'string' }, default_estimates: { type: 'object', description: '{min_pct: 90, max_pct: 125, dist: triangle|uniform|betapert} for activities without an estimate' }, buckets: { type: 'number', description: 'histogram buckets (default 20)' }, top: { type: 'number', description: 'how many activities in the criticality and sensitivity lists (default 25)' } } }) },
  { name: 'validate', annotations: ro, description: 'P6 import diagnostics for the project as it is now (what real P6 would accept, warn about or reject), plus saved dates that P6 would change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'review', annotations: ro, description: 'Schedule quality review (DCMA-style checks graded pass/warn/fail): missing logic, leads, lags, relationship types, hard constraints, float, long durations, invalid dates, resources, out-of-sequence, saved dates P6 would change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  ...LOOKUPS.map((t) => ({ name: t.name, annotations: ro, description: t.description, inputSchema: withHandle(t.parameters) })),
  { name: 'undo', annotations: edit, description: 'Undo your own last change on this project (edit, schedule, progress update, leveling, import). Refused only if someone else\'s later change touched the same items. any_caller: true (with owner_key) undoes the latest change whoever made it.', inputSchema: withHandle({ type: 'object', properties: { any_caller: { type: 'boolean' } } }, true) },
  { name: 'redo', annotations: edit, description: 'Re-apply your last undone change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'save', annotations: writes, description: 'Write the project (needs owner_key): XER (P6 version 5.0-24.12; default the version it was read in, else 19.12), P6 XML (.xml), Microsoft Project XML (format: mspdi) or MPX (.mpx). A Microsoft Project file holds one project: when the file has several, mspdi and mpx need project. Paths are inside the storage root.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string', description: 'Default: the file it was opened from (requires overwrite: true)' }, project: { type: 'string', description: 'Project ID to write (default: all projects; required for mspdi and mpx when the file holds several)' }, format: { type: 'string', description: 'xer, p6xml, mspdi or mpx (default from the extension; .xml = P6 XML)' }, version: { type: 'string' }, encoding: { type: 'string', description: 'XER/MPX text encoding (default: the code page P6 would use, e.g. windows-1256 for Arabic)' }, overwrite: { type: 'boolean' } } }, true) },
  { name: 'export_pdf', annotations: writes, description: 'Print the schedule to a PDF file like P6 prints the Activities layout: every activity on as many pages as needed, the chosen columns and/or the Gantt chart, WBS bands, timescale and column titles on every page, header/footer with page numbers, legend. Path ending in .html writes the same pages as HTML. ' + PRINT_GUIDE + ' Layout options: filter, group_by (wbs, none), sort_by.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, settings: { type: 'object', description: 'Print settings (see description)' }, project: { type: 'string', description: 'Project ID when the file holds several (default: all)' }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' } }, required: ['path'] }) },
  { name: 'export_excel', annotations: writes, description: 'Export to an Excel workbook (.xlsx) like P6 File > Export > Spreadsheet: sheets TASK, TASKPRED, RSRC, TASKRSRC; row 1 field names, row 2 titles, durations and lags in days, dates as Excel dates. Can be edited and brought back with import_excel.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID (default: all projects in the file)' } }, required: ['path'] }) },
  { name: 'import_excel', annotations: edit, description: 'Update the project from an Excel workbook in the export_excel / P6 spreadsheet layout: new and changed activities, relationships, resources and assignments; "Y" in delete_record_flag deletes the row. Calculated columns are ignored. One undoable change; dry_run returns the plan only.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID to update (default: the only project)' }, dry_run: { type: 'boolean' } }, required: ['path'] }) },
  { name: 'compare', annotations: ro, description: 'Compare this project with another open project (other_handle) or a file (path), like P6\'s Claim Digger: projects by Project ID, WBS by code path, activities by Activity ID, relationships by predecessor, successor and type. Durations, lags and floats in days.', inputSchema: withHandle({ type: 'object', properties: { other_handle: { type: 'string', description: 'the newer revision, already open' }, path: { type: 'string', description: 'or a file to compare against' }, max_changes: { type: 'number' } } }) },
  { name: 'list_reports', annotations: ro, description: 'Reports available like P6 Tools > Reports: the standard reports by group and reports made with create_report.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'run_report', annotations: ro, description: 'Run a report (id or name from list_reports, or an ad-hoc "definition" like create_report takes). Without "path" the rows come back as data; with path it is written as PDF (.pdf), HTML (.html), CSV (.csv/.txt) or Excel (.xlsx).', inputSchema: withHandle({ type: 'object', properties: { report: { type: 'string' }, definition: { type: 'object' }, path: { type: 'string' }, settings: { type: 'object', description: 'print settings for PDF (see export_pdf)' }, project: { type: 'string' }, weeks: { type: 'number', description: 'lookahead weeks' }, max_rows: { type: 'number' } } }) },
  { name: 'create_report', annotations: edit, description: 'Save a report definition like the P6 Report Wizard (name, subject, columns, filter, group_by, sort_by, sort_desc, title, group). Kept with this open project for run_report (not written into the XER). Subject areas: activities, assignments, wbs, resources, relationships (see list_reports for examples).', inputSchema: withHandle({ type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' }, sort_desc: { type: 'boolean' }, title: { type: 'string' }, group: { type: 'string' } }, required: ['name', 'subject'] }) },
  { name: 'close', annotations: writes, description: 'Close the project and free its memory (needs owner_key). Refused (unsaved_changes) while it has unsaved changes: save first, or pass discard: true to drop them.', inputSchema: withHandle({ type: 'object', properties: { discard: { type: 'boolean', description: 'close even with unsaved changes (they are lost)' } } }, true) },
];

// ---------------------------------------------------------------- helpers
const allIds = (db: Db) => (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of).map((p) => p.proj_id);
const summary = (s: Session) => runTool('project_summary', {}, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd);
const brief = (f: Finding[]) => ({ verdict: worst(f) ?? 'clean', counts: f.reduce<Record<string, number>>((a, x) => ((a[x.severity] = (a[x.severity] ?? 0) + 1), a), {}), findings: f.filter((x) => x.severity !== 'info').slice(0, 40).map((x) => ({ severity: x.severity, code: x.code, where: [x.table, x.field, x.key].filter(Boolean).join(' '), message: x.message, p6: x.p6 })) });
const dd = (v: unknown) => { if (v == null || v === '') return null; const t = parseP6Date(String(v)); if (t == null) fail('bad_input', `"${v}" is not a date.`, 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM.'); return t; };
const projectIds = (db: Db, id: unknown) => {
  const ps = (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  if (id == null || id === '') return ps.map((p) => p.proj_id);
  const p = ps.find((x) => x.proj_short_name.toLowerCase() === String(id).toLowerCase());
  if (!p) fail('bad_input', `No project "${id}".`, `Projects in this file: ${ps.map((x) => x.proj_short_name).join(', ')}.`);
  return [p!.proj_id];
};
const readBytes = (p: string) => { try { return new Uint8Array(readFileSync(p)); } catch (e) { return fail('file_unreadable', `Cannot read ${p}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}.`, 'Check the path (relative paths are taken from the storage root).'); } };
/** Write a file atomically: a temporary file in the same folder, flushed to disk, then renamed over the target (a crash
 *  leaves the old file or the new one, never half of one). Missing folders inside the write root are made. */
const writeOut = (p: string, data: string | Uint8Array) => {
  const tmp = join(dirname(p), `.${basename(p)}.${randomBytes(4).toString('hex')}.p6clone-tmp`);
  try {
    if (writeBase()) mkdirSync(dirname(p), { recursive: true });
    const fd = openSync(tmp, 'w');
    try { const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data; for (let at = 0; at < b.length;) at += writeSync(fd, b, at, b.length - at); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* gone */ } fail('file_unwritable', `Cannot write ${p}: ${(e as Error).message}.`, 'Check that the folder exists and the file is not open elsewhere.'); }
};
const iso = (t: number | null | undefined) => (t == null || !Number.isFinite(t) ? null : formatP6Date(t));
/** Between phases of long work: let waiting messages in (a cancellation), then stop if this call was cancelled. */
const checkpoint = async (ctx: Ctx) => { await new Promise((r) => setImmediate(r)); if (ctx.signal.aborted) fail('cancelled', 'The call was cancelled.', 'Nothing was kept or written by it; call again when needed.'); };

// ---------------------------------------------------------------- tool implementations
type Ctx = { caller: string; job?: ReturnType<typeof startJob>; signal: AbortSignal };
const NO_HANDLE = new Set(['open_file', 'new_project', 'list_open', 'server_status', 'job_status', 'cancel_job']);
/** Tools that can change a project (their answers carry unsaved_changes). */
const MUTATES = new Set(TOOLS.filter((t) => !t.annotations.readOnlyHint && !['list_open', 'server_status', 'job_status', 'cancel_job'].includes(t.name)).map((t) => t.name));

async function run(name: string, a: Record<string, any>, ctx: Ctx): Promise<unknown> {
  switch (name) {
    case 'list_open': return { open: [...sessions.values()].map((s) => ({ handle: s.handle, file: s.path, projects: allIds(s.db).map((id) => s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)?.proj_short_name), unsaved_changes: s.dirty, changes: s.history.length })), moved_out: evictedList() };
    case 'server_status': return { version: VERSION, ...status() };
    case 'job_status': {
      const job = getJob(a.job_id);
      const wait = Math.min(20, Math.max(0, Number(a.wait_seconds) || 0)) * 1000;
      for (const t0 = Date.now(); !job.done && Date.now() - t0 < wait;) await new Promise((r) => setTimeout(r, 200));
      return jobView(job);
    }
    case 'cancel_job': { const job = getJob(a.job_id); job.abort?.abort(); return { job_id: job.id, cancel_requested: true, note: ['monte_carlo', 'open_file', 'save', 'schedule'].includes(job.tool) ? 'The job stops at its next step.' : 'This kind of job cannot be interrupted; it will finish its current step.' }; }
    case 'open_file': {
      const path = pathArg(a.path);
      const bytes = readBytes(path);
      const need = estimateBytes(bytes.length);
      // reserve the memory first, so a big file is refused (with a way forward) instead of exhausting the process
      const s0 = createSession({ tables: {} }, { path, format: 'xer', hpd: Number(a.hours_per_day) || 8, bytes: need, dirty: false });
      try {
        await checkpoint(ctx);
        const format = detectFormat(path, bytes);
        const r = readRaw(bytes, format, a.encoding ?? 'auto');
        await checkpoint(ctx);
        const f = importChecks(r.db, r.findings, format);
        await checkpoint(ctx);
        const fatal = worst(f) === 'fatal';
        // lenient: the file is opened to be repaired, when there is a project to hold (a file that could not be read has none)
        if (fatal && !(a.lenient === true && allIds(r.db).length)) {
          fail('p6_would_reject', `P6 would reject ${basename(path)}: ${f.filter((x) => x.severity === 'fatal').slice(0, 3).map((x) => x.message).join(' ')}`,
            a.lenient === true ? 'No project could be read from the file, so it cannot be opened even leniently; fix the file (the findings say what is wrong) or rebuild it.' : 'Pass lenient: true to open it anyway and repair it (the findings say what P6 refuses), or fix the file.',
            { data: { fatal: f.filter((x) => x.severity === 'fatal').slice(0, 40).map((x) => ({ code: x.code, where: [x.table, x.field, x.key].filter(Boolean).join(' '), message: x.message, p6: x.p6 })), diagnostics: brief(f) } });
        }
        s0.db = r.db; s0.format = format;
        return { handle: s0.handle, owner_key: s0.ownerKey, file: basename(path), format, ...(fatal ? { lenient: true, note: 'P6 would reject this file as it is: the fatal findings are in diagnostics. Fix them before P6 gets it.' } : {}), diagnostics: brief(f), summary: summary(s0) };
      } catch (e) { closeSession(s0); throw e; }
    }
    case 'new_project': {
      const db: Db = { tables: {} };
      const r = applyOps(db, [{ op: 'add_project', id: a.id, name: a.name ?? a.id, start: a.start }]);
      if (!r.ok) fail('bad_input', r.error!.message, 'Give id (Project ID) and start (YYYY-MM-DD).');
      const s = createSession(db, { path: null, format: 'xer', hpd: Number(a.hours_per_day) || 8, bytes: 8 * 1048576, dirty: true });
      return { handle: s.handle, owner_key: s.ownerKey, project: a.id };
    }
  }

  const s = getSession(a.handle);
  switch (name) {
    case 'edit': {
      let r!: ReturnType<typeof applyOps>;
      try { change(s, ctx.caller, 'Edit', (d) => { r = applyOps(d, a.operations, { hoursPerDay: s.hpd }); if (!r.ok) throw new Error('refused'); }); }
      catch (e) { if (r && !r.ok) return { ok: false, error: { code: 'op_failed', ...r.error, hint: 'Fix that operation (the message says what is wrong) and send the list again; nothing was changed.' } }; throw e; }
      s.history[s.history.length - 1].label = `Edit (${r.applied} operation${r.applied === 1 ? '' : 's'})`;
      return r;
    }
    case 'schedule': {
      const t = dd(a.data_date);
      const only = a.project != null && a.project !== '' ? projectIds(s.db, a.project)[0] : null;
      await checkpoint(ctx);
      const was = s.dirty;
      const res = change(s, ctx.caller, 'Schedule', (d) => {
        // with "project" the data date moves on that project only; the others schedule on their own
        if (only && t != null) d.tables.PROJECT.rows.find((p) => p.proj_id === only)!.last_recalc_date = formatP6Date(t);
        const x = scheduleProjects(d, allIds(d), t != null && !only ? { dataDate: t } : {}); if (x.ok) syncAssignmentDates(d); return x;
      });
      if (!res.ok) { dropLast(s); return { ok: false, error: { code: 'schedule_failed', message: res.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '), hint: 'Fix the reported problem (often a loop or a missing calendar) and schedule again; nothing was changed.' } }; }
      try { await checkpoint(ctx); } catch (e) { dropLast(s); s.dirty = was; throw e; }
      return { ok: true, ...(only ? { project: s.db.tables.PROJECT.rows.find((p) => p.proj_id === only)!.proj_short_name } : {}), data_date: iso(only ? res.projects[only].dataDate : res.stats.dataDate), finish: iso(res.stats.finish), stats: res.stats, warnings: res.findings.filter((f) => f.severity !== 'info').slice(0, 30).map((f) => f.message) };
    }
    case 'update_progress': {
      const t = dd(a.data_date) ?? fail('bad_input', 'Give data_date.', 'The new data date, YYYY-MM-DD.');
      const res = change(s, ctx.caller, 'Update Progress', (d) => { const by = Object.fromEntries(allIds(d).map((id) => [id, updateProgress(d, id, t)])); const x = scheduleProjects(d, allIds(d), { dataDate: t }); if (x.ok) syncAssignmentDates(d); return { ok: x.ok, finish: iso(x.stats.finish), progress: by, errors: x.findings.filter((f) => f.severity === 'error').map((f) => f.message) }; });
      if (!res.ok) { dropLast(s); return { ok: false, error: { code: 'schedule_failed', message: res.errors.join(' '), hint: 'Scheduling failed, so the progress update was undone; fix the problem and try again.' } }; }
      return res;
    }
    case 'level_resources': return change(s, ctx.caller, 'Level Resources', (d) => { const r = levelResources(d, allIds(d), { withinFloat: !!a.within_float }); return { delayed: r.delayed, report: r.log }; });
    case 'monte_carlo': {
      const ids = projectIds(s.db, a.project);
      const iterations = Math.min(20000, Math.max(10, Math.floor(Number(a.iterations) || 1000)));
      // default estimates only for this run: applied in a journal and rolled back afterwards
      const j = a.default_estimates ? record(s.db, (d) => { defaultEstimates(d, ids, Number(a.default_estimates.min_pct) || 90, Number(a.default_estimates.max_pct) || 125, a.default_estimates.dist ?? 'triangle'); }) : null;
      try {
        const r = await runMonteCarlo(s.db, ids, { iterations, seed: a.seed != null ? Number(a.seed) : undefined, riskEvents: a.risk_events === 'post' || a.risk_events === 'off' ? a.risk_events : 'pre', signal: ctx.signal,
          onProgress: (i) => { if (ctx.job) ctx.job.progress = `${i} of ${iterations} iterations`; } });
        const top = Math.min(200, Number(a.top) || 25);
        const buckets = Math.min(100, Math.max(5, Number(a.buckets) || 20));
        const lo = r.min, hi = r.max, w = (hi - lo) / buckets || 1;
        const hist = Array.from({ length: buckets }, (_, i) => ({ start: iso(lo + i * w), end: iso(lo + (i + 1) * w), count: 0, cum_pct: 0 }));
        for (const t of r.finishSamples) hist[Math.min(buckets - 1, Math.floor((t - lo) / w))].count++;
        let acc = 0; for (const b of hist) { acc += b.count; b.cum_pct = Math.round((acc / r.finishSamples.length) * 1000) / 10; }
        return {
          iterations: r.iterations, seed: r.seed, elapsed_seconds: Math.round(r.elapsedMs / 100) / 10, data_date: iso(r.dataDate),
          deterministic_finish: iso(r.deterministicFinish), chance_of_meeting_deterministic: Math.round(r.probDeterministic * 1000) / 10,
          finish: { P10: iso(r.percentiles.P10), P50: iso(r.percentiles.P50), P80: iso(r.percentiles.P80), P90: iso(r.percentiles.P90), mean: iso(r.mean), min: iso(r.min), max: iso(r.max), std_dev_days: Math.round(r.stdDevDays * 10) / 10 },
          histogram: hist,
          milestones: r.milestones.slice(0, top).map((m) => ({ id: m.code, name: m.name, deterministic: iso(m.deterministic), P10: iso(m.P10), P50: iso(m.P50), P80: iso(m.P80), P90: iso(m.P90) })),
          criticality: r.activities.slice(0, top).map((x) => ({ id: x.code, name: x.name, critical_pct: Math.round(x.criticality * 10) / 10, p80_finish: iso(x.p80Finish) })),
          sensitivity: r.sensitivity.slice(0, top).map((x) => ({ id: x.code, name: x.name, correlation: Math.round(x.rho * 100) / 100 })),
          risk_events: r.risks.map((x) => ({ id: x.code, name: x.name, probability_pct: Math.round(x.probability * 1000) / 10, impact_days: Math.round((x.hours / s.hpd) * 10) / 10, activities: x.activities, triggered_pct: Math.round(x.triggeredPct * 10) / 10 })),
          note: r.sensitivity.length ? undefined : 'No activity has a three-point estimate and no risk event applies: every iteration equals the deterministic schedule. Set estimates with the set_estimates edit operation, or pass default_estimates.',
        };
      } catch (e) { if (ctx.signal.aborted) fail('cancelled', 'The Monte Carlo run was cancelled.', 'Start it again when needed.'); throw e; }
      finally { if (j) rollback(j); }
    }
    case 'validate': return brief(importChecks(s.db, [], s.format));
    case 'review': return reviewSchedule(s.db, { hoursPerDay: s.hpd });
    case 'undo': {
      if (a.any_caller) requireOwner(s, a.owner_key ?? fail('owner_key_required', 'any_caller undo needs the owner key.', 'Pass owner_key, or undo only your own changes.'), 'Undoing other callers\' changes');
      const r = undo(s, ctx.caller, !!a.any_caller);
      return r.undone ? { undone: r.undone, by: r.by, your_remaining_changes: s.history.filter((h) => h.caller === ctx.caller).length } : { undone: null, note: a.any_caller ? 'Nothing to undo.' : `You (${ctx.caller}) have no change to undo on this project.` };
    }
    case 'redo': { const r = redo(s, ctx.caller); return r.redone ? r : { redone: null, note: 'Nothing to redo (redo is cleared when you make a new change).' }; }
    case 'save': {
      requireOwner(s, a.owner_key, 'Saving');
      const path = a.path ? pathArg(a.path, 'path', 'write') : s.path ?? fail('bad_input', 'Give "path" (this project was created in memory).', 'Pass a file path inside the storage root.');
      if (!a.path && !a.overwrite) fail('confirm_overwrite', `Saving would overwrite ${path}.`, 'Pass overwrite: true, or a new path.');
      const fmt = String(a.format ?? (/\.mpx$/i.test(path) ? 'mpx' : /\.xml$/i.test(path) ? 'p6xml' : 'xer')).toLowerCase();
      const projIds = a.project != null && a.project !== '' ? projectIds(s.db, a.project) : undefined;
      const names = () => allIds(s.db).map((id) => s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!.proj_short_name).join(', ');
      if ((fmt === 'mspdi' || fmt === 'mpx') && !projIds && allIds(s.db).length > 1) fail('bad_input', `A Microsoft Project file holds one project, and this file holds ${allIds(s.db).length}: ${names()}.`, 'Pass "project" with the Project ID to write (save once per project).');
      await checkpoint(ctx);
      let bytes: string | Uint8Array, label: string;
      if (fmt === 'p6xml' || fmt === 'xml') { bytes = writeP6Xml(s.db, { version: a.version ?? '19.12', projIds }); label = 'P6 XML'; }
      else if (fmt === 'mspdi' || fmt === 'mpx') { bytes = exportFile(s.db, fmt as Format, { version: '', projIds: projIds ?? allIds(s.db).slice(0, 1), encoding: a.encoding ?? 'auto' }); label = fmt === 'mpx' ? 'MPX' : 'Microsoft Project XML'; }
      else if (fmt === 'xer') { bytes = writeXer(s.db, { version: a.version ?? s.db.header?.version ?? '19.12', encoding: a.encoding ?? 'auto', projIds }); label = `XER ${a.version ?? s.db.header?.version ?? '19.12'}`; }
      else return fail('bad_input', `Unknown format "${a.format}".`, 'Use xer, p6xml, mspdi or mpx.');
      await checkpoint(ctx); // nothing is written once the call is cancelled; the write itself is one step
      writeOut(path, bytes);
      if (!projIds || allIds(s.db).length === 1) s.dirty = false;
      return { saved: path, format: label, ...(projIds ? { project: s.db.tables.PROJECT.rows.find((p) => p.proj_id === projIds[0])!.proj_short_name } : {}) };
    }
    case 'close': {
      requireOwner(s, a.owner_key, 'Closing');
      if (s.dirty && a.discard !== true) fail('unsaved_changes', 'This project has unsaved changes, so it was not closed.', 'Save it first (save), or close with discard: true to drop the changes.');
      closeSession(s); forgetEvicted(s.handle); return { closed: s.handle, had_unsaved_changes: s.dirty };
    }
    case 'export_pdf': {
      const path = pathArg(a.path, 'path', 'write');
      const r = printPages(s.db, { projIds: projectIds(s.db, a.project), setup: a.settings ?? {}, filter: a.filter, groupBy: a.group_by, sortBy: a.sort_by, prefs: prefsOf(s) });
      writeOut(path, /\.html?$/i.test(path) ? pagesToHtml(r.pages, r.title) : await pagesToPdf(r.pages, r.title, { font: (cs) => findUnicodeFont(cs, a.settings?.font_path ? pathArg(a.settings.font_path, 'font_path') : undefined) }));
      return { saved: path, pages: r.pages.length, activities: r.activities, ...(r.unknownColumns.length ? { unknown_columns: r.unknownColumns, printable_columns: printableColumns(s.db).map((c) => c.id) } : {}) };
    }
    case 'export_excel': { const path = pathArg(a.path, 'path', 'write'); writeOut(path, await writeXlsx(exportSheets(s.db, projectIds(s.db, a.project), s.hpd))); return { saved: path, sheets: ['TASK', 'TASKPRED', 'RSRC', 'TASKRSRC'] }; }
    case 'import_excel': {
      const path = pathArg(a.path);
      const ids = projectIds(s.db, a.project);
      if (ids.length !== 1) fail('bad_input', 'The file holds several projects.', 'Say which one with "project".');
      const pid = s.db.tables.PROJECT.rows.find((p) => p.proj_id === ids[0])!.proj_short_name;
      let sheets;
      try { sheets = await readXlsx(readBytes(path)); } catch (e) { if (e instanceof ToolError) throw e; fail('bad_file', (e as Error).message, 'Use an .xlsx saved by export_excel or Excel in that layout.'); }
      const plan = planImport(s.db, sheets!, pid, s.hpd);
      if (a.dry_run || !plan.ops.length) return { applied: false, ...(plan.ops.length ? {} : { note: 'Nothing to change.' }), summary: plan.summary, warnings: plan.warnings, operations: plan.ops.slice(0, 200) };
      return run('edit', { ...a, operations: plan.ops }, ctx).then((r) => ((r as { ok?: boolean }).ok === false ? r : { applied: true, summary: plan.summary, warnings: [...plan.warnings, ...((r as { warnings?: string[] }).warnings ?? [])], note: 'Undo with undo. Run schedule to recalculate dates.' }));
    }
    case 'compare': {
      const other = a.other_handle ? getSession(a.other_handle).db : a.path ? (() => { const p = pathArg(a.path); const b = readBytes(p); return readRaw(b, detectFormat(p, b)).db; })() : fail('bad_input', 'Give other_handle or path.', 'other_handle: another open project; path: a file to compare against.');
      const cs = compareSchedules(s.db, other, s.hpd);
      const count = (o: string, k: string) => cs.filter((c) => c.object === o && c.kind === k).length;
      const max = Math.min(5000, Number(a.max_changes) || 500);
      return { summary: Object.fromEntries(['project', 'wbs', 'activity', 'relationship'].map((o) => [o, { added: count(o, 'added'), deleted: count(o, 'deleted'), changed: new Set(cs.filter((c) => c.object === o && c.kind === 'changed').map((c) => c.id)).size }])), changes: cs.slice(0, max), truncated: cs.length > max };
    }
    case 'list_reports': return listReports(s.db).map((e) => ({ id: e.id, name: e.name, group: e.group, kind: e.kind, description: e.description }));
    case 'create_report': {
      const spec = parseSpec(a) ?? fail('bad_input', 'Give the report a "name" and "subject".', 'subject: activities, assignments, wbs, resources or relationships.');
      return change(s, ctx.caller, `Report ${spec.name}`, (d) => {
        const t = (d.tables._REPORT ??= { name: '_REPORT', fields: ['report_id', 'name', 'json'], rows: [] });
        const ex = t.rows.find((r) => r.name.toLowerCase() === spec.name.toLowerCase());
        if (ex) ex.json = JSON.stringify(spec); else t.rows.push({ report_id: String(t.rows.length + 1), name: spec.name, json: JSON.stringify(spec) });
        return { saved: spec.name, id: `custom:${ex?.report_id ?? t.rows.length}`, replaced: !!ex };
      });
    }
    case 'run_report': {
      const prefs = prefsOf(s);
      const ids = projectIds(s.db, a.project);
      let rname: string, report;
      if (a.definition) { const spec = parseSpec({ name: 'Ad hoc report', ...a.definition }) ?? fail('bad_input', 'definition needs a name and subject.', 'subject: activities, assignments, wbs, resources or relationships.'); report = runSpec(s.db, ids, spec, { prefs }); rname = spec.name; }
      else { try { const r = runReport(s.db, ids, String(a.report ?? ''), { prefs, weeks: Number(a.weeks) || undefined }); report = r.report; rname = r.entry.name; } catch (e) { fail('bad_input', (e as Error).message, 'Use an id or name from list_reports.'); } }
      if (!a.path) { const max = Math.min(2000, Number(a.max_rows) || 200); return { report: rname!, title: report!.title, subtitle: report!.subtitle, columns: report!.columns, total_rows: report!.rows.length, rows: report!.rows.slice(0, max).map((r) => ({ cells: r.cells, ...(r.bold ? { group: true, level: r.level ?? 0 } : r.level ? { level: r.level } : {}) })), truncated: report!.rows.length > max }; }
      const path = pathArg(a.path, 'path', 'write');
      const ext = (/\.(\w+)$/.exec(path)?.[1] ?? '').toLowerCase();
      if (ext === 'pdf') { const pages = reportPages(s.db, ids, report!, a.settings ?? {}, prefs, rname!); writeOut(path, await pagesToPdf(pages, report!.title, { font: (cs) => findUnicodeFont(cs, a.settings?.font_path ? pathArg(a.settings.font_path, 'font_path') : undefined) })); return { saved: path, pages: pages.length, rows: report!.rows.length }; }
      if (ext === 'html' || ext === 'htm') writeOut(path, reportHtml(report!, nowStamp()));
      else if (ext === 'csv' || ext === 'txt') writeOut(path, reportText(report!));
      else if (ext === 'xlsx') writeOut(path, await reportXlsx(report!));
      else fail('bad_input', 'path must end in .pdf, .html, .csv, .txt or .xlsx.', 'Choose one of those extensions.');
      return { saved: path, rows: report!.rows.length };
    }
  }
  if (LOOKUPS.some((t) => t.name === name)) {
    const { handle: _h, caller: _c, async: _a, ...args } = a;
    return runTool(name, args, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd);
  }
  return fail('unknown_tool', `Unknown tool ${name}.`, 'tools/list shows the tools.');
}

/** One tool call: queued per project, run (or turned into a job), always answered with data or {error}. */
export async function callTool(name: string, a: Record<string, any>, sessionCaller?: string, signal?: AbortSignal): Promise<{ out: unknown; isError: boolean }> {
  // one abort for the call: the request's cancellation (notifications/cancelled) and cancel_job once it is a job
  const abort = new AbortController();
  if (signal?.aborted) abort.abort(); else signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const ctx: Ctx = { caller: String(a.caller ?? sessionCaller ?? 'default'), signal: abort.signal };
  const handle = NO_HANDLE.has(name) ? undefined : String(a.handle ?? '');
  const work = async () => {
    let out = handle != null ? await exclusive(handle, () => run(name, a, ctx)) : await run(name, a, ctx);
    const plain = !!out && typeof out === 'object' && !Array.isArray(out);
    // a tool that can change a project says whether that project now has unsaved changes
    const h = handle ?? (plain && typeof (out as { handle?: unknown }).handle === 'string' ? (out as { handle: string }).handle : undefined);
    if (plain && h && MUTATES.has(name)) out = { ...(out as object), unsaved_changes: isDirty(h) };
    const s = handle ? sessions.get(handle) : undefined;
    if (s?.notice && plain) { const n = s.notice; s.notice = undefined; return { ...(out as object), _notice: n }; }
    return out;
  };
  const asJob = a.async === true && name !== 'job_status';
  try {
    if (asJob) { const job = startJob(name, handle, Promise.resolve().then(() => { ctx.job = job; return work(); }), abort); return { out: { job_id: job.id, status: 'running', note: 'Call job_status with this job_id for the result.' }, isError: false }; }
    const p = work();
    const timeout = Symbol('timeout');
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(timeout), config.softTimeoutMs).unref?.())]);
    if (r === timeout) { const job = startJob(name, handle, p, abort); return { out: { job_id: job.id, status: 'running', note: `Still working after ${config.softTimeoutMs / 1000} s; the work continues as a job. Call job_status with this job_id.` }, isError: false }; }
    const o = r as { ok?: boolean; status?: string; error?: Record<string, unknown> } | null;
    // a refusal answered as data (ok: false), and a job that failed or was cancelled, are errors too
    const isError = !!(o && typeof o === 'object' && (o.ok === false || (name === 'job_status' && (o.status === 'failed' || o.status === 'cancelled'))));
    if (isError && o!.error) return { out: { ...o, error: contractError(o!.error) }, isError };
    return { out: r, isError };
  } catch (e) {
    if (e instanceof ToolError) return { out: { error: contractError({ code: e.code, message: e.message, hint: e.hint, ...(e.retryAfter ? { retry_after: e.retryAfter } : {}), ...(e.data ?? {}) }) }, isError: true };
    return { out: { error: contractError({ code: 'internal', message: (e as Error).message, hint: 'This is a bug in the server; the project was not changed by this call. Retry, or report it with the message.', detail: String((e as Error).stack ?? e).split('\n').slice(0, 4).join(' | ') }) }, isError: true };
  }
}

/** The craft forks' error shape ({code, reason, next_step, retry_after_ms}) with the older fields (message, hint,
 *  retry_after in seconds) kept beside it for one release. */
function contractError(e: Record<string, unknown>): Record<string, unknown> {
  const { code, message, hint, retry_after, ...rest } = e;
  return { code, reason: e.reason ?? message, next_step: e.next_step ?? hint, ...(retry_after ? { retry_after_ms: Number(retry_after) * 1000 } : {}), message, hint, ...(retry_after ? { retry_after } : {}), ...rest };
}

/** At exit: every project with unsaved changes (in memory or moved out) is saved as <name>.recovered-<stamp>.xer in the
 *  write root (else the storage root, else the project's own folder, else the working folder). Returns the files. */
export function saveUnsavedAtExit(reason: string): string[] {
  const saved: string[] = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const one = (handle: string, path: string | null, db: Db) => {
    const first = (db.tables.PROJECT?.rows ?? []).find((p) => p.proj_id === allIds(db)[0])?.proj_short_name;
    const name = ((path ? basename(path).replace(/\.[^.]+$/, '') : '') || first || handle).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'project';
    const dir = writeBase() ?? (path ? dirname(path) : process.cwd());
    let file = join(dir, `${name}.recovered-${stamp}.xer`);
    for (let i = 2; existsSync(file) || saved.includes(file); i++) file = join(dir, `${name}.recovered-${stamp}-${i}.xer`);
    try { writeOut(file, writeXer(db, { version: db.header?.version ?? '19.12', encoding: 'auto' })); saved.push(file); process.stderr.write(`P6 Clone: unsaved changes of ${handle} saved to ${file} (${reason})\n`); }
    catch (e) { process.stderr.write(`P6 Clone: the unsaved changes of ${handle} could not be saved (${reason}): ${(e as Error).message}\n`); }
  };
  for (const s of sessions.values()) if (s.dirty) one(s.handle, s.path, s.db);
  for (const e of unsavedEvicted()) one(e.handle, e.path, e.db);
  return saved;
}
let exiting = false;
/** Leave: save what is unsaved first (stdin closed, SIGTERM, SIGINT). */
export function shutdown(reason: string): void {
  if (exiting) return;
  exiting = true;
  try { saveUnsavedAtExit(reason); } finally { process.exit(0); }
}

/** An MCP tools/call result; oversized output is cut down to a preview instead of flooding the client. */
export function toolResult(out: unknown, isError: boolean) {
  let text = JSON.stringify(out, null, 1);
  let structured = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out };
  if (text.length > config.maxResponseChars) {
    structured = { truncated: true, size_chars: text.length, note: 'The result was too large to return whole; ask for less (limit, max_rows, filters, a narrower project) or write it to a file (run_report / export_* with path).', preview: text.slice(0, 20000) };
    text = JSON.stringify(structured, null, 1);
  }
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

export const SERVER_INFO = { name: 'p6-clone', title: 'P6 Clone (headless Primavera P6)', version: VERSION };
export const INSTRUCTIONS = 'Open an XER with open_file (or new_project): keep the handle (for editing) and the owner_key (for save, close and undoing others\' work). Then query, edit, schedule, review, run reports, Monte Carlo; save writes the file. Several agents may share one handle: calls run one at a time, undo and redo act on your own changes (pass caller). Every error has a code and a hint: follow the hint (busy: retry after retry_after seconds; unknown_handle: open the file again). Long work can run with async: true and job_status.';
export const toolsList = () => TOOLS;

// ---------------------------------------------------------------- start
export function housekeeping(): void { setInterval(() => { try { sweepIdle(); sweepJobs(); } catch { /* keep serving */ } }, 60000).unref(); }

const isMain = (() => { try { return /server\.(ts|js|cjs)$|p6clone-mcp/.test(process.argv[1] ?? ''); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  setRoot(opt('root') ?? process.env.P6CLONE_ROOT ?? null);
  setRoots(opt('automation-read-root'), opt('automation-write-root'));
  loadIndex();
  housekeeping();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(sig));
  if (args.includes('--http')) {
    config.requireOwnerKey = !args.includes('--no-owner-key');
    // not awaited: http/stdio import this module, so it must finish evaluating first
    void import('./http.ts').then(({ startHttp }) => startHttp({ port: Number(opt('port') ?? process.env.P6CLONE_PORT ?? 8765), host: opt('host') ?? '127.0.0.1', token: opt('token') ?? process.env.P6CLONE_TOKEN ?? null }));
  } else {
    config.requireOwnerKey = args.includes('--require-owner-key');
    void import('./stdio.ts').then(({ startStdio }) => startStdio());
  }
}
