// IFC models in Node (MCP server, CLI, the desktop's main process): parsed once, cached by the file's content hash in
// memory and on disk (the index, its geometry fingerprints and the display tiles), so reopening a project or a file
// someone re-saved without changes costs nothing. The memory a model takes is reported so the MCP server can count it
// in its budget, and what reading one will take is estimated before it is read (loadNeeds).
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chunkBytesOf, meshIndex, parseIfc, productIdsOf, INDEX_FORMAT, type IfcElement, type IfcIndex } from './parse.ts';
import { compactHeap, Element, ExtrasTable, noVolume, GEOM_STRIDE, geomStore, newGeomStore, type Extras, type GeomStore } from './element.ts';
import { elementsByGuid } from './lookup.ts';
import { readManifest, tileBytesOf } from './tiles.ts';
import { isRevit, revitNeed, rvtToIfc, type RevitSource } from './rvt.ts';
import { cacheNavisworks, isNavisworks, navisworksKey, navisworksNeed, nwdToIfc, type NavisworksSource } from './nwd.ts';
import { alive } from './heartbeat.mjs';
import { expectedMs, watched } from './serverWatch.ts';

export interface Model {
  hash: string; index: IfcIndex;
  /** the display tiles folder (manifest.json, tile-NNNNN.glb, elements.txt), or null when the model has no geometry */
  tiles: string | null;
  byGuid: Map<string, IfcElement>; bytes: number;
  /** a Revit file (read through IFC) or a Navisworks file (read as it is): what was read */
  source?: RevitSource | NavisworksSource;
}

