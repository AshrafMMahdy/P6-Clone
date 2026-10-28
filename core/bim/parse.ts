// Ported from the White Hat IQ platform's @whiq/ifc (shared/ifc, branch 33-chat-only) so both read models the same way.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { stepIndex } from './stepIndex.ts';
import { expectedMs, watched } from './serverWatch.ts';
import { geomWorkerPath, webIfcEntry } from './runtime.ts';
import { alive as hbAlive, forgetRates, noteRate, step as hbStep, tick as hbTick } from './heartbeat.mjs';
import { heartbeatEnv, heartbeatWatcher, stuckData, stuckMessage, workerFloorMs, type StuckData, type StuckInfo } from './liveness.ts';
import { allocGeometry, geomStore, putGeometry, scaleGeometry } from './element.ts';
import { readManifest, tileBytesOf, writeTilesManifest, type TileRecord } from './tiles.ts';

export interface IfcOwner {
  author?: string;
  organization?: string;
  application?: string;
  /** ISO time of the element's owner-history stamp (export time for most exporters). */
  when?: string;
  action?: string;
}

/** Everything about an element's shape that survives a re-export, in metres. */
export interface GeomFingerprint {
  bbox: [number, number, number, number, number, number];
  centroid: [number, number, number];
  /** Signed-tetrahedra volume over the triangulated mesh, absolute, m³. */
  volume: number;
  triangles: number;
}

export interface IfcElement {
  guid: string;
  expressId: number;
  ifcClass: string;
  name: string;
  storey: string;
  material?: string;
  typeName?: string;
  /** Coarse trade grouping from class / system / structural flags. */
  discipline: 'architecture' | 'structure' | 'mep' | 'site' | 'other';
  system?: string;
  /** Authored IfcElementQuantity values, name → value (Net/Gross kept apart). */
  authored: Record<string, number>;
  /** What each authored quantity is: its kind, the IfcElementQuantity it came from, its own unit when it names one. */
  quantityInfo?: Record<string, { kind: QuantityKind; set: string; unit?: string }>;
  /** Properties typed as a measure (IfcVolumeMeasure, IfcAreaMeasure, IfcLengthMeasure...): "Pset.Prop" → kind and unit. */
  measures?: Record<string, { kind: QuantityKind; unit?: string }>;
  /** Property sets flattened to "Pset.Prop" → value; hashed for comparison, kept for the report. */
  props: Record<string, string | number | boolean>;
  psetHash: string;
  geom: GeomFingerprint | null;
  /** Derived volume in m³ (null = no/failed geometry). Same number as geom.volume, kept for takeoff callers. */
  derivedVolumeM3: number | null;
  bbox?: [number, number, number, number, number, number];
  owner?: IfcOwner;
}

export type QuantityKind = 'length' | 'area' | 'volume' | 'count' | 'weight' | 'time';

export interface IfcIndex {
  sourcePath: string;
  schema: string;
  lengthScale: number;
  lengthScaleSource: 'unit-assignment' | 'heuristic-mm' | 'assumed-m';
  elements: IfcElement[];
  storeys: string[];
  classCounts: Record<string, number>;
  geometryFailures: number;
  quantifiedElements: number;
  /** The unit of each kind of figure the project assigns (IfcUnitAssignment), e.g. {length: "m", area: "m²"}. */
  units?: Partial<Record<QuantityKind, string>>;
  /** File header: who exported it with what, when. */
  header: { application?: string; author?: string; organization?: string; timestamp?: string; project?: string };
  parsedAt: string;
  /** Patch 1 (2026-09-17): geometry runs in a child process; when it cannot finish, the index still stands. */
  geometryStatus?: 'ok' | 'skipped' | 'unavailable';
  geometryNote?: string;
  /** the geometry worker (or the chunker, the tiler) was ended as stuck: the structured facts (step, silence or bound, tried, alternatives) */
  geometryStuck?: StuckData;
  meshedElements?: number;
}

/** Raw triangulated meshes per element — no longer materialised in-process (patch 1): the geometry worker writes them to
 *  disk. Kept as a type so older callers compile; always empty. */
