// Navisworks files (.nwd, .nwc, .nwf) for 4D: read by the clone's own clean-room reader (nwd/) as they are, straight
// into the model index and its display tiles (nwd/native.ts, in a process of its own: nwdWorker.ts), cached by the
// files' content. An IFC4 of the model is written only for the exports that deliver one (nwdToIfc). An .nwf holds no
// model of its own: the .nwc / .nwd files it lists are read from beside it (or where it says they are) and joined.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileHash } from './model.ts';
import { childV8Flags, heartbeatEnv, heartbeatWatcher, StuckError, workerFloorMs, type StuckInfo } from './liveness.ts';
import { pushAll } from '../arrays.ts';
import { openContainer, section } from './nwd/container.ts';
import { decodeTree, type NwNode, type NwTree } from './nwd/tree.ts';
import type { NwElement } from './nwd/elements.ts';
import { globalIdOf } from './nwd/toIfc.ts';
import { elementShapes } from './nwd/geometry.ts';
import { decodeBlock, geometryBlocks, type Mesh } from './nwd/mesh.ts';
import { decodePathMap, decodeSets, decodeTimeliner, type NwPathComponent, type NwTask } from './nwd/timeliner.ts';
import { modelIn, windowsGuid, type NativePart } from './nwd/native.ts';
import { runJob, type NwJob, type Progress } from './nwd/job.ts';
import { nwdWorkerPath } from './runtime.ts';

/** The reader's format: any change to what it reads bumps it, so older caches and IFCs are not reused (2: the Revit
 *  data in LcOaPartitionProps; 3: placed boxes; 4-5: meshes; 6: classes 0x4f, 0x10, 0x20; 7: files in files, lights,
 *  binary assets, DWG materials, older meshes; 8: read as it is, no IFC in between; element k is #(k + 1)) */
export const NWD_FORMAT = 8;
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
  /** the most memory the reading process took (MB), when it ran in a process of its own */
  peak_memory_mb?: number;
}

/** The elements of one .nwd / .nwc, each with its placed triangles (in memory: the in-process reader the TimeLiner and
 *  the tests use; a model is opened with native.ts). */
function readOne(path: string, max: number, o: { shapes?: boolean } = {}): { elements: NwElement[]; revision: number; units?: string; tree?: NwTree } {
  const c = openContainer(path);
  const { elements, revision, units, tree, revit } = modelIn(c, basename(path), max);
  if (!tree) return { elements, revision };
  // geometry: each element's pieces, placed, in metres (Revit exports keep Revit's feet; others are taken as metres)
  const fr = o.shapes === false ? null : section(c, 'LcOpNwdFragments', max);
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
  return { elements, revision, units, tree };
}

/** Where an .nwf's listed models may be read from. A server with a storage root sets it (fenceListedModels): then only
 *  the file beside the .nwf, and only when the fence allows it; never the path saved in the .nwf, which could name
 *  another user's files. Without one (the desktop) a model not beside the .nwf is read where the .nwf says. */
let fenceOf: () => ((path: string) => boolean) | null = () => null;
export function fenceListedModels(current: () => ((path: string) => boolean) | null): void { fenceOf = current; }

