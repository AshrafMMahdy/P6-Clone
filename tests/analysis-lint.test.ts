import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../core/project/ops.ts';
import { rows, type Db } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { lintSchedule } from '../core/analysis/lint.ts';
import { scheduleLogReport } from '../core/analysis/scheduleLog.ts';

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
