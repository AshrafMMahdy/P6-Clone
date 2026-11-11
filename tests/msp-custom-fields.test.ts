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
import { rows, table, type Db } from '../core/db.ts';
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
  const [late] = taskCodes(back); // (a field with no value is not added to an opened file: these two have one)
  ok(back, [{ op: 'add_udf', name: 'Late text' }, { op: 'add_udf', name: 'Late number', data_type: 'number' }, { op: 'set_udf', activity: late, udf: 'Late text', value: 'x' }, { op: 'set_udf', activity: late, udf: 'Late number', value: 3 }]);
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
  ok(db, [{ op: 'set_udf', activity: code, udf: 'Room', value: 'Rooms 1-2' }, { op: 'add_udf', name: 'Zone' }, { op: 'set_udf', activity: code, udf: 'Zone', value: 'North' }, { op: 'add_udf', name: 'Gang', subject: 'resource' }, { op: 'set_udf', resource: Object.keys(r.Trade.values)[0], udf: 'Gang', value: 'Crew 1' }]);
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
  ok(db, [{ op: 'add_udf', name: 'Fresh' }, { op: 'set_udf', activity: Object.keys(t.Room.values)[0], udf: 'Fresh', value: 'v' }]);
  assert.equal(defs(writeMspdi(db)).find((x) => x[2] === 'Fresh')![1], 'Text2');
});

// ---------- review round: H1, M2-M5, L6-L8

const lookupFile = () => readFileSync(FILE, 'utf8')
  .replace('<Alias>Room</Alias>', '<Alias>Room</Alias><ValueList><Value><ID>1</ID><Value>Rooms 201-210</Value><FieldGUID>G</FieldGUID></Value></ValueList><LookupUid>X</LookupUid>')
  .replace('<ExtendedAttribute><FieldID>188743731</FieldID><Value>Rooms 201-210</Value></ExtendedAttribute>', '<ExtendedAttribute><FieldID>188743731</FieldID><Value>Rooms 201-210</Value><ValueGUID>AAAA-1</ValueGUID></ExtendedAttribute>');

test('H1: the WHIQ leveling rank field, an integer field in the XER, comes back from Microsoft Project as a number field and the apply still writes ranks', async () => {
  const { whiqFieldClash, writeWhiqFields } = await import('../core/analysis/whiq-fields.ts');
  const db = load('small_villa_g_1_schedule.xer');
  const [a, b] = taskCodes(db);
  ok(db, [{ op: 'add_udf', name: 'WHIQ leveling rank', data_type: 'integer' }, { op: 'set_udf', activity: a, udf: 'WHIQ leveling rank', value: 1 }]);
  assert.equal(whiqFieldClash(db, { changes: [], ranks: [1] }), undefined, 'the integer field itself is fine');
  const back = parseMspdi(writeMspdi(db)).db;
  assert.equal(fieldsOf(back, 'TASK')['WHIQ leveling rank'].type, 'FT_FLOAT_2_DECIMALS');
  assert.equal(whiqFieldClash(back, { changes: [], ranks: [1] }), undefined, 'a number field holds a whole-number rank');
  const proj = rows(back, 'PROJECT')[0].proj_short_name;
  const task = (code: string) => rows(back, 'TASK').find((t) => t.task_code === code)!.task_id;
  const w = writeWhiqFields(back, { changes: [], ranks: [{ task_id: task(a), id: a, project: proj, rank: 1 }, { task_id: task(b), id: b, project: proj, rank: 2 }], who: 'test' }, { calendarDays: true });
  assert.deepEqual(w.map((x) => x.name), ['WHIQ leveling rank']);
  assert.deepEqual(fieldsOf(back, 'TASK')['WHIQ leveling rank'].values, { [a]: '1', [b]: '2' });
  // any other type of that name is still refused; a project without the field still makes it as an integer
  ok(back, [{ op: 'set_fields', table: 'UDFTYPE', where: { udf_type_label: 'WHIQ leveling rank' }, fields: { logical_data_type: 'FT_TEXT' } }]);
  assert.match(whiqFieldClash(back, { changes: [], ranks: [1] })!.message, /of type text/);
  const fresh = load('small_villa_g_1_schedule.xer');
  writeWhiqFields(fresh, { changes: [], ranks: [{ task_id: rows(fresh, 'TASK')[0].task_id, id: rows(fresh, 'TASK')[0].task_code, project: rows(fresh, 'PROJECT')[0].proj_short_name, rank: 1 }], who: 'test' }, { calendarDays: true });
  assert.equal(fieldsOf(fresh, 'TASK')['WHIQ leveling rank'].type, 'FT_INT');
});

