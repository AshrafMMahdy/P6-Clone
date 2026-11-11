// MPXJ is the reference for what a Microsoft Project file means: the same library the clone reads .mpp files with (core/msp/mpp.ts), asked for its own
// reading of the file as JSON (tests/mpxj-reference.ts). The clone's reader and writer are held to it, quantity by quantity, so a value that is
// 100 times too high or in the wrong unit cannot hide behind a test that agrees with the code.
//   READ   a file -> the clone's reading of it (an .mpp through the repo's own MPXJ conversion to Microsoft Project XML) must equal MPXJ's reading
//          of the same file: costs (budget, actual, remaining), work and units, rates, durations and remaining durations, lags, total and free slack,
//          percent complete, start / finish / actual dates.
//   WRITE  a P6 project -> the clone writes Microsoft Project XML -> MPXJ reads it -> MPXJ's values must equal the P6 values.
// Skipped, with the reason, where Java or MPXJ's pinned jars are not available (the release workflow fetches the jars before its tests; see the notes
// in docs/agentic/2026-11-11-msp-custom-fields-release-notes.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { mppToMspdi } from '../core/msp/mpp.ts';
import { projectFromDb } from '../core/msp/shared.ts';
import { parseXer } from '../core/xer/parse.ts';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { mpxjRead, referenceMissing, type MpxjProject } from './mpxj-reference.ts';
import { samples } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const SAMPLE_MPPS = join(ROOT, 'Sample MPPs');
const RICH = join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml');

/** The sample .mpp files, and why each: together they carry money (52 + 243 costed assignments), work and material resources, lags, total and free slack,
 *  progress (actual dates, remaining durations, percent complete), baselines, and the two rate formats Microsoft Project writes (hour, and the material's). */
const MPPS: [file: string, why: string][] = [
  ['AIStudio App schedule.mpp', 'costs on every assignment, 9 work and 4 material resources, rate formats 2 and 8 (the case that showed costs 100x too high)'],
  ['AIStudio Residential Normal.mpp', 'costs, lags (11 links), slack'],
  ['NOT USED Chipsy tanks(16-2).mpp', 'costs, progress (75 tasks with progress), 78 lags, 169 slacks, material resources, a baseline, CurrencyDigits 0'],
  ['dabur final baseline .mpp', 'progress and 506 assignments with work, units, actual and remaining quantities'],
  ['NOT USED Dabur Architecture-22-9-2011-Crashed baseline.mpp', 'progress, 238 lags, work resources'],
  ['Bel-Egypt Schedule Rev.1.mpp', 'no resources: 135 tasks with 62 lags and 84 slacks (the schedule side alone)'],
];

// ---------- what each side holds, in the same terms

interface View {
  tasks: Map<string, { name: string; dur: number; rem: number; total: number; free: number; start: string; finish: string; as: string; af: string; pct: number }>;
  links: { key: string; lagHrs: number }[];
  resources: Map<string, { name: string; rate: number; max: number | null }>;
  assigns: Map<string, { material: boolean; cost: number; actual: number; remaining: number; work: number; actualWork: number; remainingWork: number; units: number; qty: number }>;
}
/** The clone's values of a project, by the Microsoft Project UID each task, resource and assignment has (one the file had, or the one the writer gives
 *  it). P6 fields where P6 has them. Dates: for a file read, the row's (what the clone holds of the file's Start / Finish / actuals); for a file written,
 *  the dates the writer puts in the file (projectFromDb); the percent complete is always the writer's own (P6 holds it as durations). */
