// The model index in memory, compact enough for millions of elements in the MCP server's budget (a 2.5 million element
// model in about 600 MB, where plain objects took 3.4 GB). An element is a small object with its own GlobalId, express
// id, name, authored quantities and ordinal; everything elements share (class, storey, discipline, material, type,
// system, property sets, quantity and measure kinds, owner stamp) sits in one shared "extras" record per combination;
// the geometry fingerprints are one Float32Array for the whole model, relative to the model's origin. Each element
// still reads as an IfcElement (getters), JSON.stringify gives the plain object, and plainElement() gives it for spreads
// and structured clones (the desktop's IPC).
import { createHash } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { GeomFingerprint, IfcElement, IfcIndex, IfcOwner, QuantityKind } from './parse.ts';

/** Per ordinal: bbox (6), centroid (3) relative to origin, volume, triangles. NaN in the first slot: no geometry. */
export const GEOM_STRIDE = 11;
export interface GeomStore { rows: Float32Array | null; origin: [number, number, number] }
export const newGeomStore = (): GeomStore => ({ rows: null, origin: [Number.NaN, Number.NaN, Number.NaN] });

type Props = Record<string, string | number | boolean>;
type QInfo = NonNullable<IfcElement['quantityInfo']>;
type Measures = NonNullable<IfcElement['measures']>;
/** What elements share: one record per combination, every element of the combination points to it. */
export interface Extras {
  c: string; s: string; d: IfcElement['discipline']; m?: string; t?: string; y?: string;
  p: Props; q?: QInfo; me?: Measures; o?: IfcOwner;
  g: GeomStore;
}

const EMPTY: Record<string, never> = Object.freeze({}) as Record<string, never>;
export const emptyRecord = <T extends object>(): T => EMPTY as unknown as T;

export class Element implements IfcElement {
  guid: string;
  expressId: number;
  name: string;
  authored: Record<string, number>;
  /** the shared record of this element's class, storey, properties ... */
  _x: Extras;
  /** this element's place in index.elements (and in the geometry store) */
  _i: number;
  constructor(guid: string, expressId: number, name: string, authored: Record<string, number> | null, x: Extras, i: number) {
    this.guid = guid; this.expressId = expressId; this.name = name; this.authored = authored ?? EMPTY; this._x = x; this._i = i;
  }
  get ifcClass(): string { return this._x.c; }
  get storey(): string { return this._x.s; }
  get discipline(): IfcElement['discipline'] { return this._x.d; }
  get material(): string | undefined { return this._x.m; }
  get typeName(): string | undefined { return this._x.t; }
  get system(): string | undefined { return this._x.y; }
  get props(): Props { return this._x.p; }
  get quantityInfo(): QInfo | undefined { return this._x.q; }
  get measures(): Measures | undefined { return this._x.me; }
  get owner(): IfcOwner | undefined { return this._x.o; }
  get geom(): GeomFingerprint | null {
    const r = this._x.g.rows, k = this._i * GEOM_STRIDE;
    if (!r || k >= r.length || Number.isNaN(r[k])) return null;
    const [ox, oy, oz] = this._x.g.origin;
    return { bbox: [r[k] + ox, r[k + 1] + oy, r[k + 2] + oz, r[k + 3] + ox, r[k + 4] + oy, r[k + 5] + oz], centroid: [r[k + 6] + ox, r[k + 7] + oy, r[k + 8] + oz], volume: r[k + 9], triangles: r[k + 10] };
  }
  get derivedVolumeM3(): number | null { const r = this._x.g.rows, k = this._i * GEOM_STRIDE; return !r || k >= r.length || Number.isNaN(r[k]) || Number.isNaN(r[k + 9]) ? null : r[k + 9]; }
  get bbox(): [number, number, number, number, number, number] | undefined { return this.geom?.bbox; }
  /** Property sets, type, material and name hashed for comparison (computed when asked). */
  get psetHash(): string {
    const p = this.props;
    const hashable = { props: Object.fromEntries(Object.entries(p).sort(([x], [y]) => x.localeCompare(y))), typeName: this.typeName ?? '', material: this.material ?? '', name: this.name };
    return createHash('sha1').update(JSON.stringify(hashable)).digest('hex').slice(0, 16);
  }
  toJSON(): IfcElement { return plainElement(this); }
}

/** An element placed (and drawn) but given no derived volume: its geometry is a stand-in (a Revit element rvt-rs
 *  could only place as its bounding box). */
export function noVolume(e: IfcElement): void {
  if (!(e instanceof Element)) { e.derivedVolumeM3 = null; return; }
  const r = e._x.g.rows, k = e._i * GEOM_STRIDE;
  if (r && k < r.length) r[k + 9] = NaN;
}

/** The element as a plain object (for spreads, answers and structured clones). */
export function plainElement(e: IfcElement): IfcElement {
  if (!(e instanceof Element)) return e;
  const g = e.geom;
  return {
    guid: e.guid, expressId: e.expressId, ifcClass: e.ifcClass, name: e.name, storey: e.storey,
    ...(e.material ? { material: e.material } : {}), ...(e.typeName ? { typeName: e.typeName } : {}), ...(e.system ? { system: e.system } : {}),
    discipline: e.discipline, authored: { ...e.authored }, ...(e.quantityInfo ? { quantityInfo: e.quantityInfo } : {}), ...(e.measures ? { measures: e.measures } : {}),
    props: e.props, psetHash: e.psetHash, geom: g, derivedVolumeM3: e.derivedVolumeM3, ...(g ? { bbox: g.bbox } : {}), ...(e.owner ? { owner: e.owner } : {}),
  };
}

