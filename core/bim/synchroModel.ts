// SYNCHRO project files (.sp) as a model: its 3D objects (the resources drawn with 3D entities) with their placed
// triangles, in metres, in the file's own world (Z up, as the IFC it was made from). The scene is the table "Entities":
// each entity a name, its source's id, a placement (a 4x4 matrix, row vectors; doubles from 6.3), the meshes it draws and
// its child entities; a mesh is drawn in place (its vertices and polygons) or is a reference to an entity of the table
// "IncludeLibrary" (a shape drawn once and placed many times, as a column type), which is drawn the same way. Every
// resource names the entities it is drawn with (synchro.ts). Layout learned from the files only (sample 4D/synchro, 5.1 to
// 6.5) and checked against the design IFC a SYNCHRO project was made from (Schependomlaan: each object's box against the
// IFC element's, 3,504 of 3,504 within 2 mm) and against the sizes objects are named by ("610 x 610mm" columns, 2,110 mm
// doors). The world's unit is the file's own setting (3DWorldSettings): 1 is millimetres, 3 metres; no other value has been
// seen in a file, so a file with another one is refused rather than drawn at a guessed size.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Earcut } from 'three/src/extras/Earcut.js';
import { alive } from './heartbeat.mjs';
import { inWorker } from './jobWorker.ts';
import { fileHash } from './model.ts';
import type { NwElement } from './nwd/elements.ts';
import { ifcWriter } from './nwd/toIfc.ts';
import { read4dWorkerPath } from './runtime.ts';
import { container, directory, fail, HDR, level, MAGIC, readSynchro, skip, skipTable, spGlobalId, str, TRL, u32, u8, uuid, type Cur, type SynchroFile } from './synchro.ts';

const ENT = 0x541a2a37, INLINE = 0x304a69b6, REF = 0xd06a30e7, LINES = 0x738472c6, FACES = 0xf2c08b8a, MARK = 0x2e24dd6e, WORLD = 0x5075d933;
const UNIT: Record<number, number> = { 1: 0.001, 3: 1 };

type Mat = number[];
interface Ent { guid: string; name: string; m: Mat | null; meshes: { v: Float32Array; tri: Uint32Array }[]; refs: string[]; kids: Ent[] }

/** A string, or an absent one (a 00 byte and 2 more: 5.1 writes it for the source id of an entity's parts). */
function looseStr(c: Cur): string { if (c.b[c.p] === 0) { skip(c, 3); return ''; } return str(c); }

/** Polygons as written (a vertex count, then the vertices; a negative count is a hole in the polygon before it) as
 *  triangles: a triangle as it is; a larger polygon, or one with holes, cut by earcut (three's) in the plane it lies in,
 *  each triangle kept facing the way the polygon faces (its Newell normal). */
