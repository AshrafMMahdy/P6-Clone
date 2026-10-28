// The model index on disk (format 10), written and read by the server (the cache), by the index worker (stepIndex's result, handed to
// the server through a file) and by the Navisworks reader. Moved out of model.ts so parse.ts can read a worker's index without
// a cycle.
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { compactHeap, Element, ExtrasTable, GEOM_STRIDE, geomStore, newGeomStore, type Extras, type GeomStore } from './element.ts';
import { alive } from './heartbeat.mjs';
import type { IfcElement, IfcIndex } from './parse.ts';

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
