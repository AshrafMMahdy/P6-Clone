// A synthetic IFC4 building of any size, written as a stream (a 1.7 GB file never sits in memory), for the memory and
// time measurements of big models (scripts/measure-ifc.ts) and the tests. What a real export has, in proportion:
//   - storeys of up to 50,000 elements each, one IfcRelContainedInSpatialStructure per storey;
//   - walls (70 %): extruded rectangles, every one a different length (no two meshes alike: the worst case for size);
//   - columns (20 %): IfcMappedItem of one of 20 column types (the same mesh placed again: what instancing is for);
//   - slabs (10 %): extruded rectangles of different sizes;
//   - one wall in 1,000 with an opening cut into it (IfcOpeningElement, IfcRelVoidsElement);
//   - property sets, types and materials shared by 1,000 elements each; an IfcElementQuantity on one element in 4.
// Usage: node scripts/make-ifc.ts <out.ifc> <elements> [--same-walls]   (--same-walls: every wall the same mesh)
// About 680 bytes per element: 2.5 million elements make 1.7 GB.
import { closeSync, openSync, statSync, writeSync } from 'node:fs';

export interface MakeIfcOptions { sameWalls?: boolean; storeySize?: number }

/** Write the model; returns its size in bytes and the element count. */
export function makeIfc(out: string, elements: number, o: MakeIfcOptions = {}): { bytes: number; elements: number; storeys: number } {
  const fd = openSync(out, 'w');
  let buf = '';
  const put = (s: string) => { buf += s; buf += '\n'; if (buf.length > 1 << 22) { writeSync(fd, buf); buf = ''; } };
  let id = 100;
  const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  const guid = (k: number) => { let s = ''; for (let i = 0; i < 22; i++) { s = B64[k % 64] + s; k = Math.floor(k / 64); } return s; };
  let g = 1;
  const storeySize = o.storeySize ?? 50_000;
  const nStoreys = Math.max(1, Math.ceil(elements / storeySize));
  put('ISO-10303-21;');
  put('HEADER;');
  put("FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');");
  put(`FILE_NAME('synthetic.ifc','2026-10-21T00:00:00',('P6 clone'),('make-ifc'),'make-ifc','make-ifc','');`);
  put("FILE_SCHEMA(('IFC4'));");
  put('ENDSEC;');
  put('DATA;');
  put("#1=IFCPERSON($,'Synth','Model',$,$,$,$,$);");
  put("#2=IFCORGANIZATION($,'P6 clone',$,$,$);");
  put('#3=IFCPERSONANDORGANIZATION(#1,#2,$);');
  put("#4=IFCAPPLICATION(#2,'1.0','make-ifc','make-ifc');");
  put('#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,1792540800);');
  put('#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);');
  put('#7=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);');
  put('#8=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);');
  put('#9=IFCUNITASSIGNMENT((#6,#7,#8));');
  put('#10=IFCCARTESIANPOINT((0.,0.,0.));');
  put('#11=IFCDIRECTION((0.,0.,1.));');
  put('#12=IFCDIRECTION((1.,0.,0.));');
  put('#13=IFCAXIS2PLACEMENT3D(#10,$,$);');
  put("#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);");
  put("#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);");
  put("#24=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#14,$,.GRAPH_VIEW.,$);");
  put(`#16=IFCPROJECT('${guid(g++)}',#5,'Synthetic tower',$,$,$,$,(#14),#9);`);
  put('#17=IFCLOCALPLACEMENT($,#13);');
  put(`#18=IFCSITE('${guid(g++)}',#5,'Site',$,$,#17,$,$,.ELEMENT.,$,$,$,$,$);`);
  put(`#19=IFCBUILDING('${guid(g++)}',#5,'Tower',$,$,#17,$,$,.ELEMENT.,$,$,$);`);
  put(`#20=IFCRELAGGREGATES('${guid(g++)}',#5,$,$,#16,(#18));`);
  put(`#21=IFCRELAGGREGATES('${guid(g++)}',#5,$,$,#18,(#19));`);
  put('#22=IFCCARTESIANPOINT((0.,0.));');
  put('#23=IFCAXIS2PLACEMENT2D(#22,$);');
  // the column types: one representation map each (a 0.4 x 0.4 m to 0.78 x 0.78 m section, 3 m tall)
  const colMaps: number[] = [];
  for (let k = 0; k < 20; k++) {
    const prof = id++, sol = id++, rep = id++, map = id++;
    put(`#${prof}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,${(0.4 + k * 0.02).toFixed(2)},${(0.4 + k * 0.02).toFixed(2)});`);
    put(`#${sol}=IFCEXTRUDEDAREASOLID(#${prof},$,#11,3.);`);
    put(`#${rep}=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${sol}));`);
    put(`#${map}=IFCREPRESENTATIONMAP(#13,#${rep});`);
    colMaps.push(map);
  }
  const groups: Record<'WALL' | 'COLUMN' | 'SLAB', number[]> = { WALL: [], COLUMN: [], SLAB: [] };
  const flushGroups = (cls: 'WALL' | 'COLUMN' | 'SLAB', n: number) => {
    // a property set, a type and a material for the last 1,000 elements of a class
    const els = groups[cls];
    if (!els.length) return;
    const p1 = id++, p2 = id++, p3 = id++, ps = id++, rel = id++, ty = id++, rt = id++, m = id++, rm = id++;
    put(`#${p1}=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.${n % 2 ? 'T' : 'F'}.),$);`);
    put(`#${p2}=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.${n % 3 ? 'F' : 'T'}.),$);`);
    put(`#${p3}=IFCPROPERTYSINGLEVALUE('Zone',$,IFCLABEL('Z${n % 40}'),$);`);
    put(`#${ps}=IFCPROPERTYSET('${guid(g++)}',#5,'Pset_${cls === 'WALL' ? 'Wall' : cls === 'COLUMN' ? 'Column' : 'Slab'}Common',$,(#${p1},#${p2},#${p3}));`);
    const list = els.map((x) => `#${x}`).join(',');
    put(`#${rel}=IFCRELDEFINESBYPROPERTIES('${guid(g++)}',#5,$,$,(${list}),#${ps});`);
    put(`#${ty}=IFC${cls}TYPE('${guid(g++)}',#5,'${cls === 'WALL' ? 'Basic Wall' : cls === 'COLUMN' ? 'Concrete Column' : 'Floor'} ${n % 12}',$,$,$,$,$,$,.NOTDEFINED.);`);
    put(`#${rt}=IFCRELDEFINESBYTYPE('${guid(g++)}',#5,$,$,(${list}),#${ty});`);
    put(`#${m}=IFCMATERIAL('${['Concrete C30/37', 'Blockwork', 'Steel S355', 'Concrete C40/50'][n % 4]}',$,$);`);
    put(`#${rm}=IFCRELASSOCIATESMATERIAL('${guid(g++)}',#5,$,$,(${list}),#${m});`);
    groups[cls] = [];
  };
  let made = 0, groupNo = 0;
  const storeyIds: number[] = [];
  for (let s = 0; s < nStoreys; s++) {
    const z = s * 3.2;
    const sp = id++, sa = id++, sl = id++, st = id++;
    put(`#${sp}=IFCCARTESIANPOINT((0.,0.,${z.toFixed(1)}));`);
    put(`#${sa}=IFCAXIS2PLACEMENT3D(#${sp},$,$);`);
    put(`#${sl}=IFCLOCALPLACEMENT(#17,#${sa});`);
    put(`#${st}=IFCBUILDINGSTOREY('${guid(g++)}',#5,'Level ${s + 1}',$,$,#${sl},$,$,.ELEMENT.,${z.toFixed(1)});`);
    storeyIds.push(st);
    const inStorey: number[] = [];
    const n = Math.min(storeySize, elements - made);
    const side = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++, made++) {
      const x = (i % side) * 3, y = Math.floor(i / side) * 3;
      const p = id++, a = id++, lp = id++;
      put(`#${p}=IFCCARTESIANPOINT((${x}.,${y}.,0.));`);
      put(`#${a}=IFCAXIS2PLACEMENT3D(#${p},$,$);`);
      put(`#${lp}=IFCLOCALPLACEMENT(#${sl},#${a});`);
      const kind: 'WALL' | 'COLUMN' | 'SLAB' = made % 10 < 7 ? 'WALL' : made % 10 < 9 ? 'COLUMN' : 'SLAB';
      const el = id++;
      if (kind === 'COLUMN') {
        const op = id++, mi = id++, rep = id++, shp = id++;
        put(`#${op}=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,1.,$);`);
        put(`#${mi}=IFCMAPPEDITEM(#${colMaps[made % 20]},#${op});`);
        put(`#${rep}=IFCSHAPEREPRESENTATION(#15,'Body','MappedRepresentation',(#${mi}));`);
        put(`#${shp}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
        put(`#${el}=IFCCOLUMN('${guid(g++)}',#5,'Concrete Column:C${made % 20}:${300000 + made}',$,'Concrete Column:C${made % 20}',#${lp},#${shp},'${300000 + made}',.COLUMN.);`);
      } else {
        const prof = id++, sol = id++, rep = id++, shp = id++, a0 = id++, a1 = id++, pl = id++, ax = id++;
        // every wall its own length (2 to 3 m in steps of 10 µm, and 1 µm more for each 100,000 walls), so no two
        // meshes are the same; slabs 2.4 x 2.4 m to 2.9 x 2.9 m
        const len = kind === 'WALL' ? (o.sameWalls ? '2.' : (2 + (made % 100_000) * 1e-5 + Math.floor(made / 100_000) * 1e-6).toFixed(6)) : (2.4 + (made % 50) * 0.01).toFixed(2);
        put(`#${prof}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,${len},${kind === 'WALL' ? '0.2' : len});`);
        put(`#${sol}=IFCEXTRUDEDAREASOLID(#${prof},$,#11,${kind === 'WALL' ? '3.' : '0.25'});`);
        put(`#${rep}=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${sol}));`);
        // the wall's axis as Revit writes it (a second representation, not meshed)
        put(`#${a0}=IFCCARTESIANPOINT((0.,0.));`);
        put(`#${a1}=IFCCARTESIANPOINT((${len},0.));`);
        put(`#${pl}=IFCPOLYLINE((#${a0},#${a1}));`);
        put(`#${ax}=IFCSHAPEREPRESENTATION(#24,'Axis','Curve2D',(#${pl}));`);
        put(`#${shp}=IFCPRODUCTDEFINITIONSHAPE($,$,(${kind === 'WALL' ? `#${ax},` : ''}#${rep}));`);
        const nm = kind === 'WALL' ? 'Basic Wall:Generic - 200mm' : 'Floor:Generic 250mm';
        put(`#${el}=IFC${kind}('${guid(g++)}',#5,'${nm}:${300000 + made}',$,'${nm}',#${lp},#${shp},'${300000 + made}',${kind === 'WALL' ? '.STANDARD.' : '.FLOOR.'});`);
        if (kind === 'WALL' && made % 1000 === 0) {
          // a 0.9 x 2.1 m door opening through the wall
          const op = id++, oa = id++, ol = id++, opr = id++, os = id++, orep = id++, osh = id++, oe = id++, rv = id++;
          put(`#${op}=IFCCARTESIANPOINT((0.,0.,0.));`);
          put(`#${oa}=IFCAXIS2PLACEMENT3D(#${op},$,$);`);
          put(`#${ol}=IFCLOCALPLACEMENT(#${lp},#${oa});`);
          put(`#${opr}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,0.9,0.6);`);
          put(`#${os}=IFCEXTRUDEDAREASOLID(#${opr},$,#11,2.1);`);
          put(`#${orep}=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#${os}));`);
          put(`#${osh}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${orep}));`);
          put(`#${oe}=IFCOPENINGELEMENT('${guid(g++)}',#5,'Opening',$,$,#${ol},#${osh},$,.OPENING.);`);
          put(`#${rv}=IFCRELVOIDSELEMENT('${guid(g++)}',#5,$,$,#${el},#${oe});`);
        }
      }
      if (made % 4 === 3) {
        // base quantities on one element in 4
        const q = id++, eq = id++, rq = id++;
        put(`#${q}=IFCQUANTITYVOLUME('NetVolume',$,$,${kind === 'COLUMN' ? '0.48' : '1.2'},$);`);
        put(`#${eq}=IFCELEMENTQUANTITY('${guid(g++)}',#5,'Qto_BaseQuantities',$,$,(#${q}));`);
        put(`#${rq}=IFCRELDEFINESBYPROPERTIES('${guid(g++)}',#5,$,$,(#${el}),#${eq});`);
      }
      inStorey.push(el);
      groups[kind].push(el);
      if (groups[kind].length >= 1000) flushGroups(kind, groupNo++);
    }
    for (const k of ['WALL', 'COLUMN', 'SLAB'] as const) flushGroups(k, groupNo++);
    put(`#${id++}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(g++)}',#5,$,$,(${inStorey.map((x) => `#${x}`).join(',')}),#${st});`);
  }
  put(`#${id++}=IFCRELAGGREGATES('${guid(g++)}',#5,$,$,#19,(${storeyIds.map((x) => `#${x}`).join(',')}));`);
  put('ENDSEC;');
  put('END-ISO-10303-21;');
  writeSync(fd, buf);
  closeSync(fd);
  return { bytes: statSync(out).size, elements: made, storeys: nStoreys };
}

if (import.meta.filename === process.argv[1]) {
  const [out, n] = process.argv.slice(2);
  if (!out || !n) { console.error('usage: node scripts/make-ifc.ts <out.ifc> <elements> [--same-walls]'); process.exit(2); }
  const t0 = Date.now();
  const r = makeIfc(out, Number(n), { sameWalls: process.argv.includes('--same-walls') });
  console.log(`${out}: ${(r.bytes / 1048576).toFixed(1)} MB, ${r.elements} elements on ${r.storeys} storeys, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
