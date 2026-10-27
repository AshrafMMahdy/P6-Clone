// Navisworks files for 4D and for every agent, read by the clone's own clean-room reader: the container, the model tree,
// each element's Revit data (on its node, or in LcOaPartitionProps for newer exports), the GlobalIds Revit's IFC
// export writes (LcOpGuidStore), and open_model without a schedule. The fixtures are two small licensed samples
// (tests/fixtures/navisworks); the user's own files are read in place where they are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNavisworks, readNavisworksTimeliner } from '../core/bim/nwd.ts';
import { decodePathMap, decodeSets, decodeTimeliner } from '../core/bim/nwd/timeliner.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'navisworks');
/** an element's placed vertices, as [x, y, z] */
const points = (e: { shape?: { positions: number[] } }) => { const p = e.shape?.positions ?? [], out: number[][] = []; for (let k = 0; k < p.length; k += 3) out.push([p[k], p[k + 1], p[k + 2]]); return out; };
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};

test('hello.nwc: four walls placed where Revit put them (two by a translation of their own frame)', () => {
  const { elements } = readNavisworks(join(FIX, 'hello.nwc'));
  // a rectangle of four 149 ft walls turned about 39 degrees: 2 x 114 ft by 2 x 93 ft (70.9 x 56.8 m), 20 ft (6.1 m) high
  const all = elements.flatMap(points);
  const span = (k: number) => Math.max(...all.map((p) => p[k])) - Math.min(...all.map((p) => p[k]));
  assert.ok(Math.abs(span(0) - 70.9) < 0.5 && Math.abs(span(1) - 56.8) < 0.5 && Math.abs(span(2) - 6.1) < 0.1, `${span(0)} ${span(1)} ${span(2)}`);
});