function viewOf(db: Db, mode: 'read' | 'write'): View {
  const pid = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const m = projectFromDb(db, [pid]);
  const n = (s: string | undefined) => Number(s || 0);
  const v: View = { tasks: new Map(), links: [], resources: new Map(), assigns: new Map() };
  const uidOfTask = new Map<string, string>();
  for (const t of m.tasks) if (t.row && !t.summary) {
    uidOfTask.set(t.row.task_id, t.uid);
    v.tasks.set(t.uid, { name: t.name, dur: n(t.row.target_drtn_hr_cnt), rem: n(t.row.remain_drtn_hr_cnt), total: n(t.row.total_float_hr_cnt), free: n(t.row.free_float_hr_cnt), ...(mode === 'read' ? { start: t.row.target_start_date, finish: t.row.target_end_date, as: t.row.act_start_date, af: t.row.act_end_date } : { start: t.start, finish: t.finish, as: t.actualStart, af: t.actualFinish }), pct: t.pct ?? 0 });
  }
  for (const l of rows(db, 'TASKPRED').filter((x) => x.proj_id === pid)) { const s = uidOfTask.get(l.task_id), p = uidOfTask.get(l.pred_task_id); if (s && p) v.links.push({ key: `${p}->${s}`, lagHrs: n(l.lag_hr_cnt) }); }
  for (const r of m.resources) if (r.row) v.resources.set(r.uid, { name: r.name, rate: r.rate ?? 0, max: r.maxUnits });
  const kind = new Map(m.resources.map((r) => [r.uid, r.type]));
  for (const a of m.assignments) if (a.row) {
    const r = a.row;
    v.assigns.set(a.uid, {
      material: kind.get(a.resUid) === 'material', cost: n(r.act_reg_cost) + n(r.act_ot_cost) + n(r.remain_cost) || n(r.target_cost), actual: n(r.act_reg_cost) + n(r.act_ot_cost), remaining: n(r.remain_cost),
      work: n(r.act_reg_qty) + n(r.act_ot_qty) + n(r.remain_qty), actualWork: n(r.act_reg_qty) + n(r.act_ot_qty), remainingWork: n(r.remain_qty), units: n(r.target_qty_per_hr), qty: n(r.act_reg_qty) + n(r.act_ot_qty) + n(r.remain_qty),
    });
  }
  return v;
}

export interface Diff { what: string; key: string; clone: unknown; ref: unknown }
/** The precision the converted file itself carries (stated, not tolerated silently): MPXJ's XML writer rounds a duration or work to whole minutes
 *  (a 27 h 59 min 59.9 s reading in MPXJ is PT28H0M0S in the file), a slack is in tenths of a minute, a units value has 4 decimals, and a material's
 *  quantity is also the file's Work, whole seconds of an hour (a file the clone read and saved again may carry it that way). */
const PRECISION = { hours: 1 / 60 + 1e-9, slack: 1 / 600 + 1e-9, units: 5e-5 + 1e-12, quantity: 1 / 3600 + 1e-9, exact: 1e-9 };
const h = (s: number | undefined | null) => (s == null ? 0 : s / 3600);
const day = (s: string | undefined) => (s ? s.replace('T', ' ').slice(0, 16) : '');

