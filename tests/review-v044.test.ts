// The review of whiq-v0.1.44: where a render is estimated and drawn, the fall back from the graphics card, no time
// limits (liveness), the Revit reader's failures and cache, and what model_too_large tells the agent to do first.
// A stand-in Chromium (a script that speaks the DevTools pipe) and a stand-in Revit worker stand for the real ones,
// so none of this needs a browser, a graphics card or a Revit sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AUTO_DRAFT_MINUTES, planRender, renderMinutes, RENDER_SOFTWARE_TRIANGLES_PER_S } from '../core/bim/renderplan.ts';
import { inChromium, isGpuFailure, probeRenderer, RenderFailed, resetRendererMemory } from '../core/bim/headless.ts';
import { heartbeatEnv, heartbeatWatcher, parsePsCpu, parseWindowsCpu, sumTree, treeCpuMs, watchLiveness } from '../core/bim/liveness.ts';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { SAMPLES_DIR, sampleCopy, samples } from './helpers.ts';
import { nwdToIfc } from '../core/bim/nwd.ts';
import { REVIT_MEMORY_PER_BYTE, revitMaxBytes, revitNeed, RevitDiskFull, RevitTooLarge, rvtToIfc, sweepStaleTemps } from '../core/bim/rvt.ts';

const ROOT = join(import.meta.dirname, '..');
const FX = join(ROOT, 'tests', 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  let d = toolResult(r.out, r.isError).structuredContent as any, err = r.isError;
  while (!err && d?.job_id && d.status === 'running' && !args.async && !/^(job_status|cancel_job)$/.test(name)) {
    const j = toolResult((await callTool('job_status', { job_id: d.job_id, wait_seconds: 20 })).out, false).structuredContent as any;
    if (j.status === 'running') continue;
    if (j.status === 'done') d = j.result; else { err = true; d = j; }
  }
  return { err, d };
};
const env = (vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(was)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
};

// ---- the estimate and the quality (renderplan.ts) -----------------------------------------------------------------

// a 20 M triangle federation, 60+ weekly frames: the full model takes long in software, seconds on a graphics card
const BIG = { triangles: 20e6, tileBytes: 600 * 1048576, elements: 20_000, frames: 70 };

