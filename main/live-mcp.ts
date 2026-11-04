// The open schedule, on screen, as an MCP server for the embedded platform agent: its tools are the AI panel's own
// (the lookups on the open projects and the live tools that work the app in front of the user, a cursor gliding to
// what it clicks, every change undoable) and run in the window. Served on a loopback port with a fresh bearer token per
// run (mcp/httpTransport.ts); the agent server is pointed at it through its mcp-servers.json (whiq-host.ts).
import { ipcMain, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { serveMcpHttp } from '../mcp/httpTransport.ts';

export interface LiveTool { name: string; description: string; parameters: Record<string, unknown> }
const INSTRUCTIONS = 'The schedule open in the P6 Clone window in front of the user. These tools read the open projects and work the app '
  + 'visibly: menus open on screen, a cursor moves to what is clicked, typing appears, every change can be undone (Ctrl+Z) and deletions ask '
  + 'the user first. Use them to act on the open schedule; use the p6clone engine tools for files. To run your own schedule '
  + 'tools on the open project (review_programme, forecast_outcome, run_cpm, monte_carlo, ...), export_project saves it into '
  + 'the working folder; import_schedule_file that path, then work on its handle (changes there do not reach the app: make '
  + 'them with edit_project).';

export async function startLiveMcp(getWin: () => BrowserWindow | null): Promise<{ url: string; token: string; close: () => void }> {
  let next = 0;
  const waiting = new Map<number, (v: { ok: boolean; result?: unknown; error?: string }) => void>();
  ipcMain.on('live:reply', (_e, id: number, v: { ok: boolean; result?: unknown; error?: string }) => { waiting.get(id)?.(v); waiting.delete(id); });
  /** A request run in the window; refused when no window is there or it does not answer in time. */
  const ask = (kind: 'list' | 'call', payload: unknown, ms: number) => new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return resolve({ ok: false, error: 'The P6 Clone window is not open.' });
    const id = ++next;
    const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'The P6 Clone window did not answer in time.' }); }, ms);
    waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
    win.webContents.send('live:call', id, kind, payload);
  });
  const token = randomBytes(24).toString('hex');
  const server = await serveMcpHttp({ port: 0, host: '127.0.0.1', token }, async (m) => {
    const reply = (result: unknown) => (m.id !== undefined ? { jsonrpc: '2.0', id: m.id, result } : undefined);
    const error = (code: number, message: string) => (m.id !== undefined ? { jsonrpc: '2.0', id: m.id, error: { code, message } } : undefined);
    switch (m.method) {
      case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'p6-clone-live', version: '1' }, instructions: INSTRUCTIONS });
      case 'ping': return reply({});
      case 'tools/list': {
        const r = await ask('list', null, 15_000);
        if (!r.ok) return error(-32603, r.error ?? 'No tools.');
        return reply({ tools: (r.result as LiveTool[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      }
      case 'tools/call': {
        // on-screen work waits for the user where the app asks them (a deletion to confirm): no short cut-off
        const r = await ask('call', { name: m.params?.name, args: m.params?.arguments ?? {} }, 30 * 60_000);
        const out = r.ok ? r.result : { error: r.error };
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        return reply({ content: [{ type: 'text', text }], isError: !r.ok || !!(out as { error?: unknown })?.error });
      }
      default: return m.method?.startsWith('notifications/') ? undefined : error(-32601, `Unknown method ${m.method}.`);
    }
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, token, close: server.close };
}
