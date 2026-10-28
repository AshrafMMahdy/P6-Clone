// Stuck jobs (owner rules 2026-10-27, 2026-10-28): no fixed time limits. Layer 1: a loop we own ticks; a job is ended after two
// windows without a tick, a window being 4 times the longest gap THIS job showed (never under the floor), and processor time is
// not life. Layer 2: one opaque call is ended past 10 times its expected time (input size x the measured rate on this machine).
// Stand-in workers, a stand-in ffmpeg and a stand-in page stand for the real ones, for every class:
//   slow but ticking: never ended | silent: ended | spinning with no tick: ended | opaque within its bound: alive | past it: ended
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BOUND_MULTIPLE, expectedMs, machineFactor, noteRate, rateEnv } from '../core/bim/heartbeat.mjs';
import { externalWatch, heartbeatEnv, heartbeatWatcher, judge, stuckMessage, unitWatch, type StepState, type StuckInfo } from '../core/bim/liveness.ts';
import { inPage, RenderFailed, webmToMp4, whileEncoding } from '../core/bim/headless.ts';
import { planRender } from '../core/bim/renderplan.ts';

const ROOT = join(import.meta.dirname, '..');
const HB = pathToFileURL(join(ROOT, 'core', 'bim', 'heartbeat.mjs')).href;
const PARSE = pathToFileURL(join(ROOT, 'core', 'bim', 'parse.ts')).href;
const WIN = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(was)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
};
const SHORT = { P6CLONE_HEARTBEAT_MS: '100', P6CLONE_WORKER_FLOOR_MS: '400', P6CLONE_MACHINE_FACTOR: '1' };
const FLOOR = 400;

/** A worker script: heartbeat.mjs's API is in scope (startHeartbeat already called). */
const worker = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stuck-')), p = join(dir, 'w.mjs');
  writeFileSync(p, `import { alive, opaque, progress, startHeartbeat, step, tick } from ${JSON.stringify(HB)};\nstartHeartbeat();\n${body}`);
  return p;
};
const spin = (ms: number) => `{ const t = Date.now(); while (Date.now() - t < ${ms}) { /* the processor works, nothing is reported */ } }`;
const watch = (script: string) => new Promise<{ code: number | null; stuck: StuckInfo | null; out: string; ms: number }>((done) => {
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...heartbeatEnv() } });
  let stuck: StuckInfo | null = null, out = '';
  const t0 = Date.now();
  const stop = heartbeatWatcher(child, { floorMs: FLOOR, onText: (t) => { out += t; }, onStuck: (i) => { stuck = i; child.kill(); } });
  child.on('close', (code) => { stop(); done({ code, stuck, out: out.trim(), ms: Date.now() - t0 }); });
});

