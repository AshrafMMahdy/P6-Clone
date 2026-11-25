// open_model length_unit (owner, 2026-11-24): the unit the caller says a model's lengths are in, measured from an element of known size,
// in place of what the file states (none, or a wrong one). It is another model in the cache; the project's model row keeps it, so every
// tool reads the model so again; the geometry, the derived volumes, the length labels of the quantities and the IFC export_4d delivers all
// follow it, and the answer says it was the caller's and what the file states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-unit-cache-'));
const { callTool, toolResult } = await import('../mcp/server.ts');
const { ifcWriter } = await import('../core/bim/nwd/toIfc.ts');
const { stepIndex } = await import('../core/bim/stepIndex.ts');
const { releaseModels } = await import('../core/bim/model.ts');
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };

const dir = mkdtempSync(join(tmpdir(), 'p6-unit-'));
/** A box 2000 x 1000 x 3000 in the file's numbers (and a length quantity of 2000), the file stating metres: drawn 2 km long as it says. */
function boxIfc(name: string, edit: (text: string) => string = (t) => t): string {
  const p = join(dir, name), [X, Y, Z] = [2000, 1000, 3000];
  const w = ifcWriter(p, { name: 'Box', file: name });
  const v = [0, 0, 0, X, 0, 0, X, Y, 0, 0, Y, 0, 0, 0, Z, X, 0, Z, X, Y, Z, 0, Y, Z];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  w.add({ guid: null, key: 'box', name: 'Door 2000', category: null, family: null, type: null, level: 'L1', levelElevationM: null, layer: null, material: null, psets: {}, quantities: { Length: 2000 }, revitId: null }, 0, 0, { positions: v, triangles: t });
  w.finish();
  writeFileSync(p, edit(readFileSync(p, 'latin1')), 'latin1');
  return p;
}
// (to a tenth of a millimetre: the fingerprints are float32)
const size = (b: number[]) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((x) => Math.round(x * 1e4) / 1e4).sort((a, b) => a - b);

