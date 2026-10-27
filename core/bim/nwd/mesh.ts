// Navisworks meshes (section LcOpNwdGeometry). Clean-room, from the bytes; checked against Revit's own volumes (the
// four walls of the hello sample to 0.01 ft3).
//
// The section is a run of geometry blocks, then a table: u32 count, u32 pages, a u32 per page, a u32 length per block.
// A block is an object stream from id 100: root class 0x5e (faces; 0x5f lines and 0x60 points are not meshes), then
// attributes: 0x3c positions and 0x3d texture coordinates (u32 corners, u32 floats, the floats, then an index code
// unless there is one value per corner), 0x64 normals (i32 -corners, u32 count, 6 bytes each, or 3 in older files,
// then an index code unless one per corner); then the triangle strips: u32 count, u32 bits, u32 count, the lengths
// packed most significant bit first in u32 words, and u32 n with an index code taking strip corners to corners
// (0: strip corners are the corners in order).
//
// Index code, per corner: 0x00-0x3f: n+1 new values (the next ones in the array); 0x40-0x7f: the value n corners back;
// 0x80-0xbf: the previous value n+1 more times; 0xc0-0xdf: a predefined value (normals: the axes); 0xe0-0xef and a
// byte: the value (n & 15) << 8 | byte corners back; 0xf0 and a u16: the value at that index. Padded to 4 bytes.

export interface Mesh { positions: Float32Array; triangles: Uint32Array }

/** The byte ranges of the geometry blocks (null when the table is not found). */
export function geometryBlocks(b: Uint8Array): { offset: number; length: number }[] | null {
  const t = blockTable(b);
  return t && Array.from(t.lengths, (length, k) => ({ offset: t.offsets[k], length }));
}

/** The geometry blocks' offsets and lengths from the section's end: b is its last bytes, starting at byte `from` of the
 *  section (the whole section: 0). Null when the table is not in b. */
export function blockTable(b: Uint8Array, from = 0): { offsets: Float64Array; lengths: Uint32Array } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = (b.length - 12) & ~3; at >= 0; at -= 4) {
    const c = v.getUint32(at, true), pages = v.getUint32(at + 4, true);
    if (c === 0 || c > 50_000_000 || pages > 1_000_000 || at + 8 + 4 * (pages + c) > b.length) continue;
    let sum = 0;
    const base = at + 8 + 4 * pages;
    for (let k = 0; k < c && sum <= from + at; k++) sum += v.getUint32(base + 4 * k, true);
    if (sum !== from + at || !sum) continue;
    const offsets = new Float64Array(c), lengths = new Uint32Array(c);
    for (let k = 0, o = 0; k < c; k++) { const n = v.getUint32(base + 4 * k, true); offsets[k] = o; lengths[k] = n; o += n; }
    return { offsets, lengths };
  }
  return null;
}

/** One geometry block as a mesh in its own frame, or null when it holds lines or points. Throws on what it cannot read. */
export function decodeBlock(b: Uint8Array, offset: number, length: number): Mesh | null {
  // older files (navisworks:431, a DWG drawing) count a long reference one further back ("e0 00" is the value one back)
  try { return decodeWith(b, offset, length, 0); } catch (e) { try { return decodeWith(b, offset, length, 1); } catch { throw e; } }
}

