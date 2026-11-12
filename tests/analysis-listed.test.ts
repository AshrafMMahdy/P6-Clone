// The analysis tools list at most 25 of any list (LISTED), say how many there are and where all of them are (owner 2026-11-12); the Monte Carlo
// criticality and sensitivity notes are the platform's own; every analysis writes its whole result to analysis/<project>/<tool> without being
// asked, and says in words when it cannot; the tools that write only with an option say which in _meta; an argument a tool does not have is
// reported as not used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';
import { criticalityNote, sensitivityNote } from '../mcp/mcNotes.ts';
import { LISTED } from '../core/analysis/common.ts';
import { MC_BARS } from '../mcp/workset.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
const root = mkdtempSync(join(tmpdir(), 'p6-listed-'));
setRoots(null, root);
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const build = async (id: string, ops: unknown[]) => {
  const np = (await call('new_project', { id, start: '2026-03-02' })).d;
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  return { handle: np.handle as string, owner_key: np.owner_key as string };
};
const est = { min_pct: 80, max_pct: 150 };
const csv = (d: any, table: string) => d.exported.files.find((f: any) => f.path.endsWith(`-${table}.csv`))?.path as string;

test('LISTED is 25', () => assert.equal(LISTED, 25));
test('MC_BARS is 20', () => assert.equal(MC_BARS, 20));

test('criticality note: every branch, with the platform\'s words', () => {
  const f = '/x/monte_carlo-criticality.csv';
  // more ever-critical than shown, and more critical in every run than shown
  assert.equal(criticalityNote(25, 40, 30, 36, f), `25 of the 36 activities that were critical in at least one run are shown, highest first (30 critical in every run); all 40 activities are in ${f}; the 25 shown are all critical in every run, in activity-code order`);
  // more ever-critical than shown, fewer than shown critical in every run
  assert.equal(criticalityNote(25, 40, 10, 36, f), `25 of the 36 activities that were critical in at least one run are shown, highest first (10 critical in every run); all 40 activities are in ${f}`);
  // fewer ever-critical than shown: the rest are activities that never were
  assert.equal(criticalityNote(25, 33, 3, 3, f), `all 3 activities that were critical in at least one run are shown first (3 critical in every run), then 22 that never were; all 33 activities are in ${f}`);
  assert.equal(criticalityNote(25, 33, 1, 1, f), `the 1 activity that was critical in at least one run is shown first (1 critical in every run), then 24 that never were; all 33 activities are in ${f}`.replace('the 1 activity that was', 'the 1 activity that was'));
  // exactly as many as shown
  assert.equal(criticalityNote(25, 30, 25, 25, f), `all 25 activities that were critical in at least one run are shown (25 critical in every run); all 30 activities are in ${f}`);
  // none critical
  assert.equal(criticalityNote(25, 30, 0, 0, f), `no activity was critical in any run; the first 25 of 30 activities are shown; all 30 are in ${f}`);
  // not cut: no note; no file written: no file named
  assert.equal(criticalityNote(25, 25, 25, 25, f), undefined);
  assert.equal(criticalityNote(25, 30, 0, 0), 'no activity was critical in any run; the first 25 of 30 activities are shown');
  assert.equal(criticalityNote(25, 33, 3, 3), 'all 3 activities that were critical in at least one run are shown first (3 critical in every run), then 22 that never were');
  assert.equal(sensitivityNote(25, 30, '/x/s.csv'), '25 of 30 activities with a varying duration shown, strongest first; all 30 in /x/s.csv');
  assert.equal(sensitivityNote(25, 25), undefined);
});

