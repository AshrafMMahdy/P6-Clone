import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  let d = toolResult(r.out, r.isError).structuredContent as any, err = r.isError;
  // past the server's soft timeout (a slow runner) the call becomes a job: follow it to its answer
  while (!err && d?.job_id && d.status === 'running' && !args.async && !/^(job_status|cancel_job)$/.test(name)) {
    const j = toolResult((await callTool('job_status', { job_id: d.job_id, wait_seconds: 20 })).out, false).structuredContent as any;
    if (j.status === 'running') continue;
    if (j.status === 'done') d = j.result; else { err = true; d = j; }
  }
  return { err, d };
};
if (!existsSync(join(import.meta.dirname, '..', 'dist-viewer', 'viewer4d.js'))) spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'build-viewer4d.mjs')]);
const CHROME = [process.env.P6CLONE_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
// the server takes its Chromium from the environment only
if (CHROME) process.env.P6CLONE_CHROMIUM = CHROME;

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

test('4D M2: simulate by date and source, compare against a baseline after a delay, element status', async () => {
  const { h, owner_key } = await duplex();
  assert.equal((await call('edit', { handle: h, owner_key, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] })).err, false);
  const sim = await call('simulate_4d', { handle: h, from: '2026-03-02', to: '2026-04-30', step: 7, by: 'storey' });
  assert.equal(sim.err, false, JSON.stringify(sim.d));
  const first = sim.d.frames[0], last = sim.d.frames.at(-1);
  assert.ok(first.counts.not_started > 0 && last.counts.complete >= first.counts.complete);
  assert.ok(sim.d.frames.some((f: any) => f.active.length > 0));
  // Level 1 walls slip 10 days: by mid-April the Level 2 slab is late against the plan
  await call('edit', { handle: h, owner_key, operations: [{ op: 'update_activity', id: 'L1W', duration_days: 20 }] });
  await call('schedule', { handle: h, owner_key });
  const cmp = await call('compare_4d', { handle: h, date: '2026-03-25', against: 'Plan' });
  assert.equal(cmp.err, false, JSON.stringify(cmp.d));
  assert.ok(cmp.d.totals.late > 0, JSON.stringify(cmp.d.totals));
  assert.ok(cmp.d.zones.some((z: any) => z.zone === 'Level 2' && z.late > 0));
  assert.equal((await call('compare_4d', { handle: h, against: 'nope' })).d.error.code, 'bad_input');
  // walkdown: two Level 1 walls installed
  const walls = (await call('list_elements', { handle: h, linked: 'L1W', limit: 2 })).d.elements.map((e: any) => e.guid);
  const st = await call('set_element_status', { handle: h, owner_key, guids: walls, status: 'installed', date: '2026-03-10', apply_percent: true });
  assert.equal(st.err, false, JSON.stringify(st.d));
  const p = st.d.activities.find((x: any) => x.activity === 'L1W');
  assert.equal(p.installed, 2);
  assert.ok(p.proposed_percent > 0 && p.proposed_percent < 100);
});

test('4D M3: viewer folder (separate model file), self-contained viewer, video and images in Chromium', async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-4d-r-'));
  const v = await call('render_4d', { handle: h, path: join(out, 'viewer') });
  assert.equal(v.err, false, JSON.stringify(v.d));
  // the page, its script, and the model's display tiles in a folder of their own beside it
  assert.deepEqual(v.d.written.map((p: string) => basename(p)), ['index.html', 'viewer4d.js', 'manifest.json', 'elements.txt', 'tile-00000.glb']);
  assert.match(readFileSync(v.d.written[0], 'utf8'), /"model":\{"tiles":"model-[0-9a-f]{16}\/manifest\.json"\}/);
  assert.equal(basename(dirname(v.d.written[2])), basename(dirname(v.d.written[4])));
  const e = await call('render_4d', { handle: h, path: join(out, 'one'), embed: true, layout: 'side_by_side', left: 'planned', right: 'best', growth: 'bottom_up' });
  assert.ok(statSync(e.d.written[0]).size > 1_000_000, 'the model is inside');
  const vid = await call('render_4d', { handle: h, path: join(out, 'video'), kind: 'video', step: 14, width: 640, height: 360 });
  assert.equal(vid.err, false, JSON.stringify(vid.d));
  if (!CHROME) { assert.equal(vid.d.rendered, false); assert.equal(vid.d.client_render.hooks, 'WHIQ4D_EXPORT'); return; }
  assert.equal(vid.d.rendered, true);
  const bytes = readFileSync(vid.d.written[0]);
  assert.ok(bytes.length > 5000 && (bytes.subarray(4, 8).toString() === 'ftyp' || bytes[0] === 0x1a), 'an MP4 (or WebM) file');
  const img = await call('render_4d', { handle: h, path: join(out, 'png'), kind: 'images', step: 28, width: 640, height: 360 });
  assert.ok(img.d.written.length >= 2 && readFileSync(img.d.written[0]).subarray(1, 4).toString() === 'PNG');
});

