// Microsoft Project XML edited through the clone: open -> save gives the file back with everything the clone did not
// edit, element for element (notes, baselines, fixed costs, deadlines, contours, custom fields and their definitions,
// leaf WBS codes, initials, outline codes, timephased data, the project summary task, blank rows, unassigned
// assignments, resource calendars, elements Microsoft Project or other tools add) and with every UID kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { parseXml, type XNode } from '../core/xml/p6xml.ts';
import { applyOps } from '../core/project/ops.ts';
import { callTool, toolResult } from '../mcp/server.ts';

const FILE = join(import.meta.dirname, 'fixtures', 'rich-mspdi.xml');
/** Every leaf as path=value, in document order (whitespace between elements is formatting, not content). */
const canon = (n: XNode, path = ''): string[] => { const p = `${path}/${n.name}`; return n.children.length ? n.children.flatMap((c) => canon(c, p)) : [`${p}=${n.text.trim()}`]; };
const leaves = (xml: string) => canon(parseXml(xml));
/** Leaves only in a (-) and only in b (+). */
function diff(a: string[], b: string[]) {
  const count = (l: string[]) => l.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(a), cb = count(b), out: string[] = [];
  for (const [x, n] of ca) for (let i = cb.get(x) ?? 0; i < n; i++) out.push(`- ${x.replace('/#root/Project/', '')}`);
  for (const [x, n] of cb) for (let i = ca.get(x) ?? 0; i < n; i++) out.push(`+ ${x.replace('/#root/Project/', '')}`);
  return out.sort();
}

test('MSPDI: an untouched file comes back element for element, in order, every UID kept', () => {
  const src = readFileSync(FILE, 'utf8');
  const out = writeMspdi(parseMspdi(src).db);
  assert.deepEqual(leaves(out), leaves(src));
  // the things a blind review found stripped, by name
  for (const s of ['<Notes>Asbestos survey cleared 2026-02-20.</Notes>', '<Baseline><Number>1</Number>', '<FixedCost>1200</FixedCost>', '<FixedCostAccrual>3</FixedCostAccrual>', '<Deadline>2026-03-09T17:00:00</Deadline>',
    '<WorkContour>3</WorkContour>', '<Alias>Room</Alias>', '<Value>Rooms 201-210</Value>', '<WBS>1.1</WBS>', '<Initials>J</Initials>', '<Views>', '<Filters>', '<OutlineCodes>',
    '<UID>27</UID>', '<UID>31</UID>', '<ResourceUID>-65535</ResourceUID>', '<IsNull>1</IsNull>', '<Name>Clinic Fitout</Name>', '<TimephasedData><Type>2</Type>']) assert.ok(out.includes(s), s);
  assert.ok(!out.includes('P6 Activity ID'), 'the clone\'s own custom fields are not written into a customer\'s Text1');
});