test('M2: unused global fields do not push out a field that has values; a declared empty field still round-trips in a new file when there is room', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const [a] = taskCodes(db);
  const ops: unknown[] = [];
  for (let i = 1; i <= 24; i++) ops.push({ op: 'add_udf', name: `Empty ${i}`, data_type: 'text' });
  ops.push({ op: 'add_udf', name: 'Has value', data_type: 'text' }, { op: 'set_udf', activity: a, udf: 'Has value', value: 'IMPORTANT' });
  ok(db, ops);
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  assert.ok(xml.includes('IMPORTANT') && xml.includes('<Alias>Has value</Alias>'), 'the field with a value is carried');
  assert.equal(cf(xml).length, 24, 'all 24 free Text slots are used');
  assert.equal(cf(xml).filter((x) => x[2].startsWith('Empty')).length, 23);
  assert.equal(report.length, 1);
  assert.ok(report[0].includes('activity Text fields "Empty 24"'), report[0]);
  assert.deepEqual(fieldsOf(parseMspdi(xml).db, 'TASK')['Has value'].values, { [a]: 'IMPORTANT' });
  // room for all: a declared field without a value survives (new file), in the slots after the ones with values
  const roomy = built();
  ok(roomy, [{ op: 'add_udf', name: 'Declared only' }, { op: 'add_udf', name: 'Declared res', subject: 'resource', data_type: 'number' }]);
  const r2: string[] = [];
  const x2 = writeMspdi(roomy, { report: r2 });
  assert.deepEqual(r2, []);
  const back = parseMspdi(x2).db;
  assert.deepEqual(Object.keys(fieldsOf(back, 'TASK')['Declared only'].values), []);
  assert.equal(fieldsOf(back, 'TASK')['Declared only'].type, 'FT_TEXT');
  assert.equal(fieldsOf(back, 'RSRC')['Declared res'].type, 'FT_FLOAT_2_DECIMALS');
  assert.deepEqual(cf(writeMspdi(back)), cf(x2), 'and it keeps its slot through save, open, save');
});

test('M2: a customer\'s file saved in place gains no definition of a field that has no value in it, and says nothing of it', () => {
  const { db } = parseMspdi(readFileSync(FILE, 'utf8'));
  // fields of other projects / unused global fields in the same database
  ok(db, [{ op: 'add_udf', name: 'Elsewhere text' }, { op: 'add_udf', name: 'Elsewhere number', data_type: 'number' }, { op: 'add_udf', name: 'Elsewhere res', subject: 'resource' }]);
  const report: string[] = [];
  const out = writeMspdi(db, { report });
  assert.deepEqual(report, []);
  assert.ok(!out.includes('Elsewhere'));
  assert.equal(out, writeMspdi(parseMspdi(readFileSync(FILE, 'utf8')).db), 'the file is what an untouched save gives');
  // once it has a value it is added, on a slot the file does not use
  ok(db, [{ op: 'set_udf', activity: taskCodes(db)[0], udf: 'Elsewhere text', value: 'now valued' }]);
  assert.deepEqual(defs(writeMspdi(db)).filter((x) => x[2].startsWith('Elsewhere')).map((x) => [x[2], x[1]]), [['Elsewhere text', 'Text2']]);
});

test('M3: editing one custom field of a task leaves the lookup link of its other custom fields; the edited lookup value is written plain and named', () => {
  const { db } = parseMspdi(lookupFile());
  const t = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Rooms Affected')!;
  const v = rows(db, 'UDFVALUE').find((x) => x.udf_type_id === t.udf_type_id)!;
  const code = rows(db, 'TASK').find((x) => x.task_id === v.fk_id)!.task_code;
  assert.ok(writeMspdi(db).includes('<ValueGUID>AAAA-1</ValueGUID>'), 'untouched: kept');
  ok(db, [{ op: 'set_udf', activity: code, udf: 'Rooms Affected', value: 11 }]);
  const report: string[] = [];
  const out = writeMspdi(db, { report });
  assert.ok(out.includes('<ValueGUID>AAAA-1</ValueGUID>') && out.includes('<ValueList>'), 'the other field\'s lookup link stays');
  assert.match(out, /<FieldID>188743767<\/FieldID><Value>11<\/Value>/);
  assert.deepEqual(report, [], 'the edited field had no lookup link: nothing to say');
  // editing the lookup field itself: the new value is plain, the link is dropped and named
  ok(db, [{ op: 'set_udf', activity: code, udf: 'Room', value: 'Rooms 5-6' }]);
  const r2: string[] = [];
  const o2 = writeMspdi(db, { report: r2 });
  assert.match(o2, /<FieldID>188743731<\/FieldID><Value>Rooms 5-6<\/Value><\/ExtendedAttribute>/);
  assert.ok(!o2.includes('AAAA-1'));
  assert.equal(r2.length, 1);
  assert.ok(r2[0].includes(`Custom field "Room": the value on activity "${code}" was edited`) && r2[0].includes('lookup-table link') && r2[0].includes('ValueGUID') && r2[0].includes('was dropped'), r2[0]);
});

