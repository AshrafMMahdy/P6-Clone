// WHIQ handoff 4L-13 part 1: a 4D render that fails part-way is continued. A video is made in segments (the tile memory
// budget), images one by one, each written the moment it is done, beside a render.json (arguments, fingerprint, frames done).
// render_4d with resume: makes only the frames missing and joins old and new into one video without encoding again.
// P6CLONE_TEST_FAIL_AT_FRAME=N makes a render fail once N frames are done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeVideo, segmentFrames } from '../core/bim/renderParts.ts';

// tiny segments for the whole file (the tile budget is read from the environment; the model's tile folder is named by it)
process.env.P6CLONE_TILE_MB = '1';
const FX = join(import.meta.dirname, 'fixtures', '4d');
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
if (!existsSync(join(import.meta.dirname, '..', 'dist-viewer', 'viewer4d.js'))) spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'build-viewer4d.mjs')]);
const CHROME = [process.env.P6CLONE_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
if (CHROME) process.env.P6CLONE_CHROMIUM = CHROME;
const FFMPEG = [process.env.P6CLONE_FFMPEG, ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map((d) => join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))].find((p) => p && existsSync(p));
const env = (vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(was)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
};

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
/** The video decodes end to end (ffmpeg, when there is one) and has this many frames. */
const decodes = (file: string, frames: number) => {
  if (!FFMPEG) return;
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), '', 'no decode errors');
  const n = [...r.stdout.matchAll(/^frame=(\d+)/gm)].map((m) => Number(m[1])).pop();
  assert.equal(n, frames, 'ffmpeg decodes every frame');
};
const small = { width: 640, height: 360, quality: 'standard', step: 2, fps: 1 };

test('segment size: the tile budget over the bytes a frame takes (measured, else the encoder bitrate over the frame rate), never under 1', () => {
  assert.equal(segmentFrames([], 8_000_000, 4, 32 * 1048576), 32 * 1048576 / 250_000 | 0);          // 8 Mb/s at 4 fps = 250 kB a frame
  assert.equal(segmentFrames([{ bytes: 1_000_000, frames: 10 }, { bytes: 3_000_000, frames: 10 }], 8_000_000, 4, 1048576), 5); // measured: 200 kB a frame
  assert.equal(segmentFrames([], 8_000_000, 0.25, 1048576), 1);    // a frame (4 s) is 4 MB: one frame a segment
  assert.equal(segmentFrames([{ bytes: 50_000_000, frames: 1 }], 1, 1, 1048576), 1);
});

test('video: a render that fails part-way keeps its segments; resume makes the rest and joins one video of frames_total frames', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-v-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'plan', ...small };
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: '6' });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  const e = failed.d.error, data = e;
  assert.equal(e.code, 'render_failed');
  assert.equal(data.reason, 'test_failure');
  assert.ok(data.frames_done >= 6 && data.frames_done < data.frames_total, JSON.stringify(data));
  assert.ok(data.kept_segments.length >= 1 && data.kept_segments.every((p: string) => existsSync(p)));
  assert.equal(basename(dirname(data.resume)), 'plan.parts');
  assert.match(String(e.hint ?? e.message), /call render_4d again with the same arguments and resume/);
  assert.ok(!existsSync(join(out, 'plan.mp4')), 'no half video');
  const mf = JSON.parse(readFileSync(data.resume, 'utf8'));
  assert.equal(mf.frames_total, data.frames_total);
  assert.equal(mf.arguments.file_name, 'plan');
  assert.equal(mf.arguments.owner_key, undefined);
  assert.equal(mf.arguments.handle, undefined, 'no handle in the manifest');
  assert.ok(mf.fingerprint.model && mf.fingerprint.timeline && mf.fingerprint.width === 640);
  // the same arguments with resume: only the missing frames, tiny segments (1 MB), one video
  const back2 = env({});
  let r;
  try { r = await call('render_4d', { ...args, resume: data.resume }); } finally { back2(); }
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.equal(r.d.frames, data.frames_total);
  assert.equal(r.d.resumed_frames, data.frames_done);
  assert.ok(r.d.segments >= 2, `several segments joined (${r.d.segments})`);
  assert.ok(!existsSync(join(out, 'plan.parts')), 'the parts are removed after a verified join');
  const facts = await probeVideo(r.d.written[0]);
  assert.equal(facts.frames, data.frames_total);
  assert.ok(Math.abs(facts.duration - data.frames_total / 1) < 1e-6);
  assert.ok(facts.keyFrames >= r.d.segments && facts.firstKey && facts.ordered);
  decodes(r.d.written[0], data.frames_total);
  // and a render without a failure in tiny segments is the same video
  const back3 = env({});
  let whole;
  try { whole = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-v2-')) }); } finally { back3(); }
  assert.equal(whole.err, false, JSON.stringify(whole.d).slice(0, 300));
  assert.equal((await probeVideo(whole.d.written[0])).frames, data.frames_total);
});

