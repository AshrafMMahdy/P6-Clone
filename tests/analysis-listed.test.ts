// The analysis tools list at most 25 of any list (LISTED), say how many there are and where all of them are (owner 2026-11-12); the Monte Carlo
// criticality and sensitivity notes are the platform's own; every analysis writes its whole result to analysis/<project>/<tool> without being
// asked, and says in words when it cannot; the tools that write only with an option say which in _meta; an argument a tool does not have is
// reported as not used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, setRoots } from '../mcp/runtime.ts';
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
  // the file has one row per changed FIELD of an activity, so the note says what the file holds and both counts
  const evRows = ev.exported.files.find((f: any) => f.path.endsWith('-changed.csv')).rows;
  assert.ok(evRows > ev.changed_total, 'more rows than activities');
  assert.equal(ev.changed_note, `25 of ${ev.changed_total} shown; all ${ev.changed_total} in ${csv(ev, 'changed')} (that file has one row per changed field of an activity, ${evRows} rows)`);
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
  // the answer is a summary: the 25 most over-allocated resources, summary figures only; every resource's periods are in the file only
  assert.equal(rh.resources.length, 25); assert.equal(rh.resources_total, 30);
  assert.ok(rh.resources.every((x: any) => x.periods === undefined && x.periods_total > 0 && x.peak && 'over_allocated_periods' in x && x.severity));
  assert.ok(rh.resources.every((x: any, i: number, all: any[]) => i === 0 || all[i - 1].over_allocated_periods >= x.over_allocated_periods), 'most over-allocated first');
  assert.equal(rh.resources_note, `25 of 30 shown; all 30 in ${csv(rh, 'resources')}`);
  assert.equal(rh.periods_note, `The per-period figures of all 30 resources are not in this answer, only in the result file ${csv(rh, 'periods')} (table periods; columns resource, start, end, budgeted, actual, remaining_early, remaining_late, limit, over_allocated, available): the rows whose resource is a resource's ID are that resource's periods, and each resource's periods_total says how many it has.`);
  assert.equal(rh.periods_shown_for, undefined);
  const whole = JSON.parse(readFileSync(rh.exported.files[0].path, 'utf8'));
  assert.equal(whole.resources.length, 30);
  assert.ok(whole.resources.every((x: any) => x.periods.length > 0), 'the file holds the periods of every resource');
  assert.equal(rh.exported.files.find((f: any) => f.path.endsWith('-periods.csv')).rows, whole.resources.reduce((n: number, x: any) => n + x.periods.length, 0));
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
  // (no estimates: every run finishes at the same moment, so the chart is one bar holding all 20 runs, and the answer says so)
  assert.equal(m.histogram.length, 1); assert.equal(m.histogram[0].count, 20); assert.equal(m.histogram[0].cum_pct, 100);
  assert.equal(m.histogram_note, `All 20 runs finish at the same moment (${m.finish.min}), so the chart is one bar holding all of them, not 20. Why they coincide, and what to do about it, is in note.`);
  // the cause and the advice are said once, in note
  assert.match(m.note, /^No activity has a three-point estimate and no risk event applies: every iteration equals the deterministic schedule\. To get a spread, set three-point estimates \(edit set_estimates\)/);
  assert.equal(JSON.stringify(m).split('To get a spread').length - 1, 1);
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

// ---- the blind check of 14a99d2 ---------------------------------------------------------------------------------------------------------

test('B3: the desktop screens (config.screens, set only by the app\'s own process) get whole lists; no argument sets it', async () => {
  const h = await build('SCR', Array.from({ length: 60 }, (_, i) => ({ op: 'add_activity', id: `A${String(i).padStart(2, '0')}`, name: `A${i}`, duration_days: 2 })));
  // an argument named screens is just an argument the tool does not have: reported, and the lists stay at 25
  const viaArg = (await call('lint', { ...h, profile: 'platform', simulate: false, screens: true })).d;
  assert.match(viaArg.arguments_not_used[0], /^lint has no argument "screens"/);
  assert.equal(viaArg.checks.find((c: any) => c.id === 'connectivity').activities.length, 25);
  assert.equal(config.screens, false);
  config.screens = true;
  try {
    const l = (await call('lint', { ...h, profile: 'platform', simulate: false })).d;
    const ds = l.checks.find((c: any) => c.id === 'connectivity');
    assert.equal(ds.activities.length, 120); assert.equal(ds.total_activities, 120);
    assert.equal(ds.activities_note, undefined);
    assert.ok(l.checks.every((c: any) => (c.fixes_total ?? c.fixes?.length ?? 0) === (c.fixes?.length ?? 0) && c.activities.length === (c.total_activities ?? c.activities.length)), 'every check lists everything it found');
    // and the agent\'s answer to the same call is cut
  } finally { config.screens = false; }
  const l25 = (await call('lint', { ...h, profile: 'platform', simulate: false })).d;
  assert.equal(l25.checks.find((c: any) => c.id === 'connectivity').activities.length, 25);
});