export function compare(ref: MpxjProject, v: View, opts: { exactDurations?: boolean } = {}): { diffs: Diff[]; compared: Record<string, number> } {
  const diffs: Diff[] = [], compared: Record<string, number> = {};
  const eq = (what: string, key: string, clone: number | string, r: number | string, tol = PRECISION.exact) => {
    compared[what] = (compared[what] ?? 0) + 1;
    const same = typeof r === 'number' ? Math.abs(Number(clone) - r) <= tol * Math.max(1, tol === PRECISION.exact ? Math.abs(r) : 1) : String(clone) === r;
    if (!same) diffs.push({ what, key, clone, ref: r });
  };
  const hrs = opts.exactDurations ? PRECISION.exact : PRECISION.hours, slack = opts.exactDurations ? PRECISION.exact : PRECISION.slack, units = opts.exactDurations ? PRECISION.exact : PRECISION.units;
  const pp = ref.property_values as any;
  void pp;
  const tasks = new Map(ref.tasks.map((t) => [String(t.unique_id), t]));
  for (const [uid, t] of v.tasks) {
    const r = tasks.get(uid), k = `task ${uid} ${t.name}`;
    if (!r) { diffs.push({ what: 'task', key: k, clone: 'present', ref: 'absent' }); continue; }
    eq('task duration (h)', k, t.dur, h(r.duration), hrs);
    eq('task remaining duration (h)', k, t.rem, h(r.remaining_duration), hrs);
    eq('task total slack (h)', k, t.total, h(r.total_slack), slack);
    eq('task free slack (h)', k, t.free, h(r.free_slack), slack);
    eq('task start', k, t.start, day(r.start));
    eq('task finish', k, t.finish, day(r.finish));
    eq('task actual start', k, t.as, day(r.actual_start));
    eq('task actual finish', k, t.af, day(r.actual_finish));
    eq('task percent complete', k, t.pct, Number(r.percent_complete ?? 0));
  }
  for (const l of v.links) {
    const [p, s] = l.key.split('->');
    const link = tasks.get(s)?.predecessors?.find((q: any) => String(q.predecessor_task_unique_id) === p);
    if (!link) { diffs.push({ what: 'link', key: l.key, clone: 'present', ref: 'absent' }); continue; }
    // a percentage lag: that percentage of the predecessor's duration (MPXJ holds the percentage x 60 in its seconds)
    const refHrs = /%/.test(link.lag_units ?? '') ? (link.lag / 60 / 100) * h(tasks.get(p)?.duration) : h(link.lag);
    eq('link lag (h)', l.key, l.lagHrs, refHrs, hrs);
  }
  const resources = new Map(ref.resources.map((r) => [String(r.unique_id), r]));
  for (const [uid, r] of v.resources) {
    const m = resources.get(uid);
    if (!m) { diffs.push({ what: 'resource', key: `resource ${uid} ${r.name}`, clone: 'present', ref: 'absent' }); continue; }
    const rate = /^([\d.]+)\/(\w+)$/.exec(m.standard_rate ?? '');
    // MPXJ holds the rate in the unit of its format: per hour is the clone's (and the file's) unit
    if (rate && m.type !== 'MATERIAL') {
      const per = ({ m: 1 / 60, h: 1, d: pp.minutes_per_day / 60, w: pp.minutes_per_week / 60, mo: pp.minutes_per_month / 60, y: pp.minutes_per_year / 60 } as Record<string, number>)[rate[2]];
      eq('resource rate (per hour)', `resource ${uid} ${m.name}`, r.rate, Number(rate[1]) / per, 0.006 / per + PRECISION.exact);
    } else if (m.type !== 'MATERIAL') eq('resource rate (per hour)', `resource ${uid} ${m.name}`, r.rate, 0);
    // (a P6 resource with no max units per hour is written as 100 %: the writer's default for an unknown, named here, not compared)
    if (m.type !== 'MATERIAL' && r.max != null) eq('resource max units', `resource ${uid} ${m.name}`, r.max, (m.max_units ?? 0) / 100, units);
  }
  const asg = new Map(ref.assignments.map((a) => [String(a.unique_id), a]));
  for (const [uid, a] of v.assigns) {
    const m = asg.get(uid), k = `assignment ${uid}`;
    if (!m) { diffs.push({ what: 'assignment', key: k, clone: 'present', ref: 'absent' }); continue; }
    eq('assignment cost', k, a.cost, m.cost ?? 0, 1e-6);
    eq('assignment actual cost', k, a.actual, m.actual_cost ?? 0, 1e-6);
    eq('assignment remaining cost', k, a.remaining, m.remaining_cost ?? 0, 1e-6);
    eq('assignment work (h)', k, a.work, h(m.work), hrs);
    eq('assignment actual work (h)', k, a.actualWork, h(m.actual_work), hrs);
    eq('assignment remaining work (h)', k, a.remainingWork, h(m.remaining_work), hrs);
    // Deliberately modelled differently, by name: a material assignment's Microsoft Project units ARE its quantity (500 % = 5 units of the material);
    // the clone's units per hour are the quantity over the duration, as P6's are. So a material's quantity is compared, not its units per hour.
    if (a.material) eq('material assignment quantity', k, a.qty, (m.assignment_units ?? 0) / 100, PRECISION.quantity);
    else eq('assignment units', k, a.units, (m.assignment_units ?? 0) / 100, units);
  }
  return { diffs, compared };
}

