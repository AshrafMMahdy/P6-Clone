// One session's Python: Pyodide (CPython compiled to WebAssembly) in a dedicated worker of the sandbox page. State is the
// worker's: a persistent namespace, an in-memory file system (/home/user is the session folder, /tmp is scratch). The page
// can stop a running cell by writing 2 into the interrupt buffer; it can end this worker for good (terminate).
import { loadPyodide } from './pyodide/pyodide.mjs';

const BASE = new URL('./', self.location.href).href;
const HOME = '/home/user';
const violations = [];   // what the page's security policy refused (the self-test reads it: a refusal there is the jail, not a lost network)
self.addEventListener('securitypolicyviolation', (e) => { violations.push(`${e.effectiveDirective} ${e.blockedURI}`); if (violations.length > 200) violations.shift(); });

// The kernel, as Python: output captured per run and cut at MAX_OUT characters, SystemExit / KeyboardInterrupt handled, one
// namespace kept between runs, imports resolved from the session folder first (09 Local Sandbox/worker.py does the same).
const BOOT = String.raw`
import builtins, io, json, os, sys, traceback

MAX_OUT = @MAX_OUT@
os.makedirs('/home/user', exist_ok=True)
os.chdir('/home/user')
os.environ.update({'HOME': '/home/user', 'LANG': 'C.UTF-8', 'MPLBACKEND': 'Agg', 'MPLCONFIGDIR': '/tmp', 'PYTHONDONTWRITEBYTECODE': '1'})
sys.dont_write_bytecode = True

# time.sleep waits in slices, so that a stop (Ctrl-C) lands within 50 ms; Pyodide's own sleep cannot be interrupted
import time as _time
_real_sleep = _time.sleep
def _sleep(seconds):
    end = _time.monotonic() + seconds
    while True:
        left = end - _time.monotonic()
        if left <= 0: break
        _real_sleep(min(left, 0.05))
_time.sleep = _sleep
sys.path[:] = ['/home/user'] + [p for p in sys.path if p not in ('', '/home/user')]
G = {'__name__': '__main__', '__builtins__': builtins}   # the session's namespace, kept between runs


class _Raw(io.RawIOBase):
    def __init__(self, cap): self.cap = cap
    def writable(self): return True
    def write(self, b):
        self.cap.write(bytes(b).decode('utf-8', 'replace')); return len(b)


class _Cap(io.TextIOBase):
    """stdout / stderr of one run: keeps the first MAX_OUT characters (more are counted, not kept), so a loop that prints for ever cannot fill the memory."""
    def __init__(self):
        self.parts, self.n = [], 0
        self.buffer = _Raw(self)
    @property
    def encoding(self): return 'utf-8'
    @property
    def errors(self): return 'replace'
    def writable(self): return True
    def isatty(self): return False
    def flush(self): pass
    def write(self, s):
        if not isinstance(s, str): raise TypeError('write() argument must be str, not %s' % type(s).__name__)
        room = MAX_OUT + 1 - self.n
        if room > 0:
            piece = s[:room]; self.parts.append(piece); self.n += len(piece)
        return len(s)
    def text(self):
        t = ''.join(self.parts)
        return t if len(t) <= MAX_OUT else t[:MAX_OUT] + '\n[output cut at %d characters]' % MAX_OUT


def run_cell(code):
    out, err = _Cap(), _Cap()
    saved = sys.stdout, sys.stderr, sys.stdin
    sys.stdout, sys.stderr, sys.stdin = out, err, io.StringIO('')
    error = None
    try:
        exec(compile(code, '<run>', 'exec'), G)
    except KeyboardInterrupt:
        error = {'name': 'Timeout', 'value': 'stopped: the run went over its time limit', 'traceback': ''}
    except SystemExit as e:
        if e.code not in (None, 0): error = {'name': 'SystemExit', 'value': 'exit code %s' % (e.code,), 'traceback': ''}
    except BaseException as e:   # the agent's code may raise anything; the kernel must outlive it
        tb = e.__traceback__
        tb = tb.tb_next if tb is not None else None   # not this function's own frame
        error = {'name': type(e).__name__, 'value': str(e), 'traceback': ''.join(traceback.format_exception(type(e), e, tb))}
    finally:
        sys.stdout, sys.stderr, sys.stdin = saved
    return json.dumps({'stdout': out.text(), 'stderr': err.text(), 'error': error})


run_cell
`;

let pyodide = null, FS = null, runCell = null, flag = null, limits = null;
let resolveInit = () => {};
const initialised = new Promise((resolve) => { resolveInit = resolve; });

// ---- limits: a file cannot grow past fileBytes, the folder not past diskBytes (the in-memory file system counts against the
// browser's memory, so a script that fills it would take the session's process with it)
function folderBytes() {
  let total = 0;
  for (const root of [HOME, '/tmp']) {
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let names;
      try { names = FS.readdir(d); } catch { continue; }
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const p = d + '/' + n;
        let st;
        try { st = FS.lstat(p); } catch { continue; }
        if (FS.isDir(st.mode)) stack.push(p); else if (FS.isFile(st.mode)) total += st.size;
      }
    }
  }
  return total;
}
function installLimits() {
  const original = FS.write;
  let since = 0;
  FS.write = function (stream, buffer, offset, length, position, canOwn) {
    if (FS.isFile(stream.node.mode) && ((stream.path || '').startsWith(HOME + '/') || (stream.path || '').startsWith('/tmp/'))) {   // the session's own files; not the packages being unpacked into site-packages
      const at = position ?? ((stream.flags & 1024) ? stream.node.usedBytes : stream.position);
      if (at + length > limits.fileBytes) throw new FS.ErrnoError(22);   // EFBIG: "File too large"
      since += length;
      if (since >= limits.scanBytes) {
        since = 0;
        if (folderBytes() + length > limits.diskBytes) throw new FS.ErrnoError(51);   // ENOSPC: "No space left on device"
      }
    }
    return original.call(FS, stream, buffer, offset, length, position, canOwn);
  };
}

