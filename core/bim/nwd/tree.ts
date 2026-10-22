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
export function decodeTree(buf: Uint8Array, o: { stream?: boolean; fragments?: boolean } = {}): NwTree & { values?: unknown[] } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0, nid = 0;
  const objs = new Map<number, unknown>();
  const fail = (msg: string): never => { throw new Error(`Navisworks model tree: ${msg} at byte ${p} of ${buf.length}`); };
  const u32 = () => { if (p + 4 > buf.length) fail('cut short'); const x = v.getUint32(p, true); p += 4; return x; };
  const i32 = () => { const x = v.getInt32(p, true); p += 4; return x; };
  const f64 = () => { p = (p + 7) & ~7; const x = v.getFloat64(p, true); p += 8; return x; };
  const str = (): string | null => { const n = u32(); if (n === 0xffffffff) return null; if (p + n > buf.length) fail('string past the end'); const s = td.decode(buf.subarray(p, p + n)); p += (n + 3) & ~3; return s; };
  const doubles = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(f64()); return out; };
  const floats = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) { out.push(v.getFloat32(p, true)); p += 4; } return out; };

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
      case 0x20: // a node led by a u32 (a file's partition in newer files), then as 0x35
      case 0x35: {
        if (cls === 0x20) u32();
        const name = str(), a = attr(), flags = u32(), guidIndex = u32();
        const values = Array.from({ length: u32() }, value);
        const children = Array.from({ length: u32() }, value).filter((c): c is NwNode => !!c && typeof c === 'object' && 'kind' in c && ((c as NwNode).kind === 'node' || (c as NwNode).kind === 'leaf'));
        // a file's node (0x20), after its children: a kind; 2 (a file read into it): its lights (each a value, class
        // 0x1b), the ambient colour, its loader plugin and version, its view (6 doubles), its source file's path and its
        // placement (7 doubles), two u32; else (the document itself) a u32
        if (cls === 0x20) {
          if (u32() >= 2) { const nl = u32(); for (let k = 0; k < nl; k++) value(); doubles(3); u32(); str(); u32(); u32(); u32(); doubles(6); u32(); str(); u32(); str(); doubles(7); u32(); u32(); }
          else u32();
        }
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
      // a hyperlink (Revit's URL parameter): two strings, two u32, its name and address, its attribute, a u32
      case 0x4f: { str(); str(); u32(); u32(); const name = str(), url = str(); const a = attr(); u32(); return { cls, name, url, attr: a } as Obj; }
      // a material asset in binary (navisworks:431; newer files hold JSON, class 0xb9): its id, its schema ("Generic",
      // "UnifiedBitmap"), then its properties: type, unit, name, a count, a u32, a flag and the asset connected to it (a
      // value: a texture), then the value (10 text, 2 / 6 a u32, 8 a number, 4 a colour of 4 numbers, 15 a choice: the one chosen
      // and the count's options, each an id and a label)
      case 0xb6: {
        const id = str(), schema = str();
        for (let n = u32(), k = 0; k < n; k++) {
          const t = u32(); u32(); str(); const count = u32(); u32(); if (u32()) value();
          if (t === 10 || t === 12) { str(); } // text, a file path
          else if (t === 2 || t === 6) u32();
          else if (t === 8) f64();
          else if (t === 4) doubles(4);
          else if (t === 11) { /* a map: its value is the asset connected to it */ }
          else if (t === 15) { u32(); for (let j = 0; j < count; j++) { u32(); str(); } }
          else fail(`material asset property of type ${t}`);
        }
        value(); // its schema (class 0xb7)
        // a 16-byte id, a u32, its thumbnail, its categories and its keywords (each a count and the strings), its name, its
        // swatch and its description
        if (p + 16 > buf.length) fail('cut short'); p += 16;
        u32(); str(); for (let list = 0; list < 2; list++) for (let n = u32(), k = 0; k < n; k++) str(); const label = str(); str(); str();
        return { cls, id, schema, label } as Obj;
      }
      case 0xb7: { const name = str(); str(); str(); value(); return { cls, name } as Obj; } // an asset schema: its name, kind, XML and the schema it extends
      // a DWG material: its name, two u32, its groups (a name, its properties: a key, a type (3 a number, 7 a colour, 10 a
      // file name and a u32) and the value; then its own groups), and a u32
      case 0x61: {
        const name = str(); u32(); u32();
        const group = (depth: number): void => {
          if (depth > 32) fail('material groups nested too deep');
          str();
          for (let n = u32(), k = 0; k < n; k++) { str(); const t = u32(); if (t === 3) f64(); else if (t === 7) doubles(3); else if (t === 10) { str(); u32(); } else fail(`material property of type ${t}`); }
          for (let n = u32(), k = 0; k < n; k++) group(depth + 1);
        };
        for (let n = u32(), k = 0; k < n; k++) group(0);
        u32();
        return { cls, name } as Obj;
      }
      // a geometric property (a DWG entity's "arbitrary plane"): two strings, two u32, its name, then its parts (a name, a
      // type: 8 a vector, 9 a point, each 3 doubles)
      case 0x62: {
        str(); str(); u32(); u32(); const name = str(), parts: Record<string, number[]> = {};
        for (let n = u32(), k = 0; k < n; k++) { const key = str() ?? '', t = u32(); if (t !== 8 && t !== 9) fail(`geometric property part of type ${t}`); parts[key] = doubles(3); }
        return { cls, name, parts } as Obj;
      }
      case 0x1f: { const name = str(); attr(); u32(); return { cls, name, d: doubles(14) } as Obj; }
      case 0xc8: { const name = str(); u32(); u32(); return { cls, name, asset: value() } as Obj; }
      case 0xb9: {
        // a material asset: its JSON, then its texture files (path, a flag, and when the flag is set the image itself,
        // embedded: a name, an extension, an aligned u64 length and the bytes)
        const json = str(); str(); const n = u32();
        for (let i = 0; i < n; i++) { str(); if (u32()) { str(); str(); p = (p + 7) & ~7; const len = Number(v.getBigUint64(p, true)); p += 8; if (p + len > buf.length) fail('an embedded texture past the end'); p = (p + len + 3) & ~3; } else u32(); } return { cls, json } as Obj; }
      case 0x42: { const name = str(), a = attr(); u32(); p = (p + 7) & ~7; const handle = v.getBigUint64(p, true); p += 8; return { cls, name, attr: a, handle } as Obj; }
      case 0x27: case 0x28: case 0x29: {
        str(); attr(); u32();
        const d = doubles(cls === 0x27 ? 12 : cls === 0x28 ? 3 : 7);
        if (cls === 0x27) u32();
        return { cls, d } as Obj;
      }
      // LcOpNwdFragments: a fragment (a piece of an item's geometry), its transform, material and placed box
      case 0x0d: {
        p = (p + 7) & ~7; const radius = f64(); u32(); const prim = u32(), flags = u32(), item = u32();
        return { cls, radius, prim, flags, item, xform: value(), material: value(), box: value() } as Obj;
      }
      case 0x5d: { const bbox = floats(6); p = (p + 7) & ~7; const t = doubles(3); floats(1); u32(); return { cls, bbox, t, geom: u32() } as Obj; }
      case 0x1b: { u32(); return { cls, light: doubles(13) } as Obj; } // a light: colour, direction...
      case 0x0e: return { cls, t: doubles(3) } as Obj;
      case 0x0f: { const d = doubles(7); return { cls, t: d.slice(0, 3), q: d.slice(3) } as Obj; }
      case 0x10: { const d = doubles(8); return { cls, t: d.slice(0, 3), q: d.slice(3, 7), s: d[7] } as Obj; } // and a uniform scale
      case 0x11: { const m = floats(13); p = (p + 7) & ~7; return { cls, m, t: doubles(3) } as Obj; }
      case 0x37: { const x = u32(); const colour = value(); const asset = x & 0x20 ? value() : null; if (asset && x & 0x40) u32(); return { cls, colour, asset } as Obj; }
      case 0x36: { const c = floats(13); u32(); return { cls, rgb: c.slice(3, 6) } as Obj; }
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

  if (o.fragments) { // LcOpNwdFragments: u32 count, then the fragments from id 100
    const n = u32(); nid = 100;
    return { roots: [], objects: 0, values: Array.from({ length: n }, value) };
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
  // the count is an upper bound: a DWG drawing's tree (navisworks:431) ends with its first root's subtree and a null
  for (let i = 0; i < count && p + 8 <= buf.length; i++) { const r = value(); if (r && typeof r === 'object' && 'kind' in r) roots.push(r as NwNode); }
  return { roots, objects: objs.size };
}
