import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { writeP6Xml, parseP6Xml, parseXml } from '../core/xml/p6xml.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { samples } from './helpers.ts';
import { parseClndrData } from '../core/calendar/clndr-data.ts';

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

test('XER -> P6 XML -> tables keeps activity codes, UDF values, holidays and schedule options', () => {
  const src = parseXer(samples().find((s) => s.name === 'Beyti plant baseline -C(baseline).xer')!.bytes).db;
  const xml = writeP6Xml(src, {});
  assert.doesNotMatch(xml, /<ActivityCodeAssignment>|<UDFValue>|<HolidayExceptions>/);
  const { db } = parseP6Xml(xml);
  const key = (r: Record<string, string>, ...f: string[]) => f.map((x) => r[x] ?? '').join('|');
  const codes = (d: typeof db) => new Set(d.tables.TASKACTV.rows.map((r) => key(r, 'task_id', 'actv_code_id')));
  assert.deepEqual(codes(db), codes(src));
  const udfs = (d: typeof db) => new Set(d.tables.UDFVALUE.rows.map((r) => key(r, 'udf_type_id', 'fk_id', 'udf_text', 'udf_date')).filter((k) => !k.endsWith('||')));
  assert.deepEqual(udfs(db), udfs(src));
  const cal = (d: typeof db) => new Map(d.tables.CALENDAR.rows.map((r) => [r.clndr_id, parseClndrData(r.clndr_data)]));
  for (const [id, c] of cal(src)) {
    const b = cal(db).get(id)!;
    assert.deepEqual(b.week, c.week, id);
    assert.deepEqual([...b.exceptions].sort(), [...c.exceptions].sort(), id);
  }
  const so = (d: typeof db) => d.tables.SCHEDOPTIONS.rows.map((r) => key(r, 'sched_retained_logic', 'sched_progress_override', 'sched_float_type', 'sched_calendar_on_relationship_lag', 'sched_outer_depend_type', 'sched_open_critical_flag'));
  assert.deepEqual(so(db), so(src));
});