function decodeWith(b: Uint8Array, offset: number, length: number, longBack: number): Mesh | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = offset + length;
  let p = offset;
  const fail = (m: string): never => { throw new Error(`Navisworks geometry: ${m} at byte ${p - offset} of a block of ${length}`); };
  const u32 = () => { if (p + 4 > end) fail('cut short'); const x = v.getUint32(p, true); p += 4; return x; };
  const code = (corners: number): Int32Array => {
    const out = new Int32Array(corners);
    let n = 0, fresh = 0;
    const back = (d: number) => { if (d <= 0 || d > n) fail(`a reference ${d} back from corner ${n}`); out[n] = out[n - d]; n++; };
    while (n < corners) {
      if (p >= end) fail('index code cut short');
      const op = b[p++];
      if (op < 0x40) { for (let k = 0; k <= op && n < corners; k++) out[n++] = fresh++; }
      else if (op < 0x80) back(op - 0x40);
      else if (op < 0xc0) { if (!n) fail('a repeat with nothing before'); for (let k = 0; k <= op - 0x80 && n < corners; k++) { out[n] = out[n - 1]; n++; } }
      else if (op < 0xe0) out[n++] = -1; // a predefined value (an axis normal)
      else if (op < 0xf0) { const d = (((op & 15) << 8) | b[p++]) + longBack; back(d); }
      else if (op === 0xf0) { out[n++] = v.getUint16(p, true); p += 2; }
      else fail(`index op 0x${op.toString(16)}`);
    }
    p = (p + 3) & ~3;
    return out;
  };
  if (u32() !== 100) fail('no block');
  const root = u32();
  if (root !== 0x5e) return null; // lines (0x5f) and points (0x60)
  let nid = 101, positions: Float32Array | null = null, pIdx: Int32Array | null = null;
  for (;;) {
    const t = v.getUint32(p, true);
    if (t === 0) { p += 4; continue; }
    if (t !== nid) break;
    p += 4; const cls = u32(); nid++;
    if (cls === 0x3c || cls === 0x3d) {
      const corners = u32(), nf = u32();
      if (p + 4 * nf > end) fail('values past the block');
      const vals = new Float32Array(nf);
      for (let k = 0; k < nf; k++) vals[k] = v.getFloat32(p + 4 * k, true);
      p += 4 * nf;
      const idx = nf === (cls === 0x3c ? 3 : 2) * corners ? Int32Array.from({ length: corners }, (_, k) => k) : code(corners);
      if (cls === 0x3c) { positions = vals; pIdx = idx; }
    } else if (cls === 0x64) {
      const corners = -v.getInt32(p, true); p += 4;
      const nn = u32(), at = p;
      let read = false;
      for (const size of [6, 3]) { // normals: 3 x int16, or 3 x int8 in older files: the one whose code reads up to the strips
        p = (at + size * nn + 3) & ~3;
        try {
          if (nn !== corners) code(corners);
          let q = p; while (v.getUint32(q, true) === 0) q += 4;
          const n1 = v.getUint32(q, true), bits = v.getUint32(q + 4, true), n2 = v.getUint32(q + 8, true);
          if ((n1 === n2 && bits > 0 && bits <= 32) || n1 === nid) { read = true; break; } // the strips, or another attribute
        } catch { /* the other size */ }
      }
      if (!read) fail('normals');
    } else if (cls === 0x3a) {
      // colours per corner (older files): a u32, -corners, a count, 4 bytes each, then an index code unless one per corner
      u32(); const corners = -v.getInt32(p, true); p += 4;
      const nc = u32(); if (p + 4 * nc > end) fail('colours past the block'); p += 4 * nc;
      if (nc !== corners) code(corners);
    } else fail(`attribute class 0x${cls.toString(16)}`);
  }
  if (!positions || !pIdx) return fail('no positions');
  const pos = positions, pi = pIdx;
  // the strips
  const nStrips = u32(), bits = u32(); u32();
  const words = Math.ceil((nStrips * bits) / 32), at = p;
  p += 4 * words;
  const sizes = new Uint32Array(nStrips);
  for (let k = 0; k < nStrips; k++) {
    let x = 0;
    for (let j = 0; j < bits; j++) { const bit = k * bits + j, w = v.getUint32(at + 4 * (bit >>> 5), true); x = x * 2 + ((w >>> (31 - (bit & 31))) & 1); }
    sizes[k] = x;
  }
  const sc = u32();
  const corners = sc ? code(sc) : null;
  const tris: number[] = [];
  let c = 0;
  const corner = (k: number) => { const i = corners ? corners[k] : k; if (i < 0 || i >= pi.length) fail('a strip corner out of range'); return pi[i]; };
  for (const n of sizes) {
    for (let k = 0; k + 2 < n; k++) {
      const a = corner(c + k), b2 = corner(c + k + 1), d = corner(c + k + 2);
      if (a === b2 || b2 === d || a === d) continue;
      if (k % 2 === 0) tris.push(a, b2, d); else tris.push(b2, a, d);
    }
    c += n;
  }
  const nv = pos.length / 3;
  for (const t of tris) if (t < 0 || t >= nv) fail('a triangle past the vertices');
  return { positions: pos, triangles: Uint32Array.from(tris) };
}
