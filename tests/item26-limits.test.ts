// Item 26 (owner 2026-11-28, the nine rules): the loop guards with no count, numbers sent as text refused by the edit
// operations, the command line's defaults said and its wrong input refused, and the list rule on the edit and review answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { calendarResolver, scheduleProjects } from '../core/schedule/cpm.ts';
import { effectiveCalendars } from '../core/msp/shared.ts';
import { reviewSchedule, reviewText } from '../core/query/review.ts';
import { evaluate } from '../core/query/evaluate.ts';
import { writeXer } from '../core/xer/write.ts';
import { LISTED } from '../core/notes.ts';
import type { Finding } from '../core/findings.ts';
import * as B from './benchmark-fixtures.ts';
import { SAMPLES_DIR, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const CLI = join(import.meta.dirname, '..', 'cli', 'p6clone.ts');
const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
/** a chain of n activities, scheduled */
const chain = (n: number) => B.project('CH', Array.from({ length: n }, (_, i) => ({ id: `A${i + 1}`, duration_days: 2, predecessors: i ? [`A${i}`] : [] })));

// ------------------------------------------------------------------------------------------------ loop guards (C2)

test('a calendar base chain that loops back stops at the loop and is said; a long chain is followed to its end (no count)', () => {
  const b = chain(2);
  const C = rows(b.db, 'CALENDAR')[0];
  // twelve calendars, each based on the next (the old guard stopped at 10 bases), the last on the first: a loop
  const cal = (i: number) => ({ ...C, clndr_id: `90${i}`, clndr_name: `Cal ${i}`, default_flag: 'N', base_clndr_id: i < 11 ? `90${i + 1}` : '900' });
  b.db.tables.CALENDAR.rows.push(...Array.from({ length: 12 }, (_, i) => cal(i)));
  const findings: Finding[] = [];
  const r = calendarResolver(b.db, findings);
  assert.ok(r.get('900'), 'resolved');
  const loop = findings.filter((f) => f.code === 'SCHED_CAL_BASE_LOOP');
  assert.equal(loop.length, 1, JSON.stringify(findings));
  assert.match(loop[0].message, /^The base calendars of Cal 0, Cal 1, .+, Cal 11 name each other in a loop: calendar Cal 11 inherits no holidays from its base\.$/);
  // a calendar that is its own base: said the same way
  const own: Finding[] = [];
  b.db.tables.CALENDAR.rows.push({ ...C, clndr_id: '990', clndr_name: 'Self', default_flag: 'N', base_clndr_id: '990' });
  calendarResolver(b.db, own).get('990');
  assert.match(own.find((f) => f.code === 'SCHED_CAL_BASE_LOOP')!.message, /Self name each other in a loop: calendar Self inherits no holidays/);
  // the Microsoft Project side: a loop of base calendars ends too
  const defs = effectiveCalendars(b.db.tables.CALENDAR.rows);
  assert.ok(defs.get('905'));
});

test('a WBS whose parent chain loops back: the calculation ends, and a deep WBS (over 200 levels) is followed to its root', () => {
  const b = chain(3);
  const W = b.db.tables.PROJWBS, root = W.rows.find((w) => w.proj_node_flag === 'Y')!;
  // 250 levels under the root, the activities filed at the bottom, and a WBS summary activity at the top
  let parent = root.wbs_id;
  for (let i = 0; i < 250; i++) { W.rows.push({ ...root, wbs_id: `W${i}`, parent_wbs_id: parent, proj_node_flag: 'N', wbs_short_name: `L${i}`, wbs_name: `Level ${i}` }); parent = `W${i}`; }
  for (const t of rows(b.db, 'TASK')) t.wbs_id = 'W249';
  assert.ok(applyOps(b.db, [{ op: 'add_activity', id: 'S', name: 'Summary', type: 'wbs_summary', duration_days: 0 }], { calendarDays: true }).ok);
  rows(b.db, 'TASK').find((t) => t.task_code === 'S')!.wbs_id = 'W0';
  assert.ok(scheduleProjects(b.db, [b.projId], {}).ok);
  const S = rows(b.db, 'TASK').find((t) => t.task_code === 'S')!, A1 = rows(b.db, 'TASK').find((t) => t.task_code === 'A1')!, A3 = rows(b.db, 'TASK').find((t) => t.task_code === 'A3')!;
  assert.equal(S.early_start_date, A1.early_start_date, 'the summary 249 levels up spans its activities');
  assert.equal(S.early_end_date, A3.early_end_date);
  // a loop: W5's parent is W200
  W.rows.find((w) => w.wbs_id === 'W5')!.parent_wbs_id = 'W200';
  const r = scheduleProjects(b.db, [b.projId], {});
  assert.ok(r.ok, 'ends');
});

// ------------------------------------------------------------------------------------------------ edit operations (C8)

test('edit: a number sent as text is refused, naming the field and the quotes; max_length must be a whole number from 1 to 60', () => {
  const b = chain(2);
  const r = applyOps(b.db, [{ op: 'update_activity', id: 'A1', duration_days: '15' }], { calendarDays: true });
  assert.equal(r.ok, false);
  assert.equal(r.error!.message, '"duration_days" must be a number ("15" is text: send it without quotes).');
  assert.equal(applyOps(b.db, [{ op: 'update_activity', id: 'A1', duration_days: 'abc' }], { calendarDays: true }).error!.message, '"duration_days" must be a number.');
  assert.ok(applyOps(b.db, [{ op: 'update_activity', id: 'A1', duration_days: 15 }], { calendarDays: true }).ok);
  for (const v of [0, 2.5, 61]) {
    const x = applyOps(b.db, [{ op: 'add_code_type', name: `T${v}`, max_length: v }], { calendarDays: true });
    assert.equal(x.ok, false, String(v));
    assert.match(x.error!.message, v === 61 ? /max_length 61 is more than P6 allows for a code value \(60\)\./ : /max_length must be a whole number from 1 to 60\./);
  }
  assert.ok(applyOps(b.db, [{ op: 'add_code_type', name: 'Ok', max_length: 12 }], { calendarDays: true }).ok);
});

// ------------------------------------------------------------------------------------------------ the list rule in answers

test('edit through the server: the results of a long operation list are cut by the list rule, with results_total and the whole answer in a file', async () => {
  const o = await call('new_project', { currency: 'USD', id: 'LST', start: '2026-06-01' });
  const ops = Array.from({ length: 40 }, (_, i) => ({ op: 'add_activity', id: `T${i}`, name: `T${i}`, duration_days: 1 }));
  const r = await call('edit', { handle: o.d.handle, owner_key: o.d.owner_key, operations: ops });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.applied, 40);
  assert.equal(r.d.results.length, LISTED);
  assert.equal(r.d.results_total, 40);
  assert.match(r.d.results_note, /^25 of 40 shown; all 40 in .+edit-result-.+\.json\.$/);
  const whole = JSON.parse(readFileSync(/ in (.+\.json)\.$/.exec(r.d.results_note)![1], 'utf8'));
  assert.equal(whole.results.length, 40);
  // a short list: whole, no total, no note
  const short = await call('edit', { handle: o.d.handle, owner_key: o.d.owner_key, operations: ops.slice(0, 3).map((x) => ({ ...x, id: `${x.id}b`, name: `${x.name}b` })) });
  assert.equal(short.d.results.length, 3);
  assert.equal('results_total' in short.d, false);
});

