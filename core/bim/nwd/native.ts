// Navisworks models read as they are, with no IFC in between (one is written only for the exports that deliver an IFC:
// writeIfc). The elements go straight into the model index, as the same records an IFC of them gives (nativeIndex); the
// geometry, each geometry block once with the placement of every piece that uses it, into the files the display tiler
// and the fingerprints read (the geometry worker's layout, geomWorker.mjs). The models of an .nwf are read one at a
// time; a section is inflated only when it is read, and the geometry a 64 KB stream at a time through a file on disk,
// so memory follows a model's tree, not its file.
import { closeSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openContainer, section, sectionPieces, type NwContainer } from './container.ts';
import { decodeTree, type NwGroup, type NwTree } from './tree.ts';
import { elementsOf, type NwElement } from './elements.ts';
import { blockTable, decodeBlock } from './mesh.ts';
import { BOX, boxCorners, piecesOf } from './geometry.ts';
import { classOf, compressGuid, globalIdOf, psetsOf, quantitiesOf, sixDecimals, storeyOf, typeLabelOf } from './toIfc.ts';
import { closed } from '../meshClosed.mjs';
import { alive, forgetRates, noteRate, step } from '../heartbeat.mjs';
import { disciplineOf } from '../stepIndex.ts';
import { Element, ExtrasTable, Interner, newGeomStore, ownString } from '../element.ts';
import type { IfcElement, IfcIndex, QuantityKind } from '../parse.ts';

/** A GUID as Windows writes it (the first three fields little-endian), as an IFC GlobalId */
export const windowsGuid = (g: Uint8Array) => compressGuid(Uint8Array.from([g[3], g[2], g[1], g[0], g[5], g[4], g[7], g[6], ...g.subarray(8)]));

/** The GlobalIds Revit's IFC export writes, in the order the model tree's guid index counts (LcOpGuidStore: u32, u32
 *  count, then 16-byte GUIDs, little-endian as Windows writes them). */
function guidStore(c: NwContainer, max: number): string[] {
  const b = section(c, 'LcOpGuidStore', max);
  if (!b || b.length < 8) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint32(4, true), out: string[] = [];
  for (let i = 0; i < n && 8 + 16 * i + 16 <= b.length; i++) out.push(windowsGuid(b.subarray(8 + 16 * i, 24 + 16 * i)));
  return out;
}

/** One .nwd / .nwc's elements (each with its tree item) and tree. */
export function modelIn(c: NwContainer, file: string, max: number): { elements: NwElement[]; revision: number; units?: string; tree?: NwTree; revit: boolean } {
  const lh = section(c, 'LcOpNwdLogicalHierarchy', max);
  if (!lh) return { elements: [], revision: c.revision, revit: false };
  const pp = section(c, 'LcOaPartitionProps', max);
  const external = pp ? ((decodeTree(pp, { stream: true }).values ?? []) as NwGroup[]).filter((x) => x && (x as NwGroup).kind === 'group') : [];
  const tree = decodeTree(lh);
  const elements = elementsOf(tree, guidStore(c, max), file, external);
  const revit = elements.some((e) => e.revitId !== null || /^LcRevit/.test(e.node?.attr?.internal ?? ''));
  return { elements, revision: c.revision, units: revit ? 'feet (Revit)' : 'metres (taken as such: the file names no unit)', tree, revit };
}

export interface NativePart { file: string; at: string | null; note?: string }
export interface NativeFile { file: string; revision: number | null; elements: number; read: boolean; units?: string; note?: string }
export interface NativeRead {
  files: NativeFile[];
  /** elements read, in all */
  elements: number;
  /** the run folder (geomWorker.mjs's layout), when the geometry was read */
  geometry: { dir: string; elements: number } | null;
}
/** an element's placed triangles in metres, Z up */
export type Shape = { positions: ArrayLike<number>; triangles: ArrayLike<number> };
/** Each element, as soon as its model is read (its geometry too): k, its number among all; boxes, its pieces drawn as
 *  boxes (their geometry could not be read); shape, its triangles (when the geometry is read). Nothing is kept of it
 *  after: the caller takes what it needs. */
export type EachElement = (e: NwElement, k: number, boxes: number, shape: (() => Shape | null) | null) => void;

const ACC = 13; // per element: vertices, corners, signed volume, bbox (6), sum of x, y, z, open
const PLACE = 18;
/** A placement (column-major, Z up, the file's units) in metres and Y up, as web-ifc gives a mesh's (and the tiles and
 *  fingerprints have it): (x, y, z) -> (x, z, -y) */