test('video: a resume after a change is refused (resume_mismatch says what changed); so is one from another path', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h, owner_key } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-m-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'plan', ...small };
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: '3' });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  const resume = failed.d.error.resume as string;
  assert.ok(existsSync(resume), JSON.stringify(failed.d).slice(0, 300));
  // an option
  const step = await call('render_4d', { ...args, step: 3, resume });
  assert.equal(step.d.error.code, "resume_mismatch", JSON.stringify(step.d).slice(0,900));
  assert.match(step.d.error.message, /step was 2, now 3/);
  const size = await call('render_4d', { ...args, width: 800, height: 450, resume });
  assert.equal(size.d.error.code, 'resume_mismatch');
  assert.match(size.d.error.message, /width was 640, now 800/);
  // a link (another element tied to an activity) and a schedule date
  await call('link_by_rules', { handle: h, owner_key, rules: [{ type: 'scope', activity: 'ROOF', storey: 'Level 1', class: 'IfcDoor' }] });
  const link = await call('render_4d', { ...args, resume });
  assert.equal(link.d.error.code, 'resume_mismatch');
  assert.match(link.d.error.message, /timeline changed/);
  assert.match(String(link.d.error.hint), /afresh/);
  // another folder
  const elsewhere = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-m2-')), resume });
  assert.equal(elsewhere.d.error.code, 'resume_mismatch');
  assert.equal((await call('render_4d', { ...args, resume: join(out, 'nothing.parts', 'render.json') })).d.error.code, 'resume_unreadable');
  assert.ok(existsSync(resume), 'a refused resume leaves the kept parts as they are');
  // afresh (no resume) replaces the kept parts and finishes
  const back2 = env({});
  let fresh;
  try { fresh = await call('render_4d', args); } finally { back2(); }
  assert.equal(fresh.err, false, JSON.stringify(fresh.d).slice(0, 300));
  assert.ok(!existsSync(join(out, 'plan.parts')));
});

test('images: each PNG is on disk the moment it is made; a failure keeps them, resume makes the rest', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-i-'));
  const args = { handle: h, path: out, kind: 'images', file_name: 'shot', width: 640, height: 360, quality: 'standard', step: 14 };
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: '2' });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  const data = failed.d.error;
  assert.equal(data.frames_done, 2, JSON.stringify(failed.d).slice(0, 900));
  assert.ok(data.frames_total > 2);
  assert.equal(data.kept.length, 2);
  for (const p of data.kept) assert.equal(readFileSync(p).subarray(1, 4).toString(), 'PNG');
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.png')).length, 2, 'only the finished frames');
  const firstBytes = readFileSync(data.kept[0]);
  const r = await call('render_4d', { ...args, resume: data.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.equal(r.d.written.length, data.frames_total);
  assert.equal(r.d.resumed_frames, 2);
  assert.ok(r.d.written.every((p: string) => readFileSync(p).subarray(1, 4).toString() === 'PNG'));
  assert.deepEqual(readFileSync(r.d.written[0]), firstBytes, 'a kept frame is not drawn again');
  assert.ok(!existsSync(join(out, 'shot.parts')));
  const other = await call('render_4d', { ...args, step: 7, resume: join(out, 'shot.parts', 'render.json') });
  assert.equal(other.d.error.code, 'resume_unreadable', 'a finished render has nothing to continue');
});

