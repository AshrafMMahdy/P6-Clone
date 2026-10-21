// SYNCHRO project files (.sp): tasks, links, resources (the 3D objects) and task-resource assignments (the 4D links).
// A .sp is a 16-byte magic, a u32 schema number, a version string, then a directory of 48-byte entries (NUL-padded
// name, u32 offset at byte 40) ending at an empty name. Each table sits at its offset as its name again and one zlib
// stream. Inflated (schema 353+ adds a 24-byte prefix), a table is 0x39AF547A, a row count, rows that each open with a
// per-type u32 magic (most then carry 16 bytes, 8 from 6.0, and the row's GUID), and 0x6F99E416; tables nest. Strings
// are MFC-style (a 01 type byte or FF, a length, FF FE for UTF-16LE). Dates are u32 seconds from 1970 in wall-clock
// time (0x93406FFF is none), durations i32 seconds. A planned task stores only its start and working duration, so its
// finish comes from its calendar. Layout follows MPXJ's SYNCHRO reader (LGPL), re-derived and checked against files
// from 5.1 to 6.5; fields between the ones we use are skipped, and every row must end where the next one starts, so a
// misread row is stepped over and counted in the notes instead of derailing the file.
import { inflateSync } from 'node:zlib';

export interface SynchroTask { uuid: string; id: string; name: string; start: string | null; finish: string | null; actualStart: string | null; actualFinish: string | null; durationHours: number | null; parent: string | null; isSummary: boolean }
export interface SynchroLink { from: string; to: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lagHours: number }
export interface SynchroResource { uuid: string; name: string; parent: string | null }
export interface SynchroFile { version: string; tasks: SynchroTask[]; predecessors: SynchroLink[]; resources: SynchroResource[]; assignments: { task: string; resource: string }[]; notes: string[] }

const MAGIC = 'b617671e7af34640a86ed5dc417a2de2';
const HDR = 0x39af547a, TRL = 0x6f99e416, BLOCKS = 0x06a1bcd0, NONE = 0x93406fff, DAY = 86400;
const M = { task: 0x04ec2576, assign: 0x4623d899, pred: 0x04e7e3d1, resource: 0x57a85c31, company: 0x0598bfda, calendar: 0x7fec261d, dayType: 0xc4f4c21d, dayAssign: 0x0d1a3d6c };
const LINK: SynchroLink['type'][] = ['FS', 'FS', 'SF', 'SS', 'FF'];

/** A read position in one inflated table; `v` is the format level (51 for 5.1, 60, 62, 63 ...); `bad` counts skipped rows. */
interface Cur { b: Buffer; p: number; v: number; bad: number }

const u8 = (c: Cur) => c.b.readUInt8(c.p++);
const u16 = (c: Cur) => { const x = c.b.readUInt16LE(c.p); c.p += 2; return x; };
const u32 = (c: Cur) => { const x = c.b.readUInt32LE(c.p); c.p += 4; return x; };
const i32 = (c: Cur) => { const x = c.b.readInt32LE(c.p); c.p += 4; return x; };
const skip = (c: Cur, n: number) => { if (n < 0 || c.p + n > c.b.length) throw new Error('past the end'); c.p += n; };
const fail = (what: string): never => { throw new Error(what); };

/** GUID in the Windows byte order (first three groups little-endian), lower case. */
const ORDER = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
function guidAt(b: Buffer, p: number): string { return ORDER.map((i) => i < 0 ? '-' : b[p + i].toString(16).padStart(2, '0')).join(''); }
function uuid(c: Cur): string { skip(c, 16); return guidAt(c.b, c.p - 16); }

function str(c: Cur): string {
  const type = u8(c);
  let n = type === 0xff ? 0xff : type === 1 ? u8(c) : fail(`string type byte ${type}`), wide = false;
  if (n === 0xff) {
    n = u16(c);
    if (n === 0xfffe) { wide = true; n = u8(c); if (n === 0xff) { n = u16(c); if (n === 0xffff) n = u32(c); } }
    else if (n === 0xffff) n = u32(c);
  }
  const len = wide ? n * 2 : n;
  skip(c, len);
  return c.b.subarray(c.p - len, c.p).toString(wide ? 'utf16le' : 'utf8');
}

