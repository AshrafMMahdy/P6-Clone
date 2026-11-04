// The platform's own code sandbox (vendor/whiq-agent/09 Local Sandbox: Python, shell and Node, each chat in a
// bubblewrap jail) run inside WSL, when this PC has WSL with bubblewrap and the sandbox's packages set up. The service is
// copied into the WSL home (~/.p6clone/sandbox-<version>, the Linux disk: fast, writable), started on a loopback port
// Windows reaches through WSL's localhost forwarding, and used only once its own self-test proves the jail. It ends
// with the app: its stdin is a pipe from this process, and the wrapper stops it when that pipe closes.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface WslSandbox { url: string; close(): void }
export type WslResult = { ok: true; sandbox: WslSandbox } | { ok: false; reason: string; setup?: boolean };

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** One bash command in the default WSL distribution; '' when WSL is not there. */
function bash(cmd: string, timeout = 60_000): { code: number; out: string } {
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8', timeout, windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\0/g, '').trim() };
}

/** The folder the service lives in inside WSL, for this version of it. */
export const wslHome = (version: string) => `$HOME/.p6clone/sandbox-${version.replace(/[^\w.-]/g, '').slice(0, 12)}`;

/** Copy the service in (once per version) and check what it needs: bubblewrap, python3 and the packages (install.sh). */
export function prepareWsl(source: string, version: string): { ok: true } | { ok: false; reason: string; setup?: boolean } {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };
  const list = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 15_000, windowsHide: true });
  if (list.status !== 0 || !String(list.stdout ?? '').replace(/\0/g, '').trim()) return { ok: false, reason: 'WSL is not installed (or has no Linux distribution)' };
  const home = wslHome(version);
  const copy = bash(`set -e; d="${home}"; if [ ! -f "$d/service.py" ]; then mkdir -p "$d"; src="$(wslpath -a ${q(source.replace(/\\/g, '/'))})"; cp "$src"/*.py "$src"/*.sh "$src"/requirements.txt "$d"/; fi; echo copied`);
  if (copy.code !== 0) return { ok: false, reason: `could not copy the sandbox into WSL: ${copy.out.slice(-300)}` };
  const need = bash(`command -v bwrap >/dev/null || echo "bubblewrap"; command -v python3 >/dev/null || echo "python3"; [ -x "${home}/.venv/bin/python3" ] || echo "packages"`);
  const missing = need.out.split(/\s+/).filter(Boolean);
  if (missing.length) return { ok: false, reason: `the WSL sandbox is not set up (missing: ${missing.join(', ')})`, setup: true };
  return { ok: true };
}

/** Start the service in WSL and wait for its self-test; refused when the jail is not proven there. */
export async function startWslSandbox(source: string, version: string, log: (line: string) => void = () => {}): Promise<WslResult> {
  const ready = prepareWsl(source, version);
  if (!ready.ok) return ready;
  const port = await freePort();
  // the service in the background; `cat` holds until our end of stdin closes (the app quit or close()), then it is stopped
  const cmd = `cd "${wslHome(version)}" && python3 service.py --port ${port} & P=$!; cat >/dev/null; kill $P 2>/dev/null; wait $P 2>/dev/null`;
  const child: ChildProcess = spawn('wsl.exe', ['-e', 'bash', '-lc', cmd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const tail: string[] = [];
  const keep = (d: Buffer) => { for (const l of d.toString('utf8').replace(/\0/g, '').split(/\r?\n/)) if (l.trim()) { log(l); tail.push(l); if (tail.length > 30) tail.shift(); } };
  child.stdout?.on('data', keep); child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  const close = () => { try { child.stdin?.end(); } catch { /* gone */ } setTimeout(() => { if (!exited) try { child.kill(); } catch { /* gone */ } }, 3000).unref(); };
  for (let i = 0; i < 120 && !exited; i++) {   // the self-test takes a few seconds; a cold WSL start a few more
    try {
      const h = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json() as { ok?: boolean; jail?: boolean };
      if (h.jail) return { ok: true, sandbox: { url, close } };
      if (h.ok && tail.some((l) => /REFUSING/.test(l))) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  close();
  const failed = tail.filter((l) => /FAIL/.test(l)).map((l) => l.replace(/^\[vm-sandbox\]\s*/, ''));
  return { ok: false, reason: `the WSL sandbox did not prove its jail${failed.length ? `: ${failed.join('; ')}` : exited ? ` (it stopped: ${tail.slice(-2).join(' ')})` : ' in time'}` };
}

/** The set-up the user runs once, in a console they can see (it asks for their Linux password): bubblewrap and venv
 *  from the distribution, then the sandbox's packages (install.sh: about 600 MB from the internet). */
export function wslSetupCommand(version: string): string {
  return `echo "P6 Clone: setting up the code sandbox in WSL (bubblewrap, python3-venv, then about 600 MB of Python packages)."; sudo apt-get install -y bubblewrap python3-venv && bash "${wslHome(version)}/install.sh"; echo; read -p "Finished. Press Enter, then click Check again in the AI settings." _`;
}
