#!/usr/bin/env node
/**
 * Display tiles — runs in its OWN process (spawned by parse.ts after each geometry worker run, so web-ifc's memory is
 * gone by then). Turns one worker run (geomWorker.mjs: distinct meshes, placements) into GLB tiles of at most
 * <tileBytes> each, in element order, the FULL geometry (no stand-ins):
 *   - a mesh placed at least <instanceMin> times in a tile is stored once with its placements (EXT_mesh_gpu_instancing:
 *     TRANSLATION, ROTATION, SCALE), the element ordinal of each placement in node.extras.p6c.ordinals;
 *   - every other placed mesh is transformed and merged into the tile's batch (at most 2 million vertices a primitive),
 *     each element a range of vertices: node.extras.p6c.ranges = [ordinal, first vertex, vertex count, ...];
 *   - positions are relative to the tile's origin (node.translation, double precision in the JSON), so float32 keeps
 *     a georeferenced model's millimetres.
 * Nothing is held but the run's placement table and one tile. Writes <tilesDir>/tile-NNNNN.glb and <runDir>/tiles.json
 * ([{ file, bytes, elements, vertices, triangles, instances, bbox }]).
 * Usage: node geomTiles.mjs <runDir> <tilesDir> <firstTileNo> <tileBytes> [instanceMin]
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { alive, progress, startHeartbeat, step } from './heartbeat.mjs';

startHeartbeat(); // the parent's liveness watch (no fixed time limit): a tick per placed element and per tile written

const [runDir, tilesDir, firstArg, tileArg, instArg] = process.argv.slice(2);
if (!runDir || !tilesDir) { console.error('usage: geomTiles.mjs <runDir> <tilesDir> <firstTileNo> <tileBytes> [instanceMin]'); process.exit(2); }
const TILE = Math.max(1 << 16, Number(tileArg) || 32 * 1048576);
const INSTANCE_MIN = Math.max(2, Number(instArg) || 4);
const BATCH_VERTS = 2_000_000;
const MAX_GROUPS = 1024; // instanced meshes a tile draws (a draw call each): past it, merged
const PLACE = 18;
let tileNo = Number(firstArg) || 0;

const f64 = (file) => { const b = readFileSync(file); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const meta = f64(join(runDir, 'geoms.meta')); // posOffset, vCount, idxOffset, iCount per mesh
const places = existsSync(join(runDir, 'places.bin')) && statSync(join(runDir, 'places.bin')).size ? f64(join(runDir, 'places.bin')) : new Float64Array(0);
const nPlaces = places.length / PLACE;

// ── the distinct meshes, read through a window (they were written in first-use order: mostly sequential) ───────────
const geomFd = openSync(join(runDir, 'geoms.bin'), 'r');
let win = Buffer.alloc(0), winAt = -1;
function bytesAt(pos, len) {
  if (winAt < 0 || pos < winAt || pos + len > winAt + win.length) {
    win = Buffer.allocUnsafe(Math.max(16 << 20, len)); winAt = pos;
    let got = 0; for (let k; got < win.length; got += k) { k = readSync(geomFd, win, got, win.length - got, pos + got); if (k <= 0) break; }
    win = win.subarray(0, got);
  }
  return win.subarray(pos - winAt, pos - winAt + len);
}
const positionsOf = (mesh) => { const b = bytesAt(meta[mesh * 4], meta[mesh * 4 + 1] * 12); const c = new Float32Array(meta[mesh * 4 + 1] * 3); new Uint8Array(c.buffer).set(b); return c; };
const indicesOf = (mesh) => { const b = bytesAt(meta[mesh * 4 + 2], meta[mesh * 4 + 3] * 4); const c = new Uint32Array(meta[mesh * 4 + 3]); new Uint8Array(c.buffer).set(b); return c; };
const meshBytes = (mesh) => meta[mesh * 4 + 1] * 12 + meta[mesh * 4 + 3] * 4;

// ── a placement as translation, rotation, scale (null when it shears: then it is merged, not instanced) ──────────────
function trs(m) {
  const cx = [m[0], m[1], m[2]], cy = [m[4], m[5], m[6]], cz = [m[8], m[9], m[10]];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  let sx = len(cx); const sy = len(cy), sz = len(cz);
  if (!sx || !sy || !sz) return null;
  const det = cx[0] * (cy[1] * cz[2] - cy[2] * cz[1]) - cy[0] * (cx[1] * cz[2] - cx[2] * cz[1]) + cz[0] * (cx[1] * cy[2] - cx[2] * cy[1]);
  if (det < 0) sx = -sx; // a mirrored placement: a negative scale on x
  const r = [cx[0] / sx, cx[1] / sx, cx[2] / sx, cy[0] / sy, cy[1] / sy, cy[2] / sy, cz[0] / sz, cz[1] / sz, cz[2] / sz];
  // orthonormal? (a sheared or non-uniform rotated placement is not)
  const dot = (a, b) => r[a] * r[b] + r[a + 1] * r[b + 1] + r[a + 2] * r[b + 2];
  if (Math.abs(dot(0, 3)) > 1e-6 || Math.abs(dot(0, 6)) > 1e-6 || Math.abs(dot(3, 6)) > 1e-6) return null;
  if (Math.abs(m[3]) > 1e-9 || Math.abs(m[7]) > 1e-9 || Math.abs(m[11]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) return null;
  // rotation matrix (columns r[0..2], r[3..5], r[6..8]) to a quaternion
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = r[3], m11 = r[4], m21 = r[5], m02 = r[6], m12 = r[7], m22 = r[8];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s; }
  const qn = Math.hypot(qx, qy, qz, qw);
  return { t: [m[12], m[13], m[14]], q: [qx / qn, qy / qn, qz / qn, qw / qn], s: [sx, sy, sz] };
}

// ── how often each mesh is placed in this run ────────────────────────────────────────────────────────────────────
const uses = new Uint32Array(meta.length / 4);
for (let p = 0; p < nPlaces; p++) { uses[places[p * PLACE + 1]]++; if ((p & 0xfffff) === 0) alive(); }

// ── the tile being built ─────────────────────────────────────────────────────────────────────────────────────────
const out = [];
let tile = null;
function newTile(originFrom) {
  tile = { origin: [Math.round(originFrom[0]), Math.round(originFrom[1]), Math.round(originFrom[2])], batches: [], groups: new Map(), bytes: 0, elements: new Set(), vertices: 0, triangles: 0, instances: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
}
/** The batch a mesh of nv vertices goes into: the last one, or a new one when it would pass BATCH_VERTS. */
const batchFor = (nv) => { let b = tile.batches.at(-1); if (!b || (b.v && b.v + nv > BATCH_VERTS)) { b = { pos: [], idx: [], ranges: [], v: 0, i: 0 }; tile.batches.push(b); } return b; };
const grow = (x, y, z) => { const lo = tile.lo, hi = tile.hi; if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z; if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z; };