test('M4: custom field values on summary tasks are not read, stay in the file, and one finding says so', () => {
  let src = readFileSync(FILE, 'utf8');
  const sums = [...src.matchAll(/<Task>(?:(?!<\/Task>)[\s\S])*?<Summary>1<\/Summary>(?:(?!<\/Task>)[\s\S])*?<\/Task>/g)].map((x) => x[0]);
  assert.ok(sums.length >= 1, 'the fixture has a summary task');
  src = src.replace(sums[0], sums[0].replace('</Task>', '<ExtendedAttribute><FieldID>188743731</FieldID><Value>WING A</Value></ExtendedAttribute></Task>'));
  const { db, findings } = parseMspdi(src);
  assert.ok(!rows(db, 'UDFVALUE').some((v) => v.udf_text === 'WING A'));
  const f = findings.filter((x) => x.code === 'MSP_CUSTOM_FIELD_SUMMARY');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /Room \(Text1, 1 value\) on 1 summary task\(s\)/);
  assert.match(f[0].message, /stay in the Microsoft Project file.*not in the P6 data.*XER or P6 XML made from it does not have them/);
  assert.ok(writeMspdi(db).includes('<Value>WING A</Value>'), 'an in-place save keeps it');
  assert.ok(!parseMspdi(readFileSync(FILE, 'utf8')).findings.some((x) => x.code === 'MSP_CUSTOM_FIELD_SUMMARY'), 'no values on summary tasks: no finding');
});

test('M5: a text value longer than 255 characters is written whole and the save says Microsoft Project shows the first 255', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const [a, b, c] = taskCodes(db);
  const long = 'x'.repeat(400) + '\nline2\r\n"q"';
  ok(db, [{ op: 'add_udf', name: 'Long', data_type: 'text' }, { op: 'add_udf', name: 'Exact', data_type: 'text' },
    { op: 'set_udf', activity: a, udf: 'Long', value: long }, { op: 'set_udf', activity: b, udf: 'Long', value: 'y'.repeat(256) }, { op: 'set_udf', activity: c, udf: 'Long', value: 'z'.repeat(255) },
    { op: 'set_udf', activity: a, udf: 'Exact', value: 'e'.repeat(255) }]);
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  assert.equal(report.length, 1);
  assert.ok(report[0].includes('activity "Long" (2 values)') && !report[0].includes('"Exact"'), report[0]);
  assert.match(report[0], /hold 255 characters, so it shows the first 255 of each of these values; the file holds the whole value/);
  const back = fieldsOf(parseMspdi(xml).db, 'TASK').Long.values;
  assert.equal(back[a], long, 'nothing was cut');
  assert.equal(back[b].length, 256);
});

test('L6: an untouched in-place save keeps the file\'s own alias when two aliases differ only by case; a rename by the user is written', () => {
  const src = readFileSync(FILE, 'utf8').replace('<Alias>Rooms Affected</Alias>', '<Alias>ROOM</Alias>');
  const { db } = parseMspdi(src);
  assert.deepEqual(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK').map((u) => u.udf_type_label).sort(), ['ROOM (Number1)', 'Room']);
  const out = writeMspdi(db);
  assert.ok(out.includes('<Alias>ROOM</Alias>') && !out.includes('(Number1)'));
  assert.equal((out.match(/<ExtendedAttributes>[\s\S]*?<\/ExtendedAttributes>/) ?? [])[0], (src.match(/<ExtendedAttributes>[\s\S]*?<\/ExtendedAttributes>/) ?? [])[0]);
  ok(db, [{ op: 'update_udf', udf: 'ROOM (Number1)', new_name: 'Rooms hit' }]);
  assert.ok(writeMspdi(db).includes('<Alias>Rooms hit</Alias>'));
});

test('L7: a field with values and no alias is read under its Microsoft Project name and one finding names it', () => {
  const src = readFileSync(FILE, 'utf8').replace(/(<UID>155<\/UID>[\s\S]*?)(<ExtendedAttribute><FieldID>188743731)/, '$1<ExtendedAttribute><FieldID>188743748</FieldID><Value>No alias here</Value></ExtendedAttribute>$2');
  const { db, findings } = parseMspdi(src);
  assert.deepEqual(Object.values(fieldsOf(db, 'TASK').Text8.values), ['No alias here']);
  const f = findings.filter((x) => x.code === 'MSP_CUSTOM_FIELD_UNNAMED');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /1 Microsoft Project custom field\(s\) have values but no name \(alias\) in the file.*under their Microsoft Project field name.*: activity Text8\./);
  assert.ok(!parseMspdi(readFileSync(FILE, 'utf8')).findings.some((x) => x.code === 'MSP_CUSTOM_FIELD_UNNAMED'));
});

