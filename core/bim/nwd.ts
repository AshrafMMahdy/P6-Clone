// Navisworks files (.nwd, .nwc, .nwf) for 4D: read by the clone's own clean-room reader (nwd/), made into IFC4 once
// per file content (cached beside the IFC cache), then read like any IFC. An .nwf holds no model of its own: the
// .nwc / .nwd files it lists are read from beside it (or where it says they are) and joined.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileHash } from './model.ts';
import { readContainer, section, type NwContainer } from './nwd/container.ts';
import { decodeTree, type NwGroup } from './nwd/tree.ts';
import { elementsOf, type NwElement } from './nwd/elements.ts';
import { compressGuid, toIfc } from './nwd/toIfc.ts';
import { elementShapes } from './nwd/geometry.ts';
import { decodeBlock, geometryBlocks, type Mesh } from './nwd/mesh.ts';

const NWD_FORMAT = 5; // the conversion: any change to the reader bumps it (2: the Revit data in LcOaPartitionProps; 3: placed boxes; 4-5: meshes), so old conversions are not reused
const HEAD = '#LcUStream';

export function isNavisworks(path: string): boolean {
  if (!/\.nw[dcf]$/i.test(path) || !existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(HEAD.length); return readSync(fd, b, 0, b.length, 0) === b.length && b.toString('latin1') === HEAD; } finally { closeSync(fd); }
}

export interface NavisworksSource {
  format: 'Navisworks'; files: { file: string; revision: number | null; elements: number; read: boolean; units?: string; note?: string }[];
  elements: number; with_revit_ids: number; with_revit_guids: number;
  geometry: { elements_with_meshes: number; elements_with_boxes: number; note: string }; warnings: string[];
}

/** The GlobalIds Revit's IFC export writes, in the order the model tree's guid index counts (LcOpGuidStore: u32, u32
 *  count, then 16-byte GUIDs, little-endian as Windows writes them). */
function guidStore(c: NwContainer, max: number): string[] {
  const b = section(c, 'LcOpGuidStore', max);
  if (!b || b.length < 8) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint32(4, true), out: string[] = [];
  for (let i = 0; i < n && 8 + 16 * i + 16 <= b.length; i++) {
    const g = b.subarray(8 + 16 * i, 24 + 16 * i);
    // Windows GUID bytes: the first three fields little-endian
    out.push(compressGuid(Uint8Array.from([g[3], g[2], g[1], g[0], g[5], g[4], g[7], g[6], ...g.subarray(8)])));
  }
  return out;
}

/** The elements of one .nwd / .nwc. */
function readOne(path: string, max: number): { elements: NwElement[]; revision: number; units?: string } {
  const c = readContainer(new Uint8Array(readFileSync(path)));
  const lh = section(c, 'LcOpNwdLogicalHierarchy', max);
  if (!lh) return { elements: [], revision: c.revision };
  const pp = section(c, 'LcOaPartitionProps', max);
  const external = pp ? ((decodeTree(pp, { stream: true }).values ?? []) as NwGroup[]).filter((x) => x && (x as NwGroup).kind === 'group') : [];
  const tree = decodeTree(lh);
  const elements = elementsOf(tree, guidStore(c, max), basename(path), external);
  // geometry: each element's pieces as placed boxes, in metres (Revit exports keep Revit's feet; others are taken as metres)
  const fr = section(c, 'LcOpNwdFragments', max);
  const revit = elements.some((e) => e.revitId !== null || /^LcRevit/.test(e.node?.attr?.internal ?? ''));
  if (fr) {
    const scale = revit ? 0.3048 : 1;
    const geo = section(c, 'LcOpNwdGeometry', max);
    const blocks = geo ? geometryBlocks(geo) : null;
    const cache = new Map<number, Mesh | null | undefined>();
    const mesh = (n: number) => {
      if (!geo || !blocks || !blocks[n - 1]) return undefined;
      if (!cache.has(n)) { try { cache.set(n, decodeBlock(geo, blocks[n - 1].offset, blocks[n - 1].length)); } catch { cache.set(n, undefined); } }
      return cache.get(n);
    };
    for (const [i, s] of elementShapes(tree, decodeTree(fr, { fragments: true }).values ?? [], elements.map((e) => e.node!), mesh)) {
      elements[i].shape = { positions: s.positions.map((x) => x * scale), triangles: s.triangles, boxes: s.boxes };
    }
  }
  return { elements, revision: c.revision, units: revit ? 'feet (Revit)' : 'metres (taken as such: the file names no unit)' };
}

