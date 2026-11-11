// P6 custom fields (user-defined fields) in Microsoft Project XML: an activity's or a resource's field is written into a free custom field
// of its kind (Text / Number / Cost / Start / Finish / Date) under its P6 name, and read back as the same P6 field; the fields that do not
// fit the format's fixed number of slots, and the subjects Microsoft Project has no custom fields for, are named in the save's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { CF_SLOTS } from '../core/msp/custom-fields.ts';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { parseXml, type XNode } from '../core/xml/p6xml.ts';
import { samples } from './helpers.ts';

const load = (name: string) => parseXer(samples().find((s) => s.name === name)!.bytes).db;
const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const FILE = join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml');

/** A schedule with activities and resources and custom fields of every kind: three activities (A, B, C), two resources. */
function built(): Db {
  const db = load('small_villa_g_1_schedule.xer');
  const t = rows(db, 'TASK').filter((x) => x.task_type === 'TT_Task').slice(0, 3).map((x) => x.task_code);
  ok(db, [
    { op: 'add_udf', name: 'Room', data_type: 'text' },
    { op: 'add_udf', name: 'Floors', data_type: 'number' },
    { op: 'add_udf', name: 'Budget', data_type: 'cost' },
    { op: 'add_udf', name: 'Inspect on', data_type: 'start_date' },
    { op: 'add_udf', name: 'Sign off by', data_type: 'finish_date' },
    { op: 'add_udf', name: 'Trade', subject: 'resource', data_type: 'text' },
    { op: 'add_udf', name: 'Hours cap', subject: 'resource', data_type: 'number' },
    { op: 'set_udf', activity: t[0], udf: 'Room', value: 'Rooms 201-210 <A&B>' },
    { op: 'set_udf', activity: t[0], udf: 'Floors', value: 2.5 },
    { op: 'set_udf', activity: t[0], udf: 'Budget', value: 1234.5 },
    { op: 'set_udf', activity: t[0], udf: 'Inspect on', value: '2026-03-02 08:00' },
    { op: 'set_udf', activity: t[0], udf: 'Sign off by', value: '2026-03-20 17:00' },
    { op: 'set_udf', activity: t[1], udf: 'Room', value: 'Lobby' },
    { op: 'add_resource', id: 'CARP', name: 'Carpenter' },
    { op: 'add_resource', id: 'MASON', name: 'Mason' },
    { op: 'assign_resource', activity: t[0], resource: 'CARP', units_per_day: 8 }, { op: 'assign_resource', activity: t[1], resource: 'MASON', units_per_day: 8 },
    { op: 'set_udf', resource: 'CARP', udf: 'Trade', value: 'Carpentry' },
    { op: 'set_udf', resource: 'CARP', udf: 'Hours cap', value: 160 },
  ]);
  return db;
}
const taskCodes = (db: Db) => rows(db, 'TASK').filter((x) => x.task_type === 'TT_Task').map((x) => x.task_code);

/** Every custom field of a subject as name -> [type, values by owner]. */
function fieldsOf(db: Db, table: 'TASK' | 'RSRC') {
  const owner = new Map((table === 'TASK' ? rows(db, 'TASK').map((t) => [t.task_id, t.task_code]) : rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name])) as [string, string][]);
  const out: Record<string, { type: string; values: Record<string, string> }> = {};
  for (const u of rows(db, 'UDFTYPE').filter((x) => x.table_name === table)) {
    const values: Record<string, string> = {};
    for (const v of rows(db, 'UDFVALUE').filter((x) => x.udf_type_id === u.udf_type_id)) values[owner.get(v.fk_id) ?? v.fk_id] = v.udf_text || v.udf_number || v.udf_date;
    out[u.udf_type_label] = { type: u.logical_data_type, values };
  }
  return out;
}
const defs = (xml: string) => parseXml(xml).children[0].children.find((c) => c.name === 'ExtendedAttributes')?.children.map((e) => [e.children.find((c) => c.name === 'FieldID')!.text, e.children.find((c) => c.name === 'FieldName')!.text, e.children.find((c) => c.name === 'Alias')?.text ?? ''] as const) ?? [];
const valuesOf = (n: XNode) => n.children.filter((c) => c.name === 'ExtendedAttribute').map((e) => [e.children[0].text, e.children[1].text] as const);
const cf = (xml: string) => defs(xml).filter((d) => !/^P6 /.test(d[2]));

