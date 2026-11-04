// One sandbox session of the desktop code sandbox: a hidden Chromium window whose page runs Pyodide (Python in WebAssembly)
// in a Worker. The window is the jail: the renderer is Chromium's OS-sandboxed process (sandbox:true), the page is served by
// a private scheme that carries ONLY Pyodide's files and the page's own, every other request is cancelled, every permission
// is refused, and the page cannot open windows, navigate or download. Python reaches whatever the worker can reach and the
// page holds nothing of value (see page/page.js). See pyodideService.ts for the HTTP face and pyodideSelftest.ts for the proofs.
import { BrowserWindow, app, ipcMain, protocol, session as electronSession, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export const SCHEME = 'p6pyo';
export const ORIGIN = `${SCHEME}://app/`;
export const HOME = '/home/user';
export const MAX_OUT = 2_000_000;   // characters of stdout / stderr handed back per run (09 Local Sandbox/worker.py)

export interface RunResult { stdout: string; stderr: string; error: string | null; traceback: string; exitCode: number }
export interface WorkerInfo { python: string; pyodide: string; loaded: string[]; coreMs: number; packagesMs: number; isolated: boolean; totalMs: number }
export interface Limits { fileMb: number; diskMb: number; idleS: number; memMb: number }
/** What the app's handlers refused for one window (the self-test and the tests read it). */
export interface Counters { netBlocked: string[]; windowsDenied: number; navBlocked: number; downloadsBlocked: number; permissionsDenied: string[]; devtoolsClosed: number }

/** The scheme must be standard + secure (workers and SharedArrayBuffer need a secure origin) and may fetch. */
export const SANDBOX_SCHEME_ENTRY: Electron.CustomScheme = { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } };
/** Before app ready. Electron takes the privileged schemes in one call, so a program that registers others too passes them here: registerSandboxScheme([bimScheme]). */
export function registerSandboxScheme(others: Electron.CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([...others, SANDBOX_SCHEME_ENTRY]);
}

export interface Shared {
  /** URL path -> file on disk: the page's own three files and Pyodide's, nothing else is ever served */
  files: Map<string, string>;
  preload: string;
  packages: string[];
  limits: Limits;
  graceMs: number;
  noCsp: boolean;
  log: (line: string) => void;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.zip': 'application/zip', '.whl': 'application/zip' };
// connect-src 'self' is the policy half of "no network" (the page and its worker can fetch from their own scheme only); the request
// cancel in the session is the second half, and the self-test proves each on its own (P6_SANDBOX_TEST_NO_CSP drops this one).
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function headers(type: string, noCsp: boolean): Record<string, string> {
  return {
    'content-type': type,
    'cross-origin-opener-policy': 'same-origin',      // with the next one: crossOriginIsolated, which SharedArrayBuffer (the interrupt) needs
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    ...(noCsp ? {} : { 'content-security-policy': CSP }),
  };
}

/** A path the platform names, as an absolute path in the sandbox: relative paths and /home/user/... are in the session folder, /tmp/... is the
 *  sandbox's scratch folder (the platform's snapshot restore stages its parts there); any other absolute path is taken as relative to the
 *  session folder (as 09 Local Sandbox does); a path that climbs out of the folder is refused. Throws a RangeError for a refused path. */
export function sandboxPath(raw: unknown): string {
  const p = String(raw ?? '');
  if (p.includes('\0')) throw new RangeError('bad path');
  if (p === '/tmp' || p.startsWith('/tmp/')) {
    const n = posix.normalize(p);
    if (!n.startsWith('/tmp/')) throw new RangeError(`path leaves the session folder: ${p}`);
    return n;
  }
  const rel = p === HOME || p.startsWith(HOME + '/') ? p.slice(HOME.length).replace(/^\/+/, '') : p.replace(/^\/+/, '');
  const n = posix.normalize(`${HOME}/${rel}`);
  if (!n.startsWith(HOME + '/')) throw new RangeError(`path leaves the session folder: ${p}`);
  return n;
}

const bySender = new Map<number, SandboxSession>();
let wired = false;
function wireIpc(): void {
  if (wired) return;
  wired = true;
  // the page's way up: accepted only from the main frame of a sandbox window, on its own scheme
  ipcMain.on('p6sandbox:up', (e, m) => {
    const s = bySender.get(e.sender.id);
    if (!s || e.senderFrame !== e.sender.mainFrame || !e.senderFrame?.url.startsWith(ORIGIN)) return;
    s.fromPage(m);
  });
}

const plain = (b: Buffer): Uint8Array => (b.byteOffset === 0 && b.buffer.byteLength === b.length ? new Uint8Array(b.buffer, 0, b.length) : Uint8Array.from(b));
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

interface Pending { resolve: (v: { ok: boolean; result?: unknown; error?: string; errorKind?: string }) => void; reject: (e: Error) => void }
type Wait = { resolve: (v: WorkerInfo) => void; reject: (e: Error) => void };

export class SandboxSession {
  readonly id: string;
  used = Date.now();
  busy = 0;
  win: BrowserWindow | null = null;
  info: WorkerInfo | null = null;
  counters: Counters = { netBlocked: [], windowsDenied: 0, navBlocked: 0, downloadsBlocked: 0, permissionsDenied: [], devtoolsClosed: 0 };
  pageFacts: { sandboxed: boolean; contextIsolated: boolean; isolated: boolean } | null = null;
  private readonly shared: Shared;
  private readonly light: boolean;
  private ses: Session | null = null;
  private ready: Promise<WorkerInfo> | null = null;
  private pageWait: { resolve: () => void } | null = null;
  private workerWait: Wait | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private running = false;
  private cancelNext = false;
  private tail: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  /** light: Python only, no packages (the self-test's second session) */
  constructor(id: string, shared: Shared, light = false) { this.id = id; this.shared = shared; this.light = light; }

