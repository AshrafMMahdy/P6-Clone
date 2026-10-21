// Models past one web-ifc run: cut into chunks (each a valid IFC with its products and everything they reference),
// meshed one by one; the result equals a single run. The display model is tiles of the full geometry (no boxes), every
// element with every triangle. A model whose geometry did not build is never drawn as an empty building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIfc } from '../core/bim/parse.ts';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const withEnv = async <T,>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v; }
};
const volumes = (ix: Awaited<ReturnType<typeof parseIfc>>['index']) => new Map(ix.elements.filter((e) => e.geom).map((e) => [e.guid, e.derivedVolumeM3!]));

test('chunked geometry equals a single run (Duplex in many chunks: every mesh, every volume, the openings cut)', { timeout: 300_000 }, async () => {
  const one = await withEnv({ P6CLONE_GEOM_CHUNK_MB: undefined }, () => parseIfc(join(FX, 'Duplex_A_20110907.ifc')));
  const cut = await withEnv({ P6CLONE_GEOM_CHUNK_MB: '0.1' }, () => parseIfc(join(FX, 'Duplex_A_20110907.ifc')));
  assert.match(cut.index.geometryNote ?? '', /meshed in \d+ chunks/);
  assert.ok(Number(/meshed in (\d+)/.exec(cut.index.geometryNote!)![1]) > 5);
  const a = volumes(one.index), b = volumes(cut.index);
  assert.equal(b.size, a.size);
  // an open mesh has no volume in either run (null); the rest agree to the micro-cubic-metre
  for (const [g, v] of a) { const w = b.get(g); assert.ok(w === v || (w != null && v != null && Math.abs(w - v) < 1e-6), `${g}: ${v} vs ${w}`); }
});

/** A synthetic IFC4 storey of n walls (extruded rectangles), a few MB. */
function walls(n: number): string {
  const L: string[] = [];
  let id = 100;
  const g = (k: number) => (k.toString(36).padStart(8, '0') + '0'.repeat(14)).slice(0, 22).replace(/[^0-9A-Za-z]/g, 'x');
  L.push(`#1=IFCPROJECT('${g(1)}',$,'Big',$,$,$,$,(#11),#9);`, '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#9=IFCUNITASSIGNMENT((#5));');
  L.push('#10=IFCCARTESIANPOINT((0.,0.,0.));', '#12=IFCAXIS2PLACEMENT3D(#10,$,$);', "#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$);");
  L.push('#20=IFCLOCALPLACEMENT($,#12);', `#21=IFCBUILDINGSTOREY('${g(2)}',$,'Level 1',$,$,#20,$,$,.ELEMENT.,0.);`, `#22=IFCRELAGGREGATES('${g(3)}',$,$,$,#1,(#21));`);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 100) * 3, y = Math.floor(i / 100) * 3;
    const p = id++, a = id++, lp = id++, prof = id++, pa = id++, dir = id++, sol = id++, rep = id++, shp = id++, w = id++;
    L.push(`#${p}=IFCCARTESIANPOINT((${x}.,${y}.,0.));`, `#${a}=IFCAXIS2PLACEMENT3D(#${p},$,$);`, `#${lp}=IFCLOCALPLACEMENT(#20,#${a});`);
    const o2 = id++;
    L.push(`#${pa}=IFCAXIS2PLACEMENT2D(#${o2},$);`, `#${o2}=IFCCARTESIANPOINT((0.,0.));`);
    L.push(`#${prof}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${pa},2.,0.2);`, `#${dir}=IFCDIRECTION((0.,0.,1.));`, `#${sol}=IFCEXTRUDEDAREASOLID(#${prof},$,#${dir},3.);`);
    L.push(`#${rep}=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#${sol}));`, `#${shp}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
    L.push(`#${w}=IFCWALL('${g(1000 + i)}',$,'Wall ${i}',$,$,#${lp},#${shp},$,$);`);
    ids.push(w);
  }
  L.push(`#${id}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${g(4)}',$,$,$,(${ids.map((x) => `#${x}`).join(',')}),#21);`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\nFILE_NAME('big.ifc','2026-10-21T00:00:00',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

test('a large synthetic model in many chunks: every one of its 20,000 walls meshed, 1.2 m³ each', { timeout: 600_000 }, async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'p6-big-')), 'big.ifc');
  writeFileSync(f, walls(20_000), 'latin1');
  const r = await withEnv({ P6CLONE_GEOM_CHUNK_MB: '0.5' }, () => parseIfc(f));
  assert.equal(r.index.elements.length, 20_000);
  assert.match(r.index.geometryNote ?? '', /meshed in \d+ chunks/);
  assert.equal(r.index.meshedElements, 20_000);
  assert.ok(r.index.elements.every((e) => e.derivedVolumeM3 != null && Math.abs(e.derivedVolumeM3 - 1.2) < 1e-3), 'each wall 2 x 0.2 x 3 m');
});

