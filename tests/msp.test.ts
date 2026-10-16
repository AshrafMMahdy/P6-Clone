import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { parseMspdi, writeMspdi, isoDurationHours, hoursToIso } from '../core/msp/mspdi.ts';
import { parseMpx, writeMpx, mpxRecords } from '../core/msp/mpx.ts';
import { effectiveCalendars } from '../core/msp/shared.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { updateProgress } from '../core/progress/update.ts';
import { parseP6Date } from '../core/dates.ts';
import { rows, type Db, type Row } from '../core/db.ts';
import { buildConvertScript, convertError, MSP_REQUIRED, psQuote } from '../main/msproject.ts';
import { detectFormat, exportFile, parseFile } from '../renderer/io.ts';
import { samples } from './helpers.ts';

const load = (name: string) => parseXer(samples().find((s) => s.name === name)!.bytes).db;
const n = (s: string | undefined) => Number(s || 0);

/** WBS depth of an activity (root = 0). */
function depth(db: Db, t: Row): number {
  const byId = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  let d = 0;
  for (let w = byId.get(t.wbs_id); w && w.proj_node_flag !== 'Y' && d < 100; w = byId.get(w.parent_wbs_id)) d++;
  return d;
}

/** A statused copy of a sample: progressed to a later data date, with constraints added. */
function progressed(name: string, months: number): Db {
  const db = load(name);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  scheduleProjects(db, [pid]);
  const dd = parseP6Date(rows(db, 'PROJECT')[0].last_recalc_date)! + months * 30 * 1440;
  updateProgress(db, pid, dd);
  const ns = rows(db, 'TASK').filter((t) => !t.act_start_date && t.task_type === 'TT_Task');
  const cs: [string, string][] = [['CS_MSOA', 'start'], ['CS_MEOB', 'end'], ['CS_MSO', 'start'], ['CS_MANDFIN', 'end'], ['CS_ALAP', '']];
  cs.forEach(([ty, which], i) => {
    const t = ns[i * 7];
    t.cstr_type = ty;
    t.cstr_date = which ? (which === 'start' ? t.early_start_date : t.early_end_date) : '';
  });
  ns[3].cstr_type2 = 'CS_MEOB';
  ns[3].cstr_date2 = ns[3].late_end_date;
  return db;
}

