// Stuck jobs, the platform's rule (owner decision 2026-11-08; liveness.ts): no fixed time limit, no gap multiple, no bound. Each window
// a watch asks: progress? alive. Else processor time (10 ms or more)? alive — a job that works is NEVER ended, a spinning loop included,
// and its job line says it works without progress. Neither, two windows in a row: frozen (a program waiting on a dialog, a dead lock);
// no processor reading at all: three windows. Stand-in workers, a stand-in ffmpeg and a stand-in page stand for the real ones:
//   slow but ticking: never ended | sleeping (no progress, no processor): ended | spinning with no tick: NOT ended, said on the job line
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expectedMs, machineFactor, noteRate, rateEnv } from '../core/bim/heartbeat.mjs';
import { watchReport, busyWords, externalWatch, heartbeatEnv, heartbeatWatcher, stuckMessage, unitWatch, verdict, BUSY_CPU_MS, IDLE_FROZEN_WINDOWS, UNREAD_FROZEN_WINDOWS, type Silence, type StuckInfo } from '../core/bim/liveness.ts';
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
const WINDOW = 300;
const SHORT = { P6CLONE_HEARTBEAT_MS: '100', P6CLONE_LIVENESS_WINDOW_MS: String(WINDOW), P6CLONE_MACHINE_FACTOR: '1' };

/** A worker script: heartbeat.mjs's API is in scope (startHeartbeat already called). */
const worker = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stuck-')), p = join(dir, 'w.mjs');
  writeFileSync(p, `import { alive, opaque, opaqueAsync, progress, startHeartbeat, step, tick } from ${JSON.stringify(HB)};\nstartHeartbeat();\n${body}`);
  return p;
};
const spin = (ms: number) => `{ const t = Date.now(); while (Date.now() - t < ${ms}) { /* the processor works, nothing is reported */ } }`;
const watch = (script: string, lines?: (string | null)[], silences?: Silence[]) => new Promise<{ code: number | null; stuck: StuckInfo | null; out: string; ms: number }>((done) => {
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...heartbeatEnv() } });
  let stuck: StuckInfo | null = null, out = '';
  const t0 = Date.now();
  const make = () => heartbeatWatcher(child, { onText: (t) => { out += t; }, onStuck: (i) => { stuck = i; child.kill(); } });
  const stop = lines || silences ? watchReport.run({ line: (l) => { lines?.push(l); }, silence: (x) => { silences?.push(x); } }, make) : make();
  child.on('close', (code) => { stop(); done({ code, stuck, out: out.trim(), ms: Date.now() - t0 }); });
});

// ---- the rule itself (the platform's livenessVerdict) -------------------------------------------------------------------
test('verdict: progress or processor time is alive; the second idle window is frozen; with no reading, the third', () => {
  const c = { idle: 0, unread: 0 };
  assert.equal(verdict(c, false, 0), 'checking');
  assert.equal(verdict(c, false, BUSY_CPU_MS), 'alive', 'processor time resets the count');
  assert.equal(verdict(c, false, 2), 'checking');
  assert.equal(verdict(c, false, 2), 'idle', `idle on window ${IDLE_FROZEN_WINDOWS}`);
  const d = { idle: 0, unread: 0 };
  for (let i = 1; i < UNREAD_FROZEN_WINDOWS; i++) assert.equal(verdict(d, false, null), 'checking');
  assert.equal(verdict(d, false, null), 'silent');
  const e = { idle: 1, unread: 2 };
  assert.equal(verdict(e, true, null), 'alive', 'progress resets both counts');
  assert.deepEqual(e, { idle: 0, unread: 0 });
  // a job that uses the processor for ever is never frozen
  const f = { idle: 0, unread: 0 };
  for (let i = 0; i < 1000; i++) assert.equal(verdict(f, false, 500), 'alive');
});

