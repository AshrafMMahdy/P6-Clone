// End-to-end: the desktop code sandbox (Pyodide jailed in Chromium's renderer sandbox, main/sandbox/pyodideService.ts) through its HTTP
// contract, the way the platform's localSandbox.ts uses it. A small Electron harness (pyodide-sandbox-harness.mjs) starts the service;
// every claim of the jail is tried from outside as well as by the self-test. Several short-lived instances are started: the normal one,
// one with small limits and a short idle time, one with the page policy removed (the request cancel must hold alone), one with the
// self-test forced to fail (503), and one launched with --no-sandbox (the self-test must refuse).
//   node tests/e2e/pyodide-sandbox.ts        (needs vendor/pyodide: node scripts/fetch-pyodide.mjs)
import { _electron as electron, type ElectronApplication } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) { failures++; process.exitCode = 1; } };
const root = join(import.meta.dirname, '..', '..');
const harness = join(import.meta.dirname, 'pyodide-sandbox-harness.mjs');
if (!existsSync(join(root, 'vendor', 'pyodide', 'pyodide.asm.wasm'))) { console.log('FAIL vendor/pyodide is missing: node scripts/fetch-pyodide.mjs'); process.exit(1); }

interface Check { name: string; ok: boolean; detail: string }
interface Run { stdout: string; stderr: string; error: string | null; traceback: string; exitCode: number }
interface Instance { app: ElectronApplication; url: string; selftest: { ok: boolean; checks: Check[]; startMs?: { total: number; core: number; packages: number }; packages?: Record<string, string> }; startedMs: number; close(): Promise<void> }

async function launch(env: Record<string, string> = {}, o: { noSandbox?: boolean } = {}): Promise<Instance> {
  const dir = mkdtempSync(join(tmpdir(), 'p6sbx-e2e-'));
  const outFile = join(dir, 'out.json');
  const app = await electron.launch({ args: [...(o.noSandbox ? ['--no-sandbox'] : []), harness], cwd: root, chromiumSandbox: true, env: { ...process.env, ...env, P6_SBX_OUT: outFile } as Record<string, string> });
  for (let i = 0; i < 600 && !existsSync(outFile); i++) await new Promise((r) => setTimeout(r, 200));
  if (!existsSync(outFile)) throw new Error('the harness did not report within 2 minutes');
  const r = JSON.parse(readFileSync(outFile, 'utf8'));
  if (r.error) throw new Error('the harness failed: ' + r.error);
  return { app, ...r, close: async () => { await app.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); } };
}