test('B5: two open projects never share a result folder: the file name tells them apart, and the handle (on the later one) when the file name is the same too', async () => {
  const ops = [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 2 }];
  const first = await build('NEXTMONTH', ops);
  const folderOf = async (h: object) => { const r = (await call('lint', { ...h, simulate: false })).d; assert.equal(r.exported.error, undefined, JSON.stringify(r.exported)); return r.exported.folder as string; };
  // a project made here (no file): the project's short name
  assert.equal(await folderOf(first), join(root, 'analysis', 'NEXTMONTH', 'lint'));
  // the same Project ID in two files (this month's and next month's update): the file's name is in the folder
  for (const f of ['update-1.xer', 'update-2.xer']) assert.equal((await call('save', { ...first, path: join(root, f) })).err, false);
  await call('close', { ...first, discard: true });
  const one = (await call('open_file', { path: join(root, 'update-1.xer') })).d, two = (await call('open_file', { path: join(root, 'update-2.xer') })).d;
  const f1 = await folderOf(one), f2 = await folderOf(two);
  assert.equal(f1, join(root, 'analysis', 'NEXTMONTH__update-1', 'lint'));
  assert.equal(f2, join(root, 'analysis', 'NEXTMONTH__update-2', 'lint'));
  // the file name is cleaned as export_name is
  await call('save', { ...one, path: join(root, 'update (final) #3.xer') });
  const odd = (await call('open_file', { path: join(root, 'update (final) #3.xer') })).d;
  assert.equal(await folderOf(odd), join(root, 'analysis', 'NEXTMONTH__update--final---3', 'lint'));
  // the same file opened twice, and two projects made here with one Project ID: still the same folder name, so the handle is added to both
  const again = (await call('open_file', { path: join(root, 'update-1.xer') })).d;
  const a = await folderOf(one), b = await folderOf(again);
  assert.notEqual(a, b);
  assert.equal(a, f1); // the first session keeps the folder it had (B8)
  assert.equal(b, join(root, 'analysis', `NEXTMONTH__update-1__${again.handle}`, 'lint'));
  assert.ok(existsSync(join(a, 'lint.json')) && existsSync(join(b, 'lint.json')));
  const m1 = await build('TWIN', ops), m2 = await build('TWIN', ops);
  const t1 = await folderOf(m1), t2 = await folderOf(m2);
  assert.notEqual(t1, t2);
  assert.equal(t1, join(root, 'analysis', 'TWIN', 'lint')); assert.equal(t2, join(root, 'analysis', `TWIN__${m2.handle}`, 'lint'));
  // (a file whose name ends in -partial is no reason to refuse the call: that rule is for export_name)
  await call('save', { ...m1, path: join(root, 'x-partial.xer') });
  const part = (await call('open_file', { path: join(root, 'x-partial.xer') })).d;
  assert.equal((await call('lint', { ...part, simulate: false })).err, false);
});

test('B7: export_default is not an argument a caller can send: an export outside the write root is refused exactly as without it', async () => {
  const h = await build('EXD', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 2 }]);
  const outside = process.platform === 'win32' ? 'C:\\Windows\\whiq-outside' : '/etc/whiq-outside';
  for (const tool of ['lint', 'evaluate', 'monte_carlo', 'resource_histogram']) {
    const plain = await call(tool, { ...h, export: outside });
    const flagged = await call(tool, { ...h, export: outside, export_default: true });
    assert.equal(plain.err, true, tool); assert.equal(flagged.err, true, `${tool}: refused`);
    assert.equal(flagged.d.error.code, plain.d.error.code); assert.equal(flagged.d.error.message, plain.d.error.message);
    assert.ok(flagged.d.arguments_not_used.some((x: string) => x.includes('"export_default"')), 'and the flag is reported as not an argument of the tool');
  }
  assert.equal(existsSync(outside), false);
});

