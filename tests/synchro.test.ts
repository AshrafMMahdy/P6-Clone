import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSynchro } from '../core/bim/synchro.ts';
import { closed } from '../core/bim/meshClosed.mjs';

// study-only SYNCHRO samples (not in the repository); the tests run where they exist
const dir = join(import.meta.dirname, '..', 'sample 4D', 'synchro');
const schep = join(dir, 'schependomlaan', 'Synchro project Schependomlaan.sp');
const none = !existsSync(dir) && 'SYNCHRO samples (sample 4D/synchro) are not present';

function spFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? spFiles(p) : n.toLowerCase().endsWith('.sp') ? [p] : []; });
}

/** a place to the millimetre, as the agent reads it (planImport places the paths so) */
const mm = (x: number) => Math.round(x * 1000) / 1000 || 0;

test('Schependomlaan (SYNCHRO 5.1): 125 tasks with their ST ids, links, the IFC objects and the 4D assignments', { skip: !existsSync(schep) && 'Schependomlaan .sp not present' }, () => {
  const r = readSynchro(readFileSync(schep));
  assert.equal(r.version, '5.1.1.4');
  assert.equal(r.tasks.length, 125);
  const ids = new Set(r.tasks.map((t) => t.id));
  assert.ok(ids.has('ST00020') && ids.has('ST00030'));
  const first = r.tasks.find((t) => t.id === 'ST00020')!;
  assert.equal(first.name, 'Maatvoering gemeente');
  assert.equal(first.start, '2015-02-20 08:00');
  assert.equal(first.finish, '2015-02-20 17:00', 'one 8-hour day on the standard calendar');
  assert.equal(first.durationHours, 8);
  assert.ok(r.predecessors.length > 0);
  assert.ok(r.resources.some((x) => x.name === 'brievenbussen_(#269096)'));
  assert.ok(r.assignments.length > 7000);
  const res = new Set(r.resources.map((x) => x.uuid)), tasks = new Set(r.tasks.map((t) => t.uuid));
  assert.ok(r.assignments.every((a) => tasks.has(a.task) && res.has(a.resource)), 'every assignment joins a task to a resource read from the file');
});

test('every SYNCHRO sample (5.1 to 6.5) parses without throwing', { skip: none }, () => {
  const files = spFiles(dir);
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = readSynchro(readFileSync(f));
    assert.match(r.version, /^\d+\.\d+/, f);
    for (const t of r.tasks) assert.ok(t.start === null || /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(t.start), f);
  }
});

test('a file that is not SYNCHRO is refused', () => {
  assert.throws(() => readSynchro(new Uint8Array(64)), /Not a SYNCHRO/);
});

// ---- a SYNCHRO project as a model (synchroModel.ts) and its 3D paths

const kb = join(dir, 'bentley-kb-training'), ch = join(kb, 'Challenge Models'), tb = join(kb, 'SYNCHRO 4D Training Files', 'SP Files');
const paths3d = join(ch, 'Challenge Model_3D Paths.sp');
const schepIfc = join(import.meta.dirname, '..', 'sample 4D', 'ifc-models', 'schependomlaan', 'IFC Schependomlaan.ifc');
const box = (p: number[]) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[k + a]); mx[a] = Math.max(mx[a], p[k + a]); } return { mn, mx, size: mx.map((x, a) => x - mn[a]) }; };
/** the volume a closed set of triangles encloses (the divergence theorem), here, independently of the clone's own */
const enclosed = (p: number[], t: number[]) => { let v = 0; for (let k = 0; k < t.length; k += 3) { const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3; v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]); } return v / 6; };

test('the world unit: setting 1 is millimetres, 3 metres; another one, or none, is metres assumed (owner, 2026-11-24)', async () => {
  const { worldUnit } = await import('../core/bim/synchro.ts');
  const row = (v: number, code: number) => { const b = Buffer.alloc(4 + (v >= 60 ? 8 : 16) + 16 + 8 + 4); b.writeUInt32LE(0x5075d933, 0); b.writeUInt32LE(code, b.length - 4); return b; };
  assert.deepEqual(worldUnit(row(51, 1), 51), { scale: 0.001, units: 'mm', setting: 1 });
  assert.deepEqual(worldUnit(row(65, 3), 65), { scale: 1, units: 'm', setting: 3 });
  assert.deepEqual(worldUnit(row(60, 2), 60), { scale: 1, units: 'assumed-m', setting: 2 });
  assert.deepEqual(worldUnit(undefined, 60), { scale: 1, units: 'assumed-m', setting: null });
});

