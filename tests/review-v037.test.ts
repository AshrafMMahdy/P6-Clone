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
/** A child server's environment with a temp folder of its own: its recovery folder (and what it adopts from earlier
 *  runs, saved at exit beside their files) stays out of the shared one */
const isolated = () => { const t = tmp('p6-child-'); return { ...process.env, TEMP: t, TMP: t, TMPDIR: t, P6CLONE_MAX_HANDLES: undefined }; };

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
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 * 1048576, env: isolated() });
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

test('activity_table of: assignments / codes pages every resource and code assignment', async () => {
  const p = (await call('new_project', { id: 'PG', start: '2026-03-02' })).d, H = { handle: p.handle, owner_key: p.owner_key };
  const ops: any[] = [{ op: 'add_resource', id: 'CREW', name: 'Crew' }, { op: 'add_code_type', name: 'Zone' }, { op: 'add_code_value', type: 'Zone', code: 'N', name: 'North' }];
  for (let i = 1; i <= 5; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 2 }, { op: 'assign_resource', activity: `A${i}`, resource: 'CREW', units: 8 * i }, { op: 'assign_code', activity: `A${i}`, type: 'Zone', value: 'N' });
  assert.equal((await call('edit', { ...H, operations: ops })).err, false);
  const a = (await call('activity_table', { handle: p.handle, of: 'assignments', limit: 3 })).d;
  assert.deepEqual([a.total, a.rows.length, a.next_offset, a.columns.slice(0, 3)], [5, 3, 3, ['project', 'activity', 'resource']]);
  assert.deepEqual(a.rows[0].slice(1, 3), ['A1', 'CREW']);
  const c = (await call('activity_table', { handle: p.handle, of: 'codes', offset: 3 })).d;
  assert.deepEqual([c.total, c.rows.length, c.next_offset, c.rows[0].slice(1, 5)], [5, 2, null, ['A4', 'Zone', 'N', 'North']]);
});

test('stdio: server_status answers within seconds while a long step holds the main thread', { timeout: 120_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { stdio: ['pipe', 'pipe', 'ignore'], env: isolated() });
  const got = new Map<number, number>(), body = new Map<number, any>(); let buf = '';
  child.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (typeof m.id === 'number') { got.set(m.id, Date.now()); body.set(m.id, m); } } catch { /* not a reply */ } } });
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 0, method: 'initialize', params: {} });
  send({ id: 2, method: 'tools/call', params: { name: 'server_status', arguments: {} } }); // the server is up
  for (let i = 0; i < 600 && !got.has(2); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 3000)); // its state has been posted to the front (every second)
  // a long synchronous step: computing a schedule of 60,000 chained activities
  const activities = Array.from({ length: 60000 }, (_, i) => ({ id: `A${i}`, duration_days: 1, ...(i ? { predecessors: [{ id: `A${i - 1}` }] } : {}) }));
  const t0 = Date.now();
  send({ id: 3, method: 'tools/call', params: { name: 'compute_schedule', arguments: { start: '2026-03-02', activities } } });
  await new Promise((r) => setTimeout(r, 300));
  const asked = Date.now();
  send({ id: 4, method: 'tools/call', params: { name: 'server_status', arguments: {} } });
  for (let i = 0; i < 200 && !got.has(4); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  assert.ok(got.has(4) && got.get(4)! - asked < 3000, `server_status answered after ${got.has(4) ? got.get(4)! - asked : 'never'} ms`);
  // answered by the front while the long call held the main thread (busy), or by the main thread before it began
  const st = body.get(4)?.result?.structuredContent;
  assert.ok(st && (st.busy === true || !got.has(3) || got.get(3)! > got.get(4)!), String(JSON.stringify(body.get(4) ?? null)).slice(0, 400));
  assert.ok(got.has(4) && got.get(4)! - asked < 3000, `server_status answered after ${got.has(4) ? got.get(4)! - asked : 'never'} ms (the long call ran ${got.has(3) ? got.get(3)! - t0 : '?'} ms)`);
});

test('a project busy with a long call is checkpointed; one with a change in progress waits for the change to end', { timeout: 60_000 }, async () => {
  const { config, exclusive, scheduleCheckpoint, changeAsync } = await import('../mcp/runtime.ts');
  const { readdirSync } = await import('node:fs');
  const files = (h: string) => { const out: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else if (e.name.startsWith(h)) out.push(e.name); } }; walk(join(tmpdir(), '.p6clone-recovery')); return out; };
  const was = config.checkpointMs; config.checkpointMs = 30;
  try {
    const p = (await call('new_project', { id: 'CKB', start: '2026-03-02' })).d;
    await exclusive(p.handle, async () => { // a long call holds the project
      scheduleCheckpoint(p.handle);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(files(p.handle).length, 'checkpointed while busy');
    });
    const q = (await call('new_project', { id: 'CKC', start: '2026-03-02' })).d;
    await changeAsync(sessions.get(q.handle)!, 'test', 'slow change', async () => {
      scheduleCheckpoint(q.handle);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(files(q.handle).length, 0, 'not while the change is half-way');
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(files(q.handle).length, 'checkpointed once the change ended');
  } finally { config.checkpointMs = was; }
});

const FORGE = join(import.meta.dirname, '..', 'sample 4D', 'navisworks-models', 'autodesk-forge-samples');
test('N-37-6: a federated NWD (files in files with their lights, embedded textures) and a 2015 DWG drawing (binary material assets, DWG materials, its older meshes) read whole', { skip: !existsSync(join(FORGE, 'Chair.nwd')) && 'the samples are not here', timeout: 300_000 }, () => {
  const t = readNavisworks(join(FORGE, 'test.nwd'));
  assert.deepEqual([t.elements.length, t.source.geometry.elements_with_boxes], [1640, 1]);
  const c = readNavisworks(join(FORGE, 'Chair.nwd'));
  assert.deepEqual([c.elements.length, c.source.geometry.elements_with_meshes, c.source.geometry.elements_with_boxes], [10, 6, 0]);
});
