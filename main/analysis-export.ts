// Export of an analysis, run as a child process so a long tool never blocks the window: the app's saved database is read, a session
// is made of it for the MCP server's own engine (the bundle dist/p6clone-mcp-app.cjs: the name is how mcp/compute.ts finds the file its
// compute worker threads run), the tool is called with `export: <folder>` and its answer is printed as JSON on stdout.
//   request on stdin, its first line: { file (the export's snapshot of the database), tool, args, hoursPerDay, scope?, others?, progress? }
//     a later line "cancel" cancels the call as notifications/cancelled does: the tool stops at its next step and answers what it did
//     (partial); the child is not ended, its answer is the tool's. progress: true prints the tool's progress, one JSON line each
//     {"progress": {done, total, message}}, before the answer
//     scope:  Project IDs the session holds (default: the whole database)
//     others: { key: Project IDs }: more sessions, each with only those projects; a string "@key" in args is that session's handle
//   answer on stdout, the last line: { out, isError } as callTool answers
// Run on Electron's Node (ELECTRON_RUN_AS_NODE), started with -e so that mcp/server.ts does not take this file for its own entry (it
// starts its stdio server when process.argv[1] names it).
import { isMainThread } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DbReader } from '../core/db-file.ts';
import { onlyProjects } from '../renderer/analysisDb.ts';
import { callTool } from '../mcp/server.ts';
import { config, createSession, estimateBytes } from '../mcp/runtime.ts';

export interface ExportRequest { file: string; tool: string; args: Record<string, unknown>; hoursPerDay: number; scope?: string[]; others?: Record<string, string[]>; progress?: boolean }

const swap = (v: unknown, handles: Map<string, string>): unknown => {
  if (typeof v === 'string') return v.startsWith('@') && handles.has(v.slice(1)) ? handles.get(v.slice(1)) : v;
  if (Array.isArray(v)) return v.map((x) => swap(x, handles));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, handles)]));
  return v;
};

/** The request (the first line of stdin) and, as the parent writes them later, its "cancel" lines (the parent of an export ends stdin
 *  after the request: that is not a cancel). */
async function readRequest(onCancel: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let first = true;
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => { if (first) { first = false; resolve(line); } else if (line.trim() === 'cancel') onCancel(); });
    rl.on('close', () => { if (first) reject(new Error('No request was given.')); });
  });
}

async function main(): Promise<{ out: unknown; isError: boolean }> {
  const abort = new AbortController();
  const req = JSON.parse(await readRequest(() => abort.abort())) as ExportRequest;
  const reader = new DbReader();
  for await (const line of createInterface({ input: createReadStream(req.file, 'utf8'), crlfDelay: Infinity })) reader.add(line);
  const { db } = reader.finish();
  if (!db?.tables) throw new Error(`${req.file} holds no database.`);
  // a call that outlasts the soft time becomes a job there; here the answer is what is waited for
  config.softTimeoutMs = 2 ** 31 - 1;
  // each session is charged for what it holds (as runtime.ts regrow estimates a grown project: from its row count), and the handle
  // limit is what this call needs: the base and the others
  const held = (d: typeof db) => estimateBytes(Object.values(d.tables).reduce((n, t) => n + t.rows.length, 0) * 250);
  config.maxHandles = 1 + Object.keys(req.others ?? {}).length;
  const own = req.scope ? onlyProjects(db, req.scope) : db;
  const base = createSession(own, { path: null, format: 'xer', hpd: req.hoursPerDay, bytes: held(own), dirty: false });
  const handles = new Map<string, string>();
  for (const [key, ids] of Object.entries(req.others ?? {})) { const o = onlyProjects(db, ids); handles.set(key, createSession(o, { path: null, format: 'xer', hpd: req.hoursPerDay, bytes: held(o), dirty: false }).handle); }
  const progress = req.progress ? (done: number, total: number, message: string) => { process.stdout.write(`${JSON.stringify({ progress: { done, total, message } })}\n`); } : undefined;
  return callTool(req.tool, { ...(swap(req.args, handles) as Record<string, unknown>), handle: base.handle }, undefined, abort.signal, progress);
}

if (isMainThread) {
  const done = (r: { out: unknown; isError: boolean }) => process.stdout.write(JSON.stringify(r), () => process.exit(0));
  const fail = (e: unknown) => done({ isError: true, out: { error: { code: 'internal', message: (e as Error)?.message ?? String(e) } } });
  process.on('uncaughtException', fail);
  main().then(done, fail);
}
