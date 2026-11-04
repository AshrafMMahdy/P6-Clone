// The main process's side of the PQ-VAE engine (sidecar.ts, bundled as dist/pqvae-sidecar.mjs): started with the agent
// on Electron's own Node, on a loopback port it picks and prints; the agent server is given that port (PQVAE_PORT), so
// its PQ-VAE client finds the engine already answering and never looks for Python. It asks the router's decide seat,
// so it is started again with each router. It ends when its stdin (a pipe from this process) closes.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';

export interface Pqvae { port: number; stop(): void }

export function startPqvae(o: { entry: string; models: string; routerUrl: string; log: string }): Promise<Pqvae> {
  if (!existsSync(o.entry)) return Promise.reject(new Error(`the PQ-VAE engine is not built (${o.entry})`));
  if (!existsSync(o.models)) return Promise.reject(new Error(`the PQ-VAE models are not installed (${o.models})`));
  const child: ChildProcess = spawn(process.execPath, [o.entry, '--models', o.models, '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LLM_ROUTER_URL: o.routerUrl }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const log = createWriteStream(o.log, { flags: 'a' });
  child.stderr?.pipe(log);
  const stop = () => { try { child.stdin?.end(); } catch { /* gone */ } setTimeout(() => { if (child.exitCode == null) try { child.kill(); } catch { /* gone */ } }, 3000).unref(); };
  return new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => { stop(); rej(new Error('the PQ-VAE engine did not start within 30 s')); }, 30_000);
    child.on('exit', (code) => { clearTimeout(t); log.end(); rej(new Error(`the PQ-VAE engine stopped (exit ${code}); see ${o.log}`)); });
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const m = /\{"port":(\d+)\}/.exec(out);
      if (m) { clearTimeout(t); res({ port: Number(m[1]), stop }); }
      log.write(d);
    });
  });
}
