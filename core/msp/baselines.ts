// Microsoft Project's baselines (Baseline, Baseline1-10) and the clone's saved baselines. Reading: each baseline number
// in the file becomes a saved baseline (a copy of the project with that baseline's dates): Baseline is assigned as the
// project baseline, Baseline1-3 as BL1-BL3, the rest are saved by name (P6 keeps any number). Writing: the project
// baseline is Baseline, BL1-BL3 are Baseline1-3, other saved baselines take Baseline4-10 in the order they were saved.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { assignBaseline, saveBaseline } from '../progress/baseline.ts';
import { p6num } from '../schedule/cpm.ts';

const day = (s: string) => s.replace('T', ' ').slice(0, 16);

export type FoundBaselines = Map<number, Map<string, { start: string; finish: string; hours: number | null }>>;
/** The baselines of one task's XML (the inside of its <Task>), added to out. */
export function scanTaskBaselines(task: string, out: FoundBaselines): void {
  const uid = /<UID>\s*(\d+)\s*<\/UID>/.exec(task)?.[1];
  if (!uid || uid === '0') return;
  for (const b of task.matchAll(/<Baseline>([\s\S]*?)<\/Baseline>/g)) {
    const n = Number(/<Number>\s*(\d+)\s*<\/Number>/.exec(b[1])?.[1]);
    const start = /<Start>([^<]+)<\/Start>/.exec(b[1])?.[1], finish = /<Finish>([^<]+)<\/Finish>/.exec(b[1])?.[1];
    if (!Number.isFinite(n) || !start || !finish) continue;
    const dur = /<Duration>PT(\d+)H(\d+)M/.exec(b[1]);
    (out.get(n) ?? out.set(n, new Map()).get(n)!).set(uid, { start: day(start), finish: day(finish), hours: dur ? Number(dur[1]) + Number(dur[2]) / 60 : null });
  }
}
/** Baselines found in an MSPDI text, by number: task UID -> {start, finish, hours}. */
export function scanMspBaselines(xml: string, minutesPerDay = 480): FoundBaselines {
  const out: FoundBaselines = new Map();
  const tasks = /<Tasks>([\s\S]*?)<\/Tasks>/.exec(xml)?.[1] ?? '';
  for (const t of tasks.matchAll(/<Task>([\s\S]*?)<\/Task>/g)) scanTaskBaselines(t[1], out);
  void minutesPerDay;
  return out;
}

/** Save each baseline of the file as a baseline copy of the project and assign Baseline / Baseline1-3. */
export function importMspBaselines(db: Db, xml: string | FoundBaselines): string[] {
  const found = typeof xml === 'string' ? scanMspBaselines(xml) : xml; // (a document read in pieces: the reader collected them task by task)
  if (!found.size) return [];
  const proj = rows(db, 'PROJECT').find((p) => !p._baseline_of);
  if (!proj) return [];
  const byUid = new Map(rows(db, 'TASK').filter((t) => t.proj_id === proj.proj_id && t._msp_uid).map((t) => [t._msp_uid, t.task_code]));
  const names: string[] = [];
  for (const n of [...found.keys()].sort((a, b) => a - b)) {
    const name = `${proj.proj_short_name} - ${n === 0 ? 'Baseline' : `Baseline${n}`}`;
    const bid = saveBaseline(db, proj.proj_id, name);
    const copy = new Map(rows(db, 'TASK').filter((t) => t.proj_id === bid).map((t) => [t.task_code, t]));
    for (const [uid, v] of found.get(n)!) {
      const t = copy.get(byUid.get(uid) ?? '');
      if (!t) continue;
      // the baseline is the plan as it was then: its dates, its duration, no progress
      t.target_start_date = t.early_start_date = t.restart_date = v.start;
      t.target_end_date = t.early_end_date = t.reend_date = v.finish;
      t.act_start_date = t.act_end_date = '';
      t.status_code = 'TK_NotStart';
      t.phys_complete_pct = '0';
      if (v.hours != null) t.target_drtn_hr_cnt = t.remain_drtn_hr_cnt = p6num(v.hours);
    }
    if (n === 0) assignBaseline(db, proj.proj_id, bid);
    else if (n <= 3) { addField(table(db, 'PROJECT'), `_bl${n}`); proj[`_bl${n}`] = bid; }
    names.push(name);
  }
  return names;
}

/** The <Baseline> elements of a task for the clone's saved baselines (numbers as described above). */
export function baselineNumbers(db: Db, proj: Row): Map<number, string> {
  const out = new Map<number, string>();
  if (proj.sum_base_proj_id && proj.sum_base_proj_id !== proj.proj_id) out.set(0, proj.sum_base_proj_id);
  for (const k of [1, 2, 3]) if (proj[`_bl${k}`]) out.set(k, proj[`_bl${k}`]);
  const used = new Set(out.values());
  let next = 4;
  for (const b of rows(db, 'PROJECT').filter((p) => p._baseline_of === proj.proj_id && !used.has(p.proj_id)).sort((a, b) => (a._baseline_date ?? '').localeCompare(b._baseline_date ?? ''))) { if (next > 10) break; out.set(next++, b.proj_id); }
  return out;
}

export function baselineXml(db: Db, numbers: Map<number, string>, task: Row, iso: (s: string) => string): string[] {
  const out: string[] = [];
  for (const [n, bid] of [...numbers].sort((a, b) => a[0] - b[0])) {
    const b = rows(db, 'TASK').find((t) => t.proj_id === bid && t.task_code === task.task_code);
    if (!b) continue;
    const s = b.target_start_date || b.early_start_date, f = b.target_end_date || b.early_end_date;
    if (!s || !f) continue;
    const h = Number(b.target_drtn_hr_cnt || 0);
    out.push(`<Baseline><Number>${n}</Number><Start>${iso(s)}</Start><Finish>${iso(f)}</Finish><Duration>PT${Math.floor(h)}H${Math.round((h % 1) * 60)}M0S</Duration><DurationFormat>7</DurationFormat><EstimatedDuration>0</EstimatedDuration></Baseline>`);
  }
  return out;
}
