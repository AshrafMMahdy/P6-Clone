// Models past one web-ifc run: cut into chunks (each a valid IFC with its products and everything they reference),
// meshed one by one, merged; the result equals a single run. Past the display budget the most detailed elements are
// boxes. A model whose geometry did not build is never drawn as an empty building.
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
  for (const [g, v] of a) assert.ok(Math.abs((b.get(g) ?? -1) - v) < 1e-6, `${g}: ${v} vs ${b.get(g)}`);
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

test('past the display budget the most detailed elements are boxes; every element keeps its node', { timeout: 300_000 }, async () => {
  const glb = join(mkdtempSync(join(tmpdir(), 'p6-glb-')), 'm.glb');
  const r = await withEnv({ P6CLONE_VIEW_MAX_MB: '0.2' }, () => parseIfc(join(FX, 'Duplex_A_20110907.ifc'), { glbOut: glb }));
  const b = readFileSync(glb), jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString());
  assert.equal(b.readUInt32LE(8), b.length, 'GLB length field');
  assert.equal(j.nodes.length, r.index.meshedElements);
  const boxes = j.nodes.filter((n: { extras: { box?: boolean } }) => n.extras.box).length;
  assert.ok(boxes > 0 && boxes < j.nodes.length);
  assert.ok(b.length < 0.4 * 1048576);
  assert.match(r.index.geometryNote ?? '', /as boxes/);
  assert.ok(r.index.elements.some((e) => e.derivedVolumeM3), 'quantities still come from the full geometry');
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
  const r = await call('render_4d', { handle: np.handle, path: mkdtempSync(join(tmpdir(), 'p6-ng-out-')), kind: 'viewer' });
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'no_geometry');
  assert.match(r.d.error.reason, /no 3D geometry: geometry worker script not found/);
  assert.equal((await call('simulate_4d', { handle: np.handle })).err, false, 'everything without 3D still works');
});

test('past P6CLONE_VIEW_BATCH elements the display model is batched: few nodes, every element a vertex range', { timeout: 300_000 }, async () => {
  const glb = join(mkdtempSync(join(tmpdir(), 'p6-batch-')), 'm.glb');
  const r = await withEnv({ P6CLONE_VIEW_BATCH: '20' }, () => parseIfc(join(FX, 'Duplex_A_20110907.ifc'), { glbOut: glb }));
  const b = readFileSync(glb), jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString());
  assert.equal(b.readUInt32LE(8), b.length);
  assert.ok(j.nodes.length < 20, `${j.nodes.length} nodes`);
  let elements = 0;
  for (const n of j.nodes) {
    const ranges = n.extras.batch as (string | number)[];
    assert.ok(Array.isArray(ranges));
    const vertices = j.accessors[j.meshes[n.mesh].primitives[0].attributes.POSITION].count;
    let end = 0;
    for (let k = 0; k < ranges.length; k += 3) { assert.equal(ranges[k + 1], end, 'ranges follow each other'); end += Number(ranges[k + 2]); elements++; }
    assert.equal(end, vertices);
  }
  assert.equal(elements, r.index.meshedElements);
});