export type IfcMeshes = Map<number, { positions: number[]; indices: number[] }>;

/** Index format version — bump when the index shape, the parser's selection rules or the display tiles change, so
 *  caches are read again. */
export const INDEX_FORMAT = 11; // 11: no derived volume for an open mesh. 10: compact index (shared records, fingerprints in a side file), display tiles instead of one GLB. 9: quantity kinds, sets and units, measure-typed properties. 8: models past one web-ifc run meshed in chunks. 7: the length unit the project assigns. 5: property definitions are not elements; STEP comments skipped. 6: geometry in metres once (millimetre models), products split over lines, conversion-based units

export interface ParseIfcOptions {
  /** Legacy switch — mesh arrays are never returned any more; geometry itself is governed by `geometry`. */
  meshes?: boolean;
  /** Run the geometry worker (fingerprints + optional display tiles). Default true. */
  geometry?: boolean;
  /** Write the display tiles into this folder (manifest.json, tile-NNNNN.glb, elements.txt; tiles.ts). */
  tilesOut?: string;
  /** Explicit worker script path (bundles that relocate the file). */
  workerPath?: string;
  /** IFC bytes one geometry run meshes at most (default P6CLONE_GEOM_CHUNK_MB, 300 MB): the memory a run takes follows it. */
  chunkBytes?: number;
  /** Bytes per display tile (default P6CLONE_TILE_MB, 32 MB). */
  tileBytes?: number;
  /** Progress while meshing: runs done of runs. */
  onProgress?: (done: number, total: number, note: string) => void | Promise<void>;
}

/**
 * Parse one IFC into the index (+ the display tiles for callers that draw it).
 *   1. Index — streaming STEP pass, memory ∝ elements (stepIndex.ts, compact records: element.ts).
 *   2. Geometry — web-ifc in CHILD processes, one run per chunk of at most chunkBytes of the IFC (geomChunk.mjs cuts
 *      it), each run's meshes turned into display tiles by another child (geomTiles.mjs) before the next run starts:
 *      the memory meshing takes follows the chunk, not the model. A run that exhausts the WASM heap kills its child,
 *      never the server; the index is returned without that run's geometry.
 * Elements whose geometry web-ifc fails on are counted and skipped, never fatal.
 */
export async function parseIfc(absIfcPath: string, opts: ParseIfcOptions = {}): Promise<{ index: IfcIndex; meshes: IfcMeshes; tilesPath?: string }> {
  // the index is built in the server's own process: a declared section (serverWatch.ts); ticks per 1 MB read, a work bound for the pass
  // that follows the scan (size x INDEX_S_PER_MB, measured in section 6)
  const size = (() => { try { return statSync(absIfcPath).size; } catch { return 0; } })();
  const { index, productIds } = await watched('indexing the IFC (bytes read)', { what: 'The IFC indexer', tried: 'one streaming pass over the file in the server\u2019s own process', next: STUCK_NEXT, total: size, capMs: expectedMs(size, 'index') }, () => stepIndex(absIfcPath));
  const meshes: IfcMeshes = new Map();
  if (opts.geometry === false) { index.geometryStatus = 'skipped'; return { index, meshes }; }
  await meshIndex(absIfcPath, index, productIds, opts);
  return { index, meshes, ...(opts.tilesOut && index.geometryStatus === 'ok' ? { tilesPath: opts.tilesOut } : {}) };
}

/** The products' express ids in index order (an index read from the cache has no productIds of its own). */
export const productIdsOf = (index: IfcIndex): Uint32Array => Uint32Array.from(index.elements, (e) => e.expressId);

/** Geometry for an index already built: fingerprints into the index, tiles into opts.tilesOut (written beside and
 *  renamed into place: a tile folder is whole or absent). Sets geometryStatus / geometryNote / meshedElements. */