const memory = new Map<string, Model>();
// the tiles depend on their size setting, so it is part of the name
const cacheName = (hash: string) => `${hash}-v${INDEX_FORMAT}-t${Math.round(tileBytesOf() / 1048576)}`;
const cacheDir = () => { const d = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache'); mkdirSync(d, { recursive: true }); return d; };
/** Caches of an older format are set aside here (renamed, kept for the cache's days, then pruned): opening the model again reads it afresh. */
export const SUPERSEDED = 'superseded';

export function fileHash(path: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex').slice(0, 32))); });
}

// ── what a model takes in memory (measured, scripts/measure-ifc.ts): the compact index ──────────────────────────────
/** Bytes per element of the index in memory: the element (64), its GlobalId and name, its entry in the GlobalId map. */
export const ELEMENT_BYTES = 250;
const indexBytes = (index: IfcIndex) => {
  const st = geomStore(index);
  return index.elements.length * ELEMENT_BYTES + (st?.rows?.byteLength ?? 0) + 8 * 1048576;
};
// an element rvt-rs could only place as a box (its bounding box, or a turned or oriented box of a family instance) has
// no volume worth a quantity (a 2023 project: doors 22x, railings 700x Revit's own IFC; walls drawn from their profile
// within 1%): placed and counted, never measured
// A wall rvt-rs drew as an axis-aligned box thicker than any wall (both horizontal sides over 1.2 m) is the bounding box
// of a wall it could not shape (skewed or curved; rac_basic 2023: 446.6 m3 for one wall), whatever its body source says;
// a straight wall along an axis is a box too, but a thin one
const boxedWall = (e: IfcElement) => {
  const g = e.geom;
  if (!g || g.triangles !== 12 || !/^IfcWall/i.test(e.ifcClass) || e.props['RvtElementRecordGeometry.BodySource'] == null) return false;
  const [x0, y0, z0, x1, y1, z1] = g.bbox, box = (x1 - x0) * (y1 - y0) * (z1 - z0);
  const sides = [x1 - x0, y1 - y0, z1 - z0].sort((a, b) => a - b); // the height is not the thin side of a wall
  return Math.abs(g.volume - box) <= 0.01 * box && sides[0] > 1.2 && sides[1] > 1.2;
};
const boxOnly = (e: IfcElement) => /box/i.test(String(e.props['RvtElementRecordGeometry.BodySource'] ?? '')) || e.props['P6Clone.Geometry'] === 'bounding boxes' || boxedWall(e);
const wrap = (hash: string, index: IfcIndex, tiles: string | null): Model => {
  for (const e of index.elements) if (boxOnly(e)) noVolume(e);
  return { hash, index, tiles: index.geometryStatus === 'ok' && tiles && readManifest(tiles) ? tiles : null, byGuid: elementsByGuid(index), bytes: indexBytes(index) };
};

type LoadOptions = { geometry?: boolean; chunkBytes?: number; hash?: string; onProgress?: (done: number, total: number, note: string) => void | Promise<void> };
/** Parse (or take from the cache) the model at path: an IFC, a Revit file (made into IFC4 first, rvt.ts) or a
 *  Navisworks file (read as it is, nwd.ts). geometry: false skips meshing (faster; no tiles, no derived volumes). A model cached without
 *  geometry is meshed from its cached index when geometry is asked for. hash: the IFC's own content hash, when the
 *  caller has it (never a Revit or Navisworks file's: the IFC made from it is cached under its own). */
/** Loads in flight, by file: a second caller waits for the first (two meshing runs of one model would share its tiles
 *  folder and fingerprints), and reads on only when that load did not give it what it asked for. */
const inFlight = new Map<string, Promise<Model>>();
/** The IFC a model file is read as: the file itself, or the IFC4 a Revit or Navisworks file was made into (from the
 *  conversion cache, made again if it was pruned). Exports that carry the model's own file stream this one. */
export async function ifcOf(path: string): Promise<string> {
  if (isNavisworks(path)) return (await nwdToIfc(path)).ifc;
  if (isRevit(path)) return (await rvtToIfc(path)).ifc;
  return path;
}

export async function loadModel(path: string, o: LoadOptions = {}): Promise<Model> {
  const key = resolve(path);
  for (let p = inFlight.get(key); p; p = inFlight.get(key)) {
    const m = await p.catch(() => null);
    if (m && (o.geometry === false || m.index.geometryStatus !== 'skipped')) return m;
    if (inFlight.get(key) === p) break;
  }
  const run = loadModelNow(path, o);
  inFlight.set(key, run);
  try { return await run; } finally { if (inFlight.get(key) === run) inFlight.delete(key); }
}

async function loadModelNow(path: string, o: LoadOptions): Promise<Model> {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  if (isNavisworks(path)) return loadNavisworks(path, o);
  if (!isRevit(path)) return loadIfc(path, o);
  const { ifc, source } = await rvtToIfc(path);
  const m = await loadIfc(ifc, { ...o, hash: undefined });
  m.index.sourcePath = path; m.source = source;
  const boxes = m.index.elements.filter(boxOnly).length;
  source.geometry = { from_the_file: m.index.elements.length - boxes, bounding_box_only: boxes, note: 'bounding-box elements are placed for 4D but give no derived volume (quantities counts them as unquantified)' };
  return m;
}

/** A Navisworks model: its index and tiles from the cache, else read from the file (in the reader's own process) into
 *  it; cached by the files' content and the reader's format. */
async function loadNavisworks(path: string, o: LoadOptions): Promise<Model> {
  pruneCache();
  const hash = await navisworksKey(path), name = cacheName(hash), base = join(cacheDir(), name);
  const want = o.geometry !== false;
  const hit = memory.get(name);
  if (hit && (!want || hit.tiles || (hit.index.geometryStatus === 'unavailable' && retried.has(hash)))) { hit.index.sourcePath = path; return hit; }
  setAsideOld(hash);
  let index = existsSync(`${base}.ndjson`) && existsSync(`${base}.nw.json`) ? (await tryReadIndexW(base))?.index ?? null : null;
  // a model read without geometry, or whose geometry failed (once a run of the app), is read again with it
  const retry = !!index && want && index.geometryStatus === 'unavailable' && !retried.has(hash);
  if (retry) retried.add(hash);
  if (!index || retry || (want && (index.geometryStatus === 'skipped' || (index.geometryStatus === 'ok' && !readManifest(`${base}.tiles`))))) {
    await cacheNavisworks(path, base, { geometry: want, onProgress: o.onProgress });
    index = await indexSection('reading', base, () => readIndex(base));
  }
  index.sourcePath = path;
  touch(base);
  const m = wrap(hash, index, `${base}.tiles`);
  m.source = JSON.parse(readFileSync(`${base}.nw.json`, 'utf8')) as NavisworksSource;
  memory.set(name, m);
  return m;
}

async function loadIfc(path: string, o: LoadOptions): Promise<Model> {
  pruneCache();
  // an IFC is a STEP file with an IFC schema; anything else (an XER, a GLB, an .rvt) is refused before it replaces a model
  const head = (() => { const fd = openSync(path, 'r'); try { const b = Buffer.alloc(65536); return b.subarray(0, readSync(fd, b, 0, 65536, 0)).toString('latin1'); } finally { closeSync(fd); } })();
  if (!/^\s*ISO-10303-21\s*;/.test(head) || !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head)) throw new Error(`${path} is not an IFC file (an IFC starts with ISO-10303-21 and names an IFC schema). Revit (.rvt / .rfa) and Navisworks (.nwd / .nwc / .nwf) files are read as they are; other formats have to be exported to IFC first.`);
  const hash = o.hash ?? await fileHash(path);
  const want = o.geometry !== false;
  const hit = memory.get(cacheName(hash));
  if (hit && (!want || hit.tiles || (hit.index.geometryStatus === 'unavailable' && retried.has(hash)))) { hit.index.sourcePath = path; return hit; }
  const base = join(cacheDir(), cacheName(hash));
  setAsideOld(hash);
  let cached = hit ? { index: hit.index } : existsSync(`${base}.ndjson`) ? await tryReadIndexW(base) : null;
  // a model indexed without geometry: meshed now from its cached index (the STEP pass is not run again); so is one whose
  // meshing failed, once a run of the app (a timeout, or memory short at the time, may not happen again)
  const retry = cached && want && cached.index.geometryStatus === 'unavailable' && !retried.has(hash);
  if (retry) retried.add(hash);
  if (cached && want && (cached.index.geometryStatus === 'skipped' || retry)) {
    const index = cached.index;
    await meshIndex(path, index, productIdsOf(index), { tilesOut: `${base}.tiles`, chunkBytes: o.chunkBytes, onProgress: o.onProgress });
    await indexSection('writing', base, () => writeIndex(base, index));
    cached = { index };
  }
  if (cached && (!want || cached.index.geometryStatus !== 'ok' || readManifest(`${base}.tiles`))) {
    const { index } = cached;
    index.sourcePath = path;
    touch(base);
    const m = wrap(hash, index, `${base}.tiles`);
    memory.set(cacheName(hash), m);
    return m;
  }
  const { index } = await parseIfc(path, { geometry: want, ...(want ? { tilesOut: `${base}.tiles`, chunkBytes: o.chunkBytes, onProgress: o.onProgress } : {}) });
  await indexSection('writing', base, () => writeIndex(base, index));
  if (index.elements.length > 200_000) compactHeap(); // what reading it left behind goes before the next call takes memory
  const m = wrap(hash, index, want ? `${base}.tiles` : null);
  memory.set(cacheName(hash), m);
  return m;
}

