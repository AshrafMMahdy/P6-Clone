// The Extensions screens for Crashing, What-ifs and Time impact analysis call the engine exactly as their MCP tools do, so the screen
// always equals the tool and its Export (clone agent, 4L-13 round 1 item 3): days on each activity's own calendar (not the app's
// hours-per-day preference), LOB plan activities locked in crashing, the TIA baseline worked out the same way. Each panel's call is
// written here as the panel makes it (renderer/views/RecoveryPanels.tsx, DelayPanels.tsx) and compared with the tool's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { rows } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { baselineOf } from '../core/analysis/common.ts';
import { crashOptionsOf, crashSchedule } from '../core/analysis/crash.ts';
import { evaluateBatch } from '../core/analysis/batch.ts';
import { tiaBaseline, timeImpact } from '../core/analysis/delay.ts';
import { sessions, setRoots } from '../mcp/runtime.ts';

setRoots(null, tmpdir());
const { callTool, toolResult } = await import('../mcp/server.ts');
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
const HPD = 8; // the app's hours-per-day preference (the Export passes it to the tool's session too)
/** the engine's answer as JSON carries it (no undefined fields) */
const json = (x: unknown) => JSON.parse(JSON.stringify(x));
/** the tool's answer is the engine's, field for field, besides what the tool says of its session (`own`) */
const sameAs = (tool: Record<string, unknown>, engine: Record<string, unknown>, what: string, own: string[]) => {
  const e = json(engine);
  assert.deepEqual(Object.keys(tool).filter((k) => !(k in e)).sort(), own.sort(), `${what}: only the tool's own fields are added`);
  for (const [k, v] of Object.entries(e)) assert.deepEqual(tool[k], v, `${what}: ${k}`);
};

/** A CPM project P and its activities on a 10-hour calendar (days there are not the preference's 8 hours), saved as its own baseline; with lob, beside
 *  it an LOB plan TOWER that finishes later, so its activities drive the file's finish. */