test('B2: an answer too large to return still carries exported, every note and arguments_not_used, and a hint that names only the tool\'s own arguments', async () => {
  const { callTool, toolResult, toolsList } = await import('../mcp/server.ts') as any;
  const h = await build('BIG', Array.from({ length: 60 }, (_, i) => ({ op: 'add_activity', id: `A${String(i).padStart(2, '0')}`, name: `A${i}`, duration_days: 2 })));
  const was = config.maxResponseChars;
  try {
    config.maxResponseChars = 3000;
    for (const [tool, args] of [['lint', { profile: 'platform', simulate: false, bogus: 1 }], ['evaluate', { overrides: Array.from({ length: 40 }, (_, i) => ({ op: 'update_activity', id: `A${String(i).padStart(2, '0')}`, duration_days: 6 })), bogus: 1 }]] as const) {
      const r = await callTool(tool, { ...h, ...args });
      const t = toolResult(r.out, r.isError, tool).structuredContent as any;
      assert.equal(t.truncated, true, tool);
      assert.ok(t.exported.files.length > 1 && t.exported.folder, 'the result folder and files');
      assert.ok(Object.keys(t.notes).length > 0 && Object.entries(t.notes).every(([k, v]) => /_note$/.test(k) && typeof v === 'string'), JSON.stringify(t.notes));
      assert.match(t.arguments_not_used[0], new RegExp(`^${tool} has no argument "bogus"`));
      assert.ok(t.saved && t.preview);
      // the hint names only arguments the tool has
      const props = Object.keys((toolsList() as any[]).find((x) => x.name === tool).inputSchema.properties);
      assert.doesNotMatch(t.note, /max_rows|limit and offset|filters/);
      for (const named of /this tool's ([\w, ]+)\./.exec(t.note)?.[1].split(', ') ?? []) assert.ok(props.includes(named), `${tool}: ${named}`);
    }
    // evaluate's notes include the changed list's
    const ev = await callTool('evaluate', { ...h, overrides: Array.from({ length: 40 }, (_, i) => ({ op: 'update_activity', id: `A${String(i).padStart(2, '0')}`, duration_days: 6 })) });
    const tev = toolResult(ev.out, ev.isError, 'evaluate').structuredContent as any;
    assert.match(tev.notes.changed_note, /^25 of \d+ shown; all \d+ in /);
    // a tool that has limit and offset names them
    const fa = toolResult((await callTool('find_activities', { ...h, limit: 100 })).out, false, 'find_activities').structuredContent as any;
    assert.equal(fa.truncated, true);
    assert.match(fa.note, /this tool's limit, offset/);
  } finally { config.maxResponseChars = was; }
});

test('B6: the Monte Carlo file\'s histogram is the answer\'s chart; with estimates it is 20 bars, without any variation one bar', async () => {
  const h = await build('MCB', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  const r = (await call('monte_carlo', { ...h, iterations: 40, seed: 3, default_estimates: est })).d;
  assert.equal(r.histogram.length, 20); assert.equal(r.histogram_note, undefined);
  const whole = JSON.parse(readFileSync(r.exported.files[0].path, 'utf8'));
  assert.deepEqual(whole.histogram, r.histogram);
  const rows = readFileSync(csv(r, 'histogram'), 'utf8').trim().split('\r\n');
  assert.equal(rows.length, 21, 'a header and the 20 bars');
  assert.equal(rows[0].replace('\ufeff', ''), 'start,end,count,cum_pct');
  // every run at the same moment: one bar with all the runs, no one-minute bars past the maximum
  const one = (await call('monte_carlo', { ...h, iterations: 15, seed: 3 })).d;
  assert.equal(one.histogram.length, 1);
  assert.deepEqual(one.histogram[0], { start: one.finish.max, end: one.finish.max, count: 15, cum_pct: 100 });
  assert.match(one.histogram_note, /^All 15 runs finish at the same moment/);
  assert.equal(readFileSync(csv(one, 'histogram'), 'utf8').trim().split('\r\n').length, 2);
  assert.match(one.histogram_note, /Why they coincide, and what to do about it, is in note\.$/);
  assert.match(one.note, /set_estimates.*default_estimates.*sampler/);
  // durations that vary: no reason given (the runs differ)
  assert.doesNotMatch(r.note ?? '', /no activity/i);
});

test('earned_value says in a note when the schedule carries no costs (budget at completion 0)', async () => {
  const h = await build('EVN', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }]);
  const ev = (await call('earned_value', h)).d;
  assert.equal(ev.projects[0].totals.bac, 0);
  assert.equal(ev.projects[0].totals.spi, 0);
  assert.match(ev.note, /^The schedule carries no costs \(budget at completion is 0\), so SPI, CPI and EAC are not meaningful.*resource price.*budgeted cost on an assignment.*expense.*dates\. BAC = /);
});

test('B8: compare says how many changes there are and where all of them are', async () => {
  const ops = Array.from({ length: 12 }, (_, i) => ({ op: 'add_activity', id: `A${String(i).padStart(2, '0')}`, name: `A${i}`, duration_days: 2 }));
  const h = await build('CMP', ops);
  const was = join(root, 'cmp-before.xer');
  assert.equal((await call('save', { ...h, path: was })).err, false);
  await call('edit', { ...h, operations: ops.map((o) => ({ op: 'update_activity', id: o.id, name: `${o.name} changed` })) });
  const all = (await call('compare', { ...h, path: was })).d;
  assert.ok(all.changes_total >= 12 && all.changes.length === all.changes_total);
  assert.equal(all.changes_note, undefined, 'nothing is cut');
  const p1 = (await call('compare', { ...h, path: was, max_changes: 5 })).d;
  assert.equal(p1.changes.length, 5); assert.equal(p1.changes_total, all.changes_total);
  assert.equal(p1.changes_note, `5 of ${all.changes_total} shown (the page from offset 0); all ${all.changes_total} in ${csv(p1, 'changes')}`);
  assert.equal(p1.exported.files.find((f: any) => f.path.endsWith('-changes.csv')).rows, all.changes_total);
  const p2 = (await call('compare', { ...h, path: was, max_changes: 5, offset: 5 })).d;
  assert.equal(p2.changes_note, `5 of ${all.changes_total} shown (the page from offset 5); all ${all.changes_total} in ${csv(p2, 'changes')}`);
  assert.equal(p2.next_offset, 10);
  // the computed mode names the same total
  const c = (await call('compare', { ...h, path: was, mode: 'computed', max_changes: 1 })).d;
  assert.equal(c.changes_total, c.changed);
});

test('B8: a session\'s default result folder is decided once and never changes; two sessions never share one', async () => {
  const { evict, sessions } = await import('../mcp/runtime.ts') as any;
  const ops = [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 2 }];
  const folderOf = async (h: object) => { const r = (await call('lint', { ...h, simulate: false })).d; assert.equal(r.exported.error, undefined); return r.exported.folder as string; };
  const first = await build('KEEP', ops);
  await call('save', { ...first, path: join(root, 'keep.xer') });
  await call('close', { ...first, discard: true });
  const A = (await call('open_file', { path: join(root, 'keep.xer') })).d;
  const a1 = await folderOf(A);
  assert.equal(a1, join(root, 'analysis', 'KEEP__keep', 'lint'));
  // a second open of the same file: A's folder is unchanged, B's is distinct
  const B = (await call('open_file', { path: join(root, 'keep.xer') })).d;
  assert.equal(await folderOf(A), a1);
  const b1 = await folderOf(B);
  assert.equal(b1, join(root, 'analysis', `KEEP__keep__${B.handle}`, 'lint'));
  // A moved out of memory and brought back: still A's folder; B never writes into it
  evict(sessions.get(A.handle), 'test');
  assert.equal(await folderOf(A), a1);
  assert.equal(await folderOf(B), b1);
  // B moved out and back, A still holds the plain one
  evict(sessions.get(B.handle), 'test');
  assert.equal(await folderOf(B), b1); assert.equal(await folderOf(A), a1);
});

