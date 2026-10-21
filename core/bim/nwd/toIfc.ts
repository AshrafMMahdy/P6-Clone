// Navisworks elements as IFC4 (no geometry yet): project, site, building, a storey per level, each element in its IFC
// class with its type, material, property sets and the quantities Revit computed, so the IFC pipeline (element index,
// quantities, links, exports) reads a Navisworks file like any IFC.
import { createHash } from 'node:crypto';
import type { NwElement } from './elements.ts';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** 16 bytes as an IFC GlobalId (22 characters of base 64, big-endian) */
export function compressGuid(bytes: Uint8Array): string {
  let x = 0n; for (const b of bytes) x = (x << 8n) | BigInt(b);
  let s = ''; for (let i = 0; i < 22; i++) { s = CH[Number(x % 64n)] + s; x /= 64n; }
  return s;
}
const madeGuid = (seed: string) => compressGuid(createHash('sha1').update(seed).digest().subarray(0, 16));

// Revit category -> IFC4 class (args: 9 for most building elements, 13 for doors and windows)
const CLASS: Record<string, string> = {
  Walls: 'IfcWall', Floors: 'IfcSlab', Roofs: 'IfcRoof', Ceilings: 'IfcCovering', Doors: 'IfcDoor', Windows: 'IfcWindow',
  'Structural Columns': 'IfcColumn', Columns: 'IfcColumn', 'Structural Framing': 'IfcBeam', 'Structural Foundations': 'IfcFooting',
  Stairs: 'IfcStair', Railings: 'IfcRailing', 'Top Rails': 'IfcRailing', 'Curtain Panels': 'IfcPlate', 'Curtain Wall Mullions': 'IfcMember',
  Furniture: 'IfcFurniture', 'Lighting Fixtures': 'IfcLightFixture', 'Plumbing Fixtures': 'IfcSanitaryTerminal',
  Pipes: 'IfcPipeSegment', Ducts: 'IfcDuctSegment', 'Cable Trays': 'IfcCableCarrierSegment', Conduits: 'IfcCableCarrierSegment',
};
const THIRTEEN = new Set(['IfcDoor', 'IfcWindow']);

