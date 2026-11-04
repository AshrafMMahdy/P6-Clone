// Runs the embedded platform agent (vendor/whiq-agent, fetched by scripts/fetch-whiq-agent.mjs) as two child
// processes of the app, on Electron's own Node (ELECTRON_RUN_AS_NODE), on loopback ports of their own: the platform's
// LLM Router (keys by environment only, see whiq-config.ts) and its agent server with the scheduler module, in
// standalone mode (one local user, JSON stores under the app's user data, no platform database or sign-in). Talks to
// the agent server over its HTTP API and live event stream.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { routerConfig, type AgentModels } from './whiq-config.ts';

export interface HostPaths { vendor: string; data: string }
export type AgentEvent = Record<string, unknown> & { type: string };

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhiqHost {
  private router: ChildProcess | null = null;
  private chat: ChildProcess | null = null;
  private routerPort = 0;
  private chatPort = 0;
  private stopping = false;
  private starting: Promise<void> | null = null;
  status: { state: 'off' | 'starting' | 'ready' | 'failed'; error?: string } = { state: 'off' };

  private paths: HostPaths;
  private models: () => AgentModels;
  constructor(paths: HostPaths, models: () => AgentModels) { this.paths = paths; this.models = models; }

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
    this.starting ??= this.boot().catch((e) => { this.status = { state: 'failed', error: (e as Error).message }; this.starting = null; this.kill(); throw e; });
    return this.starting;
  }

  private async boot(): Promise<void> {
    const missing = this.available();
    if (missing) throw new Error(missing);
    this.stopping = false;
    this.status = { state: 'starting' };
    const { config, env: keys } = routerConfig(this.models());
    mkdirSync(join(this.paths.data, 'logs'), { recursive: true });
    const cfgFile = join(this.paths.data, 'llm-router.json');
    writeFileSync(cfgFile, JSON.stringify(config, null, 2));
    [this.routerPort, this.chatPort] = [await freePort(), await freePort()];
    const node = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' };
    this.router = this.child('router', this.routerDir, ['server.mjs'], {
      ...node, ...keys, PORT: String(this.routerPort), LLM_ROUTER_CONFIG: cfgFile,
      WHIQ_PLATFORM_KEYS_FILE: join(this.paths.data, 'platform-keys.json'), DATABASE_APP_URL: '',
    });
    this.chat = this.child('agent', this.chatDir, ['server.dist.mjs'], {
      ...node, PORT: String(this.chatPort), WHIQ_DEFAULT_MODULE: 'scheduler', LLM_ROUTER_URL: `http://127.0.0.1:${this.routerPort}`,
      COWORK_RUNTIME_DIR: join(this.paths.data, 'runtime'), WHIQ_SHARED_RUNTIME_DIR: join(this.paths.data, 'runtime'),
      WHIQ_STORAGE_DIR: join(this.paths.data, 'storage'), WHIQ_LOCAL_MODE: '1', WHIQ_ROOT: this.paths.vendor,
      COWORK_BEHIND_GATEWAY: '', COWORK_BASE_PATH: '', DATABASE_APP_URL: '',
    });
    await this.waitFor(`http://127.0.0.1:${this.routerPort}/api/health`, 'router');
    await this.waitFor(`http://127.0.0.1:${this.chatPort}/api/health`, 'agent');
    this.status = { state: 'ready' };
  }

  private child(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const log = createWriteStream(join(this.paths.data, 'logs', `${name}.log`), { flags: 'a' });
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout?.pipe(log); p.stderr?.pipe(log);
    p.on('exit', (code) => {
      log.end();
      if (this.stopping) return;
      // a server that died takes the agent down with it: the next request starts both again
      this.status = { state: 'failed', error: `The platform agent's ${name} stopped (exit ${code}); see ${join(this.paths.data, 'logs', `${name}.log`)}.` };
      this.starting = null;
      this.kill();
    });
    return p;
  }

  private async waitFor(url: string, what: string): Promise<void> {
    for (let i = 0; i < 120; i++) {
      if (this.status.state === 'failed') throw new Error(this.status.error);
      try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ }
      await sleep(500);
    }
    throw new Error(`The platform agent's ${what} did not start within a minute; see ${join(this.paths.data, 'logs')}.`);
  }

  private kill(): void {
    for (const p of [this.chat, this.router]) {
      if (!p || p.exitCode != null || p.pid == null) continue;
      // the whole tree: a server's own children (engines) go with it
      try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.chat = this.router = null;
  }

  stop(): void { this.stopping = true; this.kill(); this.starting = null; this.status = { state: 'off' }; }
  /** New model settings take effect on the next start. */
  async restart(): Promise<void> { this.stop(); await this.start(); }

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

  /** The chat's live events until stop() is called (or the server goes). */
  async stream(chatId: string, onEvent: (e: AgentEvent) => void): Promise<() => void> {
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
    })();
    return () => ctl.abort();
  }
}
