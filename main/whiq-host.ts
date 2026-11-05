// Runs the embedded platform agent (vendor/whiq-agent, fetched by scripts/fetch-whiq-agent.mjs) as two child
// processes of the app, on Electron's own Node (ELECTRON_RUN_AS_NODE), on loopback ports of their own: the platform's
// LLM Router (keys by environment only, see whiq-config.ts) and its agent server with the scheduler module, in
// standalone mode (one local user, JSON stores under the app's user data, no platform database or sign-in). Talks to
// the agent server over its HTTP API and live event stream.
// Both servers load GUARD first (--require): they end when the app's pipe on their stdin closes (a quit, a crash), and
// their HTTP servers answer only loopback requests with no Origin, so no web page reaches them, by DNS rebinding either.
// Each start is a generation: a stop while a start is under way ends that start and anything it spawned.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { routerConfig, type AgentModels } from './whiq-config.ts';

/** vendor: the fetched agent; data: its own files (runtime, storage, its router's config); logs: its servers' logs */
export interface HostPaths { vendor: string; data: string; logs: string }
/** An MCP server the agent is to connect to (the open schedule, on screen): written into its mcp-servers.json at each start. */
export interface ExtraMcp { id: string; label: string; url: string; token: string }
export type AgentEvent = Record<string, unknown> & { type: string };
/** Environment for the agent server from the app's own services beside it (the code sandbox, the PQ-VAE engine). */
export type ServiceEnv = (routerUrl: string) => Promise<Record<string, string>>;

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const killTree = (p: ChildProcess | null) => {
  if (!p || p.exitCode != null || p.pid == null) return;
  // the whole tree: a server's own children (engines) go with it
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill('SIGTERM'); } catch { /* already gone */ }
};

/** Loaded into both servers before their own code (CommonJS, plain Node). */
const GUARD = `'use strict';
// P6 Clone (main/whiq-host.ts): end with the app; answer loopback requests only, never a web page.
process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0)); process.stdin.resume();
const http = require('node:http');
const emit = http.Server.prototype.emit;
const ok = (srv, req) => {
  const a = srv.address(), port = a && typeof a === 'object' ? a.port : 0, host = String(req.headers.host || '').toLowerCase();
  return req.headers.origin === undefined && (host === '127.0.0.1:' + port || host === 'localhost:' + port);
};
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === 'request' && !ok(this, req)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return true; }
  if (ev === 'upgrade' && !ok(this, req)) { res.destroy(); return true; }
  return emit.apply(this, arguments);
};
`;

export class WhiqHost {
  private router: ChildProcess | null = null;
  private chat: ChildProcess | null = null;
  private routerPort = 0;
  private chatPort = 0;
  private gen = 0;
  /** the model settings the running agent started with */
  private bootModels = '';
  private starting: Promise<void> | null = null;
  status: { state: 'off' | 'starting' | 'ready' | 'failed'; error?: string } = { state: 'off' };
  /** Called when a running agent goes (a stop, or a server that died): its event streams are over. */
  onDown: (why: string) => void = () => {};

  private paths: HostPaths;
  private models: () => AgentModels;
  private extraMcp: () => Promise<ExtraMcp[]>;
  private services: ServiceEnv;
  constructor(paths: HostPaths, models: () => AgentModels, extraMcp: () => Promise<ExtraMcp[]> = async () => [], services: ServiceEnv = async () => ({})) { this.paths = paths; this.models = models; this.extraMcp = extraMcp; this.services = services; }

  /** the loopback ports in use (0 when off) */
  get ports() { return { router: this.routerPort, agent: this.chatPort }; }
  get chatDir() { return join(this.paths.vendor, '03 Shared Platform Agents', 'app'); }
  get routerDir() { return join(this.paths.vendor, '06 LLM Router'); }
  available(): string | null {
    if (!existsSync(join(this.chatDir, 'server.dist.mjs'))) return 'The platform agent is not installed: run node scripts/fetch-whiq-agent.mjs --install --build.';
    if (!existsSync(join(this.routerDir, 'server.mjs'))) return 'The platform agent\'s router is missing.';
    return null;
  }

  /** Starts both servers once; a second call waits for the first. */
  start(): Promise<void> {
    const g = this.gen;
    this.starting ??= this.boot(g).catch((e) => {
      if (g === this.gen) { this.status = { state: 'failed', error: (e as Error).message }; this.starting = null; this.kill(); }
      throw e;
    });
    return this.starting;
  }