test('video: the graphics card fails part-way and the processor would pick another picture; the kept frames keep theirs and the rest is drawn the same way', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-g-'));
  // (auto quality: the full model fits the limit on the graphics card, the processor's estimate does not, so a re-plan would be a 480p draft of boxes)
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: '4', P6CLONE_TEST_FAIL_CODE: 'webgl_context_lost', P6CLONE_RENDER_DRAFT_MINUTES: '0.12' });
  let r;
  const args = { handle: h, path: out, kind: 'video', file_name: 'gpu', step: 2, fps: 1 };
  try { r = await call('render_4d', args); } finally { back(); }
  if (r.err) {
    // a machine with no graphics card (a CI runner, WSL) draws on the processor from the start: there is nothing to fall back to,
    // so the failure is reported with what is kept, and resume makes the rest
    assert.equal(r.d.error.code, 'render_failed', JSON.stringify(r.d).slice(0, 500));
    assert.ok(r.d.error.frames_done >= 1 && r.d.error.resume, JSON.stringify(r.d).slice(0, 500));
    r = await call('render_4d', { ...args, resume: r.d.error.resume });
  }
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  const facts = await probeVideo(r.d.written[0]);
  assert.equal(facts.frames, r.d.frames);
  if (r.d.renderer?.kind === 'software' && /graphics card/.test(r.d.renderer.name ?? '')) {
    assert.ok(r.d.segments >= 2, 'segments of both renderers are in the one video');
    assert.deepEqual(r.d.size, [1280, 720], 'the frames kept keep their picture');
    assert.equal(r.d.drawn.geometry, 'full');
    assert.match(String(r.d.quality_note), /already made keep their picture/);
    assert.equal(r.d.redrawn, undefined, 'nothing was dropped');
  }
  decodes(r.d.written[0], r.d.frames);
});

test('video as WebM (a browser without H.264): segments join as WebM, and ffmpeg makes the one MP4 of the joined video', { skip: (!CHROME && 'no Chromium here') || (!FFMPEG && 'no ffmpeg here'), timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const back = env({ P6CLONE_RECORD_WEBM: '1', P6CLONE_FFMPEG: FFMPEG });
  try {
    const webm = await call('render_4d', { handle: h, path: mkdtempSync(join(tmpdir(), 'p6-rr-w-')), kind: 'video', format: 'webm', file_name: 'w', ...small });
    assert.equal(webm.err, false, JSON.stringify(webm.d).slice(0, 400));
    assert.equal(webm.d.mime, 'video/webm');
    assert.ok(webm.d.segments >= 2);
    assert.equal((await probeVideo(webm.d.written[0])).frames, webm.d.frames);
    decodes(webm.d.written[0], webm.d.frames);
    const out = mkdtempSync(join(tmpdir(), 'p6-rr-w2-'));
    const a = { handle: h, path: out, kind: 'video', file_name: 'm', ...small };
    process.env.P6CLONE_TEST_FAIL_AT_FRAME = '5';
    const failed = await call('render_4d', a);
    delete process.env.P6CLONE_TEST_FAIL_AT_FRAME;
    const mp4 = await call('render_4d', { ...a, resume: failed.d.error.resume });
    assert.equal(mp4.err, false, JSON.stringify(mp4.d).slice(0, 400));
    assert.equal(mp4.d.mime, "video/mp4", JSON.stringify(mp4.d).slice(0, 900));
    assert.equal((await probeVideo(mp4.d.written[0])).frames, mp4.d.frames);
  } finally { back(); }
});