/** A tile's glTF JSON and its binary chunk. */
function readTile(file: string): { json: any; bin: Buffer; total: number } {
  const b = readFileSync(file), jl = b.readUInt32LE(12);
  return { json: JSON.parse(b.subarray(20, 20 + jl).toString()), bin: b.subarray(28 + jl), total: b.readUInt32LE(8) };
}
/** Every element ordinal a tile folder draws, with the triangles it draws for it. */
function tileTriangles(dir: string): Map<number, number> {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const out = new Map<number, number>();
  for (const t of m.tiles) {
    const { json, bin, total } = readTile(join(dir, t.file));
    assert.equal(total, readFileSync(join(dir, t.file)).length, 'GLB length field');
    for (const n of json.nodes) {
      const prim = json.meshes[n.mesh].primitives[0], tris = json.accessors[prim.indices].count / 3;
      const u32 = (bv: number) => { const v = json.bufferViews[bv]; return new Uint32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + v.byteLength)); };
      if (n.extras.p6c.kind === 'instances') { for (const o of u32(n.extras.p6c.ordinals)) out.set(o, (out.get(o) ?? 0) + tris); continue; }
      // a batch: each element a range of vertices, the ranges one after another; its triangles are the indices that
      // fall in its range
      const r = u32(n.extras.p6c.ranges), idx = (() => { const a = json.accessors[prim.indices], v = json.bufferViews[a.bufferView]; return new Uint32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + v.byteLength)); })();
      let end = 0;
      for (let k = 0; k < r.length; k += 3) { assert.equal(r[k + 1], end, 'ranges follow each other'); end += r[k + 2]; }
      assert.equal(end, json.accessors[prim.attributes.POSITION].count);
      const owner = new Uint32Array(end); for (let k = 0; k < r.length; k += 3) owner.fill(r[k], r[k + 1], r[k + 1] + r[k + 2]);
      for (let k = 0; k < idx.length; k += 3) out.set(owner[idx[k]], (out.get(owner[idx[k]]) ?? 0) + 1);
    }
  }
  return out;
}

test('display tiles are the full geometry: every meshed element with every triangle, tiles within their size, repeats instanced', { timeout: 300_000 }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'p6-tiles-')), 'tiles');
  const r = await withEnv({ P6CLONE_TILE_MB: '0.25' }, () => parseIfc(join(FX, 'Duplex_A_20110907.ifc'), { tilesOut: dir, tileBytes: 0.25 * 1048576 }));
  assert.equal(r.index.geometryStatus, 'ok');
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.format, 'p6c-4d-tiles');
  assert.ok(m.tiles.length > 2, `${m.tiles.length} tiles`);
  assert.equal(m.elements, r.index.elements.length);
  assert.equal(readFileSync(join(dir, 'elements.txt'), 'utf8').split('\n')[5], r.index.elements[5].guid, 'GlobalIds by ordinal');
  // no stand-ins: each element's triangles in the tiles are its triangles in the geometry
  const drawn = tileTriangles(dir);
  let meshed = 0;
  r.index.elements.forEach((e, o) => { if (!e.geom) return; meshed++; assert.equal(drawn.get(o), e.geom.triangles, `${e.guid} (${e.ifcClass})`); });
  assert.equal(meshed, r.index.meshedElements);
  assert.equal(drawn.size, meshed);
  // a tile holds at most its size, unless one element alone is bigger
  const biggest = Math.max(...r.index.elements.map((e) => (e.geom?.triangles ?? 0) * 3 * 16));
  for (const t of m.tiles) assert.ok(t.bytes <= Math.max(0.25 * 1048576, biggest) + 65536, `${t.file}: ${t.bytes} bytes`);
  assert.ok(m.instances > 0, 'Duplex places its doors and windows again: instanced');
  assert.equal(m.tiles.reduce((n: number, t: { instances: number }) => n + t.instances, 0), m.instances);
});

test('a big model meshed in chunks: tiles of every chunk, numbered on, and every element in them once', { timeout: 600_000 }, async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'p6-bigt-')), 'big.ifc');
  writeFileSync(f, walls(6_000), 'latin1');
  const dir = join(mkdtempSync(join(tmpdir(), 'p6-bigt-')), 'tiles');
  const r = await parseIfc(f, { tilesOut: dir, chunkBytes: 0.3 * 1048576, tileBytes: 0.1 * 1048576 });
  assert.match(r.index.geometryNote ?? '', /meshed in \d+ chunks/);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.tiles.map((t: { file: string }) => t.file), m.tiles.map((_: unknown, i: number) => `tile-${String(i).padStart(5, '0')}.glb`));
  const drawn = tileTriangles(dir);
  assert.equal(drawn.size, 6_000);
  assert.ok([...drawn.values()].every((n) => n === 12), 'a wall is a box: 12 triangles');
  // identical walls (the same extrusion everywhere): one mesh, placed 6,000 times
  assert.equal(m.instances, 6_000);
});

test('render_4d refuses a model whose geometry did not build (no empty building), and says why', { timeout: 120_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const x = await callTool(name, args); return { err: x.isError, d: toolResult(x.out, x.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'NG', start: '2026-03-02' })).d;
  const f = join(mkdtempSync(join(tmpdir(), 'p6-ng-')), 'small.ifc');
  writeFileSync(f, walls(3), 'latin1'); // a model of its own (not cached), opened with a geometry worker that is missing
  await withEnv({ WHIQ_IFC_GEOM_WORKER: join(tmpdir(), 'no-such-worker.mjs') }, async () => {
    const om = await call('open_model', { handle: np.handle, owner_key: np.owner_key, path: f });
    assert.equal(om.d.geometry, 'unavailable');
  });
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: [{ op: 'add_activity', id: 'W', name: 'Walls', duration_days: 2 }] });
  await call('link_by_rules', { handle: np.handle, owner_key: np.owner_key, rules: [{ type: 'scope', activity: 'W', class: 'IfcWall' }] });
  // render_4d meshes it again once (a failure may pass); still without its worker, it is refused in words
  const r = await withEnv({ WHIQ_IFC_GEOM_WORKER: join(tmpdir(), 'no-such-worker.mjs') }, () => call('render_4d', { handle: np.handle, path: mkdtempSync(join(tmpdir(), 'p6-ng-out-')), kind: 'viewer' }));
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'no_geometry');
  assert.match(r.d.error.reason, /no 3D geometry: geometry worker script not found/);
  assert.equal((await call('simulate_4d', { handle: np.handle })).err, false, 'everything without 3D still works');
});
