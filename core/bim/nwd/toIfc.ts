// Navisworks elements as IFC4, for the exports that deliver an IFC (the model itself is read without one: native.ts):
// project, site, building, a storey per level, each element in its IFC class with its type, material, property sets,
// the quantities Revit computed and its placed triangles as one face set. Written to disk as it is made, an element at a
// time. Element k is #(k + 1), as the model index has it (indexBuilder), so the links' express ids name it: the elements
// are written as #E<k + 1> and everything else from #1, and both are numbered on the way into the file (everything
// else after the last element), the storeys and relationships last, when every element is known.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import type { NwElement } from './elements.ts';
import { alive } from '../heartbeat.mjs';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** 16 bytes as an IFC GlobalId (22 characters of base 64, big-endian) */
export function compressGuid(bytes: Uint8Array): string {
  let x = 0n; for (const b of bytes) x = (x << 8n) | BigInt(b);
  let s = ''; for (let i = 0; i < 22; i++) { s = CH[Number(x % 64n)] + s; x /= 64n; }
  return s;
}
const madeGuid = (seed: string) => compressGuid(createHash('sha1').update(seed).digest().subarray(0, 16));
/** The GlobalId an element gets: Revit's own, else one made from its place in the file */
export const globalIdOf = (e: NwElement) => e.guid ?? madeGuid(e.key);

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
const real = (x: number) => { const s = String(Math.round(x * 1e6) / 1e6); return /[.eE]/.test(s) ? s.replace(/e/, 'E') : `${s}.`; };
/** A number as the IFC carries it (six decimals) */
export const sixDecimals = (x: number) => { const r = Math.round(x * 1e6) / 1e6; return r === 0 ? 0 : r; };

/** The IFC class of an element */
export const classOf = (e: NwElement) => (e.category && CLASS[e.category]) || 'IfcBuildingElementProxy';
/** Its storey: its Revit level, else its DWG layer */
export const storeyOf = (e: NwElement) => e.level || e.layer || '(no level)';
/** Its type: "Family:Type", or whichever of them it has */
export const typeLabelOf = (e: NwElement) => (e.family && e.type && e.type !== e.family ? `${e.family}:${e.type}` : (e.type ?? e.family ?? null));
/** Its property sets as the IFC carries them (with the mark that its shape is boxes) */
export const psetsOf = (e: NwElement, boxes: number): NwElement['psets'] => (boxes ? { ...e.psets, P6Clone: { Geometry: 'bounding boxes' } } : e.psets);
/** Its quantities as the IFC carries them */
export const quantitiesOf = (e: NwElement) => Object.entries(e.quantities).filter((q): q is [string, number] => Number.isFinite(q[1]));

/** an element's placed triangles in metres */
export type IfcShape = { positions: ArrayLike<number>; triangles: ArrayLike<number> } | null;

/** A writer of the IFC4 at path: add(element k, its pieces drawn as boxes, its triangles) in order, then finish() (the
 *  file is written beside its place and renamed into it: whole or absent; drop() when it is not finished). */
