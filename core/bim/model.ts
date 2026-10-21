// IFC models in Node (MCP server, CLI, the desktop's main process): parsed once, cached by the file's content hash in
// memory and on disk (index JSON + viewer GLB), so reopening a project or a file someone re-saved without changes costs
// nothing. The memory a model takes is reported so the MCP server can count it in its budget.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIfc, INDEX_FORMAT, type IfcElement, type IfcIndex } from './parse.ts';

export interface Model { hash: string; index: IfcIndex; glb: string | null; byGuid: Map<string, IfcElement>; bytes: number }

const memory = new Map<string, Model>();
const cacheDir = () => { const d = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache'); mkdirSync(d, { recursive: true }); return d; };

export function fileHash(path: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(path).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex').slice(0, 32))); });
}

const wrap = (hash: string, index: IfcIndex, glb: string | null): Model => ({ hash, index, glb, byGuid: new Map(index.elements.map((e) => [e.guid, e])), bytes: index.elements.length * 1500 });

/** Parse (or take from the cache) the IFC at path. geometry: false skips meshes (faster; no GLB, no derived volumes). */
export async function loadModel(path: string, o: { geometry?: boolean } = {}): Promise<Model> {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  const hash = await fileHash(path);
  const hit = memory.get(hash);
  if (hit && (o.geometry === false || hit.glb)) { hit.index.sourcePath = path; return hit; }
  const base = join(cacheDir(), `${hash}-v${INDEX_FORMAT}`);
  if (existsSync(`${base}.json`) && (o.geometry === false || existsSync(`${base}.glb`))) {
    const index = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as IfcIndex;
    index.sourcePath = path;
    const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null);
    memory.set(hash, m);
    return m;
  }
  const geometry = o.geometry !== false;
  const { index } = await parseIfc(path, { geometry, ...(geometry ? { glbOut: `${base}.glb` } : {}) });
  writeFileSync(`${base}.json`, JSON.stringify(index));
  const m = wrap(hash, index, geometry && existsSync(`${base}.glb`) ? `${base}.glb` : null);
  memory.set(hash, m);
  return m;
}

/** A model by hash, from memory or the disk cache (null when it has to be opened again from its file). */
export function cachedModel(hash: string): Model | null {
  const hit = memory.get(hash);
  if (hit) return hit;
  for (const f of [`${hash}-v${INDEX_FORMAT}`]) {
    const base = join(cacheDir(), f);
    if (existsSync(`${base}.json`)) { const index = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as IfcIndex; const m = wrap(hash, index, existsSync(`${base}.glb`) ? `${base}.glb` : null); memory.set(hash, m); return m; }
  }
  return null;
}

/** Drop models no open project uses (the MCP server calls this when a project is closed or moved out). */
export function releaseModels(keep: Set<string>): void { for (const h of [...memory.keys()]) if (!keep.has(h)) memory.delete(h); }
export const modelBytes = (hashes: Iterable<string>) => { let n = 0; for (const h of hashes) n += memory.get(h)?.bytes ?? 0; return n; };
export const glbSize = (m: Model) => (m.glb && existsSync(m.glb) ? statSync(m.glb).size : 0);
