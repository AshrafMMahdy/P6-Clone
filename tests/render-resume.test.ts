// WHIQ handoff 4L-13 (parts 1 and 2): a 4D render that fails or is cancelled part-way is continued. A video is made in runs, each run
// streamed to its own file as the encoder makes it (a fragmented MP4's fragments, a WebM's clusters: whole chunks cut at the encoder's
// key frames), render.json saying after each whole chunk how many bytes are whole and how many frames they hold; images are written
// one by one. render_4d with resume: makes only the frames missing and joins old and new into one video without encoding again.
// testHooks.failAtFrame (mcp/fourd.ts) makes a render fail once N frames are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ALL_FORMATS, EncodedPacketSink, EncodedVideoPacketSource, FilePathSource, Input, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { filesLeftIn, joinSegments, leftFilesApply, Parts, PartsInUse, probeVideo } from '../core/bim/renderParts.ts';
import { renderRun } from '../core/bim/headless.ts';
import { partsNotRemovedAnswer, testHooks } from '../mcp/fourd.ts';
import { setRoots } from '../mcp/runtime.ts';

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
/** testHooks set in process; the returned function puts them back */
const hook = (o: Partial<typeof testHooks>) => { const was = { ...testHooks }; Object.assign(testHooks, o); return () => Object.assign(testHooks, was); };

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
/** every file and folder under a folder (relative paths) */
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...tree(join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [e.name]));
/** a finished render leaves no .parts folder and no render.json in the output folder */
const noParts = (out: string) => assert.deepEqual(tree(out).filter((f) => /\.parts$|render\.json/.test(f)), [], 'the parts are removed after a successful render');
const small = { width: 640, height: 360, quality: 'standard', step: 2, fps: 1 };

// ---- the parts of a render, without a browser: runs made by Mediabunny in Node from a clip ffmpeg makes ----------------------------------
const clip = (webm: boolean, profile = 'high'): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'p6-rr-clip-')), webm ? 'a.webm' : 'a.mp4');
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=4', '-t', '20', ...(webm ? ['-c:v', 'libvpx-vp9'] : ['-c:v', 'libx264', '-bf', '0', '-profile:v', profile, '-pix_fmt', 'yuv420p']), '-g', '20', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return f;
};
/** A clip's packets written as the page writes a stream: the whole chunks in order, [header, fragment, fragment, ...]. `tweak` changes the decoder description. */
async function chunks(file: string, webm: boolean, tweak?: (d: Uint8Array) => Uint8Array): Promise<Buffer[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const config = (await track.getDecoderConfig())!;
  if (tweak && config.description) config.description = tweak(new Uint8Array(config.description as ArrayBuffer));
  const pieces: Buffer[] = [], ends: number[] = []; let have = 0;
  const whole = (d: Uint8Array, at: number) => { ends.push(at + d.length); };
  const target = new StreamTarget(new WritableStream({ write(c) { assert.equal(c.position, have); pieces.push(Buffer.from(c.data)); have += c.data.length; } }));
  const output = new Output({ format: webm ? new WebMOutputFormat({ appendOnly: true, onSegmentHeader: whole, onCluster: whole }) : new Mp4OutputFormat({ fastStart: 'fragmented', onMoov: whole, onMdat: whole }), target });
  const src = new EncodedVideoPacketSource(track.codec as 'avc' | 'vp9');
  output.addVideoTrack(src, { frameRate: 4 });
  await output.start();
  let n = 0;
  for await (const p of new EncodedPacketSink(track).packets()) { await src.add(p.clone({ timestamp: n / 4, sequenceNumber: n }), n ? undefined : { decoderConfig: config }); n++; }
  await output.finalize();
  input.dispose();
  const all = Buffer.concat(pieces), out: Buffer[] = []; let at = 0;
  for (const e of ends) { out.push(all.subarray(at, e)); at = e; }
  return out;
}
const putFile = (p: string, d: string | Uint8Array) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d); };
const newParts = (frames: number, mime: string, webm = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-rr-u-'));
  return { dir, parts: Parts.create(join(dir, 'x.parts'), { kind: 'video', arguments: {}, fingerprint: {}, frames_total: frames, mime, fps: 4 }, putFile, dir) };
};

test('a run is written chunk by chunk: render.json says after each whole chunk how many bytes are whole and what frames they hold', { skip: !FFMPEG && 'no ffmpeg here' }, async () => {
  for (const webm of [false, true]) {
    const cs = await chunks(clip(webm), webm);
    assert.ok(cs.length >= 3, `a header and several chunks (${cs.length})`);
    const { parts } = newParts(80, webm ? 'video/webm' : 'video/mp4');
    const run = parts.startRun(0, parts.m.mime!, 4);
    const file = join(parts.dir, basename(run.file));
    await run.add(cs[0]);
    assert.equal(parts.framesDone, 0, 'a header holds no frame');
    assert.equal(JSON.parse(readFileSync(parts.manifestPath, 'utf8')).segments.length, 0);
    let want = 0;
    for (const c of cs.slice(1)) {
      await run.add(c);
      const m = JSON.parse(readFileSync(parts.manifestPath, 'utf8'));
      assert.equal(m.segments.length, 1);
      assert.equal(m.segments[0].bytes, statSync(file).size, 'the file is whole up to the recorded length after every chunk');
      assert.ok(m.segments[0].frames > want && m.segments[0].config);
      want = m.segments[0].frames;
      assert.equal((await probeVideo(file, m.segments[0].bytes)).frames, want, 'the recorded frames are what the bytes hold');
    }
    assert.equal(want, 80);
    assert.deepEqual(parts.missing(), []);
  }
});

test('a run has no holes: a chunk that does not continue it is refused and never recorded; renderRun never hands on a chunk after one that failed (what follows is drawn again), and takes the chunks on the progress poll, in order', { skip: !FFMPEG && 'no ffmpeg here' }, async () => {
  const cs = await chunks(clip(false), false);
  const { parts } = newParts(80, 'video/mp4');
  const run = parts.startRun(0, 'video/mp4', 4);
  await run.add(cs[0]); await run.add(cs[1]);
  const size = statSync(join(parts.dir, run.file)).size, recorded = readFileSync(parts.manifestPath, 'utf8');
  await assert.rejects(run.add(cs[3]), /a chunk is missing/); // chunk 2 never arrived
  assert.equal(statSync(join(parts.dir, run.file)).size, size, 'nothing was written for it');
  assert.equal(readFileSync(parts.manifestPath, 'utf8'), recorded, 'render.json never records it');
  assert.equal(parts.framesDone, run.frames);
  await run.add(cs[2]); // the one that follows is accepted
  // renderRun with a page that hands out chunks 'a b c' at once, then 'd': the handler fails on b, and c and d are never handled
  const b64 = (t: string) => Buffer.from(t).toString('base64');
  let drains = 0;
  const handled: string[] = [];
  const evaluate = async (expr: string) => {
    if (expr.includes('.encode(')) { await new Promise((r) => setTimeout(r, 1800)); return { mime: 'video/mp4', frames: 4 }; }
    if (expr.includes('.drain()')) { drains++; return drains === 1 ? [b64('a'), b64('b'), b64('c')] : drains === 2 ? [b64('d')] : []; }
    return { done: 1, total: 4 };
  };
  await assert.rejects(renderRun(evaluate, {}, (c) => { handled.push(c.toString()); if (c.toString() === 'b') throw new Error('disk'); }, async () => undefined), /disk/);
  assert.deepEqual(handled, ['a', 'b'], 'c (in the same batch) and d (the next) were not handed on');
  // and when nothing fails, every chunk comes in order, including those finished after the last poll
  drains = 0; handled.length = 0;
  const ok = await renderRun(evaluate, {}, (c) => { handled.push(c.toString()); }, async () => undefined);
  assert.equal(ok.frames, 4);
  assert.deepEqual(handled, ['a', 'b', 'c', 'd']);
});

test('a file torn mid-chunk (a killed process) is cut back to its whole length when the resume is accepted, not before; its frames are missing; a complete chunk the manifest did not record counts the same', { skip: !FFMPEG && 'no ffmpeg here' }, async () => {
  const cs = await chunks(clip(false), false);
  const { parts } = newParts(80, 'video/mp4');
  const run = parts.startRun(0, 'video/mp4', 4);
  const file = join(parts.dir, run.file);
  for (const c of cs.slice(0, 3)) await run.add(c); // header + two chunks
  const recorded = statSync(file).size, frames = parts.framesDone;
  assert.ok(frames > 0 && frames < 80);
  for (const tail of [cs[3].subarray(0, 100), cs[3]]) { // half a chunk, then a whole chunk the manifest never heard of
    appendFileSync(file, tail);
    const before = readFileSync(parts.manifestPath, 'utf8');
    const loaded = (await Parts.load(parts.manifestPath, putFile, parts.base))!;
    assert.equal(loaded.framesDone, frames, 'only the recorded whole chunks count');
    assert.match(loaded.redrawn.join('|'), /cut off/);
    assert.equal(statSync(file).size, recorded + tail.length, 'load alone cuts nothing');
    assert.equal(readFileSync(parts.manifestPath, 'utf8'), before, 'load alone writes nothing');
    loaded.settle();
    assert.equal(statSync(file).size, recorded, 'settle cuts the file back to its whole length');
    assert.deepEqual(loaded.missing(), [[frames, 80 - frames]]);
  }
});