/** A date (u32 seconds plus 4 unused bytes) as seconds, or null. */
function date(c: Cur): number | null { const s = u32(c); skip(c, 4); return s === NONE ? null : s; }
function seconds(c: Cur): number | null { const s = u32(c); return s === NONE ? null : s | 0; }
const iso = (s: number | null) => s === null ? null : new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** End of the row starting at `from`: the next depth-0 row magic or the closing trailer, stepping over nested tables. */
function rowEnd(b: Buffer, from: number, magic: number): number {
  let depth = 0;
  for (let i = from; i + 4 <= b.length; i++) {
    const x = b.readUInt32LE(i);
    if (x === HDR) depth++;
    else if (x === TRL) { if (!depth) return i; depth--; }
    else if (x === magic && !depth) return i;
  }
  return b.length;
}

/** Steps over a whole table (header to matching trailer) without reading its rows. */
function skipTable(c: Cur): void {
  if (u32(c) !== HDR) fail('table header');
  const end = rowEnd(c.b, c.p, -1);
  if (end >= c.b.length) fail('unterminated table');
  c.p = end + 4;
}
const skipTableIf = (c: Cur) => { if (u8(c)) skipTable(c); };
function skipBlocks(c: Cur, size: number): void { if (u32(c) !== BLOCKS) fail('block list'); skip(c, u32(c) * size); skip(c, 4); }

/** Reads a table of one row type; `withId` rows carry the usual 16 (6.0+: 8) bytes and a GUID after the magic. */
function table<T>(c: Cur, magic: number, row: (c: Cur, id: string) => T, withId = true): T[] {
  if (u32(c) !== HDR) fail('table header');
  const count = u32(c), out: T[] = [];
  for (let k = 0; k < count; k++) {
    const start = c.p;
    if (u32(c) !== magic) fail('row magic');
    try {
      let id = '';
      if (withId) { skip(c, c.v >= 60 ? 8 : 16); id = uuid(c); }
      const r = row(c, id), next = c.b.readUInt32LE(c.p);
      if (next !== magic && next !== TRL) fail('row length');
      out.push(r);
    } catch {
      c.bad++;
      c.p = rowEnd(c.b, start + 4, magic);
    }
  }
  if (u32(c) !== TRL) fail('table trailer');
  return out;
}

// ---- calendars: day types (lists of working ranges) for the seven weekdays, and dated exceptions

interface Cal { week: [number, number][][]; days: Map<number, [number, number][]> }

function readCalendars(c: Cur): { cals: Map<string, Cal>; main: string | null } {
  const cals = new Map<string, Cal>();
  for (const r of table(c, M.calendar, (c, id) => {
    str(c); skipTable(c); skip(c, 4);
    const week: string[] = [];
    for (let d = 0; d < 7; d++) week.push(uuid(c));
    skip(c, 4);
    const dated = table(c, M.dayAssign, (c) => { const at = date(c), t = uuid(c); skip(c, c.v >= 62 ? 8 : 4); return { at, t }; }, false);
    const types = new Map(table(c, M.dayType, (c) => {
      const t = uuid(c);
      str(c); skip(c, 12 + 4);
      const ranges: [number, number][] = [];
      // times are seconds of the day plus 86400; an end at midnight is the end of the day
      for (let n = u32(c); n > 0; n--) { const a = u32(c) - DAY; skip(c, 4); const e = u32(c) - DAY; skip(c, 4); ranges.push([a % DAY, e === 0 ? DAY : e]); }
      skip(c, 8);
      return [t, ranges] as const;
    }, false));
    skip(c, 8);
    const days = new Map<number, [number, number][]>();
    for (const d of dated) if (d.at !== null) days.set(Math.floor(d.at / DAY), types.get(d.t) ?? []);
    return { id, cal: { week: week.map((t) => types.get(t) ?? []), days } };
  })) cals.set(r.id, r.cal);
  return { cals, main: c.p + 16 <= c.b.length ? uuid(c) : null };
}

