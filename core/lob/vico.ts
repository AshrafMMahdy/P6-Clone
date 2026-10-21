// Reader for Trimble Vico Schedule Planner / Vico Control project files (.dpp, "DSS\x1a" + "GraphisoftControl
// Project"). Read-only and reverse-engineered from five sample files written by Schedule Planner v6.8; the format
// notes (record classes, property ids, what is known and what is not) are in docs/lob-vico-format.md. Anything the
// reader cannot pin down goes to `notes` instead of being guessed.
import { inflateSync } from 'node:zlib';

export interface VicoProject {
  name: string;
  start: string | null;
  end: string | null;
  levels: string[];
  locations: { code: string; name: string; level: number; parent: string | null }[];
  tasks: {
    code: string;
    name: string;
    start: string | null;
    end: string | null;
    durationDays: number | null;
    crew: { name: string; size: number } | null;
    items: {
      name: string;
      unit: string;
      /** Effective consumption (h/unit) the task runs at: the item's base consumption divided by the per-location
       *  productivity factor, quantity-weighted. This is the "Consumption" Schedule Planner shows for the task. */
      consumption: number;
      quantities: { location: string; quantity: number }[];
      /** The consumption stored on the quantity item itself (before the per-location factor). */
      baseConsumption?: number;
      /** Unit price of the quantity item (cost = quantity x unit price). */
      unitPrice?: number;
    }[];
    locations: string[];
  }[];
  links: { pred: string; succ: string; type: string; lagDays: number; locationLag?: number; bufferDays?: number }[];
  calendars?: unknown;
  /** Project information fields (Company's name, Creator's name, ...) that are set. */
  info?: Record<string, string>;
  notes: string[];
}

// ---- container --------------------------------------------------------------------------------------------------

const MAGIC = [0x44, 0x53, 0x53, 0x1a]; // "DSS\x1a"
const SIGNATURE = 'GraphisoftControl Project';

/** The zlib-compressed body of a .dpp file; throws on anything that is not one. */
function inflateBody(bytes: Uint8Array): Buffer {
  if (bytes.length < 40 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Not a Vico .dpp file: missing the "DSS" header');
  const sig = Buffer.from(bytes.subarray(8, 8 + SIGNATURE.length)).toString('latin1');
  if (sig !== SIGNATURE) throw new Error(`Not a Vico .dpp file: expected "${SIGNATURE}" at offset 8`);
  // In every sample the zlib stream starts at offset 39 (after "...Project\x1a\x00" and a u32); look for the zlib
  // header from there rather than hard-coding it.
  for (let off = 8 + SIGNATURE.length; off < Math.min(bytes.length - 2, 80); off++) {
    const cmf = bytes[off], flg = bytes[off + 1];
    if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) continue;
    try { return inflateSync(bytes.subarray(off)); } catch { /* not the stream; keep looking */ }
  }
  throw new Error('Vico .dpp file: could not find or inflate the zlib-compressed body');
}

// ---- object store -------------------------------------------------------------------------------------------------

type Val =
  | { t: 'empty'; type: number }
  | { t: 'int'; v: number }
  | { t: 'time'; v: number }          // seconds; dates are wall-clock time encoded as if UTC
  | { t: 'f64'; v: number }
  | { t: 'str'; v: string }
  | { t: 'blob'; v: Uint8Array }
  | { t: 'u32'; v: number }           // object reference or enum
  | { t: 'arr'; size: number; items: Uint8Array[] }
  | { t: 'map'; ks: number; vs: number; entries: [Uint8Array, Uint8Array][] };

interface Rec { id: number; cls: number; props: Map<number, Val[]> }