test('MSPDI: edits change only what they touch; what changed is the clone\'s, everything else stays the file\'s', () => {
  const src = readFileSync(FILE, 'utf8');
  const { db } = parseMspdi(src);
  const r = applyOps(db, [
    { op: 'update_activity', id: 'uid:155', name: 'Partitions and doors', duration_days: 6 },
    { op: 'update_assignment', activity: 'uid:140', resource: 'J', remaining_units: 30 },
    { op: 'add_activity', id: 'N1', name: 'Snagging', wbs: '1', duration_days: 2 },
    { op: 'add_relationship', pred: 'uid:155', succ: 'N1' },
  ]);
  assert.equal(r.ok, true, r.error?.message ?? '');
  const out = writeMspdi(db);
  const d = diff(leaves(src), leaves(out));
  const removed = d.filter((x) => x.startsWith('-'));
  assert.deepEqual(removed, [
    // Partitions: name, duration and the dates it moves
    '- Assignments/Assignment/ActualCost=1200', '- Assignments/Assignment/Cost=4800', '- Assignments/Assignment/PercentWorkComplete=50', '- Assignments/Assignment/RemainingCost=3600', '- Assignments/Assignment/RemainingWork=PT40H0M0S',
    // the Joiner's work spread over time no longer holds: left for Microsoft Project to spread again
    '- Assignments/Assignment/TimephasedData/Finish=2026-03-03T08:00:00', '- Assignments/Assignment/TimephasedData/Start=2026-03-02T08:00:00', '- Assignments/Assignment/TimephasedData/Type=2', '- Assignments/Assignment/TimephasedData/UID=51', '- Assignments/Assignment/TimephasedData/Unit=2', '- Assignments/Assignment/TimephasedData/Value=PT16H0M0S',
    '- Assignments/Assignment/Work=PT80H0M0S',
    '- Tasks/Task/Duration=PT40H0M0S', '- Tasks/Task/EarlyFinish=2026-03-16T17:00:00', '- Tasks/Task/Finish=2026-03-16T17:00:00', '- Tasks/Task/Name=Partitions', '- Tasks/Task/RemainingDuration=PT40H0M0S',
  ]);
  // the edited task keeps what the clone did not edit (its baseline, custom field, constraint, link)
  const part = /<Task>(?:(?!<\/Task>)[\s\S])*<UID>155<\/UID>[\s\S]*?<\/Task>/.exec(out)![0];
  for (const s of ['<Name>Partitions and doors</Name>', '<Duration>PT48H0M0S</Duration>', '<Baseline><Number>0</Number>', '<Value>Rooms 201-206</Value>', '<ConstraintDate>2026-03-09T08:00:00</ConstraintDate>', '<PredecessorUID>140</PredecessorUID>']) assert.ok(part.includes(s), s);
  // the new activity: the clone's elements, an unused UID, the next ID, its place under "Fitout works"
  const added = d.filter((x) => x.startsWith('+ Tasks/Task/UID=') || x.startsWith('+ Tasks/Task/ID=') || x.startsWith('+ Tasks/Task/OutlineNumber=') || x.startsWith('+ Tasks/Task/Name='));
  assert.deepEqual(added, ['+ Tasks/Task/ID=6', '+ Tasks/Task/Name=Partitions and doors', '+ Tasks/Task/Name=Snagging', '+ Tasks/Task/OutlineNumber=1.3', '+ Tasks/Task/UID=1']);
  // read back: the UIDs and the kept elements survive a second round
  const again = writeMspdi(parseMspdi(out).db);
  assert.deepEqual(leaves(again), leaves(out));
});

test('MSPDI through MCP: F9 keeps Microsoft Project\'s dates until something that drives them changes, then says what it replaced', { timeout: 60_000 }, async () => {
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError).structuredContent as any; };
  const h = (await call('open_file', { path: FILE })).handle;
  const kept = await call('schedule', { handle: h });
  assert.deepEqual([kept.ok, kept.kept_msp_dates, kept.unsaved_changes], [true, ['Clinic Fitout'], false]);
  assert.equal((await call('get_activity', { handle: h, activity_id: 'uid:162' })).start, '2026-03-20 17:00');
  // saved through the server after that F9: the file as it was
  const out = join(mkdtempSync(join(tmpdir(), 'p6msp-')), 'clinic.xml');
  assert.equal((await call('save', { handle: h, path: out, format: 'mspdi' })).saved, out);
  assert.deepEqual(leaves(readFileSync(out, 'utf8')), leaves(readFileSync(FILE, 'utf8')));
  await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'uid:140', remaining_days: 4 }] });
  const sc = await call('schedule', { handle: h });
  assert.equal(sc.kept_msp_dates, undefined);
  const ch = sc.msp_dates_changed['Clinic Fitout'];
  assert.ok(ch.activities >= 1 && ch.changes.every((c: { source_uid: string; field: string; ms_project: string; now: string }) => c.source_uid && c.field && c.ms_project !== c.now), JSON.stringify(ch));
});

