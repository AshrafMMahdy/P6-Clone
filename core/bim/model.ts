// IFC models in Node (MCP server, CLI, the desktop's main process): parsed once, cached by the file's content hash in
// memory and on disk (index JSON + viewer GLB), so reopening a project or a file someone re-saved without changes costs
// nothing. The memory a model takes is reported so the MCP server can count it in its budget.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIfc, INDEX_FORMAT, type IfcElement, type IfcIndex } from './parse.ts';
import { isRevit, rvtToIfc, type RevitSource } from './rvt.ts';
import { isNavisworks, nwdToIfc, type NavisworksSource } from './nwd.ts';

export interface Model { hash: string; index: IfcIndex; glb: string | null; byGuid: Map<string, IfcElement>; bytes: number; /** a Revit or Navisworks file read through IFC */ source?: RevitSource | NavisworksSource }

const memory = new Map<string, Model>();
// the display model depends on its settings, so they are part of the name
const cacheName = (hash: string) => `${hash}-v${INDEX_FORMAT}-${Number(process.env.P6CLONE_VIEW_BATCH) || 50000}-${Number(process.env.P6CLONE_VIEW_MAX_MB) || 1024}`;
const cacheDir = () => { const d = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache'); mkdirSync(d, { recursive: true }); return d; };

export function fileHash(path: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex').slice(0, 32))); });
}

// an element rvt-rs could only place as its bounding box has no volume worth a quantity (a 2023 project: doors 22x,
// railings 700x Revit's own IFC; walls drawn from their profile within 1%): placed and counted, never measured
const boxOnly = (e: IfcElement) => /bbox/.test(String(e.props['RvtElementRecordGeometry.BodySource'] ?? ''));
// in memory a parsed index takes about three times its JSON text (objects, strings as UTF-16, the GlobalId map)
const wrap = (hash: string, index: IfcIndex, glb: string | null, jsonChars: number): Model => {
  for (const e of index.elements) if (boxOnly(e)) e.derivedVolumeM3 = null;
  return { hash, index, glb: index.geometryStatus === 'ok' ? glb : null, byGuid: new Map(index.elements.map((e) => [e.guid, e])), bytes: jsonChars * 3 + index.elements.length * 200 };
};

/** Parse (or take from the cache) the model at path: an IFC, or a Revit file (made into IFC4 first, rvt.ts).
 *  geometry: false skips meshes (faster; no GLB, no derived volumes). */
export async function loadModel(path: string, o: { geometry?: boolean } = {}): Promise<Model> {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  if (isNavisworks(path)) {
    const { ifc, source } = await nwdToIfc(path);
    const m = await loadIfc(ifc, { geometry: false }); // the reader has no geometry yet: elements, properties, Revit's quantities
    m.index.sourcePath = path; m.source = source; m.index.geometryStatus = 'unavailable';
    return m;
  }
  if (!isRevit(path)) return loadIfc(path, o);
  const { ifc, source } = await rvtToIfc(path);
  const m = await loadIfc(ifc, o);
  m.index.sourcePath = path; m.source = source;
  const boxes = m.index.elements.filter(boxOnly).length;
  source.geometry = { from_the_file: m.index.elements.length - boxes, bounding_box_only: boxes, note: 'bounding-box elements are placed for 4D but give no derived volume (quantities counts them as unquantified)' };
  return m;
}

async function loadIfc(path: string, o: { geometry?: boolean }): Promise<Model> {
  pruneCache();
  // an IFC is a STEP file with an IFC schema; anything else (an XER, a GLB, an .rvt) is refused before it replaces a model
  const head = (() => { const fd = openSync(path, 'r'); try { const b = Buffer.alloc(65536); return b.subarray(0, readSync(fd, b, 0, 65536, 0)).toString('latin1'); } finally { closeSync(fd); } })();
  if (!/^\s*ISO-10303-21\s*;/.test(head) || !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head)) throw new Error(`${path} is not an IFC file (an IFC starts with ISO-10303-21 and names an IFC schema). Revit (.rvt / .rfa) and Navisworks (.nwd / .nwc / .nwf) files are read as they are; other formats have to be exported to IFC first.`);
  const hash = await fileHash(path);
  const hit = memory.get(cacheName(hash));
  if (hit && (o.geometry === false || hit.glb || hit.index.geometryStatus === 'unavailable')) { hit.index.sourcePath = path; return hit; }
  const base = join(cacheDir(), cacheName(hash));
  // an index cached without geometry does not serve a call that wants it
  const cached = existsSync(`${base}.ndjson`) && (o.geometry === false || existsSync(`${base}.glb`)) ? tryReadIndex(`${base}.ndjson`) : null;
  if (cached && (o.geometry === false || cached.index.geometryStatus !== 'skipped')) {
    const { index, chars } = cached;
    index.sourcePath = path;
    touch(base);
    const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null, chars);
    memory.set(cacheName(hash), m);
    return m;
  }
  const geometry = o.geometry !== false;
  const { index } = await parseIfc(path, { geometry, ...(geometry ? { glbOut: `${base}.glb` } : {}) });
  const chars = writeIndex(`${base}.ndjson`, index);
  const m = wrap(hash, index, geometry && existsSync(`${base}.glb`) ? `${base}.glb` : null, chars);
  memory.set(cacheName(hash), m);
  return m;
}