const yUp = (m: number[], scale: number) => { const o = m.map((x, i) => (i % 4 === 3 ? x : x * scale)); for (let j = 0; j < 16; j += 4) { const y = o[j + 1]; o[j + 1] = o[j + 2]; o[j + 2] = -y; } return o; };

/** Read the models (an .nwf's parts, or the one file), one at a time, each element handed to each; their geometry into
 *  dir when it is given. */
export function readNative(parts: NativePart[], o: { dir?: string; maxBytes?: number; progress?: (done: number, total: number, note: string) => void; each: EachElement }): NativeRead {
  const max = o.maxBytes ?? 2048 * 1048576;
  const files: NativeFile[] = [];
  let count = 0;
  const g = o.dir ? geometryOut(o.dir) : null;
  forgetRates('navisworks'); // this job's own rate starts with its first model
  for (const [k, p] of parts.entries()) {
    o.progress?.(k, parts.length, `reading ${p.file}`);
    step(`reading ${p.file}: unpacking and decoding the model tree`, { total: 0 });
    if (!p.at) { files.push({ file: p.file, revision: null, elements: 0, read: false, note: p.note ?? 'not found' }); continue; }
    let m: ReturnType<typeof modelIn>, shapes: ((e: number) => Shape | null) | null = null;
    const base = count;
    try {
      const c = openContainer(p.at), t0 = Date.now();
      m = modelIn(c, p.file, max);
      if (g && m.tree) { step(`reading ${p.file}: placing the geometry pieces`); shapes = g.model(c, m.tree, m.elements, base, m.revit ? 0.3048 : 1, max); }
      noteRate('navisworks', Date.now() - t0, statSync(p.at).size); // this job's own rate: the next model's bounds are sized from the slower of it and the benchmark's
    } catch (e) { files.push({ file: p.file, revision: null, elements: 0, read: false, note: (e as Error).message }); continue; }
    step(`reading ${p.file}: handing on the elements`, { total: m.elements.length });
    m.elements.forEach((e, i) => { delete e.node; o.each(e, base + i, g?.boxesOf(base + i) ?? 0, shapes ? () => shapes!(base + i) : null); });
    count += m.elements.length;
    files.push({ file: p.file, revision: m.revision, elements: m.elements.length, read: true, ...(m.units ? { units: m.units } : {}) });
  }
  return { files, elements: count, geometry: g ? { dir: o.dir!, elements: g.finish(count) } : null };
}

/** The run's files, written as the models are read: geoms.bin / geoms.meta (each distinct mesh once), places.bin (each
 *  piece: element, mesh, placement in metres), elems.meta (each element's fingerprint), geom.json. */