/** One element's placed meshes into the tile: instanced where the mesh repeats, else merged. */
function addElement(from, to) {
  const ordinal = places[from * PLACE];
  tile.elements.add(ordinal);
  let range = null;
  for (let p = from; p < to; p++) {
    const o = p * PLACE, mesh = places[o + 1], m = places.subarray(o + 2, o + 18);
    const nv = meta[mesh * 4 + 1], ni = meta[mesh * 4 + 3];
    tile.triangles += ni / 3;
    const pose = uses[mesh] >= INSTANCE_MIN && (tile.groups.has(mesh) || tile.groups.size < MAX_GROUPS) ? trs(m) : null;
    const pos = positionsOf(mesh);
    if (pose) {
      let g = tile.groups.get(mesh);
      if (!g) { g = { mesh, t: [], q: [], s: [], ord: [] }; tile.groups.set(mesh, g); tile.bytes += meshBytes(mesh); tile.vertices += nv; }
      g.t.push(pose.t[0] - tile.origin[0], pose.t[1] - tile.origin[1], pose.t[2] - tile.origin[2]); g.q.push(...pose.q); g.s.push(...pose.s); g.ord.push(ordinal);
      tile.bytes += 44; tile.instances++;
      for (let v = 0; v < nv; v++) { const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]; grow(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]); }
      continue;
    }
    // merged: transformed into the batch, relative to the tile origin
    const b = batchFor(nv);
    if (!range || range.b !== b) { range = { b, at: b.ranges.length }; b.ranges.push(ordinal, b.v, 0); } // a new batch: the element goes on in a range of its own
    const tp = new Float32Array(nv * 3);
    const [ox, oy, oz] = tile.origin;
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      grow(wx, wy, wz);
      tp[v * 3] = wx - ox; tp[v * 3 + 1] = wy - oy; tp[v * 3 + 2] = wz - oz;
    }
    const ind = indicesOf(mesh);
    if (b.v) for (let k = 0; k < ind.length; k++) ind[k] += b.v;
    b.pos.push(tp); b.idx.push(ind);
    b.ranges[range.at + 2] += nv;
    b.v += nv; b.i += ni;
    tile.vertices += nv;
    tile.bytes += nv * 12 + ni * 4;
  }
  tile.bytes += 12;
}

