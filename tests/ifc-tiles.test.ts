// Big models end to end: the index-only path (a model whose geometry cannot be built still links and exports in
// full; what needs geometry says so), the exports streamed from the model file, the memory estimate against what a
// model really takes, old caches set aside and the model meshed again, and the viewer page's signals and errors
// (docs/4d-tiles-contract.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeIfc } from '../scripts/make-ifc.ts';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const CHROME = [process.env.P6CLONE_CHROMIUM, '/opt/pw-browsers/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find((p) => p && existsSync(p));
if (CHROME) process.env.P6CLONE_CHROMIUM = CHROME;
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const withEnv = async <T,>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v; }
};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A project with one activity per storey and class of a synthetic model, linked by rules. */
async function linked(model: string, open: Record<string, unknown> = {}) {
  const np = (await call('new_project', { id: 'BIG', start: '2027-01-04' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const om = await call('open_model', { handle: h, owner_key, path: model, ...open });
  assert.equal(om.err, false, JSON.stringify(om.d).slice(0, 400));
  const acts = om.d.storeys.flatMap((s: string, i: number) => [['C', 'IfcColumn'], ['W', 'IfcWall'], ['S', 'IfcSlab']].map(([k, cls]) => ({ id: `L${i + 1}${k}`, storey: s, cls })));
  const ops: unknown[] = acts.map((a: any) => ({ op: 'add_activity', id: a.id, name: `${a.storey} ${a.cls}`, duration_days: 5 }));
  for (let i = 1; i < acts.length; i++) ops.push({ op: 'add_relationship', pred: acts[i - 1].id, succ: acts[i].id });
  await call('edit', { handle: h, owner_key, operations: ops });
  await call('schedule', { handle: h, owner_key });
  const lr = await call('link_by_rules', { handle: h, owner_key, rules: acts.map((a: any) => ({ type: 'scope', activity: a.id, storey: a.storey, class: a.cls })) });
  assert.equal(lr.err, false, JSON.stringify(lr.d).slice(0, 400));
  return { h, owner_key, om: om.d, lr: lr.d };
}

test('index only: a model whose geometry cannot be built links, keys and exports in full (TimeLiner CSV, search sets, SYNCHRO P6 XML, IFC4 4D); what needs geometry says so', { timeout: 300_000 }, async () => {
  const f = join(tmp('p6-io-'), 'tower.ifc');
  makeIfc(f, 3000);
  await withEnv({ WHIQ_IFC_GEOM_WORKER: join(tmpdir(), 'no-such-worker.mjs') }, async () => {
    const { h, owner_key, om, lr } = await linked(f);
    assert.equal(om.geometry, 'unavailable');
    assert.equal(lr.applied.added, 3000, 'every element linked');
    assert.equal((await call('set_4d_keys', { handle: h, owner_key })).err, false);
    const out = tmp('p6-io-out-');
    for (const target of ['csv', 'navisworks', 'synchro', 'ifc4d']) {
      const r = await call('export_4d', { handle: h, owner_key, target, path: join(out, target) });
      assert.equal(r.err, false, `${target}: ${JSON.stringify(r.d).slice(0, 300)}`);
      if (target === 'navisworks') {
        assert.equal(r.d.elements_tagged, 3000);
        const names = r.d.written.map((p: string) => p.split(/[\\/]/).pop());
        assert.deepEqual(names.sort(), ['BIG-4D-sets.xml', 'README.txt', 'timeliner.csv', 'tower-4D.ifc'].sort());
        const tagged = readFileSync(r.d.written.find((p: string) => p.endsWith('.ifc')), 'latin1');
        const src = readFileSync(f, 'latin1');
        assert.ok(tagged.startsWith(src.slice(0, src.lastIndexOf('ENDSEC;'))), 'the model byte for byte, the property sets appended');
        assert.equal((tagged.match(/IFCPROPERTYSET\('[^']+',#\d+,'WHIQ_4D'/g) ?? []).length, r.d.activities);
        assert.match(tagged, /ENDSEC;\s*END-ISO-10303-21;\s*$/);
      }
      if (target === 'ifc4d') assert.equal(r.d.element_links, 3000);
    }
    // what needs geometry: refused in words, or marked absent (never a silent zero)
    const v = await call('render_4d', { handle: h, path: join(out, 'v'), kind: 'video' });
    assert.equal(v.err, true);
    assert.equal(v.d.error.code, 'no_geometry');
    const q = await call('quantities', { handle: h, group_by: 'class' });
    assert.match(q.d.derived_volume, /^unavailable: the model's geometry did not build/);
    assert.ok(q.d.groups.every((g: any) => g.volume_m3 === null));
    assert.ok(q.d.groups.some((g: any) => g.authored.NetVolume > 0), 'the authored quantities stand');
  });
});

test('the streamed packages equal the text ones (tagged IFC, IFC4 4D), byte for byte but the fresh GlobalIds', { timeout: 120_000 }, async () => {
  const { tagIfc, ifc4dText } = await import('../core/bim/exchange4d.ts');
  const { tagIfcFile, ifc4dFile } = await import('../core/bim/exchange4dFile.ts');
  const f = join(tmp('p6-st-'), 'm.ifc');
  makeIfc(f, 500);
  const items = [{ taskId: '1', key: 'A1', id: 'A1', name: 'Walls ‘north’', type: 'Construct' as const, plannedStart: '2027-01-04 08:00', plannedFinish: '2027-01-08 17:00', actualStart: '', actualFinish: '', expressIds: [150, 160, 170], guids: [] }];
  const norm = (s: string) => s.replace(/'[0-9A-Za-z_$]{22}'/g, "'G'");
  const text = readFileSync(f, 'latin1');
  const out = join(tmp('p6-st-'), 'tagged.ifc');
  const r = tagIfcFile(f, out, items);
  const t = tagIfc(text, items);
  assert.deepEqual([r.tasks, r.elements], [t.tasks, t.elements]);
  assert.equal(norm(readFileSync(out, 'latin1')), norm(t.text));
  const { applyOps } = await import('../core/project/ops.ts');
  const db = { tables: {} } as any;
  applyOps(db, [{ op: 'add_project', id: 'P', start: '2027-01-04' }, { op: 'add_activity', id: 'A1', name: 'Walls', duration_days: 5 }]);
  const pid = db.tables.PROJECT.rows[0].proj_id; items[0].taskId = db.tables.TASK.rows[0].task_id;
  const o4 = join(tmp('p6-st-'), '4d.ifc');
  const a = ifc4dFile(db, pid, f, o4, items), b = ifc4dText(db, pid, text, items);
  assert.deepEqual(a, { tasks: b.tasks, links: b.links });
  // the work schedule's creation time is the clock's: the two may be a second apart
  const clock = (s: string) => norm(s).replace(/'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'/g, "'T'");
  assert.equal(clock(readFileSync(o4, 'latin1')), clock(b.text));
});

test('the memory estimate covers what reading a model takes, without doubling it (index; index and meshing)', { timeout: 600_000 }, async () => {
  const f = join(tmp('p6-mem-'), 'm.ifc');
  makeIfc(f, 60_000);
  const { loadNeeds } = await import('../core/bim/model.ts');
  const url = (p: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', ...p.split('/'))).href);
  // a fresh process, the platform's heap; peaks of the process and of its geometry children
  const code = `
    import { readFileSync, readdirSync } from 'node:fs';
    const { loadModel } = await import(${url('core/bim/model.ts')});
    const geometry = process.argv[1] === 'mesh';
    const kids = () => { let n = 0; for (const p of readdirSync('/proc')) { if (!/^\\d+$/.test(p)) continue; try { const st = readFileSync('/proc/' + p + '/stat', 'utf8'); if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) n += Number(/VmRSS:\\s+(\\d+)/.exec(readFileSync('/proc/' + p + '/status', 'utf8'))?.[1] ?? 0) * 1024; } catch {} } return n; };
    let peak = 0; const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss + kids()); }, 20);
    const r0 = process.memoryUsage().rss;
    await loadModel(${JSON.stringify(f)}, { geometry });
    clearInterval(tick); peak = Math.max(peak, process.resourceUsage().maxRSS * 1024);
    console.log(JSON.stringify({ base: r0, peak }));`;
  for (const mode of ['index', 'mesh']) {
    if (process.platform !== 'linux') break;
    const cache = tmp('p6-mem-cache-');
    const out = JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=2048', '--input-type=module', '-e', code, mode], { encoding: 'utf8', env: { ...process.env, P6CLONE_MODEL_CACHE: cache } }).trim().split('\n').pop()!);
    const need = loadNeeds(f, { geometry: mode === 'mesh' }).total;
    const used = out.peak - out.base;
    assert.ok(need >= used, `${mode}: estimate ${Math.round(need / 1048576)} MB below the ${Math.round(used / 1048576)} MB it took`);
    assert.ok(need <= used * 1.6 + 64 * 1048576, `${mode}: estimate ${Math.round(need / 1048576)} MB far above the ${Math.round(used / 1048576)} MB it took`);
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a cache of the old format is set aside (renamed, never deleted) and the model is read and meshed again', { timeout: 300_000 }, async () => {
  const cache = tmp('p6-cache-');
  await withEnv({ P6CLONE_MODEL_CACHE: cache }, async () => {
    const { fileHash, loadModel, SUPERSEDED } = await import('../core/bim/model.ts');
    const f = join(FX, 'Duplex_A_20110907.ifc');
    const hash = await fileHash(f);
    // what format 9 wrote: the index and one GLB, named with the display settings
    writeFileSync(join(cache, `${hash}-v9-50000-1024.ndjson`), '{"elements":[]}\n');
    writeFileSync(join(cache, `${hash}-v9-50000-1024.glb`), 'glTF');
    const m = await loadModel(f);
    assert.deepEqual(readdirSync(join(cache, SUPERSEDED)).sort(), [`${hash}-v9-50000-1024.glb`, `${hash}-v9-50000-1024.ndjson`]);
    assert.ok(m.tiles && existsSync(join(m.tiles, 'manifest.json')), 'meshed again, into tiles');
    assert.ok(m.index.elements.length > 200 && m.index.elements.some((e) => e.geom));
    // the new cache read back in another process: the same index, fingerprints and tiles
    const url = JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'core', 'bim', 'model.ts')).href);
    const back = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const { loadModel } = await import(${url}); const m = await loadModel(${JSON.stringify(f)}); console.log(JSON.stringify({ n: m.index.elements.length, v: m.index.elements.reduce((s, e) => s + (e.derivedVolumeM3 ?? 0), 0), tiles: !!m.tiles, e: JSON.stringify(m.index.elements[7]) }));`], { encoding: 'utf8', env: { ...process.env, P6CLONE_MODEL_CACHE: cache } }).trim().split('\n').pop()!);
    assert.equal(back.n, m.index.elements.length);
    assert.ok(Math.abs(back.v - m.index.elements.reduce((s, e) => s + (e.derivedVolumeM3 ?? 0), 0)) < 1e-6);
    assert.equal(back.tiles, true);
    assert.equal(back.e, JSON.stringify(m.index.elements[7]), 'an element reads back the same, every field');
  });
});

test('the viewer page signals it has started before the tiles, fails in labelled words when a tile is missing or the GPU is lost, and draws boxes only when asked', { skip: !CHROME && 'no Chromium here', timeout: 300_000 }, async () => {
  const { inChromium, RenderFailed } = await import('../core/bim/headless.ts');
  const { h } = await linked(join(FX, 'Duplex_A_20110907.ifc'));
  const out = tmp('p6-sig-');
  const v = await call('render_4d', { handle: h, path: out, kind: 'viewer' });
  assert.equal(v.err, false, JSON.stringify(v.d).slice(0, 300));
  const page = v.d.written[0];
  // a tile gone: the page started, then failed naming what is missing
  const tile = v.d.written.find((p: string) => p.endsWith('tile-00000.glb'));
  const saved = readFileSync(tile);
  rmSync(tile);
  await assert.rejects(inChromium(CHROME!, page, async () => null), (e: Error) => e instanceof RenderFailed && (e as InstanceType<typeof RenderFailed>).code === 'tile_missing' && /tile-00000\.glb/.test(e.message));
  writeFileSync(tile, saved);
  // started at once, ready after the tiles; a lost context afterwards: failed, labelled, with the model's size
  const r = await inChromium(CHROME!, page, (ev) => ev(`(async () => {
    const before = window.WHIQ4D_EXPORT.started === true;
    const ok = window.WHIQ4D_EXPORT.ready();
    document.getElementById('c4d').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    await new Promise((r) => setTimeout(r, 300));
    let threw = ''; try { window.WHIQ4D_EXPORT.frame(1); } catch (e) { threw = e.message; }
    return { before, ok, status: window.WHIQ4D_EXPORT.status(), threw };
  })()`));
  const x = r as any;
  assert.equal(x.before, true);
  assert.equal(x.ok, true);
  assert.equal(x.status.state, 'failed');
  assert.equal(x.status.error.code, 'webgl_context_lost');
  assert.match(x.status.error.message, /MB of geometry in 1 tile/);
  assert.match(x.threw, /^\[webgl_context_lost\] /);
  // boxes: only when asked, and drawn
  const b = await call('render_4d', { handle: h, path: join(out, 'boxes'), kind: 'viewer', boxes: true });
  assert.equal(b.err, false, JSON.stringify(b.d).slice(0, 300));
  assert.ok(b.d.written.some((p: string) => p.endsWith('boxes.bin')));
  assert.match(readFileSync(b.d.written[0], 'utf8'), /"model":\{"boxes":/);
  assert.doesNotMatch(readFileSync(page, 'utf8'), /"boxes"/, 'the default page draws the geometry');
  const px = await inChromium(CHROME!, b.d.written[0], (ev) => ev(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 238) + Math.abs(d[k + 1] - 241) + Math.abs(d[k + 2] - 245) > 30) n++; r(n); }; i.src = window.P6C4D_API.png('2027-06-01'); })`));
  assert.ok((px as number) > 5000, `${px} pixels drawn`);
});

test('the render page of a model past the inline limit carries its tiles beside it, every file in written (the client route)', { timeout: 300_000 }, async () => {
  await withEnv({ P6CLONE_CHROMIUM: undefined, P6CLONE_EMBED_MAX_MB: '0.5' }, async () => {
    const { h } = await linked(join(FX, 'Duplex_A_20110907.ifc'));
    const out = tmp('p6-cr-');
    const r = await call('render_4d', { handle: h, path: out, kind: 'video' });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.rendered, false);
    const html = readFileSync(r.d.viewer, 'utf8');
    assert.match(html, /"model":\{"tiles":"model-[0-9a-f]{16}\/manifest\.json"\}/);
    assert.doesNotMatch(html, /<script src=/, 'the viewer script is inside the page (it is served alone)');
    assert.equal(r.d.written[0], r.d.viewer);
    for (const f of r.d.client_render.files) assert.ok(r.d.written.includes(f) && existsSync(f));
    assert.ok(r.d.client_render.files.some((f: string) => /tile-00000\.glb$/.test(f)));
    // a small model stays one self-contained page (today's platform needs nothing more)
    const small = await withEnv({ P6CLONE_EMBED_MAX_MB: undefined }, () => call('render_4d', { handle: h, path: tmp('p6-cr2-'), kind: 'video' }));
    assert.equal(small.d.written, undefined);
    assert.match(readFileSync(small.d.viewer, 'utf8'), /"model":\{"inline":/);
    assert.ok(statSync(small.d.viewer).size > 100_000);
  });
});
