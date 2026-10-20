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
