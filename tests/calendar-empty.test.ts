// A calendar with no clndr_data (the platform's Polaris and Aurora seeds' "Standard 5-Day") is the week P6 gives it
// from its hours per day and week: update_calendar on it writes that week out in full plus the change, and F9 moves
// only what the change touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseXer } from '../core/xer/parse.ts';
import { writeXer } from '../core/xer/write.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { defaultCalendarDef, parseClndrData, standardCalendar } from '../core/calendar/clndr-data.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { callTool, toolResult } from '../mcp/server.ts';
import { rows, type Db } from '../core/db.ts';

const SEEDS = ['seed-polaris.xer', 'seed-aurora.xer'].map((f) => join(import.meta.dirname, 'fixtures', f));
const open = (f: string) => parseXer(new Uint8Array(readFileSync(f))).db;
/** F9, then each activity's early dates by Activity ID. */
function f9(db: Db) {
  assert.equal(scheduleProjects(db, rows(db, 'PROJECT').map((p) => p.proj_id)).ok, true);
  return new Map(rows(db, 'TASK').map((t) => [t.task_code, `${t.early_start_date} ${t.early_end_date}`]));
}
const changed = (a: Map<string, string>, b: Map<string, string>) => [...a].filter(([k, v]) => b.get(k) !== v).map(([k]) => k);

test('the default week of a calendar without data: its hours per day on its days a week; 8 h x 5 is the standard week', () => {
  assert.deepEqual(defaultCalendarDef('8.0', '40.0'), standardCalendar());
  assert.deepEqual(defaultCalendarDef('', ''), standardCalendar());
  const six = defaultCalendarDef(10, 60);
  assert.deepEqual(six.week.map((d) => d.reduce((x, s) => x + s.end - s.start, 0) / 60), [0, 10, 10, 10, 10, 10, 10]);
});

for (const file of SEEDS) {
  test(`${file.split('/').pop()}: update_calendar on its empty "Standard 5-Day" succeeds, writes a full week, and F9 moves only what it changed`, () => {
    const db = open(file);
    const cal = () => rows(db, 'CALENDAR').find((c) => c.clndr_name === 'Standard 5-Day')!;
    assert.equal(cal().clndr_data, '');
    const before = f9(db);
    // a change of nothing but the name: the full week is written, and F9 agrees with before on every activity
    assert.equal(applyOps(db, [{ op: 'update_calendar', name: 'Standard 5-Day', new_name: 'Standard 5-Day' }]).ok, true);
    assert.deepEqual(parseClndrData(cal().clndr_data).week, standardCalendar().week);
    assert.deepEqual(changed(before, f9(db)), []);
    // a holiday mid-way: only what is scheduled across or after it moves
    const starts = [...before.values()].map((v) => parseP6Date(v.split(' ').slice(0, 2).join(' '))!).sort((x, y) => x - y);
    let hol = Math.floor(starts[Math.floor(starts.length / 2)] / 1440) * 1440;
    while ([0, 6].includes(new Date(hol * 60000).getUTCDay())) hol += 1440;
    const r = applyOps(db, [{ op: 'update_calendar', name: 'Standard 5-Day', holidays: [formatP6Date(hol).slice(0, 10)] }]);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const after = f9(db), moved = changed(before, after);
    assert.ok(moved.length > 0 && moved.length < before.size, `${moved.length} of ${before.size} moved`);
    for (const [k, v] of before) {
      const end = parseP6Date(v.split(' ').slice(2).join(' '));
      if (end != null && end <= hol) assert.equal(after.get(k), v, `${k} finishes before the holiday: unchanged`);
    }
    // one day's hours: Friday mornings only; the other days of the week stay as they were
    assert.equal(applyOps(db, [{ op: 'update_calendar', name: 'Standard 5-Day', work_week: { fri: [['08:00', '12:00']] } }]).ok, true);
    const wk = parseClndrData(cal().clndr_data).week;
    assert.deepEqual(wk.slice(1, 5), standardCalendar().week.slice(1, 5));
    assert.deepEqual(wk[5], [{ start: 480, end: 720 }]);
    const edited = f9(db);
    // the saved XER opens again and schedules the same
    const back = parseXer(writeXer(db, { version: '19.12' })).db;
    assert.deepEqual(changed(edited, f9(back)), []);
  });
}

test('MCP: update_calendar on a seed\'s empty calendar, schedule, save, re-open: the same dates', { timeout: 60_000 }, async () => {
  const call = async (name: string, a: Record<string, unknown>) => toolResult((await callTool(name, a)).out, false).structuredContent as any;
  const o = await call('open_file', { path: SEEDS[0], lenient: true });
  assert.ok(o.handle, JSON.stringify(o).slice(0, 300));
  const s0 = await call('schedule', { handle: o.handle });
  const e = await call('edit', { handle: o.handle, operations: [{ op: 'update_calendar', name: 'Standard 5-Day', holidays: ['2026-03-04'], work_week: { fri: [['08:00', '12:00']] } }] });
  assert.equal(e.ok, true, JSON.stringify(e));
  const s1 = await call('schedule', { handle: o.handle });
  assert.equal(s1.ok, true);
  assert.ok(s1.finish > s0.finish, `${s0.finish} -> ${s1.finish}`);
  const path = join(mkdtempSync(join(tmpdir(), 'p6cal-')), 'polaris.xer');
  await call('save', { handle: o.handle, path });
  const re = await call('open_file', { path });
  const s2 = await call('schedule', { handle: re.handle });
  assert.equal(s2.finish, s1.finish);
  const t1 = await call('activity_table', { handle: o.handle }), t2 = await call('activity_table', { handle: re.handle });
  assert.deepEqual(t2.rows.map((r: unknown[]) => r.slice(0, 7)), t1.rows.map((r: unknown[]) => r.slice(0, 7)));
  for (const h of [o.handle, re.handle]) await call('close', { handle: h, discard: true });
});
