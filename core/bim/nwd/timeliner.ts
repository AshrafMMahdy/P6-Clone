// Navisworks TimeLiner and selection sets (sections LcTlTimelinerElement, LcOpSelectionSetsElement, LcOpNwfPathMap).
// Clean-room, from the bytes of a real 2016 TimeLiner (the villa .nwf, checked against its own Excel grid) and a
// client-made one (gatehouse.nwd).
//
// Strings are a u32 length (0xffffffff: none) and UTF-8, padded to 4; 64-bit values are aligned to 8 in the section.
//
// A task: u32 0x3d, the name, six strings, a u32, two strings, then the actual start and end (int64 Unix seconds of
// the wall clock), three u32 flags, the planned start and end, three flags, the task type ("Construct"), a string, the
// explicit selections (u32 count; each a u32, a u32 count and that many item references) and the attached sets
// (u32 count, then "lcop_selection_set_tree/<set name>" each), more fields, and last the number of its child tasks,
// which follow it (a list of tasks starts with its count: the top level's, then each parent's). Tasks are found by
// their shape, so child tasks are too; a task's child count is the u32 just before the next task found. An imported
// schedule hangs under a root task ("New Data Source (Root)"), a summary of the others.
//
// A selection set: u32 kind (5; 4 is a folder), the name, a u32, a 16-byte GUID, a u32, then u32 0 and an explicit
// selection (u32 count, the item references, 0xffffffff, an aligned u64), or another value and a search (conditions,
// not read here).
//
// Item references: in an .nwd / .nwc, an item's position in the model tree in pre-order (the file itself is 0); in an
// .nwf, the 1-based position of a component in LcOpNwfPathMap, which names the item by its path in the model it links.
// The path map: u32 count, u32, then components, each: i32 its depth (1: under the model's root), negative for one
// that is selected (a bounding box, 6 aligned doubles, ends it); u32 kind (bit 0x200: a 16-byte GUID follows the
// name, the IFC GlobalId's bytes as Windows writes them; bit 0x08: then an aligned u64, the Revit ElementId or an
// item id); u32 its 0-based position among its parent's children; u32 class; the attribute's display name; its name.
// A component's parent is the last one a level up. Seen: 0x5f and 0x57 (a 2016 .nwf: levels and categories), 0x25f
// (a 2021 .nwf: every level down to the elements).

export interface NwTask { name: string; actualStart: string | null; actualFinish: string | null; plannedStart: string | null; plannedFinish: string | null; type: string; items: number[]; sets: string[]; /** child tasks (a summary when above 0) */ children: number }
/** items null: a search set (its conditions are not read) */
export interface NwSet { name: string; items: number[] | null }
/** parent: the component above it in the path map (0-based), -1 for one under the model's root; guid: the item's
 *  GUID bytes (Windows order) when the map holds it */
export interface NwPathComponent { name: string | null; attr: string | null; position: number; parent: number; guid?: Uint8Array }

const SET_PATH = 'lcop_selection_set_tree/';
const td = new TextDecoder('utf-8', { fatal: true });

function reader(b: Uint8Array, at: number) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const r = {
    p: at,
    u32() { if (r.p + 4 > b.length) throw new Error('cut short'); const x = v.getUint32(r.p, true); r.p += 4; return x; },
    i32() { const x = r.u32(); return x | 0; },
    align() { r.p = (r.p + 7) & ~7; },
    i64() { r.align(); if (r.p + 8 > b.length) throw new Error('cut short'); const x = Number(v.getBigInt64(r.p, true)); r.p += 8; return x; },
    str(max = 4000): string | null {
      const n = r.u32();
      if (n === 0xffffffff) return null;
      if (n > max || r.p + n > b.length) throw new Error('not a string');
      const s = td.decode(b.subarray(r.p, r.p + n));
      r.p += (n + 3) & ~3;
      return s;
    },
    peek() { return r.p + 4 <= b.length ? v.getInt32(r.p, true) : 0; },
  };
  return r;
}

/** int64 Unix seconds of the wall clock as "YYYY-MM-DD HH:mm"; none outside 1971-2200 (an unset date) */
const when = (s: number) => (s > 31536000 && s < 7258118400 ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : null);
const printable = (s: string | null): s is string => !!s && !/[\u0000-\u001f]/.test(s);

