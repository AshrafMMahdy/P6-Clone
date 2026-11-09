// Export… on the analysis panels: asks for a folder, then runs the analysis tool with `export: <folder>` in a child process
// (dist/p6clone-mcp-app.cjs, main/analysis-export.ts) on a snapshot of the app's saved database, so a long tool never blocks the window.
// The renderer has saved the database just before (renderer/views/ExportButton.tsx), so the export holds the screen's unsaved edits.
// A panel whose analysis is too heavy for the window (Level resources) runs its tool the same way, without export, and shows the
// tool's answer (analysis:run). One child at a time for the whole app (an export or a run); it can be cancelled (the child's whole
// process tree is ended), and the child is ended when the app quits. Each export has a private temporary folder: the database snapshot the child reads, its working folder and its
// temporary folder (kept work in progress, recovery files); it is removed when the child ends, however it ends. Nobody can resume an
// in-app Export, so nothing is left behind there.
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportRequest } from './analysis-export.ts';

/** What the child answered (callTool's answer), or why it could not: always an answer the panel can show. */
export type ExportAnswer = { isError: boolean; out: Record<string, any> };
const refused = (code: string, message: string): ExportAnswer => ({ isError: true, out: { error: { code, message } } });

/** The child's own file, beside this bundle (dist/ in development and in the packaged app). */
const ENTRY = () => join(__dirname, 'p6clone-mcp-app.cjs');

/** The export or run that is going: its tool, its child, its private folder, whether it was cancelled, and whether it is an export. */
type Current = { tool: string; child: ChildProcess | null; dir: string | null; cancelled: boolean; exporting: boolean };
let current: Current | null = null;
const busy = (c: Current) => refused('export_busy', `${c.exporting ? 'An export' : 'A run'} of ${c.tool} is already running: wait for it, or cancel it.`);
/** The snapshot of the saved database in the private folder, for the child; false when cancelled meanwhile. */
async function snapshot(mine: Current, dbFile: string): Promise<boolean> {
  mine.dir = mkdtempSync(join(tmpdir(), 'p6export-'));
  await copyFile(dbFile, join(mine.dir, 'database.json'));
  return !mine.cancelled;
}
/** The child gone (ended if it still runs) and the private folder removed, however the export or run ended. */
function end(mine: Current): void {
  if (mine.child) killTree(mine.child);
  if (mine.dir) rmSync(mine.dir, { recursive: true, force: true });
  current = null;
}

/** Ends a process and everything under it (the worker threads are in it; any process it started is in its tree). */
function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

function runChild(req: ExportRequest, dir: string): Promise<ExportAnswer> {
  const entry = ENTRY();
  if (!existsSync(entry)) return Promise.resolve(refused('export_failed', `The export program is missing (${entry}): build the app again.`));
  return new Promise((resolve) => {
    // -e: process.argv[1] stays empty, so the server module does not start its own stdio server (it does when argv[1] names it)
    // cwd and TEMP: the export's private folder, where a long run keeps its work in progress (Monte Carlo iterations, scenarios)
    // the .mpp reader in the packaged app is the one the p6clone engine ships (the repository's .cache/mpxj in development)
    const mpxj = app.isPackaged ? { P6CLONE_MPXJ: join(process.resourcesPath, 'whiq-agent', 'engines', 'p6clone', 'mpxj') } : {};
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(entry)})`], { cwd: dir, env: { ...process.env, ...mpxj, ELECTRON_RUN_AS_NODE: '1', TEMP: dir, TMP: dir, TMPDIR: dir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    if (current) current.child = child;
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => resolve(refused('export_failed', `The export program could not start: ${e.message}`)));
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      try { resolve(JSON.parse(text) as ExportAnswer); }
      catch { resolve(refused('export_failed', `The export program stopped (exit ${code}) without an answer.${err.length ? ` ${Buffer.concat(err).toString('utf8').slice(-600)}` : ''}`)); }
    });
    child.stdin.on('error', () => { /* the child ended first: its close says why */ });
    child.stdin.end(JSON.stringify(req));
  });
}

/** The files this export wrote in the chosen folder before it was cancelled (the tool's own names, newer than its start). */
function written(folder: string, tool: string, since: number): string[] {
  try { return readdirSync(folder).filter((f) => (f === `${tool}.json` || (f.startsWith(`${tool}-`) && f.endsWith('.csv'))) && statSync(join(folder, f)).mtimeMs >= since); }
  catch { return []; }
}

export function registerAnalysisExport(getWin: () => BrowserWindow | null, dbFile: () => string): void {
  /** null when the folder dialog is cancelled. */
  ipcMain.handle('analysis:export', async (_e, tool: string, args: Record<string, unknown>, hoursPerDay: number, parts?: { scope?: string[]; others?: Record<string, string[]> }): Promise<ExportAnswer | null> => {
    if (current) return busy(current);
    const mine: Current = current = { tool, child: null, dir: null, cancelled: false, exporting: true };
    try {
      const r = await dialog.showOpenDialog(getWin()!, { title: 'Folder for the exported files', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      const folder = r.filePaths[0], since = Date.now();
      if (!(await snapshot(mine, dbFile()))) return refused('cancelled', `The export of ${tool} was cancelled; nothing was written.`);
      const answer = await runChild({ file: join(mine.dir!, 'database.json'), tool, args: { ...args, export: folder }, hoursPerDay, ...parts }, mine.dir!);
      if (!mine.cancelled) return answer;
      const files = written(folder, tool, since);
      return refused('cancelled', `The export of ${tool} was cancelled.${files.length ? ` Already written in ${folder}: ${files.join(', ')}.` : ' Nothing was written.'}`);
    } catch (e) {
      return refused('export_failed', `The export of ${tool} could not start: ${(e as Error).message}`);
    } finally { end(mine); }
  });
  /** A panel's analysis run as its tool, without export, in the same child on the saved database: the tool's answer (the panel
   *  passes the arguments of a call that changes nothing, as Export does). */
  ipcMain.handle('analysis:run', async (_e, tool: string, args: Record<string, unknown>, hoursPerDay: number, parts?: { scope?: string[]; others?: Record<string, string[]> }): Promise<ExportAnswer> => {
    if (current) return busy(current);
    const mine: Current = current = { tool, child: null, dir: null, cancelled: false, exporting: false };
    const stopped = () => refused('cancelled', `The ${tool} run was cancelled; nothing was changed.`);
    try {
      if (!(await snapshot(mine, dbFile()))) return stopped();
      const answer = await runChild({ file: join(mine.dir!, 'database.json'), tool, args, hoursPerDay, ...parts }, mine.dir!);
      return mine.cancelled ? stopped() : answer;
    } catch (e) {
      return refused('export_failed', `The ${tool} run could not start: ${(e as Error).message}`);
    } finally { end(mine); }
  });
  /** Ends the running export's or run's child (and its tree); its answer says it was cancelled. With only, just that tool's run (or export).
   *  One cancelled while its database is still being copied stops before its child starts (snapshot). */
  ipcMain.handle('analysis:cancel', (_e, only?: { tool: string; exporting: boolean }) => {
    if (!current || (only && (current.tool !== only.tool || current.exporting !== only.exporting))) return false;
    current.cancelled = true;
    if (current.child) killTree(current.child);
    return true;
  });
  app.on('before-quit', () => { if (current?.child) killTree(current.child); });
}
