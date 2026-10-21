// Navisworks files for 4D and for every agent, read by the clone's own clean-room reader: the container, the model tree,
// each element's Revit data (on its node, or in LcOaPartitionProps for newer exports), the GlobalIds Revit's IFC
// export writes (LcOpGuidStore), and open_model without a schedule. The fixtures are two small licensed samples
// (tests/fixtures/navisworks); the user's own files are read in place where they are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNavisworks } from '../core/bim/nwd.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'navisworks');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};

test('hello.nwc: four Revit walls with level, family, type, ElementId, GlobalId and the quantities Revit computed, in SI', () => {
  const { elements, source } = readNavisworks(join(FIX, 'hello.nwc'));
  assert.equal(elements.length, 4);
  assert.deepEqual(source.files, [{ file: 'hello.nwc', revision: 448, elements: 4, read: true }]);
  const w = elements[0];
  assert.deepEqual([w.category, w.family, w.type, w.level, w.revitId], ['Walls', 'Basic Wall', 'Generic - 200mm', 'L1', 1593982]);
  assert.match(w.guid!, /^[0-9A-Za-z_$]{22}$/);
  // 20 ft unconnected height, 149.2 ft long, 0.656 ft thick: Revit's own figures, converted from feet
  assert.ok(w.quantities.NetVolume! > 50 && w.quantities.NetVolume! < 60, String(w.quantities.NetVolume));
  assert.equal(w.material, 'Default Wall');
  assert.equal(w.psets.Element.IfcGUID, w.guid, 'the GUID store gives the same GlobalId Revit wrote in IfcGUID');
});

test('Electrical.nwc (a newer export): the elements\u2019 Revit data comes from LcOaPartitionProps, matched in tree order', () => {
  const { elements } = readNavisworks(join(FIX, 'Electrical.nwc'));
  assert.equal(elements.length, 46);
  assert.equal(elements.filter((e) => e.psets.Element).length, 46, 'every element has its Element properties');
  assert.equal(new Set(elements.map((e) => e.revitId)).size, 46, 'each a different ElementId');
  for (const e of elements) assert.equal(e.psets.Element.Category, e.category);
  assert.ok(elements.some((e) => e.category === 'Cable Trays' && e.quantities.Length! > 0));
});

test('open_model on an .nwc without a handle: a model-only workspace with IFC classes, storeys and Revit\u2019s quantities', { timeout: 120_000 }, async () => {
  const o = await call('open_model', { path: join(FIX, 'Electrical.nwc') });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  assert.equal(o.d.source.format, 'Navisworks');
  assert.equal(o.d.geometry, 'unavailable');
  assert.deepEqual(o.d.storeys.filter((s: string) => s !== 'Default Building' && !/^\(/.test(s)), ['Level 1']);
  assert.equal(o.d.classes.IfcCableCarrierSegment, 20);
  const q = await call('quantities', { handle: o.d.handle, group_by: 'class', kind: 'length' });
  const trays = q.d.groups.find((g: any) => g.group === 'IfcCableCarrierSegment');
  assert.ok(trays.authored.Length > 0 && trays.quantified === 20, JSON.stringify(trays).slice(0, 300));
  const e = (await call('list_elements', { handle: o.d.handle, class: 'IfcLightFixture' })).d.elements;
  const info = (await call('element_info', { handle: o.d.handle, guids: [e[0].guid] })).d.elements[0];
  assert.ok(Object.keys(info.props).some((k) => k.startsWith('Element.')), 'the Revit parameters are there as properties');
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('an .nwf opens the models it lists from beside it; one that is missing is named, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-nwf-'));
  // a minimal .nwf: the container with an XRef table naming hello.nwc and gone.nwc
  writeFileSync(join(dir, 'hello.nwc'), new Uint8Array(require_('node:fs').readFileSync(join(FIX, 'hello.nwc'))));
  const nwf = makeNwf([`C:\\elsewhere\\hello.nwc`, `C:\\elsewhere\\gone.nwc`]);
  writeFileSync(join(dir, 'job.nwf'), nwf);
  const { elements, source } = readNavisworks(join(dir, 'job.nwf'));
  assert.equal(elements.length, 4);
  assert.deepEqual(source.files.map((f) => [f.file, f.read]), [['hello.nwc', true], ['gone.nwc', false]]);
  assert.match(source.warnings[0], /gone\.nwc: not found/);
});