// ── the index on disk (format 10): a header line (everything but the elements, and the shared records), then a line
// per element ([guid, express id, name, shared record, authored quantities]); the geometry fingerprints in <base>.geom
// (float32 rows, GEOM_STRIDE per element). Written beside and renamed into place: a cache file is whole or absent.
interface Header extends Omit<IfcIndex, 'elements'> { x: unknown[]; tables: { p: unknown[]; q: unknown[]; me: unknown[]; o: unknown[] }; geom: { origin: number[]; rows: boolean } }
export function writeIndex(base: string, index: IfcIndex): void {
  const file = `${base}.ndjson`, tmp = `${file}.${process.pid}.tmp`;
  // the shared records: those of compact elements, or interned now for plain ones
  const st = geomStore(index) ?? newGeomStore();
  const table = new ExtrasTable(st);
  const xOf = (e: IfcElement): Extras => (e instanceof Element ? e._x : table.get({ c: e.ifcClass, s: e.storey, d: e.discipline, ...(e.material ? { m: e.material } : {}), ...(e.typeName ? { t: e.typeName } : {}), ...(e.system ? { y: e.system } : {}), p: e.props, ...(e.quantityInfo ? { q: e.quantityInfo } : {}), ...(e.measures ? { me: e.measures } : {}), ...(e.owner ? { o: e.owner } : {}) }));
  const xNo = new Map<Extras, number>(), xs: unknown[] = [];
  const objs = { p: new Map<object, number>(), q: new Map<object, number>(), me: new Map<object, number>(), o: new Map<object, number>() };
  const tables = { p: [] as unknown[], q: [] as unknown[], me: [] as unknown[], o: [] as unknown[] };
  const ref = (k: keyof typeof objs, v: object | undefined) => { if (!v) return -1; let n = objs[k].get(v); if (n == null) { n = tables[k].length; tables[k].push(v); objs[k].set(v, n); } return n; };
  // first the shared records (the header lists them), then the elements, written in blocks
  const xIndex = new Int32Array(index.elements.length);
  index.elements.forEach((e, i) => {
    if ((i & 0xfff) === 0) alive(); // the Navisworks reader writes this index in its own process: a tick per 4096 elements
    const x = xOf(e);
    let n = xNo.get(x);
    if (n == null) { n = xs.length; xNo.set(x, n); xs.push([x.c, x.s, x.d, x.m ?? null, x.t ?? null, x.y ?? null, ref('p', x.p), ref('q', x.q), ref('me', x.me), ref('o', x.o)]); }
    xIndex[i] = n;
  });
  const plainGeom = !(index.elements[0] instanceof Element) && index.elements.some((e) => e.geom);
  const { elements: _skip, ...rest } = index;
  const header: Header = { ...rest, x: xs, tables, geom: { origin: plainGeom ? [0, 0, 0] : st.origin, rows: !!st.rows || plainGeom } };
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(header) + '\n');
    let buf = '';
    index.elements.forEach((e, i) => { if ((i & 0xfff) === 0) alive(); buf += JSON.stringify([e.guid, e.expressId, e.name, xIndex[i], Object.keys(e.authored).length ? e.authored : 0]) + '\n'; if (buf.length > 1 << 22) { writeSync(fd, buf); buf = ''; } });
    if (buf) writeSync(fd, buf);
  } finally { closeSync(fd); }
  // fingerprints: the store's rows, or those of plain elements
  if (st.rows) writeFileSync(`${base}.geom`, new Uint8Array(st.rows.buffer, st.rows.byteOffset, st.rows.byteLength));
  else if (plainGeom) {
    const rows = new Float32Array(index.elements.length * GEOM_STRIDE).fill(Number.NaN);
    index.elements.forEach((e, i) => { const g = e.geom; if (g) rows.set([...g.bbox, ...g.centroid, g.volume, g.triangles], i * GEOM_STRIDE); });
    writeFileSync(`${base}.geom`, new Uint8Array(rows.buffer));
  } else rmSync(`${base}.geom`, { force: true });
  renameSync(tmp, file);
}

