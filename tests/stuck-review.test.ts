// The review of f04a261 (stuck jobs): each finding has its test.
//  1 a Revit retry's unpack is an opaque call bounded by its own size x rate x 10 (flat memory is not death; a leak is not life)
//  2 Microsoft Project's idle rule needs a reading that covers Project
//  3 one heavy element may take as long as the step's whole size allows
//  4 where done and total are known, only done ADVANCING is a tick
//  5 memory growth is life only up to the bound, never alone
//  6 the server's own sections are watched (cancel when it still turns, end the process when it is blocked)
//  7 every stuck error says what was tried, and carries the structured facts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cpuCovering, externalWatch, heartbeatEnv, heartbeatWatcher, StuckError, stuckData, unitWatch, type StuckInfo } from '../core/bim/liveness.ts';
import { runNode } from '../core/bim/parse.ts';
import { inChromium, RenderFailed } from '../core/bim/headless.ts';
import { rvtToIfc } from '../core/bim/rvt.ts';

const ROOT = join(import.meta.dirname, '..');
const HB = pathToFileURL(join(ROOT, 'core', 'bim', 'heartbeat.mjs')).href;
const WATCH = pathToFileURL(join(ROOT, 'core', 'bim', 'serverWatch.ts')).href;
const env = (vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(was)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
};
const SHORT = { P6CLONE_HEARTBEAT_MS: '100', P6CLONE_WORKER_FLOOR_MS: '400', P6CLONE_MACHINE_FACTOR: '1' };
const FLOOR = 400;
const worker = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-review-')), p = join(dir, 'w.mjs');
  writeFileSync(p, `import { alive, opaque, progress, startHeartbeat, step, tick } from ${JSON.stringify(HB)};\nstartHeartbeat();\n${body}`);
  return p;
};
const spin = (ms: number) => `{ const t = Date.now(); while (Date.now() - t < ${ms}) { /* works, reports nothing */ } }`;
const watch = (script: string) => new Promise<{ code: number | null; stuck: StuckInfo | null; out: string; ms: number }>((done) => {
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...heartbeatEnv() } });
  let stuck: StuckInfo | null = null, out = '';
  const t0 = Date.now();
  const stop = heartbeatWatcher(child, { floorMs: FLOOR, onText: (t) => { out += t; }, onStuck: (i) => { stuck = i; child.kill(); } });
  child.on('close', (code) => { stop(); done({ code, stuck, out: out.trim(), ms: Date.now() - t0 }); });
});

// ---- 1 and 5: an unpack is one opaque call; memory growth extends it up to its bound only ----------------------------------------
test('1: an unpack whose memory stays flat (a retry in a reused WebAssembly instance) lives to its own bound, and is ended past it', async () => {
  const restore = env(SHORT);
  try {
    // expected 300 ms: the bound is max(floor 400 ms, 3 s). 2.5 s flat is more than two floors (the old 240 s rule) and inside it
    const flat = await watch(worker("step('unpacking the Revit file (rvt-rs, mode typed-no-geometry, attempt 2 of 3)', { mem: true, expect: 300 }); await new Promise((r) => setTimeout(r, 2500)); console.log('done');"));
    assert.deepEqual([flat.code, flat.stuck, flat.out], [0, null, 'done']);
    // flat past the bound: ended as an opaque call past its bound, naming it
    const past = await watch(worker("step('unpacking the Revit file (rvt-rs, mode typed-no-geometry, attempt 2 of 3)', { mem: true, expect: 300 }); await new Promise((r) => setTimeout(r, 60000));"));
    assert.equal(past.stuck?.kind, 'bound');
    assert.equal(past.stuck?.limitMs, 3000);
    assert.match(past.stuck!.step, /attempt 2 of 3/);
  } finally { restore(); }
});

