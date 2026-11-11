// The value types of Microsoft Project XML (core/msp/values.ts): currency is hundredths of the currency unit, read and written; a file of the
// clone from before that (no format stamp) holds plain units and is read so, with one finding, and saved again in Microsoft Project's representation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { ELEMENT_TYPES, KEPT_AS_WRITTEN, currencyFromText, currencyToText, readRate, writeLag, readLag } from '../core/msp/values.ts';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { samples } from './helpers.ts';

const FILE = join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml');
const costs = (db: Db, uid: string) => { const a = rows(db, 'TASKRSRC').find((x) => x._msp_uid === uid)!; return { target: Number(a.target_cost), actual: Number(a.act_reg_cost), remaining: Number(a.remain_cost) }; };

/** A schedule with one assignment of known money: 1234.50 in all, 200 spent. */
function built(): Db {
  const db = parseXer(samples().find((s) => s.name === 'small_villa_g_1_schedule.xer')!.bytes).db;
  const t = rows(db, 'TASK').find((x) => x.task_type === 'TT_Task')!.task_code;
  const r = applyOps(db, [{ op: 'add_resource', id: 'CARP', name: 'Carpenter' }, { op: 'assign_resource', activity: t, resource: 'CARP', units_per_day: 8 }], { calendarDays: true });
  assert.equal(r.ok, true);
  const a = rows(db, 'TASKRSRC').find((x) => x.rsrc_id === rows(db, 'RSRC').find((q) => q.rsrc_short_name === 'CARP')!.rsrc_id)!;
  Object.assign(a, { target_cost: '1234.5', act_reg_cost: '200', act_ot_cost: '0', remain_cost: '1034.5' });
  return db;
}
const asgCosts = (xml: string) => ['Cost', 'ActualCost', 'RemainingCost'].map((t) => new RegExp(`<Assignment>(?:(?!</Assignment>)[\\s\\S])*?<${t}>([^<]*)</${t}>`).exec(xml)?.[1]);
const oldFile = (xml: string) => xml.replace(', format 2</Alias>', '</Alias>').replace(/<(Cost|ActualCost|RemainingCost)>([^<]*)<\/\1>/g, (_m, t, v) => `<${t}>${Number(v) / 100}</${t}>`);

test('currency codec: hundredths of the unit in and out, whatever <CurrencyDigits> says; rates and lags are their own types', () => {
  assert.equal(currencyFromText('123450'), 1234.5);
  assert.equal(currencyFromText('123450', true), 123450, 'a file of the clone from before: plain units');
  assert.equal(currencyToText(1234.5), '123450');
  assert.equal(currencyToText(0.07), '7');
  assert.equal(readRate('50'), 50, 'a rate is per hour whatever its format says');
  assert.equal(writeLag(8), '4800');
  assert.deepEqual(readLag('4800', 7), { hours: 8 });
  assert.deepEqual(readLag('50', 19), { hours: 0, percent: 50 });
});

test('the table names a type for every element the writer writes, and keeps the currency it does not touch apart', () => {
  const xml = writeMspdi(parseMspdi(readFileSync(FILE, 'utf8')).db) + writeMspdi(built());
  const known = new Set(Object.values(ELEMENT_TYPES).flatMap((t) => Object.keys(t)));
  for (const t of ['Cost', 'ActualCost', 'RemainingCost']) assert.equal(ELEMENT_TYPES.Assignment[t], 'currency');
  assert.ok(xml.includes('<Cost>'));
  for (const [entity, names] of Object.entries(KEPT_AS_WRITTEN)) for (const n of names) assert.ok(!(n in (ELEMENT_TYPES as Record<string, Record<string, string>>)[entity]), `${entity}/${n} is both converted and kept as written`);
  assert.ok(known.has('LinkLag') && known.has('StandardRate'));
});

test('a file not written by the clone (Microsoft Project, MPXJ): currency is read by the format\'s rule, hundredths, with no finding about old files', () => {
  const { db, findings } = parseMspdi(readFileSync(FILE, 'utf8'));
  assert.deepEqual(costs(db, '51'), { target: 4800, actual: 1200, remaining: 3600 });
  assert.deepEqual(costs(db, '59'), { target: 3000, actual: 0, remaining: 3000 });
  assert.ok(!findings.some((f) => f.code === 'MSP_OLD_CLONE_FILE'));
});