export async function meshIndex(absIfcPath: string, index: IfcIndex, productIds: Uint32Array, opts: ParseIfcOptions = {}): Promise<void> {
  await meshWith(index, opts, (outDir, tilesTmp) => buildGeometry(absIfcPath, outDir, tilesTmp, opts, index, productIds));
}

/** meshIndex with the geometry made by build: it writes runs in the geometry worker's layout (geomWorker.mjs) and
 *  takes each in with absorbRun (a Navisworks file's own meshes, nwd/native.ts). */
export async function meshWith(index: IfcIndex, opts: ParseIfcOptions, build: (outDir: string, tilesDir: string | null) => Promise<Built>): Promise<void> {
  const outDir = mkdtempSync(join(tmpdir(), 'whiq-ifcgeom-'));
  const tilesTmp = opts.tilesOut ? `${opts.tilesOut}.${process.pid}.tmp` : null;
  try {
    const store = geomStore(index);
    if (store) allocGeometry(store, index.elements.length);
    if (tilesTmp) { rmSync(tilesTmp, { recursive: true, force: true }); mkdirSync(tilesTmp, { recursive: true }); }
    const run = await build(outDir, tilesTmp);
    if (!run.ok) {
      if (store) store.rows = null;
      index.geometryStatus = 'unavailable';
      index.geometryNote = run.note;
      if (run.stuck) index.geometryStuck = run.stuck;
      index.geometryFailures = index.elements.length;
      index.meshedElements = 0;
      return;
    }
    if (index.lengthScaleSource === 'assumed-m' && run.maxAbsCoord > 2000) { index.lengthScale = 0.001; index.lengthScaleSource = 'heuristic-mm'; }
    // web-ifc already gives metres when the file declares its unit; only a model with no unit and millimetre-sized
    // coordinates (the heuristic above) needs scaling here (the tiles carry the scale for the viewer)
    const S = index.lengthScaleSource === 'heuristic-mm' ? 0.001 : 1;
    if (store) scaleGeometry(store, S);
    index.geometryFailures = run.failures;
    index.meshedElements = run.meshed;
    index.geometryStatus = 'ok';
    if (run.note) index.geometryNote = run.note;
    if (run.stuck) index.geometryStuck = run.stuck;
    if (tilesTmp && opts.tilesOut) {
      writeTilesManifest(tilesTmp, index, run.tiles, S);
      rmSync(opts.tilesOut, { recursive: true, force: true });
      // another process meshing the same model (the same content, the same cache name) may have put its tiles in place
      // first: those are the same tiles, so they stand and these go
      try { renameSync(tilesTmp, opts.tilesOut); } catch (e) { if (!readManifest(opts.tilesOut)) throw e; }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    if (tilesTmp) rmSync(tilesTmp, { recursive: true, force: true });
  }
}

// ── geometry worker ───────────────────────────────────────────────────────────────────────────────────────────
interface RunSummary { elements: number; placements: number; meshes: number; failures: number; maxAbsCoord: number; geomBytes: number; peakRssMb?: number }

// a child's own JS heap is small (typed arrays and WASM live outside it); the ceiling only keeps a runaway child from
// growing past what the machine has
const heapMb = () => Math.max(1024, Math.min(4096, Math.floor((totalmem() / 1048576) * 0.5)));
const childEnv = () => ({ ...process.env, ...heartbeatEnv(), P6CLONE_WEBIFC: webIfcEntry(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });

/** What the agent is told when the liveness watch ended a worker: the step, how long with no progress or the bound passed, what was
 *  tried, and the alternatives (owner rules 2026-10-27 and 2026-10-28: no fixed time limit). */
const STUCK_NEXT = 'open the model with geometry: false (index only: linking, sets, 4D keys and every 4D export still work), export it from the authoring tool as an NWC, NWD or IFC in smaller parts, or split the model by discipline or level';
const stuckOf = (i: StuckInfo, what: string, tried: string) => ({ note: stuckMessage(i, { what, tried, next: STUCK_NEXT }), stuck: stuckData(i, { tried, next: STUCK_NEXT }) });

/** A Node script in its own process; ok when it exits 0 and done() holds. It has no fixed time limit: it is watched (heartbeat.mjs,
 *  liveness.ts) and ended only when it shows no progress or passes its work bound. When this process is itself a worker with a
 *  heartbeat (the Navisworks reader runs the tiler), the child's step and ticks are passed on as its own: its parent then sees
 *  the work going on instead of a reader that seems idle. */
export function runNode(script: string, args: string[], done: () => boolean, what = 'A worker', tried = 'one pass of the worker over its input'): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb()}`, script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    let err = '', stuck: StuckInfo | null = null, lastStep = '', lastDone = -1, lastSince = Infinity;
    child.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
    const stop = heartbeatWatcher(child, {
      floorMs: workerFloorMs(),
      onBeat: (b) => {
        if (b.step !== lastStep) { lastStep = b.step; hbStep(b.step, { cap: b.capMs, total: b.total, expect: b.expectMs }); } else if (b.done !== lastDone || b.sinceMs < lastSince) { hbTick(); hbAlive(); }
        lastDone = b.done; lastSince = b.sinceMs;
      },
      onStuck: (i) => { stuck = i; try { child.kill(); } catch { /* gone */ } },
    });
    child.on('error', (e) => { stop(); resolve({ ok: false, note: e.message }); });
    child.on('close', (code) => { stop(); resolve(code === 0 && done() ? { ok: true } : stuck ? { ok: false, ...stuckOf(stuck, what, tried) } : { ok: false, note: `exited with code ${code}${err ? ` — ${err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}` }); });
  });
}