test('a polygon left out takes its holes with it; a shape made in SYNCHRO is its profile extruded, facing outwards', async () => {
  const { triangulate, prism } = await import('../core/bim/synchroModel.ts');
  const v = new Float32Array([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 1, 1, 0, 3, 1, 0, 3, 3, 0, 1, 3, 0]);
  const bad = { n: 0 };
  // the square, then a polygon naming vertex 99 followed by a hole: the hole must not cut the square
  const t = triangulate(v, Uint32Array.from([4, 0, 1, 2, 3, 3, 0, 1, 99, -4 >>> 0, 4, 7, 6, 5]), bad);
  assert.equal(bad.n, 2);
  let area = 0;
  for (let k = 0; k < t.length; k += 3) area += ((v[t[k + 1] * 3] - v[t[k] * 3]) * (v[t[k + 2] * 3 + 1] - v[t[k] * 3 + 1]) - (v[t[k + 1] * 3 + 1] - v[t[k] * 3 + 1]) * (v[t[k + 2] * 3] - v[t[k] * 3])) / 2;
  assert.equal(area, 16);
  // a clockwise L-shaped profile (area 3), extruded from 1 to 3: closed, 6 in volume, enclosed facing out
  const { v: pv, tri } = prism([0, 0, 0, 2, 1, 2, 1, 1, 2, 1, 2, 0], 1, 3);
  const pos = Array.from(pv), tr = Array.from(tri);
  assert.ok(Math.abs(enclosed(pos, tr) - 6) < 1e-9, `volume ${enclosed(pos, tr)}`);
  assert.deepEqual([box(pos).mn, box(pos).mx], [[0, 0, 1], [2, 2, 3]]);
});

test('polygons as written: a negative count is a hole in the polygon before it; every triangle faces the way its polygon does', async () => {
  const { triangulate } = await import('../core/bim/synchroModel.ts');
  // a 4 x 4 square (anticlockwise from above: facing +z) with a 2 x 2 hole, and a clockwise triangle (facing -z)
  const v = new Float32Array([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 1, 1, 0, 3, 1, 0, 3, 3, 0, 1, 3, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]);
  const bad = { n: 0 };
  const t = triangulate(v, Uint32Array.from([4, 0, 1, 2, 3, -4 >>> 0, 4, 7, 6, 5, 3, 8, 9, 10, 4, 0, 1, 99, 2]), bad);
  assert.equal(bad.n, 1, 'the polygon naming vertex 99 is left out');
  let up = 0, down = 0, area = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [v[i * 3], v[i * 3 + 1]]);
    const z = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    if (k / 3 < t.length / 3 - 1) { area += z; if (z > 0) up++; } else if (z < 0) down++;
  }
  assert.equal(area, 16 - 4, 'the square less its hole');
  assert.equal(up, t.length / 3 - 1, 'the square’s triangles all face up');
  assert.equal(down, 1, 'the clockwise triangle keeps facing down');
});

