// Ported from the White Hat IQ platform's @whiq/ifc (shared/ifc, branch 33-chat-only).
import type { IfcElement, IfcIndex, IfcOwner } from './parse.ts';

export type ChangeKind = 'added' | 'removed' | 'modified' | 'reidentified';
export type ChangeWhat = 'geometry' | 'placement' | 'properties' | 'type' | 'material' | 'storey' | 'name';

export interface IfcChange {
  kind: ChangeKind;
  guid: string;
  /** For reidentified: the GUID it was matched to on the other side. */
  matchedGuid?: string;
  ifcClass: string;
  name: string;
  storey: string;
  discipline: IfcElement['discipline'];
  system?: string;
  what: ChangeWhat[];
  /** What moved, for the report: property key → [before, after]; geometry deltas in metres / m³. */
  detail: Record<string, [unknown, unknown]>;
  confidence: 'high' | 'low';
  reason?: string;
  owner?: IfcOwner;
}

export interface DiffOptions {
  /** Absolute geometric tolerance in metres (default 5 mm). */
  tol?: number;
  /** Relative volume tolerance (default 0.5 %). */
  volTol?: number;
}

export interface IfcDiff {
  revA: { path: string; schema: string; elements: number; header: IfcIndex['header'] };
  revB: { path: string; schema: string; elements: number; header: IfcIndex['header'] };
  tolerance: { metres: number; volume: number };
  summary: { added: number; removed: number; modified: number; reidentified: number; unchanged: number; lowConfidence: number };
  byDiscipline: Record<string, { added: number; removed: number; modified: number }>;
  byStorey: Record<string, { added: number; removed: number; modified: number }>;
  byClass: Record<string, { a: number; b: number; delta: number }>;
  /** Per IFC class: derived volume totals (m³) and every authored quantity summed, A vs B. */
  quantities: Record<string, { volumeA: number; volumeB: number; authored: Record<string, { a: number; b: number }> }>;
  changes: IfcChange[];
  /** What the tolerance absorbed: elements whose geometry differed only inside it. */
  noise: { withinTolerance: number; guidChurn: number };
  computedAt: string;
}

const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

function geomCompare(a: IfcElement, b: IfcElement, tol: number, volTol: number): { what: ChangeWhat[]; detail: Record<string, [unknown, unknown]>; near: boolean } {
  const detail: Record<string, [unknown, unknown]> = {};
  const what: ChangeWhat[] = [];
  if (!a.geom || !b.geom) {
    if (!!a.geom !== !!b.geom) { what.push('geometry'); detail.geometry = [a.geom ? 'present' : 'none', b.geom ? 'present' : 'none']; }
    return { what, detail, near: false };
  }
  const size = (g: NonNullable<IfcElement['geom']>) => [g.bbox[3] - g.bbox[0], g.bbox[4] - g.bbox[1], g.bbox[5] - g.bbox[2]];
  const sa = size(a.geom), sb = size(b.geom);
  const sizeDelta = Math.max(...sa.map((v, i) => Math.abs(v - sb[i])));
  const volA = a.geom.volume, volB = b.geom.volume;
  const volDelta = Math.abs(volA - volB);
  const volLimit = Math.max(volTol * Math.max(volA, volB), tol ** 3);
  const shapeChanged = sizeDelta > tol || volDelta > volLimit;
  const moveDelta = Math.max(...a.geom.centroid.map((v, i) => Math.abs(v - b.geom!.centroid[i])));
  const moved = moveDelta > tol;
  let near = false;
  if (shapeChanged) {
    what.push('geometry');
    if (sizeDelta > tol) detail.size_m = [sa.map((v) => round(v)), sb.map((v) => round(v))];
    if (volDelta > volLimit) detail.volume_m3 = [round(volA), round(volB)];
    if (sizeDelta < 3 * tol && volDelta < 3 * volLimit) near = true;
  }
  if (moved) {
    what.push('placement');
    detail.centroid_m = [a.geom.centroid.map((v) => round(v)), b.geom.centroid.map((v) => round(v))];
    if (moveDelta < 3 * tol) near = true;
  }
  return { what, detail, near };
}

