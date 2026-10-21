// Ported from the White Hat IQ platform's @whiq/ifc (shared/ifc, branch 33-chat-only) so both read models the same way.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Property sets flattened to "Pset.Prop" → value; hashed for comparison, kept for the report. */
  props: Record<string, string | number | boolean>;
  psetHash: string;
  geom: GeomFingerprint | null;
  /** Derived volume in m³ (null = no/failed geometry). Same number as geom.volume, kept for takeoff callers. */
  derivedVolumeM3: number | null;
  bbox?: [number, number, number, number, number, number];
  owner?: IfcOwner;
}

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
export const INDEX_FORMAT = 6; // 5: property definitions are not elements; STEP comments skipped. 6: geometry in metres once (millimetre models), products split over lines, conversion-based units

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
    const run = await runGeometryWorker(absIfcPath, outDir, opts);
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
    if (opts.glbOut) { writeGlb(opts.glbOut, join(outDir, 'geom.bin'), meta, STRIDE, summary, index, products, S); return { index, meshes, glbPath: opts.glbOut }; }
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

function workerScript(opts: ParseIfcOptions): string | null {
  // An explicit path (option, then env) is honoured as given — no silent fallback to the bundled worker.
  const explicit = opts.workerPath || process.env.WHIQ_IFC_GEOM_WORKER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return geomWorkerPath();
}

function runGeometryWorker(ifc: string, outDir: string, opts: ParseIfcOptions): Promise<{ ok: true } | { ok: false; note: string }> {
  const script = workerScript(opts);
  if (!script) return Promise.resolve({ ok: false, note: 'geometry worker script not found (core/bim/geomWorker.mjs, or ifc/geomWorker.mjs beside the program)' });
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', script, ifc, outDir, '4'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, P6CLONE_WEBIFC: webIfcEntry(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
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

// ── GLB assembly: header + JSON + the worker's bin streamed through (positions scaled to metres) ───────────────
function writeGlb(glbOut: string, binPath: string, meta: Float64Array, STRIDE: number, summary: GeomSummary, index: IfcIndex, products: Map<number, { guid: string; ifcClass: string }>, S: number): void {
  const byId = new Map(index.elements.map((e) => [e.expressId, e]));
  const bufferViews: any[] = []; const accessors: any[] = []; const meshes: any[] = []; const nodes: any[] = [];
  const order: number[] = [];   // row starts, in bin order (the worker writes rows in bin order already)
  for (let r = 0; r + STRIDE <= meta.length; r += STRIDE) {
    order.push(r);
    const expressId = meta[r], posOffset = meta[r + 1], posCount = meta[r + 2], idxOffset = meta[r + 3], idxCount = meta[r + 4];
    const e = byId.get(expressId); const p = products.get(expressId);
    bufferViews.push({ buffer: 0, byteOffset: posOffset, byteLength: posCount * 12, target: 34962 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: posCount, type: 'VEC3', min: [meta[r + 7] * S, meta[r + 8] * S, meta[r + 9] * S], max: [meta[r + 10] * S, meta[r + 11] * S, meta[r + 12] * S] });
    const posAcc = accessors.length - 1;
    bufferViews.push({ buffer: 0, byteOffset: idxOffset, byteLength: idxCount * 4, target: 34963 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5125, count: idxCount, type: 'SCALAR' });
    meshes.push({ primitives: [{ attributes: { POSITION: posAcc }, indices: accessors.length - 1 }] });
    nodes.push({ mesh: meshes.length - 1, name: e?.guid ?? p?.guid ?? String(expressId), extras: { guid: e?.guid ?? p?.guid ?? '', ifcClass: e?.ifcClass ?? p?.ifcClass ?? '', storey: e?.storey ?? '' } });
  }
  const binLen = summary.binBytes; const binPad = (4 - (binLen % 4)) % 4;
  const gltf = { asset: { version: '2.0', generator: 'whiq-bim v2 (web-ifc worker, streamed)' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: binLen + binPad }] };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) json = Buffer.concat([json, Buffer.from(' '.repeat(jsonPad))]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binLen + binPad, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(binLen + binPad, 0); binHead.writeUInt32LE(0x004e4942, 4);
  const out = openSync(glbOut, 'w');
  try {
    writeSync(out, header); writeSync(out, jsonHead); writeSync(out, json); writeSync(out, binHead);
    const src = openSync(binPath, 'r');
    try {
      // Copy the bin in row order: padding and index bytes raw, position bytes scaled when the model is not in metres.
      let pos = 0;
      const copyRaw = (until: number) => { const CH = 4 << 20; while (pos < until) { const n = Math.min(CH, until - pos); const b = Buffer.allocUnsafe(n); const r = readSync(src, b, 0, n, pos); if (r <= 0) break; writeSync(out, b, 0, r); pos += r; } };
      for (const r of order) {
        const posOffset = meta[r + 1], posCount = meta[r + 2], idxOffset = meta[r + 3], idxCount = meta[r + 4];
        copyRaw(posOffset);
        const n = posCount * 12; const b = Buffer.allocUnsafe(n); let got = 0; while (got < n) { const k = readSync(src, b, got, n - got, pos + got); if (k <= 0) break; got += k; }
        if (S !== 1) { const f = new Float32Array(b.buffer, b.byteOffset, got / 4); for (let i = 0; i < f.length; i++) f[i] *= S; }
        writeSync(out, b, 0, got); pos += got;
        copyRaw(idxOffset + idxCount * 4);
      }
      copyRaw(binLen);
    } finally { closeSync(src); }
    if (binPad) writeSync(out, Buffer.alloc(binPad));
  } finally { closeSync(out); }
}

function writeEmptyGlb(glbOut: string): void {
  const gltf = { asset: { version: '2.0', generator: 'whiq-bim v2 (no geometry)' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8'); const pad = (4 - (json.length % 4)) % 4; if (pad) json = Buffer.concat([json, Buffer.from(' '.repeat(pad))]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length, 8);
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  writeFileSync(glbOut, Buffer.concat([header, jsonHead, json]));
}