test('load never deletes: an unreadable or short run is marked to be drawn again, its file stays until a run actually draws over it; a manifest of an earlier version (seg-N.mp4, whole files) still reads', { skip: !FFMPEG && 'no ffmpeg here' }, async () => {
  const cs = await chunks(clip(false), false);
  const { parts } = newParts(80, 'video/mp4');
  const run = parts.startRun(0, 'video/mp4', 4);
  for (const c of cs) await run.add(c);
  const file = join(parts.dir, run.file), size = statSync(file).size, before = readFileSync(parts.manifestPath, 'utf8');
  // same size, not a video
  writeFileSync(file, Buffer.alloc(size, 7));
  let loaded = (await Parts.load(parts.manifestPath, putFile, parts.base))!;
  assert.equal(loaded.framesDone, 0);
  assert.match(loaded.redrawn.join('|'), /run-0001/);
  assert.ok(existsSync(file) && statSync(file).size === size, 'the file is not removed');
  assert.equal(readFileSync(parts.manifestPath, 'utf8'), before, 'the manifest on disk is as it was');
  // shorter than the whole length written
  truncateSync(file, size - 10);
  loaded = (await Parts.load(parts.manifestPath, putFile, parts.base))!;
  assert.match(loaded.redrawn.join('|'), /shorter/);
  assert.ok(existsSync(file));
  // settle writes the manifest without the run; the file is still there until the new run's header overwrites it
  loaded.settle();
  assert.equal(JSON.parse(readFileSync(parts.manifestPath, 'utf8')).segments.length, 0);
  assert.ok(existsSync(file));
  const again = loaded.startRun(0, 'video/mp4', 4);
  assert.equal(again.file, run.file, 'numbered after the runs kept: the same name');
  await again.add(cs[0]);
  assert.equal(statSync(file).size, cs[0].length, 'overwritten when actually drawn again');
  // an earlier version's manifest: a whole file named seg-0001.mp4, no config, bytes = its size
  const whole = clip(false), dir = mkdtempSync(join(tmpdir(), 'p6-rr-old-')), seg = join(dir, 'old.parts', 'seg-0001.mp4');
  mkdirSync(dirname(seg), { recursive: true }); writeFileSync(seg, readFileSync(whole));
  writeFileSync(join(dir, 'old.parts', 'render.json'), JSON.stringify({ format: 'p6c-4d-render', version: 1, kind: 'video', arguments: {}, fingerprint: {}, frames_total: 160, mime: 'video/mp4', fps: 4, segments: [{ file: 'seg-0001.mp4', first: 0, frames: 80, bytes: statSync(seg).size }], images: [] }));
  const old = (await Parts.load(join(dir, 'old.parts'), putFile, dir))!;
  assert.equal(old.framesDone, 80);
  assert.deepEqual(old.redrawn, []);
  assert.ok(old.m.segments[0].config, 'its decoder configuration is read from the file');
  assert.equal(old.startRun(80, 'video/mp4', 4).file, 'run-0002.mp4');
});

test('runs from different encoders: a join of them is refused; reconcile marks the ones that differ from the encoder in use stale (listed, not counted, redrawn in one pass, kept until replaced, usable again by an encoder that matches)', { skip: !FFMPEG && 'no ffmpeg here' }, async () => {
  const a = await chunks(clip(false, 'high'), false), b = await chunks(clip(false, 'baseline'), false);
  const { parts, dir } = newParts(160, 'video/mp4');
  const r1 = parts.startRun(0, 'video/mp4', 4); for (const c of a) await r1.add(c);
  const r2 = parts.startRun(80, 'video/mp4', 4); for (const c of b) await r2.add(c);
  const [ca, cb] = [parts.m.segments[0].config!, parts.m.segments[1].config!];
  assert.notEqual(ca, cb, 'two encoders, two decoder configurations');
  const segs = parts.sortedSegments().map((s) => ({ file: join(parts.dir, s.file), first: s.first, bytes: s.bytes }));
  await assert.rejects(joinSegments(segs, join(dir, 'bad.mp4'), { mime: 'video/mp4', fps: 4 }), /decoder configuration/);
  assert.ok(!existsSync(join(dir, 'bad.mp4')), 'no broken video is left');
  // the encoder in use is cb (this call's first run): run-0001 is stale, in one step; nothing is deleted or lost from the manifest
  parts.reconcile(cb); parts.save();
  assert.deepEqual(parts.missing(), [[0, 80]]);
  assert.equal(parts.framesDone, 80, 'a stale run is not counted');
  assert.match(parts.redrawn[0], /run-0001.*another encoder.*decoder configuration/);
  assert.ok(existsSync(join(parts.dir, 'run-0001.mp4')));
  const listed = JSON.parse(readFileSync(parts.manifestPath, 'utf8')).segments;
  assert.deepEqual(listed.map((s: any) => [s.file, !!s.stale]), [['run-0001.mp4', true], ['run-0002.mp4', false]], 'stale, but still listed');
  assert.deepEqual((parts.report() as any).kept_segments.map((f: string) => basename(f)), ['run-0002.mp4'], 'kept_segments is the work in use: it matches frames_done');
  assert.deepEqual((parts.report() as any).stale_segments.map((f: string) => basename(f)), ['run-0001.mp4'], 'the stale run is listed apart');
  assert.deepEqual(parts.odd(cb), []);
  // a failed redraw loses nothing: a partial replacement (run-3, the encoder in use) lists beside the stale run, which load keeps
  const r3 = parts.startRun(0, 'video/mp4', 4); await r3.add(b[0]); await r3.add(b[1]);
  assert.equal(r3.file, 'run-0003.mp4');
  parts.retire();
  assert.equal(JSON.parse(readFileSync(parts.manifestPath, 'utf8')).segments.length, 3, 'the stale run stays until its frames are all covered');
  const again = (await Parts.load(parts.manifestPath, putFile, parts.base))!;
  assert.equal(again.m.segments.length, 3);
  assert.equal(again.framesDone, 80 + 20);
  // another encoder (ca) in use on a later call: the runs that differ are stale, and the stale run ca drew comes back (no run in use holds its frames)
  again.reconcile(ca);
  assert.deepEqual(again.m.segments.map((s) => [s.file, !!s.stale]).sort(), [['run-0001.mp4', false], ['run-0002.mp4', true], ['run-0003.mp4', true]]);
  assert.equal(again.framesDone, 80); assert.deepEqual(again.missing(), [[80, 80]]);
  assert.match(again.reused[0], /run-0001.*used again/);
  assert.match(JSON.stringify(again.report()), /used again/);
  // the redraw completes: a run of the encoder in use covers the stale run's frames, and the stale run leaves the manifest
  const { parts: p3 } = newParts(160, 'video/mp4');
  const s1 = p3.startRun(0, 'video/mp4', 4); for (const c of a) await s1.add(c);
  const s2 = p3.startRun(80, 'video/mp4', 4); for (const c of b) await s2.add(c);
  p3.reconcile(cb); p3.save();
  const s3 = p3.startRun(0, 'video/mp4', 4); for (const c of b) await s3.add(c);
  assert.deepEqual(p3.m.segments.map((s) => s.file), ['run-0001.mp4', 'run-0002.mp4', 'run-0003.mp4']);
  p3.retire();
  assert.deepEqual(p3.m.segments.map((s) => s.file), ['run-0002.mp4', 'run-0003.mp4'], 'the stale run is gone once replaced');
  assert.deepEqual(p3.missing(), [], 'nothing is missing');
  // the same encoder in two runs joins, and the video decodes
  const { parts: p2, dir: d2 } = newParts(160, 'video/mp4');
  const q = p2.startRun(0, 'video/mp4', 4); for (const c of a) await q.add(c);
  const w = p2.startRun(80, 'video/mp4', 4); for (const c of a) await w.add(c);
  assert.deepEqual(p2.odd(p2.newestConfig()), []);
  await joinSegments(p2.sortedSegments().map((s) => ({ file: join(p2.dir, s.file), first: s.first, bytes: s.bytes })), join(d2, 'ok.mp4'), { mime: 'video/mp4', fps: 4 });
  assert.equal((await probeVideo(join(d2, 'ok.mp4'))).frames, 160);
  decodes(join(d2, 'ok.mp4'), 160);
});

