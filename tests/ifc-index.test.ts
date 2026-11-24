// The STEP index on what real exporters write: products split over lines, comment markers inside strings, imperial
// units, and a millimetre model's geometry in metres (once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stepIndex } from '../core/bim/stepIndex.ts';

const ifc = (units: string, body: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,#9);
${units}
#9=IFCUNITASSIGNMENT((#7));
#20=IFCBUILDINGSTOREY('1YvctVUKr0kugbFTf53O9L',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
${body}
#40=IFCRELCONTAINEDINSPATIALSTRUCTURE('2YvctVUKr0kugbFTf53O9L',$,$,$,(#30,#31),#20);
ENDSEC;
END-ISO-10303-21;
`;
const write = (text: string) => { const p = join(mkdtempSync(join(tmpdir(), 'p6-ifcix-')), 't.ifc'); writeFileSync(p, text, 'latin1'); return p; };

test('products split over lines, and "/* */" inside a name, are read as written', async () => {
  const p = write(ifc("#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);", `#30=IFCWALLSTANDARDCASE('3YvctVUKr0kugbFTf53O9L',
  #2,
  'Wall /* old */ 138584',$,$,$,$,$);
#31=IFCSLAB( '4YvctVUKr0kugbFTf53O9L' , $ , 'Slab' ,$,$,$,$,$,.FLOOR.);`));
  const { index } = await stepIndex(p);
  assert.deepEqual(index.elements.map((e) => e.name).sort(), ['Slab', 'Wall /* old */ 138584']);
  assert.ok(index.elements.every((e) => e.storey === 'Level 1'));
  assert.equal(index.lengthScale, 0.001);
});

test('a conversion-based length unit (feet) is the model unit', async () => {
  const p = write(ifc("#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#6=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.3048),#5);\n#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n#7=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'FOOT',#6);", "#30=IFCWALL('3YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);\n#31=IFCSLAB('4YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.FLOOR.);"));
  assert.equal((await stepIndex(p)).index.lengthScale, 0.3048);
});

test('the length unit is the one the project assigns, not the last one defined (Revit writes both)', async () => {
  const p = write(ifc("#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);", "#30=IFCWALL('3YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);\n#31=IFCSLAB('4YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.FLOOR.);"));
  assert.equal((await stepIndex(p)).index.lengthScale, 0.001);
});

test('a conversion-based length unit is its measure\u2019s value in the measure\u2019s unit, whatever its name (as web-ifc scales the geometry)', async () => {
  const conv = (name: string, f: string, si: string) => write(ifc(`#5=${si};\n#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${f}),#5);\n#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n#7=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'${name}',#6);`, "#30=IFCWALL('3YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);\n#31=IFCSLAB('4YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.FLOOR.);"));
  assert.equal((await stepIndex(conv('FEET', '0.3048', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'))).index.lengthScale, 0.3048, 'a name the reader has no list for');
  assert.equal((await stepIndex(conv('FOOT', '304.8', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'))).index.lengthScale, 0.3048, 'the factor in millimetres');
  assert.equal((await stepIndex(conv('INCH', '1.', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'))).index.lengthScale, 1, 'the factor, not the name');
});

test('a unit assignment the project does not name is not in force: IFC\u2019s SI units are (as web-ifc draws it)', async () => {
  const p = write(ifc('#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);', "#30=IFCWALL('3YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);\n#31=IFCSLAB('4YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.FLOOR.);").replace("$,$,$,$,#9);", '$,$,$,$,$);'));
  const ix = (await stepIndex(p)).index;
  assert.deepEqual([ix.lengthScale, ix.lengthScaleSource, ix.units?.length], [1, 'assumed-m', undefined]);
});

const SCHEP = join(import.meta.dirname, '..', 'sample 4D', 'ifc-models', 'schependomlaan', 'IFC Schependomlaan.ifc');
test('a millimetre model (Schependomlaan): every product, and geometry in metres', { skip: !existsSync(SCHEP) && 'Schependomlaan sample not present', timeout: 600_000 }, async () => {
  const { loadModel } = await import('../core/bim/model.ts');
  const m = await loadModel(SCHEP);
  assert.equal(m.index.elements.length, 3721, 'walls written over several lines are products too');
  assert.equal(m.index.lengthScale, 0.001);
  const walls = m.index.elements.filter((e) => e.ifcClass === 'IfcWallStandardCase' && e.geom);
  const tall = walls.map((e) => e.geom!.bbox[4] - e.geom!.bbox[1]).sort((a, b) => b - a)[0];
  assert.ok(tall > 2 && tall < 20, `tallest wall ${tall} m`);
  assert.ok(walls.reduce((v, e) => v + (e.derivedVolumeM3 ?? 0), 0) > 50, 'wall volume in cubic metres');
});