test('5: memory growth is life only up to the bound: a slow leak is ended, a growing read inside its bound is not', async () => {
  const restore = env(SHORT);
  try {
    // grows every 200 ms for 2 s, inside a 3 s bound: alive although the call itself runs 5x the floor
    const grows = await watch(worker("step('unpacking', { mem: true, expect: 300 }); const keep = []; for (let i = 0; i < 10; i++) { keep.push(Buffer.alloc(4 << 20, i + 1)); await new Promise((r) => setTimeout(r, 200)); } console.log('done ' + keep.length);"));
    assert.deepEqual([grows.code, grows.stuck, grows.out], [0, null, 'done 10']);
    // a leak that never stops: alive until the bound (3 s), then no longer life; ended one bound after its last counted growth, not at 4 GB
    const leak = await watch(worker("step('unpacking', { mem: true, expect: 300 }); const keep = []; for (;;) { keep.push(Buffer.alloc(2 << 20, 1)); if (keep.length > 60) keep.shift(); await new Promise((r) => setTimeout(r, 100)); }"));
    assert.equal(leak.stuck?.kind, 'bound');
    assert.ok(leak.ms > 3000 && leak.ms < 12_000, String(leak.ms));
    // memory alone is nothing in a step with no bound at all
    const unbounded = await watch(worker("step('unpacking', { mem: true }); const keep = []; for (;;) { keep.push(Buffer.alloc(2 << 20, 1)); if (keep.length > 20) keep.shift(); await new Promise((r) => setTimeout(r, 100)); }"));
    assert.equal(unbounded.stuck?.kind, 'silent');
  } finally { restore(); }
});

// the real rvtWorker.mjs over a stand-in for rvt-rs: attempt 1 returns an error, attempt 2 unpacks for 2 s without its memory moving
test('1: rvtWorker.mjs — the second attempt’s quiet unpack is not killed (each attempt has its own bound from the file’s size)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-review-rvt-')); mkdirSync(join(dir, 'rvt'));
  for (const n of ['rvtWorker.mjs', 'heartbeat.mjs']) copyFileSync(join(ROOT, 'core', 'bim', n), join(dir, n));
  writeFileSync(join(dir, 'rvt', 'rvt_bg.wasm'), '');
  writeFileSync(join(dir, 'rvt', 'rvt.js'), `
export function initSync() { return { memory: { buffer: { byteLength: 0 } } }; }
export function fileMetadata() { return {}; }
export function rvtToIfcStream(bytes, mode) {
  if (mode === 'geometry') throw new Error('no geometry in this file'); // attempt 1 fails after its unpack
  const t = Date.now(); while (Date.now() - t < 2200) { /* attempt 2: unpacks quietly, memory flat */ }
  globalThis.__rvtIfcSink('ISO-10303-21;\\n');
  return { diagnostics: {}, revit_property_sets: null };
}`);
  const src = join(dir, 'in.rvt'); writeFileSync(src, Buffer.alloc(3 * 1048576, 1)); // 3 MB: 6 s at 2 s/MB, a bound of 60 s
  const restore = env(SHORT);
  try {
    const r = await new Promise<{ code: number | null; stuck: StuckInfo | null }>((done) => {
      const child = spawn(process.execPath, [join(dir, 'rvtWorker.mjs'), src, join(dir, 'o.ifc'), join(dir, 'o.json')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...heartbeatEnv() } });
      let stuck: StuckInfo | null = null;
      const stop = heartbeatWatcher(child, { floorMs: FLOOR, onStuck: (i) => { stuck = i; child.kill(); } });
      child.on('close', (code) => { stop(); done({ code, stuck }); });
    });
    assert.deepEqual([r.code, r.stuck], [0, null]);
    assert.ok(existsSync(join(dir, 'o.ifc')));
  } finally { restore(); }
});