test('a stale run the encoder in use drew comes back into use where no run in use holds its frames (A, then B, then A: nothing counted twice); one that overlaps stays listed until runs in use cover it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-rr-flip-'));
  const seg = (file: string, first: number, config: string, stale?: true, frames = 2) => ({ file, first, frames, bytes: 1, config, ...(stale ? { stale } : {}) });
  const p = new Parts(join(dir, 'x.parts'), { format: 'p6c-4d-render', version: 1, kind: 'video', arguments: {}, fingerprint: {}, frames_total: 10, mime: 'video/mp4', fps: 1, segments: [seg('run-0001.mp4', 6, 'A', true), seg('run-0002.mp4', 8, 'B'), seg('run-0005.mp4', 1, 'A', true)], images: [] }, putFile, dir);
  assert.deepEqual(p.missing().map((m) => m[0]).sort(), [0], 'a stale run does not count at load');
  assert.deepEqual(p.missing(true), [[0, 1], [3, 3]], 'the frames no run holds, in use or stale');
  // this call's encoder is A: its first run (frames 1-2) is being drawn; run-0005 (A, frames 2-3) overlaps it and stays stale
  p.m.segments.push(seg('run-0003.mp4', 0, 'A'));
  p.reconcile('A', [0, 2]);
  assert.deepEqual(p.m.segments.map((s) => `${s.file}${s.stale ? ' stale' : ''}`), ['run-0001.mp4', 'run-0002.mp4 stale', 'run-0005.mp4 stale', 'run-0003.mp4'], 'run-0001 matches A and no run in use holds its frames: used again; run-0005 overlaps the run being drawn');
  assert.equal(p.framesDone, 4, 'no frame counted twice');
  const live = p.sortedSegments();
  assert.ok(live.every((s, i) => i === 0 || live[i - 1].first + live[i - 1].frames <= s.first), 'runs in use do not overlap');
  assert.deepEqual((p.report() as any).stale_segments.map((f: string) => basename(f)), ['run-0005.mp4', 'run-0002.mp4']);
  assert.deepEqual((p.report() as any).kept_segments.map((f: string) => basename(f)), ['run-0003.mp4', 'run-0001.mp4'], 'kept_segments is what frames_done counts');
  // a stale run covered by runs in use is retired
  p.m.segments.push(seg('run-0004.mp4', 2, 'A', undefined, 1));
  p.retire();
  assert.deepEqual(p.m.segments.map((s) => s.file), ['run-0001.mp4', 'run-0002.mp4', 'run-0003.mp4', 'run-0004.mp4'], 'run-0005 (frames 2-3) is covered and leaves; run-0002 is not covered and stays');
});

test('the flip back the review found (A drew 300 of 333 frames, B one chunk, cancelled; A in use again): only the 33 frames no run of A holds are drawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-rr-flip2-'));
  const p = new Parts(join(dir, 'x.parts'), { format: 'p6c-4d-render', version: 1, kind: 'video', arguments: {}, fingerprint: {}, frames_total: 333, mime: 'video/mp4', fps: 1,
    segments: [{ file: 'run-0001.mp4', first: 0, frames: 300, bytes: 1, config: 'A', stale: true }, { file: 'run-0002.mp4', first: 300, frames: 10, bytes: 1, config: 'B' }], images: [] }, putFile, dir);
  // the frames no run holds go first (the call's encoder, A, draws them): its first chunk sets the reference
  const first = p.missing(true)[0];
  assert.deepEqual(first, [310, 23]);
  p.m.segments.push({ file: 'run-0003.mp4', first: 310, frames: 23, bytes: 1, config: 'A' });
  p.reconcile('A', first);
  assert.deepEqual(p.missing(true), []);
  assert.deepEqual(p.missing(), [[300, 10]], 'run-0001 is used again; only B\u2019s frames are drawn again');
  assert.equal(23 + p.missing().reduce((n, m) => n + m[1], 0), 33);
  assert.deepEqual(p.odd('A'), []);
});

test('a render.json that is there but cannot be read now is not "nothing there" (the resume is answered: call again with the same resume)', async () => {
  const { ManifestUnreadable } = await import('../core/bim/renderParts.ts');
  const dir = mkdtempSync(join(tmpdir(), 'p6-rr-m2-'));
  assert.equal(await Parts.load(join(dir, 'gone.parts', 'render.json'), putFile, dir), null, 'nothing there');
  mkdirSync(join(dir, 'x.parts', 'render.json'), { recursive: true }); // a read that fails (EISDIR) as a lock or a scan would
  await assert.rejects(Parts.load(join(dir, 'x.parts'), putFile, dir), (e: unknown) => e instanceof ManifestUnreadable && /could not be read now/.test((e as Error).message));
  writeFileSync(join(dir, 'bad.json'), '{not json');
  assert.equal(await Parts.load(join(dir, 'bad.json'), putFile, dir), null, 'not a manifest');
});

test('images are kept by their path relative to the write root; entries outside it are ignored; an earlier version\u2019s absolute path inside the root is read as relative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6-rr-root-')), png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  mkdirSync(join(root, 'f4d'), { recursive: true });
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, 'f4d', `${n}.png`), png);
  const outside = mkdtempSync(join(tmpdir(), 'p6-rr-out-')); writeFileSync(join(outside, 'z.png'), png);
  const parts = Parts.create(join(root, 'f4d', 'x.parts'), { kind: 'images', arguments: {}, fingerprint: {}, frames_total: 6 }, putFile, root);
  parts.addImage(0, join(root, 'f4d', 'a.png'));
  assert.deepEqual(parts.m.images, [{ index: 0, file: 'f4d/a.png' }], 'the manifest holds no absolute path');
  const m = JSON.parse(readFileSync(parts.manifestPath, 'utf8'));
  m.images.push({ index: 1, file: '../../../' + basename(outside) + '/z.png' }, { index: 2, file: join(outside, 'z.png') }, { index: 3, file: join(root, 'f4d', 'b.png') });
  writeFileSync(parts.manifestPath, JSON.stringify(m));
  const l = (await Parts.load(parts.manifestPath, putFile, root))!;
  assert.deepEqual(l.m.images.map((i) => i.index), [0, 3], 'outside the root: not followed; absolute inside the root: relative');
  assert.equal(l.redrawn.filter((x) => /outside the write root/.test(x)).length, 2, 'and said, with the reason');
  assert.match(l.redrawn.join('|'), /frame 2: .*outside the write root.*drawn again/);
  assert.equal(l.m.images[1].file, 'f4d/b.png');
  // the same tree under another root is the same render
  const root2 = mkdtempSync(join(tmpdir(), 'p6-rr-root2-')); cpSync(root, root2, { recursive: true });
  const moved = (await Parts.load(join(root2, 'f4d', 'x.parts', 'render.json'), putFile, root2))!;
  assert.ok(moved.redrawn.every((x) => /outside the write root/.test(x)), 'only the tampered entries (absolute paths of the old root) are said');
  assert.equal(moved.framesDone, 1);
  assert.equal(moved.report().kept![0], join(root2, 'f4d', 'a.png'));
});

// ---- render_4d with a browser ---------------------------------------------------------------------------------------------------------
const failVideo = async (name: string, at = 3) => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-t-'));
  const args = { handle: h, path: out, kind: 'video', file_name: name, ...small };
  const back = hook({ failAtFrame: at });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  return { h, args, out, e: failed.d.error };
};

