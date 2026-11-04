// The self-test of the desktop code sandbox: run once when it starts, before it serves anything (like 09 Local Sandbox/service.py's).
// The jail is PROVEN on this machine, not assumed: Python code that tries to leave runs in real sessions, and the result is compared with
// what the app saw (a listener that must never be reached, a secret file that must never be read, the handlers that must have refused).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SandboxSession, type Shared } from './pyodideSession.ts';

export interface SelftestCheck { name: string; ok: boolean; detail: string }
export interface Selftest {
  ok: boolean;
  checks: SelftestCheck[];
  python?: string;
  pyodide?: string;
  packages?: Record<string, string>;
  limits?: { memory_mb: number; file_mb: number; disk_mb: number; idle_s: number };
  /** how long a session takes to start (window, Pyodide, all packages), measured on this machine */
  startMs?: { total: number; core: number; packages: number };
}

/** The modules the platform's scripts import (09 Local Sandbox/requirements.txt without ortools): [package, module]. */
export const REQUIRED: [string, string][] = [['numpy', 'numpy'], ['pandas', 'pandas'], ['scipy', 'scipy'], ['matplotlib', 'matplotlib'], ['openpyxl', 'openpyxl'], ['xlsxwriter', 'xlsxwriter'], ['python-docx', 'docx'], ['python-pptx', 'pptx'], ['pypdf', 'pypdf'], ['lxml', 'lxml'], ['pillow', 'PIL']];

const PACKAGES_PROBE = (pairs: [string, string][]) => `
import importlib, importlib.metadata, json
bad, ver = [], {}
for name, mod in ${JSON.stringify(pairs)}:
    try:
        importlib.import_module(mod)
        ver[name] = importlib.metadata.version(name)
    except Exception as e:
        bad.append(name + ': ' + str(e)[:80])
print(json.dumps({'bad': bad, 'versions': ver}))
`;

/** Everything Python can try synchronously; the asynchronous attempts (fetch, WebSocket, ...) are started by NET_START and read by NET_READ. */
const ESCAPE_PROBE = (t: { canaryUrl: string; serviceUrl: string; secretFile: string; secretUrl: string; canary: string }) => `
import json, os, sys, subprocess, socket, urllib.request
import js
r = {}
r['py'] = sys.version.split()[0]
r['js_has'] = [n for n in ['require', 'process', 'module', 'Buffer', 'electron', 'ipcRenderer', 'sbx', 'global', 'nodeRequire'] if hasattr(js, n)]
r['env_canary'] = any(${JSON.stringify(t.canary)} in v for v in os.environ.values()) or 'WHIQ_SANDBOX_CANARY' in os.environ
r['env_keys'] = sorted(os.environ)
r['root'] = sorted(os.listdir('/'))
def tryit(f):
    try:
        v = f()
        return ('REACHED: ' + str(v)[:80]) if v else 'blocked: no effect'
    except BaseException as e: return 'blocked: ' + type(e).__name__
def xhr(url):
    x = js.XMLHttpRequest.new(); x.open('GET', url, False); x.send()
    t = str(x.responseText)
    return 'status %s, %d chars%s' % (x.status, len(t), ' WITH THE SECRET' if ${JSON.stringify(t.canary)} in t else '')
def reads(p):
    with open(p, 'rb') as f: return f.read(64)
r['xhr_canary'] = tryit(lambda: xhr(${JSON.stringify(t.canaryUrl)}))
r['xhr_service'] = tryit(lambda: xhr(${JSON.stringify(t.serviceUrl)}))
r['xhr_file'] = tryit(lambda: xhr(${JSON.stringify(t.secretUrl)}))
r['open_host_file'] = tryit(lambda: reads(${JSON.stringify(t.secretFile)}))
r['open_host_win_ini'] = tryit(lambda: reads('C:/Windows/win.ini'))
r['import_scripts'] = tryit(lambda: js.importScripts(${JSON.stringify(t.canaryUrl + 'x.js')}))
def talk():
    s = socket.create_connection(('127.0.0.1', ${new URL(t.canaryUrl).port}), 2)
    s.sendall(b"GET / HTTP/1.0" + bytes([13, 10, 13, 10]))
    return s.recv(100)   # only an answer from the other end counts as reaching it
r['socket'] = tryit(talk)
r['urllib'] = tryit(lambda: urllib.request.urlopen(${JSON.stringify(t.canaryUrl)}, timeout=2).read())
r['subprocess'] = tryit(lambda: subprocess.check_output(['cmd', '/c', 'echo', 'pwned']))
r['os_system'] = tryit(lambda: os.system('echo pwned > /home/user/pwned.txt') == 0 and os.path.exists('/home/user/pwned.txt'))
print(json.dumps(r))
`;

