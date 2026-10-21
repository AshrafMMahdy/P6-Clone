// The platform's review of whiq-v0.1.37 and of its push 2: 4D exports of a Navisworks model carry the IFC4 it was made
// into; an .nwf on a server with a root reads only the models beside it; a failed model-only open as a job closes its
// workspace; a random file is not a 4D file; every stdio reply is written before the process stops; reservations for
// work need memory, not a project slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { callTool, toolResult } from '../mcp/server.ts';
import { sessions, setRoot } from '../mcp/runtime.ts';
import { readNavisworks, readNavisworksTimeliner } from '../core/bim/nwd.ts';
import { readImport4d } from '../core/bim/read4d.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
const FIX = join(import.meta.dirname, 'fixtures', 'navisworks');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('N-37-1: every 4D export of an .nwc model carries the IFC4 it was made into', { timeout: 120_000 }, async () => {
  const o = (await call('open_model', { path: join(FIX, 'hello.nwc') })).d;
  const H = { handle: o.handle, owner_key: o.owner_key };
  await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'W1', name: 'Walls', duration_days: 5 }] });
  const walls = (await call('list_elements', { handle: o.handle })).d.elements;
  await call('link_elements', { ...H, links: [{ activity: 'W1', guids: walls.map((e: any) => e.guid) }] });
  const dir = tmp('p6-n371-');
  for (const target of ['navisworks', 'synchro', 'ifc4d']) {
    const x = await call('export_4d', { handle: o.handle, target, path: join(dir, target) });
    assert.equal(x.err, false, JSON.stringify(x.d));
    const ifc = x.d.written.find((f: string) => /\.ifc$/i.test(f));
    const text = readFileSync(ifc, 'latin1');
    assert.match(text.slice(0, 40), /^ISO-10303-21;/, target);
    for (const e of walls) assert.ok(text.includes(e.guid), `${target}: ${e.guid}`);
  }
  await call('close', { ...H, discard: true });
});

/** A minimal .nwf listing the given model paths (header, the XRef table section, the table of contents, trailer). */
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
  return Buffer.concat([head, xref, Buffer.from('#LcUStream-V1.1 binary double release utf8 navisworks:448 lizlib\n'), Buffer.alloc(7), deflateSync(toc), head]);
}

test('N-37-2: on a server with a root an .nwf reads only the models beside it, never its saved paths; unfenced it still does', async () => {
  await import('../mcp/fourd.ts'); // the fence comes with the 4D tools
  const outside = tmp('p6-n372-out-'), root = tmp('p6-n372-root-');
  const elsewhere = join(outside, 'hello.nwc');
  copyFileSync(join(FIX, 'hello.nwc'), elsewhere);
  const nwf = join(root, 'job.nwf');
  writeFileSync(nwf, makeNwf([elsewhere]));
  assert.equal(readNavisworks(nwf).elements.length, 4, 'the desktop (no root): read where the .nwf says');
  setRoot(root);
  try {
    assert.throws(() => readNavisworks(nwf), /not found beside the \.nwf(?! or)/);
    assert.match(readNavisworksTimeliner(nwf).notes.join(' '), /no TimeLiner/);
    copyFileSync(join(FIX, 'hello.nwc'), join(root, 'hello.nwc'));
    assert.equal(readNavisworks(nwf).elements.length, 4, 'beside it, inside the root: read');
  } finally { setRoot(null); }
});

test('N-37-7: a model-only open that fails as a job closes the workspace it made', { timeout: 60_000 }, async () => {
  const bad = join(tmp('p6-n377-'), 'broken.nwc');
  writeFileSync(bad, '#LcUStream-V1.1 binary double release C lichunk-008\nnot really a model');
  const before = sessions.size;
  const j = (await call('open_model', { path: bad, async: true })).d;
  assert.ok(j.job_id && j.handle, JSON.stringify(j));
  let st: any;
  for (let i = 0; i < 100; i++) { st = (await call('job_status', { job_id: j.job_id, wait_seconds: 1 })).d; if (st.status !== 'running') break; }
  assert.equal(st.status, 'failed', JSON.stringify(st));
  for (let i = 0; i < 50 && sessions.has(j.handle); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.has(j.handle), false, 'the workspace went with the failed open');
  assert.equal(sessions.size, before);
});

