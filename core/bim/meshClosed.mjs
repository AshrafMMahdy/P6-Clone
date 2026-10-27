// Whether a mesh encloses a volume (shared by the geometry worker and the Navisworks reader: one rule for both).
/** A mesh is closed when the holes in it are next to nothing: its corners joined by position (to a millionth of the
 *  mesh's size), the edges bordering an odd number of triangles make the holes' rims, and the rims, loop by loop,
 *  span at most a thousandth of the mesh's surface (a seam tessellated a little differently on either side spans
 *  none; a pipe without its ends, a wall without a face, a surface span much more).
 *  @param {ArrayLike<number>} pos positions, x y z each  @param {ArrayLike<number>} ind triangles, 3 corners each  @returns {boolean} */
export function closed(pos, ind) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < pos.length; k++) { if (pos[k] < lo) lo = pos[k]; if (pos[k] > hi) hi = pos[k]; }
  const q = Math.max((hi - lo) * 1e-6, 1e-9), at = new Map(), id = new Uint32Array(pos.length / 3), first = [];
  for (let v = 0; v < id.length; v++) { const k = `${Math.round(pos[v * 3] / q)},${Math.round(pos[v * 3 + 1] / q)},${Math.round(pos[v * 3 + 2] / q)}`; let i = at.get(k); if (i === undefined) { at.set(k, (i = at.size)); first.push(v); } id[v] = i; }
  const n = at.size, odd = new Map();
  const edge = (a, b) => { const k = a < b ? a * n + b : b * n + a; if (odd.has(k)) odd.delete(k); else odd.set(k, [a, b]); };
  let surface = 0;
  for (let t = 0; t + 2 < ind.length; t += 3) {
    const a = id[ind[t]], b = id[ind[t + 1]], c = id[ind[t + 2]];
    edge(a, b); edge(b, c); edge(c, a);
    const [x0, y0, z0, x1, y1, z1, x2, y2, z2] = [ind[t], ind[t + 1], ind[t + 2]].flatMap((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    surface += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  if (!odd.size) return true;
  // the rims as loops (corners joined), each loop's spanned area: half the length of the sum of its edges' a x b
  const up = Array.from({ length: n }, (_, i) => i), root = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  for (const [a, b] of odd.values()) up[root(a)] = root(b);
  const span = new Map();
  for (const [a, b] of odd.values()) {
    const p = first[a] * 3, r = first[b] * 3, s3 = span.get(root(a)) ?? span.set(root(a), [0, 0, 0]).get(root(a));
    s3[0] += pos[p + 1] * pos[r + 2] - pos[p + 2] * pos[r + 1]; s3[1] += pos[p + 2] * pos[r] - pos[p] * pos[r + 2]; s3[2] += pos[p] * pos[r + 1] - pos[p + 1] * pos[r];
  }
  let holes = 0;
  for (const s3 of span.values()) holes += Math.hypot(...s3) / 2;
  return holes <= surface * 1e-3;
}