  // ---- the window
  private async openWindow(): Promise<void> {
    await app.whenReady();
    wireIpc();
    const ses = electronSession.fromPartition(`p6sbx-${randomUUID()}`);   // no "persist:" prefix: in memory only, its own storage, gone with the window
    this.ses = ses;
    const { files, noCsp } = this.shared;
    ses.protocol.handle(SCHEME, async (req) => {
      const u = new URL(req.url);
      const file = u.host === 'app' ? files.get(decodeURIComponent(u.pathname)) : undefined;
      if (!file) return new Response('not found', { status: 404, headers: headers('text/plain', noCsp) });
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      return new Response(new Uint8Array(await readFile(file)), { status: 200, headers: headers(TYPES[ext] ?? 'application/octet-stream', noCsp) });
    });
    // nothing leaves the window: every request that is not for the private scheme is cancelled (the policy above refuses most of them first)
    ses.webRequest.onBeforeRequest((d, cb) => {
      if (d.url.startsWith(ORIGIN)) return cb({});
      if (this.counters.netBlocked.length < 200) this.counters.netBlocked.push(d.url.slice(0, 200));
      cb({ cancel: true });
    });
    ses.setPermissionRequestHandler((_wc, permission, cb) => { this.counters.permissionsDenied.push(permission); cb(false); });
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (e) => { e.preventDefault(); this.counters.downloadsBlocked++; });
    ses.setSpellCheckerEnabled(false);