test('evaluate (core) lists every changed activity (the old 500 is gone); the review text lists 25 examples a check and says how many more', () => {
  const b = chain(600);
  const ev = evaluate(b.db, [b.projId], { overrides: [{ op: 'update_activity', id: 'A1', duration_days: 5 }] });
  assert.equal(ev.ok, true);
  if (ev.ok) { assert.equal(ev.changed_total, 600); assert.equal(ev.changed.length, 600); }
  // 60 activities with no logic: the open-ends check lists them all as examples; the text shows 25 and the rest's count
  const loose = B.project('LOOSE', Array.from({ length: 60 }, (_, i) => ({ id: `L${i}`, duration_days: 2 })));
  const r = reviewSchedule(loose.db, { calendarDays: true });
  const c = r.checks.find((x) => x.examples.length > LISTED && x.grade !== 'pass' && x.grade !== 'not_assessed')!;
  assert.ok(c, 'a check with many examples');
  const text = reviewText(r);
  assert.ok(text.includes(`      … and ${c.examples.length - LISTED} more (--json lists them all)`), text.slice(0, 2000));
});

// ------------------------------------------------------------------------------------------------ the command line (D1-D7)

test('command line: wrong --hours-per-day and an unknown --project are refused; export and new say the defaults they used; a cut cell is said', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i26-'));
  const src = join(SAMPLES_DIR, 'CfC.xer');
  for (const v of ['abc', '0', '25', '-3']) {
    const r = cli('review', src, '--hours-per-day', v);
    assert.equal(r.status, 70, v);
    assert.equal(r.stderr.trim(), `--hours-per-day must be a number of hours above 0 and at most 24 (got "${v}").`);
  }
  const q = cli('query', src, 'find', '--project', 'NOPE');
  assert.equal(q.status, 70);
  assert.match(q.stderr, /^No project "NOPE" in .+CfC\.xer; its Project IDs: .+\.\n$/);
  // export: an XER keeps the version it was read with (not 19.12); a P6 XML with no --version says it is 19.12
  const head = (f: string) => readFileSync(f, 'utf8').split('\n')[0].split('\t')[1];
  const outX = join(dir, 'a.xer'), outM = join(dir, 'a.xml');
  const ex = cli('export', src, '--out', outX);
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(head(outX), head(src));
  assert.doesNotMatch(ex.stdout, /Written as/);
  const xm = cli('export', src, '--format', 'xml', '--out', outM);
  assert.match(xm.stdout, /^Written as P6 XML version 19\.12, the version given when none is asked \(--version for another\): a P6 older than 19\.12 may refuse it\.$/m);
  assert.equal(cli('export', src, '--format', 'mpp', '--out', outM).stderr.trim(), '--format must be xer or xml (got "mpp").');
  // a file with no version (made by new): the XER is 7.0, and that is said
  const fresh = join(dir, 'n.xer');
  const n = cli('new', '--out', fresh, '--currency', 'USD');
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, /^Created project NEW in .+n\.xer \(no --id given: the Project ID is NEW\), starting \d{4}-\d{2}-\d{2} \(no --start given: today\)$/m);
  assert.match(n.stderr, /Written as XER 7\.0, as the project had no P6 version/);
  // a cell longer than 40 characters: the table says it was cut and where the whole is
  const db = B.project('CUT', [{ id: 'A1', name: 'An activity whose name is well over forty characters long', duration_days: 2 }]).db;
  const f = join(dir, 'cut.xer');
  writeFileSync(f, writeXer(db, { version: '19.12' }));
  const t = cli('query', f, 'find');
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^\s*\(cells longer than 40 characters are cut here; --json gives them whole\)$/m);
  assert.match(cli('query', f, 'find', '--json').stdout, /An activity whose name is well over forty characters long/);
});
