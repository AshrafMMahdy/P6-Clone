// Revit files for 4D and for every agent: an .rvt opens through rvt-rs (its own process) as IFC4, says how it was read,
// keeps the GlobalIds Revit's own IFC export writes, and opens without a schedule. The user's own models are read in
// place (never copied into the repo); the tests that need them are skipped where they are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const HELSINKI = 'D:/Backup/Documents/ConREM/1. Semester 1 & 2 Helsinki/2. Semester 2/Applied Product Modelling/Project/APM GROUP 7 SUBMISSION FILES/3. Design Files/Architecture (REVIT)/';
const RVT = process.env.P6CLONE_RVT_SAMPLE || `${HELSINKI}Architecture Model Reference.rvt`, IFC = `${HELSINKI}Architecture Model Reference.ifc`;
const skip = existsSync(RVT) ? false : 'the Revit sample is not on this machine';

test('a Revit 2023 project opens without a schedule, as IFC4 read by rvt-rs, with what was read and how', { skip, timeout: 120_000 }, async () => {
  const o = await call('open_model', { path: RVT });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 400));
  assert.ok(o.d.handle && o.d.owner_key && /model only/.test(o.d.workspace));
  assert.equal(o.d.source.format, 'Revit');
  assert.equal(o.d.source.revit_version, 2023);
  assert.equal(o.d.source.read_as, 'geometry');
  // rvt-rs 0.10.0: base quantities from the elements' records, and Revit's own property sets from the parameters saved
  assert.ok(o.d.quantified_elements >= 45, String(o.d.quantified_elements)); // none before 0.10.0
  assert.ok(o.d.source.revit_property_sets?.properties > 0 && o.d.source.revit_property_sets.elements > 0, JSON.stringify(o.d.source.revit_property_sets));
  assert.ok(o.d.classes.IfcWall >= 39 && o.d.classes.IfcDoor >= 29, JSON.stringify(o.d.classes));
  const q = await call('quantities', { handle: o.d.handle, group_by: 'class' });
  assert.equal(q.err, false, JSON.stringify(q.d).slice(0, 300));
  const by = (c: string) => q.d.groups.find((g: any) => g.group === c);
  // walls from their profile: within 3% of Revit's own IFC export of this project (717.1 m3)
  assert.ok(Math.abs(by('IfcWall').volume_m3 - 717.1) / 717.1 < 0.03, String(by('IfcWall').volume_m3));
  // doors and railings rvt-rs could only box: counted, not measured
  assert.equal(by('IfcRailing').volume_m3, 0);
  assert.equal(by('IfcDoor').unquantified, by('IfcDoor').count);
  assert.ok(o.d.source.geometry.bounding_box_only > 0 && o.d.source.geometry.from_the_file >= 39);
  const e = await call('list_elements', { handle: o.d.handle, class: 'IfcWall', limit: 5 });
  assert.match(e.d.elements[0].name, /Basic Wall/);
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('links made on the RVT hold when Revit\u2019s own IFC export of it replaces the model (the same GlobalIds)', { skip: skip || (!existsSync(IFC) && 'no IFC export beside it'), timeout: 120_000 }, async () => {
  const np = (await call('new_project', { id: 'P', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'W', name: 'Walls', duration_days: 5 }] });
  await call('open_model', { handle: h, owner_key, path: RVT });
  const walls = (await call('list_elements', { handle: h, class: 'IfcWall', limit: 1000 })).d.elements.map((x: any) => x.guid);
  assert.ok(walls.length >= 39, String(walls.length));
  assert.equal((await call('link_elements', { handle: h, owner_key, links: [{ activity: 'W', guids: walls }] })).err, false);
  const swap = await call('open_model', { handle: h, owner_key, path: IFC });
  assert.equal(swap.err, false);
  assert.equal(swap.d.dropped_links ?? 0, 0, 'every wall linked on the RVT is in Revit\u2019s IFC');
});

test('a file named .rvt that is not a Revit file is refused in words; the model-only workspace goes with it', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'p6-rvt-')), 'fake.rvt');
  writeFileSync(p, 'not a revit file');
  const before = (await call('list_open', {})).d.open.length;
  const o = await call('open_model', { path: p });
  assert.equal(o.err, true);
  assert.equal(o.d.error.code, 'model_unreadable');
  assert.equal((await call('list_open', {})).d.open.length, before, 'no empty workspace left behind');
});

// rvt-rs with p6clone.patch (core/bim/rvt/README.md): the same IFC, written a piece at a time, in less memory
const rvtModule = async () => {
  const { readFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const dir = join(import.meta.dirname, '..', 'core', 'bim', 'rvt');
  const rvt = await import(pathToFileURL(join(dir, 'rvt.js')).href);
  rvt.initSync({ module: readFileSync(join(dir, 'rvt_bg.wasm')) });
  return rvt;
};

test('the string records read through a window over the partition are the ones read whole (p6clone.patch)', async () => {
  assert.ok((await rvtModule()).p6WindowedSelfCheck() > 1000);
});

test('the IFC written a piece at a time is the IFC written whole: the same elements, GlobalIds and properties', { skip, timeout: 120_000 }, async () => {
  const { readFileSync } = await import('node:fs');
  const rvt = await rvtModule(), bytes = new Uint8Array(readFileSync(RVT));
  const whole = rvt.modelToIfcStep(rvt.openRvtBytesWithDiagnosticsMode(bytes, 'geometry').model);
  let pieces = '', n = 0;
  (globalThis as { __rvtIfcSink?: (s: string) => void }).__rvtIfcSink = (s) => { pieces += s; n++; };
  const diagnostics = rvt.rvtToIfcStream(bytes, 'geometry');
  assert.ok(diagnostics && n >= 1);
  const plain = (s: string) => s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d|IFCOWNERHISTORY\([^;]*\)/g, 'T'); // the clock
  assert.equal(plain(pieces), plain(whole));
});

test('a Revit file past what the reader can open is refused before it runs, with the exports that open at any size', { skip }, async () => {
  const { rvtToIfc } = await import('../core/bim/rvt.ts');
  process.env.P6CLONE_REVIT_MAX_MB = '1';
  process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-rvtmax-'));
  try { await assert.rejects(rvtToIfc(RVT), /past what the Revit reader can open.*NWC \(Navisworks\) or IFC/); } finally { delete process.env.P6CLONE_REVIT_MAX_MB; }
});

test('through the MCP, a Revit file too big for its reader is model_too_large: what to ask for, and why in plain words', { skip }, async () => {
  process.env.P6CLONE_REVIT_MAX_MB = '1';
  try {
    const o = await call('open_model', { path: RVT });
    assert.equal(o.err, true);
    const e = o.d.error ?? o.d;
    assert.equal(e.code, 'model_too_large', JSON.stringify(o.d).slice(0, 300));
    assert.deepEqual(e.alternatives, ['nwc', 'ifc']);
    assert.ok(e.size_mb > e.max_mb);
    assert.match(e.next_step, /NWC .* IFC export.*not technical/s);
    assert.match(e.explain_to_user, /4 GB.*not a problem with your model.*NWC \(Navisworks\) or IFC/s);
  } finally { delete process.env.P6CLONE_REVIT_MAX_MB; }
});