test('L8: a P6 FT_FLOAT field is a Number field and its value is carried', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const [a] = taskCodes(db);
  ok(db, [{ op: 'add_udf', name: 'Dbl', data_type: 'number' }, { op: 'set_udf', activity: a, udf: 'Dbl', value: 4.75 }]);
  rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Dbl')!.logical_data_type = 'FT_FLOAT';
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  assert.ok(xml.includes('<Value>4.75</Value>'));
  assert.deepEqual(report, []);
  assert.deepEqual(fieldsOf(parseMspdi(xml).db, 'TASK').Dbl, { type: 'FT_FLOAT_2_DECIMALS', values: { [a]: '4.75' } });
});

test('L9: a Number value is written as stored when it is a plain decimal number (XML Schema double), else as the decimal text of its value; a value that is no number is named', () => {
  const db = load('small_villa_g_1_schedule.xer');
  const codes = taskCodes(db);
  ok(db, [{ op: 'add_udf', name: 'Num', data_type: 'number' }]);
  const type = rows(db, 'UDFTYPE').find((u) => u.udf_type_label === 'Num')!;
  const cases: [string, string | null][] = [['4.75', '4.75'], ['-3', '-3'], ['+2.50', '+2.50'], ['.5', '.5'], ['7.', '7.'], ['1e3', '1e3'], ['2.5E-2', '2.5E-2'], ['0x10', '16'], [' 5 ', '5'], ['1_000', null], ['abc', null], ['Infinity', null], ['NaN', null]];
  cases.forEach(([v], i) => table(db, 'UDFVALUE').rows.push({ udf_type_id: type.udf_type_id, fk_id: rows(db, 'TASK').find((x) => x.task_code === codes[i])!.task_id, proj_id: rows(db, 'TASK')[0].proj_id, udf_date: '', udf_number: v, udf_text: '', udf_code_id: '' }));
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const out = [...xml.matchAll(/<ExtendedAttribute><FieldID>188743767<\/FieldID><Value>([^<]*)<\/Value>/g)].map((m) => m[1]);
  assert.deepEqual([...out].sort(), cases.filter((c) => c[1] != null).map((c) => c[1]!).sort()); // (in the order of the activities in the file)
  const named = report.find((n) => n.startsWith('Custom field values NOT carried'))!;
  assert.match(named, /^Custom field values NOT carried to the Microsoft Project XML: activity "Num" \((?:"[^"]*"(?:, )?){4}\) are not numbers, so they are left out of the file\.$/);
  for (const v of ['1_000', 'abc', 'Infinity', 'NaN']) assert.ok(named.includes(`"${v}"`), v);
});

test('guard: for every logical type the clone knows, a value written is the value read back, or the field is named as not carried', async () => {
  const { ENUMS } = await import('../core/xer/schema.ts');
  const { P6XML_ENUMS } = await import('../core/xml/p6xml.ts');
  const types = [...new Set([...ENUMS['UDFTYPE.logical_data_type'], ...Object.keys(P6XML_ENUMS.udf_data_type)])];
  assert.ok(types.length >= 10 && types.includes('FT_FLOAT') && types.includes('FT_CODE'));
  // what each type holds on a row, and the text it is read back as
  const col: Record<string, [column: string, value: string, back: string]> = {
    FT_TEXT: ['udf_text', 'hello', 'hello'], FT_STATICTYPE: ['udf_text', 'UDF_G3', 'UDF_G3'], FT_CODE: ['udf_code_id', 'C1', 'AB'],
    FT_FLOAT: ['udf_number', '4.75', '4.75'], FT_FLOAT_2_DECIMALS: ['udf_number', '4.75', '4.75'], FT_INT: ['udf_number', '7', '7'], FT_MONEY: ['udf_number', '12.5', '12.5'],
    FT_START_DATE: ['udf_date', '2026-03-02 08:00', '2026-03-02 08:00'], FT_END_DATE: ['udf_date', '2026-03-02 08:00', '2026-03-02 08:00'], FT_DATE: ['udf_date', '2026-03-02 08:00', '2026-03-02 08:00'],
  };
  for (const t of types) assert.ok(col[t], `the guard knows what to write for ${t}`);
  const db = load('small_villa_g_1_schedule.xer');
  const [a] = taskCodes(db);
  const taskId = rows(db, 'TASK').find((x) => x.task_code === a)!.task_id;
  const { table } = await import('../core/db.ts');
  table(db, 'UDFCODE').rows.push({ udf_code_id: 'C1', udf_type_id: '', short_name: 'AB', udf_code_name: 'Alpha' });
  ok(db, types.map((t) => ({ op: 'add_udf', name: `T ${t}` })));
  for (const t of types) {
    const u = rows(db, 'UDFTYPE').find((x) => x.udf_type_label === `T ${t}`)!;
    u.logical_data_type = t;
    const [c, v] = col[t];
    table(db, 'UDFVALUE').rows.push({ udf_type_id: u.udf_type_id, fk_id: taskId, proj_id: rows(db, 'TASK')[0].proj_id, udf_date: '', udf_number: '', udf_text: '', udf_code_id: '', [c]: v });
  }
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const back = fieldsOf(parseMspdi(xml).db, 'TASK');
  for (const t of types) {
    const named = report.some((n) => /NOT carried/.test(n) && n.includes(`"T ${t}"`));
    const got = back[`T ${t}`]?.values[a];
    assert.ok(named || got === col[t][2], `${t}: read back ${JSON.stringify(got)}, wanted ${JSON.stringify(col[t][2])}, named: ${named}`);
    if (!named) assert.ok(back[`T ${t}`], `${t}: no definition without its value`);
  }
});

test('guard: a custom field of a data type the clone does not know is written from the value column its rows hold, never dropped; several columns, and it is named as not carried', async () => {
  const { table } = await import('../core/db.ts');
  const db = load('small_villa_g_1_schedule.xer');
  const [a, b] = taskCodes(db);
  const id = (c: string) => rows(db, 'TASK').find((x) => x.task_code === c)!.task_id;
  ok(db, ['W text', 'W number', 'W date', 'W mixed'].map((name) => ({ op: 'add_udf', name })));
  const pid = rows(db, 'TASK')[0].proj_id;
  const put = (label: string, fk: string, col: string, v: string) => {
    const u = rows(db, 'UDFTYPE').find((x) => x.udf_type_label === label)!;
    u.logical_data_type = 'FT_WEIRD';
    table(db, 'UDFVALUE').rows.push({ udf_type_id: u.udf_type_id, fk_id: fk, proj_id: pid, udf_date: '', udf_number: '', udf_text: '', udf_code_id: '', [col]: v });
  };
  put('W text', id(a), 'udf_text', 'abc'); put('W number', id(a), 'udf_number', '7.5'); put('W date', id(a), 'udf_date', '2026-03-02 08:00');
  put('W mixed', id(a), 'udf_text', 'x'); put('W mixed', id(b), 'udf_number', '3');
  const report: string[] = [];
  const xml = writeMspdi(db, { report });
  const back = fieldsOf(parseMspdi(xml).db, 'TASK');
  assert.deepEqual(back['W text'], { type: 'FT_TEXT', values: { [a]: 'abc' } });
  assert.deepEqual(back['W number'], { type: 'FT_FLOAT_2_DECIMALS', values: { [a]: '7.5' } });
  assert.deepEqual(back['W date'], { type: 'FT_DATE', values: { [a]: '2026-03-02 08:00' } });
  assert.ok(!back['W mixed'], 'two value columns: not written');
  assert.ok(report.some((n) => /NOT carried/.test(n) && n.includes('"W mixed"') && n.includes('FT_WEIRD') && /more than one value column/.test(n)), report.join(' | '));
  const said = report.find((n) => /because their data type has no Microsoft Project kind/.test(n))!;
  for (const [l, k] of [['W text', 'Text'], ['W number', 'Number'], ['W date', 'Date']]) assert.ok(said.includes(`"${l}" (FT_WEIRD, written as a ${k} field)`), said);
});