test('render_4d reports progress per frame and stops on cancel_job', { skip: !CHROME && 'no Chromium here', timeout: 300_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-4d-cancel-'));
  const job = (await call('render_4d', { handle: h, path: out, kind: 'video', from: '2026-03-02', to: '2029-12-31', step: 1, fps: 30, width: 640, height: 360, async: true })).d.job_id;
  assert.ok(job);
  let view = (await call('job_status', { job_id: job })).d;
  for (let k = 0; k < 600 && view.status === 'running' && !/frame \d+ of \d+/.test(String(view.progress ?? '')); k++) { await new Promise((r) => setTimeout(r, 100)); view = (await call('job_status', { job_id: job })).d; }
  assert.match(String(view.progress ?? ''), /frame \d+ of \d+/, JSON.stringify(view).slice(0, 300));
  await call('cancel_job', { job_id: job });
  view = (await call('job_status', { job_id: job, wait_seconds: 20 })).d;
  assert.equal(view.status, 'cancelled', JSON.stringify(view).slice(0, 300));
});

const FFMPEG = [process.env.P6CLONE_FFMPEG, ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map((d) => join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))].find((p) => p && existsSync(p));
test('render_4d: MP4 everywhere (a WebM recording becomes MP4 with P6CLONE_FFMPEG; without it, WebM and a note)', { skip: (!CHROME && 'no Chromium here') || (!FFMPEG && 'no ffmpeg here'), timeout: 300_000 }, async () => {
  const { h } = await duplex();
  const saved = { rec: process.env.P6CLONE_RECORD_WEBM, ff: process.env.P6CLONE_FFMPEG };
  process.env.P6CLONE_RECORD_WEBM = '1'; // as a Chromium without an H.264 encoder (Chromium for Testing) records
  try {
    process.env.P6CLONE_FFMPEG = FFMPEG!;
    const mp4 = await call('render_4d', { handle: h, path: mkdtempSync(join(tmpdir(), 'p6-4d-ff-')), kind: 'video', step: 14, width: 640, height: 360, file_name: 'progress.mp4' });
    assert.equal(mp4.err, false, JSON.stringify(mp4.d).slice(0, 300));
    assert.equal(mp4.d.mime, 'video/mp4');
    assert.equal(basename(mp4.d.written[0]), 'progress.mp4');
    assert.equal(readFileSync(mp4.d.written[0]).subarray(4, 8).toString('latin1'), 'ftyp');
    delete process.env.P6CLONE_FFMPEG;
    const webm = await call('render_4d', { handle: h, path: mkdtempSync(join(tmpdir(), 'p6-4d-ff-')), kind: 'video', step: 14, width: 640, height: 360 });
    assert.equal(webm.d.mime, 'video/webm');
    assert.match(webm.d.note, /P6CLONE_FFMPEG/);
  } finally {
    if (saved.rec == null) delete process.env.P6CLONE_RECORD_WEBM; else process.env.P6CLONE_RECORD_WEBM = saved.rec;
    if (saved.ff == null) delete process.env.P6CLONE_FFMPEG; else process.env.P6CLONE_FFMPEG = saved.ff;
  }
});