function assertRoundTrip(src: Db, db: Db, label: string) {
  assert.ok(rows(src, 'TASK').some((t) => t.act_start_date) || label.includes('plain'), `${label}: sample has actuals`);
  const a = new Map(rows(src, 'TASK').map((t) => [t.task_code, t]));
  const b = new Map(rows(db, 'TASK').map((t) => [t.task_code, t]));
  assert.equal(b.size, a.size, `${label}: activity count`);
  for (const [code, x] of a) {
    const y = b.get(code);
    assert.ok(y, `${label}: ${code} missing`);
    assert.equal(y.task_name, x.task_name, `${label}: ${code} name`);
    assert.equal(y.task_type, x.task_type, `${label}: ${code} type`);
    assert.equal(y.duration_type, x.duration_type, `${label}: ${code} duration type`);
    const mile = x.task_type === 'TT_Mile' || x.task_type === 'TT_FinMile';
    if (!mile) assert.ok(Math.abs(n(y.target_drtn_hr_cnt) - n(x.target_drtn_hr_cnt)) < 0.001, `${label}: ${code} duration ${y.target_drtn_hr_cnt} vs ${x.target_drtn_hr_cnt}`);
    if (!x.act_end_date && !mile) assert.ok(Math.abs(n(y.remain_drtn_hr_cnt) - n(x.remain_drtn_hr_cnt || x.target_drtn_hr_cnt)) < 0.001, `${label}: ${code} remaining`);
    assert.equal(y.act_start_date, x.act_start_date, `${label}: ${code} actual start`);
    assert.equal(y.act_end_date, x.act_end_date, `${label}: ${code} actual finish`);
    assert.equal(y.cstr_type ?? '', x.cstr_type ?? '', `${label}: ${code} constraint`);
    assert.equal(y.cstr_date ?? '', x.cstr_date ?? '', `${label}: ${code} constraint date`);
    assert.equal(y.cstr_type2 ?? '', x.cstr_type2 ?? '', `${label}: ${code} secondary constraint`);
    assert.equal(depth(db, y), depth(src, x), `${label}: ${code} WBS depth`);
  }
  // relationships: same pairs, types and lags
  const rel = (d: Db) => {
    const code = new Map(rows(d, 'TASK').map((t) => [t.task_id, t.task_code]));
    return rows(d, 'TASKPRED').filter((r) => code.has(r.task_id) && code.has(r.pred_task_id)).map((r) => `${code.get(r.pred_task_id)}>${code.get(r.task_id)} ${r.pred_type} ${n(r.lag_hr_cnt)}`).sort();
  };
  assert.deepEqual(rel(db), rel(src), `${label}: relationships`);
  // WBS: same number of nodes and the same maximum depth
  assert.equal(rows(db, 'PROJWBS').length, rows(src, 'PROJWBS').filter((w) => w.proj_id === rows(src, 'PROJECT')[0].proj_id).length, `${label}: WBS nodes`);
  // calendars used by activities: same work week and same effective holidays/exceptions
  const ca = effectiveCalendars(rows(src, 'CALENDAR')), cb = effectiveCalendars(rows(db, 'CALENDAR'));
  const nameB = new Map(rows(db, 'CALENDAR').map((c) => [c.clndr_name, c.clndr_id]));
  for (const c of rows(src, 'CALENDAR').filter((c) => rows(src, 'TASK').some((t) => t.clndr_id === c.clndr_id))) {
    const da = ca.get(c.clndr_id)!, db2 = cb.get(nameB.get(c.clndr_name)!)!;
    assert.ok(db2, `${label}: calendar ${c.clndr_name} missing`);
    assert.deepEqual(db2.week, da.week, `${label}: ${c.clndr_name} work week`);
    assert.deepEqual([...db2.exceptions].sort((p, q) => p[0] - q[0]), [...da.exceptions].sort((p, q) => p[0] - q[0]), `${label}: ${c.clndr_name} exceptions`);
  }
  // rescheduling gives the same early dates
  scheduleProjects(src, rows(src, 'PROJECT').map((p) => p.proj_id));
  scheduleProjects(db, rows(db, 'PROJECT').map((p) => p.proj_id));
  for (const [code, x] of a) {
    const y = b.get(code)!;
    assert.equal(y.early_start_date, x.early_start_date, `${label}: ${code} early start`);
    assert.equal(y.early_end_date, x.early_end_date, `${label}: ${code} early finish`);
  }
}

for (const [fmt, write, parse] of [['MSPDI', writeMspdi, parseMspdi], ['MPX', writeMpx, parseMpx]] as const) {
  test(`P6 -> ${fmt} -> P6 keeps activities, logic, durations, calendars and dates (plain cleopatra)`, () => {
    const src = load('cleopatra elmohandesen.xer');
    const { db, findings } = parse(write(src, {}));
    assert.deepEqual(findings.filter((f) => f.severity === 'fatal' || f.severity === 'error'), []);
    assert.deepEqual(validateXer(db, findings).filter((f) => f.severity === 'fatal' || f.severity === 'error'), []);
    assertRoundTrip(src, db, `${fmt} plain cleopatra`);
  });

  test(`P6 -> ${fmt} -> P6 on a progressed, constrained schedule (cleopatra)`, () => {
    const src = progressed('cleopatra elmohandesen.xer', 3);
    const { db } = parse(write(src, {}));
    assertRoundTrip(src, db, `${fmt} progressed cleopatra`);
  });

  test(`P6 -> ${fmt} -> P6 on a 5,608-activity programme with resources (DHBL)`, () => {
    const src = progressed('DHBL-24FEB13_VER-7.0.xer', 6);
    const { db, findings } = parse(write(src, {}));
    assert.deepEqual(validateXer(db, findings).filter((f) => f.severity === 'fatal' || f.severity === 'error'), []);
    assert.equal(rows(db, 'RSRC').length, rows(src, 'RSRC').length);
    const withRsrc = rows(src, 'TASKRSRC').filter((a) => a.rsrc_id && rows(src, 'RSRC').some((r) => r.rsrc_id === a.rsrc_id));
    assert.equal(rows(db, 'TASKRSRC').length, withRsrc.length);
    const units = (d: Db) => rows(d, 'TASKRSRC').reduce((s, a) => s + n(a.target_qty), 0);
    assert.ok(Math.abs(units(db) - units(src)) < 1, 'assignment units');
    assertRoundTrip(src, db, `${fmt} progressed DHBL`);
  });
}

