#!/usr/bin/env node
/**
 * IFC geometry worker — runs in its OWN process (spawned by parse.ts) so a model that exhausts web-ifc's 4 GB WASM
 * heap kills this process, never the app server. Streams every mesh once and writes, without holding them:
 *   <out>/geoms.bin    each DISTINCT mesh once, in its own (local) coordinates: positions float32 xyz, then indices
 *                      uint32. Meshes are told apart by their content (two 32-bit hashes of positions and indices, and
 *                      their counts), so a door family placed 400 times is stored once.
 *   <out>/geoms.meta   Float64Array, 4 numbers per distinct mesh: posOffset, vertexCount, idxOffset, indexCount
 *   <out>/places.bin   Float64Array, 18 numbers per placed mesh: element ordinal, mesh number, the 4x4 placement
 *                      (column-major, model units)
 *   <out>/elems.meta   Float64Array, 13 numbers per meshed element: ordinal, vertices, triangles, volume, bbox (6),
 *                      centroid (3), in model units, from the placed meshes
 *   <out>/geom.json    { elements, placements, meshes, failures, maxAbsCoord, peakRssMb }
 * The element ordinal is the product's place in <products.bin> (the sorted express ids of the model's products: the
 * order of the index), so a chunk of the model maps back to the whole.
 * Usage: node geomWorker.mjs <ifc> <outDir> <memoryLimitGB> <products.bin>
 */
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [ifcPath, outDir, memGb, productsBin] = process.argv.slice(2);
if (!ifcPath || !outDir || !productsBin) { console.error('usage: geomWorker.mjs <ifc> <outDir> <memoryLimitGB> <products.bin>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const pb = readFileSync(productsBin);
const productIds = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
const ordinalOf = (id) => { let lo = 0, hi = productIds.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, v = productIds[mid]; if (v === id) return mid; if (v < id) lo = mid + 1; else hi = mid - 1; } return -1; };

// web-ifc: the path parse.ts passes (beside a bundle), else the package
const mod = await import(process.env.P6CLONE_WEBIFC || 'web-ifc');
const WebIFC = mod.IfcAPI ? mod : mod.default;
const api = new WebIFC.IfcAPI();
await api.Init();
const modelID = api.OpenModel(new Uint8Array(readFileSync(ifcPath)), { MEMORY_LIMIT: (Number(memGb) || 4) * 1024 * 1024 * 1024 });

const geomFd = openSync(join(outDir, 'geoms.bin'), 'w');
const placesFd = openSync(join(outDir, 'places.bin'), 'w');
const elemsFd = openSync(join(outDir, 'elems.meta'), 'w');
let offset = 0, elements = 0, placements = 0, failures = 0, maxAbsCoord = 0;
const meshKey = new Map(); // content key -> mesh number
const meshMeta = []; // 4 per mesh
const flush = (u8) => { let done = 0; while (done < u8.length) done += writeSync(geomFd, u8, done, u8.length - done); offset += u8.length; };
const pad4 = () => { const pad = (4 - (offset % 4)) % 4; if (pad) flush(new Uint8Array(pad)); };
// placements and element rows are written in blocks
const PLACE = 18, ELEM = 13;
let placeBuf = new Float64Array(PLACE * 4096), placeN = 0, elemBuf = new Float64Array(ELEM * 4096), elemN = 0;
const flushPlaces = () => { if (placeN) writeSync(placesFd, new Uint8Array(placeBuf.buffer, 0, placeN * PLACE * 8)); placeN = 0; };
const flushElems = () => { if (elemN) writeSync(elemsFd, new Uint8Array(elemBuf.buffer, 0, elemN * ELEM * 8)); elemN = 0; };
/** Two FNV-1a hashes (different seeds) over 32-bit words. */
function hashes(a, b) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (const u of [a, b]) for (let i = 0; i < u.length; i++) { const w = u[i]; h1 = Math.imul(h1 ^ w, 0x01000193); h2 = Math.imul(h2 ^ (w >>> 7 | w << 25), 0x5bd1e995); h2 ^= h2 >>> 15; }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

try {
  api.StreamAllMeshes(modelID, (mesh) => {
    try {
      const ordinal = ordinalOf(mesh.expressID);
      if (ordinal < 0) return; // not a product of the index (an opening's own mesh, a spatial element)
      const geoms = mesh.geometries;
      let vTotal = 0, iTotal = 0, volume = 0, sx = 0, sy = 0, sz = 0;
      let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      const rows = [];
      for (let gi = 0; gi < geoms.size(); gi++) {
        const g = geoms.get(gi);
        const geom = api.GetGeometry(modelID, g.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        geom.delete?.();
        const n = verts.length / 6;
        if (!n || !idx.length) continue;
        const m = g.flatTransformation;
        const pos = new Float32Array(n * 3);
        for (let vi = 0; vi < n; vi++) { pos[vi * 3] = verts[vi * 6]; pos[vi * 3 + 1] = verts[vi * 6 + 1]; pos[vi * 3 + 2] = verts[vi * 6 + 2]; }
        const ind = idx instanceof Uint32Array ? idx : new Uint32Array(idx);
        // the distinct mesh: written once
        const key = `${hashes(new Uint32Array(pos.buffer), ind)}:${n}:${ind.length}`;
        let meshNo = meshKey.get(key);
        if (meshNo == null) {
          meshNo = meshMeta.length / 4; meshKey.set(key, meshNo);
          pad4(); const po = offset; flush(new Uint8Array(pos.buffer));
          pad4(); const io = offset; flush(new Uint8Array(ind.buffer, ind.byteOffset, ind.byteLength));
          meshMeta.push(po, n, io, ind.length);
        }
        rows.push(meshNo, m);
        // the fingerprint in model coordinates: transformed positions, signed tetrahedra volume
        const w = new Float64Array(n * 3);
        for (let vi = 0; vi < n; vi++) {
          const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
          const tx = m[0] * x + m[4] * y + m[8] * z + m[12], ty = m[1] * x + m[5] * y + m[9] * z + m[13], tz = m[2] * x + m[6] * y + m[10] * z + m[14];
          w[vi * 3] = tx; w[vi * 3 + 1] = ty; w[vi * 3 + 2] = tz;
          sx += tx; sy += ty; sz += tz;
          const a = Math.max(Math.abs(tx), Math.abs(ty), Math.abs(tz)); if (a > maxAbsCoord) maxAbsCoord = a;
          if (tx < minx) minx = tx; if (ty < miny) miny = ty; if (tz < minz) minz = tz;
          if (tx > maxx) maxx = tx; if (ty > maxy) maxy = ty; if (tz > maxz) maxz = tz;
        }
        for (let t = 0; t + 2 < ind.length; t += 3) {
          const a = ind[t] * 3, b = ind[t + 1] * 3, c = ind[t + 2] * 3;
          volume += (w[a] * (w[b + 1] * w[c + 2] - w[b + 2] * w[c + 1]) + w[a + 1] * (w[b + 2] * w[c] - w[b] * w[c + 2]) + w[a + 2] * (w[b] * w[c + 1] - w[b + 1] * w[c])) / 6;
        }
        vTotal += n; iTotal += ind.length;
      }
      if (!iTotal) return;
      for (let k = 0; k < rows.length; k += 2) {
        if (placeN * PLACE >= placeBuf.length) flushPlaces();
        const o = placeN * PLACE, m = rows[k + 1];
        placeBuf[o] = ordinal; placeBuf[o + 1] = rows[k];
        for (let j = 0; j < 16; j++) placeBuf[o + 2 + j] = m[j];
        placeN++; placements++;
      }
      if (elemN * ELEM >= elemBuf.length) flushElems();
      elemBuf.set([ordinal, vTotal, iTotal / 3, Math.abs(volume), minx, miny, minz, maxx, maxy, maxz, sx / vTotal, sy / vTotal, sz / vTotal], elemN * ELEM);
      elemN++; elements++;
    } catch { failures++; }
  });
} finally {
  flushPlaces(); flushElems();
  closeSync(geomFd); closeSync(placesFd); closeSync(elemsFd);
  try { api.CloseModel(modelID); } catch { /* wasm may be gone */ }
}
writeFileSync(join(outDir, 'geoms.meta'), new Uint8Array(new Float64Array(meshMeta).buffer));
const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
writeFileSync(join(outDir, 'geom.json'), JSON.stringify({ elements, placements, meshes: meshMeta.length / 4, failures, maxAbsCoord, geomBytes: offset, peakRssMb }));
console.log(`[geomWorker] ${elements} meshed elements, ${placements} placed meshes of ${meshMeta.length / 4} distinct, ${failures} failures, ${Math.round(offset / 1048576)} MB geometry, peak rss ${peakRssMb} MB`);
process.exit(0);