/** The cached index files are read and written in the server's own process: declared sections (serverWatch.ts), one opaque call of the
 *  file's size at the index rate (section 6), ticking every 16 MB block / 4096 elements. */
const indexSection = <T,>(verb: string, base: string, fn: () => T): Promise<T> => {
  const size = (() => { try { return statSync(`${base}.ndjson`).size; } catch { return 0; } })();
  return watched(`${verb} the cached model index`, { what: 'The model index', tried: 'one pass over the cached index file in the server\u2019s own process', next: 'remove the model cache folder (P6CLONE_MODEL_CACHE) so the model is read again from its file, or open the model with geometry: false', expectMs: expectedMs(size, 'index') }, fn);
};
const tryReadIndexW = async (base: string): Promise<{ index: IfcIndex } | null> => { try { return { index: await indexSection('reading', base, () => readIndex(base)) }; } catch (e) { if ((e as Error).name === 'StuckError') throw e; rmSync(`${base}.ndjson`, { force: true }); return null; } };
/** The cached index, or null when the cache is missing or damaged (then the IFC is read again). */
function tryReadIndex(base: string): { index: IfcIndex } | null { try { return { index: readIndex(base) } } catch { rmSync(`${base}.ndjson`, { force: true }); return null; } }
export function readIndex(base: string): IfcIndex {
  const fd = openSync(`${base}.ndjson`, 'r'), dec = new TextDecoder(), buf = Buffer.alloc(1 << 24);
  let rest = '', header: Header | null = null, index: IfcIndex | null = null, xs: Extras[] = [], st: GeomStore = newGeomStore();
  const line = (l: string) => {
    if (!l) return;
    if (!header) {
      header = JSON.parse(l) as Header;
      const { x, tables, geom, ...ix } = header;
      st = { rows: null, origin: geom.origin as [number, number, number] };
      if (geom.rows) { const b = readFileSync(`${base}.geom`); st.rows = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
      const tab = (k: keyof Header['tables'], n: number) => (n >= 0 ? tables[k][n] : undefined);
      xs = (x as unknown[][]).map((r) => { const e: Extras = { c: r[0] as string, s: r[1] as string, d: r[2] as Extras['d'], p: (tab('p', r[6] as number) ?? {}) as Extras['p'], g: st }; if (r[3]) e.m = r[3] as string; if (r[4]) e.t = r[4] as string; if (r[5]) e.y = r[5] as string; const q = tab('q', r[7] as number), me = tab('me', r[8] as number), o = tab('o', r[9] as number); if (q) e.q = q as Extras['q']; if (me) e.me = me as Extras['me']; if (o) e.o = o as Extras['o']; return e; });
      index = { ...(ix as Omit<IfcIndex, 'elements'>), elements: [] };
      return;
    }
    const r = JSON.parse(l) as [string, number, string, number, Record<string, number> | 0];
    const els = index!.elements;
    els.push(new Element(r[0], r[1], r[2], r[4] || null, xs[r[3]], els.length));
  };
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) { alive(); const ls = (rest + dec.decode(buf.subarray(0, n), { stream: true })).split('\n'); rest = ls.pop()!; for (const l of ls) line(l); }
    line(rest + dec.decode());
  } finally { closeSync(fd); }
  if (!index) throw new Error(`The model cache ${base}.ndjson is empty.`);
  if ((index as IfcIndex).elements.length > 200_000) compactHeap();
  const ix = index as IfcIndex;
  if (st.rows && st.rows.length !== ix.elements.length * GEOM_STRIDE) throw new Error(`The model cache ${base}.geom does not match its index.`);
  return ix;
}