test('a file that states the wrong unit, read by the caller’s: the sizes, the volume, the labels, the answer; the row keeps it; the delivered IFC states it', { timeout: 600_000 }, async () => {
  const ifc = boxIfc('metres.ifc');
  const np = (await call('new_project', { id: 'LU', start: '2027-01-04' })).d, h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'D1', name: 'Doors', duration_days: 5 }] });
  // as the file says: metres, a box two kilometres long
  const plain = await call('open_model', { handle: h, owner_key, path: ifc });
  assert.equal(plain.err, false, JSON.stringify(plain.d).slice(0, 400));
  assert.equal(plain.d.length_unit, 'm (the file’s own)');
  assert.equal(plain.d.unit_note, undefined, 'a unit the file states: no note (only the agent’s measuring finds a wrong one)');
  const guid = (await call('list_elements', { handle: h })).d.elements[0].guid;
  assert.deepEqual(size((await call('element_info', { handle: h, guids: [guid] })).d.elements[0].bbox), [1000, 2000, 3000]);
  // the caller measured the door: millimetres
  const mm = await call('open_model', { handle: h, owner_key, path: ifc, length_unit: 'mm' });
  assert.equal(mm.err, false, JSON.stringify(mm.d).slice(0, 400));
  assert.equal(mm.d.length_unit, 'mm (given by the caller; the file states m)');
  const info = (await call('element_info', { handle: h, guids: [guid] })).d.elements[0];
  assert.deepEqual(size(info.bbox), [1, 2, 3]);
  assert.ok(Math.abs(info.derivedVolumeM3 - 6) < 1e-6, `derived volume ${info.derivedVolumeM3}`);
  // the file's length quantity is in the caller's unit; its areas and volumes in the units it assigns itself
  const q = (await call('quantities', { handle: h, kind: 'length' })).d;
  assert.deepEqual([q.units.length, q.units.area, q.units.volume], ['mm', 'm²', 'm³']);
  // the model row keeps the unit: a tool that has to read the model again (nothing in memory or in the cache) reads it so
  releaseModels(new Set());
  for (const f of readdirSync(process.env.P6CLONE_MODEL_CACHE!)) rmSync(join(process.env.P6CLONE_MODEL_CACHE!, f), { recursive: true, force: true });
  assert.deepEqual(size((await call('element_info', { handle: h, guids: [guid] })).d.elements[0].bbox), [1, 2, 3], 'read again with the row’s unit');
  // the IFC delivered to SYNCHRO states millimetres, so SYNCHRO draws the door its real size
  await call('link_elements', { handle: h, owner_key, links: [{ activity: 'D1', guids: [guid] }] });
  const out = mkdtempSync(join(tmpdir(), 'p6-unit-x-'));
  const syn = await call('export_4d', { handle: h, target: 'synchro', path: join(out, 'syn') });
  assert.equal(syn.err, false, JSON.stringify(syn.d).slice(0, 400));
  const copy = syn.d.written.find((f: string) => f.endsWith('-4D.ifc'));
  assert.deepEqual([(await stepIndex(copy)).index.lengthScale, (await stepIndex(copy)).index.lengthScaleSource], [0.001, 'unit-assignment']);
  // relink_model and compare {model} say the unit each revision is read in
  const rl = (await call('relink_model', { handle: h, path: ifc, length_unit: 'mm', dry_run: true })).d;
  assert.deepEqual([rl.length_unit, rl.attached_length_unit, rl.kept], ['mm (given by the caller; the file states m)', 'mm (given by the caller; the file states m)', 1]);
  const cm = (await call('compare', { handle: h, model: ifc })).d;
  assert.deepEqual([cm.models.a.length_unit, cm.models.b.length_unit], ['mm (given by the caller; the file states m)', 'm (the file\u2019s own)']);
  // the desktop's 4D export starts from the model's text with the unit stated
  const { statedText } = await import('../core/bim/exchange4dFile.ts');
  const st = join(mkdtempSync(join(tmpdir(), 'p6-unit-s-')), 'stated.ifc');
  writeFileSync(st, await statedText(ifc, 'in'), 'latin1');
  assert.deepEqual([(await stepIndex(st)).index.lengthScale, (await stepIndex(st)).index.elements.length], [0.0254, 1]);
  // feet: a conversion-based unit in the copy
  await call('open_model', { handle: h, owner_key, path: ifc, length_unit: 'ft' });
  assert.deepEqual(size((await call('element_info', { handle: h, guids: [guid] })).d.elements[0].bbox), [304.8, 609.6, 914.4]);
  const ft = await call('export_4d', { handle: h, target: 'ifc4d', path: join(out, 'ft') });
  assert.equal(ft.err, false, JSON.stringify(ft.d).slice(0, 400));
  const ix = (await stepIndex(ft.d.written.find((f: string) => /IFC4\.ifc$/.test(f)))).index;
  assert.deepEqual([ix.lengthScale, ix.units?.length], [0.3048, 'foot']);
  // the file's own again: opened without length_unit
  assert.equal((await call('open_model', { handle: h, owner_key, path: ifc })).d.length_unit, 'm (the file’s own)');
  assert.deepEqual(size((await call('element_info', { handle: h, guids: [guid] })).d.elements[0].bbox), [1000, 2000, 3000]);
});