test('written by the clone now: currency in hundredths, a format stamp; read back, the same money and no finding', () => {
  const xml = writeMspdi(built());
  assert.ok(xml.includes(', format 2</Alias>'), 'the format revision is stamped in the rules definition');
  assert.deepEqual(asgCosts(xml), ['123450', '20000', '103450']);
  const { db, findings } = parseMspdi(xml);
  assert.ok(!findings.some((f) => f.code === 'MSP_OLD_CLONE_FILE'));
  const a = rows(db, 'TASKRSRC').find((x) => x._msp_uid && Number(x.target_cost) > 0)!;
  assert.deepEqual([Number(a.target_cost), Number(a.act_reg_cost), Number(a.remain_cost)], [1234.5, 200, 1034.5]);
});

// ---- files of the clone's OLD writer: tests/fixtures/old-clone-writer.xml is the real output of writeMspdi of the commit before the value types (eee04b2^, a git worktree
//      of it), from the sample "small_villa_g_1_schedule.xer" with a labor resource Carpenter (rate 12.5 an hour; 1234.50 in all, 200 spent), a material resource Concrete
//      (price 80.25; 401.25) and two assignments. It is the clone's own output, committed as it was written: costs in plain units (1234.5), a material's Units per hour
//      (0.625 for 70 units of the material over its duration), no format stamp.
const OLD = readFileSync(join(import.meta.dirname, 'fixtures', 'old-clone-writer.xml'), 'utf8');
const money = (db: Db) => rows(db, 'TASKRSRC').filter((x) => Number(x.target_cost) > 0).map((x) => [Number(x.target_cost), Number(x.act_reg_cost), Number(x.remain_cost)]);
const oldFindings = (x: string, opts: { converted?: boolean } = {}) => parseMspdi(x, opts).findings.filter((f) => f.code === 'MSP_OLD_CLONE_FILE');

test('the real old writer\'s file (fixture): plain units, one info line; saved again it is Microsoft Project\'s representation, the material\'s units are its quantity, and it is stamped', () => {
  assert.deepEqual(asgCosts(OLD), ['1234.5', '200', '1034.5']);
  assert.ok(!/format \d/.test(OLD) && /<Units>0\.625<\/Units>/.test(OLD), 'no stamp, and the old writer\'s per-hour material Units');
  const { db, findings } = parseMspdi(OLD);
  const f = findings.filter((x) => x.code === 'MSP_OLD_CLONE_FILE');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /earlier version of the clone.*plain units.*Saving it again writes Microsoft Project's representation/);
  assert.deepEqual(money(db), [[1234.5, 200, 1034.5], [401.25, 0, 401.25]]);
  const saved = writeMspdi(db);
  assert.deepEqual(asgCosts(saved), ['123450', '20000', '103450'], 'the kept plain elements are not carried over');
  assert.deepEqual([...saved.matchAll(/<Assignment>(?:(?!<\/Assignment>)[\s\S])*?<Units>([^<]*)<\/Units>/g)].map((m) => m[1]), ['1', '70'], 'the old writer\'s 0.625 an hour becomes the 70 units of the material');
  assert.ok(saved.includes(', format 2</Alias>'));
  const again = parseMspdi(saved);
  assert.ok(!again.findings.some((x) => x.code === 'MSP_OLD_CLONE_FILE'));
  assert.deepEqual(money(again.db), [[1234.5, 200, 1034.5], [401.25, 0, 401.25]]);
  assert.deepEqual(asgCosts(writeMspdi(again.db)), ['123450', '20000', '103450']);
});