/** The files an .nwf lists (XRefTable), found beside it by name, else (unfenced) where it says. */
function listed(path: string, max: number): { file: string; at: string | null }[] {
  const fence = fenceOf();
  const c = openContainer(path);
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

/** The models a Navisworks file opens: an .nwf's (each found as listed()), else the file itself. */
function partsOf(path: string, max: number): { parts: NativePart[]; empty: boolean } {
  if (!/\.nwf$/i.test(path)) return { parts: [{ file: basename(path), at: path }], empty: false };
  const parts = listed(path, max).map((p) => ({ ...p, ...(p.at ? {} : { note: fenceOf() ? 'not found beside the .nwf' : 'not found beside the .nwf or at its saved path' }) }));
  return { parts, empty: !parts.length };
}

/** The compressed bytes of what a model's reading holds as objects (its tree, its Revit data, its pieces), per model. */
const TREE_SECTIONS = ['LcOpNwdLogicalHierarchy', 'LcOaPartitionProps', 'LcOpNwdFragments', 'LcOpGuidStore'];
function treeBytes(path: string): number[] {
  return partsOf(path, 64 * 1048576).parts.map((p) => {
    if (!p.at) return 0;
    try { return openContainer(p.at).sections.filter((s) => TREE_SECTIONS.some((n) => s.name === n || s.name.endsWith(`\\${n}`))).reduce((n, s) => n + s.length, 0); } catch { return 0; }
  });
}
/** Memory a Navisworks model takes to open (measured, docs/4d-tiles-contract.md "Memory"): the reader's process (a
 *  fixed part, the biggest model's tree as objects, and every model's elements, kept until the index is written), and the
 *  index this process then holds. */
export const NW_READER_FIXED = 200 * 1048576, NW_TREE_PER_BYTE = 40, NW_ELEMENTS_PER_BYTE = 9, NW_INDEX_PER_BYTE = 3;
export function navisworksNeed(path: string, geometry = true): { reader: number; index: number } {
  const per = treeBytes(path), all = per.reduce((a, b) => a + b, 0), most = Math.max(0, ...per);
  return { reader: Math.round(NW_READER_FIXED + most * NW_TREE_PER_BYTE + all * NW_ELEMENTS_PER_BYTE + (geometry ? 64 * 1048576 : 0)), index: Math.round(all * NW_INDEX_PER_BYTE + 16 * 1048576) };
}

/** The cache key of a Navisworks model: its content (an .nwf's with every model it lists) and the reader's format. */
export async function navisworksKey(path: string): Promise<string> {
  let key = await fileHash(path);
  if (/\.nwf$/i.test(path)) for (const p of listed(path, 64 * 1048576)) if (p.at) key += await fileHash(p.at);
  return createHash('sha256').update(`${key}:nw${NWD_FORMAT}`).digest('hex').slice(0, 32);
}

/** Read a Navisworks model into the model cache at base (<base>.ndjson, .geom, .tiles; what was read in <base>.nw.json). */
export async function cacheNavisworks(path: string, base: string, o: { geometry: boolean; tileBytes?: number; onProgress?: Progress }): Promise<NavisworksSource> {
  const { parts, empty } = partsOf(path, 2048 * 1048576);
  const name = basename(path).replace(/\.nw[dcf]$/i, '');
  const source = await runNavisworks({ kind: 'index', parts, empty, name, file: basename(path), path, base, geometry: o.geometry, ...(o.tileBytes ? { tileBytes: o.tileBytes } : {}) }, o.onProgress);
  writeFileSync(`${base}.nw.json`, JSON.stringify(source));
  return source;
}

/** The IFC4 for a Navisworks file (written once per content, streamed, for the exports that deliver an IFC) and what
 *  was read. */
export async function nwdToIfc(path: string): Promise<{ ifc: string; source: NavisworksSource }> {
  const dir = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `ifc-${await navisworksKey(path)}`); // not "<key>-": setAsideOld moves those of another format
  if (!existsSync(`${base}.ifc`) || !existsSync(`${base}.json`)) {
    const { parts, empty } = partsOf(path, 2048 * 1048576);
    const source = await runNavisworks({ kind: 'ifc', parts, empty, name: basename(path).replace(/\.nw[dcf]$/i, ''), file: basename(path), path, out: `${base}.ifc` });
    writeFileSync(`${base}.json`, JSON.stringify(source));
  }
  return { ifc: `${base}.ifc`, source: JSON.parse(readFileSync(`${base}.json`, 'utf8')) };
}