test('a file that is no 4D file is refused, not read as an empty TimeLiner CSV', async () => {
  await assert.rejects(readImport4d('photo.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0])), /not a 4D file/);
  await assert.rejects(readImport4d('notes.txt', new TextEncoder().encode('just some words\nand more')), /not a 4D file/);
  assert.equal((await readImport4d('t.csv', new TextEncoder().encode('Name,Planned Start,Planned End\nPour,2026-03-02,2026-03-04\n'))).tasks.length, 1);
});

test('stdio: every reply is written before the process stops at the end of stdin', { timeout: 120_000 }, () => {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })];
  for (let i = 1; i <= 200; i++) lines.push(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'server_status', arguments: {} } }));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 * 1048576, env: { ...process.env, P6CLONE_MAX_HANDLES: undefined } });
  const ids = new Set(r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).id));
  assert.equal(ids.size, 201, r.stderr.slice(-500));
});

// samples kept out of the repository (no licence to redistribute): read where they are
const BSP = join(import.meta.dirname, '..', 'sample 4D', 'navisworks-models', 'aussieBIMguru-bsp-timeliner');
test('N-37-6: a 2021 Revit export (hyperlink parameters 0x4f, scaled placements 0x10) reads, volumes as Revit has them; its TimeLiner root task is a summary, not an activity', { skip: !existsSync(join(BSP, 'Timeliner test.nwf')) && 'the sample is not here', timeout: 300_000 }, async () => {
  assert.equal(readNavisworks(join(BSP, 'Structural view.nwc')).elements.length, 427);
  assert.equal(readNavisworks(join(BSP, 'Second file for simulation.nwc')).elements.length, 1328);
  const t = readNavisworksTimeliner(join(BSP, 'Timeliner test.nwf'));
  assert.deepEqual([t.tasks[0].name, t.tasks[0].children, t.tasks.slice(1).every((x) => x.children === 0)], ['New Data Source (Root)', 9, true]);
  // the path map names elements by their GUID down to the element: 7 column picks are 7 columns
  assert.deepEqual(t.sets.map((s) => s.guids?.length ?? null), [null, 55, 84, 7, 22, 115, 14, 55, 22, 22]);
  const imp = await readImport4d(join(BSP, 'Timeliner test.nwf'), readFileSync(join(BSP, 'Timeliner test.nwf')));
  assert.equal(imp.tasks.length, 9);
  assert.match(imp.notes.join(' '), /Summary tasks left out.*New Data Source \(Root\)/);
});

test('push 2: a reservation for work needs memory, not a project slot (with every slot taken, no project moves out)', async () => {
  const { config, reserveMemory } = await import('../mcp/runtime.ts');
  const a = (await call('new_project', { id: 'SLOTA', start: '2026-03-02' })).d, b = (await call('new_project', { id: 'SLOTB', start: '2026-03-02' })).d;
  const max = config.maxHandles;
  config.maxHandles = sessions.size;
  try { reserveMemory(1048576, 'a small piece of work')(); } finally { config.maxHandles = max; }
  assert.ok(sessions.has(a.handle) && sessions.has(b.handle));
});

const RVT = process.env.P6CLONE_RVT_SAMPLE || 'D:/Backup/Documents/ConREM/1. Semester 1 & 2 Helsinki/2. Semester 2/Applied Product Modelling/Project/APM GROUP 7 SUBMISSION FILES/3. Design Files/Architecture (REVIT)/Architecture Model Reference.rvt';
test('N-37-1: every 4D export of an .rvt model carries the IFC4 it was made into', { skip: !existsSync(RVT) && 'the Revit sample is not on this machine', timeout: 300_000 }, async () => {
  const o = (await call('open_model', { path: RVT, geometry: false })).d;
  const H = { handle: o.handle, owner_key: o.owner_key };
  await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'W1', name: 'Walls', duration_days: 5 }] });
  const walls = (await call('list_elements', { handle: o.handle, class: 'IfcWall', limit: 20 })).d.elements;
  await call('link_elements', { ...H, links: [{ activity: 'W1', guids: walls.map((e: any) => e.guid) }] });
  const dir = tmp('p6-n371r-');
  for (const target of ['navisworks', 'synchro', 'ifc4d', 'csv']) {
    const x = await call('export_4d', { handle: o.handle, target, path: join(dir, target) });
    assert.equal(x.err, false, JSON.stringify(x.d));
    const ifc = x.d.written.find((f: string) => /\.ifc$/i.test(f));
    if (target === 'csv') continue;
    const text = readFileSync(ifc, 'latin1');
    assert.match(text.slice(0, 40), /^ISO-10303-21;/, target);
    assert.ok(walls.every((e: any) => text.includes(e.guid)), target);
  }
  await call('close', { ...H, discard: true });
});