// ---- the rule itself ----------------------------------------------------------------------------------------------------
const at = (o: Partial<StepState>): StepState => ({ step: 's', sinceMs: 0, maxGapMs: 0, expectMs: 0, capMs: 0, ...o });
test('judge: a window is 4 x the longest gap, never under the floor; two windows of silence are stuck; an opaque call has 10 x its expected time', () => {
  assert.equal(BOUND_MULTIPLE, 10);
  assert.equal(judge(at({ sinceMs: 799 }), 400), null, 'under two floors');
  assert.equal(judge(at({ sinceMs: 801 }), 400)?.kind, 'silent');
  // a job whose ticks were 500 ms apart: windows of 2 s, so 3.9 s of silence is alive and 4.1 s is stuck
  assert.equal(judge(at({ maxGapMs: 500, sinceMs: 3900 }), 400), null);
  const i = judge(at({ maxGapMs: 500, sinceMs: 4100 }), 400)!;
  assert.deepEqual([i.kind, i.windowMs, i.limitMs, i.lengthened], ['silent', 2000, 4000, false]);
  // opaque: 10 x expected, never under the floor
  assert.equal(judge(at({ expectMs: 1000, sinceMs: 9999 }), 400), null);
  const b = judge(at({ expectMs: 1000, sinceMs: 10_001 }), 400)!;
  assert.deepEqual([b.kind, b.limitMs, b.expectMs], ['bound', 10_000, 1000]);
  assert.equal(judge(at({ expectMs: 10, sinceMs: 399 }), 400), null, 'a small input still has the floor');
  assert.equal(judge(at({ expectMs: 10, sinceMs: 401 }), 400)?.kind, 'bound');
  // a step that knows its whole work (capMs) allows ONE tick to take as long as 10 x that work: a single heavy element is bounded by the
  // size of what it works on, which cannot be known before it is done, so by the step's size. It LENGTHENS the limit, never shortens it
  const c = judge(at({ maxGapMs: 100, capMs: 60_000, sinceMs: 300_000 }), 120_000);
  assert.equal(c, null, '5 minutes for one element, inside 10 x the run\u2019s 1 minute');
  const d = judge(at({ maxGapMs: 100, capMs: 60_000, sinceMs: 601_000 }), 120_000)!;
  assert.deepEqual([d.kind, d.limitMs, d.lengthened], ['silent', 600_000, true]);
  assert.equal(judge(at({ maxGapMs: 100, capMs: 10, sinceMs: 241_000 }), 120_000)?.limitMs, 240_000, 'a small bound does not shorten two windows');
  // a window of its own (a browser starting)
  assert.equal(judge(at({ windowMs: 60_000, sinceMs: 119_000 }), 400), null);
  assert.equal(judge(at({ windowMs: 60_000, sinceMs: 121_000 }), 400)?.kind, 'silent');
});

