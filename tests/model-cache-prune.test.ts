// The model cache's clean (owner decision 2026-11-11, aggressive cleaning; the 24 hours is his own arbitrary choice): a cached
// model not used for more than 24 hours is deleted, one used within 24 hours stays, and there is no size limit. A model in use
// (open in memory, a Revit conversion reused, a meshing under way) counts as used: its files are touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
// every test prunes at a time of its own, an hour or more after the one before: pruneCache checks at most once an hour
let step = 0;
const clock = () => NOW + 10 * H * ++step;
const age = (p: string, hours: number, at: number) => { const t = new Date(at - hours * H); utimesSync(p, t, t); };
async function withCache<T>(fn: (dir: string, prune: (now: number) => number) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'p6c-prune-')), saved = process.env.P6CLONE_MODEL_CACHE;
  process.env.P6CLONE_MODEL_CACHE = dir;
  try { const { pruneCache } = await import('../core/bim/model.ts'); return await fn(dir, pruneCache); }
  finally { if (saved == null) delete process.env.P6CLONE_MODEL_CACHE; else process.env.P6CLONE_MODEL_CACHE = saved; rmSync(dir, { recursive: true, force: true }); }
}

test('a cached model used 23 hours ago stays, one used 25 hours ago goes; superseded/ follows the same 24 hours', async () => {
  await withCache((dir, prune) => {
    const now = clock(), f = (n: string) => join(dir, n);
    writeFileSync(f('a-v10.ndjson'), 'x'); age(f('a-v10.ndjson'), 23, now);
    writeFileSync(f('b-v10.ndjson'), 'x'); age(f('b-v10.ndjson'), 25, now);
    mkdirSync(f('c-v10.tiles')); age(f('c-v10.tiles'), 25, now);
    mkdirSync(f('superseded')); writeFileSync(f('superseded/old.glb'), 'x'); writeFileSync(f('superseded/new.glb'), 'x');
    age(f('superseded/old.glb'), 25, now); age(f('superseded/new.glb'), 23, now);
    assert.equal(prune(now), 3);
    assert.equal(existsSync(f('a-v10.ndjson')), true);
    assert.equal(existsSync(f('b-v10.ndjson')), false);
    assert.equal(existsSync(f('c-v10.tiles')), false);
    assert.equal(existsSync(f('superseded/old.glb')), false);
    assert.equal(existsSync(f('superseded/new.glb')), true);
  });
});

test('there is no size limit: a cache far over 10 GB of fresh models loses nothing (the prune really runs: an old model beside them goes)', async () => {
  await withCache((dir, prune) => {
    const now = clock();
    // 12 models of 1 GB each, as sparse files (no disk is used), all used within the last hour
    const names = Array.from({ length: 12 }, (_, i) => join(dir, `m${i}-v10.glb`));
    for (const n of names) { writeFileSync(n, ''); truncateSync(n, 1024 ** 3); age(n, 0.5, now); }
    const stale = join(dir, 'stale-v10.ndjson'); writeFileSync(stale, 'x'); age(stale, 30, now);
    assert.equal(prune(now), 1, 'the prune ran (it removed the stale model)');
    assert.equal(existsSync(stale), false);
    assert.ok(names.every((n) => existsSync(n)), 'no fresh model was removed for size');
  });
});

test('the clean runs at most once an hour', async () => {
  await withCache((dir, prune) => {
    const now = clock(), p = join(dir, 'z-v10.ndjson');
    writeFileSync(p, 'x'); age(p, 30, now);
    assert.equal(prune(now), 1);
    writeFileSync(p, 'x'); age(p, 30, now + H / 2);
    assert.equal(prune(now + H / 2), 0);
    assert.equal(existsSync(p), true);
    assert.equal(prune(now + H + 1), 1);
  });
});

const FX = join(import.meta.dirname, 'fixtures', '4d', 'Duplex_A_20110907.ifc');
test('a model open in memory is in use: opening it again (a memory hit) refreshes its files, so the clean leaves it', async () => {
  await withCache(async (dir) => {
    const { loadModel } = await import('../core/bim/model.ts');
    const ifc = join(dir, 'duplex.ifc'); copyFileSync(FX, ifc);
    await loadModel(ifc, { geometry: false });
    const index = readdirSync(dir).find((f) => f.endsWith('.ndjson'));
    assert.ok(index, 'the model is cached');
    const old = new Date(Date.now() - 30 * H); utimesSync(join(dir, index!), old, old);
    await loadModel(ifc, { geometry: false });   // served from memory
    assert.ok(Date.now() - statSync(join(dir, index!)).mtimeMs < H, 'a memory hit touched the cached files');
  });
});

test('a Revit conversion that is reused is touched (a model opened daily is not converted again every day)', async () => {
  await withCache(async (dir) => {
    const { rvtToIfc, RVT_FORMAT } = await import('../core/bim/rvt.ts');
    const { fileHash } = await import('../core/bim/model.ts');
    const rvt = join(dir, 'm.rvt'); writeFileSync(rvt, 'not a real Revit file');
    const base = join(dir, `${await fileHash(rvt)}-rvt${RVT_FORMAT}`);
    writeFileSync(`${base}.ifc`, 'ISO-10303-21;'); writeFileSync(`${base}.json`, JSON.stringify({ mode: 'test', diagnostics: {}, metadata: {} }));
    const old = new Date(Date.now() - 30 * H); for (const x of ['.ifc', '.json']) utimesSync(`${base}${x}`, old, old);
    await rvtToIfc(rvt);
    for (const x of ['.ifc', '.json']) assert.ok(Date.now() - statSync(`${base}${x}`).mtimeMs < H, `${x} touched`);
  });
});