/** The moment `hours` of working time after `start` on `cal`; elapsed time when the calendar has no working time. */
function addWork(cal: Cal | undefined, start: number, hours: number): number {
  let left = Math.round(hours * 3600);
  if (left <= 0 || !cal || !cal.week.some((r) => r.length)) return start + Math.max(0, left);
  let day = Math.floor(start / DAY), t = start - day * DAY;
  for (let n = 0; n < 366 * 50; n++, day++, t = 0) {
    for (const [a, b] of cal.days.get(day) ?? cal.week[((day + 4) % 7 + 7) % 7]) {
      const s = Math.max(a, t);
      if (b <= s) continue;
      if (b - s >= left) return day * DAY + s + left;
      left -= b - s;
    }
  }
  return start + Math.round(hours * 3600);
}

// ---- tasks: each row nests its resource assignments, its predecessors and its child tasks

interface RawTask { uuid: string; id: string; name: string; cal: string; status: number; plannedStart: number | null; plannedFinish: number | null; actualStart: number | null; actualFinish: number | null; estFinish: number | null; dur: number | null; kids: RawTask[]; preds: { uuid: string; type: SynchroLink['type']; lag: number }[]; res: string[] }

function readTaskRow(c: Cur, id: string, resIds: Set<string>): RawTask {
  skip(c, 1);
  const res = table(c, M.assign, (c) => {
    // the resource GUID: right after the row GUID in 5.1; from 5.4 after an unknown block, a double, 10 bytes and a GUID
    const at = c.p, end = rowEnd(c.b, at, M.assign);
    let r = guidAt(c.b, at + (c.v < 54 ? 0 : (c.v >= 63 ? 69 : 57) + 8 + 10 + 16));
    // otherwise any known resource GUID early in the row
    for (let p = at; !resIds.has(r) && p + 16 <= Math.min(end, at + 240); p++) if (resIds.has(guidAt(c.b, p))) r = guidAt(c.b, p);
    c.p = end;
    return r;
  });
  skip(c, 4);
  const preds = table(c, M.pred, (c) => {
    const pred = uuid(c), t = u32(c);
    let lag: number | null;
    if (c.v >= 62) { lag = Number(c.b.readBigInt64LE(c.p)); skip(c, 8 + 16 + 8); }
    else {
      skip(c, 4); lag = seconds(c); skip(c, 4);
      let neg: boolean;
      if (c.v < 61) { neg = u32(c) === 2; skip(c, 16 + 8); } else { skip(c, 16); neg = u32(c) === 2; }
      if (lag && neg) lag = -lag;
    }
    return { uuid: pred, type: LINK[t] ?? 'FS', lag: (lag ?? 0) / 3600 };
  });
  const cal = uuid(c), name = str(c), plannedStart = date(c), dur = seconds(c);
  skip(c, 4);
  const kids = u8(c) ? table(c, M.task, (c, k) => readTaskRow(c, k, resIds)) : [];
  skipTableIf(c); // costs
  const actualStart = date(c), plannedFinish = date(c);
  date(c);
  const actualFinish = date(c);
  skipTableIf(c); skip(c, 2); skipTableIf(c); // an unknown table, commentary
  skipBlocks(c, 20); skip(c, 4 + 4 + 8 + 8 + 40); skipBlocks(c, 20); skip(c, 26); // files, constraint type and dates
  str(c); skip(c, 4 + 8); skipBlocks(c, 20); // url, progress type, percent complete
  const tid = str(c);
  skipTableIf(c); skip(c, 4 + 20); // user fields, remaining duration
  const status = i32(c);
  skip(c, 4 * 8 + 4 + 8 + 8 + 4 + 8); // four dates, physical quantities
  // 5.1 rows end with 8 more bytes; 5.4 on add an estimated finish and a table first
  let estFinish: number | null = null;
  if (c.v >= 54) { estFinish = date(c); skipTable(c); }
  skip(c, 8);
  return { uuid: id, id: tid, name, cal, status, plannedStart, plannedFinish, actualStart, actualFinish, estFinish, dur: dur === null ? null : dur / 3600, kids, preds, res };
}