test('a file that states no unit (no unit assignment, or one without a length): the caller’s, and the delivered IFC is given it', { timeout: 600_000 }, async () => {
  // no unit assignment at all: the project names none (and its name is UTF-8 text, kept byte for byte in the copy)
  const utf8Name = Buffer.from('Bâtiment é', 'utf8').toString('latin1');
  const none = boxIfc('none.ifc', (t) => t.replace(/(IFCPROJECT\([^\n]*),#\d+\);/, '$1,$);').replace(/^#\d+=IFCUNITASSIGNMENT\(.*\n/m, '').replace("$,'Box',$", `$,'${utf8Name}',$`));
  // an assignment with an area and a volume unit, no length unit
  const noLength = boxIfc('nolength.ifc', (t) => t.replace(/IFCUNITASSIGNMENT\(\(#\d+,/, 'IFCUNITASSIGNMENT(('));
  // an assignment the project does not name: not in force (IFC's SI units are, as web-ifc draws it)
  const orphan = boxIfc('orphan.ifc', (t) => t.replace(/(IFCPROJECT\([^\n]*),#\d+\);/, '$1,$);').replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'));
  const cases = [
    { path: none, unit: 'cm', plain: 'm (assumed: the file states no unit)', text: 'cm (given by the caller; the file states no unit)', units: ['cm', 'm²', 'm³'] },
    { path: noLength, unit: 'mm', plain: 'm (assumed: the file states no unit)', text: 'mm (given by the caller; the file states no unit)', units: ['mm', 'm²', 'm³'] },
    { path: orphan, unit: 'mm', plain: 'm (assumed: the file states no unit)', text: 'mm (given by the caller; the file states no unit)', units: ['mm', 'm²', 'm³'] },
  ];
  for (const { path, unit, plain, text, units } of cases) {
    const np = (await call('new_project', { id: 'NU', start: '2027-01-04' })).d, h = np.handle, owner_key = np.owner_key;
    await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'D1', name: 'Doors', duration_days: 5 }] });
    const p0 = (await call('open_model', { handle: h, owner_key, path })).d;
    assert.equal(p0.length_unit, plain, path);
    // while the unit is taken as metres, every answer that gives sizes tells the agent to measure (or to say they are assumed)
    const steer = /measure an element whose real size you know .*open_model again with length_unit/;
    const g0 = (await call('list_elements', { handle: h })).d.elements[0].guid;
    assert.match(p0.unit_note, steer, path);
    assert.match((await call('element_info', { handle: h, guids: [g0] })).d.unit_note, steer);
    assert.match((await call('quantities', { handle: h, kind: 'length' })).d.unit_note, steer);
    const r = await call('open_model', { handle: h, owner_key, path, length_unit: unit });
    assert.equal(r.d.length_unit, text);
    assert.equal(r.d.unit_note, undefined, 'the caller gave the unit');
    const guid = (await call('list_elements', { handle: h })).d.elements[0].guid;
    assert.equal((await call('element_info', { handle: h, guids: [guid] })).d.unit_note, undefined);
    assert.deepEqual(size((await call('element_info', { handle: h, guids: [guid] })).d.elements[0].bbox), unit === 'cm' ? [10, 20, 30] : [1, 2, 3]);
    const q = (await call('quantities', { handle: h, kind: 'length' })).d.units;
    // the caller's unit is the length's: areas and volumes stay what the file assigns, or IFC's SI unit
    assert.deepEqual([q.length, q.area, q.volume], units, path);
    await call('link_elements', { handle: h, owner_key, links: [{ activity: 'D1', guids: [guid] }] });
    const x = await call('export_4d', { handle: h, target: 'navisworks', path: mkdtempSync(join(tmpdir(), 'p6-unit-n-')) });
    assert.equal(x.err, false, JSON.stringify(x.d).slice(0, 400));
    const copy = x.d.written.find((f: string) => f.endsWith('-4D.ifc'));
    const ix = (await stepIndex(copy)).index;
    assert.deepEqual([ix.lengthScale, ix.lengthScaleSource], [unit === 'cm' ? 0.01 : 0.001, 'unit-assignment'], path);
    if (path === none) assert.ok(readFileSync(copy, 'latin1').includes(`'${utf8Name}'`), 'the project\u2019s name as its bytes');
  }
});

test('a unit not on the list is refused, saying the list; discard_kept takes the unit (another model in the cache)', async () => {
  const ifc = boxIfc('refused.ifc');
  const r = await call('open_model', { path: ifc, length_unit: 'yards' });
  assert.equal(r.d.error.code, 'bad_input');
  assert.match(r.d.error.hint, /mm, cm, m, in, ft/);
  const d = await call('open_model', { path: ifc, length_unit: 'mm', discard_kept: true });
  assert.equal(d.err, false);
  assert.equal(d.d.discarded_chunks, 0);
});

const hello = join(import.meta.dirname, 'fixtures', 'navisworks', 'hello.nwc');
test('a Navisworks model read by the caller’s unit: its geometry placed by it (each file’s own unit said)', { timeout: 600_000 }, async () => {
  const a = await call('open_model', { path: hello });
  assert.equal(a.err, false, JSON.stringify(a.d).slice(0, 400));
  const b = await call('open_model', { path: hello, length_unit: 'mm' });
  assert.equal(b.err, false, JSON.stringify(b.d).slice(0, 400));
  assert.match(a.d.length_unit, /^m \(made from each file’s: /);
  assert.match(b.d.length_unit, /^mm \(given by the caller; the file states /);
  // a file that names no unit (not a Revit export): its metres are assumed, and the answer says to measure
  const assumed = a.d.source.files.some((f: { unitAssumed?: boolean }) => f.unitAssumed);
  assert.equal(!!a.d.unit_note, assumed);
  assert.equal(b.d.unit_note, undefined);
  const guids = (await call('list_elements', { handle: a.d.handle })).d.elements.map((e: { guid: string }) => e.guid);
  const ea = (await call('element_info', { handle: a.d.handle, guids })).d.elements.find((e: { bbox?: number[] }) => e.bbox);
  const eb = (await call('element_info', { handle: b.d.handle, guids: [ea.guid] })).d.elements[0];
  const own = a.d.source.files[0].units.startsWith('feet') ? 0.3048 : 1;
  const sa = size(ea.bbox), sb = size(eb.bbox);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(sb[i] - (sa[i] / own) * 0.001) <= 1e-4, `${sa} -> ${sb}`); // (size: to a tenth of a millimetre)
});
