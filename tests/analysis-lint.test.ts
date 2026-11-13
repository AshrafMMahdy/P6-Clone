import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { DEFAULT_LINT_THRESHOLDS, lintSchedule, lintScheduleTicked } from '../core/analysis/lint.ts';
import { scheduleLogReport } from '../core/analysis/scheduleLog.ts';
import { testRoots } from './helpers.ts';

testRoots(); // (the analysis tools' result files go to the run's temporary folder, never into the repository)

const ok = (db: Db, ops: unknown[]) => { const r = applyOps(db, ops); assert.ok(r.ok, JSON.stringify(r.error)); };
const pid = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;

function build(): Db {
  const db: Db = { tables: {} };
  ok(db, [
    { op: 'add_project', id: 'L', start: '2026-03-02' },
    { op: 'add_wbs', code: 'STR', name: 'Structure' }, { op: 'add_wbs', code: 'EMPTY', name: 'Nothing here' },
    { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' },
    { op: 'add_activity', id: 'A', name: 'Excavate', duration_days: 5, wbs: 'STR' },
    ...[1, 2, 3, 4].map((n) => ({ op: 'add_activity', id: `F${n}`, name: `Floor ${n} slab`, duration_days: 5, wbs: 'STR' })),
    { op: 'add_activity', id: 'B', name: 'Procure', duration_days: 10 },
    { op: 'add_activity', id: 'G', name: 'Install', duration_days: 3 },
    { op: 'add_activity', id: 'K', name: 'Survey', duration_days: 3 },
    { op: 'add_activity', id: 'Q', name: 'Check', duration_days: 2 },
    { op: 'add_activity', id: 'D', name: 'Only FF in', duration_days: 2 },
    { op: 'add_activity', id: 'X', name: 'Only SS out', duration_days: 2 },
    { op: 'add_activity', id: 'Z', name: 'Zero task', duration_days: 0 },
    { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'S', succ: 'A' },
    { op: 'add_relationship', pred: 'A', succ: 'F1' }, { op: 'add_relationship', pred: 'F1', succ: 'F2' }, { op: 'add_relationship', pred: 'F2', succ: 'F3' }, { op: 'add_relationship', pred: 'F3', succ: 'F4' }, { op: 'add_relationship', pred: 'F4', succ: 'H' },
    { op: 'add_relationship', pred: 'S', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'G', lag_days: -2 }, { op: 'add_relationship', pred: 'G', succ: 'H' },
    { op: 'add_relationship', pred: 'S', succ: 'K' }, { op: 'add_relationship', pred: 'K', succ: 'Q', type: 'SS', lag_days: 4 }, { op: 'add_relationship', pred: 'Q', succ: 'H' },
    { op: 'add_relationship', pred: 'A', succ: 'D', type: 'FF' }, { op: 'add_relationship', pred: 'D', succ: 'H' },
    { op: 'add_relationship', pred: 'A', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'H', type: 'SS' },
    { op: 'add_relationship', pred: 'A', succ: 'Z' }, { op: 'add_relationship', pred: 'Z', succ: 'H' },
  ]);
  const r = scheduleProjects(db, [pid(db)]); assert.ok(r.ok, r.log);
  return db;
}
const ids = (c: { activities: { id: string }[] }) => c.activities.map((a) => a.id);

test('lint (P6 profile): dangling start/finish, FS overlaps with fixes and days saved, empty WBS, zero-duration task', () => {
  const db = build();
  const r = lintSchedule(db);
  const c = (id: string) => r.checks.find((x) => x.id === id)!;
  assert.equal(r.profile, 'p6');
  assert.equal(r.score, undefined, 'no score in the P6 profile');
  assert.deepEqual(ids(c('dangling_start')), ['D']);
  assert.deepEqual(ids(c('dangling_finish')), ['K', 'X'], 'K and X only have SS successors');
  assert.deepEqual(ids(c('empty_wbs')), ['EMPTY']);
  assert.deepEqual(ids(c('milestone_duration')), ['Z']);
  const ov = c('fs_overlap');
  const fixes = ov.fixes!;
  const lead = fixes.find((f) => f.activities.join() === 'B,G')!;
  assert.deepEqual(lead.ops, [{ op: 'update_relationship', pred: 'B', succ: 'G', type: 'FS', new_type: 'SS', lag_days: 8 }]);
  const ss = fixes.find((f) => f.activities.join() === 'K,Q')!;
  assert.deepEqual(ss.ops, [{ op: 'update_relationship', pred: 'K', succ: 'Q', type: 'SS', new_type: 'FS', lag_days: 1 }]);
  const ladder = fixes.find((f) => f.activities.length === 4)!;
  assert.match(ladder.fix, /Floor 1 slab/);
  assert.equal(ladder.ops.length, 3);
  assert.ok(ladder.saves_days! > 0, `the ladder fix saves days (${ladder.saves_days})`);
  // applying the fixes works as edit operations, and lint was read-only
  assert.equal(rows(db, 'TASKPRED').filter((p) => p.pred_type === 'PR_SS').length, 2);
  const applied = applyOps(db, [...lead.ops, ...ladder.ops]);
  assert.ok(applied.ok, JSON.stringify(applied.error));
});

test('lint (platform profile): graded network metrics with a score and grade', () => {
  const db = build();
  const r = lintSchedule(db, { profile: 'platform' });
  assert.ok(typeof r.score === 'number' && r.score >= 0 && r.score <= 100);
  assert.match(r.grade!, /^(A\+|A|B\+|B|C\+|C|D|F)$/);
  for (const id of ['connectivity', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse', 'start_anchored'])
    assert.ok(r.checks.some((x) => x.id === id), id);
  const conn = r.checks.find((x) => x.id === 'connectivity')!;
  assert.equal(conn.band, 'pass', 'one start (S) and one finish (H)');
});

test('lint thresholds: the defaults named in the answer, overrides per call (snake_case or the platform\'s camelCase), each check with what it applied', () => {
  const db = build();
  const base = lintSchedule(db, { profile: 'platform', simulate: false });
  assert.deepEqual([base.thresholds, base.overridden, base.not_used], [DEFAULT_LINT_THRESHOLDS, [], undefined]);
  const c = (r: typeof base, id: string) => r.checks.find((x) => x.id === id)!;
  assert.deepEqual(c(base, 'serialization').applied, { pass: [0.08, 0.7], warn: [0.05, 0.9], small_network: true, weight: 15 }, 'a small network: the small bands');
  assert.deepEqual(c(base, 'dangling_start').applied, { max: 0 });
  assert.equal(c(base, 'dangling_start').band, 'fail');
  assert.ok(c(base, 'fs_overlap').fixes!.some((f) => f.activities.join() === 'B,G'), 'the 2-day lead is flagged');
  assert.ok(c(base, 'fs_overlap').fixes!.some((f) => f.activities.length === 4), 'the floor ladder');

  const r = lintSchedule(db, { profile: 'platform', simulate: false, thresholds: {
    dangling_start: { max: 1 }, fs_overlap: { max_lead_days: 2 }, ladder: { minGroupSize: 5 },
    smallNetworkBelow: 5, nonFs: { pass: [0, 1], warn: [0, 1] }, criticality: { pass: [0.9, 1], warn: [0.8, 1] },
    weights: { criticality_ratio: 50 }, grades: { PASS: 50, FAIL: 0 }, stretches: { maxReported: 3 },
  } });
  assert.deepEqual(r.overridden, ['dangling_start.max', 'fs_overlap.max_lead_days', 'ladder.min_group_size', 'small_network_below', 'non_fs_share.pass', 'non_fs_share.warn', 'criticality.pass', 'criticality.warn', 'weights.criticality', 'grades.PASS', 'grades.FAIL']);
  assert.deepEqual(r.not_used, ['stretches'], 'the platform\'s listing settings have nothing to apply to here');
  assert.equal(c(r, 'dangling_start').band, 'pass', 'one dangling start allowed');
  assert.equal(c(r, 'fs_overlap').fixes!.some((f) => f.activities.join() === 'B,G'), false, 'a 2-day lead tolerated');
  assert.equal(c(r, 'fs_overlap').fixes!.some((f) => f.activities.length === 4), false, 'four floors are not a ladder of five');
  assert.equal(c(r, 'non_fs_share').band, 'pass');
  assert.deepEqual([c(r, 'criticality').band, c(r, 'criticality').weight, c(r, 'criticality').applied], ['fail', 50, { pass: [0.9, 1], warn: [0.8, 1], weight: 50 }]);
  assert.equal((c(r, 'serialization').applied as { small_network?: boolean }).small_network, undefined, 'no longer a small network');
  assert.ok(r.grade === 'PASS' || r.grade === 'FAIL', String(r.grade));
  assert.ok(r.score! < base.score!, `criticality fails with five times its weight (${r.score} vs ${base.score})`);
  // DEFAULT is left alone by an override
  assert.equal(DEFAULT_LINT_THRESHOLDS.dangling_start.max, 0);

  for (const bad of [{ high_float_days: 44 }, { criticality: { pass: 0.3 } }, { criticality: { pass: [0.4, 0.1] } }, { ladder: { min_group_size: -1 } }, { ladder: { nope: 1 } }, { weights: { not_a_check: 1 } }])
    assert.throws(() => lintSchedule(db, { thresholds: bad }), /threshold|Unknown|must be/, JSON.stringify(bad));
});

test('schedule log as data: F9 sections plus invalid milestone links, critical, unmet constraints and relationships', () => {
  const db = build();
  ok(db, [
    { op: 'add_activity', id: 'M', name: 'Start milestone fed by FF', type: 'start_milestone' },
    { op: 'add_relationship', pred: 'A', succ: 'M', type: 'FF' }, { op: 'add_relationship', pred: 'M', succ: 'H' },
    { op: 'update_activity', id: 'G', constraint: { type: 'start_on_or_before', date: '2026-03-03' } },
    { op: 'update_activity', id: 'Q', constraint: { type: 'mandatory_start', date: '2026-03-02' } },
  ]);
  const res = scheduleProjects(db, [pid(db)]);
  assert.ok(res.ok);
  const log = scheduleLogReport(db, [pid(db)], res);
  const sec = (where: 'warnings' | 'exceptions', code: string) => log[where].find((x) => x.code === code);
  assert.ok(sec('warnings', 'MILESTONE_REL')!.activities.some((a) => a.id === 'M'));
  assert.ok(sec('exceptions', 'CRITICAL')!.count > 0);
  assert.ok(sec('exceptions', 'CONSTRAINT_UNMET')!.activities.some((a) => a.id === 'G'));
  assert.ok(sec('exceptions', 'RELATIONSHIP_UNMET')!.activities.some((a) => a.id === 'Q'), JSON.stringify(log.exceptions.map((s) => [s.code, s.activities.map((a) => a.id)])));
  assert.equal(log.statistics.activities, rows(db, 'TASK').filter((t) => t.proj_id === pid(db)).length);
});

test('lint fs_overlap: every ladder is simulated and listed by default (more than 10); a max_targets given is still honoured', () => {
  const db: Db = { tables: {} };
  const ops: unknown[] = [{ op: 'add_project', id: 'LD', start: '2026-03-02' }, { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' }, { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' }];
  const groups = 'ABCDEFGHIJKL'; // twelve ladders in series, all critical (names differ by letters: digits are masked in the look-alike match)
  let prev = 'S';
  for (const g of groups) for (let n = 1; n <= 4; n++) { const id = `${g}${n}`; ops.push({ op: 'add_activity', id, name: `Zone ${g} pour ${n}`, duration_days: 5 }, { op: 'add_relationship', pred: prev, succ: id }); prev = id; }
  ops.push({ op: 'add_relationship', pred: prev, succ: 'H' });
  ok(db, ops);
  assert.ok(scheduleProjects(db, [pid(db)]).ok);
  const ladders = (r: ReturnType<typeof lintSchedule>) => r.checks.find((x) => x.id === 'fs_overlap')!.fixes!.filter((f) => f.activities.length === 4);
  const all = lintSchedule(db);
  assert.equal(all.checks.find((x) => x.id === 'fs_overlap')!.ladders_total, 12);
  assert.equal(ladders(all).length, 12, 'all twelve are listed');
  assert.ok(ladders(all).every((l) => l.saves_days! > 0), 'and every one was simulated');
  const few = lintSchedule(db, { thresholds: { ladder: { max_targets: 3 } } });
  assert.equal(ladders(few).length, 3, 'a max_targets given is honoured');
  assert.equal(DEFAULT_LINT_THRESHOLDS.ladder.max_targets, 0, '0 = all, the default');
});

/** n critical ladders in series; ladder k has sizes[k] activities (names differ by letters: digits are masked in the look-alike match) */
function ladders(sizes: number[]): Db {
  const db: Db = { tables: {} };
  const ops: unknown[] = [{ op: 'add_project', id: 'LT', start: '2026-03-02' }, { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' }, { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' }];
  let prev = 'S';
  sizes.forEach((size, k) => { for (let n = 1; n <= size; n++) { const id = `L${k}_${n}`; ops.push({ op: 'add_activity', id, name: `Zone ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))} pour ${n}`, duration_days: 5 }, { op: 'add_relationship', pred: prev, succ: id }); prev = id; } });
  ops.push({ op: 'add_relationship', pred: prev, succ: 'H' });
  ok(db, ops);
  assert.ok(scheduleProjects(db, [pid(db)]).ok);
  return db;
}
const fs = (r: Awaited<ReturnType<typeof lintScheduleTicked>>) => r.checks.find((x) => x.id === 'fs_overlap')!;
const cancelled = () => Object.assign(new Error('The call was cancelled.'), { code: 'cancelled' });

test('lint fs_overlap ticks between the ladder simulations: progress counts them, a cancellation after the first keeps those done (partial, said), one before it is the cancellation; lintSchedule gives the same answer without a tick', async () => {
  const db = ladders(Array(12).fill(4));
  const seen: [number, number, string][] = [];
  const full = await lintScheduleTicked(db, {}, async (d, t, m) => { seen.push([d, t, m]); });
  assert.deepEqual(seen.map(([d, t]) => [d, t]), Array.from({ length: 12 }, (_, i) => [i, 12]));
  assert.equal(seen[4][2], 'fs_overlap: simulating critical ladder 5 of 12');
  assert.deepEqual(full, lintSchedule(db), 'the same lint, with or without a tick');
  assert.equal(full.partial, undefined); assert.equal(fs(full).partial, undefined);
  const cut = await lintScheduleTicked(db, {}, async (d) => { if (d === 5) throw cancelled(); });
  const c = fs(cut);
  assert.equal(cut.partial, true); assert.equal(cut.stopped, 'cancelled');
  assert.equal(c.partial, true); assert.equal(c.ladders_simulated, 5); assert.equal(c.ladders_to_simulate, 12);
  assert.equal(c.fixes!.filter((f) => f.activities.length === 4 && f.saves_days != null).length, 5, 'the five simulated ladders have their days saved');
  assert.equal(c.fixes!.filter((f) => f.activities.length === 4).length, 12, 'all twelve are still listed');
console.log('LN', JSON.stringify({ n: (cut as any).notes, cn: c.note }));
  assert.equal(cut.checks.length, full.checks.length, 'the rest of the lint was done as usual');
  // a cancel before the first simulation keeps every finished check (the ladders without saves_days), partial, none simulated
  const early = await lintScheduleTicked(db, {}, async () => { throw cancelled(); });
  assert.equal(early.partial, true); assert.equal(early.stopped, 'cancelled');
  assert.equal(fs(early).ladders_simulated, 0); assert.equal(fs(early).ladders_to_simulate, 12);
  assert.equal(early.checks.length, full.checks.length, 'every other check was done');
  assert.deepEqual(early.checks.filter((x) => x.id !== 'fs_overlap'), full.checks.filter((x) => x.id !== 'fs_overlap'));
  assert.ok(fs(early).fixes!.every((f) => f.saves_days == null), 'no ladder has saves_days');
  assert.match(String(fs(early).note), /^Partial: the call was cancelled after 0 of 12 ladder simulations/);
  await assert.rejects(lintScheduleTicked(db, {}, async (d) => { if (d === 2) throw new Error('boom'); }), /boom/);
  // simulate: false has no step to stop at: one look at the end; a cancel that arrived while it ran does not discard the result, and the note says so
  let ticks = 0;
  const whole = await lintScheduleTicked(db, { simulate: false }, async () => { ticks++; });
  assert.equal(ticks, 1); assert.equal(whole.partial, undefined); assert.equal(whole.note, undefined);
  const late = await lintScheduleTicked(db, { simulate: false }, async () => { throw cancelled(); });
  assert.equal(late.partial, undefined); assert.equal(late.stopped, undefined);
  assert.deepEqual({ ...late, note: undefined }, { ...whole, note: undefined }, 'the complete result');
  assert.match(String(late.note), /^The call was cancelled while the lint ran, when it had no further step to stop at \(no fix simulation to run\): the result is complete\.$/);
  await assert.rejects(lintScheduleTicked(db, { simulate: false }, async () => { throw new Error('boom'); }), /boom/);
});

test('lint max_targets N simulates the first N critical ladders by size (the most activities first), not "the ones that save most"', async () => {
  const db = ladders([3, 6, 4, 5]);
  const r = lintSchedule(db, { thresholds: { ladder: { max_targets: 2 } } });
  const c = r.checks.find((x) => x.id === 'fs_overlap')!;
  assert.equal(c.ladders_total, 4);
  assert.deepEqual(c.fixes!.map((f) => f.activities.length).sort(), [5, 6], 'the two largest are simulated and listed');
  assert.ok(c.fixes!.every((f) => f.saves_days != null));
});

test('MCP lint: cancelled while simulating every critical ladder it answers what it has, partial; the description says every critical ladder is simulated by default and simulate: false skips it', async () => {
  const { callTool, toolResult, toolsList } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal, progress?: (d: number, t: number, m: string) => void) => { const r = await callTool(name, args, undefined, signal, progress); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const desc = String((toolsList() as any[]).find((t) => t.name === 'lint').description);
  assert.match(desc, /by default every critical ladder is simulated/); assert.match(desc, /simulate: false skips/); assert.match(desc, /first N critical ladders, the largest by number of activities first/);
  assert.doesNotMatch(desc, /save most/);
  const np = (await call('new_project', { id: 'LTC', start: '2026-03-02' })).d;
  const sizes = Array(160).fill(4); // 160 critical ladders in series
  const ops: unknown[] = [{ op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' }, { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' }];
  let prev = 'S';
  sizes.forEach((size, k) => { for (let n = 1; n <= size; n++) { const id = `L${k}_${n}`; ops.push({ op: 'add_activity', id, name: `Zone ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))} pour ${n}`, duration_days: 5 }, { op: 'add_relationship', pred: prev, succ: id }); prev = id; } });
  ops.push({ op: 'add_relationship', pred: prev, succ: 'H' });
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const abort = new AbortController();
  const r = await call('lint', { handle: np.handle, checks: ['fs_overlap'] }, abort.signal, (done) => { if (done >= 1) abort.abort(); }); // (a report 250 ms apart: the simulations are long enough to get there)
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.partial, true); assert.equal(r.d.stopped, 'cancelled');
  const c = r.d.checks.find((x: any) => x.id === 'fs_overlap');
  assert.ok(c.ladders_simulated >= 1 && c.ladders_simulated < 160, String(c.ladders_simulated)); assert.equal(c.ladders_to_simulate, 160);
console.log('LN2', JSON.stringify({ n: r.d.notes, cn: c.note }));
  // not cancelled: whole, and no partial marks
  const whole = await call('lint', { handle: np.handle, checks: ['fs_overlap'], simulate: false });
  assert.equal(whole.d.partial, undefined);
});
