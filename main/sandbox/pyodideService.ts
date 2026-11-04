// The desktop code sandbox for PCs without WSL: the contract of the platform's local sandbox (09 Local Sandbox/service.py) answered
// with Pyodide, Python compiled to WebAssembly, jailed inside Chromium's renderer sandbox (pyodideSession.ts). The platform's client
// (localSandbox.ts, VM_SANDBOX=on, VM_SANDBOX_URL=<url>) talks to it unchanged.
//   GET /health /selftest     POST /create /kill /keepalive /interrupt /write /run     (JSON, 127.0.0.1 only)
// The self-test (pyodideSelftest.ts) runs once at start and proves the jail on this machine; while it has not passed, every POST is
// refused with 503 jail_unavailable. Python only: shell and Node answer with a clear exit-127 result.
//
// In main.ts, before app ready:   registerSandboxScheme();   (or registerSandboxScheme([...the program's other privileged schemes]): Electron takes them in one call)
// Then:                           const sb = await startPyodideSandbox({ dir: <vendor/pyodide, or resources/pyodide when packaged> });
// Optional settings (the names are service.py's): VM_SANDBOX_FILE_MB (512), VM_SANDBOX_DISK_MB (2048), VM_SANDBOX_IDLE_S (3600).
// Added here, because a session is a whole Chromium page with Pyodide (about half a GB of the app's memory each): VM_SANDBOX_MAX_SESSIONS (2).
// A session that has to make room is the least recently used one that is not running a cell; if every one is running, the request is refused (503).
// A session the service ends on its own (to make room, or idle) is saved first the way the platform snapshots a sandbox (pyodideSnapshot.ts: its files and
// its picklable variables, on disk under the app's user data for 24 h, 2 GB in all) and put back when the id comes again; the first run says so.
// Settings for that: P6_SANDBOX_SNAPSHOT_MB (2048), P6_SANDBOX_SNAPSHOT_KEEP_S (86400), P6_SANDBOX_SNAPSHOT_S (120: the time one archive step may take).
import { app } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SANDBOX_SCHEME_ENTRY, SandboxSession, registerSandboxScheme, sandboxPath, type Limits, type RunResult, type Shared } from './pyodideSession.ts';
import { runSelftest, type Selftest } from './pyodideSelftest.ts';
import { SnapshotStore, restoreSession, saveSession, type EndReason } from './pyodideSnapshot.ts';

export { registerSandboxScheme, SANDBOX_SCHEME_ENTRY };
export type { Selftest };

const MAX_BODY = 256 * 1048576;   // one request; the platform sends big files in parts of a few MB
const DEFAULT_PACKAGES = ['numpy', 'pandas', 'scipy', 'matplotlib', 'openpyxl', 'xlsxwriter', 'python-docx', 'python-pptx', 'pypdf', 'lxml', 'pillow'];

const envNumber = (name: string, fallback: number): number => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };

/** Every session is busy and the cap is reached: answered 503 like the other refusals of service.py (jail_unavailable). */
class SandboxFull extends Error {}