test('a render_4d job cancelled mid-render keeps its segments: the cancelled answer says how far it got, and resume finishes it', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-c-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'cx', width: 1280, height: 720, quality: 'standard', step: 1, fps: 1 / 60 };
  // (a frame a minute: the first segment is sized from the bitrate to one frame, so the cancel lands while the next one is still drawing)
  const job = (await call('render_4d', { ...args, async: true })).d.job_id;
  assert.ok(job);
  // cancel once a segment is on disk
  const parts = join(out, 'cx.parts');
  for (let k = 0; k < 3000 && !(existsSync(parts) && readdirSync(parts).some((f) => f.startsWith('seg-'))); k++) await new Promise((r) => setTimeout(r, 20));
  await call('cancel_job', { job_id: job });
  const view = (await call('job_status', { job_id: job, wait_seconds: 20 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 400));
  const r = view.result;
  assert.equal(r.partial, true);
  assert.equal(r.stopped, 'cancelled');
  assert.ok(r.frames_done >= 1 && r.frames_done < r.frames_total, JSON.stringify(r).slice(0, 400));
  assert.ok(r.kept_segments.length >= 1 && r.kept_segments.every((p: string) => existsSync(p)));
  assert.equal(basename(dirname(r.resume)), 'cx.parts');
  const done = await call('render_4d', { ...args, resume: r.resume });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal(done.d.frames, r.frames_total);
  assert.equal(done.d.resumed_frames, r.frames_done, 'the frames kept were not drawn again');
  assert.equal(done.d.drawn_frames, r.frames_total - r.frames_done, 'only the missing frames were drawn');
  assert.equal((await probeVideo(done.d.written[0])).frames, r.frames_total);
  assert.ok(!existsSync(parts));
});
const failVideo = async (name: string, at = '3') => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-t-'));
  const args = { handle: h, path: out, kind: 'video', file_name: name, ...small };
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: at });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  return { args, out, e: failed.d.error };
};

test('a cancel while the segments are being joined still returns the partial result, and resume only joins', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-j-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'jn', ...small };
  const back = env({ P6CLONE_TEST_JOIN_DELAY_MS: '6000' });
  let view;
  try {
    const job = (await call('render_4d', { ...args, async: true })).d.job_id;
    const manifest = join(out, 'jn.parts', 'render.json');
    for (let k = 0; k < 900; k++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const m = JSON.parse(readFileSync(manifest, 'utf8')); if (m.segments.reduce((n: number, s: any) => n + s.frames, 0) === m.frames_total) break; } catch { /* not yet */ }
    }
    await call('cancel_job', { job_id: job });
    view = (await call('job_status', { job_id: job, wait_seconds: 20 })).d;
  } finally { back(); }
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 400));
  const r = view.result;
  assert.equal(r.frames_done, r.frames_total);
  assert.ok(r.kept_segments.length >= 1 && existsSync(r.resume));
  const done = await call('render_4d', { ...args, resume: r.resume });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal(done.d.resumed_frames, r.frames_total, 'nothing drawn again');
  assert.equal((await probeVideo(done.d.written[0])).frames, r.frames_total);
});

test('a tampered manifest is not trusted: unreadable ones are refused in words, bad entries are dropped and made again, nothing outside the folder is touched', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('tm');
  const mf = JSON.parse(readFileSync(e.resume, 'utf8'));
  const write = (m: unknown) => writeFileSync(e.resume, typeof m === 'string' ? m : JSON.stringify(m));
  for (const bad of [{ ...mf, fingerprint: undefined }, { ...mf, frames_total: 'many' }, { ...mf, segments: 'x' }, '{not json']) {
    write(bad as any);
    const r = await call('render_4d', { ...args, resume: e.resume });
    assert.equal(r.d.error.code, 'resume_unreadable', JSON.stringify(r.d).slice(0, 300));
  }
  // entries that are not plain files of this folder, or ranges that do not fit, or overlap: dropped, not followed
  const outside = join(out, 'outside.mp4'); writeFileSync(outside, 'keep me');
  write({ ...mf, segments: [...mf.segments, { file: '../outside.mp4', first: 0, frames: 1, bytes: 7 }, { file: 'seg-0099.mp4', first: mf.frames_total - 1, frames: 50, bytes: 1 }, { ...mf.segments[0] }] });
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
  assert.ok(r.d.redrawn.length >= 2, JSON.stringify(r.d.redrawn));
  assert.equal(r.d.frames, mf.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, mf.frames_total);
});