async function file(lob = true) {
  const np = (await call('new_project', { id: 'P', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const ten = { mon: [['07:00', '12:00'], ['13:00', '18:00']], tue: [['07:00', '12:00'], ['13:00', '18:00']], wed: [['07:00', '12:00'], ['13:00', '18:00']], thu: [['07:00', '12:00'], ['13:00', '18:00']], fri: [['07:00', '12:00'], ['13:00', '18:00']] };
  const e = await call('edit', { handle: h, owner_key, operations: [
    { op: 'add_calendar', name: 'Ten', work_week: ten }, { op: 'set_project', project: 'P', calendar: 'Ten' }, // (a fragnet activity takes the project's calendar)
    { op: 'add_activity', id: 'A', name: 'A', duration_days: 5, calendar: 'Ten' },
    { op: 'add_activity', id: 'B', name: 'B', duration_days: 8, calendar: 'Ten' },
    { op: 'add_activity', id: 'C', name: 'C', duration_days: 4, calendar: 'Ten' },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'C' },
  ] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  assert.equal((await call('schedule', { handle: h, owner_key })).err, false);
  assert.equal((await call('edit', { handle: h, owner_key, operations: [{ op: 'save_baseline', project: 'P', name: 'Plan', assign_as: 'project' }] })).err, false);
  const plan = lob ? await call('lob_create', { handle: h, owner_key, id: 'TOWER', start: '2026-03-02', locations: { levels: ['Floor'], grid: [6] }, tasks: [
    { code: 'CS', name: 'Concrete skeleton', trade: 'Concrete', level: 'Floor', unit: 'm3', consumption: 9, quantity: 60, crew_size: 18 },
    { code: 'DW', name: 'Drywall', trade: 'Drywall', level: 'Floor', unit: 'm2', consumption: 0.5, quantity: 1400, crew_size: 16 },
  ], links: [{ pred: 'CS', succ: 'DW' }] }) : null;
  if (plan) assert.equal(plan.err, false, JSON.stringify(plan.d).slice(0, 300));
  const db = sessions.get(h)!.db;
  const cpm = rows(db, 'PROJECT').find((p) => p.proj_short_name === 'P')!;
  const all = rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  return { h, db, cpm, all };
}

test('Crashing: the panel locks the LOB plan’s activities as crash_schedule does, so the screen is the tool’s answer', async () => {
  const { h, db, all } = await file();
  // the panel's arguments (what Export gives the tool), all the projects of the file open
  const args = { target_days: 5, default_max_pct: 30 };
  const screen = await crashSchedule(db, all, crashOptionsOf(db, args, HPD));
  const tool = await call('crash_schedule', { handle: h, ...args });
  assert.equal(tool.err, false, JSON.stringify(tool.d).slice(0, 300));
  assert.ok(screen.ok);
  // (field_changes is the engine's input to the fields an apply writes beside each activity, a8b25c5: the tool does not answer it, and the screen does not show it)
  const { field_changes: forFields, ...shown } = screen;
  assert.ok(Array.isArray(forFields) && tool.d.field_changes === undefined);
  sameAs(tool.d, shown, 'crash_schedule', ['unsaved_changes']);
  // (why it matters here: without the lock the engine crashes the LOB plan's activities, which the tool never does)
  const unlocked = await crashSchedule(db, all, { targetDays: 5, defaultMaxPct: 30, hoursPerDay: HPD });
  assert.ok(unlocked.ok && unlocked.ops.some((o) => /^(CS|DW)-/.test(String(o.id))), JSON.stringify(unlocked.ok && unlocked.ops).slice(0, 300));
  assert.ok(!screen.ops.some((o) => /^(CS|DW)-/.test(String(o.id))), 'no LOB activity crashed on the screen');
});

test('What-ifs: the panel counts days on each activity’s calendar as evaluate_batch does, so the screen is the tool’s answer', async () => {
  const { h, db, cpm } = await file();
  const scenarios = [{ name: 'B longer', overrides: [{ op: 'update_activity', id: 'B', duration_days: 12 }] }, { name: 'A shorter', overrides: [{ op: 'update_activity', id: 'A', duration_days: 2 }] }];
  const screen = await evaluateBatch(db, [cpm.proj_id], scenarios, { hoursPerDay: HPD });
  const tool = await call('evaluate_batch', { handle: h, project: 'P', scenarios });
  assert.equal(tool.err, false, JSON.stringify(tool.d).slice(0, 300));
  assert.ok(screen.ok);
  sameAs(tool.d, screen, 'evaluate_batch', ['parts_removed']); // (a finished batch names the kept file it removed)
  // (why it matters here: days at the preference's 8 hours on a 10-hour calendar are other durations)
  const atPreference = await evaluateBatch(db, [cpm.proj_id], scenarios, { hoursPerDay: HPD, calendarDays: false });
  assert.ok(atPreference.ok);
  assert.notDeepEqual(json(atPreference.scenarios), json(screen.scenarios));
});

test('Time impact analysis: the panel counts the fragnet’s days on the activities’ calendars and works the baseline out as tia does, so the screen is the tool’s answer', async () => {
  const { h, db, cpm } = await file(false); // (the panel's fragnet names no project: a file of one project)
  // the panel's arguments (what Export gives the tool): a fragnet on the 10-hour calendar's path, a data date, a milestone, the project baseline
  const a = { project: 'P', fragnet: [{ op: 'add_activity', id: 'TIA-01', name: 'Delay event', duration_days: 10 }, { op: 'add_relationship', pred: 'A', succ: 'TIA-01', type: 'FS', lag_days: 0 }, { op: 'add_relationship', pred: 'TIA-01', succ: 'C', type: 'FS', lag_days: 0 }], data_date: '2026-03-02 07:00', milestone: 'C', baseline: 'project' };
  const b = baselineOf(db, cpm, a.baseline)!;
  const screen = timeImpact(db, [cpm.proj_id], a.fragnet, { dataDate: parseP6Date(a.data_date) ?? undefined, milestone: a.milestone, hoursPerDay: HPD, baseline: tiaBaseline(b, a.milestone, parseP6Date) });
  const tool = await call('tia', { handle: h, ...a });
  assert.equal(tool.err, false, JSON.stringify(tool.d).slice(0, 300));
  assert.ok(screen.ok);
  sameAs(tool.d, screen, 'tia', ['unsaved_changes']);
  // (why it matters here: the fragnet's 10 days at the preference's 8 hours are 8 days of the 10-hour calendar)
  const atPreference = timeImpact(db, [cpm.proj_id], a.fragnet, { dataDate: parseP6Date(a.data_date) ?? undefined, milestone: a.milestone, hoursPerDay: HPD, calendarDays: false, baseline: tiaBaseline(b, a.milestone, parseP6Date) });
  assert.ok(atPreference.ok);
  assert.notEqual(atPreference.delay_days, screen.delay_days);
});

test('Time impact analysis: with two projects open the screen’s fragnet names the open project, so it runs (without it the engine asks "say which with project")', async () => {
  const { tiaFragnetOps } = await import('../renderer/views/tiaFragnet.ts');
  const { applyOps } = await import('../core/project/ops.ts');
  const { h, db, cpm } = await file(false);
  // a second project with the same Activity IDs open beside P (what a kept TIA, or a copy, is)
  const c = applyOps(db, [{ op: 'copy_project', from: 'P', id: 'P2', keep_progress: true }], { hoursPerDay: HPD, calendarDays: true });
  assert.ok(c.ok, JSON.stringify(c.error));
  // the panel's own rows, as it ships them
  const acts = [{ id: 'TIA-01', name: 'Delay event', days: '10' }];
  const rels = [{ pred: 'A', succ: 'TIA-01', type: 'FS', lag: '0' }, { pred: 'TIA-01', succ: 'C', type: 'FS', lag: '0' }, { pred: '', succ: 'C', type: 'FS', lag: '0' }];
  const ops = tiaFragnetOps(acts, rels, cpm.proj_short_name);
  assert.equal(ops.length, 3, 'the row with no predecessor is not sent');
  assert.ok(ops.every((o) => o.project === 'P'), 'every operation names the open project');
  const screen = timeImpact(db, [cpm.proj_id], ops, { hoursPerDay: HPD });
  assert.ok(screen.ok, JSON.stringify(screen).slice(0, 300));
  // the tool, given the same arguments (what Export writes), answers the same
  const tool = await call('tia', { handle: h, project: 'P', fragnet: ops });
  assert.equal(tool.err, false, JSON.stringify(tool.d).slice(0, 300));
  sameAs(tool.d, screen, 'tia', ['unsaved_changes']);
  // what the screen sent before: no project on the operations
  const before = timeImpact(db, [cpm.proj_id], ops.map(({ project: _p, ...o }) => o), { hoursPerDay: HPD });
  assert.equal(before.ok, false);
  assert.match(JSON.stringify(before), /say which with \\"project\\"/);
});