test('malformed input gives a fatal finding, not an exception', () => {
  assert.equal(parseMspdi('<Project><Tasks></Project>').findings[0].code, 'XML_PARSE');
  assert.equal(parseMspdi('<foo/>').findings[0].code, 'MSP_ROOT');
  assert.equal(parseMspdi('').findings[0].severity, 'fatal');
  assert.equal(parseMpx('hello,world').findings[0].code, 'MPX_HEADER');
  assert.equal(parseMpx('').findings[0].severity, 'fatal');
  assert.doesNotThrow(() => parseMpx('MPX,x,4.0,ANSI\r\n70,"unterminated\r\n61,garbage\r\n75,1'));
  assert.doesNotThrow(() => parseMspdi('<Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task><UID>1</UID><Duration>bogus</Duration><PredecessorLink><PredecessorUID>9</PredecessorUID></PredecessorLink></Task></Tasks></Project>'));
});

const FOREIGN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
<SaveVersion>14</SaveVersion><Name>Office Fitout.xml</Name><Title>Office Fitout</Title>
<StartDate>2026-03-02T08:00:00</StartDate><StatusDate>2026-03-02T08:00:00</StatusDate><CalendarUID>1</CalendarUID><MinutesPerDay>480</MinutesPerDay>
<Calendars>
 <Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
  <WeekDays>
   <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
   <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
   <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking></WeekDay>
   <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking></WeekDay>
   <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking></WeekDay>
   <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking></WeekDay>
   <WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
  </WeekDays>
  <Exceptions><Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>2026-04-03T00:00:00</FromDate><ToDate>2026-04-06T23:59:00</ToDate></TimePeriod><Occurrences>1</Occurrences><Name>Easter</Name><Type>1</Type><DayWorking>0</DayWorking></Exception></Exceptions>
 </Calendar>
 <Calendar><UID>2</UID><Name>Joiner</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID></Calendar>
 <Calendar><UID>3</UID><Name>Night</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
  <WeekDays><WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>20:00:00</FromTime><ToTime>00:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay></WeekDays></Calendar>
</Calendars>
<Tasks>
 <Task><UID>0</UID><ID>0</ID><Name>Office Fitout</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
 <Task><UID>1</UID><ID>1</ID><Name>Design</Name><WBS>1</WBS><OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
 <Task><UID>2</UID><ID>2</ID><Name>Kick-off</Name><OutlineNumber>1.1</OutlineNumber><OutlineLevel>2</OutlineLevel><Duration>PT0H0M0S</Duration><Milestone>1</Milestone></Task>
 <Task><UID>3</UID><ID>3</ID><Name>Layouts</Name><OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel><Duration>PT40H0M0S</Duration><ConstraintType>4</ConstraintType><ConstraintDate>2026-03-04T08:00:00</ConstraintDate>
  <Deadline>2026-03-20T17:00:00</Deadline><PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink></Task>
 <Task><UID>4</UID><ID>4</ID><Name>Build</Name><WBS>1.5</WBS><OutlineNumber>1.3</OutlineNumber><OutlineLevel>2</OutlineLevel><Summary>1</Summary></Task>
 <Task><UID>5</UID><ID>5</ID><Name>Partitions</Name><OutlineNumber>1.3.1</OutlineNumber><OutlineLevel>3</OutlineLevel><Duration>PT80H0M0S</Duration><RemainingDuration>PT40H0M0S</RemainingDuration><ActualStart>2026-03-02T08:00:00</ActualStart><PercentComplete>50</PercentComplete><CalendarUID>3</CalendarUID>
  <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type><LinkLag>4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
  <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>
 <Task><UID>6</UID><ID>6</ID><Name>Handover</Name><OutlineNumber>2</OutlineNumber><OutlineLevel>1</OutlineLevel><Duration>PT0H0M0S</Duration><Milestone>1</Milestone>
  <PredecessorLink><PredecessorUID>5</PredecessorUID><Type>0</Type><LinkLag>-2400</LinkLag><LagFormat>7</LagFormat></PredecessorLink></Task>