test('Schependomlaan opened as a model: each of its objects has the box and the volume of the design IFC element it was made from', { skip: (!existsSync(schep) || !existsSync(schepIfc)) && 'Schependomlaan .sp or IFC not present', timeout: 900_000 }, async () => {
  const { readSynchroModel } = await import('../core/bim/synchroModel.ts');
  const { loadModel } = await import('../core/bim/model.ts');
  const m = readSynchroModel(readFileSync(schep));
  assert.equal(m.units, 'mm');
  assert.equal(m.objects.length, 3569);
  assert.ok(m.objects.every((o) => o.resource), 'every 3D entity of this file is a resource');
  const ifc = await loadModel(schepIfc, { geometry: true });
  const byId = new Map(ifc.index.elements.map((e) => [e.expressId, e]));
  let boxes = 0, compared = 0, volumes = 0, measured = 0;
  for (const o of m.objects) {
    const e = byId.get(Number(/\(#(\d+)\)/.exec(o.name)?.[1]));
    if (!e?.bbox || !o.positions.length) continue;
    compared++;
    // the clone's index is in web-ifc's frame (x, z, -y); SYNCHRO keeps the IFC's own (Z up)
    const { mn, mx } = box(o.positions), t = [mn[0], mn[2], -mx[1], mx[0], mx[2], -mn[1]];
    if (t.every((x, i) => Math.abs(x - e.bbox![i]) < 0.002)) boxes++;
    // signed: the 5.1 file winds its meshes inwards, and a closed mesh is turned to face outwards; an open one encloses no
    // volume to compare (the zinc sheets and a vent grille are open in this file, though their IFC solids are closed)
    if (e.derivedVolumeM3 && e.derivedVolumeM3 > 1e-6 && closed(o.positions, o.triangles)) { measured++; if (Math.abs(enclosed(o.positions, o.triangles) - e.derivedVolumeM3) / e.derivedVolumeM3 < 0.01) volumes++; }
  }
  assert.equal(compared, 3504);
  assert.equal(boxes, compared, 'every box within 2 mm');
  assert.ok(measured > 3400);
  assert.equal(volumes, measured, 'every closed object\u2019s volume within 1%, and positive');
});

test('objects come out the size they are named: 610 x 610mm columns (6.0, millimetres) and a 910x2110mm door with its frame (6.5, metres)', { skip: none, timeout: 300_000 }, async () => {
  const { readSynchroModel } = await import('../core/bim/synchroModel.ts');
  const cols = readSynchroModel(readFileSync(paths3d)).objects.filter((o) => o.name === '610 x 610mm');
  assert.ok(cols.length > 50);
  // the type names the section (the height is each column's own storey's)
  for (const c of cols) assert.deepEqual(box(c.positions).size.slice(0, 2).map((x) => Math.round(x * 1000)), [610, 610]);
  const tbm = readSynchroModel(readFileSync(join(tb, 'SYNCHRO Training Building Completed.sp')));
  assert.equal(tbm.units, 'm');
  const door = tbm.objects.find((o) => o.groups.at(-1) === '910x2110mm (1)')!;
  assert.deepEqual(box(door.positions).size.map((x) => Math.round(x * 1000)), [960, 199, 2110]);
});

test('the same building as resources (Auto Matching) and as a scene no resource draws (Filters, 5.4 and 6.3): the same objects and triangles', { skip: none, timeout: 300_000 }, async () => {
  const { readSynchroModel } = await import('../core/bim/synchroModel.ts');
  const sum = (f: string) => { const m = readSynchroModel(readFileSync(join(ch, f))); return { n: m.objects.length, res: m.objects.filter((o) => o.resource).length, tri: m.objects.reduce((k, o) => k + o.triangles.length / 3, 0), ext: box(m.objects.flatMap((o) => box(o.positions).mn.concat(box(o.positions).mx))).size.map((x) => Math.round(x * 1000)) }; };
  const am = sum('Challenge Model_Auto Matching.sp'), f54 = sum('Challenge Model_Filters.sp'), f63 = sum('Challenge Model_Filters_Solution.sp');
  assert.deepEqual([am.n, am.res, am.tri], [2539, 2539, 225722]);
  assert.deepEqual([f54.n, f54.res, f54.tri], [2539, 0, 225722]);
  assert.deepEqual(f63, f54, 'placements as doubles (6.3) and as floats (5.4) give the same model');
  assert.deepEqual(f54.ext, am.ext);
});

test('3D paths: keyframes (share of the task, place, rotation) and the assignment that follows each; 6.3+ places in doubles', { skip: none }, () => {
  const p = readSynchro(readFileSync(paths3d));
  const lift = p.paths.find((x) => x.name === 'Crane 2 - Podium Lift')!;
  assert.deepEqual(lift.points.map((k) => Math.round(k.at * 1000) / 1000), [0, 0.175, 0.729, 1]);
  assert.deepEqual(lift.points[0].position.map((x) => Math.round(x * 100) / 100), [-1818.56, 60624.96, 4996.77]);
  assert.deepEqual(lift.points[0].rotation, [0, 0, 0, 1]);
  assert.ok(Math.abs(Math.hypot(...lift.points[2].rotation) - 1) < 1e-9, 'a unit quaternion');
  const follows = p.assignments.filter((a) => a.path);
  assert.equal(follows.length, 1);
  assert.equal(follows[0].path, lift.uuid);
  assert.equal(p.resources.find((r) => r.uuid === follows[0].resource)!.name, 'Load 3');
  assert.equal(readSynchro(readFileSync(join(ch, 'Challenge Model_3D Paths_Solution.sp'))).assignments.filter((a) => a.path).length, 4, 'the solution (5.4) moves all four');
  const ex = readSynchro(readFileSync(join(tb, 'SYNCHRO Training Building Completed.sp'))).paths;
  assert.deepEqual(ex.map((x) => [x.name, x.points.length]), [['Foundation Excavation', 4]]);
  assert.deepEqual(ex[0].points[0].position.map((x) => Math.round(x * 100) / 100), [-1.21, -21.65, -0.2]);
});

test('the loads the crane paths move are drawn: a profile extruded, each where its path starts (3D Paths, 6.0 and 5.4)', { skip: none }, async () => {
  const { readSynchroModel } = await import('../core/bim/synchroModel.ts');
  for (const f of ['Challenge Model_3D Paths.sp', 'Challenge Model_3D Paths_Solution.sp']) {
    const m = readSynchroModel(readFileSync(join(ch, f)));
    const loads = m.objects.filter((o) => /Load/.test(o.name));
    assert.deepEqual(loads.map((o) => o.name).sort(), ['Load', 'Load 2', 'Load 3', 'Small Load 1'], f);
    for (const o of loads) assert.ok(o.triangles.length >= 36 && enclosed(o.positions, o.triangles) > 0, `${o.name} drawn, facing out`);
    const lift = m.file.paths.find((p) => p.name === 'Crane 2 - Podium Lift')!, mover = m.file.assignments.find((a) => a.path === lift.uuid)!;
    const load = m.objects.find((o) => o.uuid === mover.resource)!, b = box(load.positions);
    // SYNCHRO puts a keyframe at the object's centre: the first one, independently of the shape's own numbers
    assert.deepEqual(b.mn.map((x, a) => Math.round(((x + b.mx[a]) / 2) * 1000)), lift.points[0].position.map((x) => Math.round(x)), f);
  }
});

/** The same .sp with one table replaced by other inflated bytes (compressed again, the directory's offsets moved to match). */
async function withTable(file: Buffer, name: string, inflated: (raw: Buffer) => Buffer): Promise<Buffer> {
  const { container, directory } = await import('../core/bim/synchro.ts');
  const { deflateSync } = await import('node:zlib');
  const head = directory(file)!, raw = container(file, [], [name])!.tables.get(name)!;
  const parts = head.dir.map((t, k) => ({ ...t, bytes: file.subarray(t.at, k + 1 < head.dir.length ? head.dir[k + 1].at : file.length) }));
  const e = parts.find((t) => t.name === name)!;
  const nameLen = e.bytes.indexOf(Buffer.from(name, 'latin1')) + name.length;
  // a table read with its 24-byte head (from schema 353) gets it back
  const whole = file.subarray(e.at + nameLen);
  const { inflateSync } = await import('node:zlib');
  const full = inflateSync(whole.subarray(0, e.bytes.length - nameLen));
  const prefix = full.length - raw.length;
  e.bytes = Buffer.concat([e.bytes.subarray(0, nameLen), deflateSync(Buffer.concat([full.subarray(0, prefix), inflated(raw)]))]);
  const start = parts[0].at, dirAt = file.indexOf(Buffer.from(head.dir.find((t) => t.at === start)!.name, 'latin1'), 20);
  const out = Buffer.from(file.subarray(0, start));
  let at = start;
  for (const t of parts) {
    for (let q = dirAt; q + 48 <= start; q += 48) if (out.readUInt32LE(q + 40) === t.at && out.subarray(q, q + t.name.length).toString('latin1') === t.name) out.writeUInt32LE(at, q + 40);
    at += t.bytes.length;
  }
  return Buffer.concat([out, ...parts.map((t) => t.bytes)]);
}

test('an Entities table that stops part-way: what was read before that point is drawn, and said', { skip: !existsSync(schep) && 'Schependomlaan .sp not present', timeout: 300_000 }, async () => {
  const { readSynchroModel } = await import('../core/bim/synchroModel.ts');
  const m = readSynchroModel(await withTable(readFileSync(schep), 'Entities', (raw) => raw.subarray(0, Math.floor(raw.length * 0.9))));
  const drawn = m.objects.filter((o) => o.triangles.length).length;
  assert.ok(drawn > 2500 && drawn < 3505, `${drawn} objects drawn`);
  assert.ok(m.notes.some((n) => /Entities table could not all be read \(the table ends inside an entity\); what was read before that point is drawn/.test(n)), m.notes.join(' | '));
  assert.ok(m.notes.some((n) => /were not read \(the 3D scene stopped early\)/.test(n)));
});

test('a unit setting no file has shown: the model opens, its numbers taken as metres and said to be assumed (owner, 2026-11-24)', { skip: none, timeout: 600_000 }, async () => {
  const { readSynchroModel, writeSynchroIfc } = await import('../core/bim/synchroModel.ts');
  const { loadModel } = await import('../core/bim/model.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // 3D Paths (millimetres) with its unit setting made 2
  const f = await withTable(readFileSync(paths3d), '3DWorldSettings', (raw) => { const b = Buffer.from(raw); b.writeUInt32LE(2, 4 + 8 + 16 + 8); return b; });
  const m = readSynchroModel(f);
  assert.equal(m.units, 'assumed-m');
  assert.match(m.file.unitNote ?? '', /setting 2, which no SYNCHRO file read so far has used .*taken as metres \(assumed/);
  const col = m.objects.find((o) => o.name === '610 x 610mm')!;
  assert.deepEqual(box(col.positions).size.slice(0, 2).map((x) => Math.round(x)), [610, 610], 'the numbers as they are, not scaled');
  const ifc = join(mkdtempSync(join(tmpdir(), 'sp-unit-')), 'm.ifc');
  writeSynchroIfc(f, ifc, 'unit2.sp');
  // the model in those metres: the same sizes as the paths import_4d gives from this file
  const ix = (await loadModel(ifc, { geometry: true })).index;
  const c = ix.elements.find((e) => e.name === '610 x 610mm' && e.bbox)!;
  assert.deepEqual([c.bbox![3] - c.bbox![0], c.bbox![5] - c.bbox![2]].map((x) => Math.round(x)), [610, 610]);
  const { synchroToImport } = await import('../core/bim/read4d.ts');
  assert.deepEqual(synchroToImport(readSynchro(f)).paths!.find((p) => p.name === 'Crane 2 - Podium Lift')!.keyframes[0].position_m.map(mm), [-1818.561, 60624.957, 4996.766]);
});

test('the paths as the agent reads them (import_4d): who follows each in which task; each keyframe\u2019s share, place in metres, rotation in degrees', { skip: none }, async () => {
  const { synchroToImport } = await import('../core/bim/read4d.ts');
  const lift = synchroToImport(readSynchro(readFileSync(paths3d))).paths!.find((p) => p.name === 'Crane 2 - Podium Lift')!;
  assert.deepEqual(lift.followed_by, [{ resource: 'Load 3', task: 'ST00160' }]);
  assert.deepEqual(lift.keyframes.map((k) => k.percent_of_task), [0, 17.5, 72.9, 100]);
  assert.deepEqual(lift.keyframes[0].position_m.map(mm), [-1.819, 60.625, 4.997]);
  // the quaternion (0, 0, 0.678, 0.735) is a turn of 2 x atan2(0.678, 0.735) about the vertical
  assert.deepEqual(lift.keyframes[2].rotation_deg, [0, 0, 85.4]);
  const ex = synchroToImport(readSynchro(readFileSync(join(tb, 'SYNCHRO Training Building Completed.sp')))).paths!;
  assert.deepEqual(ex.map((p) => [p.name, p.followed_by[0]?.resource, p.keyframes.length]), [['Foundation Excavation', 'Excavator', 4]]);
  assert.deepEqual(ex[0].keyframes[0].position_m.map(mm), [-1.207, -21.652, -0.2], 'a metre file, read as metres');
});

test('length_unit on a SYNCHRO project: its objects and its paths placed by the caller’s unit, the assumed unit no longer said; and in place of the file’s own (owner, 2026-11-24)', { skip: none, timeout: 900_000 }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  // 3D Paths (millimetres) with its unit setting made 2: a unit the reader does not know
  const unit2 = join(mkdtempSync(join(tmpdir(), 'sp-lu-')), 'unit2.sp');
  writeFileSync(unit2, await withTable(readFileSync(paths3d), '3DWorldSettings', (raw) => { const b = Buffer.from(raw); b.writeUInt32LE(2, 4 + 8 + 16 + 8); return b; }));
  const lift = (r: { d: any }) => r.d.paths.find((p: { name: string }) => p.name === 'Crane 2 - Podium Lift').keyframes[0].position_m;
  const assumed = (r: { d: any }) => r.d.notes.some((n: string) => /taken as metres \(assumed/.test(n));
  const np = (await call('new_project', { currency: 'USD', id: 'SLU', start: '2018-07-02' })).d, h = np.handle, owner_key = np.owner_key;
  // as the file is read: its numbers taken as metres, said
  const a = await call('open_model', { handle: h, owner_key, path: unit2, geometry: false });
  assert.equal(a.err, false, JSON.stringify(a.d).slice(0, 400));
  assert.equal(a.d.length_unit, 'm (assumed: the file states no unit the reader knows)');
  assert.match(a.d.source.unit_note, /setting 2/);
  assert.match(a.d.unit_note, /measure an element whose real size you know/, 'told to measure');
  const ia = await call('import_4d', { handle: h, owner_key, path: unit2, link: false });
  assert.deepEqual(lift(ia), [-1818.561, 60624.957, 4996.766]);
  assert.ok(assumed(ia));
  assert.match(ia.d.unit_note, /measure an element whose real size you know/, 'the paths too');
  // the caller measured a column (610 x 610 mm): millimetres
  const b = await call('open_model', { handle: h, owner_key, path: unit2, length_unit: 'mm' });
  assert.equal(b.err, false, JSON.stringify(b.d).slice(0, 400));
  assert.equal(b.d.length_unit, 'mm (given by the caller; the file states no unit the reader knows)');
  assert.equal(b.d.source.unit_note, undefined);
  assert.equal(b.d.unit_note, undefined);
  const col = (await call('list_elements', { handle: h, where: [{ property: 'name', value: '610 x 610mm' }], limit: 1 })).d.elements[0];
  const bb = (await call('element_info', { handle: h, guids: [col.guid] })).d.elements[0].bbox;
  assert.deepEqual([bb[3] - bb[0], bb[5] - bb[2]].map((x: number) => Math.round(x * 1000) / 1000), [0.61, 0.61]);
  const ib = await call('import_4d', { handle: h, owner_key, path: unit2, link: false });
  assert.deepEqual(lift(ib), [-1.819, 60.625, 4.997], 'the paths placed by the caller’s unit, as the model is');
  assert.ok(!assumed(ib));
  assert.equal(ib.d.unit_note, undefined);
  // the file's own unit (millimetres) replaced: metres
  const c = await call('open_model', { handle: h, owner_key, path: paths3d, length_unit: 'm', geometry: false });
  assert.equal(c.d.length_unit, 'm (given by the caller; the file states mm)');
  assert.deepEqual(lift(await call('import_4d', { handle: h, owner_key, path: paths3d, link: false })), [-1818.561, 60624.957, 4996.766]);
});
