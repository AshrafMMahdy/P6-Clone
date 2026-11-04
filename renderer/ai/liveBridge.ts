// The window's side of the open schedule's MCP server (main/live-mcp.ts): it lists the AI panel's tools and runs a
// call the embedded platform agent makes, exactly as the panel runs its own (the lookups on the open projects, and
// the live tools on screen with their cursor, undo and delete prompts).
import { TOOLS, runTool } from '../../core/query/tools.ts';
import { LIVE_TOOLS, runLive } from './live.ts';
import { getDb, getUi } from '../store.ts';
import { makeCtx } from '../model.ts';

export function initLiveBridge(): () => void {
  return window.p6.onLiveCall(async (id, kind, payload) => {
    try {
      if (kind === 'list') return window.p6.liveReply(id, { ok: true, result: [...TOOLS, ...LIVE_TOOLS] });
      const { name, args } = payload as { name: string; args: Record<string, any> };
      const known = [...TOOLS, ...LIVE_TOOLS].some((t) => t.name === name);
      if (!known) return window.p6.liveReply(id, { ok: false, error: `No tool "${name}".` });
      const ui = getUi();
      const result = LIVE_TOOLS.some((t) => t.name === name) ? await runLive(name, args ?? {}) : runTool(name, args ?? {}, getDb(), makeCtx(getDb(), ui.prefs), ui.openProjects, ui.prefs.hoursPerDay);
      window.p6.liveReply(id, { ok: true, result });
    } catch (e) {
      window.p6.liveReply(id, { ok: false, error: (e as Error).message });
    }
  });
}
