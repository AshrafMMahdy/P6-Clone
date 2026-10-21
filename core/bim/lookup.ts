// Lookups over a model index, built once per index and shared by every caller: a map of millions of GlobalIds costs
// hundreds of MB, and each tool building its own ran the server out of memory on a big model. No Node imports: the
// desktop's renderer uses these too.
import type { IfcElement, IfcIndex } from './parse.ts';

const byGuidCache = new WeakMap<IfcIndex, Map<string, IfcElement>>();
/** GlobalId → element. */
export function elementsByGuid(ix: IfcIndex): Map<string, IfcElement> {
  let m = byGuidCache.get(ix);
  if (!m || m.size === 0 && ix.elements.length) { m = new Map(); for (const e of ix.elements) m.set(e.guid, e); byGuidCache.set(ix, m); }
  return m;
}
const byIdCache = new WeakMap<IfcIndex, Map<number, IfcElement>>();
/** Express id → element. */
export function elementsById(ix: IfcIndex): Map<number, IfcElement> {
  let m = byIdCache.get(ix);
  if (!m || m.size === 0 && ix.elements.length) { m = new Map(); for (const e of ix.elements) m.set(e.expressId, e); byIdCache.set(ix, m); }
  return m;
}
/** GlobalId → the element's place in index.elements (what the display tiles and the viewer's timeline count by); -1
 *  when the model has no such element. Compact elements know their place; plain ones (the desktop's renderer) get a map. */
const ordCache = new WeakMap<IfcIndex, Map<string, number>>();
export function ordinalOf(ix: IfcIndex): (guid: string) => number {
  if (typeof (ix.elements[0] as { _i?: number } | undefined)?._i === 'number') { const m = elementsByGuid(ix); return (g) => (m.get(g) as { _i?: number } | undefined)?._i ?? -1; }
  let m = ordCache.get(ix);
  if (!m) { const mm = new Map<string, number>(); ix.elements.forEach((e, i) => mm.set(e.guid, i)); ordCache.set(ix, m = mm); }
  const map = m;
  return (g) => map.get(g) ?? -1;
}