/** Where the page's three files are: beside the built main process (dist/sandbox-page, scripts/build-sandbox-page.mjs) or, in a source run, in main/sandbox/page. */
function findPageDir(): string {
  const base = app.getAppPath();
  for (const d of [join(base, 'dist', 'sandbox-page'), join(base, 'main', 'sandbox', 'page')]) if (existsSync(join(d, 'page.js'))) return d;
  throw new Error(`the sandbox page is missing from ${base} (dist/sandbox-page; run scripts/build.mjs)`);
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const NO_SHELL = (language: string): RunResult => ({
  stdout: '',
  stderr: `Shell and Node.js are not available in this desktop sandbox: it runs Python only (language "${language}" was asked for). Run the step as Python.`,
  error: 'shell and node are not available in this sandbox (Python only)',
  traceback: '',
  exitCode: 127,
});

export async function startPyodideSandbox(o: { dir: string; pageDir?: string; port?: number; snapshotDir?: string; log?: (line: string) => void }): Promise<{ url: string; close(): Promise<void>; selftest: Selftest }> {
  const log = o.log ?? (() => {});
  const limits: Limits = { fileMb: envNumber('VM_SANDBOX_FILE_MB', 512), diskMb: envNumber('VM_SANDBOX_DISK_MB', 2048), idleS: envNumber('VM_SANDBOX_IDLE_S', 3600), memMb: 4096 /* the WebAssembly memory ceiling */ };
  if (!existsSync(join(o.dir, 'pyodide.asm.wasm'))) throw new Error(`Pyodide is not installed in ${o.dir} (node scripts/fetch-pyodide.mjs)`);
  const pageDir = o.pageDir ?? findPageDir();
  const files = new Map<string, string>();
  for (const f of ['index.html', 'page.js', 'worker.js']) files.set('/' + f, join(pageDir, f));
  for (const f of readdirSync(o.dir)) if (statSync(join(o.dir, f)).isFile()) files.set('/pyodide/' + f, join(o.dir, f));
  let packages = DEFAULT_PACKAGES;
  try { const m = JSON.parse(readFileSync(join(o.dir, 'manifest.json'), 'utf8')) as { load?: string[] }; if (m.load?.length) packages = m.load; } catch { /* the default list */ }
  const shared: Shared = {
    files, preload: join(pageDir, 'preload.cjs'), packages, limits, log,
    graceMs: envNumber('P6_SANDBOX_GRACE_MS', 5000),
    noCsp: process.env.P6_SANDBOX_TEST_NO_CSP === '1',   // tests only: proves the request cancel holds without the page policy
  };

  const sessions = new Map<string, SandboxSession>();
  let selftest: Selftest = { ok: false, checks: [{ name: 'self-test', ok: false, detail: 'not run yet' }] };
  let closed = false;

  const maxSessions = Math.max(1, Math.floor(envNumber('VM_SANDBOX_MAX_SESSIONS', 2)));
  const store = new SnapshotStore(o.snapshotDir ?? join(app.getPath('userData'), 'whiq', 'sandbox-snapshots'), {
    maxBytes: envNumber('P6_SANDBOX_SNAPSHOT_MB', 2048) * 1048576, keepMs: envNumber('P6_SANDBOX_SNAPSHOT_KEEP_S', 86400) * 1000, log,
  });
  const snapshotMs = envNumber('P6_SANDBOX_SNAPSHOT_S', 120) * 1000;
  /** Sessions that left the table and are being saved: their windows are still open, so a new session waits for them (the cap counts memory). */
  const ending = new Map<Promise<void>, SandboxSession>();

  /** End a session the service chose to end: out of the table at once, saved, then destroyed. */
  const end = (id: string, why: EndReason): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    log(`session ${id}: ending (${why.log})`);
    const p: Promise<void> = saveSession(s, store, why, { timeoutMs: snapshotMs, log }).catch((e: Error) => log(`session ${id}: save failed: ${e.message}`)).finally(() => { s.destroy(); ending.delete(p); });
    ending.set(p, s);
  };

  /** The session of this id; a new one when there is none and `create`. A new one beyond the cap ends the least recently used session that is not in use; when all are in use: SandboxFull. */
  const get = (id: string, create: boolean): SandboxSession | undefined => {
    let s = sessions.get(id);
    if (s || !create) return s;
    while (sessions.size >= maxSessions) {
      let lru: SandboxSession | undefined;
      for (const o of sessions.values()) if (!o.inUse && (!lru || o.used < lru.used)) lru = o;
      if (!lru) throw new SandboxFull(`The desktop code sandbox already runs ${sessions.size} sessions (the limit is ${maxSessions}) and each is running a cell right now. Try again when one of them has finished.`);
      end(lru.id, { log: `to make room for ${id}: the limit is ${maxSessions} session${maxSessions === 1 ? "" : "s"}`, told: `to make room for another chat: the desktop sandbox keeps at most ${maxSessions} session${maxSessions === 1 ? "" : "s"}` });
    }
    s = new SandboxSession(id, shared);
    if (ending.size) s.holdBoot = Promise.all([...ending.keys()]);
    s.afterBoot = () => restoreSession(s!, store, { log });   // what an earlier session of this id left (nothing, for a new chat) comes back before its first request
    sessions.set(id, s);
    return s;
  };

  let port = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      // Only this machine's own tools may call: a web page cannot (a browser always names its origin), nor a rebinding of a host name to 127.0.0.1.
      const host = String(req.headers.host ?? '');
      if (req.headers.origin !== undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return sendJson(res, 403, { error: 'forbidden' });
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET') {
        if (path === '/health') return sendJson(res, 200, { ok: true, jail: selftest.ok, sessions: sessions.size, maxSessions, idleS: limits.idleS });
        if (path === '/selftest') return sendJson(res, 200, selftest);
        return sendJson(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use GET or POST' });
      const raw = await readBody(req);
      if (!raw) return sendJson(res, 413, { error: 'request too large: send big files in parts' });
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>; } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'bad json' });
      if (!selftest.ok) return sendJson(res, 503, { error: 'jail_unavailable', failed: selftest.checks.filter((c) => !c.ok) });   // never run anything in a jail that was not proven
      const id = String(body.id ?? '');
      if (!id) return sendJson(res, 400, { error: 'id required' });
      if (path === '/create') {
        const s = get(id, true)!;
        s.ensure().catch((e: Error) => log(`session ${id}: start failed: ${e.message}`));   // warm it up while the platform gets ready to use it
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/kill') {
        const s = sessions.get(id);
        sessions.delete(id);
        store.remove(id);   // the platform ended it itself (after its own snapshot): it knows, and whatever was saved here is older
        s?.destroy();
        return sendJson(res, 200, { ok: true });
      }
      // no session of that id (never made, killed, or ended by the service): nothing to keep alive or to stop, and nothing is made just for it
      if (path === '/keepalive') { sessions.get(id)?.touch(); return sendJson(res, 200, { ok: true }); }
      if (path === '/interrupt') { sessions.get(id)?.interrupt(); return sendJson(res, 200, { ok: true }); }   // Stop / the watchdog: the running cell stops, the session's variables stay
      if (path === '/write') {
        const s = get(id, true)!;
        const list = Array.isArray(body.files) ? (body.files as Record<string, unknown>[]) : [];
        let entries: { path: string; data: Buffer }[];
        try {
          entries = list.map((f) => ({
            path: sandboxPath(f?.path),
            data: typeof f?.base64 === 'string' ? Buffer.from(f.base64, 'base64') : Buffer.from(String(f?.data ?? ''), 'utf8'),
          }));
        } catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
        try { await s.write(entries); } catch (e) {
          const kind = (e as { errorKind?: string }).errorKind;
          return sendJson(res, kind === 'path' ? 400 : kind === 'size' ? 413 : 500, { error: (e as Error).message });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/run') {
        const s = get(id, true)!;
        const code = String(body.code ?? '');
        const language = String(body.language ?? 'python');
        const ms = Number(body.timeoutMs ?? 0) || 0;   // 0 / absent: no limit; the cell runs until it ends or /interrupt stops it
        if (language !== 'python') return sendJson(res, 200, NO_SHELL(language));
        return sendJson(res, 200, await s.run(code, ms > 0 ? Math.max(1000, ms) : 0));
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof SandboxFull) { if (!res.headersSent) sendJson(res, 503, { error: 'sandbox_capacity', message: e.message }); else res.end(); return; }
      if (!res.headersSent) sendJson(res, 500, { error: `${(e as Error).name}: ${(e as Error).message}` });
      else res.end();
    }
  });
  server.requestTimeout = 0;   // a cell answers once, when it ends
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;

  // idle sessions are removed after IDLE_S; a session that is running a cell never is
  const reaper = setInterval(() => {
    for (const [id, s] of [...sessions]) {
      if (!s.inUse && Date.now() - s.used > limits.idleS * 1000) end(id, { log: `removed after ${limits.idleS} s idle`, told: `it was idle for ${limits.idleS >= 120 ? Math.round(limits.idleS / 60) + ' min' : limits.idleS + ' s'}` });
    }
  }, Math.max(250, Math.min(60_000, (limits.idleS * 1000) / 4)));
  reaper.unref();
  const sweeper = setInterval(() => { try { store.sweep(); } catch (e) { log(`snapshot sweep failed: ${(e as Error).message}`); } }, Math.max(250, Math.min(3600_000, (envNumber('P6_SANDBOX_SNAPSHOT_KEEP_S', 86400) * 1000) / 4)));
  sweeper.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(reaper);
    clearInterval(sweeper);
    for (const s of sessions.values()) s.destroy();
    for (const s of ending.values()) s.destroy();
    sessions.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    selftest = await runSelftest({ shared, port, log, sessionCount: () => sessions.size });
    if (process.env.P6_SANDBOX_TEST_FAIL_SELFTEST === '1') selftest = { ...selftest, ok: false, checks: [...selftest.checks, { name: 'forced failure (tests only)', ok: false, detail: 'P6_SANDBOX_TEST_FAIL_SELFTEST=1' }] };
  } catch (e) {
    selftest = { ok: false, checks: [{ name: 'self-test', ok: false, detail: `${(e as Error).name}: ${(e as Error).message}` }] };
  }
  for (const c of selftest.checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -  ${c.detail}`}`);
  log(selftest.ok ? `READY: the jail holds on this machine (127.0.0.1:${port})` : `REFUSING to serve: the jail is not proven here (127.0.0.1:${port})`);
  return { url: `http://127.0.0.1:${port}`, close, selftest };
}
