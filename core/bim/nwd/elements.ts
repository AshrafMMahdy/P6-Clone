// Navisworks model tree to elements: what a 4D schedule, a quantity surveyor and procurement need from each item
// (identity, class, level, family and type, material, properties, the quantities Revit computed). Clean-room.
//
// Revit exports put each element's own property group (Element: Category, Family, Type, Id, every parameter) either
// on its tree node (older files) or in the table LcOaPartitionProps, in tree order (newer files): those are matched to
// the elements in order, each to the next element of the same category, family and type.
import type { NwAttr, NwGroup, NwNode, NwProp, NwTree } from './tree.ts';
import { tick } from '../heartbeat.mjs';

export interface NwElement {
  /** the GlobalId Revit's own IFC export writes (from LcOpGuidStore), else null (one is made from the item's path) */
  guid: string | null;
  key: string; name: string; category: string | null; family: string | null; type: string | null;
  level: string | null; levelElevationM: number | null; layer: string | null; material: string | null;
  /** property sets: set name -> property -> value (Revit lengths, areas and volumes in metres) */
  psets: Record<string, Record<string, string | number | boolean>>;
  /** quantities Revit computed: m, m2, m3 */
  quantities: { Length?: number; NetArea?: number; NetVolume?: number };
  revitId: number | null;
  /** its tree item (for the geometry) */
  node?: NwNode;
  /** its triangles, placed, in metres (pieces that could not be read are their boxes: shape.boxes counts them) */
  shape?: { positions: number[]; triangles: number[]; boxes: number };
}

const FT = 0.3048;
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const revit = (a: NwAttr | null) => !!a?.internal && /^(lcldrevit|LcRevit)/.test(a.internal);
/** a property's value, in SI when Revit wrote it in feet (types 6 length, 10 area, 11 volume) */
function propValue(p: NwProp): string | number | boolean | null {
  const v = p.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return (v as NwAttr).display ?? null;
  if (typeof v === 'number' && revit(p.attr)) {
    if (p.type === 6) return round(v * FT);
    if (p.type === 10) return round(v * FT * FT);
    if (p.type === 11) return round(v * FT * FT * FT);
  }
  return v;
}
const isGroup = (x: unknown): x is NwGroup => !!x && typeof x === 'object' && (x as NwGroup).kind === 'group';
const isElementGroup = (g: NwGroup) => g.attr?.internal === 'LcRevitData_Element';
const isContainer = (n: NwNode) => n.kind === 'node' && (/(Layer|Collection|Partition)$/.test(n.attr?.internal ?? '') || n.attr?.display === 'File');
/** 'Level "L1", #30' -> L1 */
const quoted = (s: unknown) => (typeof s === 'string' ? /"([^"]*)"/.exec(s)?.[1] ?? s : null);
const LEVEL_PROPS = new Set(['Level', 'Base Constraint', 'Reference Level', 'Schedule Level']);

/** Put a property group's values on an element. */
function apply(e: NwElement, g: NwGroup): void {
  const set = g.attr?.display ?? g.name ?? 'Properties';
  const own = isElementGroup(g);
  const bag = (e.psets[set === 'Revit Material' && g.name ? `Material: ${g.name}` : set] ??= {});
  if (set === 'Revit Material' && g.name) e.material ??= g.name;
  for (const p of g.props) {
    const k = p.attr?.display ?? p.attr?.internal, v = propValue(p);
    if (!k || v === null) continue;
    if (!(k in bag) || p.type !== 8) bag[k] = v; // a plain value wins over an object's label of the same name
    if (!own) { if (k === 'Elevation' && p.type === 6 && typeof p.value === 'number' && /Constraint|Level/.test(set)) e.levelElevationM ??= round(p.value * FT); continue; }
    if (typeof v === 'number') {
      if (k === 'Volume' && p.type === 11) e.quantities.NetVolume = v;
      if (k === 'Area' && p.type === 10 && v > 0) e.quantities.NetArea = v;
      if (k === 'Length' && p.type === 6) e.quantities.Length = v;
      if (k === 'Id' && p.type === 2) e.revitId = v;
    }
    if (LEVEL_PROPS.has(k) && p.type === 8) e.level = quoted(v) ?? e.level;
    if (p.type === 4 && k === 'Category') e.category = String(v);
    if (p.type === 4 && k === 'Family') e.family = String(v);
    if (p.type === 4 && k === 'Type') e.type = String(v);
  }
}

export function elementsOf(tree: NwTree, guids: string[], source: string, external: NwGroup[] = []): NwElement[] {
  const out: NwElement[] = [];
  const visit = (n: NwNode, ctx: { level: string | null; layer: string | null; coll: Record<string, string>; path: string }) => {
    tick();
    const label = n.name ?? n.attr?.display ?? '';
    const path = `${ctx.path}/${label}`;
    if (isContainer(n)) {
      const next = { ...ctx, path, coll: { ...ctx.coll } };
      if (n.attr?.internal === 'LcRevitLayer') next.level = n.name;
      else if (/Layer$/.test(n.attr?.internal ?? '')) next.layer = n.name;
      else if (n.attr?.internal === 'LcRevitCollection' && n.attr.display) next.coll[n.attr.display] = n.name ?? '';
      for (const c of n.children) visit(c, next);
      return;
    }
    // an element: a Revit element, or the first item below the layers and collections
    const e: NwElement = {
      guid: n.guidIndex > 0 && guids[n.guidIndex - 1] ? guids[n.guidIndex - 1] : null, key: `${source}${path}#${out.length}`,
      name: label || 'Element', category: ctx.coll.Category ?? n.attr?.display ?? null, family: ctx.coll.Family ?? null, type: ctx.coll.Type ?? null,
      level: ctx.level, levelElevationM: null, layer: ctx.layer, material: null, psets: {}, quantities: {}, revitId: null, node: n,
    };
    const gs = n.values.filter(isGroup);
    for (const g of gs) apply(e, g);
    out.push(e);
    // elements inside an element (a railing's top rail) are elements of their own when Revit says so
    const nested = (c: NwNode): void => { if (c.values.some((v) => isGroup(v) && isElementGroup(v))) visit(c, { ...ctx, path }); else for (const d of c.children) nested(d); };
    if (gs.some(isElementGroup)) for (const c of n.children) nested(c);
  };
  for (const r of tree.roots) visit(r, { level: null, layer: null, coll: {}, path: '' });
  // newer Revit exports: the Element groups in LcOaPartitionProps, in tree order
  if (external.length) {
    const want = out.filter((e) => !e.psets.Element);
    let from = 0;
    for (const g of external.filter(isElementGroup)) {
      const p = Object.fromEntries(g.props.filter((x) => x.type === 4).map((x) => [x.attr?.display, x.value]));
      const same = (e: NwElement) => e.category === p.Category && (e.family === p.Family || !e.family) && (e.type === p.Type || !e.type);
      let i = want.findIndex((e, k) => k >= from && same(e));
      if (i < 0) i = want.findIndex((e) => !e.psets.Element && same(e));
      if (i < 0) continue;
      apply(want[i], g);
      from = i + 1;
    }
  }
  return out;
}
