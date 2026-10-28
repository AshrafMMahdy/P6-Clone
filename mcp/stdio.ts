// MCP over stdio: JSON-RPC 2.0, one message per line (one agent per process).
import { Worker } from 'node:worker_threads';
import { callTool, toolResult, toolsList, shutdown, SERVER_INFO, INSTRUCTIONS } from './server.ts';
import { onJobChange } from './runtime.ts';

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

/** The stdio front: a thread of its own reads stdin and writes stdout, so the server answers job_status (and ping)
 *  within a second even while a long step of a job holds the main thread (a Monte Carlo iteration, a crash step, a
 *  big save): a platform's liveness check can tell busy from frozen. Every request goes to the main thread as before;
 *  a job_status the main thread has not answered after 400 ms while it is busy (no heartbeat for 400 ms) is answered
 *  by the front from the job's last state, which the main thread posts as the job starts, moves and ends; a
 *  server_status likewise after 1.5 s, from the state the main thread posts every second (busy: true, and how old it is). The main
 *  thread's late answer to that request is then dropped. P6CLONE_STDIO_THREAD=0 reads stdin on the main thread. */
const FRONT = String.raw`
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const jobs = new Map(), waiting = new Map();
let lastStatus = null; // server_status as the main thread last answered it
let beat = Date.now(), buf = '';
const write = (s) => { const b = Buffer.from(s + '\n', 'utf8'); for (let at = 0; at < b.length;) { try { at += fs.writeSync(1, b, at, b.length - at); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
const result = (out) => ({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false });
const fallback = (id) => {
  const w = waiting.get(id); if (!w) return;
  if (Date.now() - beat < 400) { w.timer = setTimeout(() => fallback(id), 150); return; }
  if (w.status) {
    // a server_status is answered from the posted state only in a real long step (no heartbeat for 1.5 s), and only
    // once a state was posted: a loaded host's short pauses still get the main thread's own, current answer
    if (Date.now() - beat < 1500 || !lastStatus) { w.timer = setTimeout(() => fallback(id), 150); return; }
    waiting.delete(id); w.answered = true; answered.add(id);
    write(JSON.stringify({ jsonrpc: '2.0', id, result: result({ ...lastStatus, busy: true, status_age_seconds: Math.round((Date.now() - lastStatus.at) / 1000), at: undefined, note: 'The server is in a long step of a call (still working); this is its state as of status_age_seconds ago.' }) }));
    return;
  }
  const j = jobs.get(String(w.job));
  if (!j) { w.timer = setTimeout(() => fallback(id), 150); return; }
  waiting.delete(id); w.answered = true; answered.add(id);
  write(JSON.stringify({ jsonrpc: '2.0', id, result: result({ ...j, running_seconds: Math.round((Date.now() - j.started) / 1000), started: undefined, busy: true, note: 'The server is in a long step of this job (still working); this is its last progress. Call job_status again shortly.' }) }));
};
const answered = new Set();
parentPort.on('message', (m) => {
  if (m.type === 'beat') { beat = Date.now(); return; }
  // every reply posted before this one is written (messages come in order; writes are synchronous)
  if (m.type === 'flush') { parentPort.postMessage({ type: 'flushed' }); return; }
  if (m.type === 'job') { if (m.view) jobs.set(m.id, m.view); else jobs.delete(m.id); return; }
  if (m.type === 'status') { lastStatus = { ...m.view, at: Date.now() }; return; }
  if (m.type === 'send') {
    const id = m.id;
    if (id != null && answered.has(id)) { answered.delete(id); return; } // answered from the job's last state already
    const w = id != null ? waiting.get(id) : undefined; if (w) { clearTimeout(w.timer); waiting.delete(id); }
    write(m.line);
  }
});
// a pipe is read as a socket (event driven, nothing waits in the thread pool, so the process can always exit);
// a file or a terminal as a stream
let s;
try { const t = fs.fstatSync(0); s = t.isFIFO() || t.isSocket() ? new (require('node:net').Socket)({ fd: 0, readable: true, writable: false }) : fs.createReadStream(null, { fd: 0 }); }
catch { s = fs.createReadStream(null, { fd: 0 }); }
s.setEncoding('utf8');
s.on('data', (chunk) => {
  buf += chunk;
  // every line of a chunk goes to the main thread in ONE message, handled in one turn there: a notifications/cancelled written right after its
  // tools/call (one write) reaches the call before the call's first await returns, whatever the scheduler does between two posts
  const batch = [];
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m = null; try { m = JSON.parse(line); } catch { /* the main thread answers the parse error */ }
    if (m && m.method === 'ping' && m.id != null) { write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })); continue; }
    if (m && m.id != null && m.method === 'tools/call' && m.params && (m.params.name === 'job_status' || m.params.name === 'server_status')) {
      const w = { job: m.params.arguments && m.params.arguments.job_id, status: m.params.name === 'server_status', answered: false, timer: null };
      waiting.set(m.id, w); w.timer = setTimeout(() => fallback(m.id), 400);
    }
    batch.push(line);
  }
  if (batch.length) parentPort.postMessage({ type: 'lines', lines: batch });
});
s.on('end', () => parentPort.postMessage({ type: 'end' }));
s.on('error', () => parentPort.postMessage({ type: 'end' }));
`;