function workerScript(opts: ParseIfcOptions): string | null {
  // An explicit path (option, then env) is honoured as given — no silent fallback to the bundled worker.
  const explicit = opts.workerPath || process.env.WHIQ_IFC_GEOM_WORKER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return geomWorkerPath();
}

export type Run = { ok: true; note?: string } | { ok: false; note: string; stuck?: StuckData };
export type Built = { ok: true; note?: string; meshed: number; failures: number; maxAbsCoord: number; tiles: TileRecord[]; stuck?: StuckData } | { ok: false; note: string; stuck?: StuckData };

/** IFC bytes one geometry run takes on: the option, else P6CLONE_GEOM_CHUNK_MB (300). */
export const chunkBytesOf = (opts: ParseIfcOptions = {}) => Math.max(1 << 16, opts.chunkBytes ?? (Number(process.env.P6CLONE_GEOM_CHUNK_MB) || 300) * 1048576);

/** Geometry for the whole model: in one worker run when the file is no bigger than a chunk; else cut into chunks
 *  (geomChunk.mjs: each a valid IFC with a batch of products and everything they reference), each meshed on its own.
 *  After each run its meshes become tiles (geomTiles.mjs) and its fingerprints go into the index; then its files go. */
async function buildGeometry(ifc: string, outDir: string, tilesDir: string | null, opts: ParseIfcOptions, index: IfcIndex, productIds: Uint32Array): Promise<Built> {
  const target = chunkBytesOf(opts);
  const script = workerScript(opts);
  if (!script) return { ok: false, note: 'geometry worker script not found (core/bim/geomWorker.mjs, or ifc/geomWorker.mjs beside the program). The model is indexed (elements, storeys, properties, authored quantities); derived volumes and the 3D view are not available for it.' };
  const productsBin = join(outDir, 'products.bin');
  writeFileSync(productsBin, new Uint8Array(productIds.buffer, productIds.byteOffset, productIds.byteLength));
  if (tilesDir && !existsSync(join(dirname(script), 'geomTiles.mjs'))) return { ok: false, note: 'the display tiler (geomTiles.mjs beside geomWorker.mjs) is missing. The model is indexed; the 3D view is not available for it.' };
  const state = newRunState();
  forgetRates('geometry'); // this job's own rate starts here (the bound of each run is sized from the slower of it and the benchmark's)
  /** One worker run: mesh, fingerprints into the index, tiles. */
  const one = async (file: string, dir: string): Promise<Run> => {
    const t0 = Date.now();
    const r = await runGeometryWorker(file, dir, productsBin, opts, script);
    const absorbed = r.ok ? await absorbRun(dir, index, tilesDir, opts, state) : r;
    if (absorbed.ok) noteRate('geometry', Date.now() - t0, statSync(file).size); // this job's own rate: the bound of the next run is sized from the slower of it and the benchmark's
    return absorbed;
  };
  if (statSync(ifc).size <= target) {
    const r = await one(ifc, join(outDir, 'g0'));
    if (r.ok) return { ok: true, ...state };
    if (!/out of memory/.test(r.note)) return r;
    state.meshed = 0; state.failures = 0; state.tiles = [];
    if (tilesDir) for (const f of readdirSync(tilesDir)) rmSync(join(tilesDir, f), { force: true });
  }
  const chunker = join(dirname(script), 'geomChunk.mjs');
  if (!existsSync(chunker)) return { ok: false, note: 'the model is too big for one geometry run and the chunker (geomChunk.mjs beside geomWorker.mjs) is missing' };
  const cdir = join(outDir, 'chunks');
  mkdirSync(cdir, { recursive: true });
  const cut = await runNode(chunker, [ifc, cdir, productsBin, String(target)], () => existsSync(join(cdir, 'chunks.json')), 'The IFC chunker', 'one streaming pass over the IFC statements, then the chunk files written one at a time');
  if (!cut.ok) return { ok: false, note: `cutting the model into chunks failed: ${cut.note}`, ...(cut.stuck ? { stuck: cut.stuck } : {}) };
  const { chunks } = JSON.parse(readFileSync(join(cdir, 'chunks.json'), 'utf8')) as { chunks: { file: string; products: number }[] };
  const failed: string[] = [];
  for (const [k, c] of chunks.entries()) {
    await opts.onProgress?.(k, chunks.length, `meshing chunk ${k + 1} of ${chunks.length}`);
    const r = await one(c.file, join(cdir, `g${k}`));
    rmSync(c.file, { force: true });
    if (!r.ok) { failed.push(`chunk ${k + 1} (${c.products} products): ${r.note.split(' The model is indexed')[0]}`); state.failures += c.products; if (r.stuck) state.stuck ??= r.stuck; }
  }
  if (!state.meshed) return { ok: false, note: `no chunk could be meshed: ${failed.slice(0, 3).join('; ')}`, ...(state.stuck ? { stuck: state.stuck } : {}) };
  return { ok: true, ...state, note: `meshed in ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} of at most ${Math.round(target / 1048576)} MB of the IFC (the model is past one geometry run)${failed.length ? `; ${failed.length} chunk(s) failed and their elements have no geometry: ${failed.slice(0, 3).join('; ')}` : ''}` };
}