test('monte_carlo on built networks: the notes carry the real counts, and the file named holds every activity', async () => {
  // a critical chain of 3 and 30 short side activities with a lot of float: 3 critical in every run, 33 in all
  const ops: unknown[] = [];
  for (let i = 0; i < 3; i++) ops.push({ op: 'add_activity', id: `C${i}`, name: `C${i}`, duration_days: 20 }, ...(i ? [{ op: 'add_relationship', pred: `C${i - 1}`, succ: `C${i}` }] : []));
  for (let i = 0; i < 30; i++) ops.push({ op: 'add_activity', id: `S${String(i).padStart(2, '0')}`, name: `S${i}`, duration_days: 1 });
  const h = await build('MCN1', ops);
  const r = (await call('monte_carlo', { ...h, iterations: 50, seed: 4, default_estimates: est })).d;
  assert.equal(r.criticality.length, 25); assert.equal(r.criticality_total, 33);
  assert.equal([r.critical_in_every_run, r.critical_in_any_run].join(), '3,3');
  assert.equal(r.criticality_note, `all 3 activities that were critical in at least one run are shown first (3 critical in every run), then 22 that never were; all 33 activities are in ${csv(r, 'criticality')}`);
  assert.equal(JSON.parse(readFileSync(r.exported.files[0].path, 'utf8')).criticality.length, 33);
  assert.equal(r.sensitivity_note, `25 of ${r.sensitivity_total} activities with a varying duration shown, strongest first; all ${r.sensitivity_total} in ${csv(r, 'sensitivity')}`);
  // exactly 25 ever critical: a chain of 25 and 5 side activities
  const ops2: unknown[] = [];
  for (let i = 0; i < 25; i++) ops2.push({ op: 'add_activity', id: `C${String(i).padStart(2, '0')}`, name: `C${i}`, duration_days: 10 }, ...(i ? [{ op: 'add_relationship', pred: `C${String(i - 1).padStart(2, '0')}`, succ: `C${String(i).padStart(2, '0')}` }] : []));
  for (let i = 0; i < 5; i++) ops2.push({ op: 'add_activity', id: `S${i}`, name: `S${i}`, duration_days: 1 });
  const h2 = await build('MCN2', ops2);
  const r2 = (await call('monte_carlo', { ...h2, iterations: 50, seed: 4, default_estimates: est })).d;
  assert.equal(r2.criticality_note, `all 25 activities that were critical in at least one run are shown (25 critical in every run); all 30 activities are in ${csv(r2, 'criticality')}`);
  // not cut: no note
  const h3 = await build('MCN3', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  const r3 = (await call('monte_carlo', { ...h3, iterations: 20, seed: 4, default_estimates: est })).d;
  assert.equal(r3.criticality_note, undefined); assert.equal(r3.criticality_total, 2);
  assert.equal(r3.histogram.length, 20);
  assert.equal(r3.iterations_requested ?? r3.iterations, 20);
});

test('R3: the result file is written by default and named in the notes; export given wins; a file that cannot be written is said in words and the notes name no file', async () => {
  const ops: unknown[] = [];
  for (let i = 0; i < 40; i++) ops.push({ op: 'add_activity', id: `A${String(i).padStart(2, '0')}`, name: `A${i}`, duration_days: 3 });
  const h = await build('RES R3', ops);
  const ev = (await call('evaluate', { ...h, overrides: ops.slice(0, 40).map((o: any) => ({ op: 'update_activity', id: o.id, duration_days: 6 })) })).d;
  assert.equal(ev.changed.length, 25); assert.ok(ev.changed_total > 25);
  assert.equal(ev.exported.folder, join(root, 'analysis', 'RES-R3', 'evaluate'), 'analysis/<project short name, cleaned>/<tool>');
  assert.equal(ev.changed_note, `25 of ${ev.changed_total} shown; all ${ev.changed_total} in ${csv(ev, 'changed')}`);
  assert.ok(existsSync(join(ev.exported.folder, 'evaluate.json')));
  // export given wins
  const mine = join(root, 'mine');
  const own = (await call('evaluate', { ...h, overrides: [{ op: 'update_activity', id: 'A00', duration_days: 6 }], export: mine })).d;
  assert.equal(own.exported.folder, mine);
  // resource_histogram: 30 resources, periods for 25
  const rops: unknown[] = [{ op: 'add_activity', id: 'T', name: 'T', duration_days: 10 }];
  for (let i = 0; i < 30; i++) rops.push({ op: 'add_resource', id: `R${i}`, name: `R${i}`, max_units_per_hour: 1 }, { op: 'assign_resource', activity: 'T', resource: `R${i}`, units_per_day: 8 + i });
  const hr = await build('HIST', rops);
  const rh = (await call('resource_histogram', hr)).d;
  assert.equal(rh.resources.length, 30);
  assert.equal(rh.resources.filter((x: any) => x.periods).length, 25);
  assert.equal(rh.periods_shown_for.length, 25); assert.equal(rh.periods_shown_for_total, 30);
  assert.equal(rh.periods_shown_for_note, `25 of 30 shown; all 30 in ${csv(rh, 'periods')}`);
  const whole = JSON.parse(readFileSync(rh.exported.files[0].path, 'utf8'));
  assert.ok(whole.resources.every((x: any) => x.periods.length > 0), 'the file holds the periods of every resource');
  // a file that cannot be written: the folder "analysis" of the write root is a file
  const bad = mkdtempSync(join(tmpdir(), 'p6-listed-bad-'));
  writeFileSync(join(bad, 'analysis'), 'x');
  setRoots(null, bad);
  try {
    const nf = await call('evaluate', { ...h, overrides: ops.slice(0, 40).map((o: any) => ({ op: 'update_activity', id: o.id, duration_days: 6 })) });
    assert.equal(nf.err, false, 'the call is answered');
    assert.equal(nf.d.changed.length, 25);
    assert.deepEqual(nf.d.exported.files, []);
    assert.match(nf.d.exported.error, /could not be written.*Next step: call again with export set to a folder/);
    assert.equal(nf.d.changed_note, `25 of ${nf.d.changed_total} shown`, 'no file is named');
  } finally { setRoots(null, root); }
});

test('R1: lists of lint fixes, windows, earned value and the other cut lists show 25 and say the total', async () => {
  const h = await build('FIX', Array.from({ length: 60 }, (_, i) => ({ op: 'add_activity', id: `A${String(i).padStart(2, '0')}`, name: `A${i}`, duration_days: 2 })));
  const l = (await call('lint', { ...h, profile: 'platform', simulate: false, max_ids: 3 })).d;
  assert.match(l.arguments_not_used[0], /^lint has no argument "max_ids"/);
  // connectivity: 60 open starts and 60 open ends share the 25, one of each in turn
  const ds = l.checks.find((c: any) => c.id === 'connectivity');
  assert.equal(ds.activities.length, 25); assert.equal(ds.total_activities, 120);
  assert.deepEqual([13, 12], ['no predecessor', 'no successor'].map((v) => ds.activities.filter((x: any) => x.value === v).length));
  assert.equal(ds.activities_note, `25 of 120 shown; all 120 in ${csv(l, 'findings')}`);
  const d = (await call('dcma_14', { ...h, max_ids: 1 })).d;
  assert.ok(d.checks.every((c: any) => c.activities.length <= 25));
  assert.match(d.arguments_not_used[0], /^dcma_14 has no argument "max_ids"/);
  const m = (await call('monte_carlo', { ...h, iterations: 20, top: 1, buckets: 7, histogram: 'days' })).d;
  assert.deepEqual(m.arguments_not_used.map((x: string) => x.match(/argument "(\w+)"/)![1]), ['top', 'buckets', 'histogram']);
  assert.equal(m.histogram.length, 20);
  assert.equal(m.arguments_not_used[0], `monte_carlo has no argument "top": it was not used and the call ran without it. Its arguments are: handle, export, export_name, iterations, resume, events, sampler, re_anchor, deadline, seed, risk_events, project, default_estimates, exact, caller, async.`);
  const ev = (await call('earned_value', { ...h, worst: 1 })).d;
  assert.match(ev.arguments_not_used[0], /^earned_value has no argument "worst"/);
  const sc = (await call('progress_curves', h)).d;
  assert.ok(sc.exported.files.length > 1);
});

test('R5: tools annotated as changing the project only with an option say which option in _meta', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const list = toolsList() as { name: string; annotations: { readOnlyHint: boolean }; _meta?: Record<string, unknown> }[];
  const meta = (n: string) => list.find((t) => t.name === n)!._meta?.['whiq/writes_when'];
  assert.deepEqual(meta('float_paths'), ['write']);
  assert.deepEqual(meta('crash_schedule'), ['apply']);
  assert.deepEqual(meta('optimize_schedule'), ['apply']);
  assert.deepEqual(meta('tia'), ['keep']);
  // every other analysis tool is annotated read-only; schedule changes the project whatever the arguments
  for (const n of ['check_schedule', 'dcma_14', 'lint', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'windows_analysis', 'compare', 'evaluate', 'earned_value', 'monte_carlo']) assert.equal(list.find((t) => t.name === n)!.annotations.readOnlyHint, true, n);
  assert.equal(meta('schedule'), undefined);
  // every argument named is an argument of the tool
  const { WRITES_WHEN } = await import('../mcp/server.ts');
  for (const [tool, args] of Object.entries(WRITES_WHEN)) for (const a of args) assert.ok(a in (list.find((t) => t.name === tool) as any).inputSchema.properties, `${tool}.${a}`);
});

test('R6: every tool of this server reports an argument it does not have; owner_key is never reported', async () => {
  const h = await build('ARG', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 2 }]);
  const v = (await call('validate', { ...h, bogus: 1 })).d;
  assert.equal(v.arguments_not_used.length, 1);
  assert.match(v.arguments_not_used[0], /^validate has no argument "bogus": it was not used and the call ran without it\. Its arguments are: handle, caller, async\.$/);
  assert.equal((await call('validate', { ...h, owner_key: h.owner_key })).d.arguments_not_used, undefined);
  assert.equal((await call('validate', h)).d.arguments_not_used, undefined);
});