function parseRecords(b: Buffer): Rec[] {
  const recs: Rec[] = [];
  let pos = 0;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32LE(pos), id = b.readUInt32LE(pos + 4), cls = b.readUInt32LE(pos + 8);
    if (len < 12 || pos + len > b.length) throw new Error(`Vico .dpp file: corrupt record at body offset ${pos}`);
    if (id === 0xffffffff && cls === 0xffffffff) break; // end-of-file sentinel
    const props = new Map<number, Val[]>();
    const end = pos + len;
    let p = pos + 12;
    while (p < end) {
      const pid = b.readUInt16LE(p), type = b[p + 2];
      p += 3;
      let v: Val;
      if (type & 0x80) v = { t: 'empty', type: type & 0x7f };
      else switch (type) {
        case 0x02: v = { t: 'int', v: b.readInt32LE(p) }; p += 4; break;
        case 0x03: v = { t: 'time', v: Number(b.readBigInt64LE(p)) }; p += 8; break;
        case 0x05: v = { t: 'f64', v: b.readDoubleLE(p) }; p += 8; break;
        case 0x06: { const n = b.readUInt32LE(p); v = { t: 'str', v: b.subarray(p + 4, p + 4 + n).toString('utf16le').replace(/\0+$/, '') }; p += 4 + n; break; }
        case 0x07: { const n = b.readUInt32LE(p); v = { t: 'blob', v: b.subarray(p + 4, p + 4 + n) }; p += 4 + n; break; }
        case 0x08: v = { t: 'u32', v: b.readUInt32LE(p) }; p += 4; break;
        case 0x09: case 0x0b: {
          const size = b.readUInt32LE(p), n = b.readUInt32LE(p + 4);
          p += 8;
          const items: Uint8Array[] = [];
          for (let i = 0; i < n; i++, p += size) items.push(b.subarray(p, p + size));
          v = { t: 'arr', size, items };
          break;
        }
        case 0x0a: {
          const ks = b.readUInt32LE(p), vs = b.readUInt32LE(p + 4), n = b.readUInt32LE(p + 8);
          p += 12;
          const entries: [Uint8Array, Uint8Array][] = [];
          for (let i = 0; i < n; i++, p += ks + vs) entries.push([b.subarray(p, p + ks), b.subarray(p + ks, p + ks + vs)]);
          v = { t: 'map', ks, vs, entries };
          break;
        }
        default: throw new Error(`Vico .dpp file: unknown property type 0x${type.toString(16)} in record #${id} (class ${cls})`);
      }
      if (p > end) throw new Error(`Vico .dpp file: record #${id} (class ${cls}) overruns its length`);
      const list = props.get(pid);
      if (list) list.push(v); else props.set(pid, [v]);
    }
    recs.push({ id, cls, props });
    pos = end;
  }
  return recs;
}

const u32 = (x: Uint8Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength).readUInt32LE(0);
const f64 = (x: Uint8Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength).readDoubleLE(0);

class Store {
  readonly byId = new Map<number, Rec>();
  readonly recs: Rec[];
  constructor(recs: Rec[]) { this.recs = recs; for (const r of recs) this.byId.set(r.id, r); }
  get(id: number | null | undefined): Rec | undefined { return id == null ? undefined : this.byId.get(id); }
  ofClass(cls: number): Rec[] { return this.recs.filter((r) => r.cls === cls); }
}
const first = (r: Rec | undefined, pid: number): Val | undefined => r?.props.get(pid)?.[0];
const all = (r: Rec | undefined, pid: number): Val[] => r?.props.get(pid) ?? [];
const str = (r: Rec | undefined, pid: number): string => { const v = first(r, pid); return v?.t === 'str' ? v.v : ''; };
const num = (r: Rec | undefined, pid: number): number | null => {
  const v = first(r, pid);
  if (!v) return null;
  if (v.t === 'int' || v.t === 'f64' || v.t === 'u32' || v.t === 'time') return v.v;
  if (v.t === 'empty') return 0; // an empty numeric property is the type's default, 0
  return null;
};
const ref = (r: Rec | undefined, pid: number): number | null => { const v = first(r, pid); return v?.t === 'u32' ? v.v : null; };
const refs = (r: Rec | undefined, pid: number): number[] => { const v = first(r, pid); return v?.t === 'arr' && v.size === 4 ? v.items.map(u32) : []; };
const doubles = (r: Rec | undefined, pid: number): number[] => { const v = first(r, pid); return v?.t === 'arr' && v.size === 8 ? v.items.map(f64) : []; };
const mapRef = (r: Rec | undefined, pid: number): Map<number, number> => {
  const v = first(r, pid);
  return new Map(v?.t === 'map' && v.ks === 4 && v.vs === 4 ? v.entries.map(([k, x]) => [u32(k), u32(x)]) : []);
};
const mapF64 = (r: Rec | undefined, pid: number): [number, number][] => {
  const v = first(r, pid);
  return v?.t === 'map' && v.ks === 4 && v.vs === 8 ? v.entries.map(([k, x]) => [u32(k), f64(x)]) : [];
};

