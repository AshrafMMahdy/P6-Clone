// Export… on an analysis panel: asks for a folder and runs the real MCP tool with `export: <folder>` (main/analysis-export-ipc.ts),
// so the files are exactly what an agent's call of that tool writes: <tool>.json and <tool>-<table>.csv. The panel's settings are the
// tool's arguments; the export only reports (never an argument that makes a tool change the project). The database is saved first, so
// the export holds what is on the screen. One export runs at a time in the app; while one runs its button says "Cancel export".
import { useSyncExternalStore } from 'react';
import { getDb, getUi, saveNow, toast } from '../store.ts';
import { rows } from '../../core/db.ts';

/** The `project` argument that makes a tool analyse the open projects: none when they are all the projects of the database (the
 *  tool's default), the project's ID when one is open; several open out of more refuse (a tool takes one project or all). */
export function projectArgs(): { project?: string } {
  const all = rows(getDb(), 'PROJECT').filter((p) => !p._baseline_of);
  const open = all.filter((p) => getUi().openProjects.includes(p.proj_id));
  if (open.length === 1) return { project: open[0].proj_short_name };
  if (open.length === all.length) return {};
  throw new Error(`Export analyses one project or all ${all.length} projects of the database; ${open.length} are open. Open one project, or all of them.`);
}

/** A number typed in a panel: nothing for an empty box (a refusal when `needed`), the number, or a refusal (shown as a toast) for text
 *  that is not one. */
export function numberOf(label: string, text: string, needed = false): number | undefined {
  if (text.trim() === '') { if (needed) throw new Error(`${label} is needed.`); return undefined; }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

/** The tool whose export is running (the whole app has one at a time): kept here, not in a button, so a panel that is switched away
 *  from and back still shows it. */
let running: string | null = null;
const listeners = new Set<() => void>();
const setRunning = (t: string | null) => { running = t; for (const l of listeners) l(); };
const useRunning = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => running);

/** The message of a tool's error answer (as callTool and the tools give it), whole. */
function errorText(out: Record<string, any>): string {
  const e = out.error;
  if (typeof e === 'string') return e;
  const m = e?.message ?? e?.reason;
  return m ? `${m}${e.hint ? ` ${e.hint}` : ''}` : JSON.stringify(out).slice(0, 400);
}

/** tool: the MCP tool; args: its arguments from the panel's settings (throw an Error to say why there is nothing to export); parts:
 *  the projects the session holds and the other sessions its arguments name (main/analysis-export.ts). */
export function ExportButton({ tool, args, parts, toolbar }: { tool: string; args: () => Record<string, unknown>; parts?: () => { scope?: string[]; others?: Record<string, string[]> }; toolbar?: boolean }) {
  const now = useRunning();
  const mine = now === tool;
  const go = async () => {
    if (mine) return void (await window.p6.analysisCancel());
    let a: Record<string, unknown>, p: ReturnType<NonNullable<typeof parts>> | undefined;
    try { a = args(); p = parts?.(); } catch (e) { return toast((e as Error).message); }
    if (running) return toast(`An export of ${running} is already running: wait for it, or cancel it.`);
    try {
      if (!(await saveNow())) return toast('The project changed while it was being saved, so nothing was exported. Click Export… again.');
      setRunning(tool);
      const r = await window.p6.analysisExport(tool, a, getUi().prefs.hoursPerDay, p);
      if (!r) return; // the folder dialog was cancelled
      const code = r.out.error?.code;
      if (code === 'export_busy' || code === 'cancelled') return toast(String(r.out.error.message));
      if (r.isError) return toast(`Export of ${tool} failed: ${errorText(r.out)}`);
      if (r.out.export_error) return toast(String(r.out.export_error));
      const x = r.out.exported as { folder: string; files: { path: string }[] } | undefined;
      toast(x ? `Exported ${x.files.length} files of ${tool} to ${x.folder}` : `The ${tool} tool answered without writing files: ${JSON.stringify(r.out).slice(0, 300)}`);
    } catch (e) { toast(`Export of ${tool} failed: ${(e as Error).message}`); } finally { if (running === tool) setRunning(null); }
  };
  const label = mine ? 'Cancel export' : 'Export…';
  const title = mine ? 'Ends the export; nothing is kept' : `Writes the full ${tool} result as ${tool}.json and ${tool}-<table>.csv into a folder`;
  return toolbar
    ? <button className="tbtn" onClick={go} title={title}><span className="lbl">{label}</span></button>
    : <button className="btn" onClick={go} title={title}>{label}</button>;
}
