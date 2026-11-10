// A panel's tool run off the window: the app's database is saved, then the tool runs in the child process of the Export (main/analysis-export-ipc.ts,
// analysis:run) on that saved database, with its own arguments; the answer is the tool's. keepWork: the run shows the tool's progress and
// its Cancel asks the tool to stop and answer what it did (Monte Carlo, Crashing, Lint, Optimize); without it Cancel ends the process, as
// Level resources' does (nothing is kept by the tool there).
import { useEffect, useRef, useState } from 'react';
import { getDb, getUi, saveNow } from '../store.ts';
import { rows } from '../../core/db.ts';
import { notRun, type ToolAnswer } from './toolAnswers.ts';

export interface Progress { done: number; total: number; message: string }
export interface ToolRun { cancel: () => void; done: Promise<ToolAnswer> }

/** Starts the run. `done` is always an answer: the tool's, or (as an error) why nothing ran. */
export function startToolRun(tool: string, args: Record<string, unknown>, o: { keepWork: boolean; onProgress?: (p: Progress) => void }): ToolRun {
  let stop = false;
  const cancel = () => { stop = true; void window.p6.analysisCancel({ tool, exporting: false }); };
  const done = (async (): Promise<ToolAnswer> => {
    if (!(await saveNow())) return notRun('not_saved', `The project changed while it was being saved, so ${tool} did not run. Run it again.`);
    if (stop) return notRun('cancelled', `The ${tool} run was cancelled before it started; nothing was changed.`);
    const off = o.keepWork && o.onProgress ? window.p6.onAnalysisProgress((p) => { if (p.tool === tool) o.onProgress!(p); }) : undefined;
    try { return await window.p6.analysisRun(tool, args, getUi().prefs.hoursPerDay, undefined, o.keepWork); }
    catch (e) { return notRun('export_failed', `The ${tool} run could not start: ${(e as Error).message}`); }
    finally { off?.(); }
  })();
  return { cancel, done };
}

/** A panel's run: `running` and the tool's `progress` while it goes; start() gives the answer (null when the panel was left meanwhile:
 *  a run still going then is cancelled, and its answer is not shown). */
export function useToolRun(tool: string, keepWork: boolean) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const live = useRef<ToolRun | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; live.current?.cancel(); }; }, []);
  const start = async (args: Record<string, unknown>): Promise<ToolAnswer | null> => {
    setRunning(true); setProgress(null);
    const run = live.current = startToolRun(tool, args, { keepWork, onProgress: (p) => { if (mounted.current) setProgress(p); } });
    try { const r = await run.done; return mounted.current ? r : null; }
    finally { live.current = null; if (mounted.current) { setRunning(false); setProgress(null); } }
  };
  return { running, progress, start, cancel: () => live.current?.cancel() };
}

/** The row of an Activity ID in the open projects (the answer of a tool names activities by ID; a click goes to the row). */
export function taskIdLookup(): (code: string) => string {
  const open = new Set(getUi().openProjects), by = new Map<string, string>();
  for (const t of rows(getDb(), 'TASK')) if (open.has(t.proj_id) && !by.has(t.task_code)) by.set(t.task_code, t.task_id);
  return (code) => by.get(code) ?? '';
}