  private async boot(g: number): Promise<void> {
    const missing = this.available();
    if (missing) throw new Error(missing);
    // a stop() during any await below ends this start: what it spawned is killed, nothing of it is kept
    // (a server that died during the start ended it too: its own error is the reason)
    const live = () => { if (g !== this.gen) throw new Error(this.status.state === 'failed' && this.status.error ? this.status.error : 'The agent was stopped while it was starting.'); };
    this.status = { state: 'starting' };
    const models = this.models();
    const { config, env: keys, agentEnv } = routerConfig(models);
    this.bootModels = JSON.stringify(models);
    mkdirSync(this.paths.logs, { recursive: true });
    const cfgFile = join(this.paths.data, 'llm-router.json');
    writeFileSync(cfgFile, JSON.stringify(config, null, 2));
    const guard = join(this.paths.data, 'child-guard.cjs');
    writeFileSync(guard, GUARD);
    const [routerPort, chatPort] = [await freePort(), await freePort()];
    // the agent's own MCP servers file, in its runtime dir: only ours (a token fresh per run; the agent reads it at boot)
    const runtime = join(this.paths.data, 'runtime');
    mkdirSync(runtime, { recursive: true });
    const mcp = (await this.extraMcp()).map((x) => ({ id: x.id, label: x.label, transport: 'http', url: x.url, headers: { authorization: `Bearer ${x.token}` }, enabled: true, trusted: true }));
    live();
    writeFileSync(join(runtime, 'mcp-servers.json'), JSON.stringify(mcp, null, 2));
    const node = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' };
    const services = await this.services(`http://127.0.0.1:${routerPort}`);
    live();
    [this.routerPort, this.chatPort] = [routerPort, chatPort];
    this.router = this.child('router', this.routerDir, ['--require', guard, 'server.mjs'], {
      ...node, ...keys, PORT: String(routerPort), LLM_ROUTER_CONFIG: cfgFile,
      WHIQ_PLATFORM_KEYS_FILE: join(this.paths.data, 'platform-keys.json'), DATABASE_APP_URL: '',
    });
    this.chat = this.child('agent', this.chatDir, ['--require', guard, 'server.dist.mjs'], {
      ...node, PORT: String(chatPort), WHIQ_DEFAULT_MODULE: 'scheduler', LLM_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
      COWORK_RUNTIME_DIR: runtime, WHIQ_SHARED_RUNTIME_DIR: runtime,
      WHIQ_STORAGE_DIR: join(this.paths.data, 'storage'), WHIQ_LOCAL_MODE: '1', WHIQ_ROOT: this.paths.vendor,
      COWORK_BEHIND_GATEWAY: '', COWORK_BASE_PATH: '', DATABASE_APP_URL: '', ...agentEnv, ...services,
    });
    await this.waitFor(`http://127.0.0.1:${routerPort}/api/health`, 'router', live);
    await this.waitFor(`http://127.0.0.1:${chatPort}/api/health`, 'agent', live);
    this.status = { state: 'ready' };
  }

  private child(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const log = createWriteStream(join(this.paths.logs, `${name}.log`), { flags: 'a' });
    // stdin: a pipe the guard watches; it closes when this process ends, however it ends
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    p.stdout?.pipe(log); p.stderr?.pipe(log);
    p.on('exit', (code) => {
      log.end();
      if (p !== this.router && p !== this.chat) return;   // a server of an earlier start, or one stop() ended
      // a server that died takes the agent down with it: the next request starts both again
      this.status = { state: 'failed', error: `The platform agent's ${name} stopped (exit ${code}); see ${join(this.paths.logs, `${name}.log`)}.` };
      this.starting = null;
      this.gen++;
      this.kill();
      this.onDown(this.status.error!);
    });
    return p;
  }

  private async waitFor(url: string, what: string, live: () => void): Promise<void> {
    for (let i = 0; i < 120; i++) {
      live();
      if (this.status.state === 'failed') throw new Error(this.status.error);
      try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ }
      await sleep(500);
    }
    throw new Error(`The platform agent's ${what} did not start within a minute; see ${this.paths.logs}.`);
  }

  private kill(): void {
    const [chat, router] = [this.chat, this.router];
    this.chat = this.router = null;   // first, so their exits are not taken for a crash
    killTree(chat); killTree(router);
  }

  /** Stops the agent, or the start under way; new model settings take effect on the next start. */
  stop(why = 'The agent was stopped.'): void {
    const was = this.status.state;
    this.gen++; this.kill(); this.starting = null; this.status = { state: 'off' };
    if (was === 'ready') this.onDown(why);   // (a start under way has no streams yet)
  }

  /** After a settings save: stops the agent only when its models (providers, keys, tiers, seats) changed, so a save that
   *  touches nothing of the agent's (a Test, the app-operating switch) leaves a running answer alone. */
  stopIfChanged(why: string): void {
    if (this.status.state === 'off' || this.status.state === 'failed') return;
    let now = '';
    try { now = JSON.stringify(this.models()); } catch { /* unreadable: treat as changed */ }
    if (now !== this.bootModels) this.stop(why);
  }

  /** A call to the agent server's API (started on first use). */
  async api(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    await this.start();
    const r = await fetch(`http://127.0.0.1:${this.chatPort}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-cowork-as': 'master' }, body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!r.ok) throw new Error((data as { error?: string })?.error ?? `${method} ${path}: HTTP ${r.status}`);
    return data;
  }

  /** A file of the agent server (its generated files), as bytes. */
  async raw(path: string): Promise<Buffer> {
    await this.start();
    const r = await fetch(`http://127.0.0.1:${this.chatPort}${path}`, { headers: { 'x-cowork-as': 'master' } });
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** The chat's live events until the returned function is called; onEnd when the stream ends by itself (the server went). */
  async stream(chatId: string, onEvent: (e: AgentEvent) => void, onEnd: () => void = () => {}): Promise<() => void> {
    await this.start();
    const ctl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${this.chatPort}/api/agent/stream?chatId=${encodeURIComponent(chatId)}&as=master`, { signal: ctl.signal });
    if (!r.ok || !r.body) throw new Error(`The agent's event stream did not open (HTTP ${r.status}).`);
    const reader = r.body.getReader(), dec = new TextDecoder();
    void (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // server-sent events: blocks separated by a blank line; "data:" lines carry the JSON, ":" lines are comments
          let at: number;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, at); buf = buf.slice(at + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { onEvent(JSON.parse(data) as AgentEvent); } catch { /* not JSON: ignore */ }
          }
        }
      } catch { /* stopped */ }
      if (!ctl.signal.aborted) onEnd();
    })();
    return () => ctl.abort();
  }
}