/** The reader's heap (MB): it holds a model tree as objects, and what it takes is reserved out of the clone's memory budget
 *  (P6CLONE_MEM_BUDGET_MB, 3072 when unset: the server's own default), so its heap follows that budget plus headroom for the
 *  runtime itself, as the server's does; never
 *  more than half the machine's memory (at most 16 GB), nor less than 1 GB. */
export function nwdHeapMb(budgetMb: number = Number(process.env.P6CLONE_MEM_BUDGET_MB) || 3072, ramBytes: number = totalmem()): number {
  const budget = Math.ceil(budgetMb) + NW_HEAP_HEADROOM_MB;
  return Math.max(1024, Math.min(16384, Math.floor((ramBytes / 1048576) * 0.5), budget));
}
const NW_HEAP_HEADROOM_MB = 512;

/** Run a read in the reader's own process (in this one when it is not there); its progress reported, its failure thrown. */
async function runNavisworks(job: NwJob, onProgress?: Progress): Promise<NavisworksSource> {
  const worker = nwdWorkerPath();
  if (!worker) return runJob(job, onProgress);
  const jobDir = mkdtempSync(join(tmpdir(), 'p6clone-nwjob-')), jobFile = join(jobDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
  try {
    const heap = nwdHeapMb();
    let stuckErr: StuckError | null = null;
    const err = await new Promise<string | null>((done) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heap}`, ...childV8Flags(), worker, jobFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...heartbeatEnv(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
      let text = '', out = '', stuck: StuckInfo | null = null;
      // heartbeatWatcher hands over what the reader printed besides its heartbeats: the progress lines
      const onText = (c: string) => {
        out += c;
        for (let i; (i = out.indexOf('\n')) >= 0; out = out.slice(i + 1)) { const m = /^progress (\d+) (\d+) (.*)$/.exec(out.slice(0, i)); if (m) void Promise.resolve(onProgress?.(Number(m[1]), Number(m[2]), m[3])).catch(() => {}); }
      };
      child.stderr.on('data', (c) => { text = (text + c).slice(-4000); });
      // no fixed time limit (owner rules 2026-10-27, 2026-10-28): the reader is watched through its heartbeats (heartbeat.mjs, liveness.ts) and ended
      // only after two windows in a row with no progress, or when one call that cannot report progress passes its work bound (P6CLONE_NWD_MINUTES, if set, is an optional
      // overall limit for an administrator who wants one; unset, there is none)
      const stop = heartbeatWatcher(child, { floorMs: workerFloorMs(), onText, onStuck: (i) => { stuck = i; child.kill(); } });
      const cap = Number(process.env.P6CLONE_NWD_MINUTES) > 0 ? setTimeout(() => child.kill(), Number(process.env.P6CLONE_NWD_MINUTES) * 60_000) : null;
      const end = () => { stop(); if (cap) clearTimeout(cap); };
      child.on('error', (e) => { end(); done(e.message); });
      // what it read is written last: a reader that wrote it finished, even if the process then fell over on its way out
      child.on('close', (code, signal) => { end(); done(existsSync(`${jobFile}.out.json`) ? null : stuck ? (stuckErr = new StuckError(stuck, { what: 'The Navisworks reader', tried: 'the reader reads each model of the file in turn and hands its elements on as soon as it is read; it was ended in the step named above', next: 'export the model from Navisworks or its authoring tool as smaller NWC or NWD files (one per discipline or level) or as an IFC and open those; for a federation (.nwf) open its models one at a time' })).message : code === 0 ? 'the Navisworks reader stopped without its answer' : (text.trim().split('\n').pop() || `the Navisworks reader stopped (${signal ?? code}${signal || code === null ? ': out of time or memory' : ''})`)); });
    });
    if (err) throw stuckErr ?? new Error(err);
    return JSON.parse(readFileSync(`${jobFile}.out.json`, 'utf8')) as NavisworksSource;
  } finally { rmSync(jobDir, { recursive: true, force: true }); }
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
  const c = openContainer(path);
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