// ---- 2: Microsoft Project's idle rule needs a reading that covers Project -------------------------------------------------------
test('2: no idle rule without a reading that covers Project; the size bound alone ends it', async (t) => {
  // a table that does not list the program: no reading
  assert.equal(await cpuCovering(process.pid, ['definitely-not-running-winproj.exe']), null);
  if (process.platform === 'linux') assert.ok(((await cpuCovering(process.pid, ['node'])) ?? 0) > 0, 'a program that is listed is covered');
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const ended = await new Promise<StuckInfo>((done) => { const stop = externalWatch({ step: 'converting', floorMs: 200, expectMs: 30, pollMs: 20, output: () => 0, cpu: async () => null, onStuck: (i) => { stop(); done(i); } }); });
  clearInterval(keep);
  assert.equal(ended.kind, 'bound', 'an unreadable processor time is not idleness: only the bound ends it');
  assert.equal(ended.limitMs, 300);
});

test('2/5: output that keeps growing is life only up to the bound', async (t) => {
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep)); // a failing assertion must not leave the loop held open
  let out = 0;
  const grow = setInterval(() => { out += 10; }, 30);
  t.after(() => clearInterval(grow));
  const t0 = Date.now();
  const ended = await new Promise<StuckInfo>((done) => { const stop = externalWatch({ step: 'converting', floorMs: 200, expectMs: 30, pollMs: 20, output: () => out, cpu: async () => 0, onStuck: (i) => { stop(); done(i); } }); });
  clearInterval(grow); clearInterval(keep);
  assert.ok(['bound', 'idle'].includes(ended.kind));
  assert.ok(Date.now() - t0 >= 280 && Date.now() - t0 < 2500, `a save whose file grows for ever is ended after about its bound: ${Date.now() - t0}`);
});

// ---- 3: one heavy element ---------------------------------------------------------------------------------------------------
test('3: one element that takes longer than the windows is alive inside the step’s work bound and ended past it', async () => {
  const restore = env(SHORT);
  try {
    // cap 300 ms: one tick may take 3 s. A product that spins for 1.8 s (4.5 floors, more than two windows of 400 ms) after quick ones lives
    const heavy = await watch(worker(`step('meshing products', { cap: 300 }); for (let i = 0; i < 5; i++) { tick(); await new Promise((r) => setTimeout(r, 50)); } ${spin(1800)} tick(); console.log('done');`));
    assert.deepEqual([heavy.code, heavy.stuck, heavy.out], [0, null, 'done']);
    // one that never comes back: ended, with the lengthening named
    const hung = await watch(worker(`step('meshing products', { cap: 300 }); tick(); ${spin(60_000)}`));
    assert.equal(hung.stuck?.kind, 'silent');
    assert.equal(hung.stuck?.lengthened, true);
    assert.equal(hung.stuck?.limitMs, 3000);
  } finally { restore(); }
});

// ---- 4: a tick counts only if done advanced ----------------------------------------------------------------------------------------
test('4: where done and total are known, repeated ticks with the same done are silence', async () => {
  const restore = env(SHORT);
  try {
    // the loop goes round again and again (alive() every 50 ms) without moving done: ended
    const loops = await watch(worker("step('decoding', { total: 100 }); progress(3); for (;;) { alive(); await new Promise((r) => setTimeout(r, 50)); }"));
    assert.equal(loops.stuck?.kind, 'silent');
    assert.equal(loops.stuck?.done, 3);
    assert.equal(loops.stuck?.total, 100);
    // the same loop with its total unknown: the alive ticks are all it has, and they count
    const unknown = await watch(worker("step('decoding'); progress(3); for (let i = 0; i < 40; i++) { alive(); await new Promise((r) => setTimeout(r, 50)); } console.log('done');"));
    assert.deepEqual([unknown.code, unknown.stuck], [0, null]);
    // done advancing is life
    const moving = await watch(worker("step('decoding', { total: 100 }); for (let i = 1; i <= 30; i++) { progress(i); await new Promise((r) => setTimeout(r, 60)); } console.log('done');"));
    assert.deepEqual([moving.code, moving.stuck], [0, null]);
  } finally { restore(); }
  // seen from here (render frames, tiles, ffmpeg): the same count again, or a smaller one, is not a tick
  const stuck: StuckInfo[] = [];
  const w = unitWatch({ floorMs: 100, pollMs: 10, onStuck: (i) => stuck.push(i) });
  w.beat(5, 10);
  for (let k = 0; k < 20; k++) { w.beat(5, 10); w.beat(2, 10); await new Promise((r) => setTimeout(r, 20)); }
  w.stop();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].done, 5);
});

