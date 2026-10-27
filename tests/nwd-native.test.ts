// Navisworks models read as they are (nwd/native.ts): the same index an IFC of them gives, element for element, with no
// IFC in between; the geometry streamed a piece at a time; an .nwf's models one at a time, in the reader's own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.P6CLONE_MODEL_CACHE = mkdtempSync(join(tmpdir(), 'p6-nwnative-'));
const { loadModel } = await import('../core/bim/model.ts');
const { nwdToIfc } = await import('../core/bim/nwd.ts');
const { parseIfc } = await import('../core/bim/parse.ts');
const { plainElement } = await import('../core/bim/element.ts');
const { openContainer, readContainer, section, sectionPieces } = await import('../core/bim/nwd/container.ts');

const FIX = join(import.meta.dirname, 'fixtures', 'navisworks');
const SAMPLES = join(import.meta.dirname, '..', 'sample 4D', 'navisworks-models');
const models = [join(FIX, 'hello.nwc'), join(FIX, 'Electrical.nwc'), join(SAMPLES, 'autodesk-forge-samples', 'test.nwd'), join(SAMPLES, 'autodesk-forge-samples', 'Chair.nwd'), join(SAMPLES, 'duchangyu-client-timeliner', 'gatehouse.nwd'), join(SAMPLES, 'aussieBIMguru-bsp-timeliner', 'Timeliner test.nwf')];

for (const path of models) {
  test(`${path.split(/[\\/]/).pop()}: read as it is, the index its IFC gives (identity, class, storey, properties, quantities, express ids, geometry)`, { skip: !existsSync(path) && 'the sample is not here', timeout: 600_000 }, async () => {
    const m = await loadModel(path, { geometry: true });
    assert.ok((m.source as { peak_memory_mb?: number }).peak_memory_mb! > 0, 'read by the reader in its own process');
    const { ifc } = await nwdToIfc(path);
    const { index } = await parseIfc(ifc, { geometry: true });
    const a = m.index.elements.map(plainElement), b = index.elements.map(plainElement);
    assert.equal(a.length, b.length);
    for (const k of ['schema', 'lengthScale', 'lengthScaleSource', 'storeys', 'classCounts', 'quantifiedElements', 'units', 'header'] as const) assert.deepEqual(m.index[k], index[k], k);
    let volumeCalls = 0, meshed = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      for (const k of ['guid', 'expressId', 'ifcClass', 'name', 'storey', 'material', 'typeName', 'discipline', 'authored', 'quantityInfo', 'props'] as const) assert.deepEqual(x[k], y[k], `${i} ${x.name}: ${k}`);
      assert.equal(x.expressId, i + 1);
      assert.equal(!!x.geom, !!y.geom, `${i} ${x.name}: geometry`);
      if (!x.geom || !y.geom) continue;
      meshed++;
      // web-ifc reads the IFC's coordinates to a millionth and keeps them in float32 (a thin steel section's volume moves
      // by a tenth of a percent); the reader keeps the file's own
      const tol = 1e-3 * Math.max(1, ...y.geom.bbox.map(Math.abs));
      x.geom.bbox.forEach((v, j) => assert.ok(Math.abs(v - y.geom!.bbox[j]) <= tol, `${i} ${x.name}: bbox ${x.geom!.bbox} vs ${y.geom!.bbox}`));
      assert.ok(Math.abs(x.geom.triangles - y.geom.triangles) <= Math.max(4, 0.05 * y.geom.triangles), `${i} ${x.name}: triangles ${x.geom.triangles} vs ${y.geom.triangles}`); // web-ifc drops the degenerate ones
      const va = x.derivedVolumeM3, vb = y.derivedVolumeM3;
      if ((va === null) !== (vb === null)) volumeCalls++;
      // the same, or (thin steel, whose float32 corners move it most) closer to the volume Revit computed
      else if (va !== null && vb !== null) assert.ok(Math.abs(va - vb) <= 5e-3 * Math.max(0.01, vb) || (x.authored.NetVolume != null && Math.abs(va - x.authored.NetVolume) < Math.abs(vb - x.authored.NetVolume)), `${i} ${x.name}: volume ${va} vs ${vb} (Revit: ${x.authored.NetVolume})`);
    }
    // whether a mesh is closed can tip on the IFC's rounding of its corners: a few elements at most
    assert.ok(volumeCalls <= Math.max(2, 0.01 * meshed), `${volumeCalls} of ${meshed} elements are closed in one and open in the other`);
  });
}

test('the geometry read a stream at a time from disk, through a window smaller than its streams, is the section as a whole', () => {
  const path = existsSync(join(SAMPLES, 'autodesk-forge-samples', 'test.nwd')) ? join(SAMPLES, 'autodesk-forge-samples', 'test.nwd') : join(FIX, 'Electrical.nwc');
  const whole = section(readContainer(new Uint8Array(readFileSync(path))), 'LcOpNwdGeometry', 1 << 30)!;
  for (const window of [16 << 20, 4096, 100]) {
    const pieces = [...sectionPieces(openContainer(path), 'LcOpNwdGeometry', window)];
    assert.ok(Buffer.from(whole).equals(Buffer.concat(pieces)), `window ${window}`);
  }
});

test('a federation (an .nwf of three models): every model read, one after the other, by the reader in its own process', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-fed-'));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'make-federation.ts'), join(FIX, 'Electrical.nwc'), '3', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = await loadModel(join(dir, 'federation.nwf'), { geometry: true });
  const src = m.source as { files: { read: boolean; elements: number }[]; peak_memory_mb?: number };
  assert.deepEqual(src.files.map((f) => [f.read, f.elements]), [[true, 46], [true, 46], [true, 46]]);
  assert.equal(m.index.elements.length, 138);
  assert.ok(src.peak_memory_mb! > 0);
  assert.ok(m.tiles, 'display tiles');
  // the elements of each model keep their order and their own express ids
  assert.deepEqual(m.index.elements.slice(0, 3).map((e) => e.expressId), [1, 2, 3]);
  assert.equal(m.index.elements[46].guid, m.index.elements[0].guid);
});