test('instanced and merged meshes draw the same building, and the same page draws the same frame again (Chromium)', { skip: !CHROME && 'no Chromium here', timeout: 300_000 }, async () => {
  const { inChromium } = await import('../core/bim/headless.ts');
  const drawn = async (instanceMin: string | undefined) => {
    const saved = { m: process.env.P6CLONE_INSTANCE_MIN, c: process.env.P6CLONE_MODEL_CACHE };
    if (instanceMin) process.env.P6CLONE_INSTANCE_MIN = instanceMin; else delete process.env.P6CLONE_INSTANCE_MIN;
    process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-inst-')); // meshed afresh
    (await import('../core/bim/model.ts')).releaseModels(new Set());
    try {
      const { h } = await duplex();
      const v = await call('render_4d', { handle: h, path: mkdtempSync(join(tmpdir(), 'p6-bv-')), kind: 'viewer', embed: true });
      // pixels of the building (not the background, nor the see-through unlinked site), when everything is built
      return { instances: v.d.display.instances, px: await inChromium(CHROME!, v.d.written[0], (ev) => ev(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 238) + Math.abs(d[k + 1] - 241) + Math.abs(d[k + 2] - 245) > 80) n++; r(n); }; i.src = window.P6C4D_API.png('2027-06-01'); })`)) as number };
    } finally {
      for (const [k, v] of [['P6CLONE_INSTANCE_MIN', saved.m], ['P6CLONE_MODEL_CACHE', saved.c]] as const) if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  };
  const inst = await drawn(undefined), again = await drawn(undefined), merged = await drawn('1000000');
  assert.ok(inst.instances > 0 && merged.instances === 0, `${inst.instances} / ${merged.instances} instances`);
  assert.ok(inst.px > 10_000, `${inst.px} pixels drawn`);
  // software rendering in threads is not bit-exact: the same frame within 1 %
  assert.ok(Math.abs(again.px - inst.px) / inst.px < 0.01, `the same frame: ${inst.px} and ${again.px}`);
  assert.ok(Math.abs(merged.px - inst.px) / inst.px < 0.02, `instanced ${inst.px}, merged ${merged.px}`);
});

test('4D video quality: auto renders a small model in full; a draft (asked, or chosen as the full one would take long) is 480p boxes, with what to tell the user', { timeout: 600_000 }, async () => {
  const { h } = await duplex();
  const out = mkdtempSync(join(tmpdir(), 'p6-4d-q-'));
  const size = (d: any) => d.size ?? [d.client_render.width, d.client_render.height];
  const auto = await call('render_4d', { handle: h, path: join(out, 'auto'), kind: 'video', step: 14 });
  assert.equal(auto.err, false, JSON.stringify(auto.d));
  assert.equal(auto.d.quality, 'standard');
  assert.equal(auto.d.quality_note, undefined);
  assert.deepEqual(size(auto.d), [1280, 720]);
  assert.ok(auto.d.estimated_minutes >= 0);
  if (CHROME) assert.ok(['gpu', 'software'].includes(auto.d.renderer.kind) && auto.d.renderer.name);
  const draft = await call('render_4d', { handle: h, path: join(out, 'draft'), kind: 'video', step: 14, quality: 'draft' });
  assert.equal(draft.d.quality, 'draft');
  assert.deepEqual(size(draft.d), [854, 480]);
  assert.equal(draft.d.display.boxes, true);
  assert.match(draft.d.quality_note, /^Draft quality, as asked: 854x480, each element drawn as a simple box.*quick preview by choice, not how their model really looks/s);
  // the full model would take longer than the limit: auto draws a draft and says why
  process.env.P6CLONE_RENDER_DRAFT_MINUTES = '0.000001';
  try {
    const long = await call('render_4d', { handle: h, path: join(out, 'long'), kind: 'video', step: 14 });
    assert.equal(long.d.quality, 'draft');
    assert.match(long.d.quality_note, /^Draft quality was chosen because the full model would take .* to render (on this server's graphics card|drawn by the processor).*quality: "standard" gives the full detail/s);
    const high = await call('render_4d', { handle: h, path: join(out, 'high'), kind: 'video', step: 14, quality: 'high' });
    assert.deepEqual(size(high.d), [1920, 1080]);
    assert.match(high.d.quality_note, /^Full detail, as asked: expect .*Tell the user it will take a while/s);
  } finally { delete process.env.P6CLONE_RENDER_DRAFT_MINUTES; }
  assert.equal((await call('render_4d', { handle: h, path: join(out, 'x'), kind: 'video', quality: 'ultra' })).d.error.code, 'bad_input');
});