test('B9: the default folder name is never ., .., empty or ending in a dot or space, and does not repeat the file\'s name', async () => {
  const { defaultResultFolder } = await import('../mcp/export.ts') as any;
  for (const n of ['.', '..', '...', ' ', 'X.', 'X ', 'X. .']) {
    const f = defaultResultFolder('lint', [n]) as string;
    const dir = f.split(/[\\/]/)[1];
    assert.ok(dir && dir !== '.' && dir !== '..' && !/[. ]$/.test(dir), `${JSON.stringify(n)} -> ${f}`);
  }
  assert.equal(defaultResultFolder('lint', ['..']), join('analysis', 'project', 'lint'));
  assert.equal(defaultResultFolder('lint', ['X'], '/a/X.xer'), join('analysis', 'X', 'lint'));
  assert.equal(defaultResultFolder('lint', ['X'], '/a/Y.xer'), join('analysis', 'X__Y', 'lint'));
  const dots = await build('..', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 2 }]);
  const r = (await call('lint', { ...dots, simulate: false })).d;
  assert.equal(r.exported.folder, join(root, 'analysis', 'project', 'lint'));
});

test('B10: resource_histogram lists by severity, then over-allocated periods, then name; a limit-0 resource does not push real ones out', async () => {
  const rops: unknown[] = [{ op: 'add_activity', id: 'T', name: 'T', duration_days: 20 }, { op: 'add_resource', id: 'AA', name: 'AA', max_units_per_hour: 0 }, { op: 'assign_resource', activity: 'T', resource: 'AA', units_per_day: 8 },
    { op: 'add_resource', id: 'MID', name: 'MID', max_units_per_hour: 1 }, { op: 'assign_resource', activity: 'T', resource: 'MID', units_per_day: 14 },
    { op: 'add_resource', id: 'HI', name: 'HI', max_units_per_hour: 1 }, { op: 'assign_resource', activity: 'T', resource: 'HI', units_per_day: 20 }];
  const h = await build('SEV', rops);
  const r = (await call('resource_histogram', h)).d;
  const whole = JSON.parse(readFileSync(r.exported.files[0].path, 'utf8')).resources;
  const zero = whole.find((x: any) => x.resource === 'AA');
  assert.equal(zero.severity, 'none'); assert.ok(zero.over_allocated_periods > 0, 'counted over-allocated though its severity is none');
  assert.deepEqual(r.resources.map((x: any) => x.resource), ['HI', 'MID', 'AA']);
  assert.match(r.resources_order_note, /severity of over-allocation first/);
});

