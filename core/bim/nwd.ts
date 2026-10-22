// Navisworks files (.nwd, .nwc, .nwf) for 4D: read by the clone's own clean-room reader (nwd/), made into IFC4 once
// per file content (cached beside the IFC cache), then read like any IFC. An .nwf holds no model of its own: the
// .nwc / .nwd files it lists are read from beside it (or where it says they are) and joined.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileHash } from './model.ts';
import { pushAll } from '../arrays.ts';
import { readContainer, section, type NwContainer } from './nwd/container.ts';
import { decodeTree, type NwGroup, type NwNode, type NwTree } from './nwd/tree.ts';
import { elementsOf, type NwElement } from './nwd/elements.ts';
import { compressGuid, globalIdOf, toIfc } from './nwd/toIfc.ts';
import { elementShapes } from './nwd/geometry.ts';
import { decodeBlock, geometryBlocks, type Mesh } from './nwd/mesh.ts';
import { decodePathMap, decodeSets, decodeTimeliner, type NwPathComponent, type NwTask } from './nwd/timeliner.ts';

const NWD_FORMAT = 7; // the conversion: any change to the reader bumps it (2: the Revit data in LcOaPartitionProps; 3: placed boxes; 4-5: meshes; 6: classes 0x4f, 0x10, 0x20; 7: files in files, lights, binary assets, DWG materials, older meshes), so old conversions are not reused
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
/** A GUID as Windows writes it (the first three fields little-endian), as an IFC GlobalId */
const windowsGuid = (g: Uint8Array) => compressGuid(Uint8Array.from([g[3], g[2], g[1], g[0], g[5], g[4], g[7], g[6], ...g.subarray(8)]));

function guidStore(c: NwContainer, max: number): string[] {
  const b = section(c, 'LcOpGuidStore', max);
  if (!b || b.length < 8) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint32(4, true), out: string[] = [];
  for (let i = 0; i < n && 8 + 16 * i + 16 <= b.length; i++) {
    out.push(windowsGuid(b.subarray(8 + 16 * i, 24 + 16 * i)));
  }
  return out;
}

/** The elements of one .nwd / .nwc. */
function readOne(path: string, max: number, o: { shapes?: boolean } = {}): { elements: NwElement[]; revision: number; units?: string; tree?: NwTree } {
  const c = readContainer(new Uint8Array(readFileSync(path)));
  const lh = section(c, 'LcOpNwdLogicalHierarchy', max);
  if (!lh) return { elements: [], revision: c.revision };
  const pp = section(c, 'LcOaPartitionProps', max);
  const external = pp ? ((decodeTree(pp, { stream: true }).values ?? []) as NwGroup[]).filter((x) => x && (x as NwGroup).kind === 'group') : [];
  const tree = decodeTree(lh);
  const elements = elementsOf(tree, guidStore(c, max), basename(path), external);
  // geometry: each element's pieces as placed boxes, in metres (Revit exports keep Revit's feet; others are taken as metres)
  const fr = o.shapes === false ? null : section(c, 'LcOpNwdFragments', max);
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
  return { elements, revision: c.revision, units: revit ? 'feet (Revit)' : 'metres (taken as such: the file names no unit)', tree };
}

/** Where an .nwf's listed models may be read from. A server with a storage root sets it (fenceListedModels): then only
 *  the file beside the .nwf, and only when the fence allows it; never the path saved in the .nwf, which could name
 *  another user's files. Without one (the desktop) a model not beside the .nwf is read where the .nwf says. */
let fenceOf: () => ((path: string) => boolean) | null = () => null;
export function fenceListedModels(current: () => ((path: string) => boolean) | null): void { fenceOf = current; }

/** The bytes a Navisworks file brings to reading it: an .nwf's own and those of every model it lists that can be read. */
export function navisworksBytes(path: string): number {
  const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
  return size(path) + (/\.nwf$/i.test(path) ? listed(path, 64 * 1048576).reduce((n, p) => n + (p.at ? size(p.at) : 0), 0) : 0);
}

