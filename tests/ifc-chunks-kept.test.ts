// 4L-13 (G10): a model past one geometry run is meshed in chunks, and each finished chunk (its fingerprints and its display tiles) is
// kept under the model cache, keyed by the model's content and the chunk size. A meshing that stops (here: cancelled at a chunk) no
// longer loses the chunks it finished: opening the model again takes them in and meshes only the rest, and the model it gives equals
// one meshed without a stop (every volume, every tile byte). Once the model is cached the kept chunks go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FX = join(import.meta.dirname, 'fixtures', '4d', 'Duplex_A_20110907.ifc');
const withEnv = async <T,>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v; }
};
/** What a meshed model is: each element's fingerprint and the tiles, byte for byte. */
const picture = (m: { index: { elements: { guid: string; geom: unknown; derivedVolumeM3: number | null }[]; meshedElements?: number; geometryFailures: number }; tiles: string | null }) => {
  const man = JSON.parse(readFileSync(join(m.tiles!, 'manifest.json'), 'utf8'));
  return {
    elements: m.index.elements.map((e) => [e.guid, JSON.stringify(e.geom), e.derivedVolumeM3]), meshed: m.index.meshedElements, failures: m.index.geometryFailures,
    manifest: man, tiles: man.tiles.map((t: { file: string }) => createHash('sha256').update(readFileSync(join(m.tiles!, t.file))).digest('hex')),
  };
};