test('B11: a too-large answer also carries its note, partial, resume and next_offset', async () => {
  const { toolResult } = await import('../mcp/server.ts') as any;
  const was = config.maxResponseChars;
  try {
    config.maxResponseChars = 200;
    const t = toolResult({ note: 'continue with resume', partial: true, resume: '/x/y.p6mc', next_offset: 50, rows: 'z'.repeat(500) }, false, 'lint').structuredContent;
    assert.equal(t.truncated, true);
    assert.equal(t.answer_note, 'continue with resume'); assert.equal(t.partial, true); assert.equal(t.resume, '/x/y.p6mc'); assert.equal(t.next_offset, 50);
    const plain = toolResult({ rows: 'z'.repeat(500) }, false, 'lint').structuredContent;
    assert.ok(!('answer_note' in plain) && !('resume' in plain));
  } finally { config.maxResponseChars = was; }
});

// ── compare: progress_integrity (ported from the platform's wrapper) ─────────────────────────────────────────────────────────────────────
const integrityPair = async (id: string, early: unknown[], late: unknown[], base: unknown[]) => {
  const h = await build(id, base);
  const ed = async (ops: unknown[]) => assert.equal((await call('edit', { ...h, operations: ops })).err, false);
  await ed(early);
  const p1 = join(root, `${id}-early.xer`), p2 = join(root, `${id}-late.xer`);
  await call('save', { ...h, path: p1 });
  await ed(late);
  await call('save', { ...h, path: p2 });
  const E = (await call('open_file', { path: p1 })).d;
  return { E, p1, p2, h };
};
const setType = (code: string, t: string) => ({ op: 'set_fields', table: 'TASK', where: { task_code: code }, fields: { complete_pct_type: t } });

