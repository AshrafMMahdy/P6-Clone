// The Node PQ-VAE sidecar (main/pqvae/) against the Python one: every fixture in tests/fixtures/pqvae/ is a request and the response the real
// Python handlers gave (scripts/pqvae-golden.py). Discrete outputs (codes, levels, verdicts, trades, phases, counts, names) must match exactly;
// floats within 1e-3 relative or one unit of the rounding the answer shows. Skipped until scripts/pqvae-export.py has written the models.
//   node --import ./tests/setup.ts --test tests/pqvae-parity.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '../main/pqvae/tokenizer.ts';
import { Pcg64 } from '../main/pqvae/rng.ts';
import { PHASE_KW, PHASE_PROTO, TRADE_KW, TRADE_PROTO } from '../main/pqvae/tables.ts';
import { pyRound } from '../main/pqvae/pyutil.ts';

const root = join(import.meta.dirname, '..');
const models = process.env.PQVAE_MODELS ?? join(root, 'vendor', 'whiq-agent', 'pqvae-onnx');
const fx = join(import.meta.dirname, 'fixtures', 'pqvae');
const skip = existsSync(join(models, 'manifest.json')) ? false : 'vendor/whiq-agent/pqvae-onnx/manifest.json is missing (python -P scripts/pqvae-export.py)';
const json = (f: string): any => JSON.parse(readFileSync(join(fx, f), 'utf8'));