/** The shared records of an index's elements, interned by what they hold. */
export class ExtrasTable {
  readonly list: Extras[] = [];
  private byKey = new Map<string, Extras>();
  private ids = new Map<object, number>();
  readonly store: GeomStore;
  constructor(store: GeomStore) { this.store = store; }
  private id(o: object | undefined): number { if (!o) return 0; let n = this.ids.get(o); if (n == null) { n = this.ids.size + 1; this.ids.set(o, n); } return n; }
  get(x: Omit<Extras, 'g'>): Extras {
    const key = `${x.c}\u0001${x.s}\u0001${x.d}\u0001${x.m ?? ''}\u0001${x.t ?? ''}\u0001${x.y ?? ''}\u0001${this.id(x.p)}\u0001${this.id(x.q)}\u0001${this.id(x.me)}\u0001${this.id(x.o)}`;
    let hit = this.byKey.get(key);
    if (!hit) { hit = { ...x, g: this.store }; if (!x.m) delete hit.m; if (!x.t) delete hit.t; if (!x.y) delete hit.y; if (!x.q) delete hit.q; if (!x.me) delete hit.me; if (!x.o) delete hit.o; this.byKey.set(key, hit); this.list.push(hit); }
    return hit;
  }
}

/** Interns objects that hold the same content (merged property sets, quantity kinds), so equal ones are one object. */
export class Interner<T extends object> {
  private byKey = new Map<string, T>();
  get(o: T): T { const k = JSON.stringify(o); let hit = this.byKey.get(k); if (!hit) { hit = Object.keys(o).length ? o : (EMPTY as unknown as T); this.byKey.set(k, hit); } return hit; }
}

/** The geometry store of an index (its elements share it). */
export const geomStore = (ix: IfcIndex): GeomStore | null => { const e = ix.elements[0]; return e instanceof Element ? e._x.g : null; };

/** Room for the fingerprints of n elements (none yet: NaN). */
export function allocGeometry(st: GeomStore, n: number): void { st.rows = new Float32Array(n * GEOM_STRIDE).fill(Number.NaN); }
/** One element's fingerprint, in the model's units (scaleGeometry turns millimetres into metres afterwards). The first
 *  fingerprint fixes the origin: float32 offsets from it keep a tenth of a millimetre over kilometres, where absolute
 *  float32 coordinates of a georeferenced model (500,000 m east) would be centimetres off. */
export function putGeometry(st: GeomStore, ordinal: number, bbox: ArrayLike<number>, centroid: ArrayLike<number>, volume: number, triangles: number): void {
  const r = st.rows; if (!r) return;
  if (Number.isNaN(st.origin[0])) st.origin = [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2])];
  const [ox, oy, oz] = st.origin, k = ordinal * GEOM_STRIDE;
  r[k] = bbox[0] - ox; r[k + 1] = bbox[1] - oy; r[k + 2] = bbox[2] - oz; r[k + 3] = bbox[3] - ox; r[k + 4] = bbox[4] - oy; r[k + 5] = bbox[5] - oz;
  r[k + 6] = centroid[0] - ox; r[k + 7] = centroid[1] - oy; r[k + 8] = centroid[2] - oz; r[k + 9] = volume; r[k + 10] = triangles;
}
/** Model units to metres (a model with no unit and millimetre coordinates). */
export function scaleGeometry(st: GeomStore, s: number): void {
  const r = st.rows; if (!r || s === 1) return;
  for (let k = 0; k < r.length; k += GEOM_STRIDE) { if (Number.isNaN(r[k])) continue; for (let j = 0; j < 9; j++) r[k + j] *= s; r[k + 9] *= s ** 3; }
  st.origin = [st.origin[0] * s, st.origin[1] * s, st.origin[2] * s];
}
/** How many elements have a fingerprint. */
export function meshedCount(st: GeomStore | null): number { const r = st?.rows; if (!r) return 0; let n = 0; for (let k = 0; k < r.length; k += GEOM_STRIDE) if (!Number.isNaN(r[k])) n++; return n; }

/** A copy of a string that holds nothing else alive. A substring V8 cuts from the text it was read from (a "sliced"
 *  string, 13 characters and longer) keeps the whole text in memory: the GlobalIds and names of an index kept every
 *  megabyte the file was read in, half the index's memory. */
export const ownString = (s: string): string => (s.length < 13 ? s : LATIN1.test(s) ? Buffer.from(s, 'latin1').toString('latin1') : Buffer.from(s, 'utf16le').toString('utf16le'));
// (a string of one-byte characters copied as one byte a character: half the memory of a UTF-16 copy)
const LATIN1 = /^[\x00-\xff]*$/;

export type { QuantityKind };
export { elementsByGuid, elementsById } from './lookup.ts';

/** A full garbage collection now, so what a big pass left behind goes back to the system before the next step takes
 *  memory (V8 otherwise lets garbage grow towards its heap limit: an index of 2.5 million elements peaked at 1.6 GB of
 *  RSS for 450 MB of live data). Used between the steps of reading a big model; a few hundred ms each. */
let gcFn: (() => void) | null | undefined;
export function compactHeap(): void {
  if (gcFn === undefined) { try { setFlagsFromString('--expose-gc'); gcFn = runInNewContext('gc') as () => void; } catch { gcFn = null; } }
  gcFn?.();
}
