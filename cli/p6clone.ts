#!/usr/bin/env node
// P6 Clone CLI — same core as the desktop app.
import { readFileSync, writeFileSync } from 'node:fs';
import { detectFormat, importChecks, readRaw, type Format } from '../renderer/io.ts';
import { writeOut } from './commands.ts';
import { validateXer } from '../core/xer/validate.ts';
import { writeXer } from '../core/xer/write.ts';
import { diffDbs } from '../core/diff.ts';
import { worst, type Finding } from '../core/findings.ts';
import type { Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { runTool } from '../core/query/tools.ts';
import { reviewSchedule, reviewText } from '../core/query/review.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';

/** Plain-text rendering of a lookup result: tables for lists of objects, key: value otherwise. */
function queryText(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0] && !Array.isArray(v[0])) {
      const cols = [...new Set(v.flatMap((r) => Object.keys(r as object)))];
      const cell = (x: unknown) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
      const w = cols.map((c) => Math.min(40, Math.max(c.length, ...v.map((r) => cell((r as Record<string, unknown>)[c]).length))));
      return [cols.map((c, i) => c.padEnd(w[i])).join('  '), ...v.map((r) => cols.map((c, i) => cell((r as Record<string, unknown>)[c]).slice(0, 40).padEnd(w[i])).join('  '))].map((l) => indent + l).join('\n');
    }
    return v.map((x) => indent + '- ' + (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  }
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => (x && typeof x === 'object' ? `${indent}${k}:\n${queryText(x, indent + '  ')}` : `${indent}${k}: ${x ?? ''}`)).join('\n');
  return indent + String(v);
}


const USAGE = `p6clone <command> [options]

  Input files: XER, P6 XML, Microsoft Project XML or MPX (detected from the content). --out writes P6 XML
  when the path ends in .xml, else XER.

  new      --id P1 --name "Tower A" --start 2026-03-01 --out p1.xer [--version 19.12]
  edit     <file.xer> --ops ops.json|- --out out.xer [--schedule] [--data-date D] [--hours-per-day 8] [--json]
           Operations (JSON array, applied as one transaction): add_project, set_project, add_calendar,
           add_holidays, add_wbs, add_activity, update_activity, delete_activity, dissolve_activity,
           add_relationship, update_relationship, delete_relationship, add_resource, assign_resource,
           unassign_resource. See README.
  query    <file.xer> summary|find|activity <ID>|wbs [code]|critical|health|resources [ID] [filters] [--json]
           find filters: --text --status not_started|in_progress|completed --critical --not-critical --wbs
                         --resource --starts-after --starts-before --finishes-after --finishes-before
                         --code "[TYPE=]value" --max-float --min-float --milestones --sort start|finish|total_float|duration --limit N
  review   <file.xer> [--json]                         Schedule quality review. Exit 0 pass, 1 warnings, 3 failures
  validate <file.xer> [--json]                       P6-style import diagnostics. Exit 0 ok/warnings, 1 errors, 2 fatal
  schedule <file.xer> [--data-date YYYY-MM-DD] [--out out.xer] [--version 19.12] [--json]
  progress <file.xer> --data-date YYYY-MM-DD --out out.xer [--version v]
  level    <file.xer> --out out.xer [--version v]
  export   <file.xer> --version <v> --out <path> [--format xer|xml]
  diff     <a.xer> <b.xer> [--json]
`;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const BOOL = new Set(['--json', '--schedule', '--critical', '--not-critical', '--milestones']);
const positional: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (!BOOL.has(args[i])) i++; }
  else positional.push(args[i]);
}
const hpd = () => Number(opt('hours-per-day') ?? 8);

/** Read an XER, P6 XML, Microsoft Project XML or MPX file (by content and extension). */
function load(path: string): { db: Db; findings: Finding[]; format: Format } {
  if (!path) throw new Error('No file given.');
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync(path)); } catch (e) { throw new Error(`Cannot read ${path}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`); }
  const format = detectFormat(path, bytes);
  return { ...readRaw(bytes, format), format };
}