test('MSPDI custom fields: each kind lands in a free custom field of its kind with its P6 name, the values in the form Microsoft Project expects', () => {
  const db = built();
  const xml = writeMspdi(db);
  const d = Object.fromEntries(cf(xml).map(([id, name, alias]) => [alias, [id, name]]));
  // FieldIDs and FieldNames of the Microsoft Project slots (Text1-6 on a task are the clone's own: the first free Text is Text7)
  assert.deepEqual(d, {
    Room: ['188743747', 'Text7'], Floors: ['188743767', 'Number1'], Budget: ['188743786', 'Cost1'], 'Inspect on': ['188743732', 'Start1'], 'Sign off by': ['188743733', 'Finish1'],
    Trade: ['205520905', 'Text2'], 'Hours cap': ['205521008', 'Number1'],
  });
  const root = parseXml(xml).children[0];
  const vals = (coll: string, name: string) => root.children.find((c) => c.name === coll)!.children.map((n) => [n.children.find((c) => c.name === 'Name')?.text, valuesOf(n)] as const).find((x) => x[0] === name)![1];
  const [a, b] = taskCodes(db).slice(0, 2).map((c) => rows(db, 'TASK').find((t) => t.task_code === c)!.task_name);
  const av = Object.fromEntries(vals('Tasks', a));
  assert.equal(av['188743747'], 'Rooms 201-210 <A&B>');
  assert.equal(av['188743767'], '2.5');
  assert.equal(av['188743786'], '123450', 'a cost field is in hundredths of the currency, as Microsoft Project has it');
  assert.equal(av['188743732'], '2026-03-02T08:00:00');
  assert.equal(av['188743733'], '2026-03-20T17:00:00');
  assert.deepEqual(vals('Tasks', b).filter((x) => x[0] === '188743747'), [['188743747', 'Lobby']]);
  assert.deepEqual(Object.fromEntries(vals('Resources', 'Carpenter')), { '205520904': 'RT_Labor', '205520905': 'Carpentry', '205521008': '160' }, 'the clone\'s own resource type field beside the P6 fields');
  assert.deepEqual(vals('Resources', 'Mason').map((x) => x[0]), ['205520904'], 'a resource without values has only the clone\'s own field');
  // the clone's own fields are still there, on the slots they always had
  assert.ok(['P6 Activity ID', 'P6 Activity Type', 'P6 Resource Type'].every((n) => defs(xml).some((x) => x[2] === n)));
  assert.equal(defs(xml).find((x) => x[2] === 'P6 Activity ID')![0], '188743731');
});

test('MSPDI custom fields: opened again they are the same P6 fields (names, types, values) and the clone\'s own fields still round-trip', () => {
  const db = built();
  const before = { task: fieldsOf(db, 'TASK'), res: fieldsOf(db, 'RSRC') };
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  assert.deepEqual(report, [], 'nothing to say when every field is carried');
  const back = parseMspdi(xml).db;
  assert.deepEqual(fieldsOf(back, 'TASK'), before.task);
  assert.deepEqual(fieldsOf(back, 'RSRC'), before.res);
  // the clone's own fields: the activity IDs, types and the resources' types are what they were
  assert.deepEqual(taskCodes(back).sort(), taskCodes(db).sort());
  assert.deepEqual(rows(back, 'RSRC').map((r) => r.rsrc_short_name).sort(), rows(db, 'RSRC').map((r) => r.rsrc_short_name).sort());
  // and the second save is the same custom fields in the same slots
  assert.deepEqual(cf(writeMspdi(back)), cf(xml));
});

