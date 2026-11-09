// open_model stopped part-way (owner decision 2026-11-08): the chunks its meshing finished are kept in the model cache (parse.ts
// keepChunks), and the answer says so truthfully: cancelled (not "cannot read the model"), how many chunks of how many are kept, where
// (the clone's model cache, not the project), that open_model again with the same path continues from them, and that discard_kept: true
// removes them when the model will not be opened again. discard_kept removes only that model's kept chunks and opens nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FX = join(import.meta.dirname, 'fixtures', '4d', 'Duplex_A_20110907.ifc');
process.env.P6CLONE_GEOM_CHUNK_MB = '0.1'; // (Duplex cut into many chunks)

const { callTool, toolResult } = await import('../mcp/server.ts');
const { onJobChange } = await import('../mcp/runtime.ts');
const { releaseModels } = await import('../core/bim/model.ts');
const { keptChunkKey, meshEngine, productIdsOf } = await import('../core/bim/parse.ts');
const { readIndex } = await import('../core/bim/indexFile.ts');
const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => { const x = await callTool(name, args, undefined, signal); return { err: x.isError, d: toolResult(x.out, x.isError).structuredContent as any }; };

/** A project, a copy of the model and a model cache of its own. */
const setup = async (id: string) => {
  process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-okept-'));
  const file = join(mkdtempSync(join(tmpdir(), 'p6-okept-ifc-')), 'duplex.ifc');
  copyFileSync(FX, file);
  const np = (await call('new_project', { id, start: '2026-03-02' })).d;
  return { cache: process.env.P6CLONE_MODEL_CACHE, file, handle: np.handle, owner_key: np.owner_key };
};
/** The chunks kept whole in the cache: <cache>/<model>.chunks/<way>/<k>/kept.json. */
const keptOnDisk = (cache: string) => readdirSync(cache).filter((f) => f.endsWith('.chunks')).flatMap((d) => readdirSync(join(cache, d)).flatMap((w) => readdirSync(join(cache, d, w)).filter((k) => /^\d+$/.test(k) && existsSync(join(cache, d, w, k, 'kept.json'))))).length;

/** open_model (or another tool that meshes the model) as a job, its progress followed: the chunks meshed and taken in from an earlier
 *  meshing (by number), and the total. stop(k, id): told at each chunk about to be meshed (1-based); it may cancel. */
async function openJob(args: Record<string, unknown>, stop?: (k: number, id: string, ac: AbortController) => void, tool = 'open_model') {
  releaseModels(new Set()); // (a model is held in memory by its content: each open here reads the cache or the file)
  const ac = new AbortController();
  const meshed = new Set<number>(), taken = new Set<number>();
  let total = 0;
  onJobChange((id, v) => {
    const p = (v as { progress?: string } | null)?.progress ?? '';
    let m = /meshing chunk (\d+) of (\d+)/.exec(p);
    if (m) { meshed.add(Number(m[1])); total = Number(m[2]); stop?.(Number(m[1]), id, ac); }
    m = /chunk (\d+) of (\d+) kept from an earlier meshing/.exec(p);
    if (m) { taken.add(Number(m[1])); total = Number(m[2]); }
  });
  try {
    const j = await call(tool, { ...args, async: true }, ac.signal);
    assert.equal(j.err, false, JSON.stringify(j.d));
    let v: any;
    do v = (await call('job_status', { job_id: j.d.job_id, wait_seconds: 20 })).d; while (v.status === 'running');
    return { v, meshed, taken, total };
  } finally { onJobChange(null); }
}

test('open_model cancelled (cancel_job) mid-meshing: cancelled, with the chunks kept and the continue / discard words; opened again it continues from them', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT1');
  let cancelled = false;
  const stopped = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file }, (k, id) => { if (k >= 4 && !cancelled) { cancelled = true; void call('cancel_job', { job_id: id }); } });
  const n = keptOnDisk(s.cache);
  assert.ok(n >= 3 && n < stopped.total, `${n} of ${stopped.total} kept`);
  assert.equal(stopped.v.status, 'cancelled', JSON.stringify(stopped.v));
  const e = stopped.v.error;
  assert.equal(e.code, 'cancelled');
  assert.equal(e.reason, `open_model was cancelled while the model was meshed: ${n} of ${stopped.total} chunks of the model’s meshing are kept in the clone’s model cache (not in the project).`);
  assert.equal(e.next_step, `Calling open_model again with the same path, with geometry, continues from them: only the missing chunks are meshed (in chunks of their size, 0.1 MB of the IFC, when that fits the memory free then, else it is meshed from scratch and the model\u2019s geometry note says why; chunks kept by another version of the clone are not used). If you will not open this model again, discard them: open_model with path "${s.file}" and discard_kept: true.`);
  assert.equal(e.kept_chunks, n);
  assert.equal(e.chunks_total, stopped.total);
  assert.deepEqual(e.discard_with, { tool: 'open_model', path: s.file, discard_kept: true });
  // opened again: the kept chunks are taken in, only the rest is meshed; once meshed, the kept chunks go
  const again = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file });
  assert.equal(again.v.status, 'done', JSON.stringify(again.v));
  assert.equal(again.v.result.geometry, 'ok');
  assert.equal(again.taken.size, n);
  assert.equal(again.meshed.size, stopped.total - n);
  assert.equal(again.v.result.kept_chunks, undefined);
  assert.equal(keptOnDisk(s.cache), 0);
});