test('A1: the plain-units rule is the old writer\'s signature and nothing else: a converted file (.mpp / MPX through MPXJ), or a file with any element a re-save adds, is read by the format\'s rule with no finding', () => {
  assert.equal(oldFindings(OLD).length, 1);
  assert.equal(oldFindings(OLD, { converted: true }).length, 0, 'what MPXJ made of an .mpp is always the format\'s representation');
  assert.deepEqual(money(parseMspdi(OLD, { converted: true }).db)[0], [12.345, 2, 10.345]);
  const no = (what: string, x: string) => { assert.equal(oldFindings(x).length, 0, what); assert.equal(money(parseMspdi(x).db)[0][0], 12.345, `${what}: read as hundredths`); };
  // each property of the signature is required: take any one away (add what a re-save adds / change what the old writer hard-codes) and the file is read by the format's rule
  no('a header element a re-save adds (CurrencyDigits)', OLD.replace('<DefaultStartTime>', '<CurrencyDigits>2</CurrencyDigits><DefaultStartTime>'));
  no('BuildNumber', OLD.replace('<SaveVersion>14</SaveVersion>', '<SaveVersion>14</SaveVersion><BuildNumber>16.0.17328.20142</BuildNumber>'));
  no('a header element of the old writer out of its order', OLD.replace('<Title>', '<StatusDate>2026-01-01T08:00:00</StatusDate><Title>'));
  no('another author', OLD.replace('<Author>Primavera P6 Clone</Author>', '<Author>Planner</Author>'));
  no('an element a re-save adds to a task (Active)', OLD.replace('<IsNull>0</IsNull>', '<IsNull>0</IsNull><Active>1</Active>'));
  no('an element a re-save adds to a resource (CanLevel)', OLD.replace('<OvertimeRateFormat>2</OvertimeRateFormat>', '<OvertimeRateFormat>2</OvertimeRateFormat><CanLevel>1</CanLevel>'));
  no('an element a re-save adds to an assignment (RateScale)', OLD.replace('<Work>PT40H0M0S</Work></Assignment>', '<Work>PT40H0M0S</Work><RateScale>0</RateScale></Assignment>'));
  no('the clone\'s own custom field definitions not first (another tool\'s field first)', OLD.replace('<ExtendedAttributes>', '<ExtendedAttributes><ExtendedAttribute><FieldID>188743767</FieldID><FieldName>Number1</FieldName><Alias>Theirs</Alias></ExtendedAttribute>'));
  // a file with the stamp is never one of the old writer's
  assert.equal(oldFindings(writeMspdi(parseMspdi(OLD).db)).length, 0);
});

test('an older file of the clone that never named the rules gets the stamp when saved again', () => {
  const x = OLD.replace(/<ExtendedAttribute><FieldID>188743746<\/FieldID>[\s\S]*?<\/ExtendedAttribute>/, '');
  assert.ok(!/Schedule Rules/.test(x));
  assert.equal(oldFindings(x).length, 1);
  const saved = writeMspdi(parseMspdi(x).db);
  assert.match(saved, /<FieldID>188743746<\/FieldID><FieldName>Text6<\/FieldName><Alias>P6 Schedule Rules [^<]*, format 2<\/Alias>/);
  assert.deepEqual(asgCosts(saved), ['123450', '20000', '103450']);
});

// ---- A4: the stamp does not depend on a free Text slot
const defs = (fids: string[], names: string[]) => fids.map((id, i) => `<ExtendedAttribute><FieldID>${id}</FieldID><FieldName>${names[i]}</FieldName><Alias>Theirs ${names[i]}</Alias></ExtendedAttribute>`).join('');
const stampOf = (xml: string) => /<ExtendedAttribute><FieldID>(\d+)<\/FieldID><FieldName>([^<]*)<\/FieldName><Alias>P6 Schedule Rules [^<]*, format 2<\/Alias>/.exec(xml)?.slice(1);
/** the old file, without its rules definition, in which the customer's own definitions use `n` of the task fields in the order the stamp looks for a free one */
async function usedUpTo(n: number): Promise<string> {
  const { taskFieldSlots } = await import('../core/msp/custom-fields.ts');
  const all = taskFieldSlots(), own = new Set(['188743731', '188743734', '188743737', '188743740', '188743743']);
  const theirs = all.filter((x) => !own.has(x.id)).slice(0, n); // (Text6 first: the clone's own rules slot)
  return OLD.replace(/<ExtendedAttribute><FieldID>188743746<\/FieldID>[\s\S]*?<\/ExtendedAttribute>/, '').replace('</ExtendedAttributes>', `${defs(theirs.map((x) => x.id), theirs.map((x) => x.name))}</ExtendedAttributes>`);
}

