// Ported from the White Hat IQ platform's @whiq/ifc (shared/ifc, branch 33-chat-only) so both read models the same way.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { stepIndex } from './stepIndex.ts';
import { geomWorkerPath, loadWebIfc, webIfcEntry } from './runtime.ts';

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
  meshedElements?: number;
}

/** Raw triangulated meshes per element — no longer materialised in-process (patch 1): the geometry worker writes the
 *  GLB directly. Kept as a type so older callers compile; always empty. */
export type IfcMeshes = Map<number, { positions: number[]; indices: number[] }>;

/** Index format version — bump when the index shape or the parser's selection rules change, so caches re-parse. */
export const INDEX_FORMAT = 9; // 9: quantity kinds, sets and units, measure-typed properties. 8: models past one web-ifc run meshed in chunks. 7: the length unit the project assigns. 5: property definitions are not elements; STEP comments skipped. 6: geometry in metres once (millimetre models), products split over lines, conversion-based units

export interface ParseIfcOptions {
  /** Legacy switch — mesh arrays are never returned any more; geometry itself is governed by `geometry`. */
  meshes?: boolean;
  /** Run the geometry worker (fingerprints + optional GLB). Default true. */
  geometry?: boolean;
  /** Write the viewer GLB here (positions scaled to metres, one node per element with GUID extras). */
  glbOut?: string;
  /** Geometry worker wall-clock budget. Default 30 minutes. */
  timeoutMs?: number;
  /** Explicit worker script path (bundles that relocate the file). */
  workerPath?: string;
}

/**
 * Parse one IFC into the index (+ GLB for callers that build a viewer).
 *   1. Index — streaming STEP pass, memory ∝ elements (stepIndex.ts).
 *   2. Geometry — web-ifc in a CHILD process (geomWorker.mjs), MEMORY_LIMIT 4 GB, meshes streamed to disk; a model
 *      that exhausts the WASM heap kills the child, never the server, and the index is returned without geometry.
 * Elements whose geometry web-ifc fails on are counted and skipped, never fatal.
 */