const report = (name: string, r: { diffs: Diff[]; compared: Record<string, number> }) => {
  const by: Record<string, Diff[]> = {};
  for (const d of r.diffs) (by[d.what] ??= []).push(d);
  return `${name}: ${Object.entries(by).map(([w, l]) => `${w} x${l.length} e.g. ${JSON.stringify(l.slice(0, 2))}`).join('; ') || 'equal'}`;
};
const compared = (r: { compared: Record<string, number> }, ...what: string[]) => { for (const w of what) assert.ok((r.compared[w] ?? 0) > 0, `${w}: nothing was compared`); };

test('READ: the clone reads the sample .mpp files with the values MPXJ reads from the same files', { timeout: 900_000 }, async (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const total: Record<string, number> = {};
  for (const [f] of MPPS) {
    const path = join(SAMPLE_MPPS, f);
    const { db } = parseMspdi(await mppToMspdi(path));
    const r = compare(mpxjRead(path), viewOf(db, 'read'));
    for (const [k, n] of Object.entries(r.compared)) total[k] = (total[k] ?? 0) + n;
    assert.equal(r.diffs.length, 0, report(f, r));
  }
  for (const w of ['assignment cost', 'assignment actual cost', 'assignment remaining cost', 'assignment work (h)', 'assignment units', 'material assignment quantity', 'resource rate (per hour)', 'resource max units', 'task remaining duration (h)', 'task total slack (h)', 'task free slack (h)', 'task percent complete', 'task actual start', 'task actual finish', 'link lag (h)']) assert.ok((total[w] ?? 0) > 0, `${w}: nothing was compared in any file`);
});

test('READ: a Microsoft Project XML file (the hand-made fixture: percentage and elapsed lags, fixed costs, money in hundredths) reads as MPXJ reads it', { timeout: 120_000 }, (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const r = compare(mpxjRead(RICH), viewOf(parseMspdi(readFileSync(RICH, 'utf8')).db, 'read'), { exactDurations: true });
  assert.equal(r.diffs.length, 0, report('rich-mspdi.xml', r));
  compared(r, 'assignment cost', 'assignment actual cost', 'assignment remaining cost', 'link lag (h)');
});