test('an open model whose files are old is touched BEFORE the hourly prune can age it out (a memory hit two hours later keeps its files)', async () => {
  await withCache(async (dir) => {
    const { loadModel } = await import('../core/bim/model.ts');
    const ifc = join(dir, 'duplex2.ifc'); copyFileSync(FX, ifc);
    await loadModel(ifc, { geometry: false });
    const index = readdirSync(dir).find((f) => f.endsWith('.ndjson'))!;
    const old = new Date(Date.now() - 30 * H); utimesSync(join(dir, index), old, old);
    const real = Date.now;
    Date.now = () => real() + 2 * H;   // two hours later: the hourly gate is open
    try { const m = await loadModel(ifc, { geometry: false }); assert.ok(m); } finally { Date.now = real; }
    assert.equal(existsSync(join(dir, index)), true, 'the open model\'s index was not pruned');
  });
});

test('a memory hit whose files are gone is dropped and the model is loaded again', async () => {
  await withCache(async (dir) => {
    const { loadModel } = await import('../core/bim/model.ts');
    const ifc = join(dir, 'duplex3.ifc'); copyFileSync(FX, ifc);
    await loadModel(ifc, { geometry: false });
    const index = readdirSync(dir).find((f) => f.endsWith('.ndjson'))!;
    rmSync(join(dir, index), { force: true });
    await loadModel(ifc, { geometry: false });
    assert.equal(existsSync(join(dir, index)), true, 'the model was read again, its cache written anew');
  });
});

test('a model held in memory and read only through cachedModel (every 4D tool) has its files touched: they survive a 24-hour prune', async () => {
  await withCache(async (dir, prune) => {
    const { loadModel, cachedModel } = await import('../core/bim/model.ts');
    const ifc = join(dir, 'duplex4.ifc'); copyFileSync(FX, ifc);
    const m = await loadModel(ifc, { geometry: false });
    const index = readdirSync(dir).find((f) => f.endsWith('.ndjson'))!;
    const old = new Date(Date.now() - 30 * H); utimesSync(join(dir, index), old, old);
    assert.ok(cachedModel(m.hash) === m, 'a memory hit');
    assert.ok(Date.now() - statSync(join(dir, index)).mtimeMs < H, 'the memory hit touched the cached files');
    const now = Date.now() + 23 * H; assert.equal(prune(now), 0, 'a prune 23 hours on (mocked clock): the touched file is within 24 hours');
  });
});

test('a cachedModel memory hit whose tiles folder is gone is dropped (read again from the cached index, with no tiles, so the caller meshes them), never a model whose tiles are missing', async () => {
  await withCache(async (dir) => {
    const { loadModel, cachedModel } = await import('../core/bim/model.ts');
    const { readManifest } = await import('../core/bim/tiles.ts');
    const ifc = join(dir, 'duplex5.ifc'); copyFileSync(FX, ifc);
    const m = await loadModel(ifc, { geometry: true });
    assert.ok(m.tiles, 'the model was meshed');
    assert.ok(cachedModel(m.hash) === m, 'with its tiles in place the memory hit stands');
    rmSync(m.tiles!, { recursive: true, force: true });
    assert.equal(readManifest(m.tiles!), null, 'a render_4d reading the manifest now gets null (its answer is in words, not a TypeError)');
    const fresh = cachedModel(m.hash);
    assert.ok(fresh && fresh !== m && fresh.tiles === null, 'the hit was dropped: what comes back is read from the cached index, with no tiles (modelWithTiles meshes them again)');
    const again = await loadModel(ifc, { geometry: true });
    assert.ok(again.tiles && readManifest(again.tiles), 'loaded again: the tiles are rebuilt');
  });
});

test('a Revit model used daily through the 4D tools (memory hit, never re-opened) keeps its conversion: liveHit touches the .ifc and .json, so a prune 23 hours on leaves them', async () => {
  await withCache(async (dir, prune) => {
    const { loadModel, cachedModel } = await import('../core/bim/model.ts');
    const { rvtToIfc, RVT_FORMAT } = await import('../core/bim/rvt.ts');
    const { fileHash } = await import('../core/bim/model.ts');
    const ifcSrc = join(dir, 'src.ifc'); copyFileSync(FX, ifcSrc);
    const rvt = join(dir, 'm.rvt'); writeFileSync(rvt, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('not a real Revit file')]));   // an OLE header: isRevit says yes, the conversion is the stand-in beside it
    const base = join(dir, `${await fileHash(rvt)}-rvt${RVT_FORMAT}`);
    copyFileSync(FX, `${base}.ifc`); writeFileSync(`${base}.json`, JSON.stringify({ mode: 'test', diagnostics: {}, metadata: {}, confidence: null }));
    const m = await loadModel(rvt, { geometry: false });
    assert.equal(m.conversion, base, 'the model knows its conversion');
    const old = new Date(Date.now() - 30 * H); for (const x of ['.ifc', '.json']) utimesSync(`${base}${x}`, old, old);
    assert.ok(cachedModel(m.hash) === m, 'a memory hit through a 4D tool');
    for (const x of ['.ifc', '.json']) assert.ok(Date.now() - statSync(`${base}${x}`).mtimeMs < H, `${x} touched by the memory hit`);
    const now = Date.now() + 23 * H; prune(now);
    for (const x of ['.ifc', '.json']) assert.equal(existsSync(`${base}${x}`), true, `${x} survives a prune 23 hours on`);
    void rvtToIfc;
  });
});