/** The files an .nwf lists (XRefTable), found beside it by name, else where it says. */
function listed(path: string, max: number): { file: string; at: string | null }[] {
  const c = readContainer(new Uint8Array(readFileSync(path)));
  const x = section(c, 'LcOpXRefTable', max);
  if (!x) return [];
  const text = new TextDecoder().decode(x), j = text.indexOf('{');
  let table: { OriginalPath?: string; RemappedPath?: string }[] = [];
  try { table = JSON.parse(text.slice(j, text.lastIndexOf('}') + 1)).Table ?? []; } catch { return []; }
  return table.map((t) => {
    const orig = t.RemappedPath || t.OriginalPath || '', name = orig.split(/[\\/]/).pop()!;
    const beside = join(dirname(path), name);
    return { file: name, at: existsSync(beside) ? beside : existsSync(orig) ? orig : null };
  });
}

export function readNavisworks(path: string, o: { maxBytes?: number } = {}): { elements: NwElement[]; source: NavisworksSource } {
  const max = o.maxBytes ?? 2048 * 1048576;
  const files: NavisworksSource['files'] = [], warnings: string[] = [];
  const elements: NwElement[] = [];
  const parts = /\.nwf$/i.test(path) ? listed(path, max) : [{ file: basename(path), at: path }];
  if (/\.nwf$/i.test(path) && !parts.length) warnings.push('the .nwf lists no model files');
  for (const p of parts) {
    if (!p.at) { files.push({ file: p.file, revision: null, elements: 0, read: false, note: 'not found beside the .nwf or at its saved path' }); continue; }
    try {
      const r = readOne(p.at, max);
      elements.push(...r.elements);
      files.push({ file: p.file, revision: r.revision, elements: r.elements.length, read: true, ...(r.units ? { units: r.units } : {}) });
    } catch (e) { files.push({ file: p.file, revision: null, elements: 0, read: false, note: (e as Error).message }); }
  }
  if (!files.some((f) => f.read)) throw new Error(files.map((f) => `${f.file}: ${f.note}`).join('; ') || 'nothing to read');
  for (const f of files) if (!f.read) warnings.push(`${f.file}: ${f.note}`);
  return {
    elements,
    source: {
      format: 'Navisworks', files, elements: elements.length,
      with_revit_ids: elements.filter((e) => e.revitId !== null).length, with_revit_guids: elements.filter((e) => e.guid).length,
      geometry: { elements_with_meshes: elements.filter((e) => e.shape && !e.shape.boxes).length, elements_with_boxes: elements.filter((e) => e.shape?.boxes).length, note: 'the triangles of each piece, placed; a piece whose geometry could not be read is its placed box (that element gives no derived volume)' }, warnings,
    },
  };
}

/** The IFC4 for a Navisworks file (made once per content) and what was read. */
export async function nwdToIfc(path: string): Promise<{ ifc: string; source: NavisworksSource }> {
  const dir = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache');
  mkdirSync(dir, { recursive: true });
  // an .nwf's content is its list; the models it lists are part of what it opens, so their hashes count too
  let key = await fileHash(path);
  if (/\.nwf$/i.test(path)) for (const p of listed(path, 64 * 1048576)) if (p.at) key += await fileHash(p.at);
  const base = join(dir, `${key.length > 32 ? (await import('node:crypto')).createHash('sha256').update(key).digest('hex').slice(0, 32) : key}-nw${NWD_FORMAT}`);
  if (!existsSync(`${base}.ifc`) || !existsSync(`${base}.json`)) {
    const { elements, source } = readNavisworks(path);
    const put = (file: string, text: string) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
    put(`${base}.ifc`, toIfc(elements, { name: basename(path).replace(/\.nw[dcf]$/i, ''), file: basename(path) }));
    put(`${base}.json`, JSON.stringify(source));
  }
  return { ifc: `${base}.ifc`, source: JSON.parse(readFileSync(`${base}.json`, 'utf8')) };
}