function propCompare(a: IfcElement, b: IfcElement): { what: ChangeWhat[]; detail: Record<string, [unknown, unknown]> } {
  const what: ChangeWhat[] = [];
  const detail: Record<string, [unknown, unknown]> = {};
  if (a.psetHash !== b.psetHash) {
    const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
    for (const k of keys) if (a.props[k] !== b.props[k]) detail[k] = [a.props[k], b.props[k]];
    if (a.typeName !== b.typeName) { what.push('type'); detail.type = [a.typeName, b.typeName]; }
    if (a.material !== b.material) { what.push('material'); detail.material = [a.material, b.material]; }
    if (a.name !== b.name) { what.push('name'); detail.name = [a.name, b.name]; }
    if (Object.keys(detail).some((k) => !['type', 'material', 'name'].includes(k))) what.push('properties');
  }
  const qa = a.authored, qb = b.authored;
  for (const k of new Set([...Object.keys(qa), ...Object.keys(qb)])) {
    if (qa[k] !== qb[k]) { detail[`quantity.${k}`] = [qa[k], qb[k]]; if (!what.includes('properties')) what.push('properties'); }
  }
  if (a.storey !== b.storey) { what.push('storey'); detail.storey = [a.storey, b.storey]; }
  return { what, detail };
}

function sameShape(a: IfcElement, b: IfcElement, tol: number, volTol: number): boolean {
  if (a.ifcClass !== b.ifcClass || (a.typeName ?? '') !== (b.typeName ?? '')) return false;
  // Two shapeless elements (no geometry on either side) can only be told apart by name.
  if (!a.geom && !b.geom) return a.name === b.name;
  return geomCompare(a, b, tol, volTol).what.length === 0;
}

/**
 * Match on GlobalId, then classify. Unmatched GUIDs whose class, type and shape agree
 * within tolerance are export noise (GUID churn), reported as `reidentified` at low
 * confidence rather than as a removal plus an addition.
 */
