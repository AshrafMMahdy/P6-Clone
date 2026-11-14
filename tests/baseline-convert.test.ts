// P6's "Convert another project to a new baseline of the current project" (Maintain Baselines > Add), and its rule for an assigned baseline (owner 2026-11-14: "match P6";
// the sources are in the platform's ledger, "P6 RESEARCH, 2026-11-14"): the project itself becomes the baseline, under its own Project ID; a project that has baselines
// of its own is not converted; an assigned ("active") baseline is neither restored nor deleted; the relationships a baseline holds to other projects stay with it,
// take no part in the schedule, and are relationships again once it is restored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callTool, toolResult } from '../mcp/server.ts';
import { getSession } from '../mcp/runtime.ts';
import { testRoots } from './helpers.ts';

testRoots();
const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return toolResult(r.out, r.isError, name).structuredContent as any; };
const edit = async (h: string, ...operations: unknown[]) => call('edit', { handle: h, operations });
/** P (A 5d -> B 5d) and Q (A 3d -> B 3d), with B of Q a predecessor of B of P: scheduled together P finishes 19 March, on its own 13 March. */
async function two() {
  const p = await call('new_project', { id: 'P', start: '2026-03-02' }), h = p.handle as string;
  const e = await edit(h, { op: 'add_activity', id: 'A', name: 'a', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'b', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' },
    { op: 'add_project', id: 'Q', start: '2026-03-02' }, { op: 'add_activity', project: 'Q', id: 'A', name: 'a', duration_days: 3 }, { op: 'add_activity', project: 'Q', id: 'B', name: 'b', duration_days: 6 }, { op: 'add_relationship', project: 'Q', pred: 'A', succ: 'B' },
    { op: 'add_relationship', pred: 'B', pred_project: 'Q', succ: 'B', succ_project: 'P' });
  assert.ok(!e.error, JSON.stringify(e.error));
  return { h, owner_key: p.owner_key as string };
}
const finish = async (h: string) => { const s = await call('schedule', { handle: h }); assert.equal(s.ok, true, JSON.stringify(s.error)); return getSession(h).db.tables.TASK.rows.find((t) => t.task_code === 'B' && t.proj_id === getSession(h).db.tables.PROJECT.rows.find((p) => p.proj_short_name === 'P')!.proj_id)!.early_end_date.slice(0, 10); };

test('convert_to_baseline: the project itself becomes a baseline of the other, under its own Project ID; its link to the other project no longer schedules', async () => {
  const { h } = await two();
  assert.equal(await finish(h), '2026-03-19', 'scheduled together, B of Q (5 to 12 March) drives B of P (13 to 19 March)');
  const qId = getSession(h).db.tables.PROJECT.rows.find((p) => p.proj_short_name === 'Q')!.proj_id;
  const e = await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P' });
  assert.deepEqual(e.results, [{ baseline: 'Q', of: 'P', assigned_as: null }]);
  assert.deepEqual(e.changes, [{ id: 'Q', field: 'project', old: 'a project of its own', new: 'converted to a baseline of P' }]);
  // the same project row, not a copy: its internal number and Project ID are kept; it is added to P's baselines, not assigned
  const db = getSession(h).db, q = db.tables.PROJECT.rows.find((p) => p.proj_short_name === 'Q')!, p = db.tables.PROJECT.rows.find((x) => x.proj_short_name === 'P')!;
  assert.deepEqual([q.proj_id, q._baseline_of, p.sum_base_proj_id ?? ''], [qId, p.proj_id, '']);
  const s = await call('project_summary', { handle: h });
  assert.deepEqual(s.projects.map((x: any) => x.id), ['P'], 'Q is no longer a project of the file');
  assert.equal(await finish(h), '2026-03-13', 'P schedules on its own logic');
  // the link is the baseline's: the activity shows it as such, and it can be deleted
  const b = await call('get_activity', { handle: h, activity_id: 'B' });
  assert.deepEqual(b.baseline_links, [{ predecessor: 'B', baseline: 'Q', type: 'FS', lag_days: 0 }]);
  assert.equal(b.predecessors_total, 1);
  // assigned, the comparison pairs the activities by Activity ID
  assert.ok(!(await edit(h, { op: 'assign_baseline', baseline: 'Q' })).error);
  const v = await call('baseline_variance', { handle: h });
  assert.deepEqual([v.compared_with.name, v.activities.compared, v.activities.not_in_reference], ['Q', 2, 0]);
  // undo of the conversion (after the assignment's): Q is a project again
  await call('undo', { handle: h }); await call('undo', { handle: h }); await call('undo', { handle: h });
  assert.deepEqual((await call('project_summary', { handle: h })).projects.map((x: any) => x.id).sort(), ['P', 'Q']);
});

test('convert_to_baseline with assign_as; what P6 does not convert is refused with the reason', async () => {
  const { h } = await two();
  const self = await edit(h, { op: 'convert_to_baseline', project: 'P', of: 'P' });
  assert.equal(self.error.message, 'P cannot be a baseline of itself: give the project to convert (project) and another project it becomes a baseline of (of).');
  assert.ok(!(await edit(h, { op: 'save_baseline', project: 'Q' })).error);
  const has = await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P' });
  assert.equal(has.error.message, 'Q has a baseline of its own (Q - B1): as in P6, a project that has baselines is not converted; delete or restore it first (delete_baseline, restore_baseline).');
  assert.ok(!(await edit(h, { op: 'delete_baseline', baseline: 'Q - B1' })).error);
  const e = await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P', assign_as: 'bl1' });
  assert.deepEqual(e.results, [{ baseline: 'Q', of: 'P', assigned_as: 'bl1' }]);
  assert.deepEqual(e.changes, [{ id: 'Q', field: 'project', old: 'a project of its own', new: 'converted to a baseline of P' }, { id: 'P', field: 'Primary Baseline', old: null, new: 'Q' }]);
  // a baseline is not a project: it cannot be converted again, nor be what another project is converted to
  assert.equal((await edit(h, { op: 'convert_to_baseline', project: 'P', of: 'Q' })).error.message, 'Q is a baseline, not a project: a project becomes a baseline of a project, not of a baseline.');
});

test('an assigned baseline is neither restored nor deleted, as in P6; cleared and restored, its link to the other project is a relationship again; the file keeps all of it', async () => {
  const { h, owner_key } = await two();
  assert.ok(!(await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P', assign_as: 'project' })).error);
  for (const [op, done] of [['restore_baseline', 'restored'], ['delete_baseline', 'deleted']]) {
    const r = await edit(h, { op, baseline: 'Q' });
    assert.equal(r.error.message, `Baseline "Q" is assigned (Project Baseline of P): as in P6, an assigned baseline is not ${done}; clear the assignment first (assign_baseline baseline: "", as: "project", project: "P"), then call this again.`);
  }
  // saved as XER and opened again: Q is P's baseline, assigned, with its link (which still does not schedule)
  const out = join(process.env.TMPDIR ?? '/tmp', `conv-${Date.now()}.xer`);
  const saved = await call('save', { handle: h, owner_key, path: out });
  assert.ok(!saved.error, JSON.stringify(saved.error));
  const o = await call('open_file', { path: out });
  const db = getSession(o.handle).db, q = db.tables.PROJECT.rows.find((p) => p.proj_short_name === 'Q')!, p = db.tables.PROJECT.rows.find((x) => x.proj_short_name === 'P')!;
  assert.deepEqual([q._baseline_of, p.sum_base_proj_id], [p.proj_id, q.proj_id]);
  assert.deepEqual((await call('get_activity', { handle: o.handle, activity_id: 'B' })).baseline_links, [{ predecessor: 'B', baseline: 'Q', type: 'FS', lag_days: 0 }]);
  assert.equal(await finish(o.handle), '2026-03-13');
  // the assignment cleared, the baseline restored: a project again, and its relationship to P schedules
  const e = await edit(o.handle, { op: 'assign_baseline', baseline: '', as: 'project' }, { op: 'restore_baseline', baseline: 'Q' });
  assert.deepEqual(e.changes, [{ id: 'P', field: 'Project Baseline', old: 'Q', new: null }, { id: 'Q', field: 'baseline', old: 'baseline of P', new: 'restored as a project' }]);
  assert.equal(await finish(o.handle), '2026-03-19');
  assert.equal((await call('get_activity', { handle: o.handle, activity_id: 'B', project: 'P' })).baseline_links, undefined);
});

/** P (A -> B, and X), Q (A -> B), with B of P -> A of Q and B of Q -> X of P: through Q, and only through Q, B of P leads to X of P. */
async function withLinks() {
  const p = await call('new_project', { id: 'P', start: '2026-03-02' }), h = p.handle as string;
  const act = (id: string, project?: string) => ({ op: 'add_activity', id, name: id, duration_days: 3, ...(project ? { project } : {}) });
  const e = await edit(h, act('A'), act('B'), act('X'), { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_project', id: 'Q', start: '2026-03-02' }, act('A', 'Q'), act('B', 'Q'),
    { op: 'add_relationship', project: 'Q', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', pred_project: 'P', succ: 'A', succ_project: 'Q' }, { op: 'add_relationship', pred: 'B', pred_project: 'Q', succ: 'X', succ_project: 'P' });
  assert.ok(!e.error, JSON.stringify(e.error));
  return { h, owner_key: p.owner_key as string };
}
const rels = (h: string) => { const db = getSession(h).db, t = new Map(db.tables.TASK.rows.map((x) => [x.task_id, `${db.tables.PROJECT.rows.find((p) => p.proj_id === x.proj_id)!.proj_short_name}.${x.task_code}`])); return db.tables.TASKPRED.rows.map((r) => `${t.get(r.pred_task_id)}>${t.get(r.task_id)}`).sort(); };

test('a baseline\'s links are no logic for the edit either: they close no loop, set_predecessors and dissolve_activity leave them alone, and only a link (never a baseline\'s own logic) is deleted by naming the baseline', async () => {
  const { h } = await withLinks();
  // as two projects, X -> B would close a loop through Q (X -> B -> A of Q -> B of Q -> X): refused
  assert.match((await edit(h, { op: 'add_relationship', pred: 'X', succ: 'B', project: 'P' })).error.message, /loop/);
  assert.ok(!(await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P' })).error);
  // Q is a baseline now: its links are no logic, X -> B closes no loop, and schedule agrees
  const ok = await edit(h, { op: 'add_relationship', pred: 'X', succ: 'B', project: 'P' });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  assert.equal((await call('schedule', { handle: h })).ok, true);
  assert.deepEqual(rels(h), ['P.A>P.B', 'P.B>Q.A', 'P.X>P.B', 'Q.A>Q.B', 'Q.B>P.X']);
  // a baseline's own logic is not edited; a link is, by naming the baseline (and the refusal for the bare IDs says so)
  assert.equal((await edit(h, { op: 'delete_relationship', pred: 'A', succ: 'B', project: 'Q' })).error.message, 'A -> B is a relationship inside baseline Q: a baseline\'s own logic is not changed. Only a baseline\'s link to an activity of another project is deleted here.');
  assert.equal((await edit(h, { op: 'delete_relationship', pred: 'B', succ: 'X', project: 'P' })).error.message, 'No relationship B -> X. A baseline\'s link B -> X exists (B in baseline Q -> X in P): name the baseline as pred_project or succ_project to delete it.');
  // set_predecessors replaces X's predecessors in the logic (it had none) and leaves the baseline's link into X where it is
  const sp = await edit(h, { op: 'set_predecessors', activity: 'X', project: 'P', links: [{ pred: 'A' }] });
  assert.equal(sp.results[0].removed, 0);
  assert.deepEqual(rels(h), ['P.A>P.B', 'P.A>P.X', 'P.B>Q.A', 'P.X>P.B', 'Q.A>Q.B', 'Q.B>P.X']);
  // dissolving B joins its predecessors to its successors in P's logic (it has none there): nothing is carried to the baseline, and B's link goes with B
  const d = await edit(h, { op: 'dissolve_activity', id: 'B', project: 'P' });
  assert.ok(!d.error, JSON.stringify(d.error));
  assert.deepEqual(rels(h), ['P.A>P.X', 'Q.A>Q.B', 'Q.B>P.X']);
  const del = await edit(h, { op: 'delete_relationship', pred: 'B', pred_project: 'Q', succ: 'X', succ_project: 'P' });
  assert.deepEqual(del.changes, [{ id: 'B in baseline Q FS X in P', field: 'baseline link', old: 'exists', new: 'deleted' }]);
  // a Project ID a baseline holds is taken
  assert.equal((await edit(h, { op: 'add_project', id: 'Q', start: '2026-03-02' })).error.message, 'A project or baseline "Q" already exists.');
  assert.equal((await edit(h, { op: 'convert_to_baseline', project: 'Q', of: 'P' })).error.message, 'Q is a baseline, not a project: only a project is converted (restore_baseline turns a baseline back into a project first).');
});

test('a baseline\'s link leaves the file only whole: one project saved as P6 XML, exported to Excel, or imported alone carries no half of it', async () => {
  const { h, owner_key } = await withLinks();
  assert.ok(!(await edit(h, { op: 'save_baseline', project: 'P', name: 'PB' })).error);
  // PB (a copy of P) holds copies of P's two relationships with Q: those are the baseline's links
  const whole = (list: string[]) => list.filter((r) => /PB\./.test(r)).every((r) => /^PB\.\w+>PB\.\w+$/.test(r));
  assert.deepEqual(rels(h).filter((r) => /PB\./.test(r)), ['PB.A>PB.B', 'PB.B>Q.A', 'Q.B>PB.X']);
  const dir = process.env.TMPDIR ?? '/tmp', stamp = Date.now();
  // P alone as P6 XML: PB goes with it; its links to Q, which is not written, do not
  const xml = join(dir, `links-${stamp}.xml`);
  assert.ok(!(await call('save', { handle: h, owner_key, path: xml, format: 'p6xml', project: 'P' })).error);
  const ox = await call('open_file', { path: xml });
  assert.ok(rels(ox.handle).includes('PB.A>PB.B') && whole(rels(ox.handle)), rels(ox.handle).join(' '));
  // Excel: the Relationships sheet of P holds P's logic and its relationships with Q, not PB's links
  const xl = await call('export_excel', { handle: h, path: join(dir, `links-${stamp}.xlsx`), project: 'P' });
  assert.ok(!xl.error, JSON.stringify(xl.error));
  // the whole file as XER, then P alone imported into a new project: no relationship of the import points at itself or at an activity it did not bring
  const xer = join(dir, `links-${stamp}.xer`);
  assert.ok(!(await call('save', { handle: h, owner_key, path: xer })).error);
  const t = await call('new_project', { id: 'T', start: '2026-03-02' });
  await edit(t.handle, ...['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 1 })));
  const imp = await call('import_file', { handle: t.handle, path: xer, from_project: 'P', action: 'new' });
  assert.ok(!imp.error, JSON.stringify(imp.error));
  const got = rels(t.handle);
  assert.ok(got.includes('P.A>P.B') && whole(got) && got.every((r) => { const [a, b] = r.split('>'); return a !== b && !/^T\./.test(a) && !/^T\./.test(b); }), got.join(' '));
});

test('a relationship kept to an activity outside the file stays that: an activity added later does not get the outside activity\'s number; the import says each kind of relationship it left out in its own sentence', async () => {
  const { h, owner_key } = await two();
  const dir = process.env.TMPDIR ?? '/tmp', xer = join(dir, `outside-${Date.now()}.xer`);
  assert.ok(!(await call('save', { handle: h, owner_key, path: xer })).error);
  // P alone into an empty file: its relationship from Q's B is kept, to an activity outside the file
  const t = await call('new_project', { id: 'T', start: '2026-03-02' });
  const imp = await call('import_file', { handle: t.handle, path: xer, from_project: 'P', action: 'new' });
  assert.ok(!imp.error, JSON.stringify(imp.error));
  const outside = () => { const db = getSession(t.handle).db, ids = new Set(db.tables.TASK.rows.map((x) => x.task_id)); return db.tables.TASKPRED.rows.filter((r) => !ids.has(r.pred_task_id) || !ids.has(r.task_id)).length; };
  assert.equal(outside(), 1);
  assert.ok(!(await edit(t.handle, ...['N1', 'N2', 'N3', 'N4', 'N5', 'N6'].map((id) => ({ op: 'add_activity', project: 'T', id, name: id, duration_days: 1 })))).error);
  assert.equal(outside(), 1, 'none of the new activities became the other end');
  // with a baseline that holds links to Q, into a file whose activities have the numbers Q's had: one sentence for the baseline's links, one for the others
  const w = await withLinks();
  assert.ok(!(await edit(w.h, { op: 'save_baseline', project: 'P', name: 'PB' })).error);
  const xer2 = join(dir, `outside2-${Date.now()}.xer`);
  assert.ok(!(await call('save', { handle: w.h, owner_key: w.owner_key, path: xer2 })).error);
  const u = await call('new_project', { id: 'U', start: '2026-03-02' });
  await edit(u.handle, ...['U1', 'U2', 'U3', 'U4', 'U5', 'U6'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 1 })));
  const imp2 = await call('import_file', { handle: u.handle, path: xer2, from_project: 'P', action: 'new' });
  assert.ok(!imp2.error, JSON.stringify(imp2.error));
  const said = JSON.stringify(imp2);
  // (of P's and PB's relationships with Q, the two that are rows of P and PB: Q's B before X; the other two are rows of Q and are not read)
  assert.match(said, /1 relationship was left out: a baseline's link to an activity of a project that was not imported \(a baseline's link is kept only with the project it points at\)\./);
  assert.match(said, /1 relationship was left out: the other end is an activity of a project that was not imported, and here its number is another activity's \(the relationship would have pointed at that activity\)\./);
});
