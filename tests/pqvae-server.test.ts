// The Node PQ-VAE sidecar's server and request handling (main/pqvae/server.ts, handlers.ts): who may call it, how big a body it takes, what it
// answers to odd `shuffles` and to more periods than the trajectory model reads, and that a call the client has dropped stops instead of
// queuing work. Skipped until scripts/pqvae-export.py has written the models.
//   node --import ./tests/setup.ts --test tests/pqvae-server.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const models = process.env.PQVAE_MODELS ?? join(root, 'vendor', 'whiq-agent', 'pqvae-onnx');
const fx = join(import.meta.dirname, 'fixtures', 'pqvae');
const skip = existsSync(join(models, 'manifest.json')) ? false : 'vendor/whiq-agent/pqvae-onnx/manifest.json is missing (python -P scripts/pqvae-export.py)';
const json = (f: string): any => JSON.parse(readFileSync(join(fx, f), 'utf8'));

let proc: ChildProcess, port = 0;
before(async () => {
  if (skip) return;
  proc = spawn(process.execPath, [join(root, 'main', 'pqvae', 'sidecar.ts'), '--models', models, '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LLM_ROUTER_URL: 'http://127.0.0.1:1', PQVAE_SHARE_ABOVE: '40' }, windowsHide: true,   // 40 distinct names, not 3000, so a small programme can pass the limit
  });
  let err = '';
  proc.stderr!.on('data', (d: Buffer) => { err += d; });
  port = await new Promise<number>((ok, no) => {
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) ok(Number(m[1])); });
    proc.on('exit', (c) => no(new Error(`sidecar exited ${c}: ${err}`)));
  });
});
after(() => { proc?.stdin!.end(); });

/** A raw HTTP call, so the Host header and the body framing are the test's to set. */
function call(o: { path?: string; method?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: number }): Promise<{ status: number; json: any }> {
  return new Promise((ok, no) => {
    let answered = false;
    const req = request({ host: '127.0.0.1', port, path: o.path ?? '/health', method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
      answered = true;
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c)).on('end', () => { req.destroy(); try { ok({ status: res.statusCode!, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }); } catch (e) { no(e); } });
    });
    req.on('error', (e) => { if (!answered || ((e as NodeJS.ErrnoException).code !== 'ECONNRESET' && (e as NodeJS.ErrnoException).code !== 'EPIPE')) no(e); });   // after the answer: the server cut off a body it refused
    if (o.chunked) {   // no Content-Length: Transfer-Encoding chunked, until the server answers
      const piece = Buffer.alloc(o.chunked);
      const pump = (): void => { if (req.destroyed) return; if (req.write(piece)) setImmediate(pump); else req.once('drain', pump); };
      pump();
    } else req.end(o.body);
  });
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call({ path, method: 'POST', body: JSON.stringify(body), headers });