// ---- 6: the server's own sections --------------------------------------------------------------------------------------------------
const server = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-review-srv-')), p = join(dir, 's.mts');
  writeFileSync(p, `import { startWatch, watched } from ${JSON.stringify(WATCH)};\nimport { alive, progress, tick } from ${JSON.stringify(HB)};\nconst report = ${JSON.stringify(join(dir, 'recovery', 'stuck.json'))};\nstartWatch(report, 500);\nconst o = (extra = {}) => ({ what: 'The IFC indexer', next: 'open it with geometry: false', ...extra });\n${body}`);
  return { p, report: join(dir, 'recovery', 'stuck.json') };
};
const runServer = (s: { p: string }, timeout = 30_000) => spawnSync(process.execPath, [s.p], { env: { ...process.env, ...SHORT }, encoding: 'utf8', timeout });

test('6: a section of the server that waits on something that never comes is cancelled with the reason; the server goes on', () => {
  const s = server(`
try { await watched('reading the cached model index', o({ expectMs: 50, tried: 'one pass' }), () => new Promise(() => {})); console.log('NOT CANCELLED'); }
catch (e) { console.log(JSON.stringify({ name: e.name, stuck: e.stuck, message: e.message })); }
console.log('still serving');
process.exit(0);`);
  const r = runServer(s);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const e = JSON.parse(lines[0]);
  assert.equal(e.name, 'StuckError');
  assert.equal(e.stuck.step, 'reading the cached model index');
  assert.equal(e.stuck.kind, 'bound');
  assert.equal(e.stuck.bound_ms, 500);
  assert.equal(e.stuck.tried, 'one pass');
  assert.match(e.message, /^The IFC indexer was ended as stuck while reading the cached model index: one call that cannot report progress ran past its work bound of 500 ms/);
  assert.equal(lines[1], 'still serving');
  assert.equal(existsSync(s.report), false, 'a job that could be cancelled does not end the server');
});

test('6: a section blocked in a synchronous loop ends the server process, and leaves the reason where the next server finds it', () => {
  const s = server(`
await watched('indexing the IFC (bytes read)', o({ expectMs: 50 }), () => { const t = Date.now(); while (Date.now() - t < 60000) { /* a spin */ } });
console.log('NOT ENDED');`);
  const t0 = Date.now();
  const r = runServer(s);
  assert.equal(r.signal, 'SIGKILL', `${r.status} ${r.stderr}`);
  assert.ok(Date.now() - t0 < 15_000);
  assert.match(r.stderr, /the server was ended because a section it was running \(indexing the IFC \(bytes read\)\) made no progress and blocked it/);
  const rep = JSON.parse(readFileSync(s.report, 'utf8'));
  assert.equal(rep.stuck.step, 'indexing the IFC (bytes read)');
  assert.equal(rep.stuck.kind, 'bound');
});

test('6: a ticking section is alive however long it takes; work that is not declared is never judged', () => {
  const s = server(`
await watched('indexing the IFC (bytes read)', o({ total: 100, capMs: 1000 }), async () => { for (let i = 1; i <= 25; i++) { progress(i); await new Promise((r) => setTimeout(r, 100)); } });
// undeclared: a synchronous stretch longer than any window is nobody's business to end
const t = Date.now(); while (Date.now() - t < 2500) { /* undeclared work */ }
console.log('done');
process.exit(0);`);
  const r = runServer(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'done');
});