// ---- resources: a tree; up to 6.1 it hangs under the companies

interface RawRes { uuid: string; name: string; kids: RawRes[] }

function readResourceRow(c: Cur, id: string): RawRes {
  const name = str(c);
  str(c);
  if (i32(c)) str(c); // description, supply reference
  skip(c, 32); skip(c, u32(c) * 20); skip(c, 12);
  const kids = table(c, M.resource, readResourceRow);
  c.p = rowEnd(c.b, c.p, M.resource);
  return { uuid: id, name, kids };
}

function readCompanyRow(c: Cur, id: string): RawRes {
  skip(c, 20);
  const kids = table(c, M.resource, readResourceRow), name = str(c);
  c.p = rowEnd(c.b, c.p, M.company);
  return { uuid: id, name, kids };
}

// ---- the container

const WANTED = ['Tasks', 'Companies', 'Resources', 'Calendars'];

function container(file: Uint8Array, notes: string[]): { version: string; schema: number; tables: Map<string, Buffer> } | null {
  const b = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (b.length < 24 || b.subarray(0, 16).toString('hex') !== MAGIC) return null;
  const schema = b.readUInt32LE(16), c: Cur = { b, p: 20, v: 0, bad: 0 };
  let version: string;
  try { version = str(c); } catch { return null; }
  const dir: { name: string; at: number }[] = [];
  while (c.p + 48 <= b.length) {
    const e = b.subarray(c.p, c.p + 48), z = e.indexOf(0);
    const name = e.subarray(0, z < 0 || z > 40 ? 40 : z).toString('latin1');
    if (!name) break;
    dir.push({ name, at: e.readUInt32LE(40) });
    c.p += 48;
  }
  dir.sort((x, y) => x.at - y.at);
  const tables = new Map<string, Buffer>();
  dir.forEach((t, k) => {
    if (!WANTED.includes(t.name)) return;
    try {
      const tc: Cur = { b, p: t.at, v: 0, bad: 0 };
      if (str(tc) !== t.name) fail('the name at its offset differs');
      const raw = inflateSync(b.subarray(tc.p, k + 1 < dir.length ? dir[k + 1].at : b.length));
      // from schema 353 (5.5 Scheduler and 6.x) a table opens with 24 bytes: 8 zero bytes and a GUID
      tables.set(t.name, raw.readUInt32LE(0) === HDR ? raw : raw.subarray(24));
    } catch (e) { notes.push(`Table ${t.name} could not be read (${(e as Error).message}).`); }
  });
  return { version, schema, tables };
}

/** Format level from the version string, raised by the schema number (the 5.5 Scheduler is laid out like 6.0). */
function level(version: string, schema: number): number {
  const [a, b] = version.split('.').map(Number);
  const fromVersion = a * 10 + (b || 0) || 0;
  const fromSchema = schema >= 478 ? 65 : schema >= 457 ? 64 : schema >= 434 ? 63 : schema >= 414 ? 62 : schema >= 400 ? 61 : schema >= 353 ? 60 : schema >= 310 ? 54 : 51;
  return Math.max(fromVersion, fromSchema);
}