function task(b: Uint8Array, at: number): { task: NwTask; end: number } | null {
  const r = reader(b, at);
  try {
    if (r.u32() !== 0x3d) return null;
    const name = r.str();
    if (name === null || /[\u0000-\u0008]/.test(name)) return null;
    for (let k = 0; k < 6; k++) r.str();
    r.u32(); r.str(); r.str();
    const a0 = r.i64(), a1 = r.i64(); r.u32(); r.u32(); r.u32();
    const p0 = r.i64(), p1 = r.i64(); r.u32(); r.u32(); r.u32();
    const type = r.str(200);
    if (!printable(type)) return null;
    r.str();
    const items: number[] = [], sets: string[] = [];
    const nx = r.u32();
    if (nx > 1000) return null;
    for (let k = 0; k < nx; k++) { r.u32(); const n = r.u32(); if (n > 1e7) return null; for (let j = 0; j < n; j++) items.push(r.u32()); }
    const ns = r.u32();
    if (ns > 1000) return null;
    for (let k = 0; k < ns; k++) { const s = r.str(); if (s === null) return null; sets.push(s.startsWith(SET_PATH) ? s.slice(SET_PATH.length) : s); }
    return { task: { name, actualStart: when(a0), actualFinish: when(a1), plannedStart: when(p0), plannedFinish: when(p1), type, items, sets, children: 0 }, end: r.p };
  } catch { return null; }
}

/** The TimeLiner tasks, in file order. */
export function decodeTimeliner(b: Uint8Array): NwTask[] {
  const out: NwTask[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 0; p + 8 <= b.length;) {
    const t = b[p] === 0x3d && b[p + 1] === 0 && b[p + 2] === 0 && b[p + 3] === 0 ? task(b, p) : null;
    if (t) {
      // the u32 before a task: the previous task's child count (0 for one without), or the count of a list's first
      const before = p >= 4 ? v.getUint32(p - 4, true) : 0;
      if (out.length && before > 0 && before < 1e6) out[out.length - 1].children = before;
      out.push(t.task); p = (t.end + 3) & ~3;
    } else p += 4;
  }
  return out;
}

/** The selection sets (explicit ones with their item references; search sets by name). Folders are not kept. */
export function decodeSets(b: Uint8Array): NwSet[] {
  const out: NwSet[] = [];
  for (let p = 0; p + 8 <= b.length;) {
    const r = reader(b, p);
    try {
      if (r.u32() !== 5) throw 0;
      const name = r.str(1000);
      if (!printable(name) || r.u32() !== 0) throw 0;
      r.p += 16; // the GUID
      if (r.u32() !== 0) throw 0;
      if (r.u32() !== 0) { out.push({ name, items: null }); p = r.p; continue; }
      const n = r.u32();
      if (n > 1e7) throw 0;
      const items: number[] = [];
      for (let k = 0; k < n; k++) items.push(r.u32());
      if (r.u32() !== 0xffffffff) throw 0;
      r.i64();
      out.push({ name, items });
      p = r.p;
    } catch { p += 4; }
  }
  return out;
}

/** The components of an .nwf's path map, in file order (item reference k is component k - 1). */
export function decodePathMap(b: Uint8Array): NwPathComponent[] {
  const r = reader(b, 8), out: NwPathComponent[] = [], last: number[] = [];
  try {
    while (r.p + 8 < b.length) {
      const lead = r.i32(), depth = Math.abs(lead);
      if (!depth || depth > 64 || depth > last.length + 1) break;
      const kind = r.u32(), position = r.u32();
      r.u32();
      const attr = r.str(), name = r.str();
      let guid: Uint8Array | undefined;
      if (kind & 0x200) { if (r.p + 16 > b.length) break; guid = b.slice(r.p, r.p + 16); r.p += 16; }
      if (kind & 0x08) r.i64();
      out.push({ name, attr, position, parent: depth > 1 ? last[depth - 2] : -1, ...(guid ? { guid } : {}) });
      last[depth - 1] = out.length - 1; last.length = depth;
      if (lead < 0) { r.align(); r.p += 48; }
    }
  } catch { /* what was read stands */ }
  return out;
}