export type RunState = { meshed: number; failures: number; maxAbsCoord: number; tiles: TileRecord[]; stuck?: StuckData };
export const newRunState = (): RunState => ({ meshed: 0, failures: 0, maxAbsCoord: 0, tiles: [] });

/** A run in the geometry worker's layout (dir: geom.json, elems.meta, geoms.*, places.bin) taken in: its fingerprints
 *  into the index, its meshes into display tiles (geomTiles.mjs, in its own process), then its files go. */
export async function absorbRun(dir: string, index: IfcIndex, tilesDir: string | null, opts: ParseIfcOptions, state: RunState): Promise<Run> {
  const store = geomStore(index);
  const sum = JSON.parse(readFileSync(join(dir, 'geom.json'), 'utf8')) as RunSummary;
  const mb = readFileSync(join(dir, 'elems.meta')), rows = new Float64Array(mb.buffer, mb.byteOffset, mb.byteLength / 8);
  for (let k = 0; k + 13 <= rows.length; k += 13) {
    if (k % (13 * 4096) === 0) hbAlive(); // the fingerprints go into the index 4096 at a time: a tick (the Navisworks reader runs this)
    const o = rows[k];
    if (store) putGeometry(store, o, rows.subarray(k + 4, k + 10), rows.subarray(k + 10, k + 13), rows[k + 3], rows[k + 2]);
    else { const e = index.elements[o] as IfcElement & { geom: GeomFingerprint | null; derivedVolumeM3: number | null }; if (e) { e.geom = { bbox: [...rows.subarray(k + 4, k + 10)] as GeomFingerprint['bbox'], centroid: [...rows.subarray(k + 10, k + 13)] as GeomFingerprint['centroid'], volume: rows[k + 3], triangles: rows[k + 2] }; e.derivedVolumeM3 = Number.isNaN(rows[k + 3]) ? null : rows[k + 3]; } }
  }
  state.meshed += sum.elements; state.failures += sum.failures; state.maxAbsCoord = Math.max(state.maxAbsCoord, sum.maxAbsCoord);
  if (tilesDir) {
    const worker = workerScript(opts), tiler = worker ? join(dirname(worker), 'geomTiles.mjs') : null;
    if (!tiler || !existsSync(tiler)) return { ok: false, note: 'the display tiler (geomTiles.mjs beside geomWorker.mjs) is missing. The model is indexed; the 3D view is not available for it.' };
    const t = await runNode(tiler, [dir, tilesDir, String(state.tiles.length), String(opts.tileBytes ?? tileBytesOf()), String(Number(process.env.P6CLONE_INSTANCE_MIN) || 4)], () => existsSync(join(dir, 'tiles.json')), 'The display tiler', 'one pass over the placed meshes, a tile file written at a time');
    if (!t.ok) return { ok: false, note: `the display tiles could not be written: ${t.note}` };
    state.tiles.push(...(JSON.parse(readFileSync(join(dir, 'tiles.json'), 'utf8')) as TileRecord[]));
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function runGeometryWorker(ifc: string, outDir: string, productsBin: string, opts: ParseIfcOptions, script: string): Promise<Run> {
  return new Promise((resolve) => {
    // web-ifc's WebAssembly memory is capped at 4 GB by WebAssembly itself (a model past that keeps its index, without
    // geometry); what a run takes follows the chunk it meshes
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb()}`, script, ifc, outDir, '4', productsBin], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    let err = '', out = '', stuck: StuckInfo | null = null;
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
    // no fixed time limit: watched through its heartbeats, ended only when it stops ticking or passes its work bound (see stuckNote)
    const stop = heartbeatWatcher(child, { floorMs: workerFloorMs(), onText: (t) => { out += t; if (out.length > 4000) out = out.slice(-4000); }, onStuck: (i) => { stuck = i; try { child.kill(); } catch { /* gone */ } } });
    child.on('error', (e) => { stop(); resolve({ ok: false, note: `geometry worker could not start: ${e.message}` }); });
    child.on('close', (code, signal) => {
      stop();
      // its summary is written last: a worker that wrote it finished, even if the process then fell over on its way out
      // (Windows: a libuv assertion at exit, 0xC0000409)
      if (existsSync(join(outDir, 'geom.json'))) { try { JSON.parse(readFileSync(join(outDir, 'geom.json'), 'utf8')); resolve({ ok: true }); return; } catch { /* cut short: a failure */ } }
      const tail = (err.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || out.trim().split('\n').slice(-1)[0] || '').slice(0, 300);
      if (stuck) { const r = stuckOf(stuck, 'The geometry worker', 'web-ifc meshes every run in one pass; a model past the 4 GB WebAssembly memory is cut into chunks and each is meshed on its own'); resolve({ ok: false, note: `${r.note} The model is indexed (elements, storeys, properties, authored quantities); derived volumes and the 3D view are not available for it.`, stuck: r.stuck }); return; }
      const why = signal ? `killed (${signal})` : code === null ? 'stopped' : /Aborted|memory|allocation/i.test(tail) ? 'ran out of memory (web-ifc 4 GB WASM ceiling)' : `exited with code ${code}`;
      resolve({ ok: false, note: `geometry ${why}${tail ? ` — ${tail}` : ''}. The model is indexed (elements, storeys, properties, authored quantities); derived volumes and the 3D view are not available for it.` });
    });
  });
}
