// MPXJ is the reference for what a Microsoft Project file means: the same library the clone reads .mpp files with (core/msp/mpp.ts), asked for its own
// reading of the file as JSON (tests/mpxj-reference.ts). The clone's reader and writer are held to it, quantity by quantity, so a value that is
// 100 times too high or in the wrong unit cannot hide behind a test that agrees with the code.
//   READ   a file -> the clone's reading of it (an .mpp through the repo's own MPXJ conversion to Microsoft Project XML) must equal MPXJ's reading
//          of the same file: costs (budget, actual, remaining), work and units, rates, durations and remaining durations, lags, total and free slack,
//          percent complete, start / finish / actual dates.
//   WRITE  a P6 project -> the clone writes Microsoft Project XML -> MPXJ reads it -> MPXJ's values must equal the P6 values.
// Skipped, with the reason, where Java or MPXJ's pinned jars are not available, unless P6CLONE_REQUIRE_REFERENCE=1: then the skip is a failure with the same
// message (the release workflow sets it, after fetching the jars and installing Java, so the reference check cannot be skipped there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { mppToMspdi } from '../core/msp/mpp.ts';
import { parseXer } from '../core/xer/parse.ts';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { mpxjRead, mpxjResave, skipWithoutReference, type MpxjProject } from './mpxj-reference.ts';
import { compare, compared, report, viewOf } from './mpxj-compare.ts';
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

test('READ: the clone reads the sample .mpp files with the values MPXJ reads from the same files', { timeout: 900_000 }, async (t) => {
  if (skipWithoutReference(t)) return;
  const total: Record<string, number> = {};
  for (const [f] of MPPS) {
    const path = join(SAMPLE_MPPS, f);
    const xml = await mppToMspdi(path), { db, findings } = parseMspdi(xml, { converted: true });
    // an .mpp is never one of the clone's old files, with the conversion's flag or by its own bytes (MPXJ's writer adds what the old writer never wrote)
    assert.equal(findings.filter((x) => x.code === 'MSP_OLD_CLONE_FILE').length, 0, f);
    assert.equal(parseMspdi(xml).findings.filter((x) => x.code === 'MSP_OLD_CLONE_FILE').length, 0, `${f}: also without the flag`);
    const r = compare(mpxjRead(path), viewOf(db, 'read'));
    for (const [k, n] of Object.entries(r.compared)) total[k] = (total[k] ?? 0) + n;
    assert.equal(r.diffs.length, 0, report(f, r));
  }
  for (const w of ['assignment cost', 'assignment actual cost', 'assignment remaining cost', 'assignment work (h)', 'assignment units', 'material assignment quantity', 'resource rate (per hour)', 'resource max units', 'task remaining duration (h)', 'task total slack (h)', 'task free slack (h)', 'task percent complete', 'task actual start', 'task actual finish', 'link lag (h)', 'baseline start', 'baseline finish', 'baseline duration (h)']) assert.ok((total[w] ?? 0) > 0, `${w}: nothing was compared in any file`);
});

test('READ: a Microsoft Project XML file (the hand-made fixture: percentage and elapsed lags, fixed costs, money in hundredths) reads as MPXJ reads it', { timeout: 120_000 }, (t) => {
  if (skipWithoutReference(t)) return;
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
  if (skipWithoutReference(t)) return;
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
  if (skipWithoutReference(t)) return;
  const db = sample('130 TRIAL.xer');
  const { ref } = viaClone(db);
  const r = compare(ref, viewOf(db, 'write'));
  assert.equal(r.diffs.length, 0, report('130 TRIAL.xer', r));
  compared(r, 'assignment cost', 'assignment actual cost', 'assignment remaining cost', 'assignment work (h)', 'assignment units', 'material assignment quantity', 'resource rate (per hour)', 'task total slack (h)', 'task percent complete', 'task actual start', 'link lag (h)');
});