test('MSPDI custom fields: the WHIQ fields (number, number, text, integer, number) round-trip, with values on some activities and none on others', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const [a, b, c] = taskCodes(db);
  ok(db, [
    { op: 'add_udf', name: 'WHIQ original duration (d)', data_type: 'number' }, { op: 'add_udf', name: 'WHIQ duration change (d)', data_type: 'number' },
    { op: 'add_udf', name: 'WHIQ change note', data_type: 'text' }, { op: 'add_udf', name: 'WHIQ leveling rank', data_type: 'integer' },
    { op: 'add_udf', name: 'WHIQ run 1 duration (d)', data_type: 'number' },
    { op: 'set_udf', activity: a, udf: 'WHIQ original duration (d)', value: 10 }, { op: 'set_udf', activity: a, udf: 'WHIQ duration change (d)', value: -4 },
    { op: 'set_udf', activity: a, udf: 'WHIQ change note', value: 'Crashed 2026-11-10: 10 d to 6 d' }, { op: 'set_udf', activity: b, udf: 'WHIQ leveling rank', value: 3 },
    { op: 'set_udf', activity: c, udf: 'WHIQ run 1 duration (d)', value: 7.25 },
  ]);
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const f = fieldsOf(parseMspdi(xml).db, 'TASK'), was = fieldsOf(db, 'TASK');
  assert.deepEqual(Object.keys(f), Object.keys(was));
  for (const k of Object.keys(was)) assert.deepEqual(f[k].values, was[k].values, k);
  assert.deepEqual(Object.keys(f['WHIQ original duration (d)'].values), [a], 'only the activity that has a value has one');
  assert.equal(f['WHIQ change note'].type, 'FT_TEXT');
  assert.equal(f['WHIQ run 1 duration (d)'].type, 'FT_FLOAT_2_DECIMALS');
  // an integer field has no Microsoft Project kind of its own: it is a Number field, and the answer says so
  assert.equal(f['WHIQ leveling rank'].type, 'FT_FLOAT_2_DECIMALS');
  assert.equal(report.length, 1);
  assert.match(report[0], /Number fields: activity "WHIQ leveling rank" \(integer fields; Microsoft Project has no integer-only custom field/);
});

test('MSPDI custom fields: indicator and code fields are written as Text and the answer says so; subjects Microsoft Project has no custom fields for are named', () => {
  const db = built();
  const [a] = taskCodes(db);
  ok(db, [
    { op: 'add_udf', name: 'Light' }, { op: 'add_udf', name: 'Proj flag', subject: 'project' }, { op: 'add_udf', name: 'Wbs note', subject: 'wbs' },
    { op: 'add_udf', name: 'Asg note', subject: 'assignment' }, { op: 'add_udf', name: 'Exp note', subject: 'expense' },
    { op: 'set_fields', table: 'UDFTYPE', where: { udf_type_label: 'Light' }, fields: { logical_data_type: 'FT_STATICTYPE' } },
    { op: 'set_udf', activity: a, udf: 'Light', value: 'UDF_G3' },
  ]);
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const text = report.join('\n');
  assert.match(text, /Text fields: activity "Light" \(indicator fields; .*UDF_G0 to UDF_G4/);
  for (const s of ['project custom fields "Proj flag" (a Microsoft Project file has no place', 'WBS custom fields "Wbs note"', 'resource assignment custom fields "Asg note"', 'activity expense custom fields "Exp note"']) assert.ok(text.includes(s), s);
  assert.ok(!xml.includes('Proj flag') && !xml.includes('Wbs note') && !xml.includes('Asg note') && !xml.includes('Exp note'));
  const back = fieldsOf(parseMspdi(xml).db, 'TASK');
  assert.equal(back.Light.type, 'FT_TEXT');
  assert.equal(Object.values(back.Light.values)[0], 'UDF_G3');
});

test('MSPDI custom fields: more fields of a kind than the format has slots: the ones that do not fit are named, the rest are intact', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const [a] = taskCodes(db);
  const slots = CF_SLOTS.Task.Number.length; // 20; none is the clone's own
  const names = Array.from({ length: slots + 3 }, (_, i) => `Num ${String(i + 1).padStart(2, '0')}`);
  ok(db, [...names.map((name) => ({ op: 'add_udf', name, data_type: 'number' })), ...names.map((name, i) => ({ op: 'set_udf', activity: a, udf: name, value: i + 1 }))]);
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const carried = cf(xml);
  assert.equal(carried.length, slots);
  assert.deepEqual(carried.map((x) => x[2]), names.slice(0, slots), 'in the order the fields were made');
  assert.equal(new Set(carried.map((x) => x[0])).size, slots, 'one field per slot');
  assert.equal(report.length, 1);
  assert.ok(report[0].includes(`activity Number fields ${names.slice(slots).map((n) => `"${n}"`).join(', ')} (Microsoft Project has ${slots} Number custom fields on a task: ${slots} carry P6 custom fields here and 0 are in use`), report[0]);
  const back = fieldsOf(parseMspdi(xml).db, 'TASK');
  assert.deepEqual(Object.keys(back), names.slice(0, slots));
  for (const [i, n] of names.slice(0, slots).entries()) assert.deepEqual(back[n].values, { [a]: String(i + 1) });
  // text: the clone's own Text1-6 are not for sale: 30 - 6 = 24 fit
  const t = load('small_villa_g_1_schedule.xer');
  const tn = Array.from({ length: 26 }, (_, i) => `Txt ${i + 1}`);
  ok(t, tn.map((name) => ({ op: 'add_udf', name })));
  const r2: string[] = [];
  const x2 = writeMspdi(t, { report: r2 });
  assert.equal(cf(x2).length, CF_SLOTS.Task.Text.length - 6);
  assert.ok(r2[0].includes('"Txt 25", "Txt 26"') && r2[0].includes('6 are in use by the clone\'s own fields'), r2[0]);
});