export function ifcWriter(path: string, o: { name: string; file: string }) {
  const body = `${path}.${process.pid}.body`, fd = openSync(body, 'w');
  let buf = '', id = 0, n = 0;
  const out = (s: string) => { buf += s; if (buf.length > 1 << 22) { writeSync(fd, buf); buf = ''; } };
  const add = (s: string) => { out(`#${++id}=${s};\n`); return id; };
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
  /** placed triangles as one triangulated face set */
  const body3d = (xyz: ArrayLike<number>, triangles: ArrayLike<number>) => {
    let p = '';
    for (let k = 0; k < xyz.length; k += 3) p += `${k ? ',' : ''}(${real(xyz[k])},${real(xyz[k + 1])},${real(xyz[k + 2])})`;
    const pts = add(`IFCCARTESIANPOINTLIST3D((${p}))`);
    let t = '';
    for (let k = 0; k < triangles.length; k += 3) t += `${k ? ',' : ''}(${triangles[k] + 1},${triangles[k + 1] + 1},${triangles[k + 2] + 1})`;
    const fs = add(`IFCTRIANGULATEDFACESET(#${pts},$,.T.,(${t}),$)`);
    const rep = add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','Tessellation',(#${fs}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  };
  // storeys (Revit levels, else DWG layers) with their elevations, types and materials: their members by element
  const elev = new Map<string, number | null>(), inStorey = new Map<string, number[]>(), byType = new Map<string, { cls: string; members: number[] }>(), byMaterial = new Map<string, number[]>();
  return {
    add(e: NwElement, k: number, boxes: number, sh: IfcShape): void {
      const guid = globalIdOf(e), cls = classOf(e), el = k + 1, storey = storeyOf(e);
      n = Math.max(n, el);
      if (!elev.has(storey) || (elev.get(storey) === null && e.levelElevationM !== null)) elev.set(storey, e.levelElevationM);
      const pl = place(); // every element is in a storey, placed absolutely
      const tail = THIRTEEN.has(cls) ? '$,$,$,$,$' : '$'; // after Tag: PredefinedType (doors and windows: height, width, type, operation, user operation)
      const typeLabel = typeLabelOf(e);
      const shape = sh?.triangles.length ? body3d(sh.positions, sh.triangles) : null;
      out(`#E${el}=${cls.toUpperCase()}(${esc(guid)},$,${esc(e.name)},$,${opt(typeLabel)},#${pl},${shape ? `#${shape}` : '$'},${e.revitId !== null ? esc(String(e.revitId)) : '$'},${tail});\n`);
      (inStorey.get(storey) ?? inStorey.set(storey, []).get(storey)!).push(el);
      if (typeLabel) { const t = byType.get(typeLabel) ?? byType.set(typeLabel, { cls, members: [] }).get(typeLabel)!; t.members.push(el); }
      if (e.material) (byMaterial.get(e.material) ?? byMaterial.set(e.material, []).get(e.material)!).push(el);
      // property sets (and the mark that the shape is boxes), then the quantities Revit computed
      for (const [set, props] of Object.entries(psetsOf(e, boxes))) {
        const ps = Object.entries(props).map(([k2, v]) => add(`IFCPROPERTYSINGLEVALUE(${esc(k2)},$,${typeof v === 'number' ? (Number.isInteger(v) ? `IFCINTEGER(${v})` : `IFCREAL(${real(v)})`) : typeof v === 'boolean' ? `IFCBOOLEAN(${v ? '.T.' : '.F.'})` : `IFCLABEL(${esc(String(v))})`},$)`));
        if (!ps.length) continue;
        const pset = add(`IFCPROPERTYSET(${esc(madeGuid(`${guid}:pset:${set}`))},$,${esc(set)},$,(${ps.map((p) => `#${p}`).join(',')}))`);
        add(`IFCRELDEFINESBYPROPERTIES(${esc(madeGuid(`${guid}:rel:${set}`))},$,$,$,(#E${el}),#${pset})`);
      }
      const q = quantitiesOf(e);
      if (q.length) {
        const qs = q.map(([k2, v]) => add(k2 === 'NetVolume' ? `IFCQUANTITYVOLUME('NetVolume',$,$,${real(v)},$)` : k2 === 'NetArea' ? `IFCQUANTITYAREA('NetArea',$,$,${real(v)},$)` : `IFCQUANTITYLENGTH('Length',$,$,${real(v)},$)`));
        const eq = add(`IFCELEMENTQUANTITY(${esc(madeGuid(`${guid}:qto`))},$,'Qto_Revit',$,'Revit',(${qs.map((x) => `#${x}`).join(',')}))`);
        add(`IFCRELDEFINESBYPROPERTIES(${esc(madeGuid(`${guid}:relq`))},$,$,$,(#E${el}),#${eq})`);
      }
    },
    finish(): void {
      const storeyId = new Map<string, number>();
      for (const [name, z] of [...elev].sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0) || a[0].localeCompare(b[0]))) {
        const pl = place(bPl);
        storeyId.set(name, add(`IFCBUILDINGSTOREY(${esc(madeGuid(`${o.file}:storey:${name}`))},$,${esc(name)},$,$,#${pl},$,$,.ELEMENT.,${z === null ? '$' : real(z)})`));
      }
      if (storeyId.size) add(`IFCRELAGGREGATES(${esc(madeGuid(`${o.file}:agg3`))},$,$,$,#${building},(${[...storeyId.values()].map((s) => `#${s}`).join(',')}))`);
      for (const [name, els] of inStorey) { const s = storeyId.get(name)!; add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${esc(madeGuid(`${o.file}:in:${s}`))},$,$,$,(${els.map((e) => `#E${e}`).join(',')}),#${s})`); }
      for (const [name, t] of byType) {
        const tcls = t.cls === 'IfcBuildingElementProxy' || THIRTEEN.has(t.cls) || t.cls === 'IfcFurniture' ? 'IfcBuildingElementProxyType' : `${t.cls}Type`;
        const ty = add(`${tcls.toUpperCase()}(${esc(madeGuid(`${o.file}:type:${name}`))},$,${esc(name)},$,$,$,$,$,$,.NOTDEFINED.)`);
        add(`IFCRELDEFINESBYTYPE(${esc(madeGuid(`${o.file}:reltype:${name}`))},$,$,$,(${t.members.map((e) => `#E${e}`).join(',')}),#${ty})`);
      }
      for (const [name, els] of byMaterial) {
        const m = add(`IFCMATERIAL(${esc(name)},$,$)`);
        add(`IFCRELASSOCIATESMATERIAL(${esc(madeGuid(`${o.file}:mat:${name}`))},$,$,$,(${els.map((e) => `#E${e}`).join(',')}),#${m})`);
      }
      writeSync(fd, buf); buf = ''; closeSync(fd);
      // into the file: the elements as #1..#n, everything else after them (references outside the strings only)
      const tmp = `${path}.${process.pid}.tmp`, ofd = openSync(tmp, 'w'), ifd = openSync(body, 'r');
      try {
        const stamp = new Date(0).toISOString().slice(0, 19); // the same file for the same input (cached by content)
        writeSync(ofd, `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\nFILE_NAME(${esc(o.name)},'${stamp}',('P6 Clone'),('P6 Clone'),'P6 Clone Navisworks reader','P6 Clone','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n`);
        const renumber = (line: string) => line.split("'").map((seg, i) => (i % 2 ? seg : seg.replace(/#(E?)(\d+)/g, (_, el: string, d: string) => `#${el ? d : Number(d) + n}`))).join("'");
        const chunk = Buffer.alloc(1 << 22);
        let rest = '', got: number;
        while ((got = readSync(ifd, chunk, 0, chunk.length, null)) > 0) {
          alive(); // a 4 MB piece copied and renumbered
          const lines = (rest + chunk.toString('latin1', 0, got)).split('\n');
          rest = lines.pop()!;
          writeSync(ofd, lines.map(renumber).join('\n') + '\n');
        }
        if (rest) writeSync(ofd, renumber(rest) + '\n');
        writeSync(ofd, 'ENDSEC;\nEND-ISO-10303-21;\n');
      } finally { closeSync(ifd); closeSync(ofd); rmSync(body, { force: true }); }
      renameSync(tmp, path);
    },
    /** a writer given up: its files go */
    drop(): void { try { closeSync(fd); } catch { /* closed */ } rmSync(body, { force: true }); rmSync(`${path}.${process.pid}.tmp`, { force: true }); },
  };
}
