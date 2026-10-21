// After a model revision: which old element is which new one, so the 4D links survive. Same GlobalId first; else,
// within the same IFC class, the same name and storey (the nearest centroid when there are several), else the same
// shape (bounding-box size and position within tolerance). Elements matched nowhere lose their links, and are listed.
import type { IfcElement, IfcIndex } from './parse.ts';

export interface RelinkPlan { kept: number; matched: { from: string; to: string; how: 'name+storey' | 'shape'; class: string; name: string }[]; lost: { guid: string; class: string; name: string; storey: string }[]; mapping: Map<string, string> }

const dist = (a?: [number, number, number], b?: [number, number, number]) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
const size = (e: IfcElement) => (e.geom ? [e.geom.bbox[3] - e.geom.bbox[0], e.geom.bbox[4] - e.geom.bbox[1], e.geom.bbox[5] - e.geom.bbox[2]] : null);

/** Map the old model's elements (only those that carry links, if given) to the new model's. tol in metres. */
export function relinkPlan(oldIx: IfcIndex, newIx: IfcIndex, only?: Set<string>, tol = 0.05): RelinkPlan {
  const inNew = new Set(newIx.elements.map((e) => e.guid)), inOld = new Set(oldIx.elements.map((e) => e.guid));
  const fresh = new Map<string, IfcElement[]>(); // new elements whose GlobalId the old model did not have, by class
  for (const e of newIx.elements) if (!inOld.has(e.guid)) (fresh.get(e.ifcClass) ?? fresh.set(e.ifcClass, []).get(e.ifcClass)!).push(e);
  const taken = new Set<string>();
  const mapping = new Map<string, string>();
  const plan: RelinkPlan = { kept: 0, matched: [], lost: [], mapping };
  for (const e of oldIx.elements) {
    if (only && !only.has(e.guid)) continue;
    if (inNew.has(e.guid)) { plan.kept++; mapping.set(e.guid, e.guid); continue; }
    const pool = (fresh.get(e.ifcClass) ?? []).filter((x) => !taken.has(x.guid));
    const sameName = pool.filter((x) => x.name === e.name && x.storey === e.storey);
    let hit: IfcElement | undefined, how: 'name+storey' | 'shape' = 'name+storey';
    if (sameName.length === 1) hit = sameName[0];
    else if (sameName.length > 1) hit = sameName.reduce((b, x) => (dist(x.geom?.centroid, e.geom?.centroid) < dist(b.geom?.centroid, e.geom?.centroid) ? x : b));
    else {
      const s = size(e);
      const shape = s ? pool.filter((x) => { const t = size(x); return t != null && t.every((v, i) => Math.abs(v - s[i]) <= tol) && dist(x.geom!.centroid, e.geom!.centroid) <= Math.max(tol * 10, 0.5); }) : [];
      if (shape.length) { hit = shape.reduce((b, x) => (dist(x.geom?.centroid, e.geom?.centroid) < dist(b.geom?.centroid, e.geom?.centroid) ? x : b)); how = 'shape'; }
    }
    if (hit) { taken.add(hit.guid); mapping.set(e.guid, hit.guid); plan.matched.push({ from: e.guid, to: hit.guid, how, class: e.ifcClass, name: e.name }); }
    else plan.lost.push({ guid: e.guid, class: e.ifcClass, name: e.name, storey: e.storey });
  }
  return plan;
}