test('WRITE: money of one assignment, known by hand: 1234.50 with 200 spent is 123450 / 20000 / 103450 in the file and 1234.5 / 200 / 1034.5 for MPXJ', { timeout: 120_000 }, (t) => {
  if (skipWithoutReference(t)) return;
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
  if (skipWithoutReference(t)) return;
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

test('READ: custom Number and Cost fields of tasks (a hand-written file: amounts with fractions of a hundredth, a negative, a large one) read as MPXJ reads them', { timeout: 120_000 }, (t) => {
  if (skipWithoutReference(t)) return;
  // (own text: the values of a Cost custom field are hundredths, a Number field's are plain)
  // (amounts with at most 2 decimals of a hundredth and numbers with at most 4 decimals: MPXJ itself reads no more than that)
  const costs = ['1234.5', '0.4', '100000000000', '-550', '1234.56', '12'], numbers = ['1.5', '0.0001', '123456.789', '-7', '3', '2.25'];
  const task = (i: number) => `<Task><UID>${i + 1}</UID><ID>${i + 1}</ID><Name>T${i + 1}</Name><Duration>PT8H0M0S</Duration><RemainingDuration>PT8H0M0S</RemainingDuration><Start>2026-03-02T08:00:00</Start><Finish>2026-03-02T17:00:00</Finish><ExtendedAttribute><FieldID>188743786</FieldID><Value>${costs[i]}</Value></ExtendedAttribute><ExtendedAttribute><FieldID>188743767</FieldID><Value>${numbers[i]}</Value></ExtendedAttribute></Task>`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project"><SaveVersion>14</SaveVersion><Name>cf</Name><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><CalendarUID>1</CalendarUID>
<ExtendedAttributes><ExtendedAttribute><FieldID>188743786</FieldID><FieldName>Cost1</FieldName><Alias>Budget</Alias></ExtendedAttribute><ExtendedAttribute><FieldID>188743767</FieldID><FieldName>Number1</FieldName><Alias>Weight</Alias></ExtendedAttribute></ExtendedAttributes>
<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID></Calendar></Calendars>
<Tasks>${costs.map((_c, i) => task(i)).join('')}</Tasks><Resources/><Assignments/></Project>`;
  const dir = mkdtempSync(join(tmpdir(), 'p6cf-'));
  try {
    const file = join(dir, 'cf.xml');
    writeFileSync(file, xml);
    const r = compare(mpxjRead(file), viewOf(parseMspdi(xml).db, 'read'), { exactDurations: true });
    assert.equal(r.diffs.length, 0, report('custom fields', r));
    assert.equal(r.compared['custom cost field'], 6);
    assert.equal(r.compared['custom number field'], 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WRITE: money text is the reference\'s: an assignment\'s costs and a custom Cost field\'s values are written with the text MPXJ writes for the same values (12.345, 0.004, 1e9, a negative, fractions of a hundredth), and a Number field as stored', { timeout: 300_000 }, (t) => {
  if (skipWithoutReference(t)) return;
  const amounts = [12.345, 0.004, 1e9, -5.5, 1.2345678, 0.0049, 7.12345, 0.03125, 2992.64789, 0.1, 1234.5, 99999999.99995];
  const numbers = ['2.123456789', '0.0000001', '1e3', '-0', '123456789.987654321', '7', '0.1', '5.00', '1.5e-7', '42', '3.14159', '0.30000000000000004'];
  const db = sample('small_villa_g_1_schedule.xer');
  const tasks = rows(db, 'TASK').filter((x) => x.task_type === 'TT_Task').slice(0, amounts.length);
  assert.equal(tasks.length, amounts.length);
  const ops: unknown[] = [{ op: 'add_resource', id: 'CARP', name: 'Carpenter' }, { op: 'add_udf', name: 'Budget', subject: 'activity', data_type: 'cost' }, { op: 'add_udf', name: 'Weight', subject: 'activity', data_type: 'number' }];
  tasks.forEach((x, i) => ops.push({ op: 'assign_resource', activity: x.task_code, resource: 'CARP', units_per_day: 8 }, { op: 'set_udf', udf: 'Budget', activity: x.task_code, value: amounts[i] }, { op: 'set_udf', udf: 'Weight', activity: x.task_code, value: numbers[i] }));
  assert.equal(applyOps(db, ops as never, { calendarDays: true }).ok, true);
  const carp = rows(db, 'RSRC').find((q) => q.rsrc_short_name === 'CARP')!.rsrc_id;
  tasks.forEach((x, i) => { const a = rows(db, 'TASKRSRC').find((q) => q.task_id === x.task_id && q.rsrc_id === carp)!; Object.assign(a, { target_cost: String(amounts[i]), act_reg_cost: '0', act_ot_cost: '0', remain_cost: String(amounts[i]) }); });
  const dir = mkdtempSync(join(tmpdir(), 'p6money-'));
  try {
    const file = join(dir, 'money.xml'), mine = writeMspdi(db);
    writeFileSync(file, mine);
    const theirs = mpxjResave(file); // the reference writing the same file again: what MPXJ prints for each value
    const texts = (xml: string) => ({
      asg: [...xml.matchAll(/<Assignment>([\s\S]*?)<\/Assignment>/g)].map((m) => /<Cost>([^<]*)<\/Cost>/.exec(m[1])?.[1]),
      cost: [...xml.matchAll(/<Task>([\s\S]*?)<\/Task>/g)].map((m) => /<FieldID>188743786<\/FieldID>\s*<Value>([^<]*)<\/Value>/.exec(m[1])?.[1]),
      num: [...xml.matchAll(/<Task>([\s\S]*?)<\/Task>/g)].map((m) => /<FieldID>188743767<\/FieldID>\s*<Value>([^<]*)<\/Value>/.exec(m[1])?.[1]),
    });
    const a = texts(mine), b = texts(theirs);
    const asgOf = (x: (string | undefined)[]) => x.filter((v) => v !== undefined);
    assert.deepEqual(asgOf(a.asg), asgOf(b.asg), 'assignment costs: the same text as the reference');
    assert.deepEqual(a.cost.filter(Boolean), b.cost.filter(Boolean), 'custom Cost values: the same text as the reference');
    assert.equal(a.cost.filter(Boolean).length, amounts.length);
    // a Number field is written as it is stored (the reference normalises its own text; the clone does not round what it was given)
    const stored = tasks.map((x) => rows(db, 'UDFVALUE').find((q) => q.fk_id === x.task_id && q.udf_type_id === rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Weight')!.udf_type_id)!.udf_number);
    assert.deepEqual(a.num.filter(Boolean).sort(), [...stored].sort(), 'Number custom values: as stored in the project (the edit that set them keeps up to 6 decimals; the writer adds no rounding of its own)');
    assert.ok(stored.some((x) => /\.\d{4,}/.test(x)), `a value with more than 3 decimals is among them: ${stored.join(' ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A1: the same old-writer file after a re-save through MPXJ (no BuildNumber, the clone aliases kept) is Microsoft Project\'s representation: format rule, no finding, the reference\'s values', { timeout: 120_000 }, (t) => {
  if (skipWithoutReference(t)) return;
  const old = readFileSync(join(import.meta.dirname, 'fixtures', 'old-clone-writer.xml'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'p6old-'));
  try {
    const file = join(dir, 'old.xml'), again = join(dir, 'resaved.xml');
    writeFileSync(file, old);
    const via = mpxjResave(file);
    writeFileSync(again, via);
    // the premise: MPXJ's writer never writes BuildNumber and keeps the aliases of the clone's custom fields
    assert.ok(!/<BuildNumber>/.test(via) && /P6 Activity ID/.test(via) && /P6 Schedule Rules/.test(via));
    const opened = parseMspdi(via);
    assert.equal(opened.findings.filter((f) => f.code === 'MSP_OLD_CLONE_FILE').length, 0, 'not read as the old writer\'s');
    // read by the format's rule: the same amounts as MPXJ reads from that file
    const r = compare(mpxjRead(again), viewOf(opened.db, 'read'), { exactDurations: true });
    // (the old writer's material Units are per hour, which Microsoft Project / MPXJ read as a percentage: the material's quantity is the one value the format rule reads differently from
    //  an old file; it is the Work of the assignment, 70 units here, and the re-save keeps the Units the old writer wrote)
    r.diffs = r.diffs.filter((d) => d.what !== 'material assignment quantity');
    assert.equal(r.diffs.length, 0, report('old file re-saved by MPXJ', r));
    compared(r, 'assignment cost');
    assert.equal(mpxjRead(again).assignments.find((x) => x.cost)!.cost, 12.345);
    // and saved in place by the clone, its costs are not multiplied again
    const saved = writeMspdi(opened.db);
    assert.deepEqual([...saved.matchAll(/<Assignment>(?:(?!<\/Assignment>)[\s\S])*?<Cost>([^<]*)<\/Cost>/g)].map((m) => m[1]), [...via.matchAll(/<Assignment>(?:(?!<\/Assignment>)[\s\S])*?<Cost>([^<]*)<\/Cost>/g)].map((m) => m[1]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the server reads an .mpp as a conversion (parseMspdi\'s converted flag), so no .mpp is ever read as one of the old writer\'s files', () => {
  assert.match(readFileSync(join(ROOT, 'mcp', 'server.ts'), 'utf8'), /parseMspdi\(xml, \{ converted: true \}\)/);
  assert.match(readFileSync(join(ROOT, 'renderer', 'io.ts'), 'utf8'), /parseFile\(name, xml, 'mspdi', undefined, true\)/);
});