test('a meshing stopped at a chunk keeps the chunks it finished: the next open meshes only the rest and gives the same model', { timeout: 600_000 }, async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const env = { P6CLONE_GEOM_CHUNK_MB: '0.1' };
  // the reference: meshed without a stop (a cache of its own)
  const ref = await withEnv({ ...env, P6CLONE_MODEL_CACHE: mkdtempSync(join(tmpdir(), 'p6-kept-ref-')) }, async () => {
    const notes: string[] = [];
    const m = await loadModel(FX, { onProgress: (_d, _t, n) => { notes.push(n); } });
    return { m, notes };
  });
  const total = ref.notes.filter((n) => /^meshing chunk/.test(n)).length;
  assert.ok(total > 5, `${total} chunks`);
  // another copy of the same model (same content, so the same cache entry), in a cache of its own; stopped at chunk 4
  const cache = mkdtempSync(join(tmpdir(), 'p6-kept-'));
  const file = join(mkdtempSync(join(tmpdir(), 'p6-kept-ifc-')), 'duplex.ifc');
  copyFileSync(FX, file);
  releaseModels(new Set()); // (the reference is not held in memory: the model is read from the cache folder or its file)
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: cache }, async () => {
    await assert.rejects(loadModel(file, { onProgress: (d) => { if (d === 3) throw Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' }); } }), /cancelled/);
    const chunks = readdirSync(cache).filter((f) => f.endsWith('.chunks'));
    assert.equal(chunks.length, 1, readdirSync(cache).join(', '));
    const keptDir = join(cache, chunks[0], readdirSync(join(cache, chunks[0]))[0]);
    assert.deepEqual(readdirSync(keptDir).sort(), ['0', '1', '2'], 'the three chunks finished before the stop are kept, whole');
    // opened again: those three are taken in, the rest meshed
    releaseModels(new Set());
    const notes: string[] = [];
    const m = await loadModel(file, { onProgress: (_d, _t, n) => { notes.push(n); } });
    assert.equal(notes.filter((n) => /kept from an earlier meshing/.test(n)).length, 3, notes.join(' | '));
    assert.equal(notes.filter((n) => /^meshing chunk/.test(n)).length, total - 3);
    assert.match(m.index.geometryNote ?? '', new RegExp(`3 of ${total} chunks kept from an earlier meshing were used; the other ${total - 3} were meshed now`));
    assert.deepEqual(picture(m), picture(ref.m));
    assert.equal(existsSync(join(cache, chunks[0])), false, 'once the model is cached its kept chunks go');
  });
});

// ---- review 4L-13 M4, L1, L2, L3 ----
const env = { P6CLONE_GEOM_CHUNK_MB: '0.1' };
let refMemo: Promise<{ picture: ReturnType<typeof picture>; total: number }> | null = null;
/** The model meshed without a stop (a cache of its own), once for these tests. */
const reference = () => (refMemo ??= (async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const notes: string[] = [];
  releaseModels(new Set()); // (a model is held in memory by its content: the one an earlier test read would be taken as it is)
  const m = await withEnv({ ...env, P6CLONE_MODEL_CACHE: mkdtempSync(join(tmpdir(), 'p6-kept-ref-')) }, () => loadModel(FX, { onProgress: (_d, _t, n) => { notes.push(n); } }));
  const out = { picture: picture(m), total: notes.filter((n) => /^meshing chunk/.test(n)).length };
  releaseModels(new Set());
  return out;
})());
/** A copy of the model in a cache of its own, its meshing stopped at the fourth chunk: the cache, the file, the kept chunks' folder. */
const stoppedAt3 = async (extra: Record<string, string | undefined> = {}) => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const cache = mkdtempSync(join(tmpdir(), 'p6-kept-'));
  const file = join(mkdtempSync(join(tmpdir(), 'p6-kept-ifc-')), 'duplex.ifc');
  copyFileSync(FX, file);
  releaseModels(new Set());
  await withEnv({ ...env, ...extra, P6CLONE_MODEL_CACHE: cache }, () => assert.rejects(loadModel(file, { onProgress: (d) => { if (d === 3) throw Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' }); } }), /cancelled/));
  const chunks = readdirSync(cache).find((f) => f.endsWith('.chunks'))!;
  const kept = join(cache, chunks, readdirSync(join(cache, chunks))[0]);
  assert.deepEqual(readdirSync(kept).sort(), ['0', '1', '2']);
  return { cache, file, chunks: join(cache, chunks), kept };
};
const meshed = (notes: string[]) => ({ kept: notes.filter((n) => /kept from an earlier meshing/.test(n)).length, meshed: notes.filter((n) => /^meshing chunk/.test(n)).length });

test('M4: an open without geometry keeps the chunks a stopped meshing kept; the next open with geometry takes them in', { timeout: 600_000 }, async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const ref = await reference();
  const s = await stoppedAt3();
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: s.cache }, async () => {
    releaseModels(new Set());
    const plain = await loadModel(s.file, { geometry: false });
    assert.equal(plain.tiles, null);
    assert.deepEqual(readdirSync(s.kept).sort(), ['0', '1', '2'], 'an open without geometry meshed nothing: the kept chunks stay');
    releaseModels(new Set());
    const notes: string[] = [];
    const m = await loadModel(s.file, { onProgress: (_d, _t, n) => { notes.push(n); } });
    assert.deepEqual(meshed(notes), { kept: 3, meshed: ref.total - 3 }, notes.join(' | '));
    assert.deepEqual(picture(m), ref.picture);
    assert.equal(existsSync(s.chunks), false, 'a pass that meshed: the kept chunks go');
  });
});

test('M4: chunks kept for one list of products are not taken by a meshing of another list', { timeout: 600_000 }, async () => {
  const { loadModel, readIndex, releaseModels } = await import('../core/bim/model.ts');
  const { meshIndex, productIdsOf } = await import('../core/bim/parse.ts');
  const s = await stoppedAt3();
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: s.cache }, async () => {
    releaseModels(new Set());
    await loadModel(s.file, { geometry: false }); // (the index, cached; the kept chunks stay)
    const index = readIndex(s.chunks.replace(/\.chunks$/, ''));
    const ids = productIdsOf(index);
    const notes: string[] = [];
    const tiles = join(mkdtempSync(join(tmpdir(), 'p6-kept-sub-')), 'tiles');
    await meshIndex(s.file, index, ids.subarray(0, Math.floor(ids.length / 2)), { keepChunks: s.chunks, tilesOut: tiles, onProgress: (_d, _t, n) => { notes.push(n); } });
    assert.equal(meshed(notes).kept, 0, notes.join(' | '));
    assert.ok(meshed(notes).meshed > 0);
  });
});