const NET_TARGETS = (t: { canaryUrl: string; serviceUrl: string; secretUrl: string }) => ({
  fetch_canary: t.canaryUrl, fetch_service: t.serviceUrl, fetch_internet: 'https://example.com/', fetch_ip: 'http://1.1.1.1/', fetch_file: t.secretUrl,
  ws_canary: t.canaryUrl.replace('http:', 'ws:'), ws_internet: 'wss://example.com/socket', sse_canary: t.canaryUrl, transport_canary: t.canaryUrl.replace('http:', 'https:'),
});
const NET_START = (targets: Record<string, string>) => `
import js
from pyodide.ffi import create_proxy
T = ${JSON.stringify(targets)}
_net = {}
_keep = []
def _done(name, how):
    def f(*a): _net[name] = how if how != 'blocked' else 'blocked: ' + (str(a[0])[:60] if a else '')
    p = create_proxy(f); _keep.append(p); return p
def _fetch(name, url, **opt):
    _net[name] = 'pending'
    try:
        p = js.fetch(url, **opt)
        p.then(_done(name, 'REACHED'), _done(name, 'blocked'))
    except BaseException as e: _net[name] = 'blocked: threw ' + type(e).__name__
_fetch('fetch_canary', T['fetch_canary'])
_fetch('fetch_canary_no_cors', T['fetch_canary'], mode='no-cors')
_fetch('fetch_service', T['fetch_service'])
_fetch('fetch_internet', T['fetch_internet'])
_fetch('fetch_ip', T['fetch_ip'])
_fetch('fetch_file', T['fetch_file'])
async def _pyfetch():
    from pyodide.http import pyfetch
    try:
        await pyfetch(T['fetch_canary']); _net['pyfetch_canary'] = 'REACHED'
    except BaseException as e: _net['pyfetch_canary'] = 'blocked: ' + type(e).__name__
import asyncio
_net['pyfetch_canary'] = 'pending'
asyncio.ensure_future(_pyfetch())
for name in ('ws_canary', 'ws_internet'):
    _net[name] = 'pending'
    try:
        ws = js.WebSocket.new(T[name]); _keep.append(ws)
        ws.onopen = _done(name, 'REACHED'); ws.onerror = _done(name, 'blocked'); ws.onclose = create_proxy(lambda *a, n=name: _net.__setitem__(n, _net[n] if _net[n] != 'pending' else 'blocked: closed'))
    except BaseException as e: _net[name] = 'blocked: threw ' + type(e).__name__
_net['sse_canary'] = 'pending'
try:
    es = js.EventSource.new(T['sse_canary']); _keep.append(es)
    es.onopen = _done('sse_canary', 'REACHED'); es.onerror = _done('sse_canary', 'blocked')
except BaseException as e: _net['sse_canary'] = 'blocked: threw ' + type(e).__name__
_net['transport_canary'] = 'pending'
try:
    wt = js.WebTransport.new(T['transport_canary']); _keep.append(wt)
    wt.ready.then(_done('transport_canary', 'REACHED'), _done('transport_canary', 'blocked'))
    wt.closed.then(create_proxy(lambda *a: None), create_proxy(lambda *a: None))
except BaseException as e: _net['transport_canary'] = 'blocked: ' + type(e).__name__ + ' (' + str(e)[:40] + ')'
`;
const NET_READ = 'import json; print(json.dumps(_net))';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelftest(ctx: { shared: Shared; port: number; log: (l: string) => void; sessionCount: () => number }): Promise<Selftest> {
  const { shared } = ctx;
  const checks: SelftestCheck[] = [];
  const add = (name: string, ok: boolean, detail = ''): void => { if (process.env.P6_SANDBOX_DEBUG) ctx.log(`(check) ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); };
  const out: Selftest = { ok: false, checks, limits: { memory_mb: shared.limits.memMb, file_mb: shared.limits.fileMb, disk_mb: shared.limits.diskMb, idle_s: shared.limits.idleS } };

  // the trap: a secret in this process's environment and in a file, and a listener on this machine that nothing in the jail may reach
  const canary = randomBytes(16).toString('hex');
  process.env.WHIQ_SANDBOX_CANARY = canary;
  const dir = mkdtempSync(join(tmpdir(), 'p6sbx-selftest-'));
  const secretFile = join(dir, 'secret.txt');
  writeFileSync(secretFile, canary);
  const hits = { tcp: 0, http: 0, upgrade: 0 };
  const trap = createServer((_req, res) => { hits.http++; res.end(canary); });
  trap.on('connection', () => { hits.tcp++; });
  trap.on('upgrade', (_req, socket) => { hits.upgrade++; socket.destroy(); });
  await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
  const trapPort = (trap.address() as AddressInfo).port;
  const targets = { canaryUrl: `http://127.0.0.1:${trapPort}/`, serviceUrl: `http://127.0.0.1:${ctx.port}/health`, secretFile, secretUrl: `file:///${secretFile.replaceAll('\\', '/')}`, canary };

  if (process.env.P6_SANDBOX_DEBUG) ctx.log('trap up on ' + trapPort);
  const a = new SandboxSession('selftest-a', shared);
  const b = new SandboxSession('selftest-b', shared, true);
  const py = async (s: SandboxSession, code: string, ms = 60_000) => s.run(code, ms);
  const json = (stdout: string): any => { try { return JSON.parse(stdout.trim().split('\n').pop() ?? ''); } catch { return null; } };   // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    // the control: the listener answers when the app itself asks, so "never reached" below means something
    const control = await fetch(targets.canaryUrl).then((r) => r.text(), () => '');
    add('the trap listener on this machine answers the app (control for the network checks)', control === canary, control ? '' : 'the trap did not answer');
    hits.tcp = hits.http = hits.upgrade = 0;

    const t0 = Date.now();
    let info;
    try { info = await a.ensure(); } catch (e) { add('the jail starts and runs Python', false, (e as Error).message); return out; }
    out.python = info.python; out.pyodide = info.pyodide;
    out.startMs = { total: Date.now() - t0, core: info.coreMs, packages: info.packagesMs };
    add('the jail starts and runs Python', info.python.length > 0, `Python ${info.python}, Pyodide ${info.pyodide}; started in ${out.startMs.total} ms (Pyodide ${info.coreMs} ms, packages ${info.packagesMs} ms)`);

    // ---- the window
    const wf = a.windowFacts();
    const pr = wf.prefs;
    wf.devtoolsOpened = a.tryDevtools();
    add("the page runs in Chromium's OS-sandboxed renderer process", wf.process?.sandboxed === true && a.pageFacts?.sandboxed === true,
      `process ${wf.process?.pid ?? '?'}: sandboxed ${wf.process?.sandboxed}, integrity level ${wf.process?.integrity ?? 'n/a'}; the page itself reports sandboxed ${a.pageFacts?.sandboxed}`);
    add('the window has no Node, no dev tools, and web security on', pr.sandbox === true && pr.contextIsolation === true && !pr.nodeIntegration && !pr.nodeIntegrationInWorker && pr.webSecurity !== false && wf.devtoolsOpened === false && !pr.webviewTag,
      `sandbox ${pr.sandbox}, contextIsolation ${pr.contextIsolation}, nodeIntegration ${pr.nodeIntegration}, nodeIntegrationInWorker ${pr.nodeIntegrationInWorker}, webSecurity ${pr.webSecurity}, dev tools open after asking for them: ${wf.devtoolsOpened}`);
    add('the page is cross-origin isolated (the interrupt buffer is a SharedArrayBuffer)', info.isolated && a.pageFacts?.isolated === true, `worker ${info.isolated}, page ${a.pageFacts?.isolated}`);

    // ---- the packages
    const pk = await py(a, PACKAGES_PROBE(REQUIRED), 120_000);
    const pj = json(pk.stdout);
    out.packages = pj?.versions;
    add('every package the platform imports is there and imports', !!pj && pj.bad.length === 0, pj ? `missing: ${pj.bad.join('; ') || 'none'}; ${Object.entries(pj.versions).map(([k, v]) => `${k} ${v}`).join(', ')}` : pk.stderr || pk.error || '');

    // ---- nothing reaches out
    await py(a, NET_START(NET_TARGETS(targets)));
    const es = await py(a, ESCAPE_PROBE(targets));
    const ej = json(es.stdout);
    await sleep(2500);   // the asynchronous attempts get their time
    const nr = json((await py(a, NET_READ)).stdout) as Record<string, string> | null;
    const facts = (await a.call('facts')).result as { violations: string[]; types: Record<string, string> } | undefined;
    const reached = (o: Record<string, string> | null | undefined) => Object.entries(o ?? {}).filter(([, v]) => !String(v).startsWith('blocked')).map(([k, v]) => `${k}=${v}`);
    const netReached = nr ? reached(nr) : ['(no answer)'];
    add('fetch, WebSocket, EventSource, WebTransport and pyfetch to 127.0.0.1, to the app\'s own service and to the internet all fail', !!nr && netReached.length === 0, netReached.length ? `NOT BLOCKED: ${netReached.join(', ')}` : `${Object.keys(nr!).length} attempts, all refused`);
    const syncReached = ej ? ['xhr_canary', 'xhr_service', 'xhr_file', 'import_scripts', 'socket', 'urllib', 'subprocess', 'os_system'].filter((k) => !String(ej[k]).startsWith('blocked')).map((k) => `${k}=${ej[k]}`) : ['(no answer)'];
    add('synchronous XMLHttpRequest, importScripts, sockets, urllib and subprocess fail', !!ej && syncReached.length === 0, syncReached.length ? `NOT BLOCKED: ${syncReached.join(', ')}` : 'all refused');
    add('the trap listener on this machine was never touched', hits.tcp === 0 && hits.http === 0 && hits.upgrade === 0, `connections ${hits.tcp}, requests ${hits.http}, upgrades ${hits.upgrade}`);
    // each refusal came from the jail, not from a missing network: the page's policy or the session's request cancel recorded the URL
    const seen = [...(facts?.violations ?? []), ...a.counters.netBlocked];
    const wanted = [`127.0.0.1:${trapPort}`, `127.0.0.1:${ctx.port}`, 'example.com', '1.1.1.1'];
    const unseen = wanted.filter((w) => !seen.some((s) => s.includes(w)));
    add('every attempt is on record as refused by the page policy or cancelled by the session (not lost on a network)', unseen.length === 0, unseen.length ? `no record of: ${unseen.join(', ')}` : `${facts?.violations.length ?? 0} policy refusals, ${a.counters.netBlocked.length} cancelled requests`);

    // ---- nothing of the host
    add('no Node or Electron object is reachable from Python (js.require, js.process, ...)', !!ej && ej.js_has.length === 0 && ['process', 'require', 'module', 'Buffer', 'electron', 'ipcRenderer', 'sbx'].every((n) => facts?.types[n] === 'undefined'), ej ? `present: ${ej.js_has.join(', ') || 'none'}` : '');
    add('no file of the host is readable (js.fetch / XHR of file:///, open() of a host path)', !!ej && !!nr && [ej.xhr_file, ej.open_host_file, ej.open_host_win_ini, nr.fetch_file].every((v) => String(v).startsWith('blocked')) && !JSON.stringify([ej, nr]).includes(canary),
      ej ? `file: XHR ${ej.xhr_file}; open() ${ej.open_host_file}; win.ini ${ej.open_host_win_ini}; fetch ${nr?.fetch_file}` : '');
    add("the app's environment is not visible", !!ej && !ej.env_canary, ej ? `variables seen inside: ${ej.env_keys.join(', ')}` : '');
    add('the only files seen are the sandbox\'s own', !!ej && !ej.root.some((n: string) => /^(c|d|mnt|Users|Windows|Program Files)$/i.test(n)), ej ? `top level seen inside: ${ej.root.join(', ')}` : '');

    // ---- one page, one window: it cannot open windows, navigate, download, ask for permissions
    const perms = await a.probePage('permissions') as Record<string, string>;
    add('permission requests (notifications, location, camera, clipboard) are refused', perms.notification !== 'granted' && String(perms.geolocation).startsWith('denied') && !['granted'].includes(perms.camera) && !['granted'].includes(perms.clipboard), JSON.stringify(perms));
    const esc = await a.probePage('escape') as { windowOpen: string; stayed: boolean };
    await sleep(300);
    add('window.open, navigation away, a frame to another site and downloads are refused', esc.windowOpen === 'denied' && esc.stayed && a.counters.windowsDenied >= 1 && a.counters.navBlocked >= 1 && a.counters.downloadsBlocked >= 1,
      `window.open ${esc.windowOpen}; page stayed ${esc.stayed}; windows denied ${a.counters.windowsDenied}, navigations blocked ${a.counters.navBlocked}, downloads blocked ${a.counters.downloadsBlocked}`);

    // ---- sessions do not see each other
    await py(a, "secret_a = 'A-only'\nimport os\nopen('/home/user/a_only.txt', 'w').write('x')\nos.makedirs('/tmp/a_scratch', exist_ok=True)");
    await b.ensure();
    const other = await py(b, "import os\nprint('secret_a' in globals(), os.path.exists('/home/user/a_only.txt'), os.path.exists('/tmp/a_scratch'))");
    const pidA = a.windowFacts().process?.pid, pidB = b.windowFacts().process?.pid;
    add("a session cannot see another session's variables or files", other.stdout.trim() === 'False False False', `${other.stdout.trim() || other.stderr}; separate window processes ${pidA} / ${pidB}`);

    // ---- limits
    const t1 = Date.now();
    const slow = await py(a, 'while True: pass', 1500);
    add('a run over its time limit is stopped', slow.exitCode === 1 && /went over its time limit/.test(slow.error ?? '') && /variables and files are kept/.test(slow.stderr) && Date.now() - t1 < 8000, `${slow.error} after ${Date.now() - t1} ms`);
    const after = await py(a, 'print(secret_a)');
    add("the session still works after a stopped run, and its variables are kept", after.stdout.trim() === 'A-only', after.stdout.trim() || after.stderr);
    const big = await py(a, `x = bytearray(${(shared.limits.memMb + 512) * 1048576})`);
    const alive = await py(a, 'print(6 * 7)');
    add('a request for more memory than the sandbox can have fails, and the session still answers', big.exitCode === 1 && alive.stdout.trim() === '42', `${(big.error ?? big.stderr).slice(0, 100)}; then ${alive.stdout.trim() || alive.stderr.slice(0, 80)}`);

    // ---- what the app writes into the sandbox cannot be redirected by a link the script planted
    await py(a, "import os\nos.symlink('/lib', '/home/user/planted')\nos.symlink('/lib/python3.14/site-packages/xlsxwriter/__init__.py', '/home/user/planted_file')");
    let escaped: string[] = [];
    for (const p of ['/home/user/planted/pwned.txt', '/home/user/planted_file']) {
      try { await a.write([{ path: p, data: Buffer.from('overwritten') }]); escaped.push(p); } catch { /* refused */ }
    }
    const intact = await py(a, "import os\nprint(os.path.exists('/lib/pwned.txt'), open('/lib/python3.14/site-packages/xlsxwriter/__init__.py').read(40) != 'overwritten')");
    add("a link planted by a script cannot redirect the app's writes", escaped.length === 0 && intact.stdout.trim() === 'False True', `written through: ${escaped.join(', ') || 'none'}; ${intact.stdout.trim()}`);
  } catch (e) {
    add('self-test ran to the end', false, `${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    a.destroy(); b.destroy();
    await new Promise<void>((resolve) => { trap.closeAllConnections(); trap.close(() => resolve()); });
    delete process.env.WHIQ_SANDBOX_CANARY;
    rmSync(dir, { recursive: true, force: true });
  }
  out.ok = checks.length > 0 && checks.every((c) => c.ok);
  return out;
}
