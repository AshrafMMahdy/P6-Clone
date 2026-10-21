// Navisworks geometry, placed (LcOpNwdFragments). Clean-room. Each fragment is a piece of one tree item's geometry: its
// item is the item's position in the model tree in pre-order (the file itself is 0); its box (class 0x5d) is the piece's
// bounding box in its own frame, a translation and the number of its geometry block (a box another fragment points
// back to is the same geometry placed again); its transform (class 0x0e translation, 0x0f translation and quaternion,
// 0x11 matrix and translation) places it, else the box's translation does.
//
// The triangles inside each geometry block (LcOpNwdGeometry) are not decoded yet: each piece is drawn as its placed box.
import type { NwNode, NwTree } from './tree.ts';

interface Frag { item: number; prim: number; xform: { cls: number; t: number[]; q?: number[]; m?: number[] } | null; box: { bbox: number[]; t: number[]; geom: number } | null }

/** Pre-order positions (the file is 0) of every node and leaf. */
export function preorder(tree: NwTree): Map<NwNode, number> {
  const out = new Map<NwNode, number>();
  let i = 0;
  const walk = (n: NwNode) => { out.set(n, ++i); for (const c of n.children) walk(c); };
  for (const r of tree.roots) walk(r);
  return out;
}

/** Placed boxes per element: the corners (x, y, z in the file's units) of every piece of geometry its items have. */
export function elementBoxes(tree: NwTree, fragments: unknown[], elementNodes: NwNode[]): Map<number, number[][]> {
  // the element each item belongs to: the nearest element at or above it
  const element = new Map(elementNodes.map((n, i) => [n, i]));
  const owner: number[] = [];
  let i = 0;
  const walk = (n: NwNode, e: number) => { const own = element.get(n) ?? e; owner[++i] = own; for (const c of n.children) walk(c, own); };
  for (const r of tree.roots) walk(r, -1);
  const out = new Map<number, number[][]>();
  for (const raw of fragments) {
    const f = raw as Frag;
    if (!f?.box?.bbox) continue;
    const e = owner[f.item];
    if (e === undefined || e < 0) continue;
    const [x0, y0, z0, x1, y1, z1] = f.box.bbox;
    const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const place = placer(f);
    (out.get(e) ?? out.set(e, []).get(e)!).push(...corners.map(place));
  }
  return out;
}

function placer(f: Frag): (p: number[]) => number[] {
  const x = f.xform;
  if (!x) { const t = f.box!.t; return (p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; }
  const t = x.t;
  if (x.cls === 0x0f && x.q) { const [qx, qy, qz, qw] = x.q; return (p) => add(rotate(p, qx, qy, qz, qw), t); }
  if (x.cls === 0x11 && x.m) { const m = x.m; return (p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + t[0], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + t[1], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + t[2]]; }
  return (p) => add(p, t);
}
const add = (p: number[], t: number[]) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
/** p rotated by the unit quaternion (x, y, z, w) */
function rotate(p: number[], x: number, y: number, z: number, w: number): number[] {
  const ix = w * p[0] + y * p[2] - z * p[1], iy = w * p[1] + z * p[0] - x * p[2], iz = w * p[2] + x * p[1] - y * p[0], iw = -x * p[0] - y * p[1] - z * p[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