/** The files an .nwf lists (XRefTable), found beside it by name, else (unfenced) where it says. */
function listed(path: string, max: number): { file: string; at: string | null }[] {
  const fence = fenceOf();
  const c = readContainer(new Uint8Array(readFileSync(path)));
  const x = section(c, 'LcOpXRefTable', max);
  if (!x) return [];
  const text = new TextDecoder().decode(x), j = text.indexOf('{');
  let table: { OriginalPath?: string; RemappedPath?: string }[] = [];
  try { table = JSON.parse(text.slice(j, text.lastIndexOf('}') + 1)).Table ?? []; } catch { return []; }
  return table.map((t) => {
    const orig = t.RemappedPath || t.OriginalPath || '', name = orig.split(/[\\/]/).pop()!;
    const beside = join(dirname(path), name);
    if (fence) return { file: name, at: name && existsSync(beside) && fence(beside) ? beside : null };
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
    if (!p.at) { files.push({ file: p.file, revision: null, elements: 0, read: false, note: fenceOf() ? 'not found beside the .nwf' : 'not found beside the .nwf or at its saved path' }); continue; }
    try {
      const r = readOne(p.at, max);
      pushAll(elements, r.elements); // (an argument spread overflows the stack past ~100,000)
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

export interface NavisworksTimeliner {
  tasks: NwTask[];
  /** each task's explicit selection as GlobalIds (null: not resolved) */
  taskGuids: (string[] | null)[];
  /** the selection sets as GlobalIds (null: a search set, or a set whose model was not read) */
  sets: { name: string; guids: string[] | null }[];
  notes: string[];
}

/** The items of a model in tree pre-order (the file is 0) and the GlobalIds of the elements an item selects: the
 *  element it is part of and every element below it. */
function itemsOf(tree: NwTree, elements: NwElement[]) {
  const el = new Map(elements.map((e, i) => [e.node!, i])), nodes: (NwNode | null)[] = [null], own = [-1], end: number[] = [];
  const at = new Map<NwNode, number>();
  const walk = (n: NwNode, e: number) => { const k = nodes.length, o = el.get(n) ?? e; nodes.push(n); at.set(n, k); own[k] = o; for (const c of n.children) walk(c, o); end[k] = nodes.length; };
  for (const r of tree.roots) walk(r, -1);
  end[0] = nodes.length;
  const guids = (k: number): string[] | null => {
    if (!Number.isInteger(k) || k < 0 || k >= nodes.length) return null;
    const pick = new Set<number>(own[k] >= 0 ? [own[k]] : []);
    for (let j = k; j < end[k]; j++) { const i = el.get(nodes[j]!); if (i !== undefined) pick.add(i); }
    return [...pick].map((i) => globalIdOf(elements[i]));
  };
  return { guids, at };
}

/** The TimeLiner of a Navisworks file: its tasks, and each task's selection and each selection set as the GlobalIds
 *  the file's model carries once opened (an .nwf's selections name items by path in the models it lists). */
export function readNavisworksTimeliner(path: string, o: { maxBytes?: number } = {}): NavisworksTimeliner {
  const max = o.maxBytes ?? 2048 * 1048576, notes: string[] = [];
  const c = readContainer(new Uint8Array(readFileSync(path)));
  const tl = section(c, 'LcTlTimelinerElement', max), ss = section(c, 'LcOpSelectionSetsElement', max);
  const tasks = tl ? decodeTimeliner(tl) : [], rawSets = ss ? decodeSets(ss) : [];
  if (!tasks.length) notes.push(tl ? 'The TimeLiner has no tasks the reader could read.' : 'The file has no TimeLiner.');
  const nwf = /\.nwf$/i.test(path);
  const models: { file: string; items: ReturnType<typeof itemsOf>; tree: NwTree; byGuid: Map<string, string> }[] = [];
  const needed = rawSets.some((s) => s.items?.length) || tasks.some((t) => t.items.length);
  if (needed) {
    for (const p of nwf ? listed(path, max) : [{ file: basename(path), at: path }]) {
      if (!p.at) { notes.push(`${p.file}: not found${fenceOf() ? ' beside the .nwf' : ' beside the .nwf or at its saved path'}, so its selections are not resolved.`); continue; }
      try { const r = readOne(p.at, max, { shapes: false }); if (r.tree) models.push({ file: p.file, items: itemsOf(r.tree, r.elements), tree: r.tree, byGuid: new Map(r.elements.filter((e) => e.guid).map((e) => [e.guid!, globalIdOf(e)])) }); } catch (e) { notes.push(`${p.file}: ${(e as Error).message}`); }
    }
  }
  // an .nwf: item k is path-map component k - 1, found by position and name from a model's root
  const comps: NwPathComponent[] = nwf ? decodePathMap(section(c, 'LcOpNwfPathMap', max) ?? new Uint8Array()) : [];
  const nodeOf = (k: number, tree: NwTree): NwNode | null => {
    const chain: NwPathComponent[] = [];
    for (let i = k - 1, n = 0; i >= 0 && n < 100; i = comps[i].parent, n++) { if (!comps[i]) return null; chain.unshift(comps[i]); if (comps[i].parent < 0) break; }
    let level = tree.roots, node: NwNode | null = null;
    for (const p of chain) {
      node = level[p.position]?.name === p.name ? level[p.position] : level.find((x) => x.name === p.name && (x.attr?.display ?? null) === p.attr) ?? null;
      if (!node) return null;
      level = node.children;
    }
    return node;
  };
  const resolve = (refs: number[]): string[] | null => {
    if (!models.length) return null;
    const out = new Set<string>();
    let missed = 0;
    for (const k of refs) {
      let g: string[] | null = null;
      if (!nwf) g = models[0].items.guids(k);
      else {
        // an item the map names by its GUID, or a part of one (a piece of its geometry), is that element; else it is
        // found by its path
        let c = comps[k - 1];
        for (let n = 0; c && !c.guid && c.parent >= 0 && n < 100; n++) c = comps[c.parent];
        const id = c?.guid ? windowsGuid(c.guid) : null;
        for (const m of models) { if (id && m.byGuid.has(id)) { g = [m.byGuid.get(id)!]; break; } const n = nodeOf(k, m.tree); if (n) { g = m.items.guids(m.items.at.get(n)!); break; } }
      }
      if (g) g.forEach((x) => out.add(x)); else missed++;
    }
    if (missed) notes.push(`${missed} selected item(s) were not found in the model.`);
    return [...out];
  };
  const sets = rawSets.map((s) => ({ name: s.name, guids: s.items ? resolve(s.items) : null }));
  const search = rawSets.filter((s) => !s.items).map((s) => s.name);
  if (search.length) notes.push(`${search.length} search set(s) are named but their conditions are not read: ${search.slice(0, 10).join(', ')}${search.length > 10 ? '…' : ''}.`);
  return { tasks, taskGuids: tasks.map((t) => (t.items.length ? resolve(t.items) : null)), sets, notes };
}
