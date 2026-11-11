// The value types of Microsoft Project XML (core/msp/values.ts): currency is hundredths of the currency unit, read and written; a file of the
// clone from before that (no format stamp) holds plain units and is read so, with one finding, and saved again in Microsoft Project's representation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a file the clone wrote before the stamp: plain units, read so with one info line; saved again it is Microsoft Project\'s representation and stamped', () => {
  const old = oldFile(writeMspdi(built()));
  assert.deepEqual(asgCosts(old), ['1234.5', '200', '1034.5']);
  const { db, findings } = parseMspdi(old);
  const f = findings.filter((x) => x.code === 'MSP_OLD_CLONE_FILE');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /earlier version of the clone.*plain units.*Saving it again writes Microsoft Project's representation/);
  const a = rows(db, 'TASKRSRC').find((x) => Number(x.target_cost) > 0)!;
  assert.deepEqual([Number(a.target_cost), Number(a.act_reg_cost), Number(a.remain_cost)], [1234.5, 200, 1034.5]);
  const saved = writeMspdi(db);
  assert.deepEqual(asgCosts(saved), ['123450', '20000', '103450'], 'the kept plain elements are not carried over');
  assert.ok(saved.includes(', format 2</Alias>'));
  const again = parseMspdi(saved);
  assert.ok(!again.findings.some((x) => x.code === 'MSP_OLD_CLONE_FILE'));
  assert.deepEqual(asgCosts(writeMspdi(again.db)), ['123450', '20000', '103450']);
});

test('an old file of the clone that Microsoft Project saved since (it has a BuildNumber) holds hundredths: read by the format\'s rule', () => {
  const x = writeMspdi(built()).replace(', format 2</Alias>', '</Alias>').replace('<SaveVersion>14</SaveVersion>', '<SaveVersion>14</SaveVersion><BuildNumber>16.0.17328.20142</BuildNumber>');
  const { db, findings } = parseMspdi(x);
  assert.ok(!findings.some((f) => f.code === 'MSP_OLD_CLONE_FILE'));
  const a = rows(db, 'TASKRSRC').find((q) => Number(q.target_cost) > 0)!;
  assert.equal(Number(a.target_cost), 1234.5);
});

test('an older file of the clone that never named the rules gets the stamp when saved again', () => {
  const x = oldFile(writeMspdi(built())).replace(/<ExtendedAttribute><FieldID>188743746<\/FieldID>[\s\S]*?<\/ExtendedAttribute>/, '');
  assert.ok(!/Schedule Rules/.test(x));
  const saved = writeMspdi(parseMspdi(x).db);
  assert.match(saved, /<FieldID>188743746<\/FieldID><FieldName>Text6<\/FieldName><Alias>P6 Schedule Rules [^<]*, format 2<\/Alias>/);
  assert.deepEqual(asgCosts(saved), ['123450', '20000', '103450']);
});