/** The lines of one read, handled in order in ONE turn of the event loop: a call's first await cannot return before the lines after it (its
 *  notifications/cancelled) have been handled. */
export function handleLines(lines: string[], send: (m: unknown) => void): void {
  for (const line of lines) {
    let m: Msg;
    try { m = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    void handleMessage(m, undefined, send).then(send, (e) => send({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32603, message: String((e as Error).message) } }));
  }
}

export function startStdio(): void {
  if (process.env.P6CLONE_STDIO_THREAD === '0') return startStdioMain();
  let front: Worker;
  try { front = new Worker(FRONT, { eval: true, stdin: false, stdout: false, stderr: false }); } catch { return startStdioMain(); }
  const send = (m: unknown) => { if (m) front.postMessage({ type: 'send', id: (m as { id?: unknown }).id ?? null, line: JSON.stringify(m) }); };
  // the job's state as the front answers it while the main thread is busy
  onJobChange((id, view) => front.postMessage({ type: 'job', id, view: view && view.status === 'running' ? { ...view, started: Date.now() - (view.running_seconds ?? 0) * 1000 } : null }));
  setInterval(() => front.postMessage({ type: 'beat' }), 100).unref();
  // server_status as it is now, every second, for the front to answer from while a long step holds this thread
  setInterval(() => { void callTool('server_status', {}).then((r) => { if (!r.isError) front.postMessage({ type: 'status', view: r.out }); }, () => {}); }, 1000).unref();
  // at the end of stdin: calls still running finish first (up to 30 s), then the front writes every reply it holds,
  // and only then does the process stop (stopping at once lost replies still on their way to the front)
  let flushed: (() => void) | null = null;
  const stop = () => { const done = () => shutdown('stdin closed'); flushed = done; front.postMessage({ type: 'flush' }); setTimeout(done, 5000).unref(); };
  front.on('message', (x: { type: string; line?: string; lines?: string[] }) => {
    if (x.type === 'flushed') { flushed?.(); return; }
    if (x.type === 'end') { const t0 = Date.now(); const wait = () => (running.size && Date.now() - t0 < 30000 ? setTimeout(wait, 50) : stop()); wait(); return; }
    handleLines(x.lines ?? [x.line ?? ''], send);
  });
  front.on('error', (e) => { process.stderr.write(`P6 Clone: the stdio thread stopped (${(e as Error).message}); stopping.\n`); shutdown('stdio thread failed'); });
}

function startStdioMain(): void {
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
