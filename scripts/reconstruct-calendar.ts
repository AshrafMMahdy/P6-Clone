// Reconstruct the calendar P6 actually scheduled with, from P6's own stored dates: picks, day by day, the work
// pattern (the calendar's normal day, the shortest exception pattern in the file, or none) that makes the most
// not-started tasks' stored dates span exactly their remaining duration. Then reschedules with it.
// Used to prove that a file's calendar was edited after P6 last scheduled it.
// Usage: node scripts/reconstruct-calendar.ts <fileSubstring> [clndr_id ...]
import { parseXer } from '../core/xer/parse.ts';
import { realSamples } from '../tests/helpers.ts';
import { parseClndrData, serializeClndrData, type CalendarDef, type Shift } from '../core/calendar/clndr-data.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';
import { FIELDS } from './oracle.ts';

type Iv = [number, number]; // minutes within the day
const D = 1440, EPOCH = 25569; // OLE serial day of 1970-01-01

export function reconstruct(file: string, calIds?: string[]) {
  const s = realSamples().find((x) => x.name.toLowerCase().includes(file.toLowerCase()))!;
  const orig = parseXer(s.bytes).db, db = parseXer(s.bytes).db;
  const tasks = orig.tables.TASK.rows.filter((t) => t.status_code === 'TK_NotStart' && t.task_type === 'TT_Task');
  const ids = calIds?.length ? calIds : [...new Set(tasks.map((t) => t.clndr_id))];
  const changes: string[] = [];
  for (const id of ids) {
    const c = db.tables.CALENDAR.rows.find((x) => x.clndr_id === id);
    if (!c) continue;
    const def = parseClndrData(c.clndr_data);
    const toIv = (ws: Shift[] | undefined): Iv[] => (ws ?? []).map((w) => [w.start, w.end]);
    const weekIv = def.week.map((d) => toIv(d));
    const allPats = [...new Set(db.tables.CALENDAR.rows.flatMap((x) => { const q = parseClndrData(x.clndr_data); return [...q.week, ...q.exceptions.values()].filter((v) => v.length).map((v) => JSON.stringify(toIv(v))); }))].map((x) => JSON.parse(x) as Iv[]);
    const shorts = [...def.exceptions.values()].filter((v) => v.length).map((v) => JSON.stringify(toIv(v)));
    const short = shorts.length ? JSON.parse(shorts.sort((a, b) => shorts.filter((x) => x === b).length - shorts.filter((x) => x === a).length)[0]) as Iv[] : null;
    const T = tasks.filter((t) => t.clndr_id === id).map((t) => ({ es: parseP6Date(t.early_start_date)!, ef: parseP6Date(t.early_end_date)!, d: Number(t.remain_drtn_hr_cnt) * 60 })).filter((t) => t.ef > t.es);
    if (!T.length) continue;
    const d0 = Math.floor(Math.min(...T.map((t) => t.es)) / D), d1 = Math.floor(Math.max(...T.map((t) => t.ef)) / D);
    const day = new Map<number, Iv[]>();
    for (let k = d0; k <= d1; k++) { const ex = def.exceptions.get(k + EPOCH); day.set(k, ex ? toIv(ex) : weekIv[(new Date(k * D * 60000).getUTCDay())]); }
    const over = (k: number, iv: Iv[], a: number, b: number) => iv.reduce((x, [s0, f0]) => x + Math.max(0, Math.min(b, k * D + f0) - Math.max(a, k * D + s0)), 0);
    const work = (t: { es: number; ef: number }) => { let w = 0; for (let k = Math.floor(t.es / D); k <= Math.floor((t.ef - 1) / D); k++) w += over(k, day.get(k)!, t.es, t.ef); return w; };
    const byDay = new Map<number, number[]>();
    T.forEach((t, i) => { for (let k = Math.floor(t.es / D); k <= Math.floor((t.ef - 1) / D); k++) { let l = byDay.get(k); if (!l) byDay.set(k, (l = [])); l.push(i); } });
    const wk = T.map(work);
    const ok = (i: number) => Math.abs(wk[i] - T[i].d) < 2;
    const before = T.filter((_, i) => ok(i)).length;
    if (process.env.DBG) T.forEach((t, i) => { if (!ok(i)) console.log("bad", formatP6Date(t.es), formatP6Date(t.ef), wk[i] / 60, t.d / 60); });
    for (let sweep = 0; sweep < 12; sweep++) {
      const pats = sweep < 6 ? (short ? [short] : []) : allPats; // the calendar's own short day first, then every pattern in the file
      let changed = false;
      for (const [k, list] of byDay) {
        const cur = day.get(k)!;
        const opts: Iv[][] = [weekIv[new Date(k * D * 60000).getUTCDay()], [], ...pats];
        // score: exact matches first, then smaller total error (moved holidays need several days to change)
        const sc = (o: Iv[]) => { let m = 0, e = 0; for (const i of list) { const x = Math.abs(wk[i] - over(k, cur, T[i].es, T[i].ef) + over(k, o, T[i].es, T[i].ef) - T[i].d); if (x < 2) m++; e += x; } return m * 1e6 - e; };
        let best = cur, bestScore = sc(cur);
        if (process.env.DBG && list.length > 5) console.log("day", formatP6Date(k * D), JSON.stringify(cur), opts.map((o) => JSON.stringify(o) + ":" + sc(o)).join(" "), bestScore);
        for (const o of opts) {
          if (JSON.stringify(o) === JSON.stringify(cur)) continue;
          const score = sc(o);
          if (score > bestScore) { best = o; bestScore = score; }
        }
        if (best !== cur) { for (const i of list) wk[i] += over(k, best, T[i].es, T[i].ef) - over(k, cur, T[i].es, T[i].ef); day.set(k, best); changed = true; }
      }
      if (!changed && sweep >= 6) break;
      if (!changed) sweep = 5;
    }
    const after = T.filter((_, i) => ok(i)).length;
    if (process.env.DBG2) { const h = new Map<string, number>(); T.forEach((t, i) => { if (!ok(i)) { const key = `${Math.round((T[i].d - wk[i]) / 60)}h`; h.set(key, (h.get(key) ?? 0) + 1); if ((h.get(key) ?? 0) < 3) console.log("still", formatP6Date(t.es), formatP6Date(t.ef), "dur", t.d / 60, "work", wk[i] / 60); } }); console.log([...h].sort((a, b) => b[1] - a[1]).slice(0, 12)); }
    // write the reconstructed days back as exceptions where they differ from the normal week
    const out: CalendarDef = { ...def, exceptions: new Map([...def.exceptions].filter(([k]) => k - EPOCH < d0 || k - EPOCH > d1)) };
    const diff: string[] = [];
    for (const [k, iv] of day) {
      const norm = weekIv[new Date(k * D * 60000).getUTCDay()];
      const was = def.exceptions.get(k + EPOCH); const wasIv = was ? toIv(was) : norm;
      if (JSON.stringify(iv) !== JSON.stringify(norm)) out.exceptions.set(k + EPOCH, iv.map(([a, b]) => ({ start: a, end: b })));
      if (JSON.stringify(iv) !== JSON.stringify(wasIv)) diff.push(`${formatP6Date(k * D).slice(0, 10)} ${desc(wasIv)}→${desc(iv)}`);
    }
    c.clndr_data = serializeClndrData(out);
    changes.push(`${c.clndr_name}: tasks consistent ${before}/${T.length} → ${after}/${T.length}; ${diff.length} day(s) differ from the file: ${diff.slice(0, Number(process.env.SHOW ?? 12)).join(', ')}${diff.length > 12 ? ', ...' : ''}`);
  }
  scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
  const A = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
  let n = 0, wrong = 0;
  for (const o of orig.tables.TASK.rows) {
    if (o.status_code === 'TK_Complete' || o.act_end_date) continue;
    n++;
    const a = A.get(o.task_id)!;
    for (const f of FIELDS) if (!(f.endsWith('_cnt') ? Math.abs(Number(o[f] || 0) - Number(a[f] || 0)) < 0.02 : o[f] === a[f])) wrong++;
  }
  return { file: s.name, changes, activities: n, wrong };
}
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const desc = (iv: Iv[]) => (iv.length ? iv.map(([a, b]) => `${fmt(a)}-${fmt(b === D ? 0 : b)}`).join('+') : 'off');

if (import.meta.main) {
  const [file, ...cals] = process.argv.slice(2);
  const r = reconstruct(file, cals);
  console.log(r.file);
  for (const c of r.changes) console.log('  ' + c);
  console.log(`  rescheduled with the reconstructed calendar(s): ${r.wrong} wrong values over ${r.activities} activities`);
}