// ── a sidecar process ────────────────────────────────────────────────────────
interface Side { proc: ChildProcess; base: string; exited: Promise<number | null>; err: () => string }
async function start(env: Record<string, string> = {}): Promise<Side> {
  const proc = spawn(process.execPath, [join(root, 'main', 'pqvae', 'sidecar.ts'), '--models', models, '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LLM_ROUTER_URL: 'http://127.0.0.1:1', ...env }, windowsHide: true,
  });
  let err = '';
  proc.stderr!.on('data', (d: Buffer) => { err += d; });
  const exited = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
  const port = await new Promise<number>((ok, no) => {
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) ok(Number(m[1])); });
    void exited.then((c) => no(new Error(`sidecar exited ${c}: ${err}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}`, exited, err: () => err };
}
const post = async (s: Side, path: string, body: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(s.base + path, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

let main: Side;
before(async () => { if (!skip) main = await start(); });
after(() => { main?.proc.stdin!.end(); });

// ── comparison ───────────────────────────────────────────────────────────────
/** Decimals the Python sidecar rounds each float key to; a value may differ by one unit of its last place (a double on the edge of a rounding step). */
const DECIMALS: Record<string, number> = {
  project_score: 3, z: 2, clean_mean: 3, position_frac: 3, surprise: 2, surprise_z: 2, corpus_z: 2, duration_flag: 3,
  kendall_tau: 2, better_than_random_share: 2, sigma_gap: 2, pred_overrun_x: 3, pred_delay_months: 1, pred_delay_months_adjusted: 1,
};
const stats = { floats: 0, unitSteps: 0, maxRel: 0 };

function same(path: string, key: string, got: any, want: any, errs: string[]): void {
  if (errs.length > 12) return;
  if (typeof want === 'number' && typeof got === 'number') {
    if (key in DECIMALS || !Number.isInteger(want)) {
      stats.floats++;
      const d = Math.abs(got - want), unit = 10 ** -(DECIMALS[key] ?? 6);
      if (d > 0) stats.maxRel = Math.max(stats.maxRel, d / Math.max(Math.abs(want), 1e-12));
      if (d > 1e-12 && d <= unit * 1.0001) stats.unitSteps++;
      if (d > 1e-12 && process.env.PQVAE_TEST_VERBOSE) console.log(`# diff ${path}: ${got} vs ${want}`);
      if (d > Math.max(1e-3 * Math.abs(want), unit * 1.0001)) errs.push(`${path}: ${got} vs ${want}`);
    } else if (got !== want) errs.push(`${path}: ${got} vs ${want}`);
  } else if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) { errs.push(`${path}: length ${got?.length} vs ${want.length}`); return; }
    want.forEach((w, i) => same(`${path}[${i}]`, key, got[i], w, errs));
  } else if (want && typeof want === 'object') {
    if (!got || typeof got !== 'object') { errs.push(`${path}: ${JSON.stringify(got)} vs object`); return; }
    for (const k of Object.keys(want)) same(`${path}.${k}`, k, got[k], want[k], errs);
    for (const k of Object.keys(got)) if (!(k in want)) errs.push(`${path}.${k}: extra key`);
  } else if (got !== want) errs.push(`${path}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
}

const SPECIAL = new Set(['names.json', 'tokenizer.json', 'tables.json', 'rng.json']);
const cases = readdirSync(fx).filter((f) => f.endsWith('.json') && !SPECIAL.has(f)).sort();

test('health: ok, the calibration label, engines listed once loaded', { skip }, async () => {
  const man = JSON.parse(readFileSync(join(models, 'manifest.json'), 'utf8'));
  const h = await (await fetch(main.base + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.calibration, 'v2-minilm');
  assert.equal(man.calibration, 'v2-minilm');
  assert.ok(Array.isArray(h.loaded));
  assert.equal((await fetch(main.base + '/nope')).status, 404);
});

for (const f of cases) {
  const c = json(f);
  test(`${c.endpoint} ${f.replace('.json', '')}`, { skip }, async () => {
    const r = await post(main, c.endpoint, c.request);
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    const errs: string[] = [];
    same('$', '', r.json, c.response, errs);
    assert.deepEqual(errs, []);
    assert.equal(r.json.calibration, 'v2-minilm');
  });
}

test('after the fixtures: engines loaded, and the float differences are rounding steps only', { skip }, async () => {
  const h = await (await fetch(main.base + '/health')).json();
  assert.deepEqual(h.loaded, ['ar', 'tok_a', 'traj']);
  console.log(`# ${stats.floats} floats compared, ${stats.unitSteps} one-unit rounding steps, largest relative difference ${stats.maxRel.toExponential(2)}`);
});

test('endpoints no scheduler chat reaches answer 200 with an error; unknown ones 404; bad json 400', { skip }, async () => {
  for (const p of ['/heartbeat', '/tender_review', '/claim_quantum', '/riskreg', '/risk_catalog', '/forensic', '/comms', '/payments']) {
    const r = await post(main, p, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.error, `${p} is not part of the desktop app's scheduler agent`);
  }
  assert.equal((await post(main, '/nothing', {})).status, 404);
  const bad = await fetch(main.base + '/encode', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^bad json/);
  const miss = await post(main, '/review_schedule', {});
  assert.equal(miss.status, 500);
  assert.equal(miss.json.error, "'records'");
});

// ── pieces ──────────────────────────────────────────────────────────────────
test('tokenizer: ids equal the Python tokenizer on activity names, Arabic, Finnish, German, accents and a Unicode sweep', { skip }, () => {
  const tk = new Tokenizer(JSON.parse(readFileSync(join(models, 'tokenizer.json'), 'utf8')));
  const t = json('tokenizer.json') as Array<{ text: string; ids: number[] }>;
  assert.ok(t.length > 3000);
  const bad = t.filter((c) => JSON.stringify(tk.encode(c.text)) !== JSON.stringify(c.ids));
  assert.deepEqual(bad.slice(0, 5), []);
});

test("rng: default_rng(seed).permutation(n) is numpy's, bit for bit", () => {
  for (const s of json('rng.json') as Array<{ seed: number; perms: Array<{ n: number; perm: number[] }> }>) {
    const g = new Pcg64(s.seed);
    for (const p of s.perms) assert.deepEqual(g.permutation(p.n), p.perm, `seed ${s.seed} n ${p.n}`);
  }
});

test('keyword tables and prototype phrases are the Python sidecar\'s', () => {
  const t = json('tables.json');
  assert.deepEqual(TRADE_KW, t.trade_kw);
  assert.deepEqual(PHASE_KW, t.phase_kw);
  assert.deepEqual(TRADE_PROTO, t.trade_proto);
  assert.deepEqual(PHASE_PROTO, t.phase_proto);
});

test("pyRound is Python's round (exact value, ties to even)", () => {
  const want: Array<[number, number, number]> = [[0.125, 2, 0.12], [0.375, 2, 0.38], [2.675, 2, 2.67], [1.005, 2, 1], [0.5, 0, 0], [1.5, 0, 2], [2.5, 0, 2], [-0.5, 0, -0], [1234.5678, 3, 1234.568], [0.0005, 3, 0.001], [7.25, 1, 7.2], [7.35, 1, 7.3], [1e-9, 3, 0]];
  for (const [x, nd, y] of want) assert.ok(Object.is(pyRound(x, nd), y) || pyRound(x, nd) === y, `${x} ${nd}: ${pyRound(x, nd)} vs ${y}`);
});

// ── the decide seat ──────────────────────────────────────────────────────────
interface Router { server: Server; url: string; calls: any[]; mode: { v: string } }
async function fakeRouter(): Promise<Router> {
  const calls: any[] = [], mode = { v: 'ok' };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({ url: req.url, body });
      if (mode.v === '424') { res.writeHead(424); res.end('{"error":"role_not_configured"}'); return; }
      const answers: Record<string, any> = {};
      for (const [k, q] of Object.entries<any>(body.questions)) {
        const want = k.endsWith('_trade') ? 'finishes' : 'commissioning';
        const conf = mode.v === 'unsure' ? 0.4 : 0.8;
        answers[k] = { type: 'choice', choice: want, confidence: conf, probabilities: Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === want ? conf : (1 - conf) / (Object.keys(q.criteria).length - 1)])) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers, model: 'stub' }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, calls, mode };
}
const names = (prefix: string, n: number): any[] => Array.from({ length: n }, (_, i) => ({ activity_id: String(i), name: `${prefix} ${i}`, duration_days: 10, position_frac: i / Math.max(n - 1, 1), ptype: 'Office' }));