export function diffIndexes(a: IfcIndex, b: IfcIndex, opts: DiffOptions = {}): IfcDiff {
  const tol = opts.tol ?? 0.005;
  const volTol = opts.volTol ?? 0.005;
  const byA = new Map(a.elements.map((e) => [e.guid, e]));
  const byB = new Map(b.elements.map((e) => [e.guid, e]));
  const changes: IfcChange[] = [];
  let unchanged = 0, withinTolerance = 0;
  const removed: IfcElement[] = [], added: IfcElement[] = [];

  for (const ea of a.elements) {
    const eb = byB.get(ea.guid);
    if (!eb) { removed.push(ea); continue; }
    const g = geomCompare(ea, eb, tol, volTol);
    const p = propCompare(ea, eb);
    const what = [...g.what, ...p.what];
    if (!what.length) {
      unchanged++;
      if (ea.geom && eb.geom && (ea.geom.volume !== eb.geom.volume || ea.geom.triangles !== eb.geom.triangles)) withinTolerance++;
      continue;
    }
    changes.push({
      kind: 'modified', guid: ea.guid, ifcClass: eb.ifcClass, name: eb.name || ea.name, storey: eb.storey, discipline: eb.discipline,
      ...(eb.system ? { system: eb.system } : {}),
      what, detail: { ...g.detail, ...p.detail },
      confidence: g.near && !p.what.length ? 'low' : 'high',
      ...(g.near && !p.what.length ? { reason: 'geometry moved by less than three tolerances — could be export noise' } : {}),
      ...(eb.owner ? { owner: eb.owner } : {}),
    });
  }
  for (const eb of b.elements) if (!byA.has(eb.guid)) added.push(eb);

  // GUID churn: pair removed↔added with the same class, type and shape.
  let guidChurn = 0;
  const addedLeft = new Set(added);
  for (const ea of removed) {
    // Prefer the candidate with the same name; fall back to shape alone.
    let hit: IfcElement | undefined;
    for (const eb of addedLeft) if (eb.name === ea.name && sameShape(ea, eb, tol, volTol)) { hit = eb; break; }
    if (!hit) for (const eb of addedLeft) if (sameShape(ea, eb, tol, volTol)) { hit = eb; break; }
    if (hit) {
      addedLeft.delete(hit);
      guidChurn++;
      const p = propCompare(ea, hit);
      changes.push({
        kind: 'reidentified', guid: ea.guid, matchedGuid: hit.guid, ifcClass: hit.ifcClass, name: hit.name || ea.name, storey: hit.storey, discipline: hit.discipline,
        what: p.what, detail: p.detail, confidence: 'low',
        reason: 'GlobalId changed but class, type and shape match within tolerance — re-exported, not redesigned',
        ...(hit.owner ? { owner: hit.owner } : {}),
      });
    } else {
      changes.push({ kind: 'removed', guid: ea.guid, ifcClass: ea.ifcClass, name: ea.name, storey: ea.storey, discipline: ea.discipline, ...(ea.system ? { system: ea.system } : {}), what: [], detail: {}, confidence: 'high', ...(ea.owner ? { owner: ea.owner } : {}) });
    }
  }
  for (const eb of addedLeft) {
    changes.push({ kind: 'added', guid: eb.guid, ifcClass: eb.ifcClass, name: eb.name, storey: eb.storey, discipline: eb.discipline, ...(eb.system ? { system: eb.system } : {}), what: [], detail: {}, confidence: 'high', ...(eb.owner ? { owner: eb.owner } : {}) });
  }

  const bump = (rec: Record<string, { added: number; removed: number; modified: number }>, key: string, kind: ChangeKind) => {
    const r = rec[key] ?? (rec[key] = { added: 0, removed: 0, modified: 0 });
    if (kind === 'added') r.added++; else if (kind === 'removed') r.removed++; else if (kind === 'modified') r.modified++;
  };
  const byDiscipline: IfcDiff['byDiscipline'] = {};
  const byStorey: IfcDiff['byStorey'] = {};
  for (const c of changes) { bump(byDiscipline, c.discipline, c.kind); bump(byStorey, c.storey || '(no storey)', c.kind); }

  const byClass: IfcDiff['byClass'] = {};
  for (const k of new Set([...Object.keys(a.classCounts), ...Object.keys(b.classCounts)])) {
    const ca = a.classCounts[k] ?? 0, cb = b.classCounts[k] ?? 0;
    byClass[k] = { a: ca, b: cb, delta: cb - ca };
  }
  const quantities: IfcDiff['quantities'] = {};
  const addQ = (idx: IfcIndex, side: 'a' | 'b') => {
    for (const e of idx.elements) {
      const q = quantities[e.ifcClass] ?? (quantities[e.ifcClass] = { volumeA: 0, volumeB: 0, authored: {} });
      if (e.derivedVolumeM3) { if (side === 'a') q.volumeA += e.derivedVolumeM3; else q.volumeB += e.derivedVolumeM3; }
      for (const [name, v] of Object.entries(e.authored)) {
        const r = q.authored[name] ?? (q.authored[name] = { a: 0, b: 0 });
        r[side] += v;
      }
    }
  };
  addQ(a, 'a'); addQ(b, 'b');
  for (const q of Object.values(quantities)) {
    q.volumeA = round(q.volumeA, 3); q.volumeB = round(q.volumeB, 3);
    for (const r of Object.values(q.authored)) { r.a = round(r.a, 3); r.b = round(r.b, 3); }
  }

  const order: Record<ChangeKind, number> = { removed: 0, added: 1, modified: 2, reidentified: 3 };
  changes.sort((x, y) => order[x.kind] - order[y.kind] || x.discipline.localeCompare(y.discipline) || x.storey.localeCompare(y.storey) || x.ifcClass.localeCompare(y.ifcClass));

  const count = (k: ChangeKind) => changes.filter((c) => c.kind === k).length;
  const brief = (i: IfcIndex) => ({ path: i.sourcePath, schema: i.schema, elements: i.elements.length, header: i.header });
  return {
    revA: brief(a), revB: brief(b),
    tolerance: { metres: tol, volume: volTol },
    summary: { added: count('added'), removed: count('removed'), modified: count('modified'), reidentified: count('reidentified'), unchanged, lowConfidence: changes.filter((c) => c.confidence === 'low').length },
    byDiscipline, byStorey, byClass, quantities, changes,
    noise: { withinTolerance, guidChurn },
    computedAt: new Date().toISOString(),
  };
}