function geometryOut(dir: string) {
  const geoms = join(dir, 'geoms.bin'), gfd = openSync(geoms, 'w+'), pfd = openSync(join(dir, 'places.bin'), 'w+');
  const meta: number[] = [], shut: boolean[] = [];
  let offset = 0, placements = 0, maxAbsCoord = 0;
  let acc = new Float64Array(ACC * 1024);
  const boxCount = new Map<number, number>();
  const placeBuf = new Float64Array(PLACE * 4096);
  let placeN = 0;
  const flushPlaces = () => { if (placeN) writeSync(pfd, new Uint8Array(placeBuf.buffer, 0, placeN * PLACE * 8)); placeN = 0; };
  const put = (u8: Uint8Array) => { for (let d = 0; d < u8.length;) d += writeSync(gfd, u8, d, u8.length - d, offset + d); offset += u8.length; };
  const pad4 = () => { const pad = (4 - (offset % 4)) % 4; if (pad) put(new Uint8Array(pad)); };
  /** a distinct mesh, written once: its number */
  const addMesh = (pos: Float32Array, tri: Uint32Array) => {
    pad4(); const po = offset; put(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength));
    pad4(); const io = offset; put(new Uint8Array(tri.buffer, tri.byteOffset, tri.byteLength));
    meta.push(po, pos.length / 3, io, tri.length);
    shut.push(closed(pos, tri));
    return shut.length - 1;
  };
  // meshes placed again are read back from geoms.bin; the latest ones are kept (up to 64 MB)
  const kept = new Map<number, { pos: Float32Array; tri: Uint32Array }>();
  let keptBytes = 0;
  const keep = (k: number, m: { pos: Float32Array; tri: Uint32Array }) => {
    kept.set(k, m); keptBytes += m.pos.byteLength + m.tri.byteLength;
    for (const [j, x] of kept) { if (keptBytes <= 64 * 1048576) break; kept.delete(j); keptBytes -= x.pos.byteLength + x.tri.byteLength; }
  };
  const meshOf = (k: number) => {
    const hit = kept.get(k);
    if (hit) { kept.delete(k); kept.set(k, hit); return hit; }
    const [po, n, io, ni] = meta.slice(4 * k, 4 * k + 4);
    const pos = new Float32Array(n * 3), tri = new Uint32Array(ni);
    readSync(gfd, new Uint8Array(pos.buffer), 0, pos.byteLength, po);
    readSync(gfd, new Uint8Array(tri.buffer), 0, tri.byteLength, io);
    const m = { pos, tri }; keep(k, m); return m;
  };
  /** a piece of element e: mesh k placed by m (column-major, metres) */
  const place = (e: number, k: number, m: number[]) => {
    if (placeN * PLACE >= placeBuf.length) flushPlaces();
    const o = placeN * PLACE; placeBuf[o] = e; placeBuf[o + 1] = k; placeBuf.set(m, o + 2); placeN++; placements++;
    if (acc.length < (e + 1) * ACC) { const a = new Float64Array(Math.max(acc.length * 2, (e + 1) * ACC)); a.set(acc); acc = a; }
    const a = e * ACC, { pos, tri } = meshOf(k), n = pos.length / 3;
    if (!acc[a]) { acc[a + 3] = acc[a + 4] = acc[a + 5] = Infinity; acc[a + 6] = acc[a + 7] = acc[a + 8] = -Infinity; }
    const w = new Float64Array(n * 3);
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const tx = m[0] * x + m[4] * y + m[8] * z + m[12], ty = m[1] * x + m[5] * y + m[9] * z + m[13], tz = m[2] * x + m[6] * y + m[10] * z + m[14];
      w[v * 3] = tx; w[v * 3 + 1] = ty; w[v * 3 + 2] = tz;
      acc[a + 9] += tx; acc[a + 10] += ty; acc[a + 11] += tz;
      const big = Math.max(Math.abs(tx), Math.abs(ty), Math.abs(tz)); if (big > maxAbsCoord) maxAbsCoord = big;
      if (tx < acc[a + 3]) acc[a + 3] = tx; if (ty < acc[a + 4]) acc[a + 4] = ty; if (tz < acc[a + 5]) acc[a + 5] = tz;
      if (tx > acc[a + 6]) acc[a + 6] = tx; if (ty > acc[a + 7]) acc[a + 7] = ty; if (tz > acc[a + 8]) acc[a + 8] = tz;
    }
    let vol = 0;
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const i = tri[t] * 3, j = tri[t + 1] * 3, l = tri[t + 2] * 3;
      vol += (w[i] * (w[j + 1] * w[l + 2] - w[j + 2] * w[l + 1]) + w[i + 1] * (w[j + 2] * w[l] - w[j] * w[l + 2]) + w[i + 2] * (w[j] * w[l + 1] - w[j + 1] * w[l])) / 6;
    }
    acc[a] += n; acc[a + 1] += tri.length; acc[a + 2] += vol;
    if (!shut[k]) acc[a + 12] = 1;
  };
  return {
    /** one model's pieces (base, its first element's number among all; scale, its units to metres): its elements'
     *  placed triangles, Z up (for the IFC), read back when asked */
    model(c: NwContainer, tree: NwTree, els: NwElement[], base: number, scale: number, max: number): ((e: number) => Shape | null) | null {
      const fr = section(c, 'LcOpNwdFragments', max);
      if (!fr) return null;
      const r0 = placements;
      const fragments = decodeTree(fr, { fragments: true }).values ?? [];
      // the geometry section unpacked to disk a stream at a time; its block table is at its end
      const raw = join(dir, 'geometry.raw'), rfd = openSync(raw, 'w+');
      try {
        let size = 0;
        for (const piece of sectionPieces(c, 'LcOpNwdGeometry')) { for (let d = 0; d < piece.length;) d += writeSync(rfd, piece, d, piece.length - d, size + d); size += piece.length; }
        const at = (from: number, length: number) => { const b = Buffer.allocUnsafe(length); readSync(rfd, b, 0, length, from); return b; };
        let table: ReturnType<typeof blockTable> = null;
        for (let tail = Math.min(size, 16 << 20); size && !table; tail = Math.min(size, tail * 4)) { table = blockTable(at(size - tail, tail), size - tail); if (tail === size) break; }
        const block = new Map<number, number>(); // block number -> mesh (-1: lines or points, -2: not readable)
        const boxMesh = new Map<string, number>();
        piecesOf(tree, fragments, els.map((e) => e.node!), (e, n, bbox, m) => {
          let k = block.get(n);
          if (k === undefined) {
            k = -2;
            if (table && n >= 1 && n <= table.lengths.length) {
              try { const g = decodeBlock(at(table.offsets[n - 1], table.lengths[n - 1]), 0, table.lengths[n - 1]); k = g ? addMesh(g.positions, g.triangles) : -1; } catch { /* drawn as its box */ }
            }
            block.set(n, k);
          }
          if (k === -1) return;
          if (k === -2) {
            const key = bbox.join(',');
            k = boxMesh.get(key) ?? boxMesh.set(key, addMesh(Float32Array.from(boxCorners(bbox)), Uint32Array.from(BOX))).get(key)!;
            boxCount.set(base + e, (boxCount.get(base + e) ?? 0) + 1);
          }
          place(base + e, k, yUp(m, scale));
        });
      } finally { closeSync(rfd); rmSync(raw, { force: true }); }
      // this model's pieces, by element (their rows stay on disk)
      flushPlaces();
      const rows = new Map<number, number[]>(), row = new Float64Array(PLACE);
      const read = (r: number) => { readSync(pfd, new Uint8Array(row.buffer), 0, PLACE * 8, r * PLACE * 8); return row; };
      for (let r = r0; r < placements; r++) { const e = read(r)[0]; (rows.get(e) ?? rows.set(e, []).get(e)!).push(r); if ((r & 0xffff) === 0) alive(); }
      return (e) => {
        const list = rows.get(e);
        if (!list) return null;
        const pos: number[] = [], tri: number[] = [];
        for (const r of list) {
          const m = read(r), { pos: p, tri: t } = meshOf(m[1]), base = pos.length / 3;
          // back to Z up for the IFC: (x, y, z) -> (x, -z, y)
          for (let v = 0; v < p.length; v += 3) pos.push(m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + m[14], -(m[4] * p[v] + m[8] * p[v + 1] + m[12] * p[v + 2] + m[16]), m[3] * p[v] + m[7] * p[v + 1] + m[11] * p[v + 2] + m[15]);
          for (const x of t) tri.push(base + x);
        }
        return { positions: pos, triangles: tri };
      };
    },
    boxesOf: (e: number) => boxCount.get(e) ?? 0,
    /** close the files, write the fingerprints and the summary: the number of elements with geometry */
    finish(n: number): number {
      flushPlaces(); closeSync(pfd);
      step('measuring the elements (fingerprints)', { total: n });
      // an element with an open piece may still be closed as a whole (a steel section drawn face by face): its pieces
      // placed together are measured (one face set per element, as in its IFC)
      const open = new Map<number, number[]>();
      for (let e = 0; e < n && (e + 1) * ACC <= acc.length; e++) { if (acc[e * ACC] && acc[e * ACC + 12]) open.set(e, []); if ((e & 0xffff) === 0) alive(); }
      if (open.size) {
        const pf = openSync(join(dir, 'places.bin'), 'r'), chunk = new Float64Array(PLACE * 4096);
        try {
          for (let r = 0; ;) {
            const got = readSync(pf, new Uint8Array(chunk.buffer), 0, chunk.byteLength, r * PLACE * 8) / (PLACE * 8);
            if (!got) break;
            for (let j = 0; j < got; j++, r++) open.get(chunk[j * PLACE])?.push(r);
            alive();
          }
          const row = new Float64Array(PLACE);
          for (const [e, rows] of open) {
            alive();
            const pos: number[] = [], tri: number[] = [];
            for (const r of rows) {
              readSync(pf, new Uint8Array(row.buffer), 0, PLACE * 8, r * PLACE * 8);
              const { pos: p, tri: t } = meshOf(row[1]), m = row.subarray(2), base = pos.length / 3;
              for (let v = 0; v < p.length; v += 3) pos.push(m[0] * p[v] + m[4] * p[v + 1] + m[8] * p[v + 2] + m[12], m[1] * p[v] + m[5] * p[v + 1] + m[9] * p[v + 2] + m[13], m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + m[14]);
              for (const x of t) tri.push(base + x);
            }
            if (closed(pos, tri)) acc[e * ACC + 12] = 0;
          }
        } finally { closeSync(pf); }
      }
      closeSync(gfd);
      writeFileSync(join(dir, 'geoms.meta'), new Uint8Array(new Float64Array(meta).buffer));
      const rows: number[] = [];
      for (let e = 0; e < n && (e + 1) * ACC <= acc.length; e++) {
        const a = e * ACC, v = acc[a];
        if (!v) continue;
        rows.push(e, v, acc[a + 1] / 3, acc[a + 12] ? NaN : Math.abs(acc[a + 2]), acc[a + 3], acc[a + 4], acc[a + 5], acc[a + 6], acc[a + 7], acc[a + 8], acc[a + 9] / v, acc[a + 10] / v, acc[a + 11] / v);
      }
      writeFileSync(join(dir, 'elems.meta'), new Uint8Array(new Float64Array(rows).buffer));
      const meshed = rows.length / 13;
      writeFileSync(join(dir, 'geom.json'), JSON.stringify({ elements: meshed, placements, meshes: shut.length, failures: 0, maxAbsCoord, geomBytes: offset }));
      return meshed;
    },
  };
}