/** Times are wall-clock (07:00 is the calendar's 07:00) stored as seconds since 1970 as if UTC. */
const isoDate = (sec: number | null): string | null => (sec == null ? null : new Date(sec * 1000).toISOString().slice(0, 10));

// Record classes (third u32 of a record header) the reader understands, see docs/lob-vico-format.md.
const C = { PROJECT: 2, CALENDAR: 19, TASK_LOCATION: 11, TASK: 12, UNIT: 17, RESOURCE: 31, CREW: 32, LOCATION: 37, LEVEL: 10,
  SETTING: 42, BOQ_ITEM: 43, TASK_DURATION: 63, TASK_ORDER: 101, SCHEDULE: 103, TASK_RESULT: 105, LINE_RESULT: 104, LINE: 130 } as const;
// Every class seen in the five sample files; one outside this set may carry data (e.g. dependencies) not decoded here.
const KNOWN_CLASSES = new Set([2, 5, 7, 10, 11, 12, 17, 19, 31, 32, 37, 42, 43, 49, 58, 59, 63, 67, 76, 77, 79, 81, 82, 83, 88, 92, 93, 95, 96,
  97, 98, 99, 101, 103, 104, 105, 107, 109, 110, 113, 117, 118, 119, 122, 126, 129, 130, 132, 137, 138, 139, 143, 144, 150, 151, 153, 154,
  155, 157, 159, 160, 161, 162]);

// ---- calendar blob ------------------------------------------------------------------------------------------------