export function triangulate(v: Float32Array, poly: Uint32Array, bad: { n: number }): Uint32Array {
  const out: number[] = [], nv = v.length / 3;
  const loops: number[][] = [];
  const flush = () => {
    if (!loops.length) return;
    const [outer, ...holes] = loops;
    loops.length = 0;
    if (!holes.length && outer.length === 3) { out.push(outer[0], outer[1], outer[2]); return; }
    let nx = 0, ny = 0, nz = 0;
    for (let a = 0; a < outer.length; a++) {
      const p = outer[a] * 3, q = outer[(a + 1) % outer.length] * 3;
      nx += (v[p + 1] - v[q + 1]) * (v[p + 2] + v[q + 2]); ny += (v[p + 2] - v[q + 2]) * (v[p] + v[q]); nz += (v[p] - v[q]) * (v[p + 1] + v[q + 1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const [i, j] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const all = [outer, ...holes].flat(), flat: number[] = [], starts: number[] = [];
    let at = outer.length;
    for (const h of holes) { starts.push(at); at += h.length; }
    for (const t of all) flat.push(v[t * 3 + i], v[t * 3 + j]);
    const tri = Earcut.triangulate(flat, starts, 2);
    for (let k = 0; k + 2 < tri.length; k += 3) {
      const a = all[tri[k]], b = all[tri[k + 1]], c = all[tri[k + 2]];
      const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
      const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
      const facing = (uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz;
      if (facing < 0) out.push(a, c, b); else out.push(a, b, c);
    }
  };
  for (let k = 0; k < poly.length;) {
    const n = poly[k++] | 0, size = Math.abs(n), ix = Array.from(poly.subarray(k, k + size));
    k += size;
    if (size < 3 || ix.length < size || ix.some((x) => x >= nv)) { bad.n++; continue; }
    if (n > 0) flush();
    else if (!loops.length) { bad.n++; continue; } // a hole with no polygon before it
    loops.push(ix);
  }
  flush();
  return Uint32Array.from(out);
}

function entTable(c: Cur, all: Map<string, Ent>, bad: { n: number }): Ent[] {
  if (u32(c) !== HDR) fail('entity table header');
  const out: Ent[] = [];
  for (let k = u32(c); k > 0; k--) out.push(entRow(c, all, bad));
  if (u32(c) !== TRL) fail('entity table trailer');
  return out;
}

/** One entity: its GUID and name, its source id, its placement, then its meshes and child entities in the order written
 *  (other nested tables, such as materials, are stepped over); it ends where the next entity or its table's end begins. */
function entRow(c: Cur, all: Map<string, Ent>, bad: { n: number }): Ent {
  if (u32(c) !== ENT) fail('entity row');
  skip(c, c.v >= 60 ? 8 : 16);
  const e: Ent = { guid: uuid(c), name: '', m: null, meshes: [], refs: [], kids: [] };
  e.name = looseStr(c);
  if (u8(c)) looseStr(c);
  if (u8(c)) {
    const d = c.v >= 63;
    e.m = Array.from({ length: 16 }, (_, k) => (d ? c.b.readDoubleLE(c.p + k * 8) : c.b.readFloatLE(c.p + k * 4)));
    skip(c, d ? 128 : 64);
  }
  const b = c.b;
  for (;;) {
    if (c.p + 4 > b.length) fail('entity past the end of its table');
    const x = b.readUInt32LE(c.p);
    if (x === ENT || x === TRL) break;
    if (x === HDR) {
      if (c.p + 12 <= b.length && b.readUInt32LE(c.p + 8) === ENT) { for (const k of entTable(c, all, bad)) e.kids.push(k); } else skipTable(c);
      continue;
    }
    if (x === INLINE) {
      skip(c, 4);
      if (b.readUInt32LE(c.p) === MARK) skip(c, 4);
      const nv = u32(c);
      skip(c, nv * 12);
      const v = new Float32Array(nv * 3);
      for (let k = 0; k < nv * 3; k++) v[k] = b.readFloatLE(c.p - nv * 12 + k * 4);
      if (b.readUInt32LE(c.p) === FACES) skip(c, 4);
      const ni = u32(c);
      skip(c, ni * 4);
      const poly = new Uint32Array(ni);
      for (let k = 0; k < ni; k++) poly[k] = b.readUInt32LE(c.p - ni * 4 + k * 4);
      e.meshes.push({ v, tri: triangulate(v, poly, bad) });
      continue;
    }
    if (x === REF) { skip(c, 4); e.refs.push(uuid(c)); continue; }
    if (x === LINES) { skip(c, 4); if (b.readUInt32LE(c.p) === MARK) skip(c, 4); skip(c, u32(c) * 12); continue; } // a polyline: no surface
    c.p++;
  }
  all.set(e.guid, e);
  return e;
}

/** The world's unit in metres, from the 3D world settings row (its magic, 16 bytes, 8 from 6.0, a GUID, a double, then
 *  the unit setting); a file without it, or with a setting no file read so far has used, is refused. */
export function worldScale(ws: Buffer | undefined, v: number): number {
  const at = 4 + (v >= 60 ? 8 : 16) + 16 + 8;
  if (!ws || ws.length < at + 4 || ws.readUInt32LE(0) !== WORLD) fail('The file has no 3D world settings (its unit), so its geometry cannot be sized.');
  const code = ws!.readUInt32LE(at);
  return UNIT[code] ?? fail(`The file's 3D unit is setting ${code}, which no SYNCHRO file read so far has used (1 is millimetres, 3 metres): its geometry is not drawn at a guessed size.`);
}

/** a · b for row vectors (p · a · b) */
function mul(a: Mat, b: Mat): Mat {
  const o = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[r * 4 + k] = a[r * 4] * b[k] + a[r * 4 + 1] * b[4 + k] + a[r * 4 + 2] * b[8 + k] + a[r * 4 + 3] * b[12 + k];
  return o;
}
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A SYNCHRO 3D object: a resource (what tasks are assigned), with the resource groups above it, or a part of the 3D scene
 *  no resource draws (a context model, a file of geometry that was never made into resources), with the scene entities
 *  above it; the triangles it is drawn with (metres, placed). */
export interface SynchroObject { uuid: string; name: string; resource: boolean; groups: string[]; positions: number[]; triangles: number[] }
export interface SynchroModel { file: SynchroFile; units: 'mm' | 'm'; objects: SynchroObject[]; notes: string[] }

/** The 3D objects of a SYNCHRO project, each with its triangles: its resources, then the scene entities no resource draws
 *  (each with only its own meshes: its child entities are objects of their own), so every triangle is drawn once.
 *  onObject is called per object, so a caller can write them out one at a time; objects then comes back empty. */
export function readSynchroModel(bytes: Uint8Array, onObject?: (o: SynchroObject) => void): SynchroModel {
  const file = readSynchro(bytes), notes: string[] = [];
  const box = container(bytes, notes, ['Entities', 'IncludeLibrary', '3DWorldSettings']);
  if (!box) fail('Not a SYNCHRO project file (no .sp header).');
  const v = level(box!.version, box!.schema);
  const scale = worldScale(box!.tables.get('3DWorldSettings'), v);
  const all = new Map<string, Ent>(), bad = { n: 0 }, scene: Ent[] = [];
  for (const name of ['IncludeLibrary', 'Entities']) {
    const t = box!.tables.get(name);
    if (!t) { if (name === 'Entities') notes.push('The file has no 3D entities: its resources have no geometry.'); continue; }
    const c: Cur = { b: t, p: 0, v, bad: 0 };
    try { const roots = entTable(c, all, bad); if (name === 'Entities') for (const r of roots) scene.push(r); }
    catch (e) { notes.push(`The ${name} table could not all be read (${(e as Error).message}); what was read before it is drawn.`); }
  }
  if (bad.n) notes.push(`${bad.n} polygons name vertices their mesh does not have and were left out.`);
  // the placement of each scene entity's parent (its world before its own matrix)
  const parentWorld = new Map<string, Mat>();
  const place = (e: Ent, w: Mat) => { parentWorld.set(e.guid, w); const m = e.m ? mul(e.m, w) : w; for (const k of e.kids) place(k, m); };
  for (const r of scene) place(r, IDENTITY);

  let missing = 0, unplaced = 0;
  const drawn = new Set<string>();
  const draw = (e: Ent, w: Mat, out: SynchroObject, path: Set<string>, kids = true) => {
    if (path.has(e.guid)) return; // a reference to a shape that is drawing it: no end
    path.add(e.guid);
    if (parentWorld.has(e.guid)) drawn.add(e.guid);
    const m = e.m ? mul(e.m, w) : w;
    for (const { v: vx, tri } of e.meshes) {
      const base = out.positions.length / 3;
      for (let k = 0; k < vx.length; k += 3) {
        const x = vx[k], y = vx[k + 1], z = vx[k + 2];
        out.positions.push((x * m[0] + y * m[4] + z * m[8] + m[12]) * scale, (x * m[1] + y * m[5] + z * m[9] + m[13]) * scale, (x * m[2] + y * m[6] + z * m[10] + m[14]) * scale);
      }
      for (const t of tri) out.triangles.push(base + t);
    }
    for (const r of e.refs) { const t = all.get(r); if (t) draw(t, m, out, path); else missing++; }
    if (kids) for (const k of e.kids) draw(k, m, out, path);
    path.delete(e.guid);
  };
  const res = new Map(file.resources.map((r) => [r.uuid, r]));
  const groups = (r: { parent: string | null }) => { const g: string[] = []; for (let p = r.parent; p; p = res.get(p)?.parent ?? null) g.unshift(res.get(p)?.name ?? ''); return g; };
  const objects: SynchroObject[] = [];
  for (const r of file.resources) {
    if (!r.entities.length) continue;
    const o: SynchroObject = { uuid: r.uuid, name: r.name, resource: true, groups: groups(r), positions: [], triangles: [] };
    for (const g of r.entities) {
      const e = all.get(g), w = parentWorld.get(g);
      if (!e || !w) { unplaced++; continue; }
      draw(e, w, o, new Set());
    }
    if (onObject) onObject(o); else objects.push(o);
  }
  // the scene no resource draws
  const rest = (e: Ent, w: Mat, above: string[]) => {
    if (!drawn.has(e.guid) && (e.meshes.length || e.refs.length)) {
      const o: SynchroObject = { uuid: e.guid, name: e.name, resource: false, groups: above, positions: [], triangles: [] };
      draw(e, w, o, new Set(), false);
      if (onObject) onObject(o); else objects.push(o);
    }
    const m = e.m ? mul(e.m, w) : w;
    for (const k of e.kids) rest(k, m, [...above, e.name]);
  };
  for (const r of scene) rest(r, IDENTITY, []);
  if (unplaced) notes.push(`${unplaced} entities that resources name are not in the file's 3D scene; those resources are drawn without them.`);
  if (missing) notes.push(`${missing} shapes the scene refers to are not in the file's library and were not drawn.`);
  return { file, units: scale === 1 ? 'm' : 'mm', objects, notes };
}

// ---- the model: an IFC4 of the 3D objects, made once per file content (in the 4D reader's own process), then read
// like any IFC (as a Revit file's conversion is, rvt.ts)

/** The conversion's format: a change to what it reads or writes bumps it, so older conversions are not reused. */
export const SP_FORMAT = 1;

/** What a SYNCHRO model's conversion read (the answer that opens the model says it). */
export interface SynchroSource {
  format: 'SYNCHRO'; version: string; units: 'mm' | 'm';
  /** resources drawn in 3D (what tasks are assigned) and parts of the scene no resource draws */
  objects: number; resources: number; scene_only: number; without_geometry: number;
  note: string; warnings: string[];
}

/** A SYNCHRO project file (.sp, by its header). */
export function isSynchro(path: string): boolean {
  if (!/\.sp$/i.test(path) || !existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(16); return readSync(fd, b, 0, 16, 0) === 16 && b.toString('hex') === MAGIC; } finally { closeSync(fd); }
}

/** Write the IFC4 of a SYNCHRO project's 3D objects at ifcPath (an object at a time): each in its group (the resource
 *  group, or the scene entity, above it) as its storey, with a property set SYNCHRO (Resource: whether tasks can be
 *  assigned it; Group: the groups above it). */
export function writeSynchroIfc(bytes: Uint8Array, ifcPath: string, file: string): SynchroSource {
  const w = ifcWriter(ifcPath, { name: file.replace(/\.sp$/i, ''), file, by: 'P6 Clone SYNCHRO reader' });
  let k = 0, resources = 0, empty = 0;
  try {
    const m = readSynchroModel(bytes, (o) => {
      alive();
      const e: NwElement = {
        guid: spGlobalId(o.uuid), key: o.uuid, name: o.name, category: null, family: null, type: null, level: null, levelElevationM: null,
        layer: o.groups.at(-1) || null, material: null, psets: { SYNCHRO: { Resource: o.resource, ...(o.groups.length ? { Group: o.groups.join(' / ') } : {}) } }, quantities: {}, revitId: null,
      };
      w.add(e, k++, 0, o.triangles.length ? { positions: o.positions, triangles: o.triangles } : null);
      if (o.resource) resources++;
      if (!o.triangles.length) empty++;
    });
    w.finish();
    return {
      format: 'SYNCHRO', version: m.file.version, units: m.units, objects: k, resources, scene_only: k - resources, without_geometry: empty,
      note: 'each object drawn with the triangles SYNCHRO keeps for it, placed, in metres; resources carry their own GUID as GlobalId, so import_4d of the same file links its tasks to them',
      warnings: [...m.file.notes, ...m.notes],
    };
  } catch (e) { w.drop(); throw e; }
}

const cacheDir = () => process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache');

/** The IFC4 of a SYNCHRO project (made once per file content, in the 4D reader's process, read4dWorker.ts) and what was
 *  read. */
export async function spToIfc(path: string): Promise<{ ifc: string; source: SynchroSource }> {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const hash = await fileHash(path), base = join(dir, `${hash}-sp${SP_FORMAT}`);
  if (existsSync(`${base}.ifc`) && existsSync(`${base}.json`)) {
    const now = new Date(); for (const x of ['.ifc', '.json']) try { utimesSync(`${base}${x}`, now, now); } catch { /* gone */ }
    return { ifc: `${base}.ifc`, source: JSON.parse(readFileSync(`${base}.json`, 'utf8')) as SynchroSource };
  }
  const worker = read4dWorkerPath();
  const source = worker
    ? await inWorker({ script: worker, job: { path, ifc: `${base}.ifc`, file: basename(path) }, what: 'The SYNCHRO reader', tried: 'one pass of the reader over the file in a process of its own', next: 'export the model from SYNCHRO as IFC and open that, with the schedule imported from the .sp' },
      (d) => JSON.parse(readFileSync(join(d, 'result.json'), 'utf8')) as SynchroSource)
    : writeSynchroIfc(new Uint8Array(readFileSync(path)), `${base}.ifc`, basename(path));
  writeFileSync(`${base}.json`, JSON.stringify(source));
  return { ifc: `${base}.ifc`, source };
}

/** Is this file's conversion already in the cache (then it is not read again)? */
export async function spCached(path: string): Promise<boolean> {
  const base = join(cacheDir(), `${await fileHash(path)}-sp${SP_FORMAT}`);
  return existsSync(`${base}.ifc`) && existsSync(`${base}.json`);
}

/** The memory the conversion takes (its process): measured with p6clone, Node 22.23, on six SYNCHRO files (5.1 to 6.5):
 *  a peak of 249 to 833 MB, about 210 MB plus 13 times the geometry tables inflated (Entities and IncludeLibrary,
 *  5.5 to 49 MB); those tables inflate to 3.9 to 5.7 times what they take in the file, so the need is taken from the
 *  bytes they take there, at 6 times: 210 MB + 78 x those bytes (every file measured is under it). */
export const SP_FIXED = 210 * 1048576, SP_PER_STORED_BYTE = 78;
export function synchroNeed(path: string): number {
  const fd = openSync(path, 'r'), size = fstatSync(fd).size;
  try {
    // the directory ends before the first table: read up to where the first entry says its table is
    const head = Buffer.alloc(Math.min(size, 1024));
    readSync(fd, head, 0, head.length, 0);
    const first = directory(head)?.dir[0]?.at ?? 0;
    const b = Buffer.alloc(Math.min(size, Math.max(first, head.length)));
    readSync(fd, b, 0, b.length, 0);
    const dir = directory(b)?.dir ?? [];
    let stored = 0;
    dir.forEach((t, k) => { if (t.name === 'Entities' || t.name === 'IncludeLibrary') stored += (k + 1 < dir.length ? dir[k + 1].at : size) - t.at; });
    return Math.round(SP_FIXED + stored * SP_PER_STORED_BYTE);
  } finally { closeSync(fd); }
}