test('A4: the stamp stays on the clone\'s own slot when it has one; with every Text field in use it goes into the first free field of another kind (Number1, then on), is read there by its alias, and the costs read back right', async () => {
  const { taskFieldSlots } = await import('../core/msp/custom-fields.ts');
  const slots = taskFieldSlots();
  assert.equal(slots.length, 120, 'Text 30, Number 20, Cost 10, Start 10, Finish 10, Date 10, Flag 20, Duration 10');
  assert.equal(new Set(slots.map((x) => x.id)).size, 120);
  const own = await usedUpTo(0);
  const ownReport: string[] = [];
  assert.deepEqual(stampOf(writeMspdi(parseMspdi(own).db, { report: ownReport })), ['188743746', 'Text6'], 'the clone\'s own slot');
  assert.ok(!ownReport.some((n) => /format mark/.test(n)), 'on Text6, the clone\'s own slot: no note');
  // Text6..Text30 are the customer's: 25 fields; the next free in the order is Number1; after the 20 Number fields Cost1; after Cost, Start, Finish, Date and the 20 Flag fields Duration1
  for (const [n, want] of [[1, ['188743747', 'Text7']], [25, ['188743767', 'Number1']], [45, ['188743786', 'Cost1']], [105, ['188743783', 'Duration1']], [114, ['188743961', 'Duration10']]] as [number, string[]][]) {
    const x = await usedUpTo(n);
    assert.equal(oldFindings(x).length, 1, `${n} used: still the old writer's file`);
    const report: string[] = [];
    const saved = writeMspdi(parseMspdi(x).db, { report });
    assert.deepEqual(stampOf(saved), want, `${n} custom fields used: the stamp is in ${want[1]}`);
    // the mark is in a field of the customer's file other than Text6 (a Text slot, or another kind): the save says which, what it is for, and to leave it
    assert.deepEqual(report.filter((l) => /format mark/.test(l)), [`Microsoft Project field ${want[1]} holds the clone's format mark (its name starts "P6 Schedule Rules"), because Text6 is already in use in this file. It marks the file as written in the current format (format 2), so its costs are read correctly; leave ${want[1]} as it is.`]);
    assert.deepEqual(asgCosts(saved), ['123450', '20000', '103450']);
    // read back there by its alias (whatever the kind of the field), then saved again: nothing moves, nothing is added
    const back = parseMspdi(saved);
    assert.equal(back.findings.filter((f) => f.code === 'MSP_OLD_CLONE_FILE').length, 0);
    assert.deepEqual(money(back.db)[0], [1234.5, 200, 1034.5]);
    assert.equal(stampOf(writeMspdi(back.db)!)?.join(), want.join());
    assert.equal((writeMspdi(back.db).match(/P6 Schedule Rules/g) ?? []).length, 1);
  }
});