const RATES = (rows5: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project"><SaveVersion>14</SaveVersion><Name>rates</Name><MinutesPerDay>360</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><DaysPerMonth>22</DaysPerMonth><CalendarUID>1</CalendarUID>
<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID></Calendar></Calendars>
<Tasks><Task><UID>1</UID><ID>1</ID><Name>T</Name><Duration>PT36H0M0S</Duration><RemainingDuration>PT36H0M0S</RemainingDuration><Start>2026-03-02T08:00:00</Start><Finish>2026-03-09T17:00:00</Finish></Task></Tasks>
<Resources>${rows5}</Resources><Assignments/></Project>`;
test('READ: a rate is per hour whatever its StandardRateFormat (minute, hour, day, week, month) in a project whose day, week and month are not the defaults', { timeout: 120_000 }, (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const res = [[1, 'perMinute', 1], [2, 'perHour', 2], [3, 'perDay', 3], [4, 'perWeek', 4], [5, 'perMonth', 5]].map(([u, n, f]) => `<Resource><UID>${u}</UID><ID>${u}</ID><Name>${n}</Name><Type>1</Type><MaxUnits>1</MaxUnits><StandardRate>60</StandardRate><StandardRateFormat>${f}</StandardRateFormat></Resource>`).join('');
  const dir = mkdtempSync(join(tmpdir(), 'p6rates-'));
  try {
    const file = join(dir, 'rates.xml');
    writeFileSync(file, RATES(res));
    const r = compare(mpxjRead(file), viewOf(parseMspdi(readFileSync(file, 'utf8')).db, 'read'), { exactDurations: true });
    assert.equal(r.diffs.length, 0, report('rates', r));
    assert.equal(r.compared['resource rate (per hour)'], 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The project MPXJ reads from what the clone wrote. */
function viaClone(db: Db): { ref: MpxjProject; xml: string } {
  const dir = mkdtempSync(join(tmpdir(), 'p6write-'));
  try {
    const xml = writeMspdi(db), file = join(dir, 'written.xml');
    writeFileSync(file, xml);
    return { ref: mpxjRead(file), xml };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const sample = (name: string) => parseXer(samples().find((s) => s.name === name)!.bytes).db;

test('WRITE: a P6 project with costs, work, material, progress, lags and slack is written, and MPXJ reads the P6 values from the file', { timeout: 300_000 }, (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const db = sample('130 TRIAL.xer');
  const { ref } = viaClone(db);
  const r = compare(ref, viewOf(db, 'write'));
  assert.equal(r.diffs.length, 0, report('130 TRIAL.xer', r));
  compared(r, 'assignment cost', 'assignment actual cost', 'assignment remaining cost', 'assignment work (h)', 'assignment units', 'material assignment quantity', 'resource rate (per hour)', 'task total slack (h)', 'task percent complete', 'task actual start', 'link lag (h)');
});

test('WRITE: money of one assignment, known by hand: 1234.50 with 200 spent is 123450 / 20000 / 103450 in the file and 1234.5 / 200 / 1034.5 for MPXJ', { timeout: 120_000 }, (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const db = sample('small_villa_g_1_schedule.xer');
  const code = rows(db, 'TASK').find((x) => x.task_type === 'TT_Task')!.task_code;
  assert.equal(applyOps(db, [{ op: 'add_resource', id: 'CARP', name: 'Carpenter' }, { op: 'assign_resource', activity: code, resource: 'CARP', units_per_day: 8 }], { calendarDays: true }).ok, true);
  const a = rows(db, 'TASKRSRC').find((x) => x.rsrc_id === rows(db, 'RSRC').find((q) => q.rsrc_short_name === 'CARP')!.rsrc_id)!;
  Object.assign(a, { target_cost: '1234.5', act_reg_cost: '200', act_ot_cost: '0', remain_cost: '1034.5' });
  const { ref } = viaClone(db);
  const m = ref.assignments.find((x) => x.cost != null)!;
  assert.deepEqual([m.cost, m.actual_cost, m.remaining_cost], [1234.5, 200, 1034.5]);
});

test('an old file of the clone (plain units, no stamp), saved again, is read by MPXJ with the right money; the same file read by the clone first says it is old', { timeout: 120_000 }, (t) => {
  const why = referenceMissing();
  if (why) return t.skip(`needs the reference (MPXJ and Java): ${why}`);
  const db = sample('130 TRIAL.xer');
  // the file as the clone wrote it before this revision: currency in plain units, no format stamp
  const old = writeMspdi(db).replace(', format 2</Alias>', '</Alias>').replace(/<(Cost|ActualCost|RemainingCost)>([^<]*)<\/\1>/g, (_x, tag, v) => `<${tag}>${Number(v) / 100}</${tag}>`);
  const opened = parseMspdi(old);
  assert.equal(opened.findings.filter((f) => f.code === 'MSP_OLD_CLONE_FILE').length, 1);
  const { ref } = viaClone(opened.db);
  const r = compare(ref, viewOf(db, 'write'));
  assert.equal(r.diffs.length, 0, report('old file saved again', r));
  compared(r, 'assignment cost');
});