export function readSynchro(bytes: Uint8Array): SynchroFile {
  const notes: string[] = [];
  const box = container(bytes, notes);
  if (!box) throw new Error('Not a SYNCHRO project file (no .sp header).');
  const v = level(box.version, box.schema);
  const out: SynchroFile = { version: box.version, tasks: [], predecessors: [], resources: [], assignments: [], notes };
  const cur = (name: string): Cur | null => { const b = box.tables.get(name); if (!b) notes.push(`No ${name} table.`); return b ? { b, p: 0, v, bad: 0 } : null; };
  let bad = 0;

  const resName = v >= 62 ? 'Resources' : 'Companies', rc = cur(resName);
  const addRes = (r: RawRes, parent: string | null) => { out.resources.push({ uuid: r.uuid, name: r.name, parent }); r.kids.forEach((k) => addRes(k, r.uuid)); };
  if (rc) {
    try { table(rc, v >= 62 ? M.resource : M.company, v >= 62 ? readResourceRow : readCompanyRow).forEach((r) => addRes(r, null)); }
    catch (e) { notes.push(`${resName} table stopped early (${(e as Error).message}).`); }
    bad += rc.bad;
    if (v < 62) notes.push('Up to SYNCHRO 6.1 resources hang under companies; each company is a top-level resource here.');
  }

  let cals = new Map<string, Cal>(), main: string | null = null;
  const cc = cur('Calendars');
  if (cc) {
    try { ({ cals, main } = readCalendars(cc)); } catch (e) { notes.push(`Calendars could not be read (${(e as Error).message}); finishes use elapsed time.`); }
    bad += cc.bad;
  }

  const raw: RawTask[] = [], tc = cur('Tasks'), resIds = new Set(out.resources.map((r) => r.uuid));
  if (tc) {
    try { raw.push(...table(tc, M.task, (c, id) => readTaskRow(c, id, resIds))); } catch (e) { notes.push(`Tasks table stopped early (${(e as Error).message}).`); }
    bad += tc.bad;
  }

  // dates: status 1 planned (finish from the calendar), 2 started, 3 finished; a summary spans its children
  const known = new Set<string>();
  let blank = 0;
  const walk = (t: RawTask, parent: string | null): { s: number | null; f: number | null } => {
    // SYNCHRO keeps blank lines of the Gantt as rows with no id, name, date or links
    if (!t.id && !t.name && t.plannedStart === null && !t.kids.length && !t.res.length && !t.preds.length) { blank++; return { s: null, f: null }; }
    const aS = t.status >= 2 ? t.actualStart : null, aF = t.status === 3 ? t.actualFinish : null;
    let s = aS ?? t.plannedStart, f = t.status === 3 ? aF : t.status === 2 ? t.estFinish ?? t.plannedFinish : null;
    if (f === null && s !== null && t.dur !== null) f = addWork(cals.get(t.cal) ?? (main ? cals.get(main) : undefined) ?? cals.values().next().value, s, t.dur);
    const row: SynchroTask = { uuid: t.uuid, id: t.id, name: t.name, start: null, finish: null, actualStart: iso(aS), actualFinish: iso(aF), durationHours: t.dur, parent, isSummary: t.kids.length > 0 };
    out.tasks.push(row);
    known.add(t.uuid);
    if (t.kids.length) {
      const spans = t.kids.map((k) => walk(k, t.uuid));
      const ss = spans.map((x) => x.s).filter((x) => x !== null), fs = spans.map((x) => x.f).filter((x) => x !== null);
      s = ss.length ? Math.min(...ss) : s; f = fs.length ? Math.max(...fs) : f;
    }
    row.start = iso(s); row.finish = iso(f);
    return { s, f };
  };
  raw.forEach((t) => walk(t, null));

  let lost = 0, orphan = 0;
  const links = (t: RawTask) => {
    for (const p of t.preds) if (known.has(p.uuid)) out.predecessors.push({ from: p.uuid, to: t.uuid, type: p.type, lagHours: p.lag }); else lost++;
    for (const r of t.res) { out.assignments.push({ task: t.uuid, resource: r }); if (!resIds.has(r)) orphan++; }
    t.kids.forEach(links);
  };
  raw.forEach(links);
  if (blank) notes.push(`${blank} blank task rows (no id, name or dates) were left out.`);
  if (bad) notes.push(`${bad} rows could not be decoded and were skipped.`);
  if (lost) notes.push(`${lost} links point at tasks not in the file and were left out.`);
  if (orphan) notes.push(`${orphan} assignments name a resource that is not in the resource tree.`);
  if (!cals.size && out.tasks.length) notes.push('No calendars were read; planned finishes use elapsed time.');
  return out;
}
