// The window's side of the open schedule's MCP server (main/live-mcp.ts): it lists the AI panel's tools and runs a
// call the embedded platform agent makes, exactly as the panel runs its own (the lookups on the open projects, and
// the live tools on screen with their cursor, undo and delete prompts). One tool is the agent's only: the open project
// saved as a schedule file in its working folder, for its own schedule tools (import_schedule_file and what reads it).
import { TOOLS, runTool, type ToolDef } from '../../core/query/tools.ts';
import { rows } from '../../core/db.ts';
import { LIVE_TOOLS, runLive } from './live.ts';
import { getDb, getUi } from '../store.ts';
import { makeCtx } from '../model.ts';
import { exportFile } from '../io.ts';

const AGENT_TOOLS: ToolDef[] = [
  { name: 'export_project', description: 'Save an open project as a schedule file in this chat\'s working folder (00_INPUTS/) for your own schedule tools: then import_schedule_file with the returned path, and review_programme, forecast_outcome, run_cpm, monte_carlo and the rest on its handle. format: xer (default) or xml (P6 XML). project: its Project ID (default: the first open project). Changes nothing in the app.', parameters: { type: 'object', properties: { project: { type: 'string' }, format: { type: 'string', enum: ['xer', 'xml'] } } } },
];

async function exportProject(args: Record<string, any>): Promise<unknown> {
  const db = getDb(), open = getUi().openProjects;
  const projects = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const p = args.project ? projects.find((x) => x.proj_short_name === String(args.project)) : projects.find((x) => open.includes(x.proj_id));
  if (!p) return { error: args.project ? `No project "${args.project}".` : 'No project is open.' };
  const format = args.format === 'xml' ? 'xml' : 'xer';
  const notes: string[] = [];
  const bytes = exportFile(db, format, { version: '19.12', projIds: [p.proj_id], report: notes });
  const r = await window.p6.whiq.saveInput(`${p.proj_short_name}.${format}`, bytes);
  return r.ok ? { path: r.data.path, project: p.proj_short_name, format, ...(notes.length ? { notes } : {}) } : { error: r.error };
}

export function initLiveBridge(): () => void {
  const all = [...TOOLS, ...LIVE_TOOLS, ...AGENT_TOOLS];
  return window.p6.onLiveCall(async (id, kind, payload) => {
    try {
      if (kind === 'list') return window.p6.liveReply(id, { ok: true, result: all });
      const { name, args } = payload as { name: string; args: Record<string, any> };
      if (!all.some((t) => t.name === name)) return window.p6.liveReply(id, { ok: false, error: `No tool "${name}".` });
      const ui = getUi();
      const result = name === 'export_project' ? await exportProject(args ?? {})
        : LIVE_TOOLS.some((t) => t.name === name) ? await runLive(name, args ?? {}) : runTool(name, args ?? {}, getDb(), makeCtx(getDb(), ui.prefs), ui.openProjects, ui.prefs.hoursPerDay);
      window.p6.liveReply(id, { ok: true, result });
    } catch (e) {
      window.p6.liveReply(id, { ok: false, error: (e as Error).message });
    }
  });
}