export interface VicoCalendar {
  name: string;
  /** Monday first. start in seconds after midnight, hours of work that day (0 = non-working). */
  week: { day: string; start: string; hours: number }[];
  /** Yearly holiday rules. 'fixed': every year on month-day. 'weekdayOnOrAfter': the first `weekday` (0 = Monday) on or
   *  after month-day (Memorial Day = Monday on/after 05-25, Thanksgiving = Thursday on/after 11-22). Inferred by
   *  matching the stored rules against the non-working days Schedule Planner exported to MS Project XML (2020-2036).
   *  `base` is the stored date (2006 in the samples); `raw` the stored kind byte and flag byte. */
  holidays: { name: string; rule: 'fixed' | 'weekdayOnOrAfter' | 'unknown'; month: number; day: number; weekday?: number; base: string; raw: { kind: number; flag: number } }[];
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hhmm = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;

/** The calendar blob (property 100 of a class-19 record) is big-endian, unlike the rest of the file. */
function parseCalendar(blob: Uint8Array): VicoCalendar {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  let p = 4; // u32 12 (format version?)
  const nameLen = b.readUInt32BE(p); p += 4;
  const name = b.subarray(p, p + 2 * nameLen).toString('utf16le'); p += 2 * nameLen;
  p += 1; // u8, 1 in the samples
  const week = DAYS.map((day) => { const s = b.readUInt32BE(p), d = b.readUInt32BE(p + 4); p += 8; return { day, start: hhmm(s), hours: d / 3600 }; });
  const holidays: VicoCalendar['holidays'] = [];
  const n = b.readUInt32BE(p); p += 4;
  for (let i = 0; i < n; i++) {
    const len = b.readUInt32BE(p); p += 4;
    const hname = b.subarray(p, p + 2 * len).toString('utf16le'); p += 2 * len;
    const kind = b[p]; p += 1;
    const from = Number(b.readBigInt64BE(p)); p += 8;
    let to: number | null = null;
    if (kind === 3) { to = Number(b.readBigInt64BE(p)); p += 8; }
    else if (kind !== 5) throw new Error(`unknown holiday kind ${kind}`);
    const flag = b[p]; p += 1;
    const d = new Date(from * 1000);
    const base = d.toISOString().slice(0, 10) + (to != null && to - from >= 86400 ? `..${new Date(to * 1000).toISOString().slice(0, 10)}` : '');
    const h: VicoCalendar['holidays'][number] = { name: hname, rule: 'unknown', month: d.getUTCMonth() + 1, day: d.getUTCDate(), base, raw: { kind, flag } };
    if (kind === 5 && flag <= 6) { h.rule = 'weekdayOnOrAfter'; h.weekday = flag; }
    else if (kind === 3 && flag === 1 && to != null && to - from < 86400) h.rule = 'fixed';
    holidays.push(h);
  }
  return { name, week, holidays };
}

// ---- the reader ---------------------------------------------------------------------------------------------------

export function readVicoDpp(bytes: Uint8Array): VicoProject {
  const store = new Store(parseRecords(inflateBody(bytes)));
  const notes: string[] = [];
  const root = store.ofClass(C.PROJECT)[0];
  if (!root) throw new Error('Vico .dpp file: no project record (class 2)');

  const info: Record<string, string> = {};
  for (const id of refs(root, 6)) {
    const s = store.get(id);
    if (s?.cls === C.SETTING && str(s, 102) && !str(s, 2).includes('::') && !str(s, 2).includes('##')) info[str(s, 2)] = str(s, 102);
  }

  // calendars
  const calendars: VicoCalendar[] = [];
  for (const c of store.ofClass(C.CALENDAR)) {
    const v = first(c, 100);
    if (v?.t !== 'blob') continue;
    try { calendars.push(parseCalendar(v.v)); } catch (e) { notes.push(`calendar #${c.id}: blob not decoded (${(e as Error).message})`); }
  }
  const workDays = calendars[0]?.week.filter((d) => d.hours > 0) ?? [];
  let hoursPerDay = workDays[0]?.hours ?? 8;
  if (!workDays.length) notes.push('no calendar decoded; durations in days assume 8 working hours per day');
  else if (workDays.some((d) => d.hours !== hoursPerDay)) notes.push(`calendar working hours differ by weekday; durations in days use ${hoursPerDay} h/day`);
  for (const c of calendars) for (const h of c.holidays) if (h.rule === 'unknown') notes.push(`calendar "${c.name}": holiday "${h.name}" has an undecoded rule (kind ${h.raw.kind}, flag ${h.raw.flag})`);

  // location breakdown: levels (root 353), locations in breakdown order (root 306)
  const levels = refs(root, 353).map((id) => str(store.get(id), 2));
  const locIds = refs(root, 306).filter((id) => store.get(id)?.cls === C.LOCATION);
  for (const l of store.ofClass(C.LOCATION)) if (!locIds.includes(l.id)) locIds.push(l.id);
  const locCode = new Map<number, string>(), locDepth = new Map<number, number>();
  const codeOf = (id: number, guard = 0): string => {
    const known = locCode.get(id);
    if (known != null) return known;
    const l = store.get(id);
    const own = str(l, 3).trim() || str(l, 2);
    const parent = ref(l, 301);
    let code = own, depth = 0;
    if (parent != null && store.get(parent)?.cls === C.LOCATION && guard < 64) {
      const pc = codeOf(parent, guard + 1);
      depth = (locDepth.get(parent) ?? 0) + 1;
      code = depth === 1 ? own : `${pc}/${own}`; // the top (project) location is not repeated in every code
    }
    locCode.set(id, code); locDepth.set(id, depth);
    return code;
  };
  const locations = locIds.map((id) => {
    const l = store.get(id)!;
    const code = codeOf(id);
    const parent = ref(l, 301);
    return { code, name: str(l, 2), level: locDepth.get(id) ?? 0, parent: parent != null && store.get(parent)?.cls === C.LOCATION ? codeOf(parent) : null };
  });
  if (new Set(locations.map((l) => l.code)).size !== locations.length) notes.push('location codes are not unique');
  const maxDepth = Math.max(0, ...locations.map((l) => l.level));
  if (levels.length && maxDepth + 1 !== levels.length) notes.push(`location tree depth ${maxDepth + 1} differs from the ${levels.length} breakdown levels`);
  const isUnder = (loc: number, anc: number): boolean => {
    for (let x: number | null = loc, g = 0; x != null && g < 64; x = ref(store.get(x), 301), g++) if (x === anc) return true;
    return false;
  };

  // task order: the class-101 record the project points at (root 365), else file order
  const order = refs(store.get(ref(root, 365)), 100);
  const taskRecs = store.ofClass(C.TASK).sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  // scheduled finish per sub-task: root 372 -> class 103, property 103 maps task -> class 105 -> class 104 (101 = finish)
  const resultOf = mapRef(store.get(ref(root, 372)), 103);
  const boq = store.ofClass(C.BOQ_ITEM);

  const tasks = taskRecs.map((t) => {
    const code = str(t, 3), name = str(t, 2), label = code || name;
    const lines = refs(t, 540).map((id) => store.get(id)).filter((r): r is Rec => r?.cls === C.LINE);
    const tls = lines.flatMap((l) => refs(l, 301).map((id) => store.get(id)).filter((r): r is Rec => r?.cls === C.TASK_LOCATION));
    // start: earliest sub-task start; end: latest stored finish
    const starts = lines.map((l) => num(l, 302)).filter((x): x is number => x != null && x > 0);
    const start = starts.length ? Math.min(...starts) : null;
    const res = store.get(resultOf.get(t.id));
    const ends = refs(res, 109).map((id) => num(store.get(id), 101)).filter((x): x is number => x != null && x > 0);
    const end = ends.length ? Math.max(...ends) : null;
    if (end == null) notes.push(`${label}: no stored finish date`);
    // duration: working seconds of each task-location (class 63, first value of property 101), summed
    let secs = 0, haveDur = true;
    for (const tl of tls) {
      const d = all(store.get(ref(tl, 414)), 101)[0];
      if (d?.t === 'time') secs += d.v; else haveDur = false;
    }
    const durationDays = haveDur && tls.length ? Math.round((secs / 3600 / hoursPerDay) * 1000) / 1000 : null;
    // crew: sub-task -> class 32 (200 resources, 204 people per crew) x number of crews (528 on the task-location)
    const crews = lines.map((l, i) => {
      const cr = store.get(ref(l, 305));
      const names = refs(cr, 200).map((id) => str(store.get(id), 2)).filter(Boolean);
      const perCrew = doubles(cr, 204).reduce((a, b) => a + b, 0);
      const tl = tls.find((x) => ref(x, 526) === l.id) ?? tls[i];
      const n = num(tl, 528) ?? 1;
      return names.length ? { name: names.join(' + '), size: Math.round(perCrew * n * 1000) / 1000 } : null;
    });
    const crew = crews.find((c) => c) ?? null;
    if (crews.some((c) => c && (c.name !== crew?.name || c.size !== crew?.size))) notes.push(`${label}: crew differs between sub-tasks (${crews.map((c) => c ? `${c.name} ${c.size}` : 'none').join(', ')}); the first is reported`);
    // quantity items; effective consumption = base / productivity factor (500) of the task-location covering it
    const items = boq.filter((b) => ref(b, 508) === t.id).map((b) => {
      const base = num(b, 501) ?? 0;
      const qs = mapF64(b, 505);
      const ordered = locIds.filter((id) => qs.some(([k]) => k === id)).map((id) => [id, qs.find(([k]) => k === id)![1]] as const);
      for (const [k, q] of qs) if (!locIds.includes(k)) ordered.push([k, q] as const);
      let hours = 0, total = 0, unfactored = false;
      for (const [loc, q] of ordered) {
        const tl = tls.find((x) => { const at = ref(x, 315); return at != null && isUnder(loc, at); });
        const f = tl ? num(tl, 500) : null;
        if (!f) unfactored = true;
        hours += q * base / (f || 1);
        total += q;
      }
      if (unfactored && total) notes.push(`${label}/${str(b, 2)}: some quantities have no task-location productivity factor; factor 1 assumed`);
      const unit = str(store.get(ref(b, 506)), 2);
      return {
        name: str(b, 2), unit, consumption: total ? hours / total : base,
        quantities: ordered.map(([loc, q]) => ({ location: locCode.get(loc) ?? `#${loc}`, quantity: q })),
        baseConsumption: base, unitPrice: num(b, 513) ?? undefined,
      };
    });
    const taskLocs = tls.map((x) => ref(x, 315)).filter((x): x is number => x != null).map((id) => locCode.get(id) ?? `#${id}`);
    return { code, name, start: isoDate(start), end: isoDate(end), durationDays, crew, items, locations: taskLocs };
  });

  const unknown = [...new Set(store.recs.map((r) => r.cls).filter((c) => !KNOWN_CLASSES.has(c)))];
  notes.push(unknown.length
    ? `no dependency records decoded; record classes not seen in the reference samples are present (${unknown.join(', ')}) and may hold logic`
    : 'no dependency records found (none of the reference samples has links, so the link encoding is unknown)');
  notes.push('task timing mode (paced / as soon as possible), location order direction, lags and buffers are not decoded');

  return {
    name: str(root, 2),
    start: isoDate(num(root, 303)),
    end: isoDate(num(root, 313)),
    levels,
    locations,
    tasks,
    links: [],
    calendars: calendars.length ? calendars : undefined,
    info,
    notes,
  };
}