test('decide seat: chunks of 100 activity names, per-name cache, the seat\'s pick wins over the keywords, <0.5 confidence keeps the old chain, 60 s back-off', { skip }, async () => {
  const router = await fakeRouter();
  const side = await start({ LLM_ROUTER_URL: router.url });
  try {
    // 250 distinct names -> 3 calls (100, 100, 50); the pick is applied to trade and phase of every activity (a keyword name included)
    const recs = names('Zork', 249);
    recs.push({ activity_id: 'k', name: 'Concrete pour', duration_days: 5, position_frac: 0.5, ptype: 'Office' });
    const r = await post(side, '/review_schedule', { records: recs, shuffles: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
    assert.equal(router.calls.length, 3);
    assert.deepEqual(router.calls.map((c) => c.url), ['/api/decide', '/api/decide', '/api/decide']);
    assert.deepEqual(router.calls.map((c) => Object.keys(c.body.questions).length), [200, 200, 100]);
    const first = router.calls[0].body;
    assert.match(first.state, /^a0: Zork 0\na1: Zork 1\n/);
    assert.equal(first.state.split('\n').length, 100);
    assert.deepEqual(Object.keys(first.questions).slice(0, 2), ['a0_trade', 'a0_phase']);
    assert.equal(first.questions.a0_trade.type, 'choice');
    assert.deepEqual(Object.keys(first.questions.a0_trade.criteria), ['general', 'civil', 'structure', 'architecture', 'mep_mech', 'mep_elec', 'mep_plumb', 'finishes', 'commissioning']);
    assert.equal(first.questions.a0_trade.criteria.civil, 'bulk excavation and earthworks; piling and foundations; drainage and external civil works; ground works');
    assert.deepEqual(Object.keys(first.questions.a0_phase.criteria), ['mobilization', 'substructure', 'superstructure', 'envelope', 'rough_in', 'finishes', 'commissioning']);
    assert.match(first.questions.a0_trade.instructions, /^Activity a0 in the state: which construction trade performs it\?/);
    for (const a of r.json.activities) { assert.equal(a.trade, 'finishes', a.name); assert.equal(a.phase, 'commissioning', a.name); }
    // the same names again: answered from the cache, the router is not asked
    await post(side, '/review_schedule', { records: recs, shuffles: 1 });
    assert.equal(router.calls.length, 3);
    // a seat that is unsure (confidence 0.4) leaves the keyword -> MiniLM -> position chain in charge
    router.mode.v = 'unsure';
    const u = await post(side, '/review_schedule', { records: [{ activity_id: '1', name: 'Bulk excavation', position_frac: 0.1, duration_days: 9 }, { activity_id: '2', name: 'Concrete frame', position_frac: 0.4, duration_days: 9 }, { activity_id: '3', name: 'Painting walls', position_frac: 0.9, duration_days: 9 }], shuffles: 1 });
    assert.equal(router.calls.length, 4);
    assert.deepEqual(u.json.activities.map((a: any) => [a.trade, a.phase]), [['civil', 'substructure'], ['structure', 'superstructure'], ['finishes', 'finishes']]);
    // no seat (424): the old chain, and the seat is left alone for a minute
    router.mode.v = '424';
    const e = await post(side, '/encode', { records: names('Quux', 4) });
    assert.equal(e.status, 200);
    assert.equal(router.calls.length, 5);
    router.mode.v = 'ok';
    await post(side, '/encode', { records: names('Corge', 4) });
    assert.equal(router.calls.length, 5, 'inside the 60 s back-off the router is not asked');
  } finally { side.proc.stdin!.end(); await side.exited; router.server.close(); }
});

test('stdin closing ends the process; the port line is JSON; it listens on 127.0.0.1 only', { skip }, async () => {
  const side = await start();
  const h = await fetch(side.base + '/health');
  assert.equal(h.status, 200);
  assert.match(side.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  side.proc.stdin!.end();
  const code = await Promise.race([side.exited, new Promise<string>((r) => setTimeout(() => r('still running'), 8000))]);
  assert.equal(code, 0);
  await assert.rejects(fetch(side.base + '/health', { signal: AbortSignal.timeout(2000) }));
});

test('no model folder: exits with a message instead of listening', async () => {
  const p = spawn(process.execPath, [join(root, 'main', 'pqvae', 'sidecar.ts'), '--models', join(root, 'no-such-folder')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d: Buffer) => { err += d; });
  const code = await new Promise<number | null>((r) => p.on('exit', r));
  assert.equal(code, 2);
  assert.match(err, /no model folder/);
});

test('a programme past the 256 positions of the sequencing model is scored in windows (the Python sidecar fails on it)', { skip }, async () => {
  const recs = names('Install item', 300).map((r, i) => ({ ...r, name: `${['Excavation', 'Concrete frame', 'Facade', 'Ductwork', 'Painting'][Math.floor(i / 60)]} zone ${i}` }));
  const r = await post(main, '/review_schedule', { records: recs, shuffles: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 200));
  assert.equal(r.json.activities.length, 300);
  assert.deepEqual(r.json.windowed_scoring, { window: 256, stride: 128, activities: 300, note: r.json.windowed_scoring.note });
  assert.ok(r.json.activities.every((a: any) => Number.isFinite(a.surprise)));
});
