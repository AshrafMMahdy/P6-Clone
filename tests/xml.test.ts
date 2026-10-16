import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { writeP6Xml, parseP6Xml, parseXml } from '../core/xml/p6xml.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { samples } from './helpers.ts';

const MAPPED = ['task_code', 'task_name', 'task_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'act_start_date', 'act_end_date', 'early_start_date', 'early_end_date', 'total_float_hr_cnt', 'cstr_type', 'cstr_date'];

test('XER -> P6 XML -> tables keeps activities, relationships and calendars', () => {
  const src = parseXer(samples().find((s) => s.name === 'DHBL-24FEB13_VER-7.0.xer')!.bytes).db;
  const xml = writeP6Xml(src, {});
  assert.match(xml, /^<\?xml/);
  const { db, findings } = parseP6Xml(xml);
  assert.deepEqual(findings.filter((f) => f.severity === 'fatal'), []);
  assert.equal(db.tables.TASK.rows.length, src.tables.TASK.rows.length);
  assert.equal(db.tables.TASKPRED.rows.length, src.tables.TASKPRED.rows.length);
  const byId = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
  for (const a of src.tables.TASK.rows.slice(0, 300)) {
    const b = byId.get(a.task_id)!;
    for (const f of MAPPED) assert.equal(b[f] ?? '', a[f] ?? '', `${a.task_code}.${f}`);
  }
});

test('rescheduling the XML round trip gives the same dates as the XER', () => {
  const src = parseXer(samples().find((s) => s.name === 'cleopatra elmohandesen.xer')!.bytes).db;
  const { db } = parseP6Xml(writeP6Xml(src, {}));
  scheduleProjects(src, src.tables.PROJECT.rows.map((p) => p.proj_id));
  scheduleProjects(db, db.tables.PROJECT.rows.map((p) => p.proj_id));
  const byId = new Map(db.tables.TASK.rows.map((r) => [r.task_id, r]));
  for (const a of src.tables.TASK.rows) assert.equal(byId.get(a.task_id)!.early_end_date, a.early_end_date, a.task_code);
});

test('malformed XML is a fatal finding, not a crash', () => {
  assert.equal(parseP6Xml('<APIBusinessObjects><Project></APIBusinessObjects>').findings[0].code, 'XML_PARSE');
  assert.equal(parseP6Xml('<foo/>').findings[0].code, 'XML_ROOT');
  assert.equal(parseXml('<a x="1">t&amp;<b/></a>').children[0].text, 't&');
});