test('A4: with not one custom field of the tasks free, the save of an old writer\'s file is refused (nothing written) in the tool\'s error shape; a file that is not one of the old writer\'s is saved, and the missing stamp is named', async () => {
  const full = await usedUpTo(115);
  const parsed = parseMspdi(full);
  assert.equal(oldFindings(full).length, 1);
  let err: unknown;
  try { writeMspdi(parsed.db); } catch (e) { err = e; }
  const { MspSaveRefused } = await import('../core/msp/mspdi.ts');
  assert.ok(err instanceof MspSaveRefused, String(err));
  assert.equal(err.code, 'msp_no_free_custom_field');
  assert.equal(err.message, 'Not saved: this Microsoft Project file has no free custom field left to mark it as written in the current format (format 2), and without that mark the clone would read its costs back a hundred times too low.');
  assert.equal(err.hint, 'Free one custom field of the tasks in the file (in Microsoft Project, clear its name and values), or save the project as XER or P6 XML.');
  // through the tool: open the file, save it as Microsoft Project XML: an error with a code, the message and the hint, and no file
  const dir = mkdtempSync(join(tmpdir(), 'p6stamp-')), src = join(dir, 'full.xml'), out = join(dir, 'out.xml');
  writeFileSync(src, full);
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const h = (await call('open_file', { path: src })).d.handle;
  const r = await call('save', { handle: h, path: out, format: 'mspdi' });
  assert.equal(r.err, true);
  assert.deepEqual([r.d.error.code, r.d.error.message, r.d.error.hint], [err.code, err.message, err.hint]);
  assert.equal(existsSync(out), false, 'nothing was written');
  assert.deepEqual(readdirSync(dir).sort(), ['full.xml'], 'no temporary file left');
  // the same with BuildNumber (a file the old writer did not write as such): saved, with the stamp named as not written
  const notOld = full.replace('<SaveVersion>14</SaveVersion>', '<SaveVersion>14</SaveVersion><BuildNumber>16.0.17328.20142</BuildNumber>');
  assert.equal(oldFindings(notOld).length, 0);
  const report: string[] = [];
  const saved = writeMspdi(parseMspdi(notOld).db, { report });
  assert.ok(report.some((x) => /format stamp \(format 2\) was not written: the file has no free custom field for it/.test(x)), report.join(' | '));
  assert.equal(stampOf(saved), undefined);
});

test('a percent above 0 with no actual start is progress: the task starts at its Start (as Microsoft Project does when a percent is typed), said in a finding; the reasoner refuses the project', async () => {
  const src = readFileSync(FILE, 'utf8');
  const at = src.indexOf('<Name>Partitions</Name>'), pc = src.indexOf('<PercentComplete>0</PercentComplete>', at);
  assert.ok(at > 0 && pc > at);
  const was = '<PercentComplete>0</PercentComplete>\n\t\t\t<RemainingDuration>PT40H0M0S</RemainingDuration>';
  assert.equal(src.slice(pc, pc + was.length), was, 'the fixture\'s Partitions task: 0 %, 40 h remaining');
  const { db, findings } = parseMspdi(src.slice(0, pc) + '<PercentComplete>40</PercentComplete><RemainingDuration>PT24H0M0S</RemainingDuration>' + src.slice(pc + was.length));
  const t = rows(db, 'TASK').find((x) => x.task_name === 'Partitions')!, plain = rows(parseMspdi(src).db, 'TASK').find((x) => x.task_name === 'Partitions')!;
  assert.equal(plain.status_code, 'TK_NotStart'); assert.equal(plain.act_start_date ?? '', '');
  assert.equal(t.status_code, 'TK_Active');
  assert.match(t.act_start_date, /^2026-03-09 08:00/, 'the actual start is the task\'s Start');
  assert.ok(Math.abs(Number(t.remain_drtn_hr_cnt) - Number(t.target_drtn_hr_cnt) * 0.6) < 1e-6, `remaining is 60 % of ${t.target_drtn_hr_cnt}: ${t.remain_drtn_hr_cnt}`);
  const f = findings.filter((x) => x.code === 'MSP_PERCENT_WITHOUT_START');
  assert.equal(f.length, 1); assert.match(f[0].message, /"Partitions" is 40 % complete but has no actual start; actual start set to its start, /);
  const { reasonerRefusal } = await import('../core/analysis/whiq-fields.ts');
  assert.equal(reasonerRefusal(db, rows(db, 'PROJECT').map((p) => p.proj_id))?.code, 'schedule_in_progress');
  // a milestone with a percent and no dates is complete (no part-done milestone), with no such finding
  const hm = src.indexOf('<Name>Handover</Name>'), hp = src.indexOf('<PercentComplete>0</PercentComplete>', hm);
  const m = parseMspdi(src.slice(0, hp) + '<PercentComplete>40</PercentComplete>' + src.slice(hp + '<PercentComplete>0</PercentComplete>'.length));
  const h = rows(m.db, 'TASK').find((x) => x.task_name === 'Handover')!;
  assert.match(h.task_type, /Mile/, 'Handover is a milestone');
  assert.equal(h.status_code, 'TK_Complete');
  assert.equal(m.findings.filter((x) => x.code === 'MSP_PERCENT_WITHOUT_START').length, 0);
});
