// Navisworks geometry, placed (LcOpNwdFragments). Clean-room. Each fragment is a piece of one tree item's geometry: its
// item is the item's position in the model tree in pre-order (the file itself is 0); its box (class 0x5d) is the piece's
// bounding box in its own frame, a translation and the number of its geometry block (a box another fragment points
// back to is the same geometry placed again); its transform (class 0x0e translation, 0x0f translation and quaternion,
// 0x10 those and a uniform scale, 0x11 matrix and translation) places it, else the box's translation does.
//
// Each piece's triangles come from its geometry block (mesh.ts); a block that cannot be read is drawn as its placed box.
import type { NwNode, NwTree } from './tree.ts';
import type { Mesh } from './mesh.ts';

interface Frag { item: number; prim: number; xform: { cls: number; t: number[]; q?: number[]; s?: number; m?: number[] } | null; box: { bbox: number[]; t: number[]; geom: number } | null }

export interface ElementShape { positions: number[]; triangles: number[]; boxes: number }
const BOX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

/** Each element's placed triangles (x, y, z in the file's units): its pieces' meshes (mesh(n) gives geometry block n,
 *  null for lines and points, undefined when it could not be read: then the piece is its placed box). */
export function elementShapes(tree: NwTree, fragments: unknown[], elementNodes: NwNode[], mesh: (n: number) => Mesh | null | undefined): Map<number, ElementShape> {
  // the element each item belongs to: the nearest element at or above it (items counted in pre-order, the file is 0)
  const element = new Map(elementNodes.map((n, i) => [n, i]));
  const owner: number[] = [];
  let i = 0;
  const walk = (n: NwNode, e: number) => { const own = element.get(n) ?? e; owner[++i] = own; for (const c of n.children) walk(c, own); };
  for (const r of tree.roots) walk(r, -1);
  const out = new Map<number, ElementShape>();
  for (const raw of fragments) {
    const f = raw as Frag;
    if (!f?.box?.bbox) continue;
    const e = owner[f.item];
    if (e === undefined || e < 0) continue;
    const m = mesh(f.box.geom);
    if (m === null) continue; // lines, points
    const s = out.get(e) ?? out.set(e, { positions: [], triangles: [], boxes: 0 }).get(e)!;
    const place = placer(f), base = s.positions.length / 3;
    if (m) {
      for (let k = 0; k < m.positions.length; k += 3) s.positions.push(...place([m.positions[k], m.positions[k + 1], m.positions[k + 2]]));
      for (const t of m.triangles) s.triangles.push(base + t);
    } else {
      const [x0, y0, z0, x1, y1, z1] = f.box.bbox;
      for (const c of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) s.positions.push(...place(c));
      for (const t of BOX) s.triangles.push(base + t);
      s.boxes++;
    }
  }
  return out;
}

function placer(f: Frag): (p: number[]) => number[] {
  const x = f.xform;
  if (!x) { const t = f.box!.t; return (p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; }
  const t = x.t;
  if (x.cls === 0x0f && x.q) { const [qx, qy, qz, qw] = x.q; return (p) => add(rotate(p, qx, qy, qz, qw), t); }
  if (x.cls === 0x10 && x.q) { const [qx, qy, qz, qw] = x.q, k = x.s ?? 1; return (p) => add(rotate([p[0] * k, p[1] * k, p[2] * k], qx, qy, qz, qw), t); }
  if (x.cls === 0x11 && x.m) { const m = x.m; return (p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + t[0], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + t[1], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + t[2]]; }
  return (p) => add(p, t);
}
const add = (p: number[], t: number[]) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
/** p rotated by the unit quaternion (x, y, z, w) */
function rotate(p: number[], x: number, y: number, z: number, w: number): number[] {
  const ix = w * p[0] + y * p[2] - z * p[1], iy = w * p[1] + z * p[0] - x * p[2], iz = w * p[2] + x * p[1] - y * p[0], iw = -x * p[0] - y * p[1] - z * p[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