test('the words for an ended job: the step, how long, the bound, what was tried, the alternatives', () => {
  const silent = stuckMessage({ kind: 'silent', step: 'meshing products', done: 1200, silentMs: 480_000, windowMs: 240_000, limitMs: 480_000, maxGapMs: 60_000, expectMs: 0, floorMs: 120_000, lengthened: false }, { what: 'The geometry worker', tried: 'a single pass', next: 'split the model' });
  assert.equal(silent, 'The geometry worker was ended as stuck while meshing products (1200 done): no progress for 8 minutes (two windows of 4 minutes, each 4 times the longest gap between steps this job showed (60 s), at least 2 minutes). Tried: a single pass. Alternatives: split the model.');
  const bound = stuckMessage({ kind: 'bound', step: 'reading the IFC (web-ifc OpenModel)', silentMs: 3_700_000, windowMs: 3_600_000, limitMs: 3_600_000, maxGapMs: 0, expectMs: 360_000, floorMs: 120_000, lengthened: false }, { what: 'The geometry worker', next: 'export in parts' });
  assert.match(bound, /^The geometry worker was ended while reading the IFC \(web-ifc OpenModel\)|^The geometry worker was ended as stuck while reading the IFC \(web-ifc OpenModel\): one call that cannot report progress ran past its work bound of 60 minutes \(about 6 minutes expected for this input at this machine's measured rate, times 10\); it had been silent for 61\.7 minutes\. Alternatives: export in parts\.$/);
});

// ---- the bound's inputs: size x the slower of the benchmark-scaled rate and the job's own ------------------------------
test('expectedMs: input size x the rate on this machine; the job’s own slower rate wins; under 1 MB tells nothing', () => {
  const restore = env({ P6CLONE_MACHINE_FACTOR: '2' });
  try {
    assert.equal(machineFactor(), 2);
    const mb = 1048576;
    // geometry 0.4 s/MB x factor 2 = 0.8 s/MB: 100 MB = 80 s (the factor is read once per process: 2 here or 1 if an earlier call fixed it)
    const f = machineFactor();
    assert.equal(Math.round(expectedMs(100 * mb, 'geometry')), Math.round(100 * 0.4 * f * 1000));
    noteRate('geometry', 500, 0.5 * mb); // too small: ignored
    assert.equal(Math.round(expectedMs(100 * mb, 'geometry')), Math.round(100 * 0.4 * f * 1000));
    noteRate('geometry', 200 * 1000, 100 * mb); // 2 s/MB measured on this job: slower than 0.4 x f
    assert.equal(Math.round(expectedMs(100 * mb, 'geometry')), Math.round(100 * Math.max(0.4 * f, 2) * 1000));
    const e = rateEnv();
    assert.ok(Number(e.P6CLONE_MACHINE_FACTOR) >= 1 && Number(e.P6CLONE_MACHINE_FACTOR) <= 5);
    assert.ok(JSON.parse(e.P6CLONE_OWN_RATES).geometry >= 2);
  } finally { restore(); }
});

// ---- the workers: every class, through the real heartbeat thread and the real parent watch -----------------------------
test('worker class: slow but ticking is NEVER ended, however long it takes (progress, tick and alive all count)', async () => {
  const restore = env(SHORT);
  try {
    // 3 s: seven windows of the floor, one tick every 200 ms
    const slow = await watch(worker("step('meshing products'); let n = 0; await new Promise((r) => { const t = setInterval(() => { n++; if (n % 3 === 0) tick(); else if (n % 3 === 1) progress(n); else alive(); if (n >= 15) { clearInterval(t); r(); } }, 200); }); console.log('done');"));
    assert.deepEqual([slow.code, slow.stuck, slow.out], [0, null, 'done']);
    assert.ok(slow.ms >= 2800);
  } finally { restore(); }
});

test('worker class: silent is ended, and the window is sized from THIS job’s own longest gap', async () => {
  const restore = env(SHORT);
  try {
    const silent = await watch(worker("step('cutting the model into chunks'); await new Promise((r) => setTimeout(r, 60000));"));
    assert.equal(silent.stuck?.kind, 'silent');
    assert.equal(silent.stuck?.step, 'cutting the model into chunks');
    assert.ok(silent.stuck!.silentMs >= 800 && silent.ms < 6000, `${silent.stuck!.silentMs} ${silent.ms}`);
    assert.notEqual(silent.code, 0);
    // ticks 250 ms apart, then nothing: the window is 4 x 250 = 1 s (not the 400 ms floor), so it is ended after about 2 s of silence, not 0.8 s
    const gaps = await watch(worker("step('tiles'); for (let i = 0; i < 6; i++) { tick(); await new Promise((r) => setTimeout(r, 250)); } await new Promise((r) => setTimeout(r, 60000));"));
    assert.equal(gaps.stuck?.kind, 'silent');
    assert.ok(gaps.stuck!.windowMs >= 900 && gaps.stuck!.windowMs <= 1400, String(gaps.stuck!.windowMs));
    assert.ok(gaps.stuck!.maxGapMs >= 200 && gaps.stuck!.maxGapMs <= 450, String(gaps.stuck!.maxGapMs));
    assert.ok(gaps.stuck!.silentMs >= 1800, String(gaps.stuck!.silentMs));
  } finally { restore(); }
});

test('worker class: SPINNING with no tick is ended (the processor time is not life), with the step named', async () => {
  const restore = env(SHORT);
  try {
    const spinning = await watch(worker(`step('meshing products'); tick(); ${spin(20_000)}`));
    assert.equal(spinning.stuck?.kind, 'silent');
    assert.equal(spinning.stuck?.step, 'meshing products');
    assert.ok(spinning.ms < 6000, `${spinning.ms}`);
    assert.notEqual(spinning.code, 0);
  } finally { restore(); }
});

test('worker class: an opaque call within its bound is alive, however busy; past its bound it is ended, with the bound in the words', async () => {
  const restore = env(SHORT);
  try {
    // expected 1 s: the bound is 10 s; 2.5 s of one synchronous call (WebAssembly, say) lives
    const within = await watch(worker(`opaque('reading the IFC (web-ifc OpenModel)', 1000, () => ${spin(2500)}); console.log('done');`));
    assert.deepEqual([within.code, within.stuck, within.out], [0, null, 'done']);
    // expected 50 ms: the bound is max(floor 400 ms, 500 ms) = 500 ms; the call never ends
    const past = await watch(worker(`opaque('reading the IFC (web-ifc OpenModel)', 50, () => ${spin(30_000)});`));
    assert.equal(past.stuck?.kind, 'bound');
    assert.equal(past.stuck?.step, 'reading the IFC (web-ifc OpenModel)');
    assert.equal(past.stuck?.limitMs, 500);
    assert.equal(past.stuck?.expectMs, 50);
    assert.ok(past.ms < 7000);
    assert.match(stuckMessage(past.stuck!, { what: 'The geometry worker', tried: 'one pass', next: 'split it' }), /ran past its work bound of 500 ms \(about 50 ms expected for this input at this machine's measured rate, times 10\)/);
    // the step before an opaque call continues after it: its own rule applies again (ticks, then silence: ended as silent)
    const after = await watch(worker(`step('meshing products'); tick(); opaque('inflating', 1000, () => ${spin(600)}); await new Promise((r) => setTimeout(r, 60000));`));
    assert.equal(after.stuck?.kind, 'silent');
    assert.equal(after.stuck?.step, 'meshing products');
  } finally { restore(); }
});

test('worker class: an unpack that cannot tick but grows its memory (the Revit reader) is alive while it grows and ended when it stops', async () => {
  const restore = env(SHORT);
  try {
    const grows = await watch(worker("step('unpacking the Revit file', { mem: true, expect: 300 }); const keep = []; for (let i = 0; i < 12; i++) { keep.push(Buffer.alloc(4 << 20, i + 1)); await new Promise((r) => setTimeout(r, 200)); } console.log('done ' + keep.length);"));
    assert.deepEqual([grows.code, grows.stuck, grows.out], [0, null, 'done 12']);
    const flat = await watch(worker("step('unpacking the Revit file', { mem: true, expect: 300 }); await new Promise((r) => setTimeout(r, 60000));"));
    assert.equal(flat.stuck?.kind, 'bound');
    assert.equal(flat.stuck?.step, 'unpacking the Revit file');
  } finally { restore(); }
});

test('a worker that runs another worker passes its steps and ticks on: a long tiler under the reader is not mistaken for an idle reader', { timeout: 60_000 }, async () => {
  const restore = env(SHORT);
  try {
    const { dirname } = await import('node:path');
    const child = worker("step('writing the display tiles (placed meshes)'); for (let i = 0; i < 15; i++) { tick(); await new Promise((r) => setTimeout(r, 200)); }");
    // the child's script is shipped as a file; the reader runs it with runNode (parse.ts), as absorbRun runs the tiler
    const reader = (body: string) => worker(`import(${JSON.stringify(PARSE)}).then(async ({ runNode }) => { step('making the display tiles'); ${body} });`);
    const alone = await watch(reader(`const r = await runNode(${JSON.stringify(child)}, [], () => true, 'The display tiler'); console.log(r.ok ? 'tiled' : r.note); process.exit(r.ok ? 0 : 3);`));
    assert.deepEqual([alone.code, alone.stuck, alone.out], [0, null, 'tiled']);
    assert.ok(alone.ms >= 2800);
    // the control: the same wait with nothing passed on is an idle reader
    const idle = await watch(reader('await new Promise((r) => setTimeout(r, 3500)); process.exit(0);'));
    assert.equal(idle.stuck?.kind, 'silent');
    assert.equal(idle.stuck?.step, 'making the display tiles');
    void dirname;
  } finally { restore(); }
});

// ---- the programs we drive: ticks seen from here (unitWatch), a program that reports nothing (externalWatch) ---------------
test('unitWatch classes: a slow frame loop lives; the first frame is bounded by 10 x its estimate, then the measured gaps rule', async () => {
  const stuck: StuckInfo[] = [];
  const w = unitWatch({ floorMs: 200, onStuck: (i) => stuck.push(i), pollMs: 20 });
  w.step('drawing frames', { expectMs: 100 }); // bound max(200, 1000) = 1 s
  w.beat(0, 10);
  await sleep(600); // the first frame takes 0.6 s: inside the bound (a 200 ms floor alone would have ended it)
  assert.equal(stuck.length, 0);
  w.beat(1, 10); // measured: 600 ms; windows now 2.4 s
  assert.equal(stuck.length, 0);
  for (let i = 2; i < 6; i++) { w.beat(i, 10); await sleep(300); } // slow but ticking: any total
  assert.equal(stuck.length, 0);
  await sleep(5200);
  w.stop();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].kind, 'silent');
  assert.equal(stuck[0].step, 'drawing frames');
  assert.equal(stuck[0].done, 5);
  assert.equal(stuck[0].total, 10);
});

test('externalWatch (Microsoft Project): output written is progress; processor time does not keep it past its bound; neither means it waits on a dialog', async (t) => {
  const keep = setInterval(() => {}, 1000); // the watch's own timer does not hold the process open
  t.after(() => clearInterval(keep)); // a failing assertion must not leave the loop held open
  const run = (o: { expectMs: number; output?: () => number; cpu?: () => Promise<number | null> }) => new Promise<StuckInfo>((done) => { const stop = externalWatch({ step: 'converting', floorMs: 200, pollMs: 20, ...o, onStuck: (i) => { stop(); done(i); } }); });
  // nothing written and no processor time: idle, after two windows of max(floor / 2, bound / 4)
  const idle = await run({ expectMs: 10, output: () => 0, cpu: async () => 5000 });
  assert.equal(idle.kind, 'idle');
  assert.match(stuckMessage(idle, { what: 'Microsoft Project', next: 'open it once' }), /used no processor time and wrote nothing for .* which is what a program does when it waits on a dialog nobody can see/);
  // processor time keeps moving: no idle, but past its work bound it is ended (max(200 ms, 10 x 30 ms))
  let c = 0;
  const bound = await run({ expectMs: 30, output: () => 0, cpu: async () => (c += 500) });
  assert.equal(bound.kind, 'bound');
  assert.equal(bound.limitMs, 300);
  // output growing resets the clock, but only up to the bound (300 ms): a save whose file grows for ever is ended soon after it
  let out = 0; const t0 = Date.now();
  const grow = setInterval(() => { out += 10; }, 40);
  const ended = await run({ expectMs: 30, output: () => out, cpu: async () => 0 });
  clearInterval(grow);
  assert.ok(Date.now() - t0 >= 280 && Date.now() - t0 < 3000, `ended about one bound after the last counted write: ${Date.now() - t0}`);
  assert.ok(['bound', 'idle'].includes(ended.kind));
  clearInterval(keep);
});

// ---- ffmpeg: reports its own progress ---------------------------------------------------------------------------------
const fakeFfmpeg = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-ffmpeg-')), p = join(dir, 'ffmpeg.cjs');
  writeFileSync(p, `#!${process.execPath}\nconst fs = require('fs'); const dst = process.argv[process.argv.length - 1]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n(async () => {\n${body}\n})();`);
  chmodSync(p, 0o755);
  return p;
};
test('ffmpeg is watched by its own progress: slow but writing frames lives, silent and spinning are ended, with the step and the alternatives', { skip: WIN && 'the stand-in is a script', timeout: 60_000 }, async () => {
  const webm = Buffer.from('webm');
  const ok = await webmToMp4(webm, fakeFfmpeg("for (let i = 1; i <= 12; i++) { console.log('frame=' + i); console.log('progress=continue'); await sleep(150); } fs.writeFileSync(dst, 'mp4'); console.log('progress=end');"), { floorMs: 300, frames: 12 });
  assert.equal(String(ok), 'mp4');
  await assert.rejects(webmToMp4(webm, fakeFfmpeg("console.log('frame=1'); await sleep(60000);"), { floorMs: 300 }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /^ffmpeg was ended as stuck while converting the WebM to MP4 \(ffmpeg, frames written\) \(1 done\): no progress for .*Tried: one conversion.*Alternatives: ask for format: "webm"/s.test(e.message));
  await assert.rejects(webmToMp4(webm, fakeFfmpeg("console.log('frame=1'); const t = Date.now(); while (Date.now() - t < 60000) { /* spins, reports nothing */ }"), { floorMs: 300 }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck');
  await assert.rejects(webmToMp4(webm, fakeFfmpeg('process.exit(1);'), { floorMs: 300 }), (e: unknown) => e instanceof RenderFailed && e.code === undefined && /ffmpeg failed \(code 1\)/.test(e.message));
});

// ---- the desktop app's page: the same watch (main/bim.ts) -------------------------------------------------------------------
test('inPage (the desktop app’s video render): tiles and frames are the ticks; a silent page is ended with the step; a page whose process is gone ends the render at once', async () => {
  const page = (state: (n: number) => unknown, onGone?: { fire?: () => void }) => {
    let handler: ((why: string) => void) | null = null, n = 0;
    if (onGone) onGone.fire = () => handler?.('oom');
    return { evaluate: async (e: string) => { if (e.includes('status()')) return state(n++); if (e.includes('progress()')) return { done: 3, total: 10 }; await sleep(30); return null; }, onGone: (h: (why: string) => void) => { handler = h; } };
  };
  // tiles arrive slowly (every 150 ms, 6 tiles = 900 ms: more than two windows of 300 ms... it is ticking), then ready, then the work
  const ready = await inPage(page((n) => (n >= 12 ? { state: 'ready', tiles: { loaded: 6, total: 6 } } : { state: 'loading', tiles: { loaded: Math.floor(n / 2), total: 6 } })), async (ev, alive) => { alive.beat(0, 3); return 'drawn'; }, { floorMs: 300 });
  assert.equal(ready, 'drawn');
  // tiles stop at 2 of 6
  await assert.rejects(inPage(page(() => ({ state: 'loading', tiles: { loaded: 2, total: 6 } })), async () => 'x', { floorMs: 300, what: 'the 4D video' }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /^The render of the 4D video was ended as stuck while loading the model.s tiles into the page \(2 of 6\)|^The render of the 4D video was ended as stuck while loading the model.s tiles into the page: /.test(e.message) && /Tried: this computer.s graphics card/.test(e.message) && /Alternatives: render the video on the server with render_4d/.test(e.message));
  // the work (the encode) never ticks
  await assert.rejects(inPage(page(() => ({ state: 'ready', tiles: { loaded: 1, total: 1 } })), async () => { await sleep(4000); }, { floorMs: 300 }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /drawing frames in the page/.test(e.message));
  // the page's process is gone
  const gone: { fire?: () => void } = {};
  const p = inPage(page(() => ({ state: 'ready', tiles: { loaded: 1, total: 1 } }), gone), async () => { await sleep(4000); }, { floorMs: 300 });
  setTimeout(() => gone.fire?.(), 100);
  await assert.rejects(p, (e: unknown) => e instanceof RenderFailed && e.code === 'browser_out_of_memory' && /process ended \(oom\)/.test(e.message));
  // the encode with frames reported: ticks, then done
  const frames: number[] = [];
  const ev = async (e: string) => { if (e.includes('progress()')) return { done: Math.min(10, frames.length + 1), total: 10 }; return null; };
  const v = await whileEncoding(sleep(1200).then(() => 'video'), ev as never, async (d) => { frames.push(d); }, { beat: () => {}, step: () => {} });
  assert.equal(v, 'video');
  assert.ok(frames.length >= 1);
});

// ---- nit (b): what is drawn -------------------------------------------------------------------------------------------------
test('render_4d plan: boxes at a standard size says it draws boxes (drawn, and a note every time), full geometry says full', () => {
  const base = { kind: 'gpu' as const, triangles: 1e6, tileBytes: 50e6, elements: 5000, frames: 24 };
  const boxes = planRender({ ...base, asked: 'auto', boxes: true });
  assert.equal(boxes.quality, 'standard');
  assert.deepEqual(boxes.drawn, { geometry: 'boxes', width: 1280, height: 720 });
  assert.match(boxes.note!, /^Boxes, as asked: each element is drawn as its bounding box at 1280x720, not the model's full geometry/);
  const full = planRender({ ...base, asked: 'auto' });
  assert.deepEqual(full.drawn, { geometry: 'full', width: 1280, height: 720 });
  assert.equal(full.note, undefined);
  const draft = planRender({ ...base, asked: 'draft' });
  assert.deepEqual(draft.drawn, { geometry: 'boxes', width: 854, height: 480 });
  assert.match(draft.note!, /Draft quality, as asked: 854x480, each element drawn as a simple box/);
  assert.deepEqual(planRender({ ...base, asked: 'high' }).drawn, { geometry: 'full', width: 1920, height: 1080 });
});