test('MSPDI custom fields: the slots are deterministic and stable across save, open, save, also when fields are added later', () => {
  const db = built();
  const one = cf(writeMspdi(db));
  assert.deepEqual(cf(writeMspdi(db)), one, 'same input, same slots');
  const back = parseMspdi(writeMspdi(db)).db;
  assert.deepEqual(cf(writeMspdi(back)), one, 'a field keeps its slot through save, open, save');
  // a field added to the opened file takes a free slot after the others; the earlier ones stay where they were
  ok(back, [{ op: 'add_udf', name: 'Late text' }, { op: 'add_udf', name: 'Late number', data_type: 'number' }]);
  const two = cf(writeMspdi(back));
  assert.deepEqual(two.slice(0, one.length), one);
  assert.deepEqual(two.filter((x) => !one.some((o) => o[0] === x[0])).map((x) => [x[2], x[1]]), [['Late text', 'Text8'], ['Late number', 'Number2']]);
  // deleting a field drops its definition and its values; the others keep their slots
  ok(back, [{ op: 'delete_udf', udf: 'Floors' }]);
  const three = writeMspdi(back);
  assert.ok(!three.includes('<Alias>Floors</Alias>') && !three.includes('<Value>2.5</Value>'));
  assert.deepEqual(cf(three).map((x) => x[2]).sort(), two.map((x) => x[2]).filter((n) => n !== 'Floors').sort());
  assert.equal(cf(three).find((x) => x[2] === 'Budget')![0], '188743786');
  // a rename is a rename of the alias
  ok(back, [{ op: 'update_udf', udf: 'Room', new_name: 'Room no.' }]);
  assert.ok(writeMspdi(back).includes('<Alias>Room no.</Alias>') && !writeMspdi(back).includes('<Alias>Room</Alias>'));
});