test('video: a failure late in a render keeps every whole chunk drawn; resume makes the rest and joins one video of frames_total frames', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('plan', 6);
  const data = e;
  assert.equal(e.code, 'render_failed');
  assert.equal(data.reason, 'test_failure');
  assert.ok(data.frames_done >= 6 && data.frames_done < data.frames_total, JSON.stringify(data));
  assert.ok(data.kept_segments.length >= 1 && data.kept_segments.every((p: string) => existsSync(p) && /run-\d+\.(mp4|webm)$/.test(p)), JSON.stringify(data.kept_segments)); // (a browser without H.264 records WebM)
  assert.equal(basename(dirname(data.resume)), 'plan.parts');
  assert.match(String(e.hint ?? e.message), /to continue, call render_4d again with the same arguments and resume: ".*render\.json"; a call without resume starts over/);
  assert.ok(!existsSync(join(out, 'plan.mp4')), 'no half video');
  const mf = JSON.parse(readFileSync(data.resume, 'utf8'));
  assert.equal(mf.frames_total, data.frames_total);
  assert.equal(mf.arguments.file_name, 'plan');
  assert.equal(mf.arguments.owner_key, undefined);
  assert.equal(mf.arguments.handle, undefined, 'no handle in the manifest');
  assert.ok(mf.fingerprint.model && mf.fingerprint.timeline && mf.fingerprint.width === 640);
  assert.equal(mf.fingerprint.segment_frames, undefined, 'how the video is cut is not part of what makes it');
  // every kept byte is whole: the recorded length is the file, and it reads back as the frames recorded
  for (const s of mf.segments) {
    const f = join(dirname(data.resume), s.file);
    assert.equal(statSync(f).size, s.bytes);
    assert.equal((await probeVideo(f, s.bytes)).frames, s.frames);
    assert.ok(s.config);
  }
  assert.equal(mf.segments.reduce((n: number, s: any) => n + s.frames, 0), data.frames_done);
  // the same arguments with resume: only the missing frames, one video
  let r = await call('render_4d', { ...args, resume: data.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.equal(r.d.frames, data.frames_total);
  assert.equal(r.d.resumed_frames, data.frames_done);
  assert.equal(r.d.drawn_frames, data.frames_total - data.frames_done);
  assert.ok(r.d.segments >= 2, `the kept run and the new one joined (${r.d.segments})`);
  assert.equal(r.d.redrawn, undefined, 'nothing was redrawn');
  noParts(out);
  const facts = await probeVideo(r.d.written[0]);
  assert.equal(facts.frames, data.frames_total);
  assert.ok(Math.abs(facts.duration - data.frames_total / 1) < 1e-6);
  assert.ok(facts.keyFrames >= r.d.segments && facts.firstKey && facts.ordered);
  decodes(r.d.written[0], data.frames_total);
  // and a render without a failure is one run: the same video
  const whole = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-v2-')) });
  assert.equal(whole.err, false, JSON.stringify(whole.d).slice(0, 300));
  assert.equal(whole.d.segments, 1);
  assert.equal((await probeVideo(whole.d.written[0])).frames, data.frames_total);
  noParts(dirname(whole.d.written[0]));
});

test('video: a file torn mid-chunk by a kill is cut back and resumed into one video of frames_total frames', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('torn', 6);
  const seg = e.kept_segments[e.kept_segments.length - 1] as string, size = statSync(seg).size;
  appendFileSync(seg, readFileSync(seg).subarray(-4000)); // a chunk that was being written when the process died
  assert.ok(statSync(seg).size > size);
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.ok(r.d.redrawn.some((x: string) => /cut off/.test(x)), JSON.stringify(r.d.redrawn));
  assert.equal(r.d.resumed_frames, e.frames_done, 'the whole chunks were kept');
  assert.equal(r.d.frames, e.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
  decodes(r.d.written[0], e.frames_total);
  noParts(out);
});

test('video: a resume after a change is refused (resume_mismatch says what changed; the answer carries what is kept) and removes nothing, even with a damaged run; so is one from another path', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('plan', 3);
  const resume = e.resume as string;
  assert.ok(existsSync(resume), JSON.stringify(e).slice(0, 300));
  // a run that no longer reads back, before the refusals: nothing may be removed or rewritten by them
  const seg = e.kept_segments[0] as string, size = statSync(seg).size;
  writeFileSync(seg, Buffer.alloc(size, 7));
  const manifestBefore = readFileSync(resume, 'utf8'), tree0 = tree(out).sort().join('|');
  // an option
  const step = await call('render_4d', { ...args, step: 3, resume });
  assert.equal(step.d.error.code, 'resume_mismatch', JSON.stringify(step.d).slice(0, 900));
  assert.match(step.d.error.message, /step was 2, now 3/);
  assert.equal(step.d.error.resume, resume);
  assert.match(String(step.d.error.hint), /afresh/);
  assert.match(String(step.d.error.hint), /to continue, call render_4d again with the same arguments and resume/);
  const size2 = await call('render_4d', { ...args, width: 800, height: 450, resume });
  assert.equal(size2.d.error.code, 'resume_mismatch');
  assert.match(size2.d.error.message, /width was 640, now 800/);
  // another folder
  const elsewhere = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-m2-')), resume });
  assert.equal(elsewhere.d.error.code, 'resume_mismatch');
  assert.equal((await call('render_4d', { ...args, resume: join(out, 'nothing.parts', 'render.json') })).d.error.code, 'resume_unreadable');
  assert.equal(readFileSync(resume, 'utf8'), manifestBefore, 'a refused resume leaves render.json as it was');
  assert.equal(tree(out).sort().join('|'), tree0, 'and every file');
  assert.equal(readFileSync(seg).length, size, 'the damaged run is still there');
  // the right arguments: the damaged run is drawn again and said so
  const r = await call('render_4d', { ...args, resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.ok(r.d.redrawn.some((x: string) => /run-0001/.test(x)), JSON.stringify(r.d.redrawn));
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
  noParts(out);
});

test('video: a changed link or schedule is a resume_mismatch; a render without resume replaces the kept parts and finishes', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h, owner_key } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-m3-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'plan', ...small };
  const back = hook({ failAtFrame: 3 });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  const resume = failed.d.error.resume as string;
  await call('link_by_rules', { handle: h, owner_key, rules: [{ type: 'scope', activity: 'ROOF', storey: 'Level 1', class: 'IfcDoor' }] });
  const link = await call('render_4d', { ...args, resume });
  assert.equal(link.d.error.code, 'resume_mismatch');
  assert.match(link.d.error.message, /timeline changed/);
  assert.match(String(link.d.error.hint), /afresh/);
  const fresh = await call('render_4d', args);
  assert.equal(fresh.err, false, JSON.stringify(fresh.d).slice(0, 300));
  noParts(out);
});

/** Another program holds `locked` (Windows: a delete of it, or of a folder holding it, fails EBUSY): fs.rmSync of it or of a folder above it
 *  throws as it would there, before anything is removed. The returned function lets go. */
const lockFile = (locked: string) => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const was = fs.rmSync;
  fs.rmSync = ((path: string, o?: object) => {
    const p = String(path);
    if (p === locked || locked.startsWith(p + '/') || locked.startsWith(p + '\\')) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${locked}'`), { code: 'EBUSY', errno: -4082, syscall: 'unlink', path: locked });
    return was(path, o);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  return () => { fs.rmSync = was; syncBuiltinESMExports(); };
};

test('a render without resume over parts whose render.json another program holds is answered in words: nothing lost or removed, the file named; once let go, resume continues', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('held');
  const manifest = e.resume as string, before = tree(out).sort(), text = readFileSync(manifest, 'utf8');
  const go = lockFile(manifest);
  let r;
  try { r = await call('render_4d', args); } finally { go(); }
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'parts_not_replaceable_now', JSON.stringify(r.d).slice(0, 500));
  assert.match(r.d.error.message, /cannot be replaced right now: a file in them is locked by another program \(".*held\.parts.render\.json": EBUSY/);
  assert.match(r.d.error.message, /Nothing was lost or removed\./);
  assert.match(String(r.d.error.hint), /Close the program holding ".*render\.json".*call render_4d again; or, to continue, call render_4d again with the same arguments and resume: ".*held\.parts.render\.json"/);
  assert.equal(r.d.error.locked, manifest);
  assert.deepEqual(tree(out).sort(), before, 'no file removed or added');
  assert.equal(readFileSync(manifest, 'utf8'), text, 'render.json as it was');
  const done = await call('render_4d', { ...args, resume: manifest });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal(done.d.resumed_frames, e.frames_done);
  assert.equal((await probeVideo(done.d.written[0])).frames, e.frames_total);
  noParts(out);
});

test('a render without resume over parts where a kept run is held: render.json is removed first, the answer says that render can no longer be continued, names the file; once let go, a render starts over and finishes', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('runheld');
  const run = e.kept_segments[0] as string;
  const go = lockFile(run);
  let r;
  try { r = await call('render_4d', args); } finally { go(); }
  assert.equal(r.d.error.code, 'parts_not_replaceable_now', JSON.stringify(r.d).slice(0, 500));
  assert.match(r.d.error.message, /could not all be removed right now: a file in them is locked by another program \(".*run-0001\.(mp4|webm)": EBUSY.*Their render\.json was removed, so that earlier render can no longer be continued/);
  assert.equal(r.d.error.locked, run);
  assert.ok(!existsSync(e.resume) && existsSync(run));
  const fresh = await call('render_4d', args);
  assert.equal(fresh.err, false, JSON.stringify(fresh.d).slice(0, 400));
  assert.equal((await probeVideo(fresh.d.written[0])).frames, e.frames_total);
  noParts(out);
});

