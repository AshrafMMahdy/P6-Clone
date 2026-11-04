// The sandbox page: a pipe between the app and the Worker that runs Python. It holds nothing of value, on purpose: no secret,
// no handle, no way to the file system or the network. Python reaches `js` of the WORKER (Pyodide's), and the worker reaches
// this page only by postMessage; this page forwards what the worker says to the app as data, and the app does not trust it.
const bridge = window.sbx;
let worker = null;
let flag = null;   // Int32Array(1) on a SharedArrayBuffer: 2 here is Ctrl-C for the running Python (Pyodide's interrupt buffer)

function startWorker(init) {
  stopWorker();
  flag = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker('worker.js', { type: 'module' });
  worker = w;
  w.onmessage = (e) => { if (worker === w) bridge.send(e.data); };
  w.onerror = (e) => { if (worker === w) bridge.send({ type: 'worker-error', message: String(e.message || 'the worker failed') }); };
  w.postMessage({ type: 'init', ...init, flag: flag.buffer });
}
function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  flag = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Facts the self-test reads about this page itself (what the app's handlers did about them is counted in the app). */
async function probe(name) {
  if (name === 'permissions') {
    const out = {};
    out.notification = await Notification.requestPermission();
    out.geolocation = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied:' + e.code), { timeout: 3000 }));
    out.camera = navigator.mediaDevices ? await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => 'denied:' + e.name) : 'unavailable';
    out.clipboard = navigator.clipboard ? await navigator.clipboard.readText().then(() => 'granted', (e) => 'denied:' + e.name) : 'unavailable';
    return out;
  }
  if (name === 'escape') {
    const out = {};
    const before = location.href;
    out.windowOpen = window.open('https://example.com/', '_blank') === null ? 'denied' : 'opened';
    const a = document.createElement('a');
    a.href = 'worker.js'; a.download = 'worker.js';
    document.body.append(a); a.click(); a.remove();
    const f = document.createElement('iframe');
    f.src = 'https://example.com/';
    document.body.append(f);
    await sleep(300);
    f.remove();
    location.href = 'https://example.com/';
    await sleep(500);
    out.stayed = location.href === before;
    return out;
  }
  throw new Error('unknown probe ' + name);
}

bridge.onMessage((m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'start') return startWorker(m.init);
  if (m.type === 'interrupt') { if (flag) { Atomics.store(flag, 0, 2); } return; }
  if (m.type === 'terminate') { stopWorker(); bridge.send({ type: 'terminated' }); return; }
  if (m.type === 'probe') {
    probe(m.name).then((value) => bridge.send({ type: 'res', id: m.id, ok: true, result: value }), (e) => bridge.send({ type: 'res', id: m.id, ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (m.type === 'req') {
    if (!worker) return bridge.send({ type: 'res', id: m.id, ok: false, error: 'the Python worker is not running' });
    const transfer = [];
    for (const f of m.files || []) if (f.bytes && f.bytes.buffer) transfer.push(f.bytes.buffer);
    worker.postMessage(m, transfer);
  }
});
bridge.send({ type: 'page-ready', facts: bridge.facts, isolated: self.crossOriginIsolated === true });
