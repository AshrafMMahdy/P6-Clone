#!/usr/bin/env node
/**
 * IFC geometry worker — runs in its OWN process (spawned by parse.ts) so a model that exhausts web-ifc's
 * 4 GB WASM heap kills this process, never the app server. Streams every mesh once and writes:
 *   <out>/geom.bin   positions (float32, model units, transformed) + indices (uint32), one view pair per element
 *   <out>/geom.meta  Float64Array, 16 numbers per meshed element:
 *                    expressId, posOffset, posCount, idxOffset, idxCount, volume, triangles,
 *                    bbox(minx,miny,minz,maxx,maxy,maxz), centroid(x,y,z)
 *   <out>/geom.json  { views, maxAbsCoord, failures, binBytes }   (views = count; the table is the .meta file)
 * Nothing is accumulated in JS arrays: each mesh goes to typed arrays and straight to disk.
 * Usage: node geomWorker.mjs <ifc> <outDir> [memoryLimitGB]
 */
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const META_STRIDE = 16;

const [ifcPath, outDir, memGb] = process.argv.slice(2);
if (!ifcPath || !outDir) { console.error('usage: geomWorker.mjs <ifc> <outDir> [memoryLimitGB]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
// web-ifc: the path parse.ts passes (beside a bundle), else the package
const mod = await import(process.env.P6CLONE_WEBIFC || 'web-ifc');
const WebIFC = mod.IfcAPI ? mod : mod.default;
const api = new WebIFC.IfcAPI();
await api.Init();
const modelID = api.OpenModel(new Uint8Array(readFileSync(ifcPath)), { MEMORY_LIMIT: (Number(memGb) || 4) * 1024 * 1024 * 1024 });

const fd = openSync(join(outDir, 'geom.bin'), 'w');
const metaFd = openSync(join(outDir, 'geom.meta'), 'w');
let offset = 0;
let views = 0;
let failures = 0;
let maxAbsCoord = 0;
const metaRow = new Float64Array(META_STRIDE);
const pad4 = () => { const pad = (4 - (offset % 4)) % 4; if (pad) { writeSync(fd, Buffer.alloc(pad)); offset += pad; } };
const flush = (u8) => { let done = 0; while (done < u8.length) done += writeSync(fd, u8, done, u8.length - done); offset += u8.length; };

try {
  api.StreamAllMeshes(modelID, (mesh) => {
    try {
      const geoms = mesh.geometries;
      let vTotal = 0, iTotal = 0;
      const parts = [];
      for (let gi = 0; gi < geoms.size(); gi++) {
        const g = geoms.get(gi);
        const geom = api.GetGeometry(modelID, g.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        parts.push({ verts, idx, m: g.flatTransformation });
        vTotal += verts.length / 6; iTotal += idx.length;
        geom.delete?.();
      }
      if (!iTotal) return;
      const pos = new Float32Array(vTotal * 3);
      const ind = new Uint32Array(iTotal);
      let vb = 0, ib = 0;
      let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      let sx = 0, sy = 0, sz = 0, volume = 0;
      for (const { verts, idx, m } of parts) {
        const n = verts.length / 6;
        for (let vi = 0; vi < n; vi++) {
          const x = verts[vi * 6], y = verts[vi * 6 + 1], z = verts[vi * 6 + 2];
          const tx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const ty = m[1] * x + m[5] * y + m[9] * z + m[13];
          const tz = m[2] * x + m[6] * y + m[10] * z + m[14];
          const o = (vb + vi) * 3; pos[o] = tx; pos[o + 1] = ty; pos[o + 2] = tz;
          sx += tx; sy += ty; sz += tz;
          const a = Math.max(Math.abs(tx), Math.abs(ty), Math.abs(tz)); if (a > maxAbsCoord) maxAbsCoord = a;
          if (tx < minx) minx = tx; if (ty < miny) miny = ty; if (tz < minz) minz = tz;
          if (tx > maxx) maxx = tx; if (ty > maxy) maxy = ty; if (tz > maxz) maxz = tz;
        }
        for (let ii = 0; ii < idx.length; ii++) ind[ib + ii] = vb + idx[ii];
        for (let t = 0; t < idx.length; t += 3) {
          const a = (vb + idx[t]) * 3, b = (vb + idx[t + 1]) * 3, c = (vb + idx[t + 2]) * 3;
          volume += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
        }
        vb += n; ib += idx.length;
      }
      pad4(); const posOffset = offset; flush(new Uint8Array(pos.buffer));
      pad4(); const idxOffset = offset; flush(new Uint8Array(ind.buffer));
      metaRow[0] = mesh.expressID; metaRow[1] = posOffset; metaRow[2] = vTotal; metaRow[3] = idxOffset; metaRow[4] = iTotal;
      metaRow[5] = Math.abs(volume); metaRow[6] = iTotal / 3;
      metaRow[7] = minx; metaRow[8] = miny; metaRow[9] = minz; metaRow[10] = maxx; metaRow[11] = maxy; metaRow[12] = maxz;
      metaRow[13] = sx / vTotal; metaRow[14] = sy / vTotal; metaRow[15] = sz / vTotal;
      writeSync(metaFd, new Uint8Array(metaRow.buffer));
      views++;
    } catch { failures++; }
  });
} finally {
  closeSync(fd); closeSync(metaFd);
  try { api.CloseModel(modelID); } catch { /* wasm may be gone */ }
}
writeFileSync(join(outDir, 'geom.json'), JSON.stringify({ views, maxAbsCoord, failures, binBytes: offset, stride: META_STRIDE }));
console.log(`[geomWorker] ${views} meshed elements, ${failures} failures, ${Math.round(offset / 1048576)} MB geometry, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
process.exit(0);