const UNITS: Record<QuantityKind, string> = { length: 'm', area: 'm²', volume: 'm³', count: 'no.', weight: 'kg', time: 's' };
const KIND: Record<string, QuantityKind> = { NetVolume: 'volume', NetArea: 'area', Length: 'length' };

/** The model index, an element at a time: the records an IFC of the elements gives (writeIfc, then the IFC index,
 *  stepIndex.ts), element k as express id k + 1. */
export function indexBuilder(o: { name: string; path: string }) {
  const store = newGeomStore(), extras = new ExtrasTable(store), qinfo = new Interner<NonNullable<IfcElement['quantityInfo']>>();
  const merged = new Map<string, Record<string, string | number | boolean>>();
  const storeys: string[] = [], seen = new Set<string>(), classCounts: Record<string, number> = {}, out: Element[] = [];
  let quantified = 0;
  return {
    add(e: NwElement, k: number, boxes: number): void {
      const cls = classOf(e), storey = ownString(storeyOf(e));
      if (!seen.has(storey)) { seen.add(storey); storeys.push(storey); }
      const props: Record<string, string | number | boolean> = {};
      for (const [set, bag] of Object.entries(psetsOf(e, boxes))) for (const [p, v] of Object.entries(bag)) {
        if (!p || (typeof v === 'number' && !Number.isFinite(v))) continue; // as the IFC carries it: no name, no value
        props[ownString(`${set || 'Pset'}.${p}`)] = typeof v === 'number' ? (Number.isInteger(v) ? v : sixDecimals(v)) : typeof v === 'string' ? ownString(v) : v;
      }
      const pkey = JSON.stringify(props);
      const p = merged.get(pkey) ?? merged.set(pkey, Object.keys(props).length ? props : (Object.freeze({}) as typeof props)).get(pkey)!;
      const q = quantitiesOf(e);
      const authored = q.length ? Object.fromEntries(q.map(([n, v]) => [n, sixDecimals(v)])) : null;
      const info = q.length ? qinfo.get(Object.fromEntries(q.map(([n]) => [n, { kind: KIND[n] ?? 'length', set: 'Qto_Revit' }]))) : undefined;
      if (q.length) quantified++;
      const tn = typeLabelOf(e), mat = e.material || undefined;
      const x = extras.get({ c: cls, s: storey, d: disciplineOf(cls, p, undefined), ...(mat ? { m: mat } : {}), ...(tn ? { t: tn } : {}), p, ...(info ? { q: info } : {}) });
      classCounts[cls] = (classCounts[cls] ?? 0) + 1;
      out[k] = new Element(ownString(globalIdOf(e)), k + 1, ownString(e.name), authored, x, k);
    },
    finish(): IfcIndex {
      merged.clear();
      return {
        sourcePath: o.path, schema: 'IFC4', lengthScale: 1, lengthScaleSource: 'unit-assignment', elements: out, storeys, classCounts,
        geometryFailures: 0, quantifiedElements: quantified, units: { ...UNITS },
        header: { timestamp: new Date(0).toISOString().slice(0, 19), author: 'P6 Clone', organization: 'P6 Clone', application: 'P6 Clone', project: o.name },
        parsedAt: new Date().toISOString(),
      };
    },
  };
}