    const win = new BrowserWindow({
      show: false, width: 800, height: 600, skipTaskbar: true, focusable: false,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, spellcheck: false,
        backgroundThrottling: false, session: ses, preload: this.shared.preload,
      },
    });
    this.win = win;
    const wc = win.webContents;
    bySender.set(wc.id, this);
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => { this.counters.windowsDenied++; return { action: 'deny' }; });
    wc.on('will-navigate', (e) => { e.preventDefault(); this.counters.navBlocked++; });
    wc.on('will-frame-navigate', (e) => { e.preventDefault(); this.counters.navBlocked++; });
    wc.on('will-redirect', (e) => { e.preventDefault(); this.counters.navBlocked++; });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('devtools-opened', () => { this.counters.devtoolsClosed++; wc.closeDevTools(); });
    wc.on('render-process-gone', (_e, d) => { this.shared.log(`session ${this.id}: its page process ended (${d.reason})`); this.lost(`the sandbox process ended (${d.reason})`); });
    if (process.env.P6_SANDBOX_DEBUG) wc.on('console-message', (e: { message?: string }) => this.shared.log(`[page ${this.id}] ${e.message}`));
    if (process.env.P6_SANDBOX_DEBUG) {
      wc.on('did-fail-load', (_e, code, desc, url) => this.shared.log(`[page ${this.id}] load failed ${code} ${desc} ${url}`));
      wc.on('preload-error', (_e, p, err) => this.shared.log(`[page ${this.id}] preload error ${p}: ${err}`));
    }
    const pageReady = new Promise<void>((resolve) => { this.pageWait = { resolve }; });
    await win.loadURL(ORIGIN + 'index.html');
    await pageReady;
  }

  /** The window or its process is gone: everything waiting fails, the next use opens a new window (empty: variables and files are lost). */
  private lost(why: string): void {
    this.failAll(new Error(why));
    this.closeWindow();
    this.ready = null;
  }
  private closeWindow(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) { bySender.delete(win.webContents.id); win.destroy(); }
    const ses = this.ses;
    this.ses = null;
    if (ses) { ses.clearStorageData().catch(() => undefined); ses.clearCache().catch(() => undefined); ses.closeAllConnections().catch(() => undefined); }
  }

  // ---- the worker
  /** The session's Python is running (window opened, packages loaded). Starts it when it is not. */
  ensure(): Promise<WorkerInfo> {
    if (this.destroyed) return Promise.reject(new Error('the session was ended'));
    this.ready ??= this.boot().catch((e) => { this.ready = null; if (this.win) this.sendUp({ type: 'terminate' }); throw e; });
    return this.ready;
  }
  private async boot(): Promise<WorkerInfo> {
    const t0 = Date.now();
    if (!this.win || this.win.isDestroyed()) await this.openWindow();
    const info = await new Promise<WorkerInfo>((resolve, reject) => {
      const t = setTimeout(() => { this.workerWait = null; reject(new Error('the Python worker did not start within 3 minutes')); }, 180_000);
      this.workerWait = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      const { limits } = this.shared;
      this.sendUp({ type: 'start', init: { packages: this.light ? [] : this.shared.packages, limits: { fileBytes: limits.fileMb * 1048576, diskBytes: limits.diskMb * 1048576, scanBytes: Math.max(1048576, Math.min(32 * 1048576, (limits.diskMb * 1048576) >> 3)), maxOut: MAX_OUT } } });
    });
    info.totalMs = Date.now() - t0;
    this.info = info;
    return info;
  }
  private sendUp(m: unknown): void {
    const win = this.win;
    if (win && !win.isDestroyed()) win.webContents.send('p6sandbox:down', m);
  }
  private failAll(err: Error): void {
    const w = this.workerWait;
    this.workerWait = null;
    w?.reject(err);
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  /** What the page sent up (untrusted: the worker's messages are forwarded as they are, and Python can post any it likes). */
  fromPage(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const x = m as Record<string, unknown>;
    if (x.type === 'page-ready') {
      const f = (x.facts ?? {}) as Record<string, unknown>;
      this.pageFacts = { sandboxed: f.sandboxed === true, contextIsolated: f.contextIsolated === true, isolated: x.isolated === true };
      this.pageWait?.resolve();
      this.pageWait = null;
    } else if (x.type === 'ready') {
      const i = (x.info ?? {}) as Record<string, unknown>;
      const w = this.workerWait;
      this.workerWait = null;
      w?.resolve({ python: str(i.python), pyodide: str(i.pyodide), loaded: Array.isArray(i.loaded) ? i.loaded.map(str) : [], coreMs: Number(i.coreMs) || 0, packagesMs: Number(i.packagesMs) || 0, isolated: i.isolated === true, totalMs: 0 });
    } else if (x.type === 'fatal' || x.type === 'worker-error') {
      const why = new Error(str(x.error ?? x.message).slice(0, 2000) || 'the Python worker failed');
      if (this.workerWait) { const w = this.workerWait; this.workerWait = null; w.reject(why); } else this.dropWorker(why);
    } else if (x.type === 'res' && typeof x.id === 'number') {
      const p = this.pending.get(x.id);
      if (!p) return;
      this.pending.delete(x.id);
      p.resolve({ ok: x.ok === true, result: x.result, error: typeof x.error === 'string' ? x.error : undefined, errorKind: typeof x.errorKind === 'string' ? x.errorKind : undefined });
    }
  }

  /** The worker is gone (killed, or it failed): waiting calls fail, the next use starts a new one in the same window. */
  private dropWorker(why: Error): void {
    this.sendUp({ type: 'terminate' });
    this.ready = null;
    this.failAll(why);
  }

  call(kind: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: unknown; error?: string; errorKind?: string }> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.sendUp({ type: 'req', id, kind, ...extra });
    });
  }
  /** A fact about the page itself (self-test only: permissions asked for, a window opened, a navigation). */
  async probePage(name: string): Promise<unknown> {
    await this.ensure();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve: (v) => (v.ok ? resolve(v.result) : reject(new Error(v.error ?? 'probe failed'))), reject });
      this.sendUp({ type: 'probe', id, name });
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  // ---- what the service asks of a session
  async write(files: { path: string; data: Buffer }[]): Promise<void> {
    this.touch();
    await this.ensure();
    const r = await this.call('write', { files: files.map((f) => ({ path: f.path, bytes: plain(f.data) })) });
    if (!r.ok) throw Object.assign(new Error(r.error ?? 'write failed'), { errorKind: r.errorKind });
  }

  run(code: string, timeoutMs: number): Promise<RunResult> {
    this.busy++;
    this.touch();
    return this.exclusive(() => this.runLocked(code, timeoutMs)).finally(() => { this.busy--; this.touch(); });
  }
  private async runLocked(code: string, timeoutMs: number): Promise<RunResult> {
    const fail = (stderr: string, error: string): RunResult => ({ stdout: '', stderr, error, traceback: '', exitCode: 1 });
    try { await this.ensure(); } catch (e) { return fail(`[the Python sandbox did not start: ${(e as Error).message}]`, 'sandbox unavailable'); }
    const secs = Math.floor(timeoutMs / 1000);
    let timedOut = false;
    let killed = false;
    let t1: NodeJS.Timeout | undefined;
    let t2: NodeJS.Timeout | undefined;
    let t3: NodeJS.Timeout | undefined;
    if (this.cancelNext) {   // /interrupt came while this run waited for the session to start: it is the run that was meant to stop
      this.cancelNext = false;
      return { stdout: '', stderr: '[the run was stopped before it started; variables and files are kept]', error: 'stopped: the run went over its time limit', traceback: '', exitCode: 1 };
    }
    this.running = true;
    if (timeoutMs > 0) {
      t1 = setTimeout(() => {   // over time: ask Python to stop (the session's variables stay); if it will not, end the worker
        timedOut = true;
        this.sendUp({ type: 'interrupt' });
        t3 = setInterval(() => this.sendUp({ type: 'interrupt' }), 300);   // asked again until it answers: a Ctrl-C that landed between two statements is not lost
        t2 = setTimeout(() => { killed = true; this.dropWorker(new Error('killed')); }, this.shared.graceMs);
      }, timeoutMs);
    }
    let r: Awaited<ReturnType<SandboxSession['call']>>;
    try {
      r = await this.call('run', { code });
    } catch (e) {
      if (killed) return fail(`[timeout after ${secs}s: the run was killed and this session's Python variables and files are gone (the sandbox's files live with its Python)]`, 'timeout');
      return fail(`[the run ended the sandbox process (out of memory, or it exited); this session's Python variables and files are gone: ${(e as Error).message}]`, 'killed');
    } finally {
      clearTimeout(t1); clearTimeout(t2); clearInterval(t3);
      this.running = false;
    }
    if (!r.ok) return fail(r.error ?? 'the run failed', 'sandbox error');
    const res = (r.result ?? {}) as Record<string, unknown>;
    if (typeof res.diskFull === 'number') return fail(`[the sandbox folder holds ${res.diskFull} MB, over its ${this.shared.limits.diskMb} MB limit: delete files you no longer need, then run again]`, 'disk limit');
    const e = res.error && typeof res.error === 'object' ? (res.error as Record<string, unknown>) : null;
    let stderr = str(res.stderr);
    let error = e ? str(e.value) : null;
    let traceback = e ? str(e.traceback) : '';
    if (timedOut) {
      stderr += `\n[timeout after ${secs}s: the run was stopped; variables and files are kept]`;
      error ||= 'timeout';
      if (!e) traceback = '';
    }
    return { stdout: str(res.stdout), stderr, error, traceback, exitCode: error ? 1 : 0 };
  }

  /** Ctrl-C for the running cell: it stops, the session's variables and files stay. Nothing running: nothing to do. */
  interrupt(): void {
    this.touch();
    if (this.running) this.sendUp({ type: 'interrupt' });
    else if (this.busy > 0) this.cancelNext = true;   // a run is queued or the session is still starting: that run stops before it starts
  }
  touch(): void { this.used = Date.now(); }

  /** Facts of the live window as the app sees it (for the self-test). */
  windowFacts(): { prefs: Record<string, unknown>; process: { pid: number; sandboxed: boolean | undefined; integrity: string | undefined } | null; devtoolsOpened?: boolean } {
    const wc = this.win!.webContents;
    const pid = wc.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid) as ({ sandboxed?: boolean; integrityLevel?: string } | undefined);
    return { prefs: (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences(), process: m ? { pid, sandboxed: m.sandboxed, integrity: m.integrityLevel } : null };
  }

  /** Ask for the dev tools the way a script never could, and say whether they opened (they must not: devTools is off for this window). */
  tryDevtools(): boolean {
    const wc = this.win!.webContents;
    try { wc.openDevTools({ mode: 'detach', activate: false }); } catch { /* refused */ }
    return wc.isDevToolsOpened();
  }

  /** End the session: its window, its Python, everything in it. */
  destroy(): void {
    this.destroyed = true;
    this.failAll(new Error('the session was ended'));
    this.closeWindow();
    this.ready = null;
  }
}
