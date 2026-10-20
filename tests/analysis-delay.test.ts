import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { timeImpact, windowsAnalysis, type Update } from '../core/analysis/delay.ts';
import { compareComputed } from '../core/query/evaluate.ts';

// S -> A(5) -> B(5) -> F, S -> C(3) -> F; planned 2 Mar 2026, finish 13 Mar.
function update(name: string, dd: string, progress: unknown[] = []): Update {
  const db: Db = { tables: {} };
  const ok = (ops: unknown[]) => { const r = applyOps(db, ops, { calendarDays: true }); assert.ok(r.ok, JSON.stringify(r.error)); };
  ok([
    { op: 'add_project', id: 'DLY', start: '2026-03-02' },
    { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' },
    { op: 'add_activity', id: 'A', name: 'Excavation', duration_days: 5 },
    { op: 'add_activity', id: 'B', name: 'Foundations', duration_days: 5 },
    { op: 'add_activity', id: 'C', name: 'Survey', duration_days: 3 },
    { op: 'add_activity', id: 'F', name: 'Handover', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'S', succ: 'A' }, { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'F' },
    { op: 'add_relationship', pred: 'S', succ: 'C' }, { op: 'add_relationship', pred: 'C', succ: 'F' },
  ]);
  ok(progress);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid], { dataDate: parseP6Date(`${dd} 08:00`)! }).ok);
  return { name, db, projId: pid };
}
const u0 = () => update('Baseline', '2026-03-02');
// A starts a day late; 2 days left at the second update
const u1 = () => update('Update 1', '2026-03-09', [
  { op: 'update_activity', id: 'S', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-02 08:00' },
  { op: 'update_activity', id: 'C', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-04 17:00' },
  { op: 'update_activity', id: 'A', actual_start: '2026-03-03 08:00', remaining_days: 2 }]);
// A done on the 10th; B renumbered B-10 and revised to 8 days, started the 11th with 6 days left; D (2 d) added before handover
const u2 = () => update('Update 2', '2026-03-16', [
  { op: 'update_activity', id: 'S', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-02 08:00' },
  { op: 'update_activity', id: 'C', actual_start: '2026-03-02 08:00', actual_finish: '2026-03-04 17:00' },
  { op: 'update_activity', id: 'A', actual_start: '2026-03-03 08:00', actual_finish: '2026-03-10 17:00' },
  { op: 'update_activity', id: 'B', new_id: 'B-10', duration_days: 8, actual_start: '2026-03-11 08:00', remaining_days: 6 },
  { op: 'add_activity', id: 'D', name: 'Snagging', duration_days: 2 }, { op: 'add_relationship', pred: 'B-10', succ: 'D' }, { op: 'add_relationship', pred: 'D', succ: 'F' }]);

test('windows: slip per window on the driving path, causes, totals add up, name fallback', () => {
  const r = windowsAnalysis([u2(), u0(), u1()]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.updates.map((u) => u.name), ['Baseline', 'Update 1', 'Update 2'], 'sorted by data date');
  const [w1, w2] = r.windows as any[];
  assert.equal(w1.finish_from.slice(0, 10), '2026-03-13');
  assert.equal(w1.slip_days, 2);
  assert.deepEqual(w1.driving_path, ['S', 'A', 'B', 'F']);
  const a = w1.lost_time.find((x: any) => x.id === 'A');
  assert.equal(a.lost_days, 2);
  assert.ok(a.causes.includes('started late'));
  const b = w2.lost_time.find((x: any) => x.id === 'B');
  assert.equal(b.now, 'B-10', 'B matched to its renumbered self by name');
  assert.ok(b.causes.includes('duration revised'));
  assert.deepEqual(w2.added, ['D']);
  assert.equal(r.total_slip_days, w1.slip_days + w2.slip_days);
});

test('windows half-step: progress and revision split', () => {
  const r = windowsAnalysis([u0(), u1(), u2()], { method: 'half_step' });
  assert.ok(r.ok);
  for (const w of r.windows as any[]) assert.equal(Math.round((w.half_step.progress_days + w.half_step.revision_days) * 100) / 100, w.slip_days);
  const w2 = (r.windows as any[])[1];
  // B's longer remaining duration is progress (MIP 3.4 applies remaining durations); the added D is a revision
  assert.equal(w2.half_step.revision_days, 2);
  assert.equal(r.total_progress_days! + r.total_revision_days!, r.total_slip_days);
});

test('TIA: fragnet delay at the same data date, driven path, baseline variance; nothing kept', () => {
  const u = u1();
  const before = JSON.stringify(u.db);
  const r = timeImpact(u.db, [u.projId], [
    { op: 'add_activity', id: 'X', name: 'Design change', duration_days: 4 },
    { op: 'add_relationship', pred: 'A', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'B' },
  ], { baseline: { name: 'Baseline', finish: parseP6Date('2026-03-13 17:00') } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.stringify(u.db), before);
  assert.equal(r.delay_days, 4);
  assert.equal(r.fragnet_on_critical_path, true);
  assert.deepEqual(r.fragnet_path, ['X', 'B', 'F']);
  assert.equal(r.variance_to_baseline_days, 6);
  const off = timeImpact(u.db, [u.projId], [{ op: 'add_activity', id: 'Y', name: 'Side work', duration_days: 1 }, { op: 'add_relationship', pred: 'C', succ: 'Y' }]);
  assert.ok(off.ok && off.delay_days === 0 && !off.fragnet_on_critical_path);
});

test('compare computed: two updates with different project IDs match by Activity ID, then by name', () => {
  const a = u1(), b = u2();
  const c = compareComputed(a.db, b.db);
  assert.deepEqual(c.matched_by_name, [{ a: 'B', b: 'B-10' }]);
  assert.ok(c.changes.some((x) => x.id === 'B-10'));
  assert.deepEqual(c.only_in_a, []);
});

test('MCP windows_analysis (baseline and progress updates), tia with keep, compare against a baseline', async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'WIN', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  const e = await call('edit', { handle: h, owner_key, operations: [
    { op: 'add_activity', id: 'A', name: 'Excavation', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'Foundations', duration_days: 5 },
    { op: 'add_activity', id: 'F', name: 'Handover', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'F' },
  ] });
  assert.equal(e.err, false, JSON.stringify(e.d));
  await call('schedule', { handle: h, owner_key });
  assert.equal((await call('edit', { handle: h, owner_key, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] })).err, false);
  const w = await call('windows_analysis', { handle: h, include_current: false, method: 'half_step', updates: [
    { baseline: 'project' },
    { name: 'U1', data_date: '2026-03-09', progress: [{ op: 'update_activity', id: 'A', actual_start: '2026-03-04 08:00', remaining_days: 3 }] },
  ] });
  assert.equal(w.err, false, JSON.stringify(w.d));
  assert.equal(w.d.windows.length, 1);
  assert.equal(w.d.windows[0].slip_days, 3);
  assert.equal(w.d.windows[0].half_step.progress_days, 3);
  const t = await call('tia', { handle: h, owner_key, fragnet: [{ op: 'add_activity', id: 'X', name: 'Change', duration_days: 2 }, { op: 'add_relationship', pred: 'A', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'B' }], baseline: 'project', keep: true });
  assert.equal(t.err, false, JSON.stringify(t.d));
  assert.equal(t.d.delay_days, 2);
  assert.equal(t.d.variance_to_baseline_days, 2);
  assert.equal(t.d.kept_as, 'WIN-TIA');
  const c = await call('compare', { handle: h, project: 'WIN', baseline: 'project' });
  assert.equal(c.err, false, JSON.stringify(c.d));
  assert.equal(c.d.baseline, 'Plan');
  assert.equal((await call('tia', { handle: h, fragnet: [{ op: 'add_relationship', pred: 'NOPE', succ: 'B' }] })).d.error.code, 'bad_input');
  assert.equal((await call('windows_analysis', { handle: h, updates: [{ baseline: 'bl3' }] })).d.error.code, 'bad_input');
});