</Tasks>
<Resources>
 <Resource><UID>0</UID><ID>0</ID></Resource>
 <Resource><UID>1</UID><ID>1</ID><Name>Joiner</Name><Type>1</Type><MaxUnits>2</MaxUnits><StandardRate>45</StandardRate><StandardRateFormat>2</StandardRateFormat><CalendarUID>2</CalendarUID></Resource>
 <Resource><UID>2</UID><ID>2</ID><Name>Plasterboard</Name><Type>0</Type><StandardRate>12.5</StandardRate></Resource>
</Resources>
<Assignments>
 <Assignment><UID>1</UID><TaskUID>5</TaskUID><ResourceUID>1</ResourceUID><Units>2</Units><Work>PT160H0M0S</Work><ActualWork>PT80H0M0S</ActualWork><RemainingWork>PT80H0M0S</RemainingWork></Assignment>
 <Assignment><UID>2</UID><TaskUID>5</TaskUID><ResourceUID>2</ResourceUID><Work>PT300H0M0S</Work></Assignment>
 <Assignment><UID>3</UID><TaskUID>1</TaskUID><ResourceUID>1</ResourceUID><Work>PT8H0M0S</Work></Assignment>
</Assignments>
</Project>`;

test('a Microsoft Project XML file maps onto P6 tables', () => {
  const { db, findings } = parseMspdi(FOREIGN);
  assert.deepEqual(validateXer(db, findings).filter((f) => f.severity === 'fatal' || f.severity === 'error'), []);
  const p = rows(db, 'PROJECT')[0];
  assert.equal(p.proj_short_name, 'Office Fitout');
  assert.equal(p.plan_start_date, '2026-03-02 08:00');
  const wbs = rows(db, 'PROJWBS');
  const root = wbs.find((w) => w.proj_node_flag === 'Y')!;
  const design = wbs.find((w) => w.wbs_name === 'Design')!, build = wbs.find((w) => w.wbs_name === 'Build')!;
  assert.equal(design.parent_wbs_id, root.wbs_id);
  assert.equal(build.parent_wbs_id, design.wbs_id);
  assert.equal(build.wbs_short_name, '5'); // WBS "1.5" under "1"
  const t = new Map(rows(db, 'TASK').map((x) => [x.task_name, x]));
  assert.equal(t.size, 4);
  assert.deepEqual([...t.values()].map((x) => x.task_code), ['A1000', 'A1010', 'A1020', 'A1030']);
  assert.equal(t.get('Kick-off')!.task_type, 'TT_Mile'); // milestone without predecessors
  assert.equal(t.get('Handover')!.task_type, 'TT_FinMile');
  assert.equal(t.get('Handover')!.wbs_id, root.wbs_id);
  const lay = t.get('Layouts')!;
  assert.equal(lay.target_drtn_hr_cnt, '40');
  assert.equal(lay.cstr_type, 'CS_MSOA');
  assert.equal(lay.cstr_date, '2026-03-04 08:00');
  assert.equal(lay.wbs_id, design.wbs_id);
  const part = t.get('Partitions')!;
  assert.equal(part.status_code, 'TK_Active');
  assert.equal(part.act_start_date, '2026-03-02 08:00');
  assert.equal(part.remain_drtn_hr_cnt, '40');
  assert.equal(part.wbs_id, build.wbs_id);
  assert.equal(part.clndr_id, '3');
  const rels = rows(db, 'TASKPRED').map((r) => `${r.pred_task_id}>${r.task_id} ${r.pred_type} ${r.lag_hr_cnt}`).sort();
  assert.deepEqual(rels, ['2>3 PR_FS 0', '3>5 PR_SS 8', '5>6 PR_FF -4']);
  assert.ok(findings.some((f) => f.code === 'MSP_DEADLINE' && f.severity === 'info'));
  assert.ok(findings.some((f) => f.code === 'MSP_SUMMARY_LINK'));
  assert.ok(findings.some((f) => f.code === 'MSP_SUMMARY_ASSIGNMENT'));
  // calendars: base calendar with Easter, night shift to midnight, resource calendar without changes folds into its base
  const cal = new Map(rows(db, 'CALENDAR').map((c) => [c.clndr_name, c]));
  assert.ok(!cal.has('Joiner'));
  const std = effectiveCalendars(rows(db, 'CALENDAR')).get(cal.get('Standard')!.clndr_id)!;
  assert.deepEqual(std.week[3], [{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
  assert.deepEqual(std.week[0], []);
  assert.equal(std.exceptions.size, 4);
  assert.equal(cal.get('Standard')!.default_flag, 'Y');
  const night = effectiveCalendars(rows(db, 'CALENDAR')).get(cal.get('Night')!.clndr_id)!;
  assert.deepEqual(night.week[1], [{ start: 1200, end: 1440 }]);
  // resources and assignments
  const rs = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_name, r]));
  assert.equal(rs.size, 2);
  assert.equal(rs.get('Joiner')!.rsrc_type, 'RT_Labor');
  assert.equal(rs.get('Joiner')!.clndr_id, '1');
  assert.equal(rs.get('Plasterboard')!.rsrc_type, 'RT_Mat');
  assert.equal(rows(db, 'RSRCRATE').find((r) => r.rsrc_id === rs.get('Joiner')!.rsrc_id)!.cost_per_qty, '45');
  const asg = rows(db, 'TASKRSRC');
  assert.equal(asg.length, 2);
  const j = asg.find((a) => a.rsrc_id === rs.get('Joiner')!.rsrc_id)!;
  assert.deepEqual([j.target_qty, j.act_reg_qty, j.remain_qty, j.target_qty_per_hr], ['160', '80', '80', '2']);
  // scheduling works on the imported project
  assert.equal(scheduleProjects(db, [p.proj_id]).ok, true);
});

test('an MPX file written by another tool maps onto P6 tables', () => {
  const mpx = [
    'MPX,Microsoft Project for Windows,4.0,ANSI',
    '10,$,0,2,",",.',
    '11,2,1,1,8,40,$0.00/h,$0.00/h,1,1',
    '12,0,0,480,/,:,am,pm,0,0',
    '20,Standard,0,1,1,1,1,1,0',
    '25,2,8:00am,12:00pm,1:00pm,5:00pm',
    '26,12/25/26,12/26/26,0',
    '30,Warehouse,,,Standard,03/02/26 8:00am,,0,03/02/26 8:00am',
    '41,40,49,1,41,42',
    '50,1,1,Crane,100%,$120.00/h',
    '61,90,98,1,3,40,91,68,70,58',
    '70,1,1,Civil,1,,,,,',
    '70,2,2,Excavate,2,5d,0,,,03/02/26 8:00am',
    '75,1,100%,40h,,0h,,,,,,,,1',
    '70,3,3,"Slab, ground floor",2,2w,4,03/16/26 8:00am,2SS+2d',
    '70,4,4,Done,1,0d,,,3',
  ].join('\r\n');
  const { db, findings } = parseMpx(mpx);
  assert.deepEqual(findings.filter((f) => f.severity === 'fatal' || f.severity === 'error'), []);
  const t = new Map(rows(db, 'TASK').map((x) => [x.task_name, x]));
  assert.equal(t.size, 3);
  assert.equal(t.get('Excavate')!.target_drtn_hr_cnt, '40');
  assert.equal(t.get('Excavate')!.act_start_date, '2026-03-02 08:00');
  assert.equal(t.get('Slab, ground floor')!.target_drtn_hr_cnt, '80');
  assert.equal(t.get('Slab, ground floor')!.cstr_type, 'CS_MSOA');
  assert.equal(t.get('Slab, ground floor')!.cstr_date, '2026-03-16 08:00');
  assert.equal(t.get('Done')!.task_type, 'TT_FinMile');
  assert.equal(rows(db, 'PROJWBS').filter((w) => w.proj_node_flag !== 'Y').map((w) => w.wbs_name).join(), 'Civil');
  const rels = rows(db, 'TASKPRED').map((r) => `${r.pred_task_id}>${r.task_id} ${r.pred_type} ${r.lag_hr_cnt}`).sort();
  assert.deepEqual(rels, ['2>3 PR_SS 16', '3>4 PR_FS 0']);
  const cal = effectiveCalendars(rows(db, 'CALENDAR')).get(rows(db, 'CALENDAR')[0].clndr_id)!;
  assert.deepEqual(cal.week[1], [{ start: 480, end: 720 }, { start: 780, end: 1020 }]);
  assert.equal(cal.exceptions.size, 2);
  assert.equal(rows(db, 'RSRCRATE')[0].cost_per_qty, '120');
  assert.equal(rows(db, 'TASKRSRC')[0].target_qty, '40');
  assert.equal(rows(db, 'TASKRSRC')[0].task_id, t.get('Excavate')!.task_id);
  assert.deepEqual(mpxRecords('70,"a ""b"", c",d\r\n', ','), [['70', 'a "b", c', 'd']]);
});

test('duration helpers', () => {
  assert.equal(isoDurationHours('PT40H0M0S'), 40);
  assert.equal(isoDurationHours('PT7H30M0S'), 7.5);
  assert.equal(isoDurationHours('-PT8H0M0S'), -8);
  assert.equal(isoDurationHours('P1DT2H'), 10);
  assert.equal(isoDurationHours('nonsense'), null);
  assert.equal(hoursToIso(7.5), 'PT7H30M0S');
  assert.equal(hoursToIso(0.333333), 'PT0H20M0S');
});

test('file format detection and routing', () => {
  const src = load('cleopatra elmohandesen.xer');
  const pid = rows(src, 'PROJECT')[0].proj_id;
  const xml = exportFile(src, 'mspdi', { version: '', projIds: [pid] });
  const mpx = exportFile(src, 'mpx', { version: '', projIds: [pid] });
  assert.equal(detectFormat('a.xml', xml), 'mspdi');
  assert.equal(detectFormat('a.xml', exportFile(src, 'xml', { version: '', projIds: [pid] })), 'xml');
  assert.equal(detectFormat('a.mpx', mpx), 'mpx');
  assert.equal(detectFormat('noext', mpx), 'mpx');
  assert.equal(detectFormat('a.mpp', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), 'mpp');
  assert.equal(parseFile('a.xml', xml).db.tables.TASK.rows.length, 92);
  assert.equal(parseFile('a.mpx', mpx).db.tables.TASK.rows.length, 92);
  assert.equal(parseFile('a.mpp', new Uint8Array(8)).findings[0].severity, 'fatal');
});

test('MPP bridge PowerShell script', () => {
  const s = buildConvertScript('mppToXml', "C:\\Users\\o'brien\\My $chedule.mpp", 'C:\\Temp\\out.xml');
  assert.ok(s.includes("$in = 'C:\\Users\\o''brien\\My $chedule.mpp'"), s);
  assert.ok(s.includes("$out = 'C:\\Temp\\out.xml'"));
  assert.ok(!s.includes('"'), 'no double quotes, so it survives -Command quoting');
  assert.ok(!/[\r\n]/.test(s), 'single line');
  for (const part of ['New-Object -ComObject MSProject.Application', '$app.Visible = $false', '$app.DisplayAlerts = $false', "'FileOpenEx' @($in, $true)", "'MSProject.XML')", '$app.FileCloseEx(0)', '$app.Quit(0)', 'exit 3']) assert.ok(s.includes(part), part);
  const back = buildConvertScript('xmlToMpp', 'C:\\a.xml', 'D:\\b.mpp');
  assert.ok(back.includes("'MSProject.MPP')"));
  assert.ok(back.includes("'FileOpenEx' @($in, $false, 'MSProject.XML') @('Name', 'ReadOnly', 'FormatID')"));
  assert.equal(psQuote("it's"), "'it''s'");
  assert.ok(convertError('mppToXml', 3, 'MSPROJECT_NOT_AVAILABLE: class not registered', false).startsWith(MSP_REQUIRED));
  assert.match(convertError('xmlToMpp', null, '', true), /did not finish within 120 s/);
});