test('compare mode all carries progress_integrity: retroactive actuals, % complete down for every type, status regressions', async () => {
  const codes = ['DUR', 'PHY', 'UNI', 'RET', 'STA', 'OK'];
  const { E, p2 } = await integrityPair('PIN',
    [...['DUR', 'PHY', 'UNI', 'OK'].map((c) => ({ op: 'update_activity', id: c, actual_start: '2026-03-02', percent_complete: c === 'DUR' ? 20 : 50 })), { op: 'update_activity', id: 'RET', actual_start: '2026-03-02' },
      { op: 'update_activity', id: 'STA', actual_start: '2026-03-02', actual_finish: '2026-03-06' }, { op: 'set_fields', table: 'TASKRSRC', where: { taskrsrc_id: '1' }, fields: { act_reg_qty: '20' } }],
    [{ op: 'update_activity', id: 'DUR', percent_complete: 10 }, { op: 'update_activity', id: 'PHY', percent_complete: 30 }, { op: 'update_activity', id: 'RET', actual_start: '2026-03-03' }, { op: 'update_activity', id: 'OK', percent_complete: 60 },
      { op: 'set_fields', table: 'TASKRSRC', where: { taskrsrc_id: '1' }, fields: { act_reg_qty: '10' } }, { op: 'set_fields', table: 'TASK', where: { task_code: 'STA' }, fields: { act_end_date: '' } }],
    [...codes.map((c) => ({ op: 'add_activity', id: c, name: c, duration_days: 10 })), { op: 'add_resource', id: 'LAB', price_per_unit: 10 }, { op: 'assign_resource', activity: 'UNI', resource: 'LAB', units: 40 }, setType('PHY', 'CP_Phys'), setType('UNI', 'CP_Units')]);
  const d = (await call('compare', { handle: E.handle, path: p2 })).d;
  const pi = d.progress_integrity;
  assert.deepEqual(Object.keys(pi).sort(), ['clean', 'note', 'progress_decreases', 'progress_decreases_total', 'retroactive_actuals', 'retroactive_actuals_total', 'status_regressions', 'status_regressions_total']);
  assert.equal(pi.clean, false);
  assert.deepEqual(pi.retroactive_actuals.map((x: any) => [x.id, x.field, x.a, x.b]), [['RET', 'actual_start', '2026-03-02 00:00', '2026-03-03 00:00'], ['STA', 'actual_finish', '2026-03-06 00:00', '']]);
  assert.deepEqual(pi.progress_decreases.map((x: any) => [x.id, x.field, x.a, x.b]), [['DUR', 'duration_pct', 20, 10], ['PHY', 'physical_pct', 50, 30], ['UNI', 'units_pct', 50, 25]]);
  assert.deepEqual(pi.status_regressions.map((x: any) => [x.id, x.a, x.b]), [['STA', 'TK_Complete', 'TK_Active']]);
  assert.equal(pi.progress_decreases_total, 3);
  assert.match(pi.note, /^Between the updates: 2 actual dates the earlier update held were changed or cleared \(e\.g\. .*\); 3 percent completes went down \(e\.g\. .*\); 1 status went back \(e\.g\. .*\)\. A claim relies on contemporaneous records, so these are disclosed in the report; the lists give every one\.$/);
  // the whole lists are in the result files
  assert.ok(csv(d, 'progress_decreases') && csv(d, 'retroactive_actuals') && csv(d, 'status_regressions'));
  // not given in mode computed
  assert.equal((await call('compare', { handle: E.handle, path: p2, mode: 'computed' })).d.progress_integrity, undefined);
});