/** Caches of this model in an older format (another INDEX_FORMAT, the GLB of format 9, other tile settings): renamed
 *  into superseded/ (pruned after the cache's days), so opening the model reads it afresh. */
export function setAsideOld(hash: string): string[] {
  const dir = cacheDir(), keep = cacheName(hash), moved: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return moved; }
  for (const f of names) {
    if (!f.startsWith(`${hash}-`) || f.startsWith(`${keep}.`) || /\.\d+\.tmp$/.test(f)) continue;
    mkdirSync(join(dir, SUPERSEDED), { recursive: true });
    try { renameSync(join(dir, f), join(dir, SUPERSEDED, f)); moved.push(f); } catch { /* in use: tried again next time */ }
  }
  return moved;
}

/** A model by hash, from memory or the disk cache (null when it has to be opened again from its file). */
export function cachedModel(hash: string): Model | null {
  const hit = memory.get(cacheName(hash));
  if (hit) return hit;
  const base = join(cacheDir(), cacheName(hash));
  const c = existsSync(`${base}.ndjson`) ? tryReadIndex(base) : null;
  if (c) { touch(base); const m = wrap(hash, c.index, `${base}.tiles`); memory.set(cacheName(hash), m); return m; }
  return null;
}

/** Drop models no open project uses (the MCP server calls this when a project is closed or moved out). */
export function releaseModels(keep: Set<string>): void { for (const [k, m] of [...memory]) if (!keep.has(m.hash)) memory.delete(k); }
export const modelBytes = (hashes?: Iterable<string>) => { const want = hashes ? new Set(hashes) : null; let n = 0; for (const m of memory.values()) if (!want || want.has(m.hash)) n += m.bytes; return n; };