test('the words for an ended job: the step, how long, the windows, what was tried, the alternatives; the busy line has the time', () => {
  const i: StuckInfo = { kind: 'idle', step: 'reading the IFC (web-ifc OpenModel)', done: 3, total: 9, silentMs: 12_000, windows: 2, windowMs: 5000, cpuMs: 0, expectMs: 60_000 };
  assert.equal(stuckMessage(i, { what: 'The geometry worker', tried: 'one pass', next: 'split it' }),
    'The geometry worker was ended as frozen while reading the IFC (web-ifc OpenModel) (3 of 9): no progress for 12 s and no processor time (0 ms) in 2 windows of 5 s in a row (about 60 s was expected for this input on this machine) — it was frozen, or waiting on something nobody can answer (a dialog nobody can see). It is never ended while it works (uses the processor). Tried: one pass. Alternatives: split it.');
  assert.match(stuckMessage({ ...i, kind: 'silent', cpuMs: null, windows: 3 }, { what: 'W', next: 'n' }), /in 3 windows of 5 s in a row, and its processor time could not be read here/);
  const at = new Date(2026, 10, 8, 10, 42).getTime();
  assert.equal(busyWords(at, at + 12 * 60_000), 'using CPU, no progress since 10:42 (12 minutes) — cancel it if that is not expected');
});

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
    // 3 s: ten windows, one tick every 200 ms and almost no processor time
    const slow = await watch(worker("step('meshing products'); let n = 0; await new Promise((r) => { const t = setInterval(() => { n++; if (n % 3 === 0) tick(); else if (n % 3 === 1) progress(n); else alive(); if (n >= 15) { clearInterval(t); r(); } }, 200); }); console.log('done');"));
    assert.deepEqual([slow.code, slow.stuck, slow.out], [0, null, 'done']);
    assert.ok(slow.ms >= 2800);
  } finally { restore(); }
});

test('worker class: no progress and no processor time (waiting on nothing) is ended as frozen, with the step named', async () => {
  const restore = env(SHORT);
  try {
    const sleeping = await watch(worker("step('cutting the model into chunks'); await new Promise((r) => setTimeout(r, 60000));"));
    assert.equal(sleeping.stuck?.kind, 'idle');
    assert.equal(sleeping.stuck?.step, 'cutting the model into chunks');
    assert.equal(sleeping.stuck?.windows, 2);
    assert.ok(sleeping.ms < 8000, String(sleeping.ms));
    assert.notEqual(sleeping.code, 0);
    // an opaque call that waits (no processor) is the same; its estimate is only in the words
    const waits = await watch(worker("await opaqueAsync('reading the IFC (web-ifc OpenModel)', 60000, () => new Promise((r) => setTimeout(r, 60000)));"));
    assert.equal(waits.stuck?.kind, 'idle');
    assert.equal(waits.stuck?.step, 'reading the IFC (web-ifc OpenModel)');
    assert.equal(waits.stuck?.expectMs, 60000);
  } finally { restore(); }
});

test('worker class: SPINNING with no tick is NOT ended (it uses the processor), and its job line says so each window', async () => {
  const restore = env(SHORT);
  try {
    const lines: (string | null)[] = [];
    const spinning = await watch(worker(`step('meshing products'); tick(); ${spin(2500)} console.log('done');`), lines);
    assert.deepEqual([spinning.code, spinning.stuck, spinning.out], [0, null, 'done'], 'eight windows with no progress, the processor busy: alive');
    assert.ok(lines.filter((l) => l && /^using CPU, no progress since \d\d:\d\d \(.+\) — cancel it if that is not expected$/.test(l)).length >= 3, JSON.stringify(lines));
    // an opaque call that works for longer than its estimate is alive too: the estimate is never a limit
    const opaqueLong = await watch(worker(`opaque('reading the IFC (web-ifc OpenModel)', 50, () => ${spin(1500)}); console.log('done');`));
    assert.deepEqual([opaqueLong.code, opaqueLong.stuck, opaqueLong.out], [0, null, 'done']);
    // the step before an opaque call continues after it: progress, then nothing at all → frozen in that step
    const after = await watch(worker(`step('meshing products'); tick(); opaque('inflating', 1000, () => ${spin(600)}); await new Promise((r) => setTimeout(r, 60000));`));
    assert.equal(after.stuck?.kind, 'idle');
    assert.equal(after.stuck?.step, 'meshing products');
  } finally { restore(); }
});

test('the busy line is taken back once progress returns', async () => {
  const restore = env(SHORT);
  try {
    const lines: (string | null)[] = [];
    const r = await watch(worker(`step('meshing products'); tick(); ${spin(1200)} for (let i = 0; i < 8; i++) { tick(); await new Promise((r) => setTimeout(r, 100)); } console.log('done');`), lines);
    assert.deepEqual([r.code, r.stuck], [0, null]);
    const first = lines.findIndex((l) => typeof l === 'string');
    assert.ok(first >= 0, JSON.stringify(lines));
    assert.ok(lines.slice(first).includes(null), `taken back: ${JSON.stringify(lines)}`);
  } finally { restore(); }
});