test('hello.nwc: each wall’s mesh, measured by the clone, is the volume Revit computed (to 0.1%)', { timeout: 120_000 }, async () => {
  const o = await call('open_model', { path: join(FIX, 'hello.nwc') });
  assert.equal(o.d.source.geometry.elements_with_meshes, 4);
  const els = (await call('list_elements', { handle: o.d.handle })).d.elements;
  const info = (await call('element_info', { handle: o.d.handle, guids: els.map((e: any) => e.guid) })).d.elements;
  for (const e of info) {
    const revit = e.authored.NetVolume;
    assert.ok(revit > 50 && Math.abs(e.derivedVolumeM3 - revit) / revit < 0.001, `${e.name}: mesh ${e.derivedVolumeM3} m3, Revit ${revit} m3`);
  }
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('hello.nwc: four Revit walls with level, family, type, ElementId, GlobalId and the quantities Revit computed, in SI', () => {
  const { elements, source } = readNavisworks(join(FIX, 'hello.nwc'));
  assert.equal(elements.length, 4);
  assert.deepEqual(source.files, [{ file: 'hello.nwc', revision: 448, elements: 4, read: true, units: 'feet (Revit)' }]);
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
  assert.equal(o.d.geometry, 'ok', 'each element drawn as its placed boxes');
  assert.equal(o.d.source.geometry.elements_with_meshes, 46);
  assert.deepEqual(o.d.storeys.filter((s: string) => s !== 'Default Building' && !/^\(/.test(s)), ['Level 1']);
  assert.equal(o.d.classes.IfcCableCarrierSegment, 20);
  const q = await call('quantities', { handle: o.d.handle, group_by: 'class', kind: 'length' });
  const trays = q.d.groups.find((g: any) => g.group === 'IfcCableCarrierSegment');
  assert.ok(trays.authored.Length > 0 && trays.quantified === 20, JSON.stringify(trays).slice(0, 300));
  assert.ok(trays.volume_m3 > 0, 'meshes give derived volumes');
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
  // every element with a shape: its triangles in metres, inside the building's footprint
  assert.equal(elements.filter((e) => e.shape?.triangles.length).length, 369, 'all but the 47 model lines');
  assert.equal(elements.filter((e) => e.shape?.boxes).length, 0, 'every piece read as a mesh');
  const xs = elements.flatMap(points).map((p) => p[0]), zs = elements.flatMap(points).map((p) => p[2]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 60 && Math.max(...zs) - Math.min(...zs) < 30, `${Math.min(...xs)}..${Math.max(...xs)}, ${Math.min(...zs)}..${Math.max(...zs)}`);
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

test('the user\u2019s 2016 villa NWC: every element\u2019s mesh volume is the one Revit computed, within 1%', { skip: !existsSync(VILLA) && 'the villa sample is not here', timeout: 300_000 }, async () => {
  const o = await call('open_model', { path: VILLA });
  assert.equal(o.d.source.geometry.elements_with_boxes, 0);
  const els = (await call('list_elements', { handle: o.d.handle, limit: 1000 })).d.elements;
  let checked = 0;
  for (let k = 0; k < els.length; k += 40) {
    for (const e of (await call('element_info', { handle: o.d.handle, guids: els.slice(k, k + 40).map((x: any) => x.guid) })).d.elements) {
      const r = e.authored?.NetVolume;
      if (!(r > 0.001)) continue;
      assert.ok(Math.abs(e.derivedVolumeM3 - r) / r < 0.01, `${e.name}: mesh ${e.derivedVolumeM3}, Revit ${r}`);
      checked++;
    }
  }
  assert.equal(checked, 325);
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

// ── TimeLiner and selection sets ───────────────────────────────────────────────────────────────────────────────
/** Bytes laid out as Navisworks writes them: u32, strings padded to 4, 64-bit values aligned to 8 in the section */
type Part = ['u32', number] | ['str', string | null] | ['i64', number] | ['raw', number];
function bytes(parts: Part[]): Uint8Array {
  const out: number[] = [];
  const u32 = (x: number) => { out.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255); };
  for (const [k, v] of parts) {
    if (k === 'u32') u32(v as number);
    else if (k === 'str') { if (v === null) { u32(0xffffffff); continue; } const b = Buffer.from(v as string); u32(b.length); out.push(...b); while (out.length % 4) out.push(0); }
    else if (k === 'i64') { while (out.length % 8) out.push(0); const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v as number)); out.push(...b); }
    else for (let i = 0; i < (v as number); i++) out.push(0);
  }
  return Uint8Array.from(out);
}
const unix = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00Z`) / 1000;

test('TimeLiner tasks, selection sets and an .nwf path map, decoded from their layout', () => {
  const empty: Part[] = Array.from({ length: 6 }, () => ['str', ''] as Part);
  const tasks = decodeTimeliner(bytes([['u32', 1], ['u32', 0x3d], ['str', 'Strip walls'], ...empty, ['u32', 1], ['str', null], ['str', null],
    ['i64', unix('2026-03-02 08:00')], ['i64', unix('2026-03-05 17:00')], ['u32', 1], ['u32', 1], ['u32', 1], ['i64', unix('2026-03-01 08:00')], ['i64', 0], ['u32', 1], ['u32', 1], ['u32', 1],
    ['str', 'Demolish'], ['str', null], ['u32', 1], ['u32', 0], ['u32', 2], ['u32', 7], ['u32', 9], ['u32', 1], ['str', 'lcop_selection_set_tree/Walls'], ['raw', 40]]));
  assert.deepEqual(tasks, [{ name: 'Strip walls', actualStart: '2026-03-02 08:00', actualFinish: '2026-03-05 17:00', plannedStart: '2026-03-01 08:00', plannedFinish: null, type: 'Demolish', items: [7, 9], sets: ['Walls'], children: 0 }]);
  const sets = decodeSets(bytes([['u32', 2], ['u32', 5], ['str', 'Walls'], ['u32', 0], ['raw', 16], ['u32', 0], ['u32', 0], ['u32', 2], ['u32', 3], ['u32', 4], ['u32', 0xffffffff], ['i64', 0],
    ['u32', 5], ['str', 'By category'], ['u32', 0], ['raw', 16], ['u32', 0], ['u32', 1], ['u32', 2], ['u32', 100]]));
  assert.deepEqual(sets, [{ name: 'Walls', items: [3, 4] }, { name: 'By category', items: null }]);
  const pm = decodePathMap(bytes([['u32', 2], ['u32', 0], ['u32', 1], ['u32', 0x5f], ['u32', 1], ['u32', 0x35], ['str', 'Level'], ['str', 'L1'], ['i64', 9], ['u32', 0xfffffffe],
    ['u32', 0x57], ['u32', 0], ['u32', 0x35], ['str', 'Category'], ['str', 'Walls'], ['i64', 0], ['raw', 40],
    ['u32', 0xfffffffe], ['u32', 0x57], ['u32', 1], ['u32', 0x35], ['str', 'Category'], ['str', 'Floors'], ['i64', 0], ['raw', 40]]));
  assert.deepEqual(pm, [{ name: 'L1', attr: 'Level', position: 1, parent: -1 }, { name: 'Walls', attr: 'Category', position: 0, parent: 0 }, { name: 'Floors', attr: 'Category', position: 1, parent: 0 }]);
});

test('a file with no TimeLiner says so', () => {
  const t = readNavisworksTimeliner(join(FIX, 'hello.nwc'));
  assert.deepEqual([t.tasks, t.sets], [[], []]);
  assert.match(t.notes.join(' '), /no TimeLiner/);
});

const VILLA_NWF = VILLA.replace(/\.nwc$/, '.nwf');
test('the user’s 2016 villa TimeLiner (.nwf): the 12 tasks as its Excel grid has them, each set resolved through the path map to the NWC’s elements, imported and linked', { skip: !existsSync(VILLA_NWF) && 'the villa sample is not here', timeout: 300_000 }, async () => {
  const o = await call('open_model', { path: VILLA_NWF });
  const dry = (await call('import_4d', { handle: o.d.handle, path: VILLA_NWF, link: false, create_activities: true })).d;
  assert.equal(dry.task_list.length, 12);
  // task 11: an actual start never edited (the day the file was made), planned as scheduled
  assert.deepEqual(dry.task_list[10], { name: 'Walls Construction', start: '2016-04-26 09:00', finish: '2016-05-10 17:00', actual_start: '2016-01-23 17:00', actual_finish: '2016-05-10 17:00', type: 'Construct', attached: 'Walls Construction', elements: 179 });
  assert.deepEqual(dry.sets.map((x: any) => x.elements), [21, 74, 4, 22, 7, 7, 1, 1, 8, 4, 179, 6]);
  const imp = (await call('import_4d', { handle: o.d.handle, owner_key: o.d.owner_key, path: VILLA_NWF, create_activities: true })).d;
  assert.equal(imp.created_activities.length, 12);
  assert.equal(imp.added, 334);
  // "Ground floor slab" is path-map component 6: level RC Level ground, category Floors
  const slab = (await call('list_elements', { handle: o.d.handle, linked: 'TL0030' })).d.elements;
  assert.equal(slab.length, 4);
  assert.ok(slab.every((e: any) => e.class === 'IfcSlab' && e.storey === 'RC Level ground'), JSON.stringify(slab));
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('the gatehouse NWD’s TimeLiner: two tasks with explicit selections (tree items), linked through sets made for them', { skip: !existsSync(GATE) && 'the gatehouse sample is not here', timeout: 300_000 }, async () => {
  const t = readNavisworksTimeliner(GATE);
  assert.deepEqual(t.tasks.map((x) => [x.name, x.items, x.plannedStart, x.actualFinish]), [['New Task', [2458], '2013-12-03 09:00', '2013-12-05 17:00'], ['New Task', [2245], '2013-12-03 09:00', '2013-12-06 17:00']]);
  // the sets select the layers their names say (items counted in tree pre-order, the file is 0)
  assert.deepEqual(t.sets.map((s) => [s.name, s.guids?.length]), [['Window Frames', 13], ['Solid Doors', 5], ['External Walls', 40], ['Internal Walls', 42], ['Glass', 15], ['Facia', 6], ['Floors', 2], ['Foundations', 16], ['Supporting pillars', 8]]);
  const o = await call('open_model', { path: GATE });
  const imp = (await call('import_4d', { handle: o.d.handle, owner_key: o.d.owner_key, path: GATE, create_activities: true })).d;
  assert.deepEqual(imp.created_activities.map((a: any) => a.id), ['TL0010', 'TL0020']);
  assert.equal(imp.added, 2);
  const el = (await call('list_elements', { handle: o.d.handle, linked: 'TL0010' })).d.elements;
  assert.equal(el.length, 1);
  assert.match(JSON.stringify((await call('element_info', { handle: o.d.handle, guids: el.map((e: any) => e.guid) })).d), /S_STEEL_COLUMNS_G10/);
  await call('close', { handle: o.d.handle, owner_key: o.d.owner_key, discard: true });
});

test('the Navisworks reader’s heap follows the memory budget (plus headroom), never more than half the machine or 16 GB, never under 1 GB', async () => {
  const { nwdHeapMb } = await import('../core/bim/nwd.ts');
  const GB = 1024 * 1048576;
  assert.equal(nwdHeapMb(3072, 64 * GB), 3072 + 512, 'a big machine: the budget and its headroom, not half the RAM');
  assert.equal(nwdHeapMb(8192, 64 * GB), 8192 + 512);
  assert.equal(nwdHeapMb(100000, 256 * GB), 16384, 'the 16 GB ceiling');
  assert.equal(nwdHeapMb(8192, 8 * GB), 4096, 'a small machine: half its memory');
  assert.equal(nwdHeapMb(256, 64 * GB), 1024, 'the floor');
  const was = process.env.P6CLONE_MEM_BUDGET_MB;
  try {
    process.env.P6CLONE_MEM_BUDGET_MB = '2048'; assert.equal(nwdHeapMb(undefined, 64 * GB), 2048 + 512);
    delete process.env.P6CLONE_MEM_BUDGET_MB; assert.equal(nwdHeapMb(undefined, 64 * GB), 3072 + 512, 'unset: the server’s default budget');
  } finally { if (was === undefined) delete process.env.P6CLONE_MEM_BUDGET_MB; else process.env.P6CLONE_MEM_BUDGET_MB = was; }
});

test('the reader’s job file is written in a private directory, mode 0600, and gone with its directory afterwards', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const { cacheNavisworks } = await import('../core/bim/nwd.ts');
  const { readdirSync, readFileSync, rmSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const work = mkdtempSync(join(tmpdir(), 'p6-nwjob-')), temp = join(work, 'tmp');
  mkdirSync(temp);
  // a reader that only reports where its job file was, and how it was protected
  const stub = join(work, 'stub-worker.mjs');
  writeFileSync(stub, `import { statSync, writeFileSync } from 'node:fs'; import { dirname } from 'node:path';
const f = process.argv[2];
writeFileSync(f + '.seen', JSON.stringify({ dir: dirname(f), dirMode: statSync(dirname(f)).mode & 0o777, fileMode: statSync(f).mode & 0o777 }));
writeFileSync(f + '.out.json', JSON.stringify({ format: 'Navisworks', files: [], warnings: [] }));
`);
  const was = { worker: process.env.P6CLONE_NWD_WORKER, tmpdir: process.env.TMPDIR };
  process.env.P6CLONE_NWD_WORKER = stub; process.env.TMPDIR = temp;
  let seen: { dir: string; dirMode: number; fileMode: number } | undefined;
  try {
    const origin = join(work, 'seen.json'); // outside the job directory, which is gone when the read returns
    writeFileSync(stub, readFileSync(stub, 'utf8').replace("f + '.seen'", JSON.stringify(origin)));
    await cacheNavisworks(join(FIX, 'hello.nwc'), join(work, 'base'), { geometry: false });
    seen = JSON.parse(readFileSync(origin, 'utf8'));
  } finally {
    for (const [k, v] of [['P6CLONE_NWD_WORKER', was.worker], ['TMPDIR', was.tmpdir]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.ok(seen, 'the reader ran');
  assert.equal(dirname(seen!.dir), temp, 'inside the temp folder, in a directory of its own');
  assert.match(seen!.dir.slice(temp.length + 1), /^p6clone-nwjob-[A-Za-z0-9]{6}$/);
  assert.equal(seen!.dirMode, 0o700);
  assert.equal(seen!.fileMode, 0o600);
  assert.deepEqual(readdirSync(temp), [], 'the job file, its answer and its directory are removed afterwards');
  rmSync(work, { recursive: true, force: true });
});