test('L1 / L2: a kept chunk damaged in place (zeros of the right length) is meshed again and named; the model equals one meshed without a stop', { timeout: 600_000 }, async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const ref = await reference();
  const s = await stoppedAt3();
  const meta = join(s.kept, '1', 'elems.meta');
  writeFileSync(meta, Buffer.alloc(readFileSync(meta).length));
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: s.cache }, async () => {
    releaseModels(new Set());
    const notes: string[] = [];
    const m = await loadModel(s.file, { onProgress: (_d, _t, n) => { notes.push(n); } });
    assert.deepEqual(meshed(notes), { kept: 2, meshed: ref.total - 2 }, notes.join(' | '));
    assert.ok(notes.includes(`meshing chunk 2 of ${ref.total} (its kept results did not check out)`), notes.join(' | '));
    assert.match(m.index.geometryNote ?? '', /1 chunk kept from an earlier meshing did not check out \(damaged, as a power loss can leave a file\) and was meshed again/);
    assert.ok((m.index.geometryNote ?? '').includes(`; 2 of ${ref.total} chunks kept from an earlier meshing were used; the other ${ref.total - 2} were meshed now; 1 chunk kept`), m.index.geometryNote ?? '');
    assert.deepEqual(picture(m), ref.picture);
  });
});

test('L3: chunks kept by another version of the engine (here: the tiler changed) are not taken', { timeout: 600_000 }, async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const ref = await reference();
  // the geometry scripts copied beside the repository's node_modules (web-ifc is found from there)
  const engine = mkdtempSync(join(import.meta.dirname, '..', '.p6-test-engine-'));
  try {
    for (const f of ['geomWorker.mjs', 'meshClosed.mjs', 'heartbeat.mjs', 'geomChunk.mjs', 'geomTiles.mjs']) copyFileSync(join(import.meta.dirname, '..', 'core', 'bim', f), join(engine, f));
    const worker = { P6CLONE_IFC_GEOM_WORKER: join(engine, 'geomWorker.mjs') };
    const s = await stoppedAt3(worker);
    appendFileSync(join(engine, 'geomTiles.mjs'), '\n// another version of the tiler\n');
    await withEnv({ ...env, ...worker, P6CLONE_MODEL_CACHE: s.cache }, async () => {
      releaseModels(new Set());
      const notes: string[] = [];
      await loadModel(s.file, { onProgress: (_d, _t, n) => { notes.push(n); } });
      assert.deepEqual(meshed(notes), { kept: 0, meshed: ref.total }, notes.join(' | '));
    });
  } finally { rmSync(engine, { recursive: true, force: true }); }
});

test('a cancelled retry of a model whose meshing failed does not use up the retry: the next open meshes it, from the chunks kept', { timeout: 600_000 }, async () => {
  const { loadModel, releaseModels } = await import('../core/bim/model.ts');
  const ref = await reference();
  const cache = mkdtempSync(join(tmpdir(), 'p6-kept-retry-'));
  const file = join(mkdtempSync(join(tmpdir(), 'p6-kept-ifc-')), 'duplex.ifc');
  copyFileSync(FX, file);
  // its meshing fails (no geometry worker): indexed, geometry unavailable, cached so
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: cache, WHIQ_IFC_GEOM_WORKER: join(tmpdir(), 'no-such-worker.mjs') }, async () => {
    releaseModels(new Set());
    assert.equal((await loadModel(file)).index.geometryStatus, 'unavailable');
  });
  await withEnv({ ...env, P6CLONE_MODEL_CACHE: cache }, async () => {
    // the one retry of this run, cancelled at the fourth chunk
    releaseModels(new Set());
    await assert.rejects(loadModel(file, { onProgress: (d) => { if (d === 3) throw Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' }); } }), /cancelled/);
    // a cancel is not a failure: the next open retries, taking in the three chunks kept
    releaseModels(new Set());
    const notes: string[] = [];
    const m = await loadModel(file, { onProgress: (_d, _t, n) => { notes.push(n); } });
    assert.equal(m.index.geometryStatus, 'ok', m.index.geometryNote ?? '');
    assert.deepEqual(meshed(notes), { kept: 3, meshed: ref.total - 3 }, notes.join(' | '));
    assert.deepEqual(picture(m), ref.picture);
    assert.ok((m.index.geometryNote ?? '').includes(`; 3 of ${ref.total} chunks kept from an earlier meshing were used; the other ${ref.total - 3} were meshed now`), m.index.geometryNote ?? '');
  });
});