test('a worker that runs another worker passes its steps and ticks on: a long tiler under the reader is not mistaken for an idle reader', { timeout: 60_000 }, async () => {
  const restore = env(SHORT);
  try {
    const child = worker("step('writing the display tiles (placed meshes)'); for (let i = 0; i < 15; i++) { tick(); await new Promise((r) => setTimeout(r, 200)); }");
    // the child's script is shipped as a file; the reader runs it with runNode (parse.ts), as absorbRun runs the tiler
    const reader = (body: string) => worker(`import(${JSON.stringify(PARSE)}).then(async ({ runNode }) => { step('making the display tiles'); ${body} });`);
    const alone = await watch(reader(`const r = await runNode(${JSON.stringify(child)}, [], () => true, 'The display tiler'); console.log(r.ok ? 'tiled' : r.note); process.exit(r.ok ? 0 : 3);`));
    assert.deepEqual([alone.code, alone.stuck, alone.out], [0, null, 'tiled']);
    assert.ok(alone.ms >= 2800);
    // the control: the same wait with nothing passed on, and nothing working, is a frozen reader
    const idle = await watch(reader('await new Promise((r) => setTimeout(r, 4000)); process.exit(0);'));
    assert.equal(idle.stuck?.kind, 'idle');
    assert.equal(idle.stuck?.step, 'making the display tiles');
  } finally { restore(); }
});

// ---- the programs we drive: ticks seen from here (unitWatch), a program that reports nothing (externalWatch) ---------------
test('unitWatch: a slow frame loop lives; processor time keeps it alive with no frame; neither is frozen; no reading at all, the third window', async () => {
  const stuck: StuckInfo[] = [];
  let cpu = 0;
  const w = unitWatch({ onStuck: (i) => stuck.push(i), cpu: async () => cpu, windowMs: 100 });
  w.step('drawing frames', { expectMs: 50 });
  for (let i = 0; i < 6; i++) { w.beat(i, 10); await sleep(80); } // slow but ticking
  assert.equal(stuck.length, 0);
  const busy = setInterval(() => { cpu += 30; }, 20); // the browser works on one frame for a long time: no frame, the processor busy
  await sleep(700);
  clearInterval(busy);
  assert.equal(stuck.length, 0, 'never ended while it works');
  await sleep(500); // then nothing at all
  w.stop();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].kind, 'idle');
  assert.equal(stuck[0].step, 'drawing frames');
  assert.equal(stuck[0].done, 5);
  assert.equal(stuck[0].total, 10);
  // no reading to be had: three windows with no frame
  const quiet: StuckInfo[] = [];
  const q = unitWatch({ onStuck: (i) => quiet.push(i), step: 'loading tiles', windowMs: 100 });
  await sleep(250);
  assert.equal(quiet.length, 0, 'not after two windows');
  await sleep(300);
  q.stop();
  assert.equal(quiet[0]?.kind, 'silent');
  assert.equal(quiet[0]?.cpuMs, null);
});

test('externalWatch (Microsoft Project): output written is progress; processor time is life; neither means it waits on a dialog', async (t) => {
  const keep = setInterval(() => {}, 1000); // the watch's own timer does not hold the process open
  t.after(() => clearInterval(keep));
  const run = (o: { output?: () => number; cpu?: () => Promise<number | null>; until?: number }) => new Promise<StuckInfo | null>((done) => {
    const stop = externalWatch({ step: 'converting', expectMs: 10, windowMs: 100, ...o, onStuck: (i) => { stop(); done(i); } });
    if (o.until) setTimeout(() => { stop(); done(null); }, o.until);
  });
  // nothing written and no processor time: idle, after two windows
  const idle = await run({ output: () => 0, cpu: async () => 5000 });
  assert.equal(idle?.kind, 'idle');
  assert.match(stuckMessage(idle!, { what: 'Microsoft Project', next: 'open it once' }), /no processor time .* waiting on something nobody can answer \(a dialog nobody can see\)/);
  // processor time keeps moving: never ended (no bound), however long
  let c = 0;
  assert.equal(await run({ output: () => 0, cpu: async () => (c += 500), until: 1200 }), null);
  // output growing is progress, with no processor time
  let out = 0;
  const grow = setInterval(() => { out += 10; }, 40);
  assert.equal(await run({ output: () => out, cpu: async () => 0, until: 1200 }), null);
  clearInterval(grow);
  clearInterval(keep);
});