const call = async (url: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(url + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sha = (b: Uint8Array | Buffer): string => createHash('sha256').update(b).digest('hex');
/** WHIQ_B64 as e2bClient's readArchiveOut reads it: the file comes back through stdout as base64 behind a marker. */
const RET = (path: string): string => `
import base64, os, sys
_p = ${JSON.stringify(path)}
with open(_p, 'rb') as _f: _b = _f.read()
sys.stdout.write('WHIQ_B64 ' + str(os.path.getsize(_p)) + ':' + base64.b64encode(_b).decode('ascii'))
`;
const unB64 = (r: Run): Buffer | null => { const m = /WHIQ_B64 (\d+):([A-Za-z0-9+/=\s]*)/.exec(r.stdout); return m ? Buffer.from(m[2].replace(/\s+/g, ''), 'base64') : null; };

const main = await launch({ P6_SANDBOX_GRACE_MS: '2500' });
const U = main.url;
const run = async (id: string, code: string, timeoutMs = 0, language = 'python'): Promise<Run> => (await call(U, '/run', { id, code, language, timeoutMs })).json;
const write = (id: string, files: unknown[]) => call(U, '/write', { id, files });

try {
  // ---- the jail was proven at start
  const h = await call(U, '/health');
  ok(h.status === 200 && h.json.ok === true && h.json.jail === true, `health: ${JSON.stringify(h.json)}`);
  const st = await call(U, '/selftest');
  for (const c of st.json.checks as Check[]) ok(c.ok, `self-test: ${c.name}${c.ok ? '' : '  --  ' + c.detail}`);
  ok(st.json.ok === true && st.json.checks.length >= 20, `self-test: ${st.json.checks.length} checks, all pass; the harness waited ${main.startedMs} ms for it`);
  console.log(`INFO  packages: ${JSON.stringify(st.json.packages)}`);

  // ---- a session: create, write, run, state kept, files
  let t = Date.now();
  ok((await call(U, '/create', { id: 'a' })).json.ok === true, 'create answers at once');
  const first = await run('a', 'import sys; print(sys.version.split()[0])');
  ok(first.exitCode === 0 && /^3\.14/.test(first.stdout), `first run waits for the session to be ready: Python ${first.stdout.trim()}, ${Date.now() - t} ms from create to the first answer`);
  t = Date.now();
  const start2 = await call(U, '/create', { id: 'timing' });
  const r2 = await run('timing', 'import numpy, pandas, scipy, matplotlib, openpyxl, xlsxwriter, docx, pptx, pypdf, lxml, PIL; print("imports ok")');
  ok(r2.stdout.trim() === 'imports ok' && start2.status === 200, `a new session imports every package in ${Date.now() - t} ms from create (window, Pyodide, packages loaded)`);
  await call(U, '/kill', { id: 'timing' });
  await run('a', 'x = 41\nimport os\nprint(os.getcwd(), sys.path[0], os.environ.get("MPLBACKEND"))');
  const keep = await run('a', 'x += 1\nprint(x)');
  ok(keep.stdout.trim() === '42', 'variables are kept between runs');
  const cwd = await run('a', 'import os, sys; print(os.getcwd(), sys.path[0], os.environ["HOME"], os.environ["MPLBACKEND"])');
  ok(cwd.stdout.trim() === '/home/user /home/user /home/user Agg', `cwd, first sys.path entry and HOME are /home/user, MPLBACKEND is Agg: ${cwd.stdout.trim()}`);
  const w = await write('a', [{ path: 'notes.txt', data: 'hello\n' }, { path: '/home/user/sub/dir/bin.dat', base64: Buffer.from([0, 1, 2, 255, 254]).toString('base64') }, { path: '/home/user/whiq_helper.py', data: 'VALUE = 7\n' }]);
  ok(w.status === 200, 'write: text, base64 and a nested folder');
  const rd = await run('a', "print(open('notes.txt').read().strip(), list(open('/home/user/sub/dir/bin.dat','rb').read()))\nimport whiq_helper\nprint(whiq_helper.VALUE)");
  ok(rd.stdout.trim() === 'hello [0, 1, 2, 255, 254]\n7' || rd.stdout.trim().replace(/\r/g, '') === 'hello [0, 1, 2, 255, 254]\n7', `files written by /write are readable, and a module written there imports without touching sys.path: ${JSON.stringify(rd.stdout)}`);

  // ---- the libraries the platform imports, producing real files that come back through WHIQ_B64
  const xl = await run('a', `
import numpy as np, pandas as pd
df = pd.DataFrame({'a': np.arange(5), 'b': np.arange(5) ** 2.0})
df.to_excel('/home/user/pd.xlsx', index=False)
import xlsxwriter
wb = xlsxwriter.Workbook('/home/user/xw.xlsx'); ws = wb.add_worksheet('Sheet9'); ws.write(0, 0, 'hi'); ws.write_number(1, 0, 3.5); wb.close()
import openpyxl
print(openpyxl.load_workbook('/home/user/pd.xlsx').active.max_row, openpyxl.load_workbook('/home/user/xw.xlsx').sheetnames, pd.read_excel('/home/user/xw.xlsx', header=None).iloc[1, 0])
`);
  ok(xl.exitCode === 0 && xl.stdout.trim() === "6 ['Sheet9'] 3.5", `numpy + pandas DataFrame to .xlsx (openpyxl) and xlsxwriter, read back: ${xl.stdout.trim() || xl.stderr.slice(-200)}`);
  const xlBytes = unB64(await run('a', RET('/home/user/xw.xlsx')));
  ok(!!xlBytes && xlBytes.subarray(0, 2).toString() === 'PK' && xlBytes.includes(Buffer.from('xl/worksheets/sheet1.xml')), `the .xlsx comes back through WHIQ_B64 as a real workbook (${xlBytes?.length} bytes)`);
  const png = await run('a', `
import matplotlib; import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(3, 2)); ax.plot([1, 2, 3], [1, 4, 9]); fig.savefig('/home/user/p.png', dpi=60); print(matplotlib.get_backend())
`);
  const pngBytes = unB64(await run('a', RET('/home/user/p.png')));
  ok(png.exitCode === 0 && png.stdout.trim().toLowerCase() === 'agg' && !!pngBytes && pngBytes.subarray(1, 4).toString() === 'PNG', `matplotlib (Agg) draws a PNG: backend ${png.stdout.trim()}, ${pngBytes?.length} bytes${png.stderr ? ', stderr: ' + png.stderr.slice(0, 80) : ''}`);
  const docx = await run('a', `
import docx
d = docx.Document(); d.add_heading('Title', 0); d.add_paragraph('body text'); d.save('/home/user/d.docx')
print([p.text for p in docx.Document('/home/user/d.docx').paragraphs])
`);
  ok(docx.stdout.trim() === "['Title', 'body text']", `python-docx writes and re-reads a .docx: ${docx.stdout.trim() || docx.stderr.slice(-200)}`);
  const pptx = await run('a', `
import pptx
p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = 'Deck'; p.save('/home/user/p.pptx')
print(pptx.Presentation('/home/user/p.pptx').slides[0].shapes.title.text)
`);
  ok(pptx.stdout.trim() === 'Deck', `python-pptx writes and re-reads a .pptx: ${pptx.stdout.trim() || pptx.stderr.slice(-200)}`);
  const pdf = await run('a', `
import pypdf
w = pypdf.PdfWriter(); w.add_blank_page(200, 100); w.add_metadata({'/Title': 'T'}); w.write('/home/user/b.pdf')
r = pypdf.PdfReader('/home/user/b.pdf'); print(len(r.pages), r.metadata.title, float(r.pages[0].mediabox.width))
`);
  ok(pdf.stdout.trim() === '1 T 200.0', `pypdf writes and reads a PDF: ${pdf.stdout.trim() || pdf.stderr.slice(-200)}`);
  const lx = await run('a', `
from lxml import etree
t = etree.fromstring('<r><i n="1">a</i><i n="2">b</i></r>'); print(t.xpath('//i[@n="2"]/text()'), etree.__name__)
`);
  ok(lx.stdout.trim().startsWith("['b']"), `lxml parses and queries XML: ${lx.stdout.trim() || lx.stderr.slice(-200)}`);
  const pil = await run('a', `
from PIL import Image, ImageDraw
im = Image.new('RGB', (40, 20), 'red'); ImageDraw.Draw(im).line((0, 0, 39, 19), fill='blue'); im.save('/home/user/i.png'); print(Image.open('/home/user/i.png').size, im.getpixel((0, 19)))
import scipy.optimize as so, numpy as np
print(round(float(so.minimize_scalar(lambda v: (v - 2) ** 2).x), 3), np.linalg.inv(np.array([[2., 0], [0, 4]])).tolist())
`);
  ok(pil.stdout.trim() === '(40, 20) (255, 0, 0)\n2.0 [[0.5, 0.0], [0.0, 0.25]]' || pil.stdout.replace(/\r/g, '').trim() === '(40, 20) (255, 0, 0)\n2.0 [[0.5, 0.0], [0.0, 0.25]]', `Pillow draws and saves an image; scipy and numpy compute: ${pil.stdout.trim() || pil.stderr.slice(-200)}`);
  // a binary file of random bytes returns exactly through the WHIQ_B64 marker
  const rnd = await run('a', "import os, hashlib\nb = os.urandom(300_000); open('/home/user/rnd.bin', 'wb').write(b); print(hashlib.sha256(b).hexdigest())");
  const back = unB64(await run('a', RET('rnd.bin')));
  ok(!!back && back.length === 300_000 && sha(back) === rnd.stdout.trim(), 'a 300 KB binary file returns byte for byte through a WHIQ_B64 stdout marker');

  // ---- errors, exits, output
  const err = await run('a', 'def f():\n    raise ValueError("boom")\nf()');
  ok(err.exitCode === 1 && err.error === 'boom' && /ValueError: boom/.test(err.traceback) && /<run>/.test(err.traceback) && !/pyodide|run_cell/.test(err.traceback), `an exception: error "${err.error}" and a traceback of the user's frames only`);
  const syn = await run('a', 'def (:');
  ok(syn.exitCode === 1 && /SyntaxError|invalid syntax/.test(syn.traceback + (syn.error ?? '')), 'a syntax error is reported, not thrown');
  const ex3 = await run('a', 'import sys; print("before"); sys.exit(3)');
  ok(ex3.exitCode === 1 && ex3.error === 'exit code 3' && ex3.stdout.trim() === 'before', `SystemExit(3) -> error "${ex3.error}", output kept`);
  const ex0 = await run('a', 'import sys; sys.exit(0)');
  ok(ex0.exitCode === 0 && ex0.error === null, 'SystemExit(0) is not an error');
  const ki = await run('a', 'raise KeyboardInterrupt');
  ok(ki.exitCode === 1 && ki.error === 'stopped: the run went over its time limit', `KeyboardInterrupt -> "${ki.error}"`);
  const alive = await run('a', 'print(x)');
  ok(alive.stdout.trim() === '42', 'the session outlives all of them');
  const err2 = await run('a', 'import sys\nprint("out"); print("err", file=sys.stderr); import warnings; warnings.warn("careful")');
  ok(err2.stdout.trim() === 'out' && /err/.test(err2.stderr) && /careful/.test(err2.stderr), 'stdout and stderr are captured apart (warnings go to stderr)');
  const loud = await run('a', "print('x' * 3_000_000)");
  ok(loud.stdout.length === 2_000_000 + '\n[output cut at 2000000 characters]'.length && loud.stdout.endsWith('[output cut at 2000000 characters]'), `output is cut at 2,000,000 characters (${loud.stdout.length} returned)`);
  const fut = await run('a', "import sys\nwhile True:\n    print('spam' * 1000)\n", 1500);
  ok(fut.exitCode === 1 && fut.stdout.length <= 2_000_050, `a loop that prints for ever is stopped by the time limit with its output cut (${fut.stdout.length} chars, ${fut.error})`);

  // ---- the time limit, interrupt, kill
  await run('a', 'secret = "kept"; x = 42');
  let t0 = Date.now();
  const slow = await run('a', 'while True: pass', 1500);
  ok(slow.exitCode === 1 && slow.error === 'stopped: the run went over its time limit' && /timeout after 1s: the run was stopped; variables and files are kept/.test(slow.stderr) && Date.now() - t0 < 4500, `timeout: the loop is interrupted after ${Date.now() - t0} ms: "${slow.error}"`);
  const kept = await run('a', 'print(secret, x)');
  ok(kept.stdout.trim() === 'kept 42', 'after a timeout the variables are kept');
  const sleepy = await run('a', 'import time\ntime.sleep(60)', 1500);
  t0 = Date.now();
  ok(sleepy.exitCode === 1 && /timeout after 1s/.test(sleepy.stderr), `time.sleep(60) over a 1.5 s limit is ended: "${sleepy.error}" (${sleepy.stderr.trim().slice(-110)})`);
  const afterSleep = await run('a', 'print(1 + 1)');
  ok(afterSleep.stdout.trim() === '2', 'the session answers after it');
  // /interrupt from outside: the long run stops, the variables stay
  await run('a', 'secret = "kept2"');
  const long = run('a', 'while True: pass');
  await new Promise((r) => setTimeout(r, 1200));
  t0 = Date.now();
  ok((await call(U, '/interrupt', { id: 'a' })).json.ok === true, '/interrupt answers');
  const stopped = await long;
  ok(stopped.exitCode === 1 && stopped.error === 'stopped: the run went over its time limit' && Date.now() - t0 < 3000, `/interrupt stops the running cell within ${Date.now() - t0} ms`);
  ok((await run('a', 'print(secret)')).stdout.trim() === 'kept2', 'and the variables are kept');
  const idle = await call(U, '/interrupt', { id: 'a' });
  const notStale = await run('a', 'print("fine")');
  ok(idle.json.ok === true && notStale.stdout.trim() === 'fine', 'an interrupt with nothing running does not hit the next run');
  // a loop that swallows KeyboardInterrupt: the worker is ended, and the session starts afresh
  await write('a', [{ path: 'survivor.txt', data: 'x' }]);
  t0 = Date.now();
  const stuck = await run('a', "while True:\n    try:\n        while True: pass\n    except BaseException:\n        pass", 1000);
  ok(stuck.exitCode === 1 && stuck.error === 'timeout' && /timeout after 1s: the run was killed and this session's Python variables and files are gone/.test(stuck.stderr), `a loop that ignores KeyboardInterrupt: the worker is ended after the grace time (${Date.now() - t0} ms) and the result says the session is lost`);
  const fresh = await run('a', "import os\nprint('secret' in globals(), os.path.exists('/home/user/survivor.txt'), 6 * 7)");
  ok(fresh.stdout.trim() === 'False False 42', `after the kill the next run gets a fresh Python: ${fresh.stdout.trim()}`);

  // ---- memory: a script that eats memory gets a MemoryError at the sandbox's ceiling, and the session survives it
  await run('a', 'keep_me = "v"');
  const mem = await run('a', `
chunks = []
try:
    while True:
        chunks.append(bytearray(256 * 1024 * 1024))
except MemoryError:
    n = len(chunks); chunks.clear()
    print("MemoryError after", n * 256, "MB")
`, 90_000);
  const memAfter = await run('a', 'print(keep_me, 6 * 7)');
  ok(/MemoryError after \d+ MB/.test(mem.stdout) && memAfter.stdout.trim() === 'v 42', `allocating until the sandbox is out of memory: ${mem.stdout.trim() || mem.stderr.slice(-120)}; the session answers after it: ${memAfter.stdout.trim()}`);

  // ---- a window process that dies: the run in it reports the loss, the next run starts afresh
  await run('crash', 'before = 1');
  const pids: number[] = await main.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').map((m) => m.pid));
  const victim = run('crash', 'while True: pass');
  await new Promise((r) => setTimeout(r, 800));
  for (const p of pids) { try { process.kill(p); } catch { /* already gone */ } }
  const lost = await victim;
  const reborn2 = await run('crash', 'print("before" in globals(), 1 + 1)');
  ok(lost.exitCode === 1 && lost.error === 'killed' && /variables and files are gone/.test(lost.stderr) && reborn2.stdout.trim() === 'False 2', `the window process is killed during a run (${pids.length} renderer processes): "${lost.error}", then the session starts afresh: ${reborn2.stdout.trim() || reborn2.stderr.slice(-100)}`);

  // ---- languages
  for (const language of ['shell', 'node', 'js', 'bash']) {
    const r = await run('a', 'echo hi', 0, language);
    ok(r.exitCode === 127 && /Shell and Node.js are not available in this desktop sandbox/.test(r.stderr) && r.stdout === '', `${language}: refused with exit code 127 (${r.stderr.slice(0, 60)}...)`);
  }

  // ---- sessions are apart
  await run('s1', 'only_s1 = 1\nopen("s1.txt", "w").write("1")');
  const s2 = await run('s2', 'import os\nprint("only_s1" in globals(), os.path.exists("s1.txt"), os.listdir("."))');
  ok(s2.stdout.trim() === "False False []", `two sessions are isolated: ${s2.stdout.trim()}`);

  // ---- no network, no host files, tried from outside the sandbox's own self-test
  const hits = { n: 0 };
  const trap = createServer((_q, res) => { hits.n++; res.end('trap'); });
  trap.on('connection', () => { hits.n++; });
  await new Promise<void>((r) => trap.listen(0, '127.0.0.1', r));
  const tp = (trap.address() as AddressInfo).port;
  const secretDir = mkdtempSync(join(tmpdir(), 'p6sbx-secret-'));
  const secretFile = join(secretDir, 'secret.txt');
  writeFileSync(secretFile, 'TOP-SECRET-' + sha(Buffer.from(String(Math.random()))));
  const secret = readFileSync(secretFile, 'utf8');
  const bad = await run('a', `
import js, urllib.request, socket, os
from pyodide.ffi import create_proxy
res = {}
def sync_xhr(url):
    x = js.XMLHttpRequest.new(); x.open('GET', url, False); x.send(); return x.status
for name, url in [('xhr', 'http://127.0.0.1:${tp}/'), ('xhr-service', '${U}/health'), ('xhr-file', 'file:///${secretFile.replaceAll('\\', '/')}'), ('xhr-net', 'https://example.com/')]:
    try: res[name] = 'REACHED %s' % sync_xhr(url)
    except Exception as e: res[name] = 'blocked'
for name, url in [('fetch', 'http://127.0.0.1:${tp}/'), ('fetch-service', '${U}/health'), ('fetch-file', 'file:///${secretFile.replaceAll('\\', '/')}'), ('fetch-net', 'https://example.com/')]:
    res[name] = 'pending'
    js.fetch(url).then(create_proxy(lambda r, n=name: res.__setitem__(n, 'REACHED')), create_proxy(lambda e, n=name: res.__setitem__(n, 'blocked')))
ws = js.WebSocket.new('ws://127.0.0.1:${tp}/')
res['ws'] = 'pending'
ws.onopen = create_proxy(lambda e: res.__setitem__('ws', 'REACHED')); ws.onerror = create_proxy(lambda e: res.__setitem__('ws', 'blocked'))
try: open(${JSON.stringify(secretFile)}).read(); res['open'] = 'REACHED'
except Exception: res['open'] = 'blocked'
try: open('C:/Windows/win.ini').read(); res['win.ini'] = 'REACHED'
except Exception: res['win.ini'] = 'blocked'
print(list(os.listdir('/')))
`);
  await new Promise((r) => setTimeout(r, 2000));
  const after = await run('a', 'import json; print(json.dumps(res))');
  const resMap = JSON.parse(after.stdout.trim() || '{}') as Record<string, string>;
  const reached = Object.entries(resMap).filter(([, v]) => v !== 'blocked');
  ok(Object.keys(resMap).length >= 11 && reached.length === 0, `fetch, XHR, WebSocket, open() of 127.0.0.1, the sandbox's own service, the internet and host files all fail: ${JSON.stringify(resMap)}`);
  ok(hits.n === 0, `a listener on 127.0.0.1 saw ${hits.n} connections from the sandbox`);
  ok(!bad.stdout.includes('Users') && !bad.stdout.includes("'c'") && !bad.stdout.includes('mnt') && !(bad.stdout + after.stdout).includes(secret), `the sandbox sees only its own file system: ${bad.stdout.trim()}`);
  trap.close(); rmSync(secretDir, { recursive: true, force: true });

  // ---- /write never leaves the session folder
  for (const p of ['../../x.txt', 'a/../../../x.txt', '/home/user/../etc/x', '/home/user/../../x', 'x\0y']) {
    const r = await write('a', [{ path: p, data: 'no' }]);
    ok(r.status === 400, `/write ${JSON.stringify(p)} -> ${r.status} ${r.json?.error ?? ''}`);
  }
  const abs = await write('a', [{ path: '/etc/passwd', data: 'inside' }]);
  const absRead = await run('a', "print(open('/home/user/etc/passwd').read())");
  ok(abs.status === 200 && absRead.stdout.trim() === 'inside', 'any other absolute path is taken as inside the session folder (as the reference service does), not at the real place');
  await run('a', "import os\nos.symlink('/lib', '/home/user/ln')");
  const viaLink = await write('a', [{ path: 'ln/evil.txt', data: 'no' }]);
  ok(viaLink.status === 400 && (await run('a', "import os; print(os.path.exists('/lib/evil.txt'))")).stdout.trim() === 'False', `/write through a link the script planted -> ${viaLink.status} ${viaLink.json?.error}`);

  // ---- the platform's own snapshot / restore code (e2bClient.ts) works on this sandbox
  const e2b = join(root, 'vendor', 'whiq-agent', 'shared', 'chat-engine', 'server', 'sandbox', 'e2bClient.ts');
  if (existsSync(e2b)) {
    const src = readFileSync(e2b, 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
    const lit = (re: RegExp): string => { const m = re.exec(src); if (!m) throw new Error('not found in e2bClient.ts: ' + re); return new Function('STATE_SKIP_DIRS', 'STATE_SKIP_VARS', 'return `' + m[1] + '`')(['handles', 'files', 'docs', 'site-packages', 'node_modules', '__pycache__', '.cache', '.local', '.ipython', '.npm'], ['DOCS', 'HANDLES', 'load_schedule', 'In', 'Out', 'exit', 'quit', 'get_ipython']); };
    const snapFiles = lit(/const SNAPSHOT_FILES_PY = `([\s\S]*?)`;\n/), snapVars = lit(/const SNAPSHOT_VARS_PY = `([\s\S]*?)`;\n/);
    const restFiles = lit(/const restoreFilesPy = \(\): string => `([\s\S]*?)`;\n/), restVars = lit(/const restoreVarsPy = \(\): string => `([\s\S]*?)`;\n/);
    await run('snap', "import pandas as pd, numpy as np, os\nos.makedirs('out/deep', exist_ok=True)\nopen('out/deep/f.txt', 'w').write('kept file')\nopen('data.bin', 'wb').write(bytes(range(256)) * 100)\ndf = pd.DataFrame({'a': [1, 2, 3], 'b': list('xyz')})\narr = np.arange(12).reshape(3, 4)\nd = {'k': [1, 2, {'z': 3}]}\ndef f(): pass\n");
    const s1 = await run('snap', snapFiles), s2b = await run('snap', snapVars);
    ok(/WHIQ_STATE/.test(s1.stdout) && /WHIQ_VARS/.test(s2b.stdout) && !s1.error && !s2b.error, `the platform's snapshot of files and variables runs: ${(s1.stdout + s2b.stdout).trim().replace(/\n/g, ' ')} ${s1.error ?? ''} ${s2b.error ?? ''}`);
    const arcF = unB64(await run('snap', RET('/tmp/__whiq_state.tar.gz'))), arcV = unB64(await run('snap', RET('/tmp/__whiq_vars.tar.gz')));
    ok(!!arcF && !!arcV, `both archives come out through WHIQ_B64 (${arcF?.length} + ${arcV?.length} bytes)`);
    // into a NEW session, in parts of 6 MB as writeArchiveIn does, at /tmp/__whiq_state.b64.NNNNN
    const toParts = async (id: string, buf: Buffer, prefix: string) => {
      const entries: { path: string; data: string }[] = [];
      for (let i = 0, p = 0; i < Math.max(1, buf.length); i += 6 * 1024 * 1024, p++) entries.push({ path: `${prefix}.${String(p).padStart(5, '0')}`, data: buf.subarray(i, i + 6 * 1024 * 1024).toString('base64') });
      return write(id, entries);
    };
    ok((await toParts('restored', arcF!, '/tmp/__whiq_state.b64')).status === 200 && (await toParts('restored', arcV!, '/tmp/__whiq_vars.b64')).status === 200, 'the archives are written into a new sandbox under /tmp, in parts');
    const q1 = await run('restored', restFiles), q2 = await run('restored', restVars);
    ok(/WHIQ_RESTORED \{"files": \d+/.test(q1.stdout) && /WHIQ_VARS_BACK/.test(q2.stdout) && !q1.error && !q2.error, `the platform's restore runs: ${(q1.stdout + q2.stdout).trim().replace(/\n/g, ' ').slice(0, 200)} ${q1.error ?? ''}${q2.error ?? ''}`);
    const chk = await run('restored', "import hashlib\nprint(open('out/deep/f.txt').read(), len(open('data.bin','rb').read()), df.shape, df['b'].tolist(), arr.sum(), d, 'f' in globals())");
    ok(chk.stdout.trim() === "kept file 25600 (3, 2) ['x', 'y', 'z'] 66 {'k': [1, 2, {'z': 3}]} False", `files and variables (a DataFrame, an array, a dict) are back in the new sandbox; the function is named as not carried: ${chk.stdout.trim() || chk.stderr.slice(-200)}`);
  } else console.log('SKIP the platform snapshot/restore (vendor/whiq-agent is not installed)');

  // ---- kill, and the service's own door
  const before = (await call(U, '/health')).json.sessions;
  await call(U, '/kill', { id: 's1' });
  const afterKill = (await call(U, '/health')).json.sessions;
  const reborn = await run('s1', 'print("only_s1" in globals())');
  ok(afterKill === before - 1 && reborn.stdout.trim() === 'False', `/kill ends the session (${before} -> ${afterKill}); the id starts afresh when used again`);
  ok((await call(U, '/run', { code: 'print(1)' })).status === 400, 'a request without an id is refused (400)');
  const raw = (headers: Record<string, string>) => new Promise<number>((resolve) => { const u = new URL(U); const q = httpRequest({ host: '127.0.0.1', port: u.port, path: '/health', headers }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }); q.end(); });
  ok(await raw({ origin: 'https://evil.example' }) === 403, 'a request that names a web origin (a web page in a browser) is refused (403)');
  ok(await raw({ host: 'evil.example' }) === 403, 'a request under another host name (DNS rebinding) is refused (403)');
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const reachable = await new Promise<boolean>((resolve) => { const s = connect({ host: lan.address, port: Number(new URL(U).port), timeout: 2000 }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
    ok(!reachable, `the service answers on 127.0.0.1 only (${lan.address} refuses)`);
  }
} catch (e) {
  ok(false, 'the normal-instance tests ran to the end: ' + ((e as Error).stack ?? e));
} finally {
  await main.close();
}

// ---- limits and the idle reaper, with small numbers
try {
  const lim = await launch({ VM_SANDBOX_FILE_MB: '8', VM_SANDBOX_DISK_MB: '20', VM_SANDBOX_IDLE_S: '4' });
  ok(lim.selftest.ok, 'a second instance with small limits passes its self-test' + (lim.selftest.ok ? '' : ': ' + lim.selftest.checks.filter((c) => !c.ok).map((c) => c.name + ' (' + c.detail + ')').join('; ')));
  const U2 = lim.url;
  const run2 = async (id: string, code: string, ms = 0): Promise<Run> => (await call(U2, '/run', { id, code, language: 'python', timeoutMs: ms })).json;
  const big = await call(U2, '/write', { id: 'l', files: [{ path: 'big.bin', base64: Buffer.alloc(9 * 1048576, 1).toString('base64') }] });
  ok(big.status === 413 && /limit of one file/.test(big.json?.error ?? ''), `/write of a file over the per-file limit -> ${big.status} ${big.json?.error}`);
  const fileLimit = await run2('l', "try:\n    with open('f.bin', 'wb') as f:\n        for i in range(12): f.write(bytes(1048576))\n    print('wrote all')\nexcept OSError as e:\n    print('stopped:', e.errno, e.strerror)");
  ok(/stopped: \d+ File too large/.test(fileLimit.stdout), `Python writing past the per-file limit gets an OSError: ${fileLimit.stdout.trim()}`);
  const diskLimit = await run2('l', "import os\nn = 0\ntry:\n    for i in range(10):\n        with open('d%d.bin' % i, 'wb') as f: f.write(bytes(6 * 1048576))\n        n += 1\n    print('wrote all', n)\nexcept OSError as e:\n    print('stopped after', n, 'files:', e.strerror)");
  ok(/stopped after \d+ files: No space left/.test(diskLimit.stdout), `Python filling the folder past its limit gets ENOSPC: ${diskLimit.stdout.trim()}`);
  const over = await call(U2, '/write', { id: 'l', files: [{ path: 'm.bin', base64: Buffer.alloc(7 * 1048576, 1).toString('base64') }] });
  ok(over.status === 413 || over.status === 200, `/write into a nearly full folder answers ${over.status}`);
  const idleId = 'idle1';
  await run2(idleId, 'v = 1');
  const n0 = (await call(U2, '/health')).json.sessions;
  const longRun = run2('busy', 'import time\nt = time.time()\nwhile time.time() - t < 7: pass\nkeep = "alive"\nprint("done")');
  await new Promise((r) => setTimeout(r, 7500));
  const busyDone = await longRun;
  const n1 = (await call(U2, '/health')).json.sessions;
  ok(busyDone.stdout.trim() === 'done' && n1 < n0 + 1, `idle sessions are removed after the idle time (${n0 + 1} sessions -> ${n1}); a 7 s run (idle 4 s) was not cut`);
  await new Promise((r) => setTimeout(r, 1200));
  ok((await run2('busy', 'print(keep)')).stdout.trim() === 'alive', 'the busy session survived its long run (its idle time starts when the run ends)');
  await new Promise((r) => setTimeout(r, 6500));
  ok((await call(U2, '/health')).json.sessions === 0, 'every session is gone after the idle time');
  const ka = await run2('ka', 'z = 5');
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 2000)); await call(U2, '/keepalive', { id: 'ka' }); }
  ok(ka.exitCode === 0 && (await run2('ka', 'print(z)')).stdout.trim() === '5', '/keepalive holds a session past the idle time');
  await lim.close();
} catch (e) { ok(false, 'the limits instance ran to the end: ' + ((e as Error).stack ?? e)); }

// ---- each layer alone: with the page policy removed the request cancel still refuses everything
try {
  const nocsp = await launch({ P6_SANDBOX_TEST_NO_CSP: '1' });
  const rec = nocsp.selftest.checks.find((c) => /on record as refused/.test(c.name));
  const cancelled = Number(/(\d+) cancelled requests/.exec(rec?.detail ?? '')?.[1] ?? 0);
  ok(nocsp.selftest.ok && cancelled >= 4, `without the page policy the jail still holds: self-test ${nocsp.selftest.ok ? 'passes' : 'FAILS: ' + nocsp.selftest.checks.filter((c) => !c.ok).map((c) => c.name + ' (' + c.detail + ')').join('; ')}, ${cancelled} requests cancelled by the session (${rec?.detail})`);
  await nocsp.close();
} catch (e) { ok(false, 'the no-policy instance ran to the end: ' + ((e as Error).stack ?? e)); }

// ---- 503 when the jail is not proven
try {
  const bad = await launch({ P6_SANDBOX_TEST_FAIL_SELFTEST: '1' });
  const hb = await call(bad.url, '/health');
  ok(bad.selftest.ok === false && hb.json.ok === true && hb.json.jail === false, `a failed self-test: health says jail=${hb.json.jail}`);
  for (const [p, body] of [['/create', { id: 'x' }], ['/write', { id: 'x', files: [] }], ['/run', { id: 'x', code: 'print(1)', language: 'python' }], ['/kill', { id: 'x' }], ['/keepalive', { id: 'x' }], ['/interrupt', { id: 'x' }]] as const) {
    const r = await call(bad.url, p, body);
    ok(r.status === 503 && r.json.error === 'jail_unavailable' && r.json.failed.length > 0, `${p} -> ${r.status} ${r.json?.error} (failed: ${r.json?.failed?.map((c: Check) => c.name).join('; ')})`);
  }
  ok((await call(bad.url, '/selftest')).json.ok === false, '/selftest still answers, with ok:false');
  await bad.close();
} catch (e) { ok(false, 'the failed-self-test instance ran to the end: ' + ((e as Error).stack ?? e)); }

// ---- launched with --no-sandbox the renderer is not OS-sandboxed, and the self-test refuses
try {
  const ns = await launch({}, { noSandbox: true });
  const c = ns.selftest.checks.find((x) => /OS-sandboxed/.test(x.name));
  ok(ns.selftest.ok === false && c?.ok === false, `with --no-sandbox the self-test refuses: ${c?.detail}`);
  await ns.close();
} catch (e) { ok(false, 'the --no-sandbox instance ran to the end: ' + ((e as Error).stack ?? e)); }

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