function printFindings(f: Finding[]): void {
  for (const x of f) {
    const where = [x.table, x.row != null ? `row ${x.row}` : '', x.field].filter(Boolean).join(' ');
    console.log(`${x.severity.toUpperCase().padEnd(7)} ${x.code.padEnd(20)} ${where ? `[${where}] ` : ''}${x.message}`);
    console.log(`        P6: ${x.p6}`);
  }
}

function exitCode(f: Finding[]): number {
  const w = worst(f);
  return w === 'fatal' ? 2 : w === 'error' ? 1 : 0;
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'validate': {
      const { db, findings, format } = load(positional[0]);
      const all = importChecks(db, findings, format);
      if (flag('json')) console.log(JSON.stringify({ file: positional[0], version: db.header?.version, verdict: worst(all) ?? 'clean', findings: all }, null, 2));
      else {
        printFindings(all);
        const w = worst(all);
        console.log(`\n${all.length} finding(s). Verdict: ${w === 'fatal' ? 'P6 would REJECT this file' : w === 'error' ? 'P6 import would FAIL or drop data' : 'P6 would import this file'}.`);
      }
      return exitCode(all);
    }
    case 'export': {
      const { db } = load(positional[0]);
      const version = opt('version') ?? '19.12';
      const out = opt('out');
      if (!out) throw new Error('--out required');
      if ((opt('format') ?? 'xer') === 'xml') {
        const { writeP6Xml } = await import('../core/xml/p6xml.ts');
        writeFileSync(out, writeP6Xml(db, {}));
      } else writeFileSync(out, writeXer(db, { version }));
      console.log(`Wrote ${out}`);
      return 0;
    }
    case 'schedule': case 'progress': case 'level': {
      const { db, findings } = load(positional[0]);
      const pre = validateXer(db, findings);
      if (worst(pre) === 'fatal') { printFindings(pre.filter((f) => f.severity === 'fatal')); return 2; }
      const { runScheduleCommand } = await import('./commands.ts');
      return runScheduleCommand(cmd, db, { dataDate: opt('data-date'), out: opt('out'), version: opt('version'), json: flag('json') });
    }
    case 'new': {
      const out = opt('out');
      if (!out) throw new Error('--out required');
      const db: Db = { tables: {} };
      const id = opt('id') ?? 'NEW';
      const r = applyOps(db, [{ op: 'add_project', id, name: opt('name') ?? id, start: opt('start') ?? new Date().toISOString().slice(0, 10) }]);
      if (!r.ok) { console.error(r.error!.message); return 65; }
      writeOut(out, db, opt('version'));
      if (flag('json')) console.log(JSON.stringify({ ok: true, project: id, out }));
      else console.log(`Created project ${id} in ${out}`);
      return 0;
    }
    case 'edit': {
      const { db, findings } = load(positional[0]);
      const pre = validateXer(db, findings);
      if (worst(pre) === 'fatal') { printFindings(pre.filter((f) => f.severity === 'fatal')); return 2; }
      const src = opt('ops');
      if (!src) throw new Error('--ops <file.json> (or - for standard input) required');
      let ops: unknown;
      try { ops = JSON.parse(src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8')); }
      catch (e) { console.error(`--ops is not valid JSON: ${(e as Error).message}`); return 65; }
      const r = applyOps(db, ops, { hoursPerDay: hpd() });
      let sched: { ok: boolean; finish: string | null } | null = null;
      if (r.ok && flag('schedule')) {
        const dd = opt('data-date') ? parseP6Date(opt('data-date')) : null;
        const res = scheduleProjects(db, (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id), dd != null ? { dataDate: dd } : {});
        if (res.ok) syncAssignmentDates(db);
        sched = { ok: res.ok, finish: formatP6Date(res.stats.finish) };
        if (!res.ok) { r.ok = false; r.error = { index: -1, op: null, message: `Scheduling failed: ${res.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('; ')}` }; }
      }
      const out = opt('out');
      if (r.ok && out) writeOut(out, db, opt('version'));
      if (flag('json')) console.log(JSON.stringify({ ...r, schedule: sched, out: r.ok ? out ?? null : null }, null, 2));
      else if (r.ok) console.log(`Applied ${r.applied} operation(s)${sched ? `, scheduled (finish ${sched.finish})` : ''}${out ? `; wrote ${out}` : ' (no --out: nothing written)'}`);
      else console.error(`${r.error!.index >= 0 ? `Operation ${r.error!.index + 1} failed` : 'Failed'}: ${r.error!.message}${r.error!.index >= 0 ? `\n  ${JSON.stringify(r.error!.op)}` : ''}\nNothing was changed.`);
      return r.ok ? 0 : 65;
    }
    case 'query': {
      const { db } = load(positional[0]);
      const what = positional[1] ?? 'summary';
      const tool = ({ summary: 'project_summary', find: 'find_activities', activity: 'get_activity', wbs: 'list_wbs', critical: 'critical_path', health: 'schedule_health', resources: 'resource_summary' } as Record<string, string>)[what];
      if (!tool) throw new Error(`unknown query "${what}" (summary, find, activity, wbs, critical, health, resources)`);
      const n = (k: string) => (opt(k) != null ? Number(opt(k)) : undefined);
      const qargs: Record<string, unknown> = what === 'activity' ? { activity_id: positional[2] }
        : what === 'resources' ? { resource: positional[2] ?? opt('resource'), limit: n('limit') }
        : what === 'wbs' ? { under: positional[2] ?? opt('under'), depth: n('depth') }
        : what === 'critical' ? { limit: n('limit') }
        : {
          text: opt('text'), status: opt('status'), critical: flag('critical') ? true : flag('not-critical') ? false : undefined, wbs: opt('wbs'), resource: opt('resource'),
          starts_after: opt('starts-after'), starts_before: opt('starts-before'), finishes_after: opt('finishes-after'), finishes_before: opt('finishes-before'),
          max_total_float_days: n('max-float'), min_total_float_days: n('min-float'), milestones_only: flag('milestones') || undefined, activity_code: opt('code'), sort: opt('sort'), limit: n('limit'),
        };
      const projIds = opt('project') ? (db.tables.PROJECT?.rows ?? []).filter((p) => p.proj_short_name === opt('project')).map((p) => p.proj_id) : [];
      const res = runTool(tool, qargs, db, makeCtx(db, { hoursPerDay: hpd() }), projIds, hpd());
      console.log(flag('json') ? JSON.stringify(res, null, 2) : queryText(res));
      return (res as { error?: string })?.error ? 66 : 0;
    }
    case 'review': {
      const { db, findings } = load(positional[0]);
      const pre = validateXer(db, findings);
      if (worst(pre) === 'fatal') { printFindings(pre.filter((f) => f.severity === 'fatal')); return 2; }
      const r = reviewSchedule(db, { hoursPerDay: hpd() });
      console.log(flag('json') ? JSON.stringify(r, null, 2) : reviewText(r));
      return r.grade === 'fail' ? 3 : r.grade === 'warn' ? 1 : 0;
    }
    case 'diff': {
      const d = diffDbs(load(positional[0]).db, load(positional[1]).db);
      if (flag('json')) console.log(JSON.stringify(d, null, 2));
      else for (const e of d) console.log(e.kind === 'changed' ? `~ ${e.table}[${e.key}].${e.field}: ${e.a} -> ${e.b}` : `${e.kind === 'added' ? '+' : '-'} ${e.table}[${e.key}]`);
      if (!flag('json')) console.log(`${d.length} difference(s)`);
      return d.length ? 1 : 0;
    }
    default:
      if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return 0; }
      console.error(`unknown command "${cmd}"

${USAGE}`);
      return 64;
  }
}

main().then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(70); });
