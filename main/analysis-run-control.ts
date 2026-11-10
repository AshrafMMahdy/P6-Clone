// The parts of the Export / panel-run child process (main/analysis-export-ipc.ts) that decide things, with no Electron in them so the
// tests can run them: how a Cancel is carried out, what the child's stdout answered, and the private temporary folders of the runs.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** What the child answered (callTool's answer), or why it could not: always an answer the panel can show. */
export type ExportAnswer = { isError: boolean; out: Record<string, any> };
export const refused = (code: string, message: string): ExportAnswer => ({ isError: true, out: { error: { code, message } } });

// ---------------------------------------------------------------- Cancel
/** The run a Cancel is for: whether it was already cancelled, whether it keeps its work (asked to stop, it answers what it did), and whether it was ended. */
export interface Cancellable { cancelled: boolean; keepWork: boolean; ended: boolean }
/** The child as a Cancel sees it: the line "cancel" to its stdin (false when it cannot be written), and the end of its whole process tree. */
export interface CancelTarget { askToStop: () => boolean; end: () => void }
/** Whether a Cancel with `only` (the id of a panel's run) is for this run: another panel's Cancel is not. Without `only`, every run. */
export const matchesCancel = (run: { id?: string }, only?: { id: string }): boolean => !only || run.id === only.id;
/** What a Cancel did: 'flagged' (no child yet: it stops before it starts), 'asked' (the tool is asked to stop and answer what it did), or
 *  'ended' (the process tree ended: a run that keeps nothing, or a second Cancel while the first has not stopped the run). No timer: the
 *  user decides when a run that does not answer is to be ended. */
export type CancelResult = 'flagged' | 'asked' | 'ended';
export function cancelRun(run: Cancellable, child: CancelTarget | null): CancelResult {
  const again = run.cancelled;
  run.cancelled = true;
  if (!child) return 'flagged';
  if (run.keepWork && !again && child.askToStop()) return 'asked';
  run.ended = true;
  child.end();
  return 'ended';
}
/** The answer of a run that was ended: said as it was, not as an answer lost. */
export const endedAnswer = (tool: string): ExportAnswer => refused('cancelled', `The ${tool} run was ended: it did not stop when asked, so its work was not kept; nothing was changed.`);

// ---------------------------------------------------------------- the child's answer
/** The answer on the child's stdout: its last non-empty line that is not a progress line. Any other line (a dependency's stray output) is ignored
 *  while the answer is there, and kept for the words when it is not. `lines`: the non-progress, non-empty lines in order; `stderr`: the child's
 *  error text; `code`: its exit code. */
export function answerOf(lines: string[], code: number | null, stderr: string): ExportAnswer {
  const last = lines[lines.length - 1];
  if (last !== undefined) {
    try { const a = JSON.parse(last); if (a && typeof a === 'object' && 'isError' in a && 'out' in a) return a as ExportAnswer; } catch { /* not an answer: said below */ }
  }
  const stray = lines.join('\n').slice(-600);
  return refused('export_failed', `The export program stopped (exit ${code}) without an answer.${stderr ? ` ${stderr.slice(-600)}` : ''}${stray ? ` Its other output: ${stray}` : ''}`);
}

// ---------------------------------------------------------------- the private temporary folders
/** A run's private folder in `tmp`: p6export-<process id>-<random>, so a folder left behind says which app process made it. */
export const makeRunDir = (tmp: string, pid: number): string => mkdtempSync(join(tmp, `p6export-${pid}-`));
/** Whether a process is running (signal 0 only asks; a process this one may not signal still exists). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** A run's private folder removed now (synchronously: for an app that is quitting, where an async close may never run). False when it could not be
 *  (a file still open): removeLeftBehind removes it at the next start. */
export function removeRunDir(dir: string): boolean {
  try { rmSync(dir, { recursive: true, force: true }); return !existsSync(dir); } catch { return false; }
}
/** Removes the p6export-* folders in `tmp` that no running app owns: the folder of a process that is gone (an app that quit or crashed mid-run), and
 *  the folders of the older naming (p6export-<random>, no process id), which no run of this build makes. A folder whose process is still running
 *  is left (it is that run's, or another running app's). No age is looked at. Returns the folders removed. */
export function removeLeftBehind(tmp: string, alive: (pid: number) => boolean = isAlive): string[] {
  const gone: string[] = [];
  let names: string[];
  try { names = readdirSync(tmp); } catch { return gone; }
  for (const n of names) {
    if (!n.startsWith('p6export-')) continue;
    const m = /^p6export-(\d+)-/.exec(n);
    if (m && alive(Number(m[1]))) continue;
    const p = join(tmp, n);
    try { rmSync(p, { recursive: true, force: true }); if (!existsSync(p)) gone.push(n); } catch { /* still in use: the next start looks again */ }
  }
  return gone;
}