test('6: where no watch runs (tests, P6CLONE_SERVER_WATCH=off) a section simply runs', () => {
  const s = server('');
  writeFileSync(s.p, `import { watched } from ${JSON.stringify(WATCH)};\nconsole.log(await watched('x', { what: 'w', next: 'n' }, async () => 7));`);
  const r = spawnSync(process.execPath, [s.p], { env: { ...process.env, ...SHORT }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '7');
  const off = server(`console.log(await watched('x', o({ expectMs: 1 }), async () => { await new Promise((r) => setTimeout(r, 1500)); return 'ran'; }));\nprocess.exit(0);`);
  const r2 = spawnSync(process.execPath, [off.p], { env: { ...process.env, ...SHORT, P6CLONE_SERVER_WATCH: 'off' }, encoding: 'utf8' });
  assert.equal(r2.stdout.trim(), 'ran');
});

test('6: a server adopting the folder of one that was ended as stuck tells the reason (server_status recovery.previous_server_ended_stuck)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6-review-adopt-'));
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const old = join(root, '.p6clone-recovery', `${dead}-0123456789ab`);
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'stuck.json'), JSON.stringify({ at: '2026-10-28T12:00:00.000Z', pid: dead, stuck: { step: 'indexing the IFC (bytes read)', kind: 'bound', silentMs: 700000, limitMs: 600000, expectMs: 60000 } }));
  const { config, adoptRecovery, previousStuck, recoveryStatus } = await import('../mcp/runtime.ts');
  const was = config.root; config.root = root;
  try {
    adoptRecovery();
    assert.equal(previousStuck().length >= 1, true);
    assert.equal((recoveryStatus() as { previous_server_ended_stuck?: { stuck: { step: string } }[] }).previous_server_ended_stuck?.at(-1)?.stuck.step, 'indexing the IFC (bytes read)');
  } finally { config.root = was; }
});

// ---- 7: Tried, and the structured facts ------------------------------------------------------------------------------------------------
test('7: the chunker’s and the tiler’s messages say what was tried; the result carries the structured facts', async () => {
  const restore = env(SHORT);
  try {
    const silent = worker("step('cutting the model into chunks: scanning the IFC (bytes)', { total: 1000 }); progress(10); await new Promise((r) => setTimeout(r, 60000));");
    const chunker = await runNode(silent, [], () => true, 'The IFC chunker', 'one streaming pass over the IFC statements, then the chunk files written one at a time');
    assert.equal(chunker.ok, false);
    if (chunker.ok) return;
    assert.match(chunker.note, /^The IFC chunker was ended as stuck while cutting the model into chunks: scanning the IFC \(bytes\) \(10 of 1000\): no progress for .*Tried: one streaming pass over the IFC statements, then the chunk files written one at a time\. Alternatives: open the model with geometry: false/s);
    assert.equal(chunker.stuck?.step, 'cutting the model into chunks: scanning the IFC (bytes)');
    assert.equal(chunker.stuck?.kind, 'silent');
    assert.equal(chunker.stuck?.windows, 2);
    assert.ok(chunker.stuck!.silent_ms > 0 && chunker.stuck!.window_ms! >= FLOOR);
    assert.match(chunker.stuck!.tried!, /^one streaming pass/);
    assert.match(chunker.stuck!.alternatives, /geometry: false/);
    const tiler = await runNode(worker("await new Promise((r) => setTimeout(r, 60000));"), [], () => true, 'The display tiler', 'one pass over the placed meshes, a tile file written at a time');
    assert.ok(!tiler.ok && /Tried: one pass over the placed meshes/.test(tiler.note));
  } finally { restore(); }
});

test('7: stuckData has the plan’s fields for a silence and for a bound', () => {
  const base = { step: 'x', silentMs: 480_000, windowMs: 240_000, limitMs: 480_000, maxGapMs: 60_000, expectMs: 0, floorMs: 120_000, lengthened: false };
  assert.deepEqual(stuckData({ kind: 'silent', ...base }, { tried: 't', next: 'n' }), { step: 'x', kind: 'silent', silent_ms: 480000, window_ms: 240000, windows: 2, longest_gap_ms: 60000, tried: 't', alternatives: 'n' });
  assert.deepEqual(stuckData({ kind: 'bound', ...base, expectMs: 60_000, limitMs: 600_000 }, { next: 'n' }), { step: 'x', kind: 'bound', silent_ms: 480000, bound_ms: 600000, expected_ms: 60000, alternatives: 'n' });
  const e = new StuckError({ kind: 'bound', ...base, expectMs: 60_000, limitMs: 600_000 }, { what: 'W', next: 'n' }, 'p: ', ' s');
  assert.ok(e.message.startsWith('p: W was ended as stuck while x'));
  assert.ok(e.message.endsWith(' s'));
  assert.equal(e.stuck.bound_ms, 600000);
});