const pad4 = (n) => (4 - (n % 4)) % 4;
function writeTile() {
  if (!tile || (!tile.batches.length && !tile.groups.size)) return;
  const parts = []; let at = 0;
  const bufferViews = [], accessors = [], meshes = [], nodes = [];
  const view = (typed, target) => { const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength); parts.push(u8); const p = pad4(u8.length); if (p) parts.push(new Uint8Array(p)); bufferViews.push({ buffer: 0, byteOffset: at, byteLength: u8.length, ...(target ? { target } : {}) }); at += u8.length + p; return bufferViews.length - 1; };
  const bounds = (f, comps) => { const lo = new Array(comps).fill(Infinity), hi = new Array(comps).fill(-Infinity); for (let k = 0; k < f.length; k++) { const c = k % comps; if (f[k] < lo[c]) lo[c] = f[k]; if (f[k] > hi[c]) hi[c] = f[k]; } return { min: lo, max: hi }; };
  const concat = (list, n, T) => { const a = new T(n); let o = 0; for (const x of list) { a.set(x, o); o += x.length; } return a; };
  for (const b of tile.batches) {
    if (!b.v) continue;
    const pos = concat(b.pos, b.v * 3, Float32Array), idx = concat(b.idx, b.i, Uint32Array);
    const pv = view(pos, 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: b.v, type: 'VEC3', ...bounds(pos, 3) });
    const iv = view(idx, 34963);
    accessors.push({ bufferView: iv, componentType: 5125, count: b.i, type: 'SCALAR' });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] });
    const rv = view(new Uint32Array(b.ranges));
    nodes.push({ mesh: meshes.length - 1, translation: tile.origin, extras: { p6c: { kind: 'batch', ranges: rv, elements: b.ranges.length / 3 } } });
  }
  for (const g of tile.groups.values()) {
    const pos = positionsOf(g.mesh), idx = indicesOf(g.mesh);
    const pv = view(pos, 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', ...bounds(pos, 3) });
    const iv = view(idx, 34963);
    accessors.push({ bufferView: iv, componentType: 5125, count: idx.length, type: 'SCALAR' });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] });
    const n = g.ord.length;
    const tv = view(new Float32Array(g.t)); accessors.push({ bufferView: tv, componentType: 5126, count: n, type: 'VEC3' });
    const qv = view(new Float32Array(g.q)); accessors.push({ bufferView: qv, componentType: 5126, count: n, type: 'VEC4' });
    const sv = view(new Float32Array(g.s)); accessors.push({ bufferView: sv, componentType: 5126, count: n, type: 'VEC3' });
    const ov = view(new Uint32Array(g.ord));
    nodes.push({ mesh: meshes.length - 1, translation: tile.origin, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: accessors.length - 3, ROTATION: accessors.length - 2, SCALE: accessors.length - 1 } } }, extras: { p6c: { kind: 'instances', ordinals: ov, instances: n } } });
  }
  const bbox = [...tile.lo, ...tile.hi];
  const gltf = {
    asset: { version: '2.0', generator: 'P6 clone 4D tiles (web-ifc worker)' },
    ...(tile.groups.size ? { extensionsUsed: ['EXT_mesh_gpu_instancing'] } : {}),
    scene: 0, scenes: [{ nodes: nodes.map((_, k) => k) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: at }],
    extras: { p6c: { format: 1, elements: tile.elements.size, vertices: tile.vertices, triangles: tile.triangles, instances: tile.instances, bbox } },
  };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (pad4(json.length)) json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);
  const total = 12 + 8 + json.length + 8 + at;
  const head = Buffer.alloc(20); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8); head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(at, 0); binHead.writeUInt32LE(0x004e4942, 4);
  const file = `tile-${String(tileNo).padStart(5, '0')}.glb`;
  const fd = openSync(join(tilesDir, file), 'w');
  try { writeSync(fd, head); writeSync(fd, json); writeSync(fd, binHead); for (const p of parts) writeSync(fd, p); } finally { closeSync(fd); }
  out.push({ file, bytes: total, elements: tile.elements.size, vertices: tile.vertices, triangles: tile.triangles, instances: tile.instances, bbox });
  tileNo++;
  tile = null;
}

// ── element by element (an element's placements are consecutive: the worker wrote them so) ──────────────────────────
step('writing the display tiles (placed meshes)', { total: nPlaces });
for (let p = 0; p < nPlaces;) {
  progress(p);
  let q = p + 1; while (q < nPlaces && places[q * PLACE] === places[p * PLACE]) q++;
  let need = 12; for (let k = p; k < q; k++) need += meshBytes(places[k * PLACE + 1]);
  if (tile && tile.bytes && tile.bytes + need > TILE) { writeTile(); alive(); } // a tile written is a step of the loop
  if (!tile) newTile([places[p * PLACE + 14], places[p * PLACE + 15], places[p * PLACE + 16]]);
  addElement(p, q);
  p = q;
}
writeTile();
closeSync(geomFd);
writeFileSync(join(runDir, 'tiles.json'), JSON.stringify(out));
console.log(`[geomTiles] ${out.length} tiles, ${Math.round(out.reduce((n, t) => n + t.bytes, 0) / 1048576)} MB, ${out.reduce((n, t) => n + t.instances, 0)} instances, peak rss ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
process.exit(0);