test('no server Chromium: the client render is drawn on the user’s graphics card, so it is estimated as one and auto does not send it a box draft', () => {
  const software = planRender({ ...BIG, kind: 'software', asked: 'auto' });
  assert.equal(software.quality, 'draft', 'drawn by this server’s processor that model is long enough for a draft');
  const client = planRender({ ...BIG, kind: 'gpu', client: true, asked: 'auto' });
  assert.equal(client.quality, 'standard');
  assert.equal(client.boxes, false);
  assert.ok(client.minutes < software.fullMinutes / 20, `${client.minutes} against ${software.fullMinutes}`);
  assert.equal(client.note, undefined);
  // a draft chosen there says whose graphics card the estimate is for, never "the processor"
  const huge = planRender({ triangles: 20e9, tileBytes: 30e9, elements: 4e6, frames: 3000, kind: 'gpu', client: true, asked: 'auto' });
  assert.equal(huge.quality, 'draft');
  assert.match(huge.note!, /on the user’s own graphics card \(the client render/);
  assert.doesNotMatch(huge.note!, /drawn by the processor/);
  assert.match(software.note!, /drawn by the processor \(this server has no graphics card the browser can use\)/);
});

test('auto picks a draft past 5 minutes (owner decision 2026-10-27), says so, and quality or the environment overrides it', () => {
  assert.equal(AUTO_DRAFT_MINUTES, 5);
  // a software render between 5 and 10 minutes: a draft now, standard before
  const mid = { triangles: 2.1e6 * 7, tileBytes: 0, elements: 1000, frames: 60 };
  const p = planRender({ ...mid, kind: 'software', asked: 'auto' });
  assert.ok(p.fullMinutes > 5 && p.fullMinutes < 10, String(p.fullMinutes));
  assert.equal(p.quality, 'draft');
  assert.match(p.note!, /^Draft quality was chosen because the full model would take about \d+ minutes to render drawn by the processor.*quality auto draws a draft past 5 minutes; owner decision 2026-10-27.*quality: "standard" gives the full detail/s);
  assert.equal(planRender({ ...mid, kind: 'software', asked: 'standard' }).quality, 'standard');
  assert.match(planRender({ ...mid, kind: 'software', asked: 'standard' }).note!, /^Full detail, as asked: expect about \d+ minutes/);
  assert.equal(planRender({ ...mid, kind: 'software', asked: 'auto', limitMinutes: 15 }).quality, 'standard');
  const restore = env({ P6CLONE_RENDER_DRAFT_MINUTES: '15' });
  try { assert.equal(planRender({ ...mid, kind: 'software', asked: 'auto' }).quality, 'standard'); } finally { restore(); }
});

test('the estimate counts boxes, side_by_side and a custom size', () => {
  const base = { ...BIG, kind: 'software' as const, asked: 'standard' as const };
  const full = planRender(base), boxes = planRender({ ...base, boxes: true }), sbs = planRender({ ...base, sides: 2 }), big = planRender({ ...base, width: 3840, height: 2160 });
  assert.equal(boxes.boxes, true);
  assert.equal(boxes.quality, 'standard');
  assert.ok(boxes.minutes < full.minutes / 5, `boxes ${boxes.minutes} full ${full.minutes}`); // 20,000 boxes, nothing to load
  assert.ok(Math.abs((sbs.minutes - full.minutes) - BIG.frames * BIG.triangles / RENDER_SOFTWARE_TRIANGLES_PER_S / 60) < 1e-9, 'the triangles drawn twice a frame; the tiles loaded once');
  assert.ok(big.minutes > full.minutes && (big.width === 3840 && big.height === 2160));
  assert.equal(planRender({ ...base, asked: 'high' }).width, 1920);
  // auto with boxes: reported as what it is (the box estimate), not as the full model's
  const auto = planRender({ ...BIG, kind: 'software', asked: 'auto', boxes: true });
  assert.equal(auto.quality, 'standard');
  assert.equal(auto.minutes, renderMinutes('software', BIG.elements * 12, BIG.frames, 0, 1280 * 720));
});

test('after the graphics card could not finish, quality and estimate are worked out again for the processor, and the note says it takes longer', () => {
  const small = { triangles: 5e6, tileBytes: 100 * 1048576, elements: 50_000, frames: 40 };
  const gpu = planRender({ ...small, kind: 'gpu', asked: 'auto' });
  assert.equal(gpu.quality, 'standard');
  const soft = planRender({ ...small, kind: 'software', asked: 'auto', fellBack: { reason: 'the WebGL context was lost', firstMinutes: gpu.minutes } });
  assert.ok(soft.minutes > gpu.minutes);
  assert.equal(soft.quality, soft.fullMinutes > AUTO_DRAFT_MINUTES ? 'draft' : 'standard');
  assert.match(soft.note!, /^The graphics card could not finish this render \(the WebGL context was lost\), so the processor drew it, which takes longer: .* instead of the .* first estimated/);
  const mid = { triangles: 2.1e6 * 7, tileBytes: 0, elements: 1000, frames: 60 };
  const gpuMid = planRender({ ...mid, kind: 'gpu', asked: 'auto' }), softMid = planRender({ ...mid, kind: 'software', asked: 'auto', fellBack: { reason: 'x', firstMinutes: gpuMid.minutes } });
  assert.equal(gpuMid.quality, 'standard');
  assert.equal(softMid.quality, 'draft', 'auto decides again for the processor');
  assert.match(softMid.note!, /took longer|takes longer/);
  assert.match(softMid.note!, /Draft quality was chosen because the full model would take .* drawn by the processor \(the graphics card could not finish the render\)/);
  // asked for explicitly, the quality stays; only the estimate and the note change
  const asked = planRender({ ...mid, kind: 'software', asked: 'standard', fellBack: { reason: 'x', firstMinutes: gpuMid.minutes } });
  assert.equal(asked.quality, 'standard');
  assert.ok(asked.minutes > gpuMid.minutes);
});

test('only the graphics card’s failures are GPU failures', () => {
  for (const c of ['webgl_context_lost', 'gpu_out_of_memory', 'gpu_process_crashed', 'webgl_unavailable']) assert.equal(isGpuFailure(new RenderFailed('x', c)), true, c);
  for (const c of ['browser_out_of_memory', 'disk_full', 'render_stuck', 'tile_missing', 'bad_tile', 'load_failed', undefined]) assert.equal(isGpuFailure(new RenderFailed('x', c)), false, String(c));
  assert.equal(isGpuFailure(new Error('x')), false);
});

// ---- liveness instead of a time limit (liveness.ts, headless.ts) ---------------------------------------------------

test('watchLiveness: progress keeps a job alive; silence for two windows is stuck; processor time counts as life', async () => {
  const stuck: number[] = [];
  let n = 0;
  const alive = watchLiveness({ floorMs: 100, progress: () => n, onStuck: (ms) => stuck.push(ms) });
  for (let i = 0; i < 8; i++) { n++; await new Promise((r) => setTimeout(r, 60)); } // a beat in every window
  assert.deepEqual(stuck, []);
  await new Promise((r) => setTimeout(r, 450));
  alive();
  assert.equal(stuck.length, 1, 'silent for two windows: stuck, once');
  assert.ok(stuck[0] >= 200);
});

// the stand-in Chromium: speaks the DevTools pipe (fd 3 in, fd 4 out); what it does comes from the environment
const FAKE = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2), E = process.env;
if (E.FAKE_LOG) fs.appendFileSync(E.FAKE_LOG, JSON.stringify({ gpu: args.includes('--enable-gpu') }) + '\\n');
if (E.FAKE_EXIT) process.exit(Number(E.FAKE_EXIT));
let buf = '';
const out = (o) => fs.writeSync(4, JSON.stringify(o) + '\\0');
fs.createReadStream(null, { fd: 3 }).on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); handle(m); } });
function handle(m) {
  const r = (result) => out({ id: m.id, result });
  if (m.method === 'Target.createTarget') return r({ targetId: 't1' });
  if (m.method === 'Target.attachToTarget') return r({ sessionId: 's1' });
  if (m.method === 'Browser.close') { r({}); return setTimeout(() => process.exit(0), 10); }
  if (m.method !== 'Runtime.evaluate') return r({});
  const e = m.params.expression, val = (value) => r({ result: { value } });
  if (e.includes('P6C4D_API.status()')) return val({ state: 'ready', tiles: { loaded: 1, total: 1 } });
  if (e.includes('WEBGL_debug_renderer_info')) return val(E.FAKE_RENDERER || 'SwiftShader');
  if (e.includes('P6C4D_API.png(')) {
    if (E.FAKE_GPU_FAIL && args.includes('--enable-gpu')) return r({ exceptionDetails: { text: 'x', exception: { description: E.FAKE_GPU_FAIL } } });
    return val('data:image/png;base64,iVBORw0KGgo=');
  }
  if (e === 'hang') return;
  if (e === 'busy') { const t = Date.now(); while (Date.now() - t < 1500) { /* the processor works */ } return val('done'); }
  val('ok');
}
`;
const fakeChromium = () => { const dir = mkdtempSync(join(tmpdir(), 'p6-fake-chrome-')), p = join(dir, 'chrome.cjs'); writeFileSync(p, FAKE); chmodSync(p, 0o755); return { dir, p, log: join(dir, 'log.jsonl') }; };
const page = (dir: string) => { const p = join(dir, 'page.html'); writeFileSync(p, '<!doctype html>'); return p; };
const runs = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { gpu: boolean }) : []);
const WIN = process.platform === 'win32';

test('a render has no time limit: it lives while frames arrive, and is stuck only after two silent windows', { skip: WIN && 'the stand-in browser is a script' }, async () => {
  const f = fakeChromium(), restore = env({ FAKE_LOG: f.log });
  try {
    // frames keep arriving for longer than two windows: not stuck, no limit on the total
    const t0 = Date.now();
    const ok = await inChromium(f.p, page(f.dir), async (ev, alive) => { for (let i = 0; i < 12; i++) { alive.beat(i); await new Promise((r) => setTimeout(r, 100)); } return ev('1'); }, { floorMs: 300 });
    assert.equal(ok, 'ok');
    assert.ok(Date.now() - t0 >= 1200);
    // nothing arrives and the browser is idle: two windows, then stuck, with the cause
    const t1 = Date.now();
    await assert.rejects(inChromium(f.p, page(f.dir), (ev) => ev('hang'), { floorMs: 300 }), (e: unknown) => e instanceof RenderFailed && e.code === 'render_stuck' && /no tile or frame, and no processor time/.test(e.message));
    assert.ok(Date.now() - t1 < 6000, 'ended soon after the second window');
  } finally { restore(); }
});

test('a browser that is working on one long frame is not stuck (Linux: its processor time is read)', { skip: (process.platform !== 'linux' && 'processor time is read from /proc') }, async () => {
  const f = fakeChromium();
  // 1.5 s of work in a single frame, windows of 300 ms: five windows pass with no frame, none of them idle
  assert.equal(await inChromium(f.p, page(f.dir), (ev) => ev('busy'), { floorMs: 300 }), 'done');
});

test('the probe: a failure that is not the graphics side’s is not remembered; a GPU failure is, for the process', { skip: WIN && 'the stand-in browser is a script' }, async () => {
  const f = fakeChromium(), restore = env({ FAKE_LOG: f.log, P6CLONE_RENDER_GPU: 'on', FAKE_EXIT: '1' });
  resetRendererMemory();
  try {
    const a = await probeRenderer(f.p), b = await probeRenderer(f.p);
    assert.equal(a.kind, 'software');
    assert.match(a.name, /the probe failed/);
    assert.equal(runs(f.log).length, 2, 'asked again: the failure said nothing about the card');
    delete process.env.FAKE_EXIT;
    process.env.FAKE_RENDERER = 'NVIDIA GeForce RTX 4090';
    assert.equal((await probeRenderer(f.p)).kind, 'gpu');
    assert.equal(runs(f.log).length, 3);
    assert.equal((await probeRenderer(f.p)).kind, 'gpu');
    assert.equal(runs(f.log).length, 3, 'a good verdict is kept');
    assert.ok(b);
  } finally { restore(); delete process.env.FAKE_RENDERER; resetRendererMemory(); }
});

// ---- render_4d end to end with the stand-in browser -----------------------------------------------------------------

async function duplex() {
  const np = (await call('new_project', { id: 'D4', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const acts = [['L1W', 'Level 1 walls', 'Level 1', 'IfcWall', 10], ['L2S', 'Level 2 slab', 'Level 2', 'IfcSlab', 6], ['L2W', 'Level 2 walls', 'Level 2', 'IfcWall', 10], ['ROOF', 'Roof', 'Roof', '', 8]] as const;
  const ops: unknown[] = acts.map(([id, name, , , d]) => ({ op: 'add_activity', id, name, duration_days: d }));
  for (let i = 1; i < acts.length; i++) ops.push({ op: 'add_relationship', pred: acts[i - 1][0], succ: acts[i][0] });
  await call('edit', { handle: h, owner_key, operations: ops });
  await call('schedule', { handle: h, owner_key });
  await call('open_model', { handle: h, owner_key, path: join(FX, 'Duplex_A_20110907.ifc') });
  await call('link_by_rules', { handle: h, owner_key, rules: acts.map(([id, , storey, cls]) => ({ type: 'scope', activity: id, storey, ...(cls ? { class: cls } : {}) })) });
  return { h, owner_key };
}

test('render_4d: the graphics card’s failure goes again in software with quality and estimate worked out again; any other failure is reported with its cause; a failed card is not tried again', { skip: WIN && 'the stand-in browser is a script', timeout: 300_000 }, async () => {
  const f = fakeChromium(), out = mkdtempSync(join(tmpdir(), 'p6-v044-'));
  const restore = env({ P6CLONE_CHROMIUM: f.p, FAKE_LOG: f.log, P6CLONE_RENDER_GPU: 'on', FAKE_RENDERER: 'NVIDIA GeForce RTX 4090', FAKE_GPU_FAIL: undefined, P6CLONE_RENDER_DRAFT_MINUTES: undefined });
  resetRendererMemory();
  try {
    const { h } = await duplex();
    const images = (name: string, extra: Record<string, unknown> = {}) => call('render_4d', { handle: h, path: join(out, name), kind: 'images', step: 1, ...extra });
    // 1. the card draws: standard, estimated as a card
    const first = await images('first');
    assert.equal(first.err, false, JSON.stringify(first.d).slice(0, 400));
    assert.equal(first.d.renderer.kind, 'gpu');
    assert.equal(first.d.quality, 'standard');
    const frames = first.d.written.length, tris = first.d.display.triangles, bytes = first.d.display.mb * 1048576;
    assert.ok(frames > 20, String(frames));
    assert.deepEqual(runs(f.log).map((r) => r.gpu), [true, true], 'the probe, then the render');
    // a limit the card's estimate is under and the processor's is over
    const gpuMin = renderMinutes('gpu', tris, frames, bytes), softMin = renderMinutes('software', tris, frames, bytes);
    assert.ok(softMin > gpuMin * 2);
    process.env.P6CLONE_RENDER_DRAFT_MINUTES = String(gpuMin * 1.5);
    assert.equal((await images('second')).d.quality, 'standard');

    // 2. the card loses its WebGL context: the processor draws it, once, and the answer is worked out again for it
    process.env.FAKE_GPU_FAIL = 'Error: [webgl_context_lost] the WebGL context was lost';
    const before = runs(f.log).length;
    const fell = await images('fell');
    assert.equal(fell.err, false, JSON.stringify(fell.d).slice(0, 400));
    assert.deepEqual(runs(f.log).slice(before).map((r) => r.gpu), [true, false], 'the card first, then the processor');
    assert.equal(fell.d.renderer.kind, 'software');
    assert.match(fell.d.renderer.name, /after the graphics card could not finish: the WebGL context was lost/);
    assert.equal(fell.d.quality, 'draft', 'auto decided again: the full model is too long for the processor');
    assert.equal(fell.d.display.boxes, true);
    assert.match(fell.d.quality_note, /^The graphics card could not finish this render \(the WebGL context was lost\), so the processor drew it, which takes longer: .*instead of the .*first estimated.*Draft quality was chosen because the full model would take .*drawn by the processor/s);
    assert.ok(fell.d.written.length === frames);
    // an explicit standard stays standard; the estimate is the processor's
    const kept = await images('kept', { quality: 'standard' });
    // (the card is remembered as failed: this one starts in software)
    assert.equal(kept.d.quality, 'standard');
    assert.equal(kept.d.renderer.kind, 'software');
    assert.match(kept.d.renderer.name, /failed earlier/);

    // 3. the next render does not repeat the failed attempt
    const n = runs(f.log).length;
    delete process.env.FAKE_GPU_FAIL;
    const after = await images('after');
    assert.equal(after.d.renderer.kind, 'software');
    assert.ok(runs(f.log).slice(n).every((r) => !r.gpu), 'no render asked the card again');

    // 4. the machine runs out of memory: not the card's failure, no retry in software, the cause and the next step
    resetRendererMemory();
    delete process.env.P6CLONE_RENDER_DRAFT_MINUTES;
    process.env.FAKE_GPU_FAIL = 'Error: [browser_out_of_memory] the page ran out of memory';
    const m = runs(f.log).length;
    const oom = await images('oom', { quality: 'standard' });
    assert.equal(oom.err, true);
    assert.equal(oom.d.error.code, 'render_failed');
    assert.match(oom.d.error.message, /the page ran out of memory/);
    assert.doesNotMatch(oom.d.error.message, /processor/);
    assert.match(oom.d.error.next_step, /Try a smaller quality first \(quality: "draft"/);
    assert.match(oom.d.error.next_step, /browser_out_of_memory/);
    assert.deepEqual(runs(f.log).slice(m).map((r) => r.gpu), [true, true], 'the probe and one render on the card; no retry in software');
    // and the card is still tried by the next render: an out-of-memory machine is no verdict on it
    delete process.env.FAKE_GPU_FAIL;
    assert.equal((await images('again', { quality: 'standard' })).d.renderer.kind, 'gpu');
  } finally { restore(); resetRendererMemory(); }
});

test('render_4d with no Chromium: the client render is estimated as a graphics card and its page is for it', { timeout: 120_000 }, async () => {
  const restore = env({ P6CLONE_CHROMIUM: undefined, P6CLONE_RENDER_DRAFT_MINUTES: undefined });
  try {
    const { h } = await duplex();
    const r = await call('render_4d', { handle: h, path: join(mkdtempSync(join(tmpdir(), 'p6-v044c-')), 'x'), kind: 'video', step: 7 });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.rendered, false);
    assert.equal(r.d.quality, 'standard');
    assert.equal(r.d.renderer, undefined);
    // a limit the (tiny) estimate is over: the draft's note names the user's graphics card, not the processor
    process.env.P6CLONE_RENDER_DRAFT_MINUTES = '0.000001';
    const d = await call('render_4d', { handle: h, path: join(mkdtempSync(join(tmpdir(), 'p6-v044c-')), 'x'), kind: 'video', step: 7 });
    assert.equal(d.d.quality, 'draft');
    assert.match(d.d.quality_note, /on the user’s own graphics card/);
    assert.doesNotMatch(d.d.quality_note, /drawn by the processor/);
    assert.deepEqual([d.d.client_render.width, d.d.client_render.height], [854, 480]);
    // a custom size is the client render's size
    const c = await call('render_4d', { handle: h, path: join(mkdtempSync(join(tmpdir(), 'p6-v044c-')), 'x'), kind: 'video', step: 7, width: 640, height: 360 });
    assert.deepEqual([c.d.client_render.width, c.d.client_render.height], [640, 360]);
  } finally { restore(); }
});

// ---- the Revit reader --------------------------------------------------------------------------------------------

// a stand-in rvtWorker.mjs: what it does comes from FAKE_RVT
const HB_URL = pathToFileURL(join(ROOT, 'core', 'bim', 'heartbeat.mjs')).href;
const FAKE_WORKER = `
import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { progress, startHeartbeat } from ${JSON.stringify(HB_URL)};
const [src, outIfc, outJson] = process.argv.slice(2), mode = process.env.FAKE_RVT || 'ok';
startHeartbeat();
if (mode === 'silent') { await new Promise((r) => setTimeout(r, 120000)); process.exit(1); } // does nothing (its heartbeat goes on: no progress, no processor time)
else if (mode === 'slow') { let n = 0; await new Promise((r) => { const t = setInterval(() => { progress(++n); if (n >= 20) { clearInterval(t); r(); } }, 150); }); } // steady, slow progress
const tmp = outIfc + '.' + process.pid + '.tmp';
if (mode !== 'ok') writeFileSync(tmp, 'half an IFC');
if (mode === 'disk') { console.error('disk_full: ENOSPC: no space left on device, write'); process.exit(4); }
if (mode === 'oom') { console.error('out_of_memory: memory allocation of 2147483648 bytes failed'); process.exit(5); }
if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
if (mode === 'bad') { console.error('not a readable Revit file (geometry: nope)'); process.exit(3); }
copyFileSync(process.env.FAKE_IFC, tmp); renameSync(tmp, outIfc);
writeFileSync(outJson, JSON.stringify({ metadata: { revit_version: 2023 }, mode: 'geometry', diagnostics: {}, revit_property_sets: null }));
`;
const fakeRevit = (size = 4096) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-fake-rvt-')), worker = join(dir, 'worker.mjs'), rvt = join(dir, 'Tower.rvt'), cache = join(dir, 'cache');
  writeFileSync(worker, FAKE_WORKER);
  const b = Buffer.alloc(size, 7); Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b); writeFileSync(rvt, b);
  mkdirSync(cache);
  return { dir, worker, rvt, cache };
};

test('the memory ratio is stated once: the need, the cap and the words all come from the same 8', () => {
  assert.equal(REVIT_MEMORY_PER_BYTE, 8);
  assert.equal(revitNeed(100 * 1048576), 128 * 1048576 + 100 * 1048576 * 8);
  assert.ok(revitMaxBytes() * REVIT_MEMORY_PER_BYTE <= 4096 * 1048576, 'the default cap times the ratio fits WebAssembly’s 4 GB');
  const e = new RevitTooLarge(500 * 1048576, revitMaxBytes());
  assert.match(e.message, /about 450 MB/);
  for (const f of ['docs/4d-tiles-contract.md', 'core/bim/rvt/README.md']) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /about 5[x×] the file|9[x×] the file/, f);
});

test('the Revit reader failing for the disk or for memory is reported with its cause and is never a lesser conversion or a cache entry; its half-written files go', async () => {
  const f = fakeRevit(), restore = env({ P6CLONE_RVT_WORKER: f.worker, P6CLONE_MODEL_CACHE: f.cache, FAKE_IFC: join(FX, 'construction-scheduling-task.ifc') });
  const tmps = () => readdirSync(f.cache).filter((n) => n.endsWith('.tmp'));
  try {
    process.env.FAKE_RVT = 'disk';
    await assert.rejects(rvtToIfc(f.rvt), (e: unknown) => e instanceof RevitDiskFull && /ENOSPC/.test(e.message) && e.dir === f.cache);
    process.env.FAKE_RVT = 'oom';
    await assert.rejects(rvtToIfc(f.rvt), (e: unknown) => e instanceof RevitTooLarge && /ran the Revit reader out of working memory \(memory allocation of 2147483648 bytes failed\)/.test(e.message) && !!e.ranOut);
    process.env.FAKE_RVT = 'kill';
    await assert.rejects(rvtToIfc(f.rvt), (e: unknown) => e instanceof RevitTooLarge && /ended by the system \(SIGKILL\)/.test(e.ranOut!));
    process.env.FAKE_RVT = 'bad';
    await assert.rejects(rvtToIfc(f.rvt), (e: unknown) => !(e instanceof RevitTooLarge) && !(e instanceof RevitDiskFull) && /not a readable Revit file/.test((e as Error).message));
    assert.deepEqual(readdirSync(f.cache), [], 'no cache entry, and no half-written IFC of the killed reader');
    // through the tools: memory is model_too_large with the cause, disk is model_unreadable with the next step
    process.env.FAKE_RVT = 'oom';
    const o = await call('open_model', { path: f.rvt });
    assert.equal(o.d.error.code, 'model_too_large', JSON.stringify(o.d).slice(0, 300));
    assert.match(o.d.error.message, /ran the Revit reader out of working memory/);
    assert.equal(o.d.error.reader_out_of_memory, true);
    assert.match(o.d.error.explain_to_user, /did not fit/);
    process.env.FAKE_RVT = 'disk';
    const dk = await call('open_model', { path: f.rvt });
    assert.equal(dk.d.error.code, 'model_unreadable');
    assert.match(dk.d.error.message, /could not write the converted IFC/);
    assert.match(dk.d.error.next_step, /Free disk space/);
    assert.deepEqual(tmps(), []);
  } finally { restore(); delete process.env.FAKE_RVT; }
});

test('a conversion that succeeds removes the old -rvt1 one; a file already converted opens whatever the size limit says now; model_too_large sends the agent to the project first', async () => {
  const f = fakeRevit(), restore = env({ P6CLONE_RVT_WORKER: f.worker, P6CLONE_MODEL_CACHE: f.cache, FAKE_IFC: join(FX, 'construction-scheduling-task.ifc'), FAKE_RVT: 'ok' });
  try {
    const { fileHash } = await import('../core/bim/model.ts');
    const hash = await fileHash(f.rvt);
    for (const ext of ['ifc', 'json']) writeFileSync(join(f.cache, `${hash}-rvt1.${ext}`), 'old');
    writeFileSync(join(f.cache, `${hash}-rvt1.keep`), 'not a conversion'); // only the old IFC and its JSON go
    const o = await call('open_model', { path: f.rvt });
    assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
    assert.equal(o.d.source.format, 'Revit');
    const names = readdirSync(f.cache);
    assert.ok(names.includes(`${hash}-rvt2.ifc`) && names.includes(`${hash}-rvt2.json`));
    assert.ok(!names.includes(`${hash}-rvt1.ifc`) && !names.includes(`${hash}-rvt1.json`), names.join(' '));
    assert.ok(names.includes(`${hash}-rvt1.keep`));
    await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
    // the size limit is lowered below the file: it is converted already, so it opens
    process.env.P6CLONE_REVIT_MAX_MB = '0.001';
    const again = await call('open_model', { path: f.rvt });
    assert.equal(again.err, false, JSON.stringify(again.d).slice(0, 300));
    await call('close', { handle: again.d.handle, owner_key: again.d.owner_key, discard: true });
    // a file not converted yet is refused, and the next step is the project first, the user second
    const other = join(f.dir, 'Other.rvt'); writeFileSync(other, Buffer.concat([readFileSync(f.rvt), Buffer.from('different')]));
    const big = await call('open_model', { path: other });
    assert.equal(big.d.error.code, 'model_too_large');
    const next: string = big.d.error.next_step;
    assert.match(next, /^FIRST look in the project’s bucket or folder .* for an NWC, NWD or IFC export of this same model/);
    assert.match(next, /same file name first \(Tower\.rvt: Tower\.nwc, Tower\.nwd, Tower\.ifc\)/);
    assert.match(next, /open_model it/);
    assert.match(next, /Only if none is the same model, ask the user \(pass this error’s explain_to_user/);
    assert.ok(next.indexOf('FIRST look') < next.indexOf('ask the user'));
    assert.match(next, /not technical/);
    assert.deepEqual(big.d.error.alternatives, ['nwc', 'nwd', 'ifc']);
    assert.match(big.d.error.explain_to_user, /about 8 times its size/);
    // the skill says the same, in the same order
    const skill = readFileSync(join(ROOT, 'docs', 'platform', '4d-scheduling-skill.md'), 'utf8');
    assert.match(skill, /model_too_large[^\n]*FIRST look in the project's bucket or folder[^\n]*NWC, NWD or IFC export of that same model[^\n]*same file name first[^\n]*Only if none is the same model, ask the user \(pass the error's explain_to_user\)/);
  } finally { restore(); delete process.env.P6CLONE_REVIT_MAX_MB; }
});

test('half-written conversions of readers that are gone are swept; a running reader’s are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-sweep-'));
  const dead = spawnSync(process.execPath, ['-e', '']).pid!; // a pid that has ended
  const files = { stale: `abc-rvt2.ifc.${dead}.tmp`, staleJson: `abc-rvt2.json.${dead}.tmp`, mine: `abc-rvt2.ifc.${process.pid}.tmp`, ifc: 'abc-rvt2.ifc', other: `abc.ifc.${dead}.tmp` };
  for (const n of Object.values(files)) writeFileSync(join(dir, n), 'x');
  const gone = sweepStaleTemps(dir).sort();
  assert.deepEqual(gone, [files.stale, files.staleJson].sort());
  assert.deepEqual(readdirSync(dir).sort(), [files.ifc, files.mine, files.other].sort());
});

// the real rvtWorker.mjs, over a stand-in for rvt-rs's WebAssembly
const stubWorker = () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stub-worker-')); mkdirSync(join(dir, 'rvt'));
  copyFileSync(join(ROOT, 'core', 'bim', 'rvtWorker.mjs'), join(dir, 'rvtWorker.mjs'));
  copyFileSync(join(ROOT, 'core', 'bim', 'heartbeat.mjs'), join(dir, 'heartbeat.mjs'));
  writeFileSync(join(dir, 'rvt', 'rvt_bg.wasm'), '');
  writeFileSync(join(dir, 'rvt', 'rvt.js'), `