test('MSPDI custom fields: a customer\'s own file keeps its custom fields exactly once, saved in place; new fields take slots the file does not use', () => {
  const src = readFileSync(FILE, 'utf8');
  const { db, findings } = parseMspdi(src);
  assert.ok(!findings.some((f) => f.code === 'MSP_CUSTOM_FIELD_KIND'));
  // read: the aliased fields are P6 fields of the matching type, on the activities and resources that hold values
  const t = fieldsOf(db, 'TASK'), r = fieldsOf(db, 'RSRC');
  assert.deepEqual(Object.keys(t).sort(), ['Room', 'Rooms Affected']);
  assert.equal(t.Room.type, 'FT_TEXT');
  assert.equal(t['Rooms Affected'].type, 'FT_FLOAT_2_DECIMALS');
  assert.deepEqual(Object.values(t.Room.values).sort(), ['Rooms 201-206', 'Rooms 201-210']);
  assert.deepEqual(Object.values(t['Rooms Affected'].values), ['10']);
  assert.deepEqual(Object.values(r.Trade.values), ['Carpentry']);
  // saved untouched: the file's elements once each, nothing twice
  const out = writeMspdi(db);
  assert.equal((out.match(/<Value>Rooms 201-210<\/Value>/g) ?? []).length, 1);
  assert.equal((out.match(/<Alias>Room<\/Alias>/g) ?? []).length, 1);
  assert.equal((out.match(/<Alias>Trade<\/Alias>/g) ?? []).length, 1);
  assert.equal(out.includes('P6 Activity ID'), false, 'the clone\'s own fields are not written into a customer\'s Text1');
  // an edit of one value rewrites that field's value on that activity, once; a new field takes a slot the file does not use
  const code = Object.keys(t.Room.values)[0];
  ok(db, [{ op: 'set_udf', activity: code, udf: 'Room', value: 'Rooms 1-2' }, { op: 'add_udf', name: 'Zone' }, { op: 'set_udf', activity: code, udf: 'Zone', value: 'North' }, { op: 'add_udf', name: 'Gang', subject: 'resource' }]);
  const out2 = writeMspdi(db);
  assert.equal((out2.match(/<Value>Rooms 1-2<\/Value>/g) ?? []).length, 1);
  assert.equal(out2.includes('<Value>Rooms 201-210</Value>'), false);
  assert.equal((out2.match(/<FieldID>188743731<\/FieldID><Value>/g) ?? []).length, 2, 'the file\'s Room is still on its Text1 of the two activities');
  const d = defs(out2);
  assert.deepEqual(d.filter((x) => x[2] === 'Zone' || x[2] === 'Gang').map((x) => [x[2], x[1]]), [['Zone', 'Text2'], ['Gang', 'Text2']], 'Text1 is the file\'s own; the next one is free');
  assert.deepEqual(d.slice(0, 3).map((x) => x[2]), ['Room', 'Rooms Affected', 'Trade'], 'the file\'s definitions first, as they were');
  // read again: the same fields
  const again = parseMspdi(out2).db;
  assert.deepEqual(Object.keys(fieldsOf(again, 'TASK')).sort(), ['Room', 'Rooms Affected', 'Zone']);
  assert.deepEqual(Object.keys(fieldsOf(again, 'RSRC')).sort(), ['Gang', 'Trade']);
  assert.deepEqual(cf(writeMspdi(again)), cf(out2));
  // deleting one of the file's fields takes its definition and values out of the file
  ok(db, [{ op: 'delete_udf', udf: 'Rooms Affected' }]);
  const out3 = writeMspdi(db);
  assert.ok(!out3.includes('<Alias>Rooms Affected</Alias>') && !out3.includes('<FieldID>188743767</FieldID><Value>'));
});

test('MSPDI custom fields: a field without an alias is read under its Microsoft Project name when it has a value; flag and duration fields stay in the file and are named', () => {
  const src = readFileSync(FILE, 'utf8').replace('</ExtendedAttributes>', '<ExtendedAttribute><FieldID>188743753</FieldID><FieldName>Flag2</FieldName><Alias>Cleared</Alias></ExtendedAttribute></ExtendedAttributes>')
    .replace(/(<UID>155<\/UID>[\s\S]*?)(<ExtendedAttribute><FieldID>188743731)/, '$1<ExtendedAttribute><FieldID>188743748</FieldID><Value>No alias here</Value></ExtendedAttribute><ExtendedAttribute><FieldID>188743753</FieldID><Value>1</Value></ExtendedAttribute>$2');
  const { db, findings } = parseMspdi(src);
  const t = fieldsOf(db, 'TASK');
  assert.deepEqual(Object.values(t.Text8.values), ['No alias here'], 'Text8 has no alias in the file: it is read under its name, since it has a value');
  assert.ok(!('Cleared' in t));
  assert.match(findings.find((f) => f.code === 'MSP_CUSTOM_FIELD_KIND')!.message, /Cleared \(Flag2\)/);
  const out = writeMspdi(db);
  assert.equal((out.match(/<Value>No alias here<\/Value>/g) ?? []).length, 1);
  assert.equal((out.match(/<FieldID>188743753<\/FieldID><Value>1<\/Value>/g) ?? []).length, 1, 'the flag value goes back as it was');
  assert.equal((out.match(/<Alias>Cleared<\/Alias>/g) ?? []).length, 1);
  assert.equal(out.includes('<Alias>Text8</Alias>'), false, 'no definition is made up for a field the file did not define');
  // a new field never takes a slot that has values in the file, defined or not
  ok(db, [{ op: 'add_udf', name: 'Fresh' }]);
  assert.equal(defs(writeMspdi(db)).find((x) => x[2] === 'Fresh')![1], 'Text2');
});