test('reads P6 XML as P6 writes it: HolidayOrExceptions, hh:59 finishes, nested Code/UDF, ScheduleOptions, fraction percents', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V20.12/API/BusinessObjects" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<ActivityCodeType><ObjectId>7</ObjectId><Name>Phase</Name><Scope>Global</Scope></ActivityCodeType>
<ActivityCode><ObjectId>70</ObjectId><CodeTypeObjectId>7</CodeTypeObjectId><CodeValue>DES</CodeValue></ActivityCode>
<UDFType><ObjectId>9</ObjectId><SubjectArea>Activity</SubjectArea><Title>Package</Title><DataType>Text</DataType></UDFType>
<Calendar><ObjectId>1</ObjectId><Name>Site</Name><Type>Global</Type><IsDefault>true</IsDefault><HoursPerDay>8</HoursPerDay>
<StandardWorkWeek>
<StandardWorkHours><DayOfWeek>Sunday</DayOfWeek><WorkTime xsi:nil="true"/></StandardWorkHours>
<StandardWorkHours><DayOfWeek>Monday</DayOfWeek><WorkTime><Start>08:00:00</Start><Finish>11:59:00</Finish></WorkTime><WorkTime><Start>13:00:00</Start><Finish>16:59:00</Finish></WorkTime></StandardWorkHours>
<StandardWorkHours><DayOfWeek>Tuesday</DayOfWeek><WorkTime><Start>00:00:00</Start><Finish>23:59:00</Finish></WorkTime></StandardWorkHours>
</StandardWorkWeek>
<HolidayOrExceptions>
<HolidayOrException><Date>2026-01-05T00:00:00</Date></HolidayOrException>
<HolidayOrException><Date>2026-01-06T00:00:00</Date><WorkTime><Start>00:00:00</Start><Finish>23:59:00</Finish></WorkTime></HolidayOrException>
<HolidayOrException><Date>2026-01-10T00:00:00</Date><WorkTime><Start>08:00:00</Start><Finish>12:29:00</Finish></WorkTime></HolidayOrException>
</HolidayOrExceptions></Calendar>
<Project><ObjectId>1</ObjectId><Id>P1</Id><Name>P1</Name><PlannedStartDate>2026-01-05T08:00:00</PlannedStartDate>
<ScheduleOptions><IgnoreOtherProjectRelationships>true</IgnoreOtherProjectRelationships><MakeOpenEndedActivitiesCritical>false</MakeOpenEndedActivitiesCritical><OutOfSequenceScheduleType>Progress Override</OutOfSequenceScheduleType><RelationshipLagCalendar>24 Hour Calendar</RelationshipLagCalendar><ComputeTotalFloatType>Start Float = Late Start - Early Start</ComputeTotalFloatType></ScheduleOptions>
<Activity><ObjectId>100</ObjectId><Id>A1</Id><Name>Design</Name><CalendarObjectId>1</CalendarObjectId><PhysicalPercentComplete>0.25</PhysicalPercentComplete><PrimaryConstraintType>None</PrimaryConstraintType>
<Code><TypeObjectId>7</TypeObjectId><ValueObjectId>70</ValueObjectId></Code><UDF><TypeObjectId>9</TypeObjectId><TextValue>Civil</TextValue></UDF></Activity>
</Project></APIBusinessObjects>`;
  const { db } = parseP6Xml(xml);
  const c = parseClndrData(db.tables.CALENDAR.rows[0].clndr_data);
  assert.deepEqual(c.week[0], []);
  assert.deepEqual(c.week[1], [{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
  assert.deepEqual(c.week[2], [{ start: 0, end: 1440 }]); // 24-hour work day
  assert.deepEqual([...c.exceptions.values()], [[], [], [{ start: 480, end: 750 }]]); // nil and 00:00-23:59 = holiday
  const so = db.tables.SCHEDOPTIONS.rows[0];
  assert.deepEqual([so.sched_outer_depend_type, so.sched_open_critical_flag, so.sched_retained_logic, so.sched_progress_override, so.sched_calendar_on_relationship_lag, so.sched_float_type], ['SD_None', 'N', 'N', 'Y', 'rcal_24Hour', 'FT_SS']);
  const t = db.tables.TASK.rows[0];
  assert.equal(t.phys_complete_pct, '25');
  assert.equal(t.cstr_type, '');
  assert.deepEqual(db.tables.TASKACTV.rows.map((r) => [r.task_id, r.actv_code_type_id, r.actv_code_id]), [['100', '7', '70']]);
  assert.deepEqual(db.tables.UDFVALUE.rows.map((r) => [r.udf_type_id, r.fk_id, r.udf_text]), [['9', '100', 'Civil']]);
  assert.deepEqual([db.tables.UDFTYPE.rows[0].table_name, db.tables.UDFTYPE.rows[0].logical_data_type, db.tables.ACTVTYPE.rows[0].actv_code_type_scope], ['TASK', 'FT_TEXT', 'AS_Global']);
  // and writes them back the same way
  const out = writeP6Xml(db, {});
  assert.match(out, /<Finish>16:59:00<\/Finish>/);
  assert.match(out, /<HolidayOrException><Date>2026-01-05T00:00:00<\/Date><\/HolidayOrException>/);
  assert.match(out, /<PhysicalPercentComplete>0.25<\/PhysicalPercentComplete>/);
  assert.match(out, /<Code><TypeObjectId>7<\/TypeObjectId><ValueObjectId>70<\/ValueObjectId><\/Code><UDF><TypeObjectId>9<\/TypeObjectId><TextValue>Civil<\/TextValue><\/UDF><\/Activity>/);
  assert.match(out, /<ScheduleOptions>.*<OutOfSequenceScheduleType>Progress Override<\/OutOfSequenceScheduleType>.*<\/ScheduleOptions>/); // (in the schema's order, not last)
  assert.match(out, /<DataType>Text<\/DataType><ObjectId>9<\/ObjectId><SubjectArea>Activity<\/SubjectArea>/); // (the schema's order)
});
