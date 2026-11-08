// 4L-13 (G10): a model past one geometry run is meshed in chunks, and each finished chunk (its fingerprints and its display tiles) is
// kept under the model cache, keyed by the model's content and the chunk size. A meshing that stops (here: cancelled at a chunk) no
// longer loses the chunks it finished: opening the model again takes them in and meshes only the rest, and the model it gives equals
// one meshed without a stop (every volume, every tile byte). Once the model is cached the kept chunks go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
    assert.deepEqual(picture(m), picture(ref.m));
    assert.equal(existsSync(join(cache, chunks[0])), false, 'once the model is cached its kept chunks go');
  });
});