test('compare progress_integrity: the same file is clean; a list over LISTED shows 25 with its total and the note naming the file', async () => {
  const ops = Array.from({ length: 27 }, (_, i) => ({ op: 'add_activity', id: `P${String(i).padStart(2, '0')}`, name: `P${i}`, duration_days: 10 }));
  const { E, p1, p2 } = await integrityPair('PIL', ops.map((o) => ({ op: 'update_activity', id: o.id, actual_start: '2026-03-02', percent_complete: 40 })), ops.map((o) => ({ op: 'update_activity', id: o.id, percent_complete: 30 })), ops);
  const same = (await call('compare', { handle: E.handle, path: p1 })).d.progress_integrity;
  assert.equal(same.clean, true); assert.equal(same.progress_decreases_total, 0);
  assert.match(same.note, /^no actual date the earlier update held was changed or cleared/);
  const d = (await call('compare', { handle: E.handle, path: p2 })).d, pi = d.progress_integrity;
  assert.equal(pi.progress_decreases.length, LISTED); assert.equal(pi.progress_decreases_total, 27);
  assert.equal(pi.progress_decreases_note, `25 of 27 shown; all 27 in ${csv(d, 'progress_decreases')}`);
  assert.equal(readFileSync(csv(d, 'progress_decreases'), 'utf8').trim().split('\n').length, 28);
  assert.equal(JSON.parse(readFileSync(d.exported.files[0].path, 'utf8')).progress_integrity.progress_decreases.length, 27);
});

// ── a scenario or enum value the tool cannot use is refused, not run as "no change" ────────────────────────────────────────────────────────
test('evaluate_batch refuses a scenario that is not {name, overrides: [...]}, naming it; an empty overrides list stays allowed', async () => {
  const h = await build('EBS', [{ op: 'add_activity', id: 'A50', name: 'A', duration_days: 5 }]);
  const op = { op: 'update_activity', id: 'A50', duration_days: 10 };
  const bare = await call('evaluate_batch', { ...h, scenarios: [[op]] });
  assert.equal(bare.err, true);
  assert.match(bare.d.error.message, /^scenarios\[0\] \(scenario 1\) is not a scenario: received a bare list\. A scenario is an object \{"name": "\.\.\.", "overrides": \[edit operations\]\}\.$/);
  const keys = await call('evaluate_batch', { ...h, scenarios: [{ name: 'ok', overrides: [op] }, { name: 'x', operations: [op] }] });
  assert.equal(keys.err, true);
  assert.match(keys.d.error.message, /^scenarios\[1\] \(scenario 2\) is not a scenario: received an object with the keys "name", "operations", no "overrides" list\./);
  assert.match((await call('evaluate_batch', { ...h, scenarios: [{ name: 'x', overrides: 'nope' }] })).d.error.message, /"overrides" is not a list/);
  assert.match((await call('evaluate_batch', { ...h, scenarios: ['x'] })).d.error.message, /received string "x"/);
  const good = await call('evaluate_batch', { ...h, scenarios: [{ name: 'as it stands', overrides: [] }, { name: 'longer', overrides: [op] }] });
  assert.equal(good.err, false);
  assert.equal(good.d.scenarios[0].finish_delta_days, 0); assert.ok(good.d.scenarios[1].finish_delta_days > 0);
});

test('evaluate refuses overrides that are not a list of operations', async () => {
  const h = await build('EVO', [{ op: 'add_activity', id: 'A50', name: 'A', duration_days: 5 }]);
  const obj = await call('evaluate', { ...h, overrides: { op: 'update_activity' } });
  assert.equal(obj.err, true); assert.match(obj.d.error.message, /received an object with the keys "op"/);
  const nested = await call('evaluate', { ...h, overrides: [[{ op: 'update_activity', id: 'A50', duration_days: 10 }]] });
  assert.equal(nested.err, true, JSON.stringify(nested.d).slice(0, 300));
});

test('an argument value outside its declared enum is refused for every tool, naming the accepted values', async () => {
  const h = await build('ENU', [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }]);
  const bad = await call('find_activities', { ...h, status: 'inprogress' });
  assert.equal(bad.err, true);
  assert.equal(bad.d.error.message, 'find_activities: status "inprogress" is not an accepted value. status is one of: not_started, in_progress, completed.');
  assert.match((await call('find_activities', { ...h, sort: 'name' })).d.error.message, /sort "name" is not an accepted value\. sort is one of: start, finish, total_float, duration\./);
  assert.match((await call('render_4d', { ...h, path: root, format: 'gif' })).d.error.message, /render_4d: format "gif" is not an accepted value\. format is one of: mp4, webm\./);
  for (const status of ['not_started', 'in_progress', 'completed', '', null, undefined]) assert.equal((await call('find_activities', { ...h, status })).err, false);
});