// ── who may call ─────────────────────────────────────────────────────────────
test('Host must be 127.0.0.1:<port> or localhost:<port>; anything else is 403', { skip }, async () => {
  assert.equal((await call({ headers: { Host: `127.0.0.1:${port}` } })).status, 200);
  assert.equal((await call({ headers: { Host: `localhost:${port}` } })).status, 200);
  assert.equal((await call({ headers: { Host: `LOCALHOST:${port}` } })).status, 200);
  for (const h of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost.evil.example:${port}`, `[::1]:${port}`]) {
    const r = await call({ headers: { Host: h } });
    assert.equal(r.status, 403, h);
    assert.match(r.json.error, /host/);
  }
  assert.equal((await call({ path: '/encode', method: 'POST', body: '{}', headers: { Host: 'evil.example' } })).status, 403);
});

test('a request with an Origin header is 403, GET and POST, whatever the origin says', { skip }, async () => {
  for (const origin of ['http://evil.example', 'http://127.0.0.1', 'null', '']) {
    assert.equal((await call({ headers: { Origin: origin } })).status, 403, `GET Origin ${JSON.stringify(origin)}`);
    assert.equal((await call({ path: '/encode', method: 'POST', body: '{"records":[]}', headers: { Origin: origin } })).status, 403, `POST Origin ${JSON.stringify(origin)}`);
  }
  assert.equal((await call({})).status, 200);   // and the client without one is served
});

/** A request over a plain socket that reads the answer whatever happens to the rest of the upload: the server answers a
 *  refused body at once, before the upload is over, and an HTTP client may fail its upload (EPIPE) before it reads it. */
async function oversize(chunked: boolean): Promise<{ status: number; body: string }> {
  const { connect } = await import('node:net');
  return new Promise((ok) => {
    const s = connect(port, '127.0.0.1');
    const got: Buffer[] = [];
    // a whole answer (headers and as many body bytes as they declare) ends the request: kept alive as a real client does
    const answer = (): { status: number; body: string } | null => {
      const t = Buffer.concat(got).toString('utf8'), end = t.indexOf('\r\n\r\n');
      if (end < 0) return null;
      const len = Number(/content-length: *(\d+)/i.exec(t.slice(0, end))?.[1] ?? 0), body = t.slice(end + 4);
      return Buffer.byteLength(body) >= len ? { status: Number(/^HTTP\/1\.1 (\d+)/.exec(t)?.[1] ?? 0), body } : null;
    };
    s.on('data', (d: Buffer) => { got.push(d); const a = answer(); if (a) { s.destroy(); ok(a); } });
    s.on('error', () => { /* after the answer, or a refused upload */ });
    s.on('close', () => ok(answer() ?? { status: 0, body: '' }));
    const size = 65 * 1024 * 1024, piece = Buffer.alloc(1024 * 1024, 32);
    s.write(`POST /encode HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n${chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${size}`}\r\n\r\n`);
    let sent = 0;
    const pump = (): void => {
      while (sent < size && !s.destroyed) {
        sent += piece.length;
        if (!s.write(chunked ? Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n')]) : piece)) { s.once('drain', pump); return; }
      }
    };
    pump();
  });
}

test('a body over 64 MB is 413, declared by Content-Length or streamed chunked; the server stays up', { skip }, async () => {
  const a = await oversize(false);
  assert.equal(a.status, 413);
  assert.match(a.body, /64 MB/);
  const b = await oversize(true);
  assert.equal(b.status, 413);
  assert.equal((await call({})).status, 200);
  // a large body under the cap is read (it is not JSON here: 400, not 413)
  assert.equal((await call({ path: '/encode', method: 'POST', body: Buffer.alloc(8 * 1024 * 1024, 120) })).status, 400);
});

// ── odd inputs ───────────────────────────────────────────────────────────────
test('review_schedule: shuffles 0, absent or null mean 12 as in Python; below 1 answers "n/a", never NaN', { skip }, async () => {
  const c = json('review-small5.json');
  const ovr = async (shuffles: unknown) => {
    const r = await post('/review_schedule', { ...c.request, shuffles });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    return r.json.order_vs_random;
  };
  for (const s of [0, null, undefined]) assert.equal((await ovr(s)).shuffles, 12, String(s));
  assert.equal((await ovr(3)).shuffles, 3);
  for (const s of [-1, '0']) {
    const o = await ovr(s);
    assert.equal(o.shuffles, 0, String(s));
    assert.equal(o.verdict, 'n/a');
    assert.equal(o.better_than_random_share, null);
    assert.equal(o.sigma_gap, null);
    assert.match(o.note, /no random orders/);
  }
  const whole = await post('/review_schedule', { ...c.request, shuffles: -5 });
  assert.ok(whole.json.phase_order && whole.json.activities.length === c.request.records.length, 'the rest of the review is still there');
});

test('review_schedule: past the limit of distinct names, names differing in digits share a reading and the answer says so', { skip }, async () => {
  const trades = ['Pour slab level', 'Erect formwork bay', 'Install duct riser', 'Paint corridor zone'];
  const records = Array.from({ length: 120 }, (_, i) => ({ activity_id: String(i), name: `${trades[i % 4]} ${i}`, duration_days: 4 }));   // 120 distinct names, 4 patterns
  const r = await post('/review_schedule', { records, shuffles: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  assert.deepEqual(r.json.shared_name_readings, { distinct_names: 120, never_read: 120, readings: 4, limit: 40 });
  for (const where of [r.json, r.json.phase_order, r.json.order_vs_random]) assert.match(where.notice, /120 distinct activity names.*4 readings.*review it again later/);
  assert.equal(r.json.activities.length, 120, 'every activity is still reviewed');
  // the engine reads the exact names while idle; then the same programme is read exactly, with no notice
  let pending = -1;
  for (let i = 0; i < 120 && pending !== 0; i++) { await new Promise((ok) => setTimeout(ok, 500)); pending = (await call({})).json.readingLater; }
  assert.equal(pending, 0, 'the idle reading finished');
  const again = await post('/review_schedule', { records, shuffles: 2 });
  assert.equal(again.json.notice, undefined, 'read exactly the second time');
  assert.equal(again.json.shared_name_readings, undefined);
  // at or below the limit nothing is shared and no notice is added
  const small = json('review-small5.json');
  const ok = await post('/review_schedule', small.request);
  assert.equal(ok.json.notice, undefined);
  assert.equal(ok.json.shared_name_readings, undefined);
  assert.equal(ok.json.order_vs_random.notice, undefined);
});

test('trajectory: more than 120 periods says how many the model read', { skip }, async () => {
  const periods = (n: number) => Array.from({ length: n }, (_, i) => ({ period: i + 1, planned_pct: (i + 1) / n, actual_pct: 0.9 * (i + 1) / n }));
  const ok = await post('/trajectory', { periods: periods(24), ptype: 'Road', planned_months: 24 });
  assert.equal(ok.json.notice, undefined);
  assert.equal(ok.json.periods_read, undefined);
  const r = await post('/trajectory', { periods: periods(130), ptype: 'Road', planned_months: 130 });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  assert.equal(r.json.periods_read, 120);
  assert.match(r.json.notice, /first 120/);
  assert.match(r.json.notice, /ignored the last 10/);
  assert.equal(r.json.months_observed, 130);
  assert.ok(Number.isFinite(r.json.pred_overrun_x));
  // the plan is much longer than what is observed: the head reads the share elapsed, and the notice says that number
  const s = await post('/trajectory', { periods: periods(130), ptype: 'Road', planned_months: 400 });
  assert.equal(s.json.periods_read, Math.trunc(130 * 130 / 400));
  assert.match(s.json.notice, /first 42 of them/);
});

// ── a dropped call stops ─────────────────────────────────────────────────────
const longReview = (tag: string, n: number): string => JSON.stringify({ records: Array.from({ length: n }, (_, i) => ({ activity_id: String(i), name: `Cast ${tag} slab ${i} section ${(i * 7919) % 1000} grid ${i % 37}` })) });
const waitAbandoned = async (want: number): Promise<number> => {
  const t0 = Date.now();
  let h = (await call({})).json.abandoned;
  while (h < want && Date.now() - t0 < 60_000) { await new Promise((r) => setTimeout(r, 100)); h = (await call({})).json.abandoned; }
  return h;
};

test('a client that drops a long review stops it between batches; the next call is answered at once', { skip, timeout: 120_000 }, async () => {
  const h0 = (await call({})).json.abandoned;
  const req = request({ host: '127.0.0.1', port, path: '/review_schedule', method: 'POST' });
  req.on('error', () => undefined);
  req.end(longReview('a', 6000));
  await new Promise((r) => setTimeout(r, 1500));   // gone while the names are being embedded
  req.destroy();
  assert.equal(await waitAbandoned(h0 + 1), h0 + 1, 'the sidecar noticed the dropped call');
  const t1 = Date.now();
  const e = await post('/encode', { records: [{ name: 'Excavate trench', duration_days: 3 }] });
  assert.equal(e.status, 200);
  assert.equal(e.json.n, 1);
  assert.ok(Date.now() - t1 < 10_000, `the next call waited ${Date.now() - t1} ms`);
});

test('a call dropped while it waits its turn leaves nothing queued', { skip, timeout: 120_000 }, async () => {
  const h0 = (await call({})).json.abandoned;
  const open = (tag: string) => { const req = request({ host: '127.0.0.1', port, path: '/review_schedule', method: 'POST' }); req.on('error', () => undefined); req.end(longReview(tag, 3000)); return req; };
  const first = open('b');
  await new Promise((r) => setTimeout(r, 700));
  const second = open('c');   // queued behind the first
  await new Promise((r) => setTimeout(r, 700));
  second.destroy();
  first.destroy();
  assert.equal(await waitAbandoned(h0 + 2), h0 + 2);
  const t1 = Date.now();
  assert.equal((await post('/encode', { records: [{ name: 'Backfill', duration_days: 2 }] })).status, 200);
  assert.ok(Date.now() - t1 < 10_000);
});