// ---- ffmpeg: reports its own progress ---------------------------------------------------------------------------------
const fakeFfmpeg = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-ffmpeg-')), p = join(dir, 'ffmpeg.cjs');
  writeFileSync(p, `#!${process.execPath}\nconst fs = require('fs'); const dst = process.argv[process.argv.length - 1]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n(async () => {\n${body}\n})();`);
  chmodSync(p, 0o755);
  return p;
};
test('ffmpeg is watched by its own progress and its processor time: slow but writing frames lives, spinning lives, waiting on nothing is ended', { skip: WIN && 'the stand-in is a script', timeout: 60_000 }, async () => {
  const restore = env({ P6CLONE_LIVENESS_WINDOW_MS: String(WINDOW) });
  try {
    const webm = Buffer.from('webm');
    const ok = await webmToMp4(webm, fakeFfmpeg("for (let i = 1; i <= 12; i++) { console.log('frame=' + i); console.log('progress=continue'); await sleep(150); } fs.writeFileSync(dst, 'mp4'); console.log('progress=end');"), { frames: 12 });
    assert.equal(String(ok), 'mp4');
    const spun = await webmToMp4(webm, fakeFfmpeg("console.log('frame=1'); const t = Date.now(); while (Date.now() - t < 2000) { /* works, reports nothing */ } fs.writeFileSync(dst, 'mp4');"));
    assert.equal(String(spun), 'mp4', 'a conversion that works without reporting is not ended');
    await assert.rejects(webmToMp4(webm, fakeFfmpeg("console.log('frame=1'); await sleep(60000);")), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /^ffmpeg was ended as frozen while converting the WebM to MP4 \(ffmpeg, frames written\) \(1 done\): no progress for .*Tried: one conversion.*Alternatives: ask for format: "webm"/s.test(e.message));
    await assert.rejects(webmToMp4(webm, fakeFfmpeg('process.exit(1);')), (e: unknown) => e instanceof RenderFailed && e.code === undefined && /ffmpeg failed \(code 1\)/.test(e.message));
  } finally { restore(); }
});

// ---- the desktop app's page: the same watch (main/bim.ts) -------------------------------------------------------------------
test('inPage (the desktop app’s video render): tiles and frames are the ticks; a page that neither moves nor works is ended with the step; a page whose process is gone ends the render at once', async () => {
  const restore = env({ P6CLONE_LIVENESS_WINDOW_MS: String(WINDOW) });
  try {
    const page = (state: (n: number) => unknown, onGone?: { fire?: () => void }) => {
      let handler: ((why: string) => void) | null = null, n = 0;
      if (onGone) onGone.fire = () => handler?.('oom');
      return { evaluate: async (e: string) => { if (e.includes('status()')) return state(n++); if (e.includes('progress()')) return { done: 3, total: 10 }; await sleep(30); return null; }, onGone: (h: (why: string) => void) => { handler = h; } };
    };
    const still = async () => 0; // the app's processor time, held still (the test process itself is not the app)
    const ready = await inPage(page((n) => (n >= 12 ? { state: 'ready', tiles: { loaded: 6, total: 6 } } : { state: 'loading', tiles: { loaded: Math.floor(n / 2), total: 6 } })), async (ev, alive) => { alive.beat(0, 3); return 'drawn'; }, { cpu: still });
    assert.equal(ready, 'drawn');
    // tiles stop at 2 of 6, nothing works
    await assert.rejects(inPage(page(() => ({ state: 'loading', tiles: { loaded: 2, total: 6 } })), async () => 'x', { what: 'the 4D video', cpu: still }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /^The render of the 4D video was ended as frozen while loading the model.s tiles into the page \(2 of 6\)/.test(e.message) && /Tried: this computer.s graphics card/.test(e.message) && /Alternatives: render the video on the server with render_4d/.test(e.message));
    // the work (the encode) never ticks and nothing works
    await assert.rejects(inPage(page(() => ({ state: 'ready', tiles: { loaded: 1, total: 1 } })), async () => { await sleep(4000); }, { cpu: still }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /drawing frames in the page/.test(e.message));
    // the same encode with the app working is alive
    let c = 0;
    assert.equal(await inPage(page(() => ({ state: 'ready', tiles: { loaded: 1, total: 1 } })), async () => { await sleep(1500); return 'encoded'; }, { cpu: async () => (c += 100) }), 'encoded');
    // the page's process is gone
    const gone: { fire?: () => void } = {};
    const p = inPage(page(() => ({ state: 'ready', tiles: { loaded: 1, total: 1 } }), gone), async () => { await sleep(4000); }, { cpu: still });
    setTimeout(() => gone.fire?.(), 100);
    await assert.rejects(p, (e: unknown) => e instanceof RenderFailed && e.code === 'browser_out_of_memory' && /process ended \(oom\)/.test(e.message));
    // the encode with frames reported: ticks, then done
    const frames: number[] = [];
    const ev = async (e: string) => { if (e.includes('progress()')) return { done: Math.min(10, frames.length + 1), total: 10 }; return null; };
    const v = await whileEncoding(sleep(1200).then(() => 'video'), ev as never, async (d) => { frames.push(d); }, { beat: () => {}, step: () => {} });
    assert.equal(v, 'video');
    assert.ok(frames.length >= 1);
  } finally { restore(); }
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