export async function parseIfc(absIfcPath: string, opts: ParseIfcOptions = {}): Promise<{ index: IfcIndex; meshes: IfcMeshes; glbPath?: string }> {
  const { index, products } = await stepIndex(absIfcPath);
  await canonicaliseClassNames(index);
  const meshes: IfcMeshes = new Map();
  if (opts.geometry === false) { index.geometryStatus = 'skipped'; return { index, meshes }; }

  const outDir = mkdtempSync(join(tmpdir(), 'whiq-ifcgeom-'));
  try {
    const run = await buildGeometry(absIfcPath, outDir, opts, products);
    if (!run.ok) {
      index.geometryStatus = 'unavailable';
      index.geometryNote = run.note;
      index.geometryFailures = index.elements.length;
      if (opts.glbOut) writeEmptyGlb(opts.glbOut);
      return { index, meshes, ...(opts.glbOut ? { glbPath: opts.glbOut } : {}) };
    }
    const summary = JSON.parse(readFileSync(join(outDir, 'geom.json'), 'utf8')) as GeomSummary;
    const metaBuf = readFileSync(join(outDir, 'geom.meta'));
    const meta = new Float64Array(metaBuf.buffer, metaBuf.byteOffset, metaBuf.byteLength / 8);
    const STRIDE = summary.stride || 16;
    if (index.lengthScaleSource === 'assumed-m' && summary.maxAbsCoord > 2000) { index.lengthScale = 0.001; index.lengthScaleSource = 'heuristic-mm'; }
    // web-ifc already gives metres when the file declares its unit; only a model with no unit and millimetre-sized
    // coordinates (the heuristic above) needs scaling here
    const S = index.lengthScaleSource === 'heuristic-mm' ? 0.001 : 1;
    const byId = new Map(index.elements.map((e) => [e.expressId, e]));
    for (let r = 0; r + STRIDE <= meta.length; r += STRIDE) {
      const e = byId.get(meta[r]);
      if (!e) continue;
      const fp: GeomFingerprint = {
        bbox: [meta[r + 7] * S, meta[r + 8] * S, meta[r + 9] * S, meta[r + 10] * S, meta[r + 11] * S, meta[r + 12] * S],
        centroid: [meta[r + 13] * S, meta[r + 14] * S, meta[r + 15] * S],
        volume: meta[r + 5] * S ** 3, triangles: meta[r + 6],
      };
      e.geom = fp; e.derivedVolumeM3 = fp.volume; e.bbox = fp.bbox;
    }
    index.geometryFailures = summary.failures;
    index.meshedElements = summary.views;
    index.geometryStatus = 'ok';
    if (run.note) index.geometryNote = run.note;
    if (opts.glbOut) {
      const boxes = writeGlb(opts.glbOut, join(outDir, 'geom.bin'), meta, STRIDE, summary, index, products, S);
      if (boxes) index.geometryNote = `${index.geometryNote ? `${index.geometryNote}; ` : ''}the display model draws its ${boxes} most detailed elements as boxes, to stay within P6CLONE_VIEW_MAX_MB (quantities use the full geometry)`;
      return { index, meshes, glbPath: opts.glbOut };
    }
    return { index, meshes };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ── class names: the STEP text says IFCSLAB, web-ifc (and every consumer, cache and diff) says IfcSlab ──────────
let classNames: Map<string, string> | null = null;
async function canonicaliseClassNames(index: IfcIndex): Promise<void> {
  if (!classNames) {
    const map = new Map<string, string>();
    try {
      const WebIFC: any = await loadWebIfc();
      const api = new WebIFC.IfcAPI();
      await api.Init();
      for (const k of Object.keys(WebIFC)) {
        if (!/^IFC[A-Z0-9]+$/.test(k) || typeof WebIFC[k] !== 'number') continue;
        try { const n = api.GetNameFromTypeCode(WebIFC[k]); if (typeof n === 'string' && n) map.set(k, n); } catch { /* not a type code */ }
      }
    } catch { /* web-ifc missing: keep STEP casing */ }
    classNames = map;
  }
  const map = classNames;
  const fix = (c: string) => map.get(c) ?? c;
  for (const e of index.elements) e.ifcClass = fix(e.ifcClass);
  const counts: Record<string, number> = {};
  for (const [k, n] of Object.entries(index.classCounts)) counts[fix(k)] = (counts[fix(k)] ?? 0) + n;
  index.classCounts = counts;
}

// ── geometry worker ───────────────────────────────────────────────────────────────────────────────────────────
interface GeomSummary { views: number; maxAbsCoord: number; failures: number; binBytes: number; stride?: number }

const heapMb = () => Math.max(4096, Math.floor((totalmem() / 1048576) * 0.6));
const childEnv = () => ({ ...process.env, P6CLONE_WEBIFC: webIfcEntry(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });

/** A Node script in its own process; ok when it exits 0 and done() holds. */
function runNode(script: string, args: string[], timeoutMs: number, done: () => boolean): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb()}`, script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    let err = '';
    child.stdout.resume();
    child.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, note: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && done() ? { ok: true } : { ok: false, note: `exited with code ${code}${err ? ` — ${err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}` }); });
  });
}

function workerScript(opts: ParseIfcOptions): string | null {
  // An explicit path (option, then env) is honoured as given — no silent fallback to the bundled worker.
  const explicit = opts.workerPath || process.env.WHIQ_IFC_GEOM_WORKER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return geomWorkerPath();
}

type Run = { ok: true; note?: string } | { ok: false; note: string };

/** Geometry for the whole model: in one worker run when it fits web-ifc's 4 GB WebAssembly memory; a model bigger than
 *  P6CLONE_GEOM_CHUNK_MB (300), or one whose single run ran out of memory, is cut into chunks (geomChunk.mjs: each a
 *  valid IFC with a batch of products and everything they reference), each chunk meshed on its own, and the meshes
 *  merged into one geom.bin / geom.meta / geom.json, as a single run writes them. */