// The index on disk: a line with everything but the elements, then a line per element (a model of millions of elements
// is longer than one string can be). Returns / reads the characters written, for the memory count.
function writeIndex(file: string, index: IfcIndex): number {
  // written beside, then renamed into place: a cache file is whole or absent
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  let chars = 0, buf = '';
  const put = (line: string) => { buf += line + '\n'; chars += line.length + 1; if (buf.length > 1 << 22) { writeSync(fd, buf); buf = ''; } };
  try { put(JSON.stringify({ ...index, elements: [] })); for (const e of index.elements) put(JSON.stringify(e)); if (buf) writeSync(fd, buf); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return chars;
}
/** The cached index, or null when the cache is missing or damaged (then the IFC is read again). */
function tryReadIndex(file: string): { index: IfcIndex; chars: number } | null { try { return readIndex(file); } catch { rmSync(file, { force: true }); return null; } }
function readIndex(file: string): { index: IfcIndex; chars: number } {
  const fd = openSync(file, 'r'), dec = new TextDecoder(), buf = Buffer.alloc(1 << 24);
  let rest = '', chars = 0, index: IfcIndex | null = null;
  const line = (l: string) => { if (!l) return; chars += l.length + 1; if (!index) index = JSON.parse(l) as IfcIndex; else index.elements.push(JSON.parse(l)); };
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) { const ls = (rest + dec.decode(buf.subarray(0, n), { stream: true })).split('\n'); rest = ls.pop()!; for (const l of ls) line(l); }
    line(rest + dec.decode());
  } finally { closeSync(fd); }
  if (!index) throw new Error(`The model cache ${file} is empty.`);
  return { index, chars };
}

/** A model by hash, from memory or the disk cache (null when it has to be opened again from its file). */
export function cachedModel(hash: string): Model | null {
  const hit = memory.get(cacheName(hash));
  if (hit) return hit;
  for (const f of [cacheName(hash)]) {
    const base = join(cacheDir(), f);
    const c = existsSync(`${base}.ndjson`) ? tryReadIndex(`${base}.ndjson`) : null;
    if (c) { const { index, chars } = c; touch(base); const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null, chars); memory.set(cacheName(hash), m); return m; }
  }
  return null;
}

/** Drop models no open project uses (the MCP server calls this when a project is closed or moved out). */
export function releaseModels(keep: Set<string>): void { for (const [k, m] of [...memory]) if (!keep.has(m.hash)) memory.delete(k); }
export const modelBytes = (hashes?: Iterable<string>) => { const want = hashes ? new Set(hashes) : null; let n = 0; for (const m of memory.values()) if (!want || want.has(m.hash)) n += m.bytes; return n; };

/** What reading the IFC at path may need, before it is read: the index in this process (about 4x the file; a 102 MB
 *  model took 423 MB) and, while it runs, the geometry process (about 5x what it meshes at once: the whole file, or one
 *  chunk of P6CLONE_GEOM_CHUNK_MB for a model past one run). Held only while the model is read. */
export function loadEstimate(path: string, o: { geometry?: boolean } = {}): number {
  const size = existsSync(path) ? statSync(path).size : 0;
  if (isRevit(path)) return size * 12; // rvt-rs's process: 419 MB for a 33.7 MB project; the IFC it makes is far smaller
  if (isNavisworks(path)) return size * 30; // a model tree unpacks about 7x and is held as objects while it is read
  const chunk = (Number(process.env.P6CLONE_GEOM_CHUNK_MB) || 300) * 1048576;
  return Math.round(size * 4.2 + (o.geometry === false ? 0 : Math.min(size, chunk) * 5));
}

// ── the disk cache (OS temp folder): models not used for P6CLONE_MODEL_CACHE_DAYS (14) go, and the oldest go first
// while it is over P6CLONE_MODEL_CACHE_MB (10240); checked at most once an hour
const touch = (base: string) => { const now = new Date(); for (const x of ['.ndjson', '.glb']) try { utimesSync(`${base}${x}`, now, now); } catch { /* not there */ } };
let pruned = 0;
export function pruneCache(now = Date.now()): number {
  if (now - pruned < 3_600_000) return 0;
  pruned = now;
  const dir = cacheDir(), days = Number(process.env.P6CLONE_MODEL_CACHE_DAYS) || 14, cap = (Number(process.env.P6CLONE_MODEL_CACHE_MB) || 10240) * 1048576;
  const files = readdirSync(dir).map((f) => { const p = join(dir, f); try { const st = statSync(p); return { p, at: st.mtimeMs, size: st.size }; } catch { return null; } }).filter((x): x is { p: string; at: number; size: number } => !!x && /\.(json|ndjson|glb)$/.test(x.p)).sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
  for (const f of files) {
    if (now - f.at < days * 86_400_000 && total <= cap) break;
    try { rmSync(f.p, { force: true }); total -= f.size; removed++; } catch { /* in use */ }
  }
  return removed;
}
export const glbSize = (m: Model) => (m.glb && existsSync(m.glb) ? statSync(m.glb).size : 0);