test('a file that is not Navisworks, or a cut-short one, is refused in words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-nwbad-'));
  writeFileSync(join(dir, 'x.nwd'), 'not navisworks');
  assert.throws(() => readNavisworks(join(dir, 'x.nwd')), /not a Navisworks file/);
  const b = require_('node:fs').readFileSync(join(FIX, 'hello.nwc'));
  writeFileSync(join(dir, 'cut.nwc'), b.subarray(0, 4000));
  assert.throws(() => readNavisworks(join(dir, 'cut.nwc')), /Navisworks|table of contents|cut short/);
});

const VILLA = 'C:/Users/ashra/Downloads/Primavera P6 Clone/sample 4D/navisworks-real-2016-villa/Ashraf_Navisworks.nwc';
test('the user\u2019s 2016 villa NWC: 416 Revit elements, every one with the GlobalId Revit\u2019s IFC export writes', { skip: !existsSync(VILLA) && 'the villa sample is not here' }, () => {
  const { elements } = readNavisworks(VILLA);
  assert.equal(elements.length, 416);
  assert.equal(elements.filter((e) => e.guid && e.revitId !== null).length, 416);
  assert.equal(elements.filter((e) => e.category === 'Walls').length, 180);
});

const GATE = 'C:/Users/ashra/Downloads/Primavera P6 Clone/sample 4D/navisworks-models/duchangyu-client-timeliner/gatehouse.nwd';
test('a DWG-sourced NWD (revision 431): its items under their layers', { skip: !existsSync(GATE) && 'the gatehouse sample is not here' }, () => {
  const { elements } = readNavisworks(GATE);
  assert.equal(elements.length, 614);
  assert.ok(elements.every((e) => e.layer !== null));
});

// ── a minimal .nwf for the test: header, the XRef table section, the table of contents, the trailer ────────────
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
function require_(m: string) { return createRequire(import.meta.url)(m); }
function makeNwf(paths: string[]): Uint8Array {
  const head = Buffer.from('#LcUStream-V1.1 binary double release C lichunk-008\n');
  const json = JSON.stringify({ Type: 'XRefTable', Version: 1, SavedFilename: 'C:\\elsewhere\\job.nwf', Table: paths.map((p) => ({ OriginalPath: p, RemappedPath: p })) });
  const xref = deflateSync(Buffer.concat([Buffer.alloc(4), Buffer.from(json)]));
  const name = Buffer.from('LcOpXRefTable'), pad = Buffer.alloc((4 - (name.length % 4)) % 4);
  const entry = Buffer.alloc(4); entry.writeUInt32LE(name.length);
  let toc = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0]), entry, name, pad, Buffer.from([1, 0, 0, 0])]);
  if (toc.length % 8) toc = Buffer.concat([toc, Buffer.alloc(8 - (toc.length % 8))]);
  const off = Buffer.alloc(24); off.writeBigUInt64LE(BigInt(head.length)); off.writeBigUInt64LE(BigInt(xref.length), 8);
  toc = Buffer.concat([toc, off]);
  const tocHead = Buffer.from('#LcUStream-V1.1 binary double release utf8 navisworks:448 lizlib\n');
  return Buffer.concat([head, xref, tocHead, Buffer.alloc(7), deflateSync(toc), head]);
}

const VILLA_RVT = 'D:/Backup/Documents/Construction Management/AUC Courses/CENG 447/Revit Project winter 2016/Project1ashraf.0554.rvt';
test('the same building as RVT and as NWC: the same GlobalIds, so 4D links carry from one to the other', { skip: (!existsSync(VILLA) || !existsSync(VILLA_RVT)) && 'the villa samples are not here', timeout: 120_000 }, async () => {
  const a = await call('open_model', { path: VILLA_RVT }), b = await call('open_model', { path: VILLA });
  const ids = async (h: string) => new Set((await call('list_elements', { handle: h, limit: 1000 })).d.elements.map((e: any) => e.guid));
  const ra = await ids(a.d.handle), nb = await ids(b.d.handle);
  const shared = [...ra].filter((g) => nb.has(g)).length;
  assert.ok(shared >= 350, `${shared} of ${ra.size} RVT elements found in the NWC by GlobalId`);
  for (const x of [a, b]) await call('close', { handle: x.d.handle, owner_key: x.d.owner_key, discard: true });
});