async function buildGeometry(ifc: string, outDir: string, opts: ParseIfcOptions, products: Map<number, unknown>): Promise<Run> {
  const target = (Number(process.env.P6CLONE_GEOM_CHUNK_MB) || 300) * 1048576;
  if (statSync(ifc).size <= target) {
    const one = await runGeometryWorker(ifc, outDir, opts);
    if (one.ok || !/out of memory/.test(one.note)) return one;
  }
  const script = workerScript(opts), chunker = script ? join(dirname(script), 'geomChunk.mjs') : null;
  if (!chunker || !existsSync(chunker)) return { ok: false, note: 'the model is too big for one geometry run and the chunker (geomChunk.mjs beside geomWorker.mjs) is missing' };
  const cdir = join(outDir, 'chunks');
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'products.json'), JSON.stringify([...products.keys()]));
  const cut = await runNode(chunker, [ifc, cdir, join(cdir, 'products.json'), String(target)], opts.timeoutMs ?? 60 * 60_000, () => existsSync(join(cdir, 'chunks.json')));
  if (!cut.ok) return { ok: false, note: `cutting the model into chunks failed: ${cut.note}` };
  const { chunks } = JSON.parse(readFileSync(join(cdir, 'chunks.json'), 'utf8')) as { chunks: { file: string; products: number }[] };
  // merge: the chunks' bins one after the other (4-byte aligned), their meta rows with offsets moved, each element once
  const bin = openSync(join(outDir, 'geom.bin'), 'w'), metaOut = openSync(join(outDir, 'geom.meta'), 'w');
  const seen = new Set<number>(), failed: string[] = [];
  let at = 0, views = 0, failures = 0, maxAbsCoord = 0, stride = 16;
  try {
    for (const [k, c] of chunks.entries()) {
      const dir = join(cdir, `g${k}`);
      const r = await runGeometryWorker(c.file, dir, opts);
      rmSync(c.file, { force: true });
      if (!r.ok) { failed.push(`chunk ${k + 1} (${c.products} products): ${r.note.split(' The model is indexed')[0]}`); failures += c.products; continue; }
      const sum = JSON.parse(readFileSync(join(dir, 'geom.json'), 'utf8')) as GeomSummary;
      stride = sum.stride || 16;
      const mb = readFileSync(join(dir, 'geom.meta')), meta = new Float64Array(mb.buffer, mb.byteOffset, mb.byteLength / 8);
      const pad = (4 - (at % 4)) % 4;
      if (pad) { writeSync(bin, Buffer.alloc(pad)); at += pad; }
      const src = openSync(join(dir, 'geom.bin'), 'r');
      try { const b = Buffer.alloc(8 << 20); for (let pos = 0, n; (n = readSync(src, b, 0, b.length, pos)) > 0; pos += n) writeSync(bin, b, 0, n); } finally { closeSync(src); }
      for (let r0 = 0; r0 + stride <= meta.length; r0 += stride) {
        if (seen.has(meta[r0])) continue;
        seen.add(meta[r0]);
        const row = meta.slice(r0, r0 + stride); row[1] += at; row[3] += at;
        writeSync(metaOut, new Uint8Array(row.buffer)); views++;
      }
      at += sum.binBytes; failures += sum.failures; maxAbsCoord = Math.max(maxAbsCoord, sum.maxAbsCoord);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally { closeSync(bin); closeSync(metaOut); }
  if (!views) return { ok: false, note: `no chunk could be meshed: ${failed.slice(0, 3).join('; ')}` };
  writeFileSync(join(outDir, 'geom.json'), JSON.stringify({ views, maxAbsCoord, failures, binBytes: at, stride }));
  return { ok: true, note: `meshed in ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} (the model is past one web-ifc run)${failed.length ? `; ${failed.length} chunk(s) failed and their elements have no geometry: ${failed.slice(0, 3).join('; ')}` : ''}` };
}

function runGeometryWorker(ifc: string, outDir: string, opts: ParseIfcOptions): Promise<Run> {
  const script = workerScript(opts);
  if (!script) return Promise.resolve({ ok: false, note: 'geometry worker script not found (core/bim/geomWorker.mjs, or ifc/geomWorker.mjs beside the program)' });
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  return new Promise((resolve) => {
    // no size limit of our own: the worker's heap scales with the machine (60% of its memory, at least 4 GB); web-ifc's
    // WebAssembly memory is capped at 4 GB by WebAssembly itself (a model past that keeps its index, without geometry)
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb()}`, script, ifc, outDir, '4'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    let err = '', out = '';
    child.stdout.on('data', (d) => { out += String(d); if (out.length > 4000) out = out.slice(-4000); });
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, note: `geometry worker could not start: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(join(outDir, 'geom.json'))) { resolve({ ok: true }); return; }
      const tail = (err.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || out.trim().split('\n').slice(-1)[0] || '').slice(0, 300);
      const why = signal ? `stopped (${signal}) after ${Math.round(timeoutMs / 60000)} min` : code === null ? 'stopped' : /Aborted|memory|allocation/i.test(tail) ? 'ran out of memory (web-ifc 4 GB WASM ceiling)' : `exited with code ${code}`;
      resolve({ ok: false, note: `geometry ${why}${tail ? ` — ${tail}` : ''}. The model is indexed (elements, storeys, properties, authored quantities); derived volumes and the 3D view are not available for it.` });
    });
  });
}