test('open_model discard_kept: only that model’s kept chunks are removed, nothing is opened; a later open meshes from scratch', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT2');
  // stopped at the fourth chunk (the request cancelled at that progress): three kept
  const stopped = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file }, (k, _id, ac) => { if (k === 4) ac.abort(); });
  assert.equal(stopped.v.error.code, 'cancelled');
  assert.equal(stopped.v.error.kept_chunks, 3);
  assert.equal(keptOnDisk(s.cache), 3);
  // an open without geometry keeps them, and says so
  const plain = await call('open_model', { handle: s.handle, owner_key: s.owner_key, path: s.file, geometry: false });
  assert.equal(plain.d.geometry, 'skipped');
  assert.equal(plain.d.kept_chunks, 3);
  assert.match(plain.d.kept_note, new RegExp(`^3 of ${stopped.total} chunks of the model’s meshing are kept in the clone’s model cache \\(not in the project\\)\\. Calling open_model again with the same path, with geometry, continues from them`));
  // another model's kept chunks in the same cache (another content hash)
  const mine = readdirSync(s.cache).find((f) => f.endsWith('.chunks'))!;
  const other = mine.replace(/^[0-9a-f]+/, 'f'.repeat(32));
  cpSync(join(s.cache, mine), join(s.cache, other), { recursive: true });
  // discarded, with no handle: no workspace is made, no model opened
  const d = await call('open_model', { path: s.file, discard_kept: true });
  assert.equal(d.err, false, JSON.stringify(d.d));
  assert.equal(d.d.discarded_chunks, 3);
  assert.equal(d.d.opened, false);
  assert.equal(d.d.handle, undefined, 'no model-only workspace');
  assert.match(d.d.note, /^Removed the 3 chunks of the model’s meshing kept in the clone’s model cache; a later open_model of it meshes it from scratch\./);
  assert.equal(existsSync(join(s.cache, mine)), false);
  assert.equal(existsSync(join(s.cache, other)), true, 'another model’s kept chunks stay');
  const twice = await call('open_model', { handle: s.handle, owner_key: s.owner_key, path: s.file, discard_kept: true });
  assert.equal(twice.d.discarded_chunks, 0);
  assert.match(twice.d.note, /^Nothing of this model’s meshing was kept; nothing else was touched\. The model was not opened\./);
  // a later open meshes every chunk
  const later = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file });
  assert.equal(later.v.status, 'done', JSON.stringify(later.v));
  assert.equal(later.taken.size, 0);
  assert.equal(later.meshed.size, later.total);
});

test('open_model cancelled before any chunk was meshed: cancelled, nothing kept', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT3');
  const stopped = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file }, (k, _id, ac) => { if (k === 1) ac.abort(); });
  assert.equal(stopped.v.status, 'cancelled', JSON.stringify(stopped.v));
  assert.equal(stopped.v.error.code, 'cancelled');
  assert.equal(stopped.v.error.reason, 'open_model was cancelled; nothing of the model’s meshing was kept (no chunk of it had finished).');
  assert.equal(stopped.v.error.kept_chunks, 0);
  assert.equal(keptOnDisk(s.cache), 0);
});

test('kept at one chunk size, the default now another: the model is meshed in chunks of the kept size (it fits) and they are taken in', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT4');
  const stopped = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file }, (k, _id, ac) => { if (k === 4) ac.abort(); });
  assert.equal(stopped.v.error.kept_chunks, 3);
  process.env.P6CLONE_GEOM_CHUNK_MB = '0.2'; // (the chunk size an open picks now differs from the kept one, as less or more memory free would make it)
  try {
    const again = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file });
    assert.equal(again.v.status, 'done', JSON.stringify(again.v));
    assert.equal(again.v.result.geometry, 'ok');
    assert.equal(again.total, stopped.total, 'cut as the kept chunks were');
    assert.equal(again.taken.size, 3);
    assert.equal(again.meshed.size, stopped.total - 3);
    assert.doesNotMatch(again.v.result.geometry_note ?? '', /not used/);
  } finally { process.env.P6CLONE_GEOM_CHUNK_MB = '0.1'; }
});

