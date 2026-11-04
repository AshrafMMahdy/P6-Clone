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
import { app } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SANDBOX_SCHEME_ENTRY, SandboxSession, registerSandboxScheme, sandboxPath, type Limits, type RunResult, type Shared } from './pyodideSession.ts';
import { runSelftest, type Selftest } from './pyodideSelftest.ts';

export { registerSandboxScheme, SANDBOX_SCHEME_ENTRY };
export type { Selftest };

const MAX_BODY = 256 * 1048576;   // one request; the platform sends big files in parts of a few MB
const DEFAULT_PACKAGES = ['numpy', 'pandas', 'scipy', 'matplotlib', 'openpyxl', 'xlsxwriter', 'python-docx', 'python-pptx', 'pypdf', 'lxml', 'pillow'];

const envNumber = (name: string, fallback: number): number => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };

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

export async function startPyodideSandbox(o: { dir: string; pageDir?: string; port?: number; log?: (line: string) => void }): Promise<{ url: string; close(): Promise<void>; selftest: Selftest }> {
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

  const get = (id: string, create: boolean): SandboxSession | undefined => {
    let s = sessions.get(id);
    if (!s && create) { s = new SandboxSession(id, shared); sessions.set(id, s); }
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
        if (path === '/health') return sendJson(res, 200, { ok: true, jail: selftest.ok, sessions: sessions.size });
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
        s?.destroy();
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/keepalive') { get(id, true)!.touch(); return sendJson(res, 200, { ok: true }); }
      if (path === '/interrupt') { get(id, true)!.interrupt(); return sendJson(res, 200, { ok: true }); }   // Stop / the watchdog: the running cell stops, the session's variables stay
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
    for (const [id, s] of sessions) {
      if (!s.busy && Date.now() - s.used > limits.idleS * 1000) { sessions.delete(id); s.destroy(); log(`session ${id}: removed after ${limits.idleS} s idle`); }
    }
  }, Math.max(250, Math.min(60_000, (limits.idleS * 1000) / 4)));
  reaper.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(reaper);
    for (const s of sessions.values()) s.destroy();
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