test('images: each PNG is on disk the moment it is made; a failure keeps them, resume makes the rest, and nothing is left behind', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-i-'));
  const args = { handle: h, path: out, kind: 'images', file_name: 'shot', width: 640, height: 360, quality: 'standard', step: 14 };
  const back = hook({ failAtFrame: 2 });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
  const data = failed.d.error;
  assert.equal(data.frames_done, 2, JSON.stringify(failed.d).slice(0, 900));
  assert.ok(data.frames_total > 2);
  assert.equal(data.kept.length, 2);
  assert.match(String(data.hint), /to continue, call render_4d again with the same arguments and resume/);
  for (const p of data.kept) assert.equal(readFileSync(p).subarray(1, 4).toString(), 'PNG');
  assert.equal(readdirSync(out).filter((f) => f.endsWith('.png')).length, 2, 'only the finished frames');
  assert.ok(JSON.parse(readFileSync(data.resume, 'utf8')).images.every((i: { file: string }) => i.file === basename(i.file)), 'relative to the output folder (the server has no write root here)');
  const firstBytes = readFileSync(data.kept[0]);
  const r = await call('render_4d', { ...args, resume: data.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.equal(r.d.written.length, data.frames_total);
  assert.equal(r.d.resumed_frames, 2);
  assert.ok(r.d.written.every((p: string) => readFileSync(p).subarray(1, 4).toString() === 'PNG'));
  assert.deepEqual(readFileSync(r.d.written[0]), firstBytes, 'a kept frame is not drawn again');
  noParts(out);
  const other = await call('render_4d', { ...args, step: 7, resume: join(out, 'shot.parts', 'render.json') });
  assert.equal(other.d.error.code, 'resume_unreadable', 'a finished render has nothing to continue');
  // an image render that never fails is as clean
  const clean = await call('render_4d', { ...args, path: mkdtempSync(join(tmpdir(), 'p6-rr-i2-')), step: 28 });
  assert.equal(clean.err, false, JSON.stringify(clean.d).slice(0, 300));
  noParts(dirname(clean.d.written[0]));
});

test('images: the tree copied to another write root and resumed there keeps every frame (paths in render.json are relative to the write root)', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex(); // (the model is opened before the roots are set: the fixtures are outside them)
  const A = mkdtempSync(join(tmpdir(), 'p6-rr-A-')), B = mkdtempSync(join(tmpdir(), 'p6-rr-B-'));
  const args = { handle: h, path: 'f4d', kind: 'images', file_name: 'P1-4D', width: 640, height: 360, quality: 'standard', step: 14 };
  let kept: string[] = [], total = 0;
  try {
    setRoots(null, A);
    const back = hook({ failAtFrame: 2 });
    let failed;
    try { failed = await call('render_4d', args); } finally { back(); }
    assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
    const e = failed.d.error;
    total = e.frames_total; kept = e.kept;
    const mf = JSON.parse(readFileSync(e.resume, 'utf8'));
    assert.deepEqual(mf.images.map((i: { file: string }) => i.file).sort(), [0, 1].map((i) => `f4d/P1-4D-000${i}-${mf.images.find((x: any) => x.index === i).file.slice(-14, -4)}.png`), 'relative to the write root: f4d/<name>-NNNN-<date>.png');
    const bytes = kept.map((p) => readFileSync(p));
    cpSync(A, B, { recursive: true });
    setRoots(null, B);
    const r = await call('render_4d', { ...args, resume: 'f4d/P1-4D.parts/render.json' });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
    assert.equal(r.d.resumed_frames, 2, 'the kept frames are not drawn again under the other root');
    assert.equal(r.d.redrawn, undefined);
    assert.equal(r.d.written.length, total);
    assert.ok(r.d.written.every((p: string) => p.startsWith(B)));
    kept.forEach((p, i) => assert.deepEqual(readFileSync(join(B, 'f4d', basename(p))), bytes[i]));
    noParts(B);
  } finally { setRoots(null, null); }
});

test('video: the graphics card fails part-way and the processor would pick another picture; the kept frames keep theirs and the rest is drawn the same way', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-g-'));
  // (auto quality: the full model fits the limit on the graphics card, the processor's estimate does not, so a re-plan would be a 480p draft of boxes)
  const back = env({ P6CLONE_RENDER_DRAFT_MINUTES: '0.12' }), back2 = hook({ failAtFrame: 4, failCode: 'webgl_context_lost' });
  let r;
  const args = { handle: h, path: out, kind: 'video', file_name: 'gpu', step: 2, fps: 1 };
  try { r = await call('render_4d', args); } finally { back(); back2(); }
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
    // the card's runs and the processor's are joined when their decoder configurations are the same, else the card's are drawn again by
    // the processor (the encoder in use) and the answer says so
    assert.ok(r.d.segments >= 2 || (r.d.redrawn ?? []).some((x: string) => /decoder configuration/.test(x)), JSON.stringify(r.d).slice(0, 600));
    assert.deepEqual(r.d.size, [1280, 720], 'the frames kept keep their picture');
    assert.equal(r.d.drawn.geometry, 'full');
    assert.match(String(r.d.quality_note), /already made keep their picture/);
    for (const x of r.d.redrawn ?? []) assert.match(x, /decoder configuration/, 'only the encoder change drew anything again');
  }
  decodes(r.d.written[0], r.d.frames);
  noParts(out);
});

test('video as WebM (a browser without H.264): runs join as WebM, and ffmpeg makes the one MP4 of the joined video; no parts are left either way', { skip: (!CHROME && 'no Chromium here') || (!FFMPEG && 'no ffmpeg here'), timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const back = env({ P6CLONE_RECORD_WEBM: '1', P6CLONE_FFMPEG: FFMPEG });
  try {
    // WebM asked for: fails part-way, resume joins the kept WebM run and the new one
    const outW = mkdtempSync(join(tmpdir(), 'p6-rr-w-'));
    const aw = { handle: h, path: outW, kind: 'video', format: 'webm', file_name: 'w', ...small };
    const b1 = hook({ failAtFrame: 5 });
    let fw;
    try { fw = await call('render_4d', aw); } finally { b1(); }
    assert.equal(fw.err, true, JSON.stringify(fw.d).slice(0, 300));
    assert.ok(fw.d.error.kept_segments.every((p: string) => /run-\d+\.webm$/.test(p)));
    const webm = await call('render_4d', { ...aw, resume: fw.d.error.resume });
    assert.equal(webm.err, false, JSON.stringify(webm.d).slice(0, 400));
    assert.equal(webm.d.mime, 'video/webm');
    assert.ok(webm.d.segments >= 2);
    assert.equal((await probeVideo(webm.d.written[0])).frames, webm.d.frames);
    decodes(webm.d.written[0], webm.d.frames);
    noParts(outW);
    // MP4 asked for with a WebM-only browser: the joined WebM is converted
    const out = mkdtempSync(join(tmpdir(), 'p6-rr-w2-'));
    const a = { handle: h, path: out, kind: 'video', file_name: 'm', ...small };
    const b2 = hook({ failAtFrame: 5 });
    let failed;
    try { failed = await call('render_4d', a); } finally { b2(); }
    const mp4 = await call('render_4d', { ...a, resume: failed.d.error.resume });
    assert.equal(mp4.err, false, JSON.stringify(mp4.d).slice(0, 400));
    assert.equal(mp4.d.mime, 'video/mp4', JSON.stringify(mp4.d).slice(0, 900));
    assert.equal((await probeVideo(mp4.d.written[0])).frames, mp4.d.frames);
    noParts(out);
    // and without a failure, converted, clean
    const out3 = mkdtempSync(join(tmpdir(), 'p6-rr-w3-'));
    const plain = await call('render_4d', { ...a, path: out3, file_name: 'p' });
    assert.equal(plain.d.mime, 'video/mp4');
    noParts(out3);
  } finally { back(); }
});

test('a render_4d job cancelled mid-render keeps what is whole: the cancelled answer says how far it got, and resume finishes it', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-c-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'cx', width: 1280, height: 720, quality: 'standard', step: 1, fps: 1 / 60 };
  // (a frame a minute: every frame is a key frame, so each is a whole chunk of its own)
  const job = (await call('render_4d', { ...args, async: true })).d.job_id;
  assert.ok(job);
  // cancel once a chunk is whole in the manifest
  const manifest = join(out, 'cx.parts', 'render.json');
  const kept = () => { try { return JSON.parse(readFileSync(manifest, 'utf8')).segments.reduce((n: number, s: any) => n + s.frames, 0); } catch { return 0; } };
  for (let k = 0; k < 6000 && kept() < 2; k++) await new Promise((r) => setTimeout(r, 20));
  await call('cancel_job', { job_id: job });
  const view = (await call('job_status', { job_id: job, wait_seconds: 20 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 400));
  const r = view.result;
  assert.equal(r.partial, true);
  assert.equal(r.stopped, 'cancelled');
  assert.ok(r.frames_done >= 2 && r.frames_done < r.frames_total, JSON.stringify(r).slice(0, 400));
  assert.ok(r.kept_segments.length >= 1 && r.kept_segments.every((p: string) => existsSync(p)));
  assert.equal(basename(dirname(r.resume)), 'cx.parts');
  assert.match(r.note, /to continue, call render_4d again with the same arguments and resume: ".*render\.json"; a call without resume starts over/);
  const done = await call('render_4d', { ...args, resume: r.resume });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal(done.d.frames, r.frames_total);
  assert.equal(done.d.resumed_frames, r.frames_done, 'the frames kept were not drawn again');
  assert.equal(done.d.drawn_frames, r.frames_total - r.frames_done, 'only the missing frames were drawn');
  assert.equal((await probeVideo(done.d.written[0])).frames, r.frames_total);
  noParts(out);
});

test('a cancel while the runs are being joined still returns the partial result, and resume only joins', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-j-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'jn', ...small };
  const back = hook({ joinDelayMs: 6000 });
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
  // the join writes under a temporary name until it is complete and checked (a mirror skips it: a half-joined video is never offered)
  let seen: { file: string; names: string[] } | null = null;
  const back2 = hook({ onJoined: (f) => { seen = { file: f, names: readdirSync(dirname(f)) }; } });
  let done;
  try { done = await call('render_4d', { ...args, resume: r.resume }); } finally { back2(); }
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.match(basename(seen!.file), /\.p6clone-tmp$/);
  assert.deepEqual(seen!.names.filter((n) => /^joined\.(mp4|webm)$/.test(n)), [], 'no joined video under its own name before it is checked');
  assert.equal(done.d.resumed_frames, r.frames_total, 'nothing drawn again');
  assert.equal((await probeVideo(done.d.written[0])).frames, r.frames_total);
  noParts(out);
});