test('a corrupt kept segment is found when the manifest is read, drawn again, and the answer says so', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, e } = await failVideo('cs', '6');
  const seg = e.kept_segments[0] as string, size = statSync(seg).size;
  writeFileSync(seg, Buffer.alloc(size, 7)); // the same size, not a video
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.equal(r.d.redrawn.length, 1, JSON.stringify(r.d.redrawn));
  assert.match(r.d.redrawn[0], /seg-0001/);
  assert.equal(r.d.frames, e.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
  decodes(r.d.written[0], e.frames_total);
});

test('images: entries of a tampered manifest (an index out of range, a file that is not this render’s) do not count as frames', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-ti-'));
  const args = { handle: h, path: out, kind: 'images', file_name: 'ti', width: 640, height: 360, quality: 'standard', step: 14 };
  const back = env({ P6CLONE_TEST_FAIL_AT_FRAME: '2' });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  const e = failed.d.error, mf = JSON.parse(readFileSync(e.resume, 'utf8'));
  const stray = join(out, 'stray.png'); writeFileSync(stray, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  mf.images.push({ index: 9999, file: stray }, { index: 2, file: stray }, { index: -1, file: stray });
  writeFileSync(e.resume, JSON.stringify(mf));
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.equal(r.d.resumed_frames, 2, 'only the two real frames were kept');
  assert.equal(r.d.written.length, e.frames_total);
  assert.ok(r.d.redrawn.length >= 1);
  assert.ok(r.d.written.every((p: string) => p !== stray && readFileSync(p).subarray(1, 4).toString() === 'PNG'));
});

test('a resume adopts the picture the kept render was drawn with: auto picks a draft first and another plan on the second call, and the resume still continues the draft', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-a-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'au', step: 2, fps: 1 };
  // the first call: any full render is too long for auto, so it is a draft (854x480 boxes); it fails part-way
  const back = env({ P6CLONE_RENDER_DRAFT_MINUTES: '0.00001', P6CLONE_TEST_FAIL_AT_FRAME: '4' });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  // the second call, same arguments, decides auto otherwise (the full model, 1280x720) -- and is not refused
  const fresh = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-a2-')) });
  assert.equal(fresh.d.quality, 'standard', 'auto now picks another plan');
  const r = await call('render_4d', { ...args, resume: failed.d.error.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.equal(r.d.quality, 'draft');
  assert.deepEqual(r.d.size, [854, 480]);
  assert.equal(r.d.drawn.geometry, 'boxes');
  assert.match(String(r.d.quality_note), /not decided again/);
  assert.equal((await probeVideo(r.d.written[0])).frames, failed.d.error.frames_total);
  // what the caller does give still counts: another size is a mismatch
  const f2 = env({ P6CLONE_RENDER_DRAFT_MINUTES: '0.00001', P6CLONE_TEST_FAIL_AT_FRAME: '4' });
  let again;
  try { again = await call('render_4d', { ...args, file_name: 'au2' }); } finally { f2(); }
  const bad = await call('render_4d', { ...args, file_name: 'au2', width: 1280, height: 720, resume: again.d.error.resume });
  assert.equal(bad.d.error.code, 'resume_mismatch');
  assert.match(bad.d.error.message, /width was 854, now 1280/);
});