// ── what reading a model will take, before it is read ─────────────────────────────────────────────────────────────
// Measured with scripts/measure-ifc.ts (peak RSS of the server process and its children, synthetic models of 7 MB to
// 1.7 GB and the sample models): see docs/4d-tiles-contract.md, "Memory". The estimate is the measured peak plus a margin.
/** Server-side peak while the STEP pass builds the index: about the file's size for a model of a few hundred MB (the
 *  pass's garbage between its collections), then INDEX_PER_BYTE of each byte past it (the live index is a quarter of
 *  the file; the pass collects every 128 MB read), whichever is less, plus INDEX_FIXED (the code it loads). */
export const INDEX_PER_BYTE = 0.4, INDEX_KNEE = 256 * 1048576, INDEX_FIXED = 160 * 1048576; // fixed: 160 MB, the most a 42 MB model took on Linux (Node 24.14.0) past its own size
export const indexNeed = (bytes: number) => Math.round(Math.min(bytes, bytes * INDEX_PER_BYTE + INDEX_KNEE) + INDEX_FIXED);
/** A geometry run's peak (web-ifc's WebAssembly memory, the file's bytes, the meshes) per byte of IFC it meshes, and its
 *  fixed part (Node and web-ifc themselves). */
export const MESH_PER_BYTE = 3.8, MESH_FIXED = 330 * 1048576;
/** The smallest chunk a model is cut into to fit the memory left (smaller ones repeat the shared definitions too often). */
export const MIN_CHUNK = 16 * 1048576;

export interface LoadNeeds {
  /** bytes the index takes while it is built (0 when it is cached) */
  index: number;
  /** bytes a geometry run takes at its peak (0 without geometry, or when the tiles are cached) */
  mesh: number;
  /** IFC bytes per geometry run that fit: the default chunk, or smaller when the memory left is short */
  chunkBytes: number;
  total: number;
}
const meshNeed = (bytes: number) => Math.round(bytes * MESH_PER_BYTE + MESH_FIXED);

/** What reading the IFC at path needs, given the memory free for it: the index (unless cached), and one geometry run on
 *  a chunk sized to what is left (never more than P6CLONE_GEOM_CHUNK_MB, never less than MIN_CHUNK). */
