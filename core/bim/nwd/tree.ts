// Navisworks model tree (section LcOpNwdLogicalHierarchy): a stream of objects. Clean-room, from the bytes only.
//
// Header: u32 1, u32, u32 base, u32 count, then `count` top-level values. A value is a u32 tag: 0 or -1 none; 1 then u32 id,
// an earlier object; else the next id (base+1, base+2, ...): a new object, u32 class, then its body. Strings: u32 length
// (-1 none), UTF-8, padded to 4. Doubles sit on 8-byte boundaries. Classes seen:
//   0x35 node      name, attribute, u32 flags, u32 guid index (1-based into LcOpGuidStore, 0 none), u32 n, n values
//                  (property groups, materials, transforms...), u32 m, m children
//   0x16 leaf      geometry item: name, attribute, u32, u32 index, u32 n, n values
//   0x34 attribute display name, internal name
//   0x56 group     name, attribute, u32, u32 n, n properties (attribute, u32 type, value)
//                  types: 1 double, 2 int, 3 bool, 4 text, 6 length, 8 object, 10 area, 11 volume (Revit: feet)
//   0x1f material appearance: name, attribute, u32, 14 doubles     0xc8 material: name, u32, u32, asset
//   0xb9 asset     JSON, text, u32 n, n (path, u32, u32)          0x42 DWG handle: name, attribute, u32, u64
//   0x27 / 0x28 / 0x29 transform: name, attribute, u32 flags, 12 doubles + u32 / 3 doubles / 7 doubles
export interface NwAttr { display: string | null; internal: string | null }
export type NwValue = string | number | boolean | NwAttr | null;
export interface NwProp { attr: NwAttr | null; type: number; value: NwValue }
export interface NwGroup { kind: 'group'; name: string | null; attr: NwAttr | null; props: NwProp[] }
export interface NwNode { kind: 'node' | 'leaf'; name: string | null; attr: NwAttr | null; flags: number; guidIndex: number; values: unknown[]; children: NwNode[] }
export interface NwTree { roots: NwNode[]; objects: number }

const td = new TextDecoder();
type Obj = { cls: number } & Record<string, unknown>;

/** stream: the bytes are a bare run of objects from id 100 (LcOaPartitionProps: element-id keys and their property
 *  groups), read until the first thing that is not a new object. */
export function decodeTree(buf: Uint8Array, o: { stream?: boolean } = {}): NwTree & { values?: unknown[] } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0, nid = 0;
  const objs = new Map<number, unknown>();
  const fail = (msg: string): never => { throw new Error(`Navisworks model tree: ${msg} at byte ${p} of ${buf.length}`); };
  const u32 = () => { if (p + 4 > buf.length) fail('cut short'); const x = v.getUint32(p, true); p += 4; return x; };
  const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
  const f64 = () => { p = (p + 7) & ~7; const x = v.getFloat64(p, true); p += 8; return x; };
  const str = (): string | null => { const n = u32(); if (n === 0xffffffff) return null; if (p + n > buf.length) fail('string past the end'); const s = td.decode(buf.subarray(p, p + n)); p += (n + 3) & ~3; return s; };
  const doubles = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(f64()); return out; };

  function value(): unknown {
    const t = u32();
    if (t === 0 || t === 0xffffffff) return null;
    if (t === 1) return objs.get(u32()) ?? null;
    if (t !== nid) fail(`unexpected tag ${t} (next object ${nid})`);
    nid++;
    const cls = u32(), id = t;
    const o = body(cls);
    objs.set(id, o);
    return o;
  }
  function attr(): NwAttr | null { const a = value() as NwAttr | null; return a && 'display' in a ? a : null; }
  function body(cls: number): unknown {
    switch (cls) {
      case 0x34: return { display: str(), internal: str() } satisfies NwAttr;
      case 0x35: {
        const name = str(), a = attr(), flags = u32(), guidIndex = u32();
        const values = Array.from({ length: u32() }, value);
        const children = Array.from({ length: u32() }, value).filter((c): c is NwNode => !!c && typeof c === 'object' && 'kind' in c && ((c as NwNode).kind === 'node' || (c as NwNode).kind === 'leaf'));
        return { kind: 'node', name, attr: a, flags, guidIndex, values, children } satisfies NwNode;
      }
      case 0x16: {
        const name = str(), a = attr(); u32(); const index = u32();
        const values = Array.from({ length: u32() }, value);
        return { kind: 'leaf', name, attr: a, flags: 0, guidIndex: 0, values, children: [], index } as NwNode;
      }
      case 0x56: {
        const name = str(), a = attr(); u32();
        const props = Array.from({ length: u32() }, () => prop());
        return { kind: 'group', name, attr: a, props } satisfies NwGroup;
      }
      case 0x1f: { const name = str(); attr(); u32(); return { cls, name, d: doubles(14) } as Obj; }
      case 0xc8: { const name = str(); u32(); u32(); return { cls, name, asset: value() } as Obj; }
      case 0xb9: { const json = str(); str(); const n = u32(); for (let i = 0; i < n; i++) { str(); u32(); u32(); } return { cls, json } as Obj; }
      case 0x42: { const name = str(), a = attr(); u32(); p = (p + 7) & ~7; const handle = v.getBigUint64(p, true); p += 8; return { cls, name, attr: a, handle } as Obj; }
      case 0x27: case 0x28: case 0x29: {
        str(); attr(); u32();
        const d = doubles(cls === 0x27 ? 12 : cls === 0x28 ? 3 : 7);
        if (cls === 0x27) u32();
        return { cls, d } as Obj;
      }
      default: return fail(`object class 0x${cls.toString(16)} this reader does not know`);
    }
  }
  function prop(): NwProp {
    const a = attr(), type = u32();
    let val: NwValue;
    switch (type) {
      case 1: case 6: case 10: case 11: val = f64(); break;
      case 2: val = i32(); break;
      case 3: val = i32() !== 0; break;
      case 4: val = str(); break;
      case 8: { const o = value() as NwAttr | null; val = o && 'display' in o ? o : null; break; }
      default: return fail(`property type ${type} this reader does not know`);
    }
    return { attr: a, type, value: val };
  }

  if (o.stream) {
    nid = 100;
    const values: unknown[] = [];
    while (p + 8 <= buf.length && v.getUint32(p, true) === nid) values.push(value());
    return { roots: [], objects: objs.size, values };
  }
  u32(); u32();
  const base = u32(), count = u32();
  nid = base + 1;
  const roots: NwNode[] = [];
  for (let i = 0; i < count; i++) { const r = value(); if (r && typeof r === 'object' && 'kind' in r) roots.push(r as NwNode); }
  return { roots, objects: objs.size };
}