test('a resume while a cancelled job is still stopping is refused as render_busy naming the job; once it has stopped, the resume works', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex(), second = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-b-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'bz', ...small };
  const back = hook({ joinDelayMs: 8000 });
  let job = '', busy, view;
  try {
    job = (await call('render_4d', { ...args, async: true })).d.job_id;
    const manifest = join(out, 'bz.parts', 'render.json');
    for (let k = 0; k < 900; k++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const m = JSON.parse(readFileSync(manifest, 'utf8')); if (m.segments.reduce((n: number, s: any) => n + s.frames, 0) === m.frames_total) break; } catch { /* not yet */ }
    }
    await call('cancel_job', { job_id: job }); // answers at once; the job is in its delay and has not stopped
    const before = readFileSync(manifest, 'utf8');
    for (const extra of [{ resume: manifest }, {}]) { // a resume, and a render that would start over and replace the parts
      busy = await call('render_4d', { ...args, handle: second.h, ...extra });
      assert.equal(busy.err, true, JSON.stringify(busy.d).slice(0, 300));
      assert.equal(busy.d.error.code, 'render_busy', JSON.stringify(busy.d).slice(0, 500));
      assert.equal(busy.d.error.job_id, job);
    }
    assert.equal(readFileSync(manifest, 'utf8'), before, 'the refused calls touched nothing');
    view = (await call('job_status', { job_id: job, wait_seconds: 30 })).d;
  } finally { back(); }
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
  const done = await call('render_4d', { ...args, handle: second.h, resume: view.result.resume });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal((await probeVideo(done.d.written[0])).frames, view.result.frames_total);
  noParts(out);
});

test('an error after frames were kept (a manifest that cannot be written) carries what is kept and how to continue; the resume still works', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-e-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'ro', ...small };
  const manifest = join(out, 'ro.parts', 'render.json');
  const job = (await call('render_4d', { ...args, async: true })).d.job_id;
  const recorded = () => { try { return JSON.parse(readFileSync(manifest, 'utf8')).segments.reduce((n: number, s: any) => n + s.frames, 0); } catch { return 0; } };
  for (let k = 0; k < 6000 && recorded() < 1; k++) await new Promise((r) => setTimeout(r, 10));
  chmodSync(manifest, 0o444); // the next write of render.json is refused (Windows: the file is read-only)
  const view = (await call('job_status', { job_id: job, wait_seconds: 60 })).d;
  if (existsSync(manifest)) chmodSync(manifest, 0o666); // (a render that finished removed it)
  if (process.platform !== 'win32' && view.status === 'done') return; // (a POSIX rename over a read-only file succeeds: nothing to refuse there)
  assert.equal(view.status, 'failed', JSON.stringify(view).slice(0, 400));
  assert.equal(view.error.code, 'file_unwritable');
  assert.ok(view.error.frames_done >= 1 && view.error.frames_done < view.error.frames_total, JSON.stringify(view.error).slice(0, 500));
  assert.ok(view.error.kept_segments.length >= 1 && view.error.resume);
  assert.match(String(view.error.hint), /to continue, call render_4d again with the same arguments and resume: ".*render\.json"; a call without resume starts over/);
  const done = await call('render_4d', { ...args, resume: view.error.resume });
  assert.equal(done.err, false, JSON.stringify(done.d).slice(0, 400));
  assert.equal((await probeVideo(done.d.written[0])).frames, view.error.frames_total);
  noParts(out);
});

test('a kept run from another encoder is drawn again before the join: the answer says which and why, and the video decodes', { skip: (!CHROME && 'no Chromium here') || (!FFMPEG && 'no ffmpeg here'), timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('enc', 6);
  const seg = e.kept_segments[0] as string, manifest = JSON.parse(readFileSync(e.resume, 'utf8'));
  // the kept run as another encoder would have made it: the same frames, a decoder description that differs by a byte
  const was = (await probeVideo(seg)).config;
  const cs = await chunks(seg, false, (d) => { const c = Uint8Array.from(d); c[c.length - 1] ^= 1; return c; });
  writeFileSync(seg, Buffer.concat(cs));
  const s0 = manifest.segments.find((s: { file: string }) => s.file === basename(seg));
  s0.bytes = statSync(seg).size; s0.config = (await probeVideo(seg)).config;
  assert.notEqual(s0.config, was);
  writeFileSync(e.resume, JSON.stringify(manifest));
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.ok(r.d.redrawn.some((x: string) => /run-0001.*another encoder.*decoder configuration/.test(x)), JSON.stringify(r.d.redrawn));
  assert.equal(r.d.frames, e.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
  decodes(r.d.written[0], e.frames_total);
  noParts(out);
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
  write({ ...mf, segments: [...mf.segments, { file: '../outside.mp4', first: 0, frames: 1, bytes: 7 }, { file: 'run-0099.mp4', first: mf.frames_total - 1, frames: 50, bytes: 1 }, { ...mf.segments[0] }] });
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
  assert.ok(r.d.redrawn.length >= 2, JSON.stringify(r.d.redrawn));
  assert.equal(r.d.frames, mf.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, mf.frames_total);
});

test('a corrupt kept run is found when the manifest is read, drawn again, and the answer says so', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, e } = await failVideo('cs', 6);
  const seg = e.kept_segments[0] as string, size = statSync(seg).size;
  writeFileSync(seg, Buffer.alloc(size, 7)); // the same size, not a video
  const r = await call('render_4d', { ...args, resume: e.resume });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
  assert.equal(r.d.redrawn.length, 1, JSON.stringify(r.d.redrawn));
  assert.match(r.d.redrawn[0], /run-0001/);
  assert.equal(r.d.frames, e.frames_total);
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
  decodes(r.d.written[0], e.frames_total);
});

test('images: entries of a tampered manifest (an index out of range, a file that is not this render\u2019s) do not count as frames', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-ti-'));
  const args = { handle: h, path: out, kind: 'images', file_name: 'ti', width: 640, height: 360, quality: 'standard', step: 14 };
  const back = hook({ failAtFrame: 2 });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); }
  const e = failed.d.error, mf = JSON.parse(readFileSync(e.resume, 'utf8'));
  const stray = join(out, 'stray.png'); writeFileSync(stray, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  mf.images.push({ index: 9999, file: 'stray.png' }, { index: 2, file: 'stray.png' }, { index: -1, file: 'stray.png' });
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
  const back = env({ P6CLONE_RENDER_DRAFT_MINUTES: '0.00001' }), back2 = hook({ failAtFrame: 4 });
  let failed;
  try { failed = await call('render_4d', args); } finally { back(); back2(); }
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
  const f2 = env({ P6CLONE_RENDER_DRAFT_MINUTES: '0.00001' }), f3 = hook({ failAtFrame: 4 });
  let again;
  try { again = await call('render_4d', { ...args, file_name: 'au2' }); } finally { f2(); f3(); }
  const bad = await call('render_4d', { ...args, file_name: 'au2', width: 1280, height: 720, resume: again.d.error.resume });
  assert.equal(bad.d.error.code, 'resume_mismatch');
  assert.match(bad.d.error.message, /width was 854, now 1280/);
});

test('the resume path is compared as a path: a drive letter in another case is the same folder (Windows)', { skip: (!CHROME && 'no Chromium here') || (process.platform !== 'win32' && 'drive letters are a Windows matter'), timeout: 600_000 }, async () => {
  const { args, e } = await failVideo('dl', 4);
  const lower = (e.resume as string).replace(/^[A-Za-z]:/, (d) => d.toLowerCase());
  assert.notEqual(lower, e.resume);
  const r = await call('render_4d', { ...args, resume: lower });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 1500));
  assert.equal(r.d.resumed_frames, e.frames_done);
  assert.equal((await probeVideo(r.d.written[0])).frames, e.frames_total);
});

test('resume given with no Chromium (the client route): the answer says it was not used, and the kept parts are left as they are', async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-n-'));
  const parts = join(out, 'plan.parts'); mkdirSync(parts, { recursive: true });
  writeFileSync(join(parts, 'render.json'), '{"keep":"me"}'); writeFileSync(join(parts, 'run-0001.mp4'), 'kept');
  const back = env({ P6CLONE_CHROMIUM: undefined });
  try {
    const r = await call('render_4d', { handle: h, path: out, kind: 'video', file_name: 'plan', resume: join(parts, 'render.json'), ...small });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.rendered, false);
    assert.match(r.d.note, /resume was given, but there is no Chromium here to continue a render with/);
    assert.match(r.d.note, /plan\.parts/);
    assert.equal(readFileSync(join(parts, 'render.json'), 'utf8'), '{"keep":"me"}');
    assert.equal(readFileSync(join(parts, 'run-0001.mp4'), 'utf8'), 'kept');
    const plain = await call('render_4d', { handle: h, path: out, kind: 'video', file_name: 'plan', ...small });
    assert.doesNotMatch(plain.d.note, /resume was given/);
  } finally { back(); }
});