// ---- files the app writes: never through a link, never outside /home/user (or /tmp, where the platform's snapshot restore stages its parts)
function fail(message, kind) { return Object.assign(new Error(message), { kind }); }
function safeWrite(path, bytes) {
  if (!(path.startsWith(HOME + '/') || path.startsWith('/tmp/'))) throw fail('path leaves the session folder: ' + path, 'path');
  if (bytes.length > limits.fileBytes) throw fail(`${path} is ${Math.ceil(bytes.length / 1048576)} MB, over the ${Math.floor(limits.fileBytes / 1048576)} MB limit of one file`, 'size');
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur += '/' + parts[i];
    let st = null;
    try { st = FS.lstat(cur); } catch { st = null; }
    if (!st) { FS.mkdir(cur); continue; }
    if (FS.isLink(st.mode)) throw fail('a link is in the way of ' + path, 'path');
    if (!FS.isDir(st.mode)) throw fail('not a folder: ' + cur, 'path');
  }
  let old = 0;
  let st = null;
  try { st = FS.lstat(path); } catch { st = null; }
  if (st) {
    if (FS.isLink(st.mode)) throw fail('a link is in the way of ' + path, 'path');
    if (FS.isDir(st.mode)) throw fail('a folder is in the way of ' + path, 'path');
    old = st.size;
  }
  if (folderBytes() - old + bytes.length > limits.diskBytes) throw fail(`the sandbox folder would pass its ${Math.floor(limits.diskBytes / 1048576)} MB limit`, 'size');
  FS.writeFile(path, bytes);
}

const INTERRUPTED = JSON.stringify({ stdout: '', stderr: '', error: { name: 'Timeout', value: 'stopped: the run went over its time limit', traceback: '' } });
function run(code) {
  const used = Math.ceil(folderBytes() / 1048576);
  if (used > limits.diskBytes / 1048576) return { diskFull: used };
  Atomics.store(flag, 0, 0);   // an interrupt that came while nothing ran is not for this run
  let raw;
  try { raw = runCell(code); } catch (e) {   // the interrupt landed outside the cell's own handler
    const text = String((e && e.message) || e);
    raw = /KeyboardInterrupt/.test(text) ? INTERRUPTED : JSON.stringify({ stdout: '', stderr: '', error: { name: 'InternalError', value: text, traceback: '' } });
  }
  Atomics.store(flag, 0, 0);
  return JSON.parse(raw);
}

async function init(msg) {
  const t0 = performance.now();
  flag = new Int32Array(msg.flag);
  limits = msg.limits;
  pyodide = await loadPyodide({ indexURL: BASE + 'pyodide/', fullStdLib: false });
  FS = pyodide.FS;
  pyodide.setInterruptBuffer(flag);
  FS.mkdirTree(HOME);
  runCell = pyodide.runPython(BOOT.replace('@MAX_OUT@', String(limits.maxOut)), { globals: pyodide.globals.get('dict')() });
  const tCore = performance.now() - t0;
  let tPackages = 0;
  let loaded = [];
  if (msg.packages.length) {
    const t1 = performance.now();
    const errors = [];
    await pyodide.loadPackage(msg.packages, { messageCallback: () => {}, errorCallback: (m) => errors.push(m) });
    tPackages = performance.now() - t1;
    loaded = Object.keys(pyodide.loadedPackages);
    if (errors.length) throw new Error('packages did not load: ' + errors.slice(0, 3).join('; '));
  }
  installLimits();   // after the packages: unpacking a wheel writes it to /tmp first, and that is not the script's file
  return { python: pyodide.runPython('import sys; sys.version.split()[0]'), pyodide: pyodide.version, loaded, coreMs: Math.round(tCore), packagesMs: Math.round(tPackages), isolated: self.crossOriginIsolated === true };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const info = await init(m);
      resolveInit(true);
      self.postMessage({ type: 'ready', info });
    } catch (err) {
      self.postMessage({ type: 'fatal', error: String((err && err.stack) || err) });
    }
    return;
  }
  if (m.type !== 'req') return;
  await initialised;
  const reply = (body) => self.postMessage({ type: 'res', id: m.id, ...body });
  try {
    if (m.kind === 'run') return reply({ ok: true, result: run(String(m.code ?? '')) });
    if (m.kind === 'write') {
      for (const f of m.files) safeWrite(String(f.path), f.bytes);
      return reply({ ok: true });
    }
    if (m.kind === 'facts') {
      const names = ['process', 'require', 'module', 'Buffer', 'electron', 'ipcRenderer', 'sbx', 'RTCPeerConnection', 'WebTransport', 'SharedArrayBuffer'];
      return reply({ ok: true, result: { violations: violations.slice(), isolated: self.crossOriginIsolated === true, folderBytes: folderBytes(), types: Object.fromEntries(names.map((n) => [n, typeof self[n]])) } });
    }
    reply({ ok: false, error: 'unknown request ' + m.kind });
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err), errorKind: err && err.kind });
  }
};