// ── GLB assembly: header + JSON + the meshes (positions scaled to metres), boxes past the display budget ──
function writeGlb(glbOut: string, binPath: string, meta: Float64Array, STRIDE: number, summary: GeomSummary, index: IfcIndex, products: Map<number, { guid: string; ifcClass: string }>, S: number): number {
  // The display model. Up to P6CLONE_VIEW_BATCH (50,000) elements each element is its own node; past that, elements
  // are merged into batches (by storey, up to 2 million vertices each), with every element's vertex range in the
  // node's extras ([guid, first vertex, vertex count, ...]): the viewer colours each element by vertex colour, so a
  // model of millions of elements loads in a browser (a node per element would not: millions of draw calls, and an
  // index too long for one string). Past P6CLONE_VIEW_MAX_MB (1024; a GLB cannot pass 4 GB, and a browser or GPU gives
  // out well before) the most detailed elements are drawn as their bounding boxes, the heaviest first, until it fits.
  // Returns how many were boxed.
  const budget = Math.min(4000, Number(process.env.P6CLONE_VIEW_MAX_MB) || 1024) * 1048576;
  const batchAt = Number(process.env.P6CLONE_VIEW_BATCH) || 50_000;
  const BOX_V = 8, BOX_I = 36;
  const rows: number[] = [];
  for (let r = 0; r + STRIDE <= meta.length; r += STRIDE) rows.push(r);
  const full = (r: number) => meta[r + 2] * 12 + meta[r + 4] * 4;
  let total = rows.reduce((n, r) => n + full(r), 0);
  const boxed = new Set<number>();
  if (total > budget) for (const r of [...rows].sort((x, y) => full(y) - full(x))) { if (total <= budget || full(r) <= BOX_V * 12 + BOX_I * 4) break; boxed.add(r); total -= full(r) - (BOX_V * 12 + BOX_I * 4); }
  const nv = (r: number) => (boxed.has(r) ? BOX_V : meta[r + 2]), ni = (r: number) => (boxed.has(r) ? BOX_I : meta[r + 4]);
  const byId = byIdOf(index);
  const who = (r: number) => { const e = byId.get(meta[r]), p = products.get(meta[r]); return { guid: e?.guid ?? p?.guid ?? String(meta[r]), ifcClass: e?.ifcClass ?? p?.ifcClass ?? '', storey: e?.storey ?? '' }; };
  // the batches: one row each, or rows merged by storey
  const batches: number[][] = [];
  if (rows.length <= batchAt) for (const r of rows) batches.push([r]);
  else {
    const byStorey = new Map<string, number[]>();
    for (const r of rows) { const k = who(r).storey; (byStorey.get(k) ?? byStorey.set(k, []).get(k)!).push(r); }
    for (const list of byStorey.values()) { let cur: number[] = [], v = 0; for (const r of list) { if (cur.length && v + nv(r) > 2_000_000) { batches.push(cur); cur = []; v = 0; } cur.push(r); v += nv(r); } if (cur.length) batches.push(cur); }
  }
  const bufferViews: any[] = []; const accessors: any[] = []; const meshes: any[] = []; const nodes: any[] = [];
  let at = 0;
  for (const list of batches) {
    let v = 0, i = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const ranges: (string | number)[] = [];
    for (const r of list) {
      ranges.push(who(r).guid, v, nv(r));
      v += nv(r); i += ni(r);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], meta[r + 7 + k] * S); hi[k] = Math.max(hi[k], meta[r + 10 + k] * S); }
    }
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: v * 12, target: 34962 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: v, type: 'VEC3', min: lo, max: hi });
    bufferViews.push({ buffer: 0, byteOffset: at + v * 12, byteLength: i * 4, target: 34963 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5125, count: i, type: 'SCALAR' });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] });
    if (list.length === 1) { const w = who(list[0]); nodes.push({ mesh: meshes.length - 1, name: w.guid, extras: { ...w, ...(boxed.has(list[0]) ? { box: true } : {}) } }); }
    else nodes.push({ mesh: meshes.length - 1, name: `batch ${nodes.length + 1}`, extras: { storey: who(list[0]).storey, batch: ranges } });
    at += v * 12 + i * 4;
  }
  const binLen = at; const binPad = (4 - (binLen % 4)) % 4;
  const gltf = { asset: { version: '2.0', generator: 'whiq-bim v2 (web-ifc worker, streamed)' }, scene: 0, scenes: [{ nodes: nodes.map((_, k) => k) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: binLen + binPad }] };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) json = Buffer.concat([json, Buffer.from(' '.repeat(jsonPad))]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binLen + binPad, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(binLen + binPad, 0); binHead.writeUInt32LE(0x004e4942, 4);
  const out = openSync(glbOut, 'w');
  const src = openSync(binPath, 'r');
  const read = (pos: number, bytes: number) => { const b = Buffer.allocUnsafe(bytes); for (let got = 0, k; got < bytes; got += k) { k = readSync(src, b, got, bytes - got, pos + got); if (k <= 0) break; } return b; };
  try {
    writeSync(out, header); writeSync(out, jsonHead); writeSync(out, json); writeSync(out, binHead);
    for (const list of batches) {
      // positions (scaled to metres when the model is not in metres), then indices rebased to the batch
      for (const r of list) {
        if (boxed.has(r)) {
          const [x0, y0, z0, x1, y1, z1] = [7, 8, 9, 10, 11, 12].map((k) => meta[r + k] * S);
          writeSync(out, new Uint8Array(new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]).buffer));
          continue;
        }
        const b = read(meta[r + 1], meta[r + 2] * 12);
        if (S !== 1) { const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4); for (let k = 0; k < f.length; k++) f[k] *= S; }
        writeSync(out, b);
      }
      let base = 0;
      for (const r of list) {
        if (boxed.has(r)) writeSync(out, new Uint8Array(new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7].map((x) => x + base)).buffer));
        else {
          const b = read(meta[r + 3], meta[r + 4] * 4);
          if (base) { const u = new Uint32Array(b.buffer, b.byteOffset, b.length / 4); for (let k = 0; k < u.length; k++) u[k] += base; }
          writeSync(out, b);
        }
        base += nv(r);
      }
    }
    if (binPad) writeSync(out, Buffer.alloc(binPad));
  } finally { closeSync(src); closeSync(out); }
  void summary;
  return boxed.size;
}
const byIdCache = new WeakMap<IfcIndex, Map<number, IfcElement>>();
const byIdOf = (index: IfcIndex) => byIdCache.get(index) ?? byIdCache.set(index, new Map(index.elements.map((e) => [e.expressId, e]))).get(index)!;

function writeEmptyGlb(glbOut: string): void {
  const gltf = { asset: { version: '2.0', generator: 'whiq-bim v2 (no geometry)' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8'); const pad = (4 - (json.length % 4)) % 4; if (pad) json = Buffer.concat([json, Buffer.from(' '.repeat(pad))]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  writeFileSync(glbOut, Buffer.concat([header, jsonHead, json]));
}