test('a parts folder that cannot be removed after a finished render does not make it an error: the answer says so', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const was = Parts.prototype.discard;
  Parts.prototype.discard = function () { throw new Error('EBUSY: resource busy or locked'); };
  try {
    for (const a of [{ kind: 'video', ...small }, { kind: 'images', width: 640, height: 360, quality: 'standard', step: 28 }]) {
      const out = mkdtempSync(join(tmpdir(), 'p6-rr-d-'));
      const r = await call('render_4d', { handle: h, path: out, file_name: 'dd', ...a });
      assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
      assert.equal(r.d.rendered, true);
      assert.match(r.d.note, /parts folder could not be removed: .*dd\.parts.*EBUSY/);
      assert.ok(r.d.written.every((p: string) => existsSync(p)));
    }
  } finally { Parts.prototype.discard = was; }
});

const bytesOf = (dir: string) => tree(dir).sort().map((f) => { const p = join(dir, f); return `${f}:${statSync(p).isDirectory() ? 'dir' : readFileSync(p).toString('base64')}`; }).join('|');

test('a resume refused after the manifest was read (frames_total, or the codec) changes nothing: no file cut, no render.json rewritten, no folder removed, even when every kept run was bad', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  for (const [what, edit, code] of [['frames_total', (m: any) => { m.frames_total += 1; }, /frames_total was/], ['the codec', (m: any) => { m.mime = String(m.mime).includes('mp4') ? 'video/webm' : 'video/mp4'; }, /the browser now encodes video\/\w+, the kept runs are video\/\w+/]] as const) {
    for (const bad of [false, true]) {
      const { args, out, e } = await failVideo(`rf${bad ? 'b' : 'g'}${what.slice(0, 2)}`, 4);
      const segs = e.kept_segments as string[];
      if (bad) for (const f of segs) writeFileSync(f, Buffer.alloc(statSync(f).size, 7)); // every kept run fails its check
      else appendFileSync(segs[segs.length - 1], Buffer.alloc(300, 1)); // a torn tail the resume must not cut when it is refused
      const m = JSON.parse(readFileSync(e.resume, 'utf8')); edit(m); writeFileSync(e.resume, JSON.stringify(m));
      const before = bytesOf(out);
      const r = await call('render_4d', { ...args, resume: e.resume });
      assert.equal(r.err, true, `${what} ${bad}: ${JSON.stringify(r.d).slice(0, 300)}`);
      assert.equal(r.d.error.code, 'resume_mismatch', JSON.stringify(r.d).slice(0, 400));
      assert.match(r.d.error.message, code);
      assert.equal(bytesOf(out), before, `${what}, bad runs ${bad}: every file and render.json are as they were`);
    }
  }
});

test('images: a folder that differs only in case is the same place on Windows: the kept frames are not drawn again', { skip: (!CHROME && 'no Chromium here') || (process.platform !== 'win32' && 'case-folding paths is a Windows matter'), timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const A = mkdtempSync(join(tmpdir(), 'p6-rr-C-'));
  const args = { handle: h, kind: 'images', file_name: 'P1-4D', width: 640, height: 360, quality: 'standard', step: 14 };
  try {
    setRoots(null, A);
    const back = hook({ failAtFrame: 2 });
    let failed;
    try { failed = await call('render_4d', { ...args, path: 'f4d' }); } finally { back(); }
    assert.equal(failed.err, true, JSON.stringify(failed.d).slice(0, 300));
    const r = await call('render_4d', { ...args, path: 'F4D', resume: 'F4D/P1-4D.parts/render.json' });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 500));
    assert.equal(r.d.resumed_frames, 2, 'not drawn again');
    assert.equal(r.d.redrawn, undefined);
  } finally { setRoots(null, null); }
});

test('an encoder whose new run still differs from the reference refuses the join: render_failed with the kept report, and no kept file changed', { skip: (!CHROME && 'no Chromium here') || (!FFMPEG && 'no ffmpeg here'), timeout: 600_000 }, async () => {
  // every frame kept in two runs (a cancel during the join), the newest run as another encoder would have made it: it sets the reference
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-x-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'xx', ...small };
  const manifest = join(out, 'xx.parts', 'render.json');
  const frames = () => { try { const m = JSON.parse(readFileSync(manifest, 'utf8')); return m.segments.reduce((n: number, s: any) => n + s.frames, 0) as number; } catch { return 0; } };
  const b1 = hook({ failAtFrame: 4 });
  try { await call('render_4d', args); } finally { b1(); }
  const b2 = hook({ joinDelayMs: 6000 });
  let view;
  try {
    const job = (await call('render_4d', { ...args, resume: manifest, async: true })).d.job_id;
    const total = JSON.parse(readFileSync(manifest, 'utf8')).frames_total;
    for (let k = 0; k < 900 && frames() < total; k++) await new Promise((r) => setTimeout(r, 100));
    await call('cancel_job', { job_id: job });
    view = (await call('job_status', { job_id: job, wait_seconds: 30 })).d;
  } finally { b2(); }
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
  const mf = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.ok(mf.segments.length >= 2, 'two runs hold every frame');
  const newest = mf.segments[mf.segments.length - 1], file = join(out, 'xx.parts', newest.file);
  writeFileSync(file, Buffer.concat(await chunks(file, false, (d) => { const c = Uint8Array.from(d); c[c.length - 1] ^= 1; return c; })));
  newest.bytes = statSync(file).size; newest.config = (await probeVideo(file)).config;
  writeFileSync(manifest, JSON.stringify(mf));
  const keptBytes = Object.fromEntries(mf.segments.map((s: any) => [s.file, readFileSync(join(out, 'xx.parts', s.file)).toString('base64')]));
  const r = await call('render_4d', { ...args, resume: manifest });
  assert.equal(r.err, true, JSON.stringify(r.d).slice(0, 400));
  assert.equal(r.d.error.code, 'render_failed');
  assert.equal(r.d.error.reason, 'decoder_config_differs');
  assert.ok(r.d.error.frames_done >= 1 && r.d.error.kept_segments.length >= 1 && r.d.error.resume, JSON.stringify(r.d.error).slice(0, 500));
  for (const [f, b] of Object.entries(keptBytes)) assert.equal(readFileSync(join(out, 'xx.parts', f)).toString('base64'), b, `${f} is not changed`);
  assert.ok(!existsSync(join(out, 'xx.mp4')), 'no video was made');
  // the next resume converges: the newest run (this encoder's) is the reference, the odd run's frames are drawn again, one video is made
  const total = r.d.error.frames_total as number;
  const again = await call('render_4d', { ...args, resume: manifest });
  assert.equal(again.err, false, JSON.stringify(again.d).slice(0, 400));
  assert.equal((await probeVideo(again.d.written[0])).frames, total);
  decodes(again.d.written[0], total);
  noParts(out);
});

test('a render the soft timeout turns into a job is named by that job: render_busy carries its job_id', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { config } = await import('../mcp/runtime.ts');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const { h } = await duplex(), second = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-rr-promo-'));
  const args = { handle: h, path: out, kind: 'video', file_name: 'pr', ...small };
  const was = config.softTimeoutMs, back = hook({ joinDelayMs: 8000 });
  let job = '';
  try {
    config.softTimeoutMs = 300; // (no async: the render is promoted to a job as the platform's long renders are)
    const first = toolResult((await callTool('render_4d', args)).out, false).structuredContent as any;
    config.softTimeoutMs = was;
    assert.equal(first.status, 'running', JSON.stringify(first).slice(0, 300));
    job = first.job_id;
    const busy = await call('render_4d', { ...args, handle: second.h });
    assert.equal(busy.err, true, JSON.stringify(busy.d).slice(0, 300));
    assert.equal(busy.d.error.code, 'render_busy');
    assert.equal(busy.d.error.job_id, job, JSON.stringify(busy.d.error).slice(0, 400));
  } finally { config.softTimeoutMs = was; back(); }
  await call('job_status', { job_id: job, wait_seconds: 20 });
});

