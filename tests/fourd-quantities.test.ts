// quantities for the platform's takeoff: per group, besides the count, derived volume and authored totals it always
// gave, how many elements have no figure of the asked kind (unquantified), and each figure's kind, unit and source
// (base_quantity = an IfcElementQuantity, with its set; geometry = derived from the shape; property_set = a property
// typed as a measure), so a line can show provenance, deviation between sources and its unquantified count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DUPLEX = join(import.meta.dirname, 'fixtures', '4d', 'Duplex_A_20110907.ifc');
const FZK = join(import.meta.dirname, '..', 'sample 4D', 'ifc-models', 'ifcopenshell', 'AC20-FZK-Haus.ifc');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
async function model(path: string) {
  const np = (await call('new_project', { id: `Q${Math.random().toString(36).slice(2, 7)}`, start: '2026-03-02' })).d;
  const om = await call('open_model', { handle: np.handle, owner_key: np.owner_key, path });
  assert.equal(om.err, false, JSON.stringify(om.d).slice(0, 300));
  const q = (args: Record<string, unknown> = {}) => call('quantities', { handle: np.handle, ...args });
  return Object.assign(async (args: Record<string, unknown> = {}) => { const r = await q(args); assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300)); return r.d; }, { raw: q });
}
const group = (q: any, g: string) => q.groups.find((x: any) => x.group === g);
const figure = (g: any, name: string) => g.figures.find((f: any) => f.name === name);
/** Every group: the shape it always had, the counts adding up, every figure with a kind, unit and known source. */
function wellFormed(q: any, kind: string) {
  assert.equal(q.kind, kind);
  for (const g of q.groups) {
    assert.deepEqual(['group', 'count', 'volume_m3', 'authored'].map((k) => k in g), [true, true, true, true], 'the shape the platform already reads');
    assert.equal(g.quantified + g.unquantified, g.count, g.group);
    for (const f of g.figures) {
      assert.ok(['base_quantity', 'geometry', 'property_set'].includes(f.source) && f.unit && f.kind && f.elements >= 1 && f.elements <= g.count, JSON.stringify(f));
      if (f.source === 'base_quantity') { assert.ok(f.set, `${g.group} ${f.name}: its quantity set`); assert.equal(f.value, g.authored[f.name]); }
    }
    // an element counts as quantified when one of its figures is of the asked kind: so a group with none has none
    if (!g.figures.some((f: any) => f.kind === kind && f.value > 0)) assert.equal(g.quantified, 0, g.group);
  }
}

test('quantities on Duplex (Revit, IFC2X3): derived volume against the Revit property, the walls without an area, the space areas from a quantity set', { timeout: 300_000 }, async () => {
  const q = await model(DUPLEX);
  const vol = await q({ group_by: 'class' });
  wellFormed(vol, 'volume');
  assert.deepEqual([vol.units.length, vol.units.area, vol.units.volume], ['m', 'm²', 'm³']);
  const walls = group(vol, 'IfcWallStandardCase');
  assert.deepEqual([walls.count, walls.quantified, walls.unquantified], [56, 56, 0]);
  const geo = figure(walls, 'derived volume'), rvt = figure(walls, 'PSet_Revit_Dimensions.Volume');
  assert.deepEqual([geo.source, geo.unit, geo.elements, geo.value], ['geometry', 'm³', 56, walls.volume_m3]);
  assert.deepEqual([rvt.source, rvt.kind, rvt.unit, rvt.elements], ['property_set', 'volume', 'm³', 56]);
  assert.ok(Math.abs(geo.value - rvt.value) / rvt.value < 0.02, `geometry ${geo.value} vs Revit ${rvt.value}: a deviation the platform can show`);
  assert.equal(walls.figures[0].kind, 'volume', 'figures of the asked kind first');

  const area = await q({ group_by: 'class', kind: 'area' });
  wellFormed(area, 'area');
  const wa = group(area, 'IfcWallStandardCase');
  assert.deepEqual([wa.quantified, wa.unquantified, figure(wa, 'PSet_Revit_Dimensions.Area').elements], [55, 1, 55], 'one wall carries no area');
  assert.deepEqual([group(area, 'IfcWindow').quantified, group(area, 'IfcWindow').unquantified], [0, 24], 'no window carries an area');
  const gsa = figure(group(area, 'IfcSpace'), 'GSA BIM Area');
  assert.deepEqual([gsa.source, gsa.set, gsa.kind, gsa.unit, gsa.elements], ['base_quantity', 'GSA Space Areas', 'area', 'm²', 21]);
  // grouped another way, the same elements: the unquantified counts add up to the same total
  const total = (r: any) => r.groups.reduce((s: number, g: any) => s + g.unquantified, 0);
  assert.equal(total(await q({ group_by: 'storey', kind: 'area' })), total(area));
  const bad = await q.raw({ kind: 'mass' });
  assert.deepEqual([bad.err, bad.d.error?.code], [true, 'bad_input']);
});

test('quantities on FZK-Haus (ArchiCAD, IFC4): base quantities with their sets, the project\'s units, spaces quantified without geometry', { skip: !existsSync(FZK) && 'FZK-Haus sample not present (sample 4D/ifc-models/ifcopenshell/AC20-FZK-Haus.ifc)', timeout: 300_000 }, async () => {
  const q = await model(FZK);
  const vol = await q({ group_by: 'class' });
  wellFormed(vol, 'volume');
  assert.deepEqual(vol.units, { length: 'm', area: 'm²', volume: 'm³', count: 'no.', weight: 'g', time: 's' }, 'as the project assigns them (mass in grams)');
  const walls = group(vol, 'IfcWallStandardCase');
  assert.deepEqual([walls.count, walls.unquantified], [13, 0]);
  const gross = figure(walls, 'GrossVolume'), geo = figure(walls, 'derived volume');
  assert.deepEqual([gross.source, gross.set, gross.unit, gross.elements], ['base_quantity', 'BaseQuantities', 'm³', 13]);
  assert.equal(geo.source, 'geometry');
  assert.equal(figure(walls, 'Brutto-Volumen der Wand ').set, 'ArchiCADQuantities', 'ArchiCAD\'s own set kept apart');
  const spaces = group(vol, 'IfcSpace');
  assert.deepEqual([spaces.quantified, figure(spaces, 'derived volume')], [spaces.count, undefined], 'spaces have no derived volume; their base quantities quantify them');
  assert.equal(figure(spaces, 'NetVolume').source, 'base_quantity');
  const count = await q({ group_by: 'class', kind: 'count' });
  wellFormed(count, 'count');
  assert.ok(count.groups.some((g: any) => g.quantified > 0 && g.figures.some((f: any) => f.kind === 'count' && f.unit === 'no.')));
  wellFormed(await q({ group_by: 'class+storey', kind: 'length' }), 'length');
});
