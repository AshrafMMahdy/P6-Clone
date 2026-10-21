// IFC models in Node (MCP server, CLI, the desktop's main process): parsed once, cached by the file's content hash in
// memory and on disk (index JSON + viewer GLB), so reopening a project or a file someone re-saved without changes costs
// nothing. The memory a model takes is reported so the MCP server can count it in its budget.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIfc, INDEX_FORMAT, type IfcElement, type IfcIndex } from './parse.ts';

export interface Model { hash: string; index: IfcIndex; glb: string | null; byGuid: Map<string, IfcElement>; bytes: number }

const memory = new Map<string, Model>();
const cacheDir = () => { const d = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache'); mkdirSync(d, { recursive: true }); return d; };

export function fileHash(path: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex').slice(0, 32))); });
}

// in memory a parsed index takes about three times its JSON text (objects, strings as UTF-16, the GlobalId map)
const wrap = (hash: string, index: IfcIndex, glb: string | null, jsonChars: number): Model => ({ hash, index, glb, byGuid: new Map(index.elements.map((e) => [e.guid, e])), bytes: jsonChars * 3 + index.elements.length * 200 });

/** Parse (or take from the cache) the IFC at path. geometry: false skips meshes (faster; no GLB, no derived volumes). */
export async function loadModel(path: string, o: { geometry?: boolean } = {}): Promise<Model> {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  pruneCache();
  // an IFC is a STEP file with an IFC schema; anything else (an XER, a GLB, an .rvt) is refused before it replaces a model
  const head = (() => { const fd = openSync(path, 'r'); try { const b = Buffer.alloc(65536); return b.subarray(0, readSync(fd, b, 0, 65536, 0)).toString('latin1'); } finally { closeSync(fd); } })();
  if (!/^\s*ISO-10303-21\s*;/.test(head) || !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head)) throw new Error(`${path} is not an IFC file (an IFC starts with ISO-10303-21 and names an IFC schema). Revit .rvt and other formats have to be exported to IFC first.`);
  const hash = await fileHash(path);
  const hit = memory.get(hash);
  if (hit && (o.geometry === false || hit.glb)) { hit.index.sourcePath = path; return hit; }
  const base = join(cacheDir(), `${hash}-v${INDEX_FORMAT}`);
  if (existsSync(`${base}.json`) && (o.geometry === false || existsSync(`${base}.glb`))) {
    const text = readFileSync(`${base}.json`, 'utf8'), index = JSON.parse(text) as IfcIndex;
    index.sourcePath = path;
    touch(base);
    const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null, text.length);
    memory.set(hash, m);
    return m;
  }
  const geometry = o.geometry !== false;
  const { index } = await parseIfc(path, { geometry, ...(geometry ? { glbOut: `${base}.glb` } : {}) });
  const text = JSON.stringify(index);
  writeFileSync(`${base}.json`, text);
  const m = wrap(hash, index, geometry && existsSync(`${base}.glb`) ? `${base}.glb` : null, text.length);
  memory.set(hash, m);
  return m;
}

/** A model by hash, from memory or the disk cache (null when it has to be opened again from its file). */
export function cachedModel(hash: string): Model | null {
  const hit = memory.get(hash);
  if (hit) return hit;
  for (const f of [`${hash}-v${INDEX_FORMAT}`]) {
    const base = join(cacheDir(), f);
    if (existsSync(`${base}.json`)) { const text = readFileSync(`${base}.json`, 'utf8'), index = JSON.parse(text) as IfcIndex; touch(base); const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null, text.length); memory.set(hash, m); return m; }
  }
  return null;
}

/** Drop models no open project uses (the MCP server calls this when a project is closed or moved out). */
export function releaseModels(keep: Set<string>): void { for (const h of [...memory.keys()]) if (!keep.has(h)) memory.delete(h); }
export const modelBytes = (hashes: Iterable<string> = memory.keys()) => { let n = 0; for (const h of hashes) n += memory.get(h)?.bytes ?? 0; return n; };

/** What reading the IFC at path may need, before it is read: the index in this process (about 4x the file; a 102 MB
 *  model took 423 MB) and, while it runs, the geometry process (about 5x: 484 MB). Held only while the model is read. */
export function loadEstimate(path: string, o: { geometry?: boolean } = {}): number {
  const size = existsSync(path) ? statSync(path).size : 0;
  return Math.round(size * (o.geometry === false ? 4.2 : 9.2));
}

// ── the disk cache (OS temp folder): models not used for P6CLONE_MODEL_CACHE_DAYS (14) go, and the oldest go first
// while it is over P6CLONE_MODEL_CACHE_MB (10240); checked at most once an hour
const touch = (base: string) => { const now = new Date(); for (const x of ['.json', '.glb']) try { utimesSync(`${base}${x}`, now, now); } catch { /* not there */ } };
let pruned = 0;
export function pruneCache(now = Date.now()): number {
  if (now - pruned < 3_600_000) return 0;
  pruned = now;
  const dir = cacheDir(), days = Number(process.env.P6CLONE_MODEL_CACHE_DAYS) || 14, cap = (Number(process.env.P6CLONE_MODEL_CACHE_MB) || 10240) * 1048576;
  const files = readdirSync(dir).map((f) => { const p = join(dir, f); try { const st = statSync(p); return { p, at: st.mtimeMs, size: st.size }; } catch { return null; } }).filter((x): x is { p: string; at: number; size: number } => !!x && /\.(json|glb)$/.test(x.p)).sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0), removed = 0;
  for (const f of files) {
    if (now - f.at < days * 86_400_000 && total <= cap) break;
    try { rmSync(f.p, { force: true }); total -= f.size; removed++; } catch { /* in use */ }
  }
  return removed;
}
export const glbSize = (m: Model) => (m.glb && existsSync(m.glb) ? statSync(m.glb).size : 0);