test('a call the soft timeout turns into a job is that job for the tool: its progress goes to the job', { timeout: 120_000 }, async () => {
  const { config } = await import('../mcp/runtime.ts');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const np = (await call('new_project', { id: 'PROMO', start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < 60; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 3 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const was = config.softTimeoutMs;
  let job = '', progress = '';
  setRoots(null, mkdtempSync(join(tmpdir(), 'p6-rr-promo-mc-'))); // (the cancelled run keeps its iterations in the write root)
  try {
    config.softTimeoutMs = 200;
    const first = toolResult((await callTool('monte_carlo', { handle: np.handle, iterations: 20000, default_estimates: { min_pct: 90, max_pct: 125 } })).out, false).structuredContent as any;
    config.softTimeoutMs = was;
    job = first.job_id;
    assert.equal(first.status, 'running', JSON.stringify(first).slice(0, 300));
    for (let k = 0; k < 100 && !/of 20000 iterations/.test(progress); k++) { await new Promise((r) => setTimeout(r, 100)); progress = String((await call('job_status', { job_id: job })).d.progress ?? ''); }
  } finally { config.softTimeoutMs = was; if (job) await call('cancel_job', { job_id: job }); }
  assert.match(progress, /\d+ of 20000 iterations/);
  await call('job_status', { job_id: job, wait_seconds: 20 });
  setRoots(null, null);
  await call('close', { handle: np.handle, owner_key: np.owner_key, discard: true });
});

test('kept work that is only stale runs is still kept work: a refusal carries the report with stale_segments and resume, and removes nothing; a manifest change after load (frames_total) is refused the same way', { skip: !CHROME && 'no Chromium here', timeout: 600_000 }, async () => {
  const { args, out, e } = await failVideo('st', 4);
  const m = JSON.parse(readFileSync(e.resume, 'utf8'));
  for (const sgm of m.segments) sgm.stale = true; // nothing in use, everything listed
  writeFileSync(e.resume, JSON.stringify(m));
  const before = bytesOf(out);
  for (const [label, extra, edit] of [['a changed option', { step: 3 }, null], ['frames_total', {}, (x: any) => { x.frames_total += 1; }]] as const) {
    if (edit) { edit(m); writeFileSync(e.resume, JSON.stringify(m)); }
    const r = await call('render_4d', { ...args, ...extra, resume: e.resume });
    assert.equal(r.err, true, label);
    assert.equal(r.d.error.code, 'resume_mismatch', `${label}: ${JSON.stringify(r.d).slice(0, 300)}`);
    assert.equal(r.d.error.frames_done, 0);
    assert.equal(r.d.error.resume, e.resume);
    assert.equal(r.d.error.stale_segments.length, m.segments.length, label);
    assert.match(String(r.d.error.hint), /to continue, call render_4d again with the same arguments and resume/);
    if (!edit) assert.equal(bytesOf(out), before, 'nothing was changed');
  }
  assert.ok(existsSync(e.resume), 'the folder is still there');
});

test('parts folder that cannot be removed, the error path being the folder itself (Windows): the files still left in it are named, in the message, the next step and data.locked_files', () => {
  const base = mkdtempSync(join(tmpdir(), 'p6-rr-left-'));
  const dir = join(base, 'held.parts');
  mkdirSync(join(dir, 'frames'), { recursive: true });
  for (const f of ['render.json', 'run-0001.mp4', 'run-0002.mp4', join('frames', 'f-0001.png'), join('frames', 'f-0002.png')]) writeFileSync(join(dir, f), 'x');
  // as Windows does it: what can be removed goes, the folder fails with its own path in the error, the held files stay
  const held = new Set([join(dir, 'run-0002.mp4'), join(dir, 'frames', 'f-0002.png')]);
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const was = fs.rmSync;
  fs.rmSync = ((path: string, o?: object) => {
    if (String(path) !== dir) return was(path, o);
    const sweep = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) sweep(p); else if (!held.has(p)) was(p); } };
    sweep(dir);
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dir}'`), { code: 'EBUSY', errno: -4082, syscall: 'rmdir', path: dir });
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  let e: unknown;
  try { Parts.create(dir, { kind: 'video', arguments: {}, fingerprint: {}, frames_total: 3 }, () => {}, base); } catch (x) { e = x; } finally { fs.rmSync = was; syncBuiltinESMExports(); }
  assert.ok(e instanceof PartsInUse, String(e));
  assert.equal(e.whole, false); assert.equal(e.path, dir);
  assert.deepEqual(e.files, [...held].sort(), 'the files left after the failed removal');
  const a = partsNotRemovedAnswer('held', dir, e);
  assert.match(a.message, /2 files are still in it, locked by another program: ".*frames.f-0002\.png" and 1 more \(data\.locked_files lists them all\)\./);
  assert.ok(a.message.includes(`"${[...held].sort()[0]}"`) && !a.message.includes(`"${[...held].sort()[1]}"`), 'the first file left is named, the rest are counted');
  assert.match(a.message, /Their render\.json was removed, so that earlier render can no longer be continued/);
  assert.match(a.hint, /Close the program holding ".*f-0002\.png" and the 1 other file \(data\.locked_files lists them\)/);
  assert.deepEqual(a.data, { parts: dir, locked: dir, locked_files: [...held].sort() });
  // one file left: named in the next step too; a file reported (not the folder): the earlier words, no locked_files
  const one = partsNotRemovedAnswer('held', dir, new PartsInUse(dir, new Error('EBUSY'), false, [join(dir, 'run-0002.mp4')]));
  assert.match(one.message, /a file is still in it/); assert.match(one.hint, /Close the program holding ".*run-0002\.mp4"/);
  const file = partsNotRemovedAnswer('held', dir, new PartsInUse(join(dir, 'run-0001.mp4'), new Error('EBUSY'), false));
  assert.match(file.message, /a file in them is locked by another program \(".*run-0001\.mp4": EBUSY\)/);
  assert.equal(file.data.locked_files, undefined); assert.equal(file.data.locked, join(dir, 'run-0001.mp4'));
  // many files: the message is short (the first, and how many more), the list is whole in data.locked_files, whatever the count
  const many = Array.from({ length: 40 }, (_, i) => join(dir, `run-${String(i).padStart(4, '0')}.mp4`));
  const big = partsNotRemovedAnswer('held', dir, new PartsInUse(dir, new Error('EBUSY'), false, many));
  assert.match(big.message, /40 files are still in it, locked by another program: ".*run-0000\.mp4" and 39 more \(data\.locked_files lists them all\)\./);
  assert.ok(!big.message.includes('run-0001.mp4'));
  assert.deepEqual(big.data.locked_files, many); assert.match(big.hint, /and the 39 other files \(data\.locked_files lists them\)/);
  // the lister: files in every folder below, nothing for a folder that is not there
  assert.deepEqual(filesLeftIn(dir), [...held].sort());
  assert.deepEqual(filesLeftIn(join(base, 'nothing')), []);
});

test('parts folder that cannot be removed: the files left are listed whether the error path is the folder, a folder inside it (any case, or with \\?\ in front on Windows), or a held file (not listed: that file is named as before)', () => {
  const base = mkdtempSync(join(tmpdir(), 'p6-rr-sub-'));
  const dir = join(base, 'held.parts');
  mkdirSync(join(dir, 'frames'), { recursive: true });
  for (const f of ['render.json', join('frames', 'f-0001.png'), join('frames', 'f-0002.png'), 'run-0001.mp4']) writeFileSync(join(dir, f), 'x');
  const sub = join(dir, 'frames');
  // as the folder, a folder inside it, a file inside it, a place outside it, and the extended-length spellings of Windows
  assert.equal(leftFilesApply(dir, dir), true);
  assert.equal(leftFilesApply(dir, sub), true, 'a subfolder inside the .parts folder');
  assert.equal(leftFilesApply(dir, join(dir, 'run-0001.mp4')), false, 'a held file is not a folder: named as it was');
  assert.equal(leftFilesApply(dir, join(base, 'other.parts')), false);
  assert.equal(leftFilesApply(dir, join(base, 'held.parts-2')), false, 'a folder whose name only begins like it');
  assert.equal(leftFilesApply(dir, base), false, 'the folder that holds it');
  assert.equal(leftFilesApply(dir, join(sub, '..', '..', 'elsewhere')), false);
  assert.equal(leftFilesApply(dir, `\\\\?\\${dir}`), true, '\\?\\ in front of the path');
  assert.equal(leftFilesApply(dir, `\\\\?\\${sub}`), true);
  // through Parts.create: the error names the subfolder (as Windows does when a file in it is held and the folder cannot go)
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const was = fs.rmSync;
  fs.rmSync = ((path: string, o?: object) => {
    if (String(path) !== dir) return was(path, o);
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${sub}'`), { code: 'EBUSY', errno: -4082, syscall: 'rmdir', path: sub });
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  let e: unknown;
  try { Parts.create(dir, { kind: 'video', arguments: {}, fingerprint: {}, frames_total: 3 }, () => {}, base); } catch (x) { e = x; } finally { fs.rmSync = was; syncBuiltinESMExports(); }
  assert.ok(e instanceof PartsInUse, String(e));
  assert.equal(e.path, sub);
  assert.deepEqual(e.files, filesLeftIn(dir), 'the files left in the folder, though the path reported is a folder inside it');
  assert.ok(e.files.length >= 3);
  const a = partsNotRemovedAnswer('held', dir, e);
  assert.match(a.message, /the folder could not be removed .* and \d+ files are still in it/);
  assert.deepEqual(a.data.locked_files, e.files); assert.equal(a.data.locked, sub);
});