const esc = (s: string) => `'${[...s].map((c) => { const k = c.codePointAt(0)!; if (c === "'") return "''"; if (c === '\\') return '\\\\'; if (k < 32 || k > 126) return k > 0xffff ? `\\X4\\${k.toString(16).toUpperCase().padStart(8, '0')}\\X0\\` : `\\X2\\${k.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`; return c; }).join('')}'`;
const opt = (s: string | null | undefined) => (s ? esc(s) : '$');
const real = (x: number) => { const s = String(x); return /[.eE]/.test(s) ? s.replace(/e/, 'E') : `${s}.`; };

export function toIfc(elements: NwElement[], o: { name: string; file: string }): string {
  const lines: string[] = [];
  let id = 0;
  const add = (s: string) => { lines.push(`#${++id}=${s};`); return id; };
  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const axis = add(`IFCAXIS2PLACEMENT3D(#${origin},$,$)`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axis},$)`);
  const units = [add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'), add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')];
  const ua = add(`IFCUNITASSIGNMENT((${units.map((u) => `#${u}`).join(',')}))`);
  const project = add(`IFCPROJECT(${esc(madeGuid(`${o.file}:project`))},$,${esc(o.name)},$,$,$,$,(#${ctx}),#${ua})`);
  const place = (rel?: number) => add(`IFCLOCALPLACEMENT(${rel ? `#${rel}` : '$'},#${axis})`);
  const sitePl = place(), site = add(`IFCSITE(${esc(madeGuid(`${o.file}:site`))},$,'Site',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bPl = place(sitePl), building = add(`IFCBUILDING(${esc(madeGuid(`${o.file}:building`))},$,${esc(o.name)},$,$,#${bPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${esc(madeGuid(`${o.file}:agg1`))},$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES(${esc(madeGuid(`${o.file}:agg2`))},$,$,$,#${site},(#${building}))`);
  // storeys: Revit levels (by elevation), else DWG layers
  const storeyOf = (e: NwElement) => e.level ?? e.layer ?? '(no level)';
  const elev = new Map<string, number | null>();
  for (const e of elements) { const k = storeyOf(e); if (!elev.has(k) || (elev.get(k) === null && e.levelElevationM !== null)) elev.set(k, e.levelElevationM); }
  const storeyId = new Map<string, number>();
  for (const [name, z] of [...elev].sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0) || a[0].localeCompare(b[0]))) {
    const pl = place(bPl);
    storeyId.set(name, add(`IFCBUILDINGSTOREY(${esc(madeGuid(`${o.file}:storey:${name}`))},$,${esc(name)},$,$,#${pl},$,$,.ELEMENT.,${z === null ? '$' : real(z)})`));
  }
  if (storeyId.size) add(`IFCRELAGGREGATES(${esc(madeGuid(`${o.file}:agg3`))},$,$,$,#${building},(${[...storeyId.values()].map((s) => `#${s}`).join(',')}))`);
  const inStorey = new Map<number, number[]>(), byType = new Map<string, { cls: string; members: number[] }>(), byMaterial = new Map<string, number[]>();
  for (const e of elements) {
    const guid = e.guid ?? madeGuid(e.key);
    const cls = (e.category && CLASS[e.category]) || 'IfcBuildingElementProxy';
    const pl = place(storeyId.get(storeyOf(e)) ? undefined : bPl);
    const tail = THIRTEEN.has(cls) ? '$,$,$,$,$' : '$'; // after Tag: PredefinedType (doors and windows: height, width, type, operation, user operation)
    const typeLabel = e.family && e.type && e.type !== e.family ? `${e.family}:${e.type}` : (e.type ?? e.family ?? null);
    const el = add(`${cls.toUpperCase()}(${esc(guid)},$,${esc(e.name)},$,${opt(typeLabel)},#${pl},$,${e.revitId !== null ? esc(String(e.revitId)) : '$'},${tail})`);
    const s = storeyId.get(storeyOf(e))!; (inStorey.get(s) ?? inStorey.set(s, []).get(s)!).push(el);
    if (typeLabel) { const t = byType.get(typeLabel) ?? byType.set(typeLabel, { cls, members: [] }).get(typeLabel)!; t.members.push(el); }
    if (e.material) (byMaterial.get(e.material) ?? byMaterial.set(e.material, []).get(e.material)!).push(el);
    // property sets, then the quantities Revit computed
    for (const [set, props] of Object.entries(e.psets)) {
      const ps = Object.entries(props).map(([k, v]) => add(`IFCPROPERTYSINGLEVALUE(${esc(k)},$,${typeof v === 'number' ? (Number.isInteger(v) ? `IFCINTEGER(${v})` : `IFCREAL(${real(v)})`) : typeof v === 'boolean' ? `IFCBOOLEAN(${v ? '.T.' : '.F.'})` : `IFCLABEL(${esc(String(v))})`},$)`));
      if (!ps.length) continue;
      const pset = add(`IFCPROPERTYSET(${esc(madeGuid(`${guid}:pset:${set}`))},$,${esc(set)},$,(${ps.map((p) => `#${p}`).join(',')}))`);
      add(`IFCRELDEFINESBYPROPERTIES(${esc(madeGuid(`${guid}:rel:${set}`))},$,$,$,(#${el}),#${pset})`);
    }
    const q = Object.entries(e.quantities);
    if (q.length) {
      const qs = q.map(([k, v]) => add(k === 'NetVolume' ? `IFCQUANTITYVOLUME('NetVolume',$,$,${real(v!)},$)` : k === 'NetArea' ? `IFCQUANTITYAREA('NetArea',$,$,${real(v!)},$)` : `IFCQUANTITYLENGTH('Length',$,$,${real(v!)},$)`));
      const eq = add(`IFCELEMENTQUANTITY(${esc(madeGuid(`${guid}:qto`))},$,'Qto_Revit',$,'Revit',(${qs.map((x) => `#${x}`).join(',')}))`);
      add(`IFCRELDEFINESBYPROPERTIES(${esc(madeGuid(`${guid}:relq`))},$,$,$,(#${el}),#${eq})`);
    }
  }
  for (const [s, els] of inStorey) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${esc(madeGuid(`${o.file}:in:${s}`))},$,$,$,(${els.map((e) => `#${e}`).join(',')}),#${s})`);
  for (const [name, t] of byType) {
    const tcls = t.cls === 'IfcBuildingElementProxy' || THIRTEEN.has(t.cls) || t.cls === 'IfcFurniture' ? 'IfcBuildingElementProxyType' : `${t.cls}Type`;
    const ty = add(`${tcls.toUpperCase()}(${esc(madeGuid(`${o.file}:type:${name}`))},$,${esc(name)},$,$,$,$,$,$,.NOTDEFINED.)`);
    add(`IFCRELDEFINESBYTYPE(${esc(madeGuid(`${o.file}:reltype:${name}`))},$,$,$,(${t.members.map((e) => `#${e}`).join(',')}),#${ty})`);
  }
  for (const [name, els] of byMaterial) {
    const m = add(`IFCMATERIAL(${esc(name)},$,$)`);
    add(`IFCRELASSOCIATESMATERIAL(${esc(madeGuid(`${o.file}:mat:${name}`))},$,$,$,(${els.map((e) => `#${e}`).join(',')}),#${m})`);
  }
  const stamp = new Date(0).toISOString().slice(0, 19); // the same file for the same input (cached by content)
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\nFILE_NAME(${esc(o.name)},'${stamp}',('P6 Clone'),('P6 Clone'),'P6 Clone Navisworks reader','P6 Clone','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
