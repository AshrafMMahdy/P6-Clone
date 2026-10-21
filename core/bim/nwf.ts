// TimeLiner tasks straight from a Navisworks .nwf/.nwd, without Navisworks. The file is "#LcUStream-V1.1 binary ..."
// followed by zlib streams; the TimeLiner element holds, per task: a length-prefixed name, the actual start and end and
// the planned start and end as int64 Unix seconds (actual pair first), the task type name, and the attached selection
// sets ("lcop_selection_set_tree/<set name>"). Decoded from a real 2016 file (sample 4D/navisworks-real-2016-villa);
// newer versions may lay the chunk out differently, so anything not found is reported, not guessed.
import { inflateSync } from 'node:zlib';

export interface NwfTask { name: string; actualStart: string | null; actualFinish: string | null; plannedStart: string | null; plannedFinish: string | null; type: string; attached: string[] }

const SET = 'lcop_selection_set_tree/';
const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** Length-prefixed (u32 LE) printable Latin-1 strings in a buffer, with where they start and end. */
function strings(b: Buffer): { s: string; at: number; end: number }[] {
  const out: { s: string; at: number; end: number }[] = [];
  for (let i = 0; i + 4 < b.length; i++) {
    const n = b.readUInt32LE(i);
    if (n < 2 || n > 400 || i + 4 + n > b.length) continue;
    let ok = true;
    for (let k = 0; k < n; k++) { const c = b[i + 4 + k]; if (c < 0x20 || (c > 0x7e && c < 0xa0)) { ok = false; break; } }
    if (!ok) continue;
    out.push({ s: b.subarray(i + 4, i + 4 + n).toString('latin1'), at: i, end: i + 4 + n });
    i += 3 + n;
  }
  return out;
}

export function readNwfTimeliner(file: Uint8Array): { header: string; tasks: NwfTask[]; notes: string[] } {
  const b = Buffer.from(file);
  const header = b.subarray(0, Math.max(0, b.indexOf(10))).toString('latin1');
  if (!header.startsWith('#LcUStream')) return { header, tasks: [], notes: ['Not a Navisworks file (no "#LcUStream" header).'] };
  const tasks: NwfTask[] = [];
  for (let i = 0; i < b.length - 2; i++) {
    if (b[i] !== 0x78 || ![0x01, 0x5e, 0x9c, 0xda].includes(b[i + 1])) continue;
    let s: Buffer;
    try { s = inflateSync(b.subarray(i)); } catch { continue; }
    if (!s.includes(SET, 0, 'latin1')) continue;
    const strs = strings(s);
    // a task: name, then (after the dates) its type, then 0xFFFFFFFF, a count, and the attached set paths
    for (let k = 0; k < strs.length; k++) {
      const t = strs[k];
      if (t.s.startsWith(SET) || k + 1 >= strs.length) continue;
      const type = strs[k + 1];
      if (type.s.startsWith(SET) || !/^[A-Za-z][\w ]{1,40}$/.test(type.s)) continue;
      const attached: string[] = [];
      for (let j = k + 2; j < strs.length && strs[j].s.startsWith(SET); j++) attached.push(strs[j].s.slice(SET.length));
      // the four dates between the name and the type: int64 Unix seconds in a plausible range
      const dates: number[] = [];
      for (let p = t.end; p + 8 <= type.at && dates.length < 4; p++) { const v = Number(s.readBigInt64LE(p)); if (v > 946684800 && v < 4102444800) { dates.push(v); p += 7; } }
      if (dates.length < 4 || !attached.length && !['Construct', 'Demolish', 'Temporary'].includes(type.s)) continue;
      tasks.push({ name: t.s, actualStart: iso(dates[0]), actualFinish: iso(dates[1]), plannedStart: iso(dates[2]), plannedFinish: iso(dates[3]), type: type.s, attached });
      k += 1 + attached.length;
    }
    if (tasks.length) break;
  }
  return { header, tasks, notes: tasks.length ? ['Explicit selection sets are stored as item paths in the model tree; they are linked by set name.'] : ['No TimeLiner tasks were found (an empty TimeLiner, or a newer layout).'] };
}
