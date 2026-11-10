// A panel's tool run off the window: the app's database is saved, then the tool runs in the child process of the Export (main/analysis-export-ipc.ts,
// analysis:run) on that saved database, with its own arguments; the answer is the tool's. keepWork: the run shows the tool's progress and
// its Cancel asks the tool to stop and answer what it did (Monte Carlo, Crashing, Lint, Optimize); without it Cancel ends the process, as
// Level resources' does (nothing is kept by the tool there).
import { useEffect, useRef, useState } from 'react';
import { getDb, getDbVersion, getUi, saveNow, useStore } from '../store.ts';
import { changedSince, notRun, runScope, taskIndex, type RunStamp, type ToolAnswer } from './toolAnswers.ts';

export interface Progress { done: number; total: number; message: string }
/** An answer with the state the run was started on (the database version and the open projects): the result is of that state only. */
export type RanAnswer = ToolAnswer & { stamp: RunStamp };
export interface ToolRun { cancel: () => void; done: Promise<RanAnswer>; stamp: RunStamp }

/** The state now: what a result's stamp is compared with. */
export const stampNow = (): RunStamp => ({ dbVersion: getDbVersion(), projects: [...getUi().openProjects] });
/** Whether the project changed since a result was computed (the result is then of an older state: the panel says so, and Apply refuses). Re-renders when it does. */
export function useChangedSince(stamp: RunStamp | null): boolean {
  const dbVersion = useStore((s) => s.dbVersion), open = useStore((s) => s.ui.openProjects);
  return !!stamp && changedSince(stamp, { dbVersion, projects: open });
}
let runCount = 0;

/** Starts the run, on exactly the open projects (analysis:run's scope; the tool's `project` argument is not given). `done` is always an answer:
 *  the tool's, or (as an error) why nothing ran. The run has its own id, so Cancel (and the progress) of one panel never reach another's run. */
export function startToolRun(tool: string, args: Record<string, unknown>, o: { keepWork: boolean; onProgress?: (p: Progress) => void }): ToolRun {
  const id = `${tool}#${++runCount}`, stamp = stampNow();
  let stop = false;
  const cancel = () => { stop = true; void window.p6.analysisCancel({ id }); };
  const done = (async (): Promise<RanAnswer> => {
    const answer = async (): Promise<ToolAnswer> => {
      if (!(await saveNow())) return notRun('not_saved', `The project changed while it was being saved, so ${tool} did not run. Run it again.`);
      if (stop) return notRun('cancelled', `The ${tool} run was cancelled before it started; nothing was changed.`);
      const off = o.keepWork && o.onProgress ? window.p6.onAnalysisProgress((p) => { if (p.id === id) o.onProgress!(p); }) : undefined;
      try { return await window.p6.analysisRun(tool, args, getUi().prefs.hoursPerDay, runScope(stamp.projects), o.keepWork, id); }
      catch (e) { return notRun('export_failed', `The ${tool} run could not start: ${(e as Error).message}`); }
      finally { off?.(); }
    };
    return { ...(await answer()), stamp };
  })();
  return { cancel, done, stamp };
}

/** A panel's run: `running` and the tool's `progress` while it goes; start() gives the answer (null when the panel was left meanwhile:
 *  a run still going then is cancelled, and its answer is not shown). */
export function useToolRun(tool: string, keepWork: boolean) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [asked, setAsked] = useState(false);
  const live = useRef<ToolRun | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; live.current?.cancel(); }; }, []);
  const start = async (args: Record<string, unknown>): Promise<RanAnswer | null> => {
    setRunning(true); setProgress(null); setAsked(false);
    const run = live.current = startToolRun(tool, args, { keepWork, onProgress: (p) => { if (mounted.current) setProgress(p); } });
    try { const r = await run.done; return mounted.current ? r : null; }
    finally { live.current = null; if (mounted.current) { setRunning(false); setProgress(null); setAsked(false); } }
  };
  /** A first Cancel asks the run to stop; a second, while it has not, ends it (its work is not kept). `asked` says the first was made. */
  return { running, progress, start, asked, cancel: () => { live.current?.cancel(); setAsked(true); } };
}

/** The row of an activity in the open projects now, by its Activity ID and Project ID (see taskIndex): null when it is not there. */
export const taskIdLookup = () => taskIndex(getDb(), getUi().openProjects);
