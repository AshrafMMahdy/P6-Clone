// Which sandbox runs the agent's code on this PC (owner's decision, 2026-11-03): the platform's own Linux jail inside
// WSL when it is set up there, else Pyodide (Python in WebAssembly, jailed in a hidden Chromium page: pyodideService.ts).
// The choice is made when the agent starts (a quick look at WSL) and told to the agent: its server gets VM_SANDBOX /
// VM_SANDBOX_URL (the platform's local-sandbox client) and a note of what this sandbox has. The sandbox itself starts when
// the agent starts, in the background (each proves its jail first: seconds for WSL, about 14 s for Pyodide): the URL the agent
// gets is a small loopback door here that passes every request through once it is up. When WSL's jail does not
// hold at that point, Pyodide takes over.
import { existsSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prepareWsl, startWslSandbox } from './wslSandbox.ts';
import { startPyodideSandbox } from './pyodideService.ts';

export interface SandboxState { kind: 'wsl' | 'pyodide' | 'none'; started?: boolean; url?: string; note?: string; /** why WSL is not used */ wsl?: string; wslSetup?: boolean; error?: string }

const PACKAGES = 'numpy, pandas, scipy, matplotlib, openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, lxml and Pillow';
const NOTE = {
  wsl: `code runs on this PC in a Linux jail inside WSL (the platform's local sandbox): Python with ${PACKAGES} and ortools; shell and Node commands work. There is no internet, so pip install does not work, and only those packages exist (no ImageMagick).`,
  pyodide: `code runs on this PC in Pyodide (Python compiled to WebAssembly, jailed inside the app) with ${PACKAGES}. Language must be python: no shell or Node commands, no ortools (use the schedule tools to optimise), no threads or subprocesses, no ImageMagick, and no internet, so pip install does not work.`,
};
type Backend = { url: string; close(): void | Promise<void> };

export class CodeSandbox {
  private o: { wslSource: string; version: string; pyodideDir: string; log: (l: string) => void };
  private state: SandboxState = { kind: 'none' };
  private door: Server | null = null;
  private backend: Promise<Backend> | null = null;
  private closeBackend: (() => void | Promise<void>) | null = null;
  constructor(o: { wslSource: string; version: string; pyodideDir: string; log?: (l: string) => void }) { this.o = { log: () => {}, ...o }; }

  get status(): SandboxState { return this.state; }

  /** Pick the sandbox (once while the app runs) and open its door; nothing is started yet. */
  async ensure(): Promise<SandboxState> {
    if (this.door) return this.state;
    const force = process.env.P6CLONE_SANDBOX;
    let wsl = 'not tried', wslSetup = false;
    if (force !== 'pyodide' && existsSync(this.o.wslSource)) {
      const r = prepareWsl(this.o.wslSource, this.o.version);
      if (r.ok) return this.open({ kind: 'wsl', note: NOTE.wsl });
      wsl = r.reason; wslSetup = !!r.setup;
    }
    if (force === 'wsl') return (this.state = { kind: 'none', wsl, wslSetup, error: `the WSL sandbox is required (P6CLONE_SANDBOX=wsl) but ${wsl}` });
    if (!existsSync(this.o.pyodideDir)) return (this.state = { kind: 'none', wsl, wslSetup, error: `Pyodide is not installed beside the program (${this.o.pyodideDir})` });
    return this.open({ kind: 'pyodide', note: NOTE.pyodide, wsl, wslSetup });
  }

  private async open(s: SandboxState): Promise<SandboxState> {
    this.door = createServer((req, res) => void this.pass(req, res));
    await new Promise<void>((r) => this.door!.listen(0, '127.0.0.1', () => r()));
    this.state = { ...s, started: false, url: `http://127.0.0.1:${(this.door.address() as AddressInfo).port}` };
    void this.start().catch(() => undefined);   // proving the jail in the background while the agent starts and the user types
    return this.state;
  }

  /** The sandbox behind the door, started on the first request: the one picked, else Pyodide when WSL's jail fails. */
  private start(): Promise<Backend> {
    this.backend ??= (async () => {
      if (this.state.kind === 'wsl') {
        const r = await startWslSandbox(this.o.wslSource, this.o.version, (l) => this.o.log(`[wsl-sandbox] ${l}`));
        if (r.ok) { this.closeBackend = r.sandbox.close; this.state = { ...this.state, started: true }; return r.sandbox; }
        this.o.log(`[sandbox] WSL refused at first use, Pyodide takes over: ${r.reason}`);
        this.state = { ...this.state, kind: 'pyodide', note: NOTE.pyodide, wsl: r.reason, wslSetup: !!r.setup };
      }
      const p = await startPyodideSandbox({ dir: this.o.pyodideDir });
      this.closeBackend = () => p.close();
      if (!p.selftest.ok) this.o.log(`[sandbox] Pyodide failed its self-test: ${p.selftest.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail ?? ''})`).join('; ')}`);
      this.state = { ...this.state, started: true, ...(p.selftest.ok ? {} : { error: 'the Pyodide sandbox failed its self-test (see logs/sandbox.log)' }) };
      return p;   // a failed self-test answers 503 jail_unavailable itself: the platform says so to the agent
    })().catch((e) => { this.backend = null; this.state = { ...this.state, error: (e as Error).message }; throw e; });
    return this.backend;
  }

  private async pass(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // the platform probes health with a 10 s bound before it creates a session (30 s): while the sandbox is still proving
    // its jail, the door answers the probe and the create waits; a sandbox whose jail fails refuses every POST itself (503)
    if (req.url === '/health' && !this.state.started && !this.state.error) {
      void this.start().catch(() => undefined);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, jail: true, sessions: 0, starting: true })); return;
    }
    let b: Backend;
    try { b = await this.start(); } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'sandbox_unavailable', detail: (e as Error).message })); return;
    }
    const to = new URL(req.url ?? '/', b.url);
    const fwd = request(to, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'sandbox_unreachable', detail: e.message })); });
    req.pipe(fwd);
  }

  /** The agent server's environment for this sandbox (none: run_code stays hidden, as the platform does without one). */
  env(): Record<string, string> {
    const s = this.state;
    return s.url ? { VM_SANDBOX: 'on', VM_SANDBOX_URL: s.url, WHIQ_SANDBOX_NOTE: s.note ?? '', WHIQ_SANDBOX_TRANSCRIBE: '0' } : {};
  }

  /** Stop it (the app quits, or the user set WSL up and wants a fresh pick at the agent's next start). */
  async close(): Promise<void> {
    const c = this.closeBackend, d = this.door;
    this.closeBackend = null; this.backend = null; this.door = null; this.state = { kind: 'none' };
    d?.close();
    await c?.();
  }
}