/** The file edited with `ops` (and `mutate`), saved: what changed (diff lines), the output, the save's report. */
function edited(ops: unknown[], mutate?: (db: ReturnType<typeof parseMspdi>['db']) => void, src = readFileSync(FILE, 'utf8')) {
  const { db } = parseMspdi(src);
  const r = applyOps(db, ops);
  assert.equal(r.ok, true, r.error?.message ?? '');
  mutate?.(db);
  const report: string[] = [];
  const out = writeMspdi(db, { report });
  return { out, d: diff(leaves(src), leaves(out)), report };
}
const taskXml = (xml: string, uid: string) => new RegExp(`<Task><UID>${uid}</UID>[\\s\\S]*?</Task>`).exec(xml.replace(/>\s+</g, '><'))![0];
const links = (xml: string) => xml.match(/<PredecessorLink>[\s\S]*?<\/PredecessorLink>/g) ?? [];
const calXml = (xml: string, uid: string) => new RegExp(`<Calendar><UID>${uid}</UID>[\\s\\S]*?</Calendar>`).exec(xml.replace(/>\s+</g, '><'))![0];

test('MSPDI links: an edit rewrites only the link it changed (type and lag, in its own lag format); the others stay as written', () => {
  const src = readFileSync(FILE, 'utf8');
  const { out, d } = edited([
    { op: 'update_relationship', pred: 'uid:155', succ: 'uid:162', lag_days: 1 }, // a percentage lag: 8 h of 40 h = 20 %
    { op: 'update_relationship', pred: 'uid:140', succ: 'uid:155', new_type: 'SS' },
    { op: 'delete_relationship', pred: 'uid:140', succ: 'uid:162' }, // the elapsed-lag link goes
  ]);
  assert.ok(d.every((x) => /\/PredecessorLink\//.test(x)), d.join('\n'));
  const before = links(taskXml(src, '155'));
  assert.deepEqual(links(taskXml(out, '155')), [before[0]!.replace('<Type>1</Type>', '<Type>3</Type>'), before[1], before[2]]); // summary and cross-project links as read
  assert.deepEqual(links(taskXml(out, '162')), ['<PredecessorLink><PredecessorUID>155</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>20</LinkLag><LagFormat>19</LagFormat></PredecessorLink>']);
  // untouched links of an edited task stay as written: the elapsed lag of 140 -> 162 when only 155 -> 162 changes
  const only = edited([{ op: 'update_relationship', pred: 'uid:155', succ: 'uid:162', lag_days: 2 }]);
  assert.deepEqual(links(taskXml(only.out, '162'))[1], links(taskXml(src, '162'))[1]);
  // an added link: the clone's, after the file's
  const add = edited([{ op: 'add_relationship', pred: 'uid:140', succ: 'uid:162', type: 'SS' }, { op: 'add_activity', id: 'N1', name: 'New', wbs: '1' }, { op: 'add_relationship', pred: 'N1', succ: 'uid:162' }]);
  const l = links(taskXml(add.out, '162'));
  assert.deepEqual([l.length, l[0], l[1]], [3, links(taskXml(src, '162'))[0], links(taskXml(src, '162'))[1]]);
});

test('MSPDI calendars: an edited calendar keeps its base, GUID, exception names and recurrences; only the changed days are written anew', () => {
  const src = readFileSync(FILE, 'utf8');
  const { out, d } = edited([
    { op: 'update_calendar', name: 'Standard', holidays: ['2026-03-27'], remove_exceptions: ['2026-04-25'] },
    { op: 'update_calendar', name: 'Night works', work_week: { sat: [['08:00', '13:00']] } },
  ]);
  assert.ok(d.every((x) => /^[-+] Calendars\/Calendar\/(WeekDays|Exceptions)\//.test(x)), d.join('\n'));
  const std = calXml(out, '11'), was = calXml(src, '11');
  for (const keep of ['<GUID>11111111-0000-4000-8000-000000000011</GUID>', '<Name>Site closed</Name>', /<WeekDays>[\s\S]*<\/WeekDays>/.exec(was)![0]]) assert.ok(std.includes(keep as string), String(keep));
  // the recurrence that covered the removed day goes on for its other days, under its own name; the new holiday is added
  assert.ok(!std.includes('<Type>4</Type>'));
  assert.deepEqual(std.match(/<FromDate>[^<]+<\/FromDate>[\s\S]*?<Name>[^<]+<\/Name>/g)!.map((x) => [x.slice(10, 20), /<Name>([^<]+)/.exec(x)![1]]),
    [['2026-03-13', 'Site closed'], ['2026-03-25', 'Monthly maintenance'], ['2026-05-25', 'Monthly maintenance'], ['2026-03-27', 'Nonworking']]);
  // a recurrence untouched by the edit stays a recurrence
  assert.ok(calXml(edited([{ op: 'update_calendar', name: 'Standard', holidays: ['2026-03-27'] }]).out, '11').includes('<Type>4</Type><Period>1</Period><MonthDay>25</MonthDay>'));
  const night = calXml(out, '15');
  for (const keep of ['<GUID>11111111-0000-4000-8000-000000000015</GUID>', '<IsBaseCalendar>0</IsBaseCalendar>', '<BaseCalendarUID>11</BaseCalendarUID>', '<Name>Permit day</Name>',
    '<WeekDay><DayType>7</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>13:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>']) assert.ok(night.includes(keep), keep);
  assert.equal((night.match(/<WeekDay>/g) ?? []).length, 1, 'the inherited days stay inherited');
});

test('MSPDI resources: a resource whose calendar changed keeps its own resource calendar, which now derives from the new one', () => {
  const { out, d } = edited([], (db) => {
    const night = db.tables.CALENDAR.rows.find((c) => c.clndr_name === 'Night works')!;
    db.tables.RSRC.rows.find((r) => r.rsrc_short_name === 'J')!.clndr_id = night.clndr_id;
  });
  assert.deepEqual(d, ['+ Calendars/Calendar/BaseCalendarUID=15', '- Calendars/Calendar/BaseCalendarUID=11']);
  assert.ok(calXml(out, '27').includes('<BaseCalendarUID>15</BaseCalendarUID>') && out.includes('<CalendarUID>27</CalendarUID>'));
});

test('MSPDI rows: a task added renumbers the rows below it, as Microsoft Project does (IDs are row numbers); UIDs and the blank row above stay', () => {
  const { out } = edited([{ op: 'add_activity', id: 'N1', name: 'Snagging', wbs: '1' }]);
  const rows = [...out.replace(/>\s+</g, '><').matchAll(/<Task><UID>(\d+)<\/UID>(?:<GUID>[^<]*<\/GUID>)?<ID>(\d+)<\/ID>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [['0', '0'], ['101', '1'], ['140', '2'], ['141', '3'], ['155', '4'], ['1', '5'], ['162', '6']]);
});

test('MSPDI WBS: a moved leaf keeps its WBS code under a WBS code mask; without one the code is the outline number, and the save says so', () => {
  const move = [{ op: 'update_activity', id: 'uid:162', wbs: '1' }];
  const masked = edited(move);
  assert.ok(taskXml(masked.out, '162').includes('<WBS>2</WBS><OutlineNumber>1.3</OutlineNumber><OutlineLevel>2</OutlineLevel>'));
  assert.deepEqual(masked.report, []);
  const plain = edited(move, undefined, readFileSync(FILE, 'utf8').replace(/<WBSMask>[\s\S]*?<\/WBSMask>/, ''));
  assert.ok(taskXml(plain.out, '162').includes('<WBS>1.3</WBS><OutlineNumber>1.3</OutlineNumber>'));
  assert.match(plain.report[0], /no WBS code mask[\s\S]*UID 162\) 2 -> 1\.3/);
});
