// MCP over stdio: JSON-RPC 2.0, one message per line (one agent per process).
import { callTool, toolResult, toolsList, shutdown, SERVER_INFO, INSTRUCTIONS } from './server.ts';

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any };
/** Running tools/call requests by caller and request id, for notifications/cancelled. */
const running = new Map<string, AbortController>();

/** Answer one JSON-RPC message (shared by the stdio and HTTP transports). Returns undefined for notifications. */
/** notify: sends a notification to the client while a call runs (notifications/progress for a progressToken). */
export async function handleMessage(m: Msg, sessionCaller?: string, notify?: (n: unknown) => void): Promise<unknown | undefined> {
  const reply = (result: unknown) => (m.id !== undefined ? { jsonrpc: '2.0', id: m.id, result } : undefined);
  const error = (code: number, message: string) => (m.id !== undefined ? { jsonrpc: '2.0', id: m.id, error: { code, message } } : undefined);
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case 'notifications/initialized': return undefined;
    case 'notifications/cancelled': running.get(`${sessionCaller ?? ''}|${m.params?.requestId}`)?.abort(); return undefined;
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: toolsList() });
    case 'tools/call': {
      const key = `${sessionCaller ?? ''}|${m.id}`, abort = new AbortController();
      if (m.id !== undefined) running.set(key, abort);
      try {
        const token = m.params?._meta?.progressToken;
        const progress = token != null && notify ? (done: number, total: number, message: string) => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } }) : undefined;
        const { out, isError } = await callTool(String(m.params?.name ?? ''), (m.params?.arguments ?? {}) as Record<string, any>, sessionCaller, abort.signal, progress);
        return reply(toolResult(out, isError, String(m.params?.name ?? '')));
      } finally { if (running.get(key) === abort) running.delete(key); }
    }
    default: return error(-32601, `Method not found: ${m.method}`);
  }
}

export function startStdio(): void {
  const send = (m: unknown) => { if (m) process.stdout.write(JSON.stringify(m) + '\n'); };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m: Msg;
      try { m = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      void handleMessage(m, undefined, send).then(send, (e) => send({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32603, message: String((e as Error).message) } }));
    }
  });
  // calls still running finish first (up to 30 s), so their changes are in the save at exit
  process.stdin.on('end', () => { const t0 = Date.now(); const wait = () => (running.size && Date.now() - t0 < 30000 ? setTimeout(wait, 50) : shutdown('stdin closed')); wait(); });
}