export function initSync() { return { memory: { buffer: { byteLength: Number(process.env.STUB_MEM || 0) } } }; }
export function fileMetadata() { return {}; }
export function rvtToIfcStream(bytes, mode) {
  const m = process.env.STUB;
  globalThis.__rvtIfcSink('ISO-10303-21;\\n');
  if (m === 'sink') globalThis.__rvtIfcSink(null);
  if (m === 'grow') throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
  if (m === 'trap') throw new Error('unreachable');
  if (m === 'geometry-only' && mode === 'geometry') throw new Error('no geometry in this file');
  if (m === 'bad') throw new Error('not a revit file');
  return { diagnostics: { mode }, revit_property_sets: null };
}`);
  const src = join(dir, 'in.rvt'); writeFileSync(src, 'x');
  const run = (stub: string, extra: Record<string, string> = {}) => {
    const out = join(dir, `out-${stub}.ifc`), json = join(dir, `out-${stub}.json`);
    const r = spawnSync(process.execPath, [join(dir, 'rvtWorker.mjs'), src, out, json], { env: { ...process.env, STUB: stub, ...extra }, encoding: 'utf8' });
    return { code: r.status, err: r.stderr.trim(), ifc: existsSync(out), json: existsSync(json), mode: existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')).mode : null, tmp: readdirSync(dir).filter((n) => n.endsWith('.tmp')) };
  };
  return { run };
};

test('rvtWorker.mjs: a write error or an out-of-memory trap ends the run at once (exit 4, 5), never falling to a lesser mode; nothing is left or cached', () => {
  const { run } = stubWorker();
  const ok = run('ok');
  assert.deepEqual([ok.code, ok.ifc, ok.json, ok.tmp], [0, true, true, []]);
  const sink = run('sink');
  assert.equal(sink.code, 4, sink.err);
  assert.match(sink.err, /^disk_full: /);
  assert.deepEqual([sink.ifc, sink.json, sink.tmp], [false, false, []]);
  const grow = run('grow');
  assert.equal(grow.code, 5, grow.err);
  assert.match(grow.err, /^out_of_memory: .*Maximum memory size exceeded/);
  assert.deepEqual([grow.ifc, grow.json, grow.tmp], [false, false, []]);
  // a bare trap is memory only when the WebAssembly memory is at its limit
  assert.equal(run('trap', { STUB_MEM: String(4 * 2 ** 30 - 65536) }).code, 5);
  const trap = run('trap');
  assert.equal(trap.code, 3, 'a trap with room to spare is an unreadable file');
  assert.match(trap.err, /not a readable Revit file/);
  // a file whose geometry cannot be read still falls to the typed elements: that is the file, not the resources
  const lesser = run('geometry-only');
  assert.deepEqual([lesser.code, lesser.json, lesser.mode], [0, true, 'typed-no-geometry']);
});

// ---- no time limit on the workers, on any platform: their heartbeats (heartbeat.mjs, liveness.ts) ----------------

const STANDIN = (body: string) => { const dir = mkdtempSync(join(tmpdir(), 'p6-standin-')), p = join(dir, 'worker.mjs'); writeFileSync(p, `import { progress, startHeartbeat } from ${JSON.stringify(HB_URL)};\nstartHeartbeat();\n${body}`); return p; };
const SHORT = { P6CLONE_HEARTBEAT_MS: '100', P6CLONE_WORKER_FLOOR_MS: '400' };
const watched = (script: string) => new Promise<{ code: number | null; stuck: number; beats: string }>((done) => {
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...heartbeatEnv() } });
  let stuck = 0, text = '';
  const stop = heartbeatWatcher(child, { floorMs: Number(process.env.P6CLONE_WORKER_FLOOR_MS), onText: (t) => { text += t; }, onStuck: (ms) => { stuck = ms; child.kill(); } });
  child.on('close', (code) => { stop(); done({ code, stuck, beats: text }); });
});

test('a worker that progresses slowly but steadily is never ended, however long it takes; a silent one is, with the cause (heartbeats, any platform)', async () => {
  const restore = env(SHORT);
  try {
    // 3 s of steady progress, one step every 200 ms: seven times the 400 ms floor, and no processor time to speak of
    const t0 = Date.now();
    const slow = await watched(STANDIN("let n = 0; await new Promise((r) => { const t = setInterval(() => { progress(++n); if (n >= 15) { clearInterval(t); r(); } }, 200); }); console.log('done');"));
    assert.deepEqual([slow.code, slow.stuck], [0, 0]);
    assert.ok(Date.now() - t0 >= 2800);
    assert.equal(slow.beats.trim(), 'done', 'its own output comes through, its heartbeats do not');
    // idle: heartbeats go on, nothing else changes: two windows, then ended
    const t1 = Date.now();
    const silent = await watched(STANDIN("await new Promise((r) => setTimeout(r, 60000));"));
    assert.ok(silent.stuck >= 800, String(silent.stuck));
    assert.notEqual(silent.code, 0);
    assert.ok(Date.now() - t1 < 8000);
    // one long synchronous call (nothing for the main thread to report): the processor time its heartbeat reports is the life
    const busy = await watched(STANDIN("const t = Date.now(); while (Date.now() - t < 2500) { /* WebAssembly, say */ } console.log('done');"));
    assert.deepEqual([busy.code, busy.stuck], [0, 0]);
  } finally { restore(); }
});

test('the Revit reader and the geometry worker are watched the same way: slow and steady lives, silent is ended with a cause (no time limit)', { timeout: 120_000 }, async () => {
  const f = fakeRevit(), restore = env({ ...SHORT, P6CLONE_RVT_WORKER: f.worker, P6CLONE_MODEL_CACHE: f.cache, FAKE_IFC: join(FX, 'construction-scheduling-task.ifc') });
  try {
    process.env.FAKE_RVT = 'slow'; // 3 s of steady progress, windows of 400 ms
    assert.match((await rvtToIfc(f.rvt)).ifc, /-rvt2\.ifc$/);
    rmSync(join(f.cache), { recursive: true, force: true }); mkdirSync(f.cache);
    process.env.FAKE_RVT = 'silent';
    await assert.rejects(rvtToIfc(f.rvt), /the Revit reader stopped making progress \(its heartbeat showed no IFC written and no processor time for [\d.]+ minutes\) and was ended/);
    assert.deepEqual(readdirSync(f.cache), []);
    // the geometry worker, through open_model: a stand-in named like the real one (the environment only)
    const geom = (body: string) => { const w = STANDIN(body), d = join(w, '..'); for (const n of ['geomTiles.mjs', 'geomChunk.mjs', 'heartbeat.mjs']) copyFileSync(join(ROOT, 'core', 'bim', n), join(d, n)); return w; }; // beside the tiler and chunker, as the real one is
    const cache = mkdtempSync(join(tmpdir(), 'p6-geomcache-'));
    const opened = async (body: string) => {
      const r2 = env({ WHIQ_IFC_GEOM_WORKER: geom(body), P6CLONE_MODEL_CACHE: mkdtempSync(join(cache, 'c-')) });
      const copy = join(mkdtempSync(join(tmpdir(), 'p6-geomifc-')), 'm.ifc'); writeFileSync(copy, Buffer.concat([readFileSync(join(FX, 'Duplex_A_20110907.ifc')), Buffer.from(`\n/* ${Math.random()} */\n`)])); // its own content hash: no cached model
      try { const o = await call('open_model', { path: copy }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true }); return o.d; } finally { r2(); }
    };
    const silent = await opened("await new Promise((r) => setTimeout(r, 60000));");
    assert.equal(silent.geometry, 'unavailable');
    assert.match(silent.geometry_note, /^geometry stopped making progress \(its heartbeat showed no progress and no processor time for [\d.]+ minutes\) and was ended/);
    // slow and steady for 2.5 s, then fails by itself: it was not ended for being slow
    const slow = await opened("let n = 0; await new Promise((r) => { const t = setInterval(() => { progress(++n); if (n >= 12) { clearInterval(t); r(); } }, 200); }); console.error('stand-in finished'); process.exit(1);");
    assert.equal(slow.geometry, 'unavailable');
    assert.match(slow.geometry_note, /^geometry exited with code 1 \u2014 stand-in finished/);
  } finally { restore(); delete process.env.FAKE_RVT; }
});

test('the processor time of a process tree is read from outside on Linux, Windows (PowerShell, wmic) and macOS: the tables parse and sum', async () => {
  const tree = sumTree([[1, 0, 100], [2, 1, 50], [3, 2, 25], [4, 9, 1000]], 1);
  assert.equal(tree, 175);
  const ps = 'ProcessId,ParentProcessId,KernelModeTime,UserModeTime\r\n"10","1","20000000","10000000"\r\n"11","10","0","5000000"\r\n';
  assert.deepEqual(parseWindowsCpu(ps), [[10, 1, 3000], [11, 10, 500]]);
  const wmic = 'Node,KernelModeTime,ParentProcessId,ProcessId,UserModeTime\r\nPC,20000000,1,10,10000000\r\n';
  assert.deepEqual(parseWindowsCpu(wmic.replace('Node,', '').replace('PC,', '')), [[10, 1, 3000]]);
  assert.deepEqual(parsePsCpu(' 10 1 0:03.50\n 11 10 1-02:00:01\n'), [[10, 1, 3500], [11, 10, (86400 + 7200 + 1) * 1000]]);
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const ms = await treeCpuMs(process.pid);
    assert.ok(ms != null && ms > 0, String(ms));
  }
});

test('the Navisworks reader has no fixed 60-minute limit: slow and steady lives, silent is ended with a cause (P6CLONE_NWD_MINUTES is only an optional cap)', { timeout: 60_000 }, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'p6-nwcache-'));
  const nwc = join(mkdtempSync(join(tmpdir(), 'p6-nwsrc-')), 'hello.nwc'); copyFileSync(join(ROOT, 'tests', 'fixtures', 'navisworks', 'hello.nwc'), nwc);
  const run = async (body: string, extra: Record<string, string | undefined> = {}) => {
    const restore = env({ ...SHORT, P6CLONE_NWD_WORKER: STANDIN(body), P6CLONE_MODEL_CACHE: mkdtempSync(join(cache, 'c-')), P6CLONE_NWD_MINUTES: undefined, ...extra });
    try { await nwdToIfc(nwc); return null; } catch (e) { return (e as Error).message; } finally { restore(); }
  };
  assert.match((await run("await new Promise((r) => setTimeout(r, 60000));"))!, /^the Navisworks reader stopped making progress \(its heartbeat showed no progress and no processor time for [\d.]+ minutes\) and was ended/);
  // 2.5 s of steady progress (six times the 400 ms floor), then it ends without an answer by itself: not ended for being slow
  assert.equal(await run("let n = 0; await new Promise((r) => { const t = setInterval(() => { progress(++n); console.log('progress ' + n + ' 12 step'); if (n >= 12) { clearInterval(t); r(); } }, 200); });"), 'the Navisworks reader stopped without its answer');
  // the optional cap, when an administrator sets one, still ends a reader that is alive
  if (process.platform !== 'win32') assert.match((await run("let n = 0; await new Promise((r) => { const t = setInterval(() => progress(++n), 100); setTimeout(() => { clearInterval(t); r(); }, 5000); });", { P6CLONE_NWD_MINUTES: '0.01' }))!, /stopped \(SIGTERM/);
});

test('a test that hands a sample to a server process works on a copy: the fixture folder is never written, and recovery files are never samples', async () => {
  const before = readdirSync(SAMPLES_DIR).sort();
  const file = sampleCopy('cairo festival city.xer');
  assert.notEqual(dirname(file), SAMPLES_DIR);
  const p = spawn(process.execPath, [join(ROOT, 'mcp', 'server.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'p6-v044-srv-')) } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const send = (id: number, method: string, params: unknown) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const answer = async (id: number) => { for (let i = 0; i < 600; i++) { const l = out.split('\n').find((x) => x.startsWith(`{"jsonrpc":"2.0","id":${id},`)); if (l) return JSON.parse(l).result.structuredContent; await new Promise((r) => setTimeout(r, 100)); } throw new Error('no answer'); };
  const exited = new Promise((r) => p.on('exit', r));
  send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await answer(1).catch(() => null);
  send(2, 'tools/call', { name: 'open_file', arguments: { path: file } });
  const o = await answer(2);
  send(3, 'tools/call', { name: 'edit', arguments: { handle: o.handle, operations: [{ op: 'add_activity', id: 'ZZ1', name: 'x', duration_days: 1 }] } });
  await answer(3);
  p.stdin.end(); await exited;
  assert.match(err, new RegExp(`saved to ${dirname(file).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`), 'the recovery file is beside the copy');
  assert.deepEqual(readdirSync(SAMPLES_DIR).sort(), before, 'nothing was written into the shared fixture folder');
  assert.ok(samples().every((x) => !/\.recovered-/.test(x.name)));
});