test('kept chunks whose size does not fit the memory free now are not used: meshed from scratch, and the geometry note says why', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT5');
  releaseModels(new Set()); // (the index read from the file into this cache)
  assert.equal((await call('open_model', { handle: s.handle, owner_key: s.owner_key, path: s.file, geometry: false })).err, false);
  const base = readdirSync(s.cache).find((f) => f.endsWith('.ndjson'))!.replace(/\.ndjson$/, '');
  // one chunk kept by this engine, for this model's products, at a size no memory budget here holds (10,000,000 MB)
  const way = join(s.cache, `${base}.chunks`, `${1e7 * 1048576}-${keptChunkKey(productIdsOf(readIndex(join(s.cache, base))))}`, '0');
  mkdirSync(way, { recursive: true });
  writeFileSync(join(way, 'kept.json'), JSON.stringify({ files: [], tiles: [], of: 2, engine: meshEngine() }));
  const o = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file });
  assert.equal(o.v.status, 'done', JSON.stringify(o.v));
  assert.equal(o.v.result.geometry, 'ok');
  assert.equal(o.taken.size, 0);
  assert.equal(o.meshed.size, o.total);
  assert.match(o.v.result.geometry_note, /the 1 chunk kept from an earlier meshing was not used: meshing in chunks of their size \(10000000 MB of the IFC\) needs about [\d,]+ MB of memory and [\d,]+ MB of the memory budget is free now, so the model was meshed from scratch/);
  assert.equal(existsSync(join(s.cache, `${base}.chunks`)), false, 'meshed: the kept chunks go');
});

test('kept chunks of this engine but of another product list are not taken, nor their chunk size: meshed as an open picks it', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT7');
  releaseModels(new Set());
  assert.equal((await call('open_model', { handle: s.handle, owner_key: s.owner_key, path: s.file, geometry: false })).err, false);
  const base = readdirSync(s.cache).find((f) => f.endsWith('.ndjson'))!.replace(/\.ndjson$/, '');
  // (a set whose key is not this model's products with this engine: its folder name says another chunkKey)
  const other = join(s.cache, `${base}.chunks`, `${1e7 * 1048576}-0123456789abcdef`, '0');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'kept.json'), JSON.stringify({ files: [], tiles: [], of: 2, engine: meshEngine() }));
  const o = await openJob({ handle: s.handle, owner_key: s.owner_key, path: s.file });
  assert.equal(o.v.status, 'done', JSON.stringify(o.v));
  assert.equal(o.taken.size, 0);
  assert.doesNotMatch(o.v.result.geometry_note ?? '', /kept from an earlier meshing/, 'the other set played no part');
});

test('render_4d meshing a model opened without geometry, cancelled part-way: cancelled, with the chunks kept and how to continue or discard', { timeout: 600_000 }, async () => {
  const s = await setup('KEPT6');
  releaseModels(new Set()); // (the index read from the file into this cache)
  assert.equal((await call('open_model', { handle: s.handle, owner_key: s.owner_key, path: s.file, geometry: false })).err, false);
  const stopped = await openJob({ handle: s.handle, path: mkdtempSync(join(tmpdir(), 'p6-okept-out-')), kind: 'viewer' }, (k, _id, ac) => { if (k === 4) ac.abort(); }, 'render_4d');
  assert.equal(stopped.v.status, 'cancelled', JSON.stringify(stopped.v));
  const e = stopped.v.error;
  assert.equal(e.code, 'cancelled');
  assert.equal(e.reason, `The call was cancelled while the model was meshed: 3 of ${stopped.total} chunks of the model’s meshing are kept in the clone’s model cache (not in the project).`);
  assert.equal(e.next_step, `Calling this tool again (or open_model with the model’s path) continues from them: only the missing chunks are meshed (in chunks of their size, 0.1 MB of the IFC, when that fits the memory free then, else it is meshed from scratch and the model’s geometry note says why; chunks kept by another version of the clone are not used). If you will not open this model again, discard them: open_model with path "${s.file}" and discard_kept: true.`);
  assert.equal(e.kept_chunks, 3);
  assert.equal(keptOnDisk(s.cache), 3);
});
