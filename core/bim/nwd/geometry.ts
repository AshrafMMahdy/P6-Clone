// Navisworks geometry, placed (LcOpNwdFragments). Clean-room. Each fragment is a piece of one tree item's geometry: its
// item is the item's position in the model tree in pre-order (the file itself is 0); its box (class 0x5d) is the piece's
// bounding box in its own frame, a translation and the number of its geometry block (a box another fragment points
// back to is the same geometry placed again); its transform (class 0x0e translation, 0x0f translation and quaternion,
// 0x10 those and a uniform scale, 0x11 matrix and translation) places it, else the box's translation does.
//
// Each piece's triangles come from its geometry block (mesh.ts); a block that cannot be read is drawn as its placed box.
import type { NwNode, NwTree } from './tree.ts';
import type { Mesh } from './mesh.ts';
import { tick } from '../heartbeat.mjs';

export interface Frag { item: number; prim: number; xform: { cls: number; t: number[]; q?: number[]; s?: number; m?: number[] } | null; box: { bbox: number[]; t: number[]; geom: number } | null }

export interface ElementShape { positions: number[]; triangles: number[]; boxes: number }
const BOX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

/** Each piece of each element's geometry: each(element, geometry block, its box in its own frame, its placement as a
 *  column-major 4x4 matrix), in fragment order. */
export function piecesOf(tree: NwTree, fragments: unknown[], elementNodes: NwNode[], each: (element: number, geom: number, bbox: number[], m: number[]) => void): void {
  // the element each item belongs to: the nearest element at or above it (items counted in pre-order, the file is 0)
  const element = new Map(elementNodes.map((n, i) => [n, i]));
  const owner: number[] = [];
  let i = 0;
  const walk = (n: NwNode, e: number) => { tick(); const own = element.get(n) ?? e; owner[++i] = own; for (const c of n.children) walk(c, own); };
  for (const r of tree.roots) walk(r, -1);
  for (const raw of fragments) {
    const f = raw as Frag;
    tick();
    if (!f?.box?.bbox) continue;
    const e = owner[f.item];
    if (e === undefined || e < 0) continue;
    each(e, f.box.geom, f.box.bbox, matrixOf(f));
  }
}

/** Each element's placed triangles (x, y, z in the file's units): its pieces' meshes (mesh(n) gives geometry block n,
 *  null for lines and points, undefined when it could not be read: then the piece is its placed box). */
export function elementShapes(tree: NwTree, fragments: unknown[], elementNodes: NwNode[], mesh: (n: number) => Mesh | null | undefined): Map<number, ElementShape> {
  const out = new Map<number, ElementShape>();
  piecesOf(tree, fragments, elementNodes, (e, geom, bbox, m) => {
    const g = mesh(geom);
    if (g === null) return; // lines, points
    const s = out.get(e) ?? out.set(e, { positions: [], triangles: [], boxes: 0 }).get(e)!;
    const base = s.positions.length / 3;
    const pos = g ? g.positions : boxCorners(bbox);
    for (let k = 0; k < pos.length; k += 3) { const x = pos[k], y = pos[k + 1], z = pos[k + 2]; s.positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]); }
    for (const t of g ? g.triangles : BOX) s.triangles.push(base + t);
    if (!g) s.boxes++;
  });
  return out;
}

/** A box's 8 corners (x, y, z each) and its 12 triangles (BOX) */
export const boxCorners = ([x0, y0, z0, x1, y1, z1]: number[]): number[] => [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
export { BOX };

/** A fragment's placement as a column-major 4x4 matrix: its transform (translation; a rotation by a quaternion, scaled
 *  uniformly first for 0x10; a 3x4 matrix), else its box's translation. */
export function matrixOf(f: Frag): number[] {
  const x = f.xform;
  const t = x ? x.t : f.box!.t;
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // columns
  if (x && (x.cls === 0x0f || x.cls === 0x10) && x.q) {
    const [qx, qy, qz, qw] = x.q, k = x.cls === 0x10 ? x.s ?? 1 : 1;
    // q p q* (as rotate() did for a point), a unit quaternion or not
    r = [qw * qw + qx * qx - qy * qy - qz * qz, 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy),
      2 * (qx * qy - qw * qz), qw * qw - qx * qx + qy * qy - qz * qz, 2 * (qy * qz + qw * qx),
      2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), qw * qw - qx * qx - qy * qy + qz * qz].map((v) => v * k);
  } else if (x && x.cls === 0x11 && x.m) { const m = x.m; r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]; }
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, t[0], t[1], t[2], 1];
}