export function loadNeeds(path: string, o: { geometry?: boolean; free?: number; hash?: string } = {}): LoadNeeds {
  const size = existsSync(path) ? statSync(path).size : 0;
  // a Revit file is made into an IFC first, by rvt-rs in its own process (revitNeed); reading and meshing the IFC it
  // makes is sized from that IFC (loadNeeds on it, once it is made)
  if (isRevit(path)) { const index = revitNeed(size); return { index, mesh: 0, chunkBytes: 0, total: index }; }
  // a Navisworks model is read as it is, by its own process (its model trees as objects, a model at a time; the geometry
  // a stream at a time), then its index is held here: both, from the sizes of its sections (navisworksNeed)
  if (isNavisworks(path)) { const n = navisworksNeed(path, o.geometry !== false); return { index: n.index, mesh: n.reader, chunkBytes: 0, total: n.index + n.reader }; }
  const base = o.hash ? join(cacheDir(), cacheName(o.hash)) : null;
  const indexCached = !!(base && (memory.has(cacheName(o.hash!)) || existsSync(`${base}.ndjson`)));
  const tilesCached = !!(base && readManifest(`${base}.tiles`));
  const index = indexCached ? 0 : indexNeed(size);
  if (o.geometry === false || tilesCached) return { index, mesh: 0, chunkBytes: 0, total: index };
  let chunk = Math.min(size, chunkBytesOf());
  if (o.free != null) {
    // what fits beside the index (the index stays in memory while the runs go)
    const room = o.free - index - MESH_FIXED;
    const fits = Math.floor(room / MESH_PER_BYTE);
    if (fits < chunk) chunk = Math.max(Math.min(size, MIN_CHUNK), fits);
  }
  const mesh = meshNeed(chunk);
  return { index, mesh, chunkBytes: chunk, total: index + mesh };
}
/** The bytes loadNeeds would reserve with no memory limit (the default chunk). */
export function loadEstimate(path: string, o: { geometry?: boolean } = {}): number { return loadNeeds(path, o).total; }

// ── the disk cache (OS temp folder unless P6CLONE_MODEL_CACHE): models not used for P6CLONE_MODEL_CACHE_DAYS (14) go,
// and the oldest go first while it is over P6CLONE_MODEL_CACHE_MB (10240); checked at most once an hour. The
// superseded/ folder (older formats, set aside) is pruned by age only.
const touch = (base: string) => { const now = new Date(); for (const x of ['.ndjson', '.geom', '.tiles/manifest.json', '.tiles', '.nw.json']) try { utimesSync(`${base}${x}`, now, now); } catch { /* not there */ } };
let pruned = 0;
const retried = new Set<string>();

export function pruneCache(now = Date.now()): number {
  if (now - pruned < 3_600_000) return 0;
  pruned = now;
  const dir = cacheDir(), days = Number(process.env.P6CLONE_MODEL_CACHE_DAYS) || 14, cap = (Number(process.env.P6CLONE_MODEL_CACHE_MB) || 10240) * 1048576;
  const sizeOf = (p: string): number => { try { const st = statSync(p); return st.isDirectory() ? readdirSync(p).reduce((n, f) => n + sizeOf(join(p, f)), 0) : st.size; } catch { return 0; } };
  const files = readdirSync(dir).filter((f) => /\.(json|ndjson|geom|glb|tiles|ifc)$/.test(f)).map((f) => { const p = join(dir, f); try { const st = statSync(p); return { p, at: st.mtimeMs, size: sizeOf(p) }; } catch { return null; } }).filter((x): x is { p: string; at: number; size: number } => !!x).sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
  for (const f of files) {
    if (now - f.at < days * 86_400_000 && total <= cap) break;
    try { rmSync(f.p, { recursive: true, force: true }); total -= f.size; removed++; } catch { /* in use */ }
  }
  // what was set aside (older formats) goes on the same days: it is never read again, only kept a while
  const old = join(dir, SUPERSEDED);
  for (const f of existsSync(old) ? readdirSync(old) : []) {
    const p = join(old, f);
    try { if (now - statSync(p).mtimeMs >= days * 86_400_000) { rmSync(p, { recursive: true, force: true }); removed++; } } catch { /* in use */ }
  }
  return removed;
}
/** Bytes of the model's display tiles. */
export const tilesSize = (m: Model) => (m.tiles ? readManifest(m.tiles)?.bytes ?? 0 : 0);