test('7: a Revit read ended as stuck is an error of the open_model tool with the facts in the error (reason "stuck", stuck{step, silent_ms, tried, alternatives})', { timeout: 120_000 }, async () => {
  const restore = env({ ...SHORT });
  const { callTool, toolResult } = await import('../mcp/server.ts');
  try {
    // Revit: a stand-in reader that never answers
    const dir = mkdtempSync(join(tmpdir(), 'p6-review-rvt2-')), w = join(dir, 'w.mjs'), rvt = join(dir, 'T.rvt'), cache = join(dir, 'cache');
    writeFileSync(w, `import { startHeartbeat } from ${JSON.stringify(HB)};\nstartHeartbeat();\nawait new Promise((r) => setTimeout(r, 60000));`);
    const b = Buffer.alloc(4096, 7); Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b); writeFileSync(rvt, b); mkdirSync(cache);
    const r2 = env({ P6CLONE_RVT_WORKER: w, P6CLONE_MODEL_CACHE: cache });
    try {
      await assert.rejects(rvtToIfc(rvt), (e: unknown) => e instanceof StuckError && e.stuck.kind === 'silent' && /Tried: the reader tries up to three modes/.test(e.message));
      const r = await callTool('open_model', { path: rvt });
      const d = toolResult(r.out, r.isError).structuredContent as any;
      assert.equal(r.isError, true, JSON.stringify(d).slice(0, 300));
      const err = d.error ?? d;
      assert.equal(err.code, 'model_unreadable');
      assert.equal(err.reason, 'stuck'); // (a tool error's data is spread into the error)
      assert.equal(err.stuck.kind, 'silent');
      assert.ok(err.stuck.step && err.stuck.silent_ms > 0 && err.stuck.tried && err.stuck.alternatives, JSON.stringify(err.stuck));
    } finally { r2(); }
  } finally { restore(); }
});

test('7: a render ended as stuck carries the facts (RenderFailed.stuck)', { skip: process.platform === 'win32' && 'the stand-in browser is a script' }, async () => {
  const { chmodSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'p6-review-chrome-')), p = join(dir, 'chrome.cjs');
  writeFileSync(p, `#!${process.execPath}
const fs = require('fs'); let buf = '';
const out = (o) => fs.writeSync(4, JSON.stringify(o) + '\\0');
fs.createReadStream(null, { fd: 3 }).on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const r = (result) => out({ id: m.id, result }); if (m.method === 'Target.createTarget') r({ targetId: 't' }); else if (m.method === 'Target.attachToTarget') r({ sessionId: 's' }); else if (m.method === 'Browser.close') { r({}); setTimeout(() => process.exit(0), 10); } else if (m.method !== 'Runtime.evaluate') r({}); else if (m.params.expression.includes('status()')) r({ result: { value: { state: 'ready', tiles: { loaded: 1, total: 1 } } } }); else if (m.params.expression !== 'hang') r({ result: { value: 'ok' } }); } });`);
  chmodSync(p, 0o755);
  const page = join(dir, 'page.html'); writeFileSync(page, '<!doctype html>');
  await assert.rejects(inChromium(p, page, (ev) => ev('hang'), { floorMs: 300, what: 'the model: 3 tiles' }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && e.stuck?.kind === 'silent' && e.stuck.step === 'drawing frames in the browser' && !!e.stuck.tried && /draft/.test(e.stuck.alternatives));
});
