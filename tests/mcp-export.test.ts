// The analysis tools' `export` option (owner 2026-11-09): export: "<folder>" writes <tool>.json, the FULL result (every list whole,
// whatever top / max_ids / limit / max_rows cut from the chat answer), and one CSV per table beside it, so an agent builds Excel
// sheets, Word reports and slides from every number. The chat answer is the same with or without export (plus exported), and every
// list it cuts says how many there are (<list>_total). Monte Carlo's iterations.csv holds the exact finishes the statistics come
// from (also after a stop and a resume): sorted, they give the reported percentiles exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';
import { testHooks } from '../core/risk/montecarlo.ts';
import { percentile } from '../core/risk/montecarlo.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { reasonerModelPath } from '../core/analysis/hrmRuntime.ts';
import { sampleCopy } from './helpers.ts';

setRoots(null, tmpdir());
const root = mkdtempSync(join(tmpdir(), 'p6-export-'));
process.env.P6CLONE_COMPUTE_WORKERS = '0'; // (Monte Carlo's test hook lives in this process)

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
let n = 0;
const folder = () => join(root, `out${++n}`);

/** A CSV as rows of cells (quotes, commas and line breaks inside quotes), after its BOM. */
function readCsv(p: string): string[][] {
  const t = readFileSync(p, 'utf8');
  assert.equal(t[0], '﻿', `${p} starts with a BOM`);
  const out: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && t[i + 1] === '\n') { row.push(f); out.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  return out;
}
/** The exported files: the json (parsed) and each CSV's rows by name, checked against what exported says of them. */
function files(d: any, tool: string) {
  assert.ok(d.exported, `exported is answered: ${JSON.stringify(d).slice(0, 300)}`);
  const json = join(d.exported.folder, `${tool}.json`);
  assert.equal(d.exported.files[0].path, json);
  const csv: Record<string, Record<string, string>[]> = {};
  for (const f of d.exported.files.slice(1)) {
    const [head, ...rows] = readCsv(f.path);
    assert.deepEqual(head, f.columns, `${f.path}: the header row is the columns answered`);
    assert.equal(rows.length, f.rows, `${f.path}: as many rows as answered`);
    assert.ok(rows.every((r) => r.length === head.length), `${f.path}: every row has every column`);
    csv[f.path.split(/[\\/]/).pop()!.replace(/\.csv$/, '')] = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  return { json: JSON.parse(readFileSync(json, 'utf8')), csv };
}
/** The answer as it is without export. */
const plain = (d: any) => { const { exported: _e, elapsed_seconds: _s, ...rest } = d; return rest; };

/** A chain of n activities ending in a milestone (A0 -> A1 -> ... -> M1). */
async function chain(id: string, count: number, extra: unknown[] = []) {
  const np = (await call('new_project', { id, start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < count; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `Activity, "${i}"`, duration_days: 2 + (i % 3) }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  ops.push({ op: 'add_activity', id: 'M1', name: 'Done', type: 'finish_milestone' }, { op: 'add_relationship', pred: `A${count - 1}`, succ: 'M1' }, ...extra);
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  return { handle: np.handle as string, owner_key: np.owner_key as string };
}

test('check_schedule, dcma_14 and lint: the answer lists max_ids per check, the export every activity of every check', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  for (const [tool, found, extra] of [['check_schedule', 'failing_activities', {}], ['dcma_14', 'failing_activities', {}], ['lint', 'findings', { profile: 'platform', simulate: false }]] as const) {
    const without = (await call(tool, { handle: h, max_ids: 2, ...extra })).d;
    const r = await call(tool, { handle: h, max_ids: 2, ...extra, export: folder() });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.deepEqual(plain(r.d), plain(without), `${tool}: the answer is the one without export`);
    const { json, csv } = files(r.d, tool);
    const cut = r.d.checks.filter((c: any) => c.total_activities > 2);
    assert.ok(cut.length, `${tool}: some check found more than max_ids`);
    assert.ok(r.d.checks.every((c: any) => c.activities.length === Math.min(2, c.total_activities)));
    // the json holds every activity of every check, and the CSV one row for each
    assert.ok(json.checks.every((c: any) => c.activities.length === c.total_activities), tool);
    const total = json.checks.reduce((s: number, c: any) => s + c.total_activities, 0);
    assert.equal(csv[found].length, total, `${tool}: ${found}.csv`);
    assert.equal(csv.checks.length, r.d.checks.length);
    assert.equal(csv.checks.find((c) => c.id === cut[0].id)!.total_activities, String(cut[0].total_activities));
    if (tool === 'lint') assert.ok('fixes' in csv);
    if (tool === 'check_schedule') assert.ok(csv.checks[0].threshold_op && csv.projects.length);
  }
  // the HTML report is the answer's, as before
  const html = await call('dcma_14', { handle: h, max_ids: 1, path: join(root, 'dcma.html'), export: folder() });
  assert.ok(existsSync(html.d.saved) && html.d.exported.files.length === 3);
  // a folder outside the write root is refused
  const out = await call('dcma_14', { handle: h, export: join(tmpdir(), '..', 'elsewhere-p6-export') });
  assert.deepEqual([out.err, out.d.error.code], [true, 'path_outside_root']);
  await call('close', { handle: h, discard: true });
});

test('monte_carlo: iterations.csv holds every iteration, whose sorted finishes give the reported percentiles exactly, also after a stop and a resume', async () => {
  const h = await chain('MCX', 30);
  const args = { ...h, iterations: 120, seed: 5, top: 3, default_estimates: { min_pct: 80, max_pct: 150 }, deadline: '2026-07-15', events: [{ name: 'Permit', probability: 0.3, delay_days: 3 }] };
  const without = (await call('monte_carlo', args)).d;
  const r = (await call('monte_carlo', { ...args, export: folder() })).d;
  assert.deepEqual(plain(r), plain(without), 'the answer is the one without export');
  // the lists cut to top say how many there are
  assert.equal(r.criticality.length, 3); assert.equal(r.criticality_total, 31);
  assert.equal(r.sensitivity.length, 3); assert.ok(r.sensitivity_total > 3);
  assert.equal(r.milestones_total, 1);
  const { json, csv } = files(r, 'monte_carlo');
  assert.equal(csv.iterations.length, 120, 'one row per iteration');
  assert.deepEqual(Object.keys(csv.iterations[0]), ['iteration', 'finish', 'finish_days', 'M1_finish']);
  assert.equal(csv.criticality.length, 31); assert.equal(json.criticality.length, 31);
  assert.equal(csv.sensitivity.length, r.sensitivity_total);
  // nearest-rank percentiles of the finishes in the file, as the engine takes them, are the ones answered and in percentiles.csv
  const fin = csv.iterations.map((x) => x.finish).sort();
  // (the engine's nearest-rank percentile over the dates in the file, as minutes)
  const pct = (dates: string[], p: number) => formatP6Date(percentile(dates.map((x) => parseP6Date(x)!).sort((a, b) => a - b), p));
  const P = Object.fromEntries(csv.percentiles.map((x) => [x.statistic, x]));
  for (const k of ['P10', 'P50', 'P80', 'P90'] as const) {
    const p = Number(k.slice(1)) / 100;
    assert.equal(pct(fin, p), r.finish[k], k);
    assert.equal(P[k].date, r.finish[k], k);
    assert.equal(Number(P[k].working_days), percentile(csv.iterations.map((x) => Number(x.finish_days)).sort((a, b) => a - b), p), `${k} in working days`);
    assert.equal(Math.round(Number(P[k].working_days) * 100) / 100, r.working_days[k]);
    // each milestone's percentiles likewise
    assert.equal(pct(csv.iterations.map((x) => x.M1_finish), p), csv.milestones[0][k]);
  }
  assert.equal(P.min.date, fin[0]); assert.equal(P.max.date, fin.at(-1));
  assert.equal(Math.round(Number(P.prob_deterministic.value) * 10) / 10, r.chance_of_meeting_deterministic);
  assert.equal(Math.round(Number(P.prob_deadline.value) * 10) / 10, r.deadline.probability_pct);
  assert.equal(Number(P.prob_deadline.value), (100 * fin.filter((f) => f <= '2026-07-15 00:00').length) / 120);
  // the histogram in whole days counts every iteration
  assert.equal(csv.histogram.reduce((s, b) => s + Number(b.count), 0), 120);
  assert.equal(csv.histogram.at(-1)!.cum_pct, '100');
  assert.ok(csv.histogram.every((b) => b.start.endsWith('00:00')));

  // stopped part-way, then resumed with export: the iterations are those of the uninterrupted run, the kept ones first
  testHooks.failAt = 47;
  let part;
  try { part = (await call('monte_carlo', args)).d; } finally { testHooks.failAt = null; }
  assert.equal(part.partial, true); assert.ok(part.resume);
  const resumed = (await call('monte_carlo', { ...args, resume: part.resume, export: folder() })).d;
  assert.equal(resumed.resumed_iterations, 47);
  const again = files(resumed, 'monte_carlo').csv;
  assert.deepEqual(again.iterations, csv.iterations);
  assert.deepEqual(again.percentiles, csv.percentiles);
  // and a partial run exports the iterations it did
  testHooks.failAt = 30;
  try { part = (await call('monte_carlo', { ...args, export: folder() })).d; } finally { testHooks.failAt = null; }
  assert.equal(files(part, 'monte_carlo').csv.iterations.length, 30);
  await call('close', { ...h, discard: true });
});

test('windows_analysis: max_ids 0 lists every activity, a cut list says how many there are, the export has them all', async () => {
  const h = await chain('WINX', 60);
  await call('edit', { ...h, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] });
  const updates = [{ baseline: 'project' }, { name: 'U1', data_date: '2026-03-09', progress: [{ op: 'update_activity', id: 'A0', actual_start: '2026-03-04 08:00', remaining_days: 4 }] }];
  const all = (await call('windows_analysis', { handle: h.handle, include_current: false, updates, max_ids: 0 })).d;
  const w = all.windows[0];
  assert.ok(w.driving_path.length > 50, `max_ids 0: every activity (${w.driving_path.length})`);
  assert.equal(w.driving_path.length, w.driving_path_total);
  assert.equal(w.lost_time.length, w.lost_time_total);
  assert.ok(w.lost_time_total > 50);
  const dflt = (await call('windows_analysis', { handle: h.handle, include_current: false, updates })).d.windows[0];
  assert.deepEqual([dflt.driving_path.length, dflt.lost_time.length, dflt.driving_path_more, dflt.driving_path_total], [50, 50, w.driving_path_total - 50, w.driving_path_total], 'default 50');
  const r = (await call('windows_analysis', { handle: h.handle, include_current: false, updates, max_ids: 3, export: folder() })).d;
  assert.deepEqual([r.windows[0].driving_path.length, r.windows[0].lost_time.length, r.windows[0].lost_time_total], [3, 3, w.lost_time_total]);
  const { json, csv } = files(r, 'windows_analysis');
  assert.deepEqual(json.windows[0].driving_path, w.driving_path);
  assert.equal(csv.driving_path.length, w.driving_path_total);
  assert.equal(csv.lost_time.length, w.lost_time_total);
  assert.equal(csv.windows.length, 1);
  await call('close', { ...h, discard: true });
});

test('evaluate_batch: the export lists every activity every scenario moved; the answer the first 200 of the best, with changed_total', async () => {
  const h = await chain('BATX', 230);
  const scenarios = [{ name: 'first longer', overrides: [{ op: 'update_activity', id: 'A0', duration_days: 9 }] }, { name: 'last longer', overrides: [{ op: 'update_activity', id: 'A229', duration_days: 9 }] }, { name: 'bad', overrides: [{ op: 'nope' }] }];
  const without = (await call('evaluate_batch', { ...h, scenarios, top: 2 })).d;
  const r = (await call('evaluate_batch', { ...h, scenarios, top: 1, export: folder() })).d;
  const withTop = (await call('evaluate_batch', { ...h, scenarios, top: 1 })).d;
  assert.deepEqual(plain(r), plain(withTop));
  const first = without.scenarios[0];
  assert.deepEqual([first.changed.length, first.changed_total], [200, 231], 'every later activity and the milestone moved');
  const { json, csv } = files(r, 'evaluate_batch');
  assert.equal(r.scenarios[0].changed, undefined, 'not among the best 1');
  assert.equal(json.scenarios[0].changed.length, 231);
  assert.equal(csv.dates_moved.filter((x) => x.scenario === 'first longer').length, 231);
  assert.equal(csv.dates_moved.length, 231 + json.scenarios[1].changed_total);
  assert.equal(csv.scenarios.length, 3);
  assert.equal(csv.scenarios[0].dates_moved, '231');
  await call('close', { ...h, discard: true });
});

test('crash_schedule, float_paths, progress_curves, resource_histogram, tia, level_resources, evaluate, compare and review export their tables', async () => {
  const h = await chain('MISC', 12, [{ op: 'add_resource', id: 'crew', name: 'Crew', max_units_per_hour: 1 }, { op: 'assign_resource', activity: 'A1', resource: 'crew', units_per_day: 8 }, { op: 'add_activity', id: 'P', name: 'Parallel', duration_days: 4 }, { op: 'assign_resource', activity: 'P', resource: 'crew', units_per_day: 8 }]);
  const c = (await call('crash_schedule', { handle: h.handle, target_days: 3, export: folder() })).d;
  let f = files(c, 'crash_schedule');
  assert.equal(f.csv.steps.length, c.steps.length); assert.ok(c.steps.length);
  assert.equal(f.csv.changes.length, c.changes.length);
  assert.equal(f.csv.step_activities.length, c.steps.reduce((s: number, x: any) => s + x.activities.length, 0));
  const fp = (await call('float_paths', { handle: h.handle, between: { from: 'A0', to: 'M1' }, export: folder() })).d;
  f = files(fp, 'float_paths');
  assert.equal(f.csv.paths.length, fp.paths.reduce((s: number, p: any) => s + p.activities.length, 0));
  assert.equal(f.csv.between.length, fp.between.paths.length);
  const pc = (await call('progress_curves', { handle: h.handle, units: 'hours', export: folder() })).d;
  f = files(pc, 'progress_curves');
  assert.equal(f.csv.periods.length, pc.periods.length); assert.equal(f.csv.totals.length, 1);
  const rh = (await call('resource_histogram', { handle: h.handle, export: folder() })).d;
  f = files(rh, 'resource_histogram');
  assert.equal(f.csv.periods.length, rh.resources[0].periods.length); assert.equal(f.csv.resources[0].resource, 'crew');
  const t = (await call('tia', { handle: h.handle, fragnet: [{ op: 'add_activity', id: 'X', name: 'Change', duration_days: 2 }, { op: 'add_relationship', pred: 'A3', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'A4' }], export: folder() })).d;
  f = files(t, 'tia');
  assert.equal(f.csv.fragnet_path.length, t.fragnet_path.length); assert.equal(f.csv.summary[0].delay_days, String(t.delay_days));
  const lv = (await call('level_resources', { handle: h.handle, dry_run: true, export: folder() })).d;
  f = files(lv, 'level_resources');
  assert.equal(f.csv.moved.length, lv.moved.length); assert.ok(lv.moved.length); assert.equal(f.csv.peaks.length, lv.peaks.length);
  // evaluate: changed cut by max_rows, the export has every field of every activity that changed
  const ev = (await call('evaluate', { handle: h.handle, overrides: [{ op: 'update_activity', id: 'A0', duration_days: 6 }], max_rows: 2, export: folder() })).d;
  assert.deepEqual(plain(ev), plain((await call('evaluate', { handle: h.handle, overrides: [{ op: 'update_activity', id: 'A0', duration_days: 6 }], max_rows: 2 })).d));
  assert.equal(ev.changed.length, 2); assert.ok(ev.changed_total > 2);
  f = files(ev, 'evaluate');
  assert.equal(f.json.changed.length, ev.changed_total);
  assert.equal(f.csv.changed.length, f.json.changed.reduce((s: number, x: any) => s + Object.values(x).filter(Array.isArray).length, 0));
  // compare against the baseline: the answer pages the changes, the export has them all
  await call('edit', { ...h, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }, { op: 'update_activity', id: 'A0', duration_days: 6 }] });
  await call('schedule', h);
  const cmp = (await call('compare', { handle: h.handle, baseline: 'project', max_changes: 1, export: folder() })).d;
  assert.equal(cmp.changes.length, 1); assert.ok(cmp.changed > 1 && cmp.truncated);
  f = files(cmp, 'compare');
  assert.equal(f.csv.changes.length, cmp.changed); assert.equal(f.json.changes.length, cmp.changed); assert.equal(f.json.truncated, false);
  await call('close', { ...h, discard: true });
  // review: 10 examples per check (examples_total says how many), the export every one
  const k = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const rv = (await call('review', { handle: k, export: folder() })).d;
  const many = rv.checks.find((x: any) => x.examples_total > 10);
  assert.ok(many && many.examples.length === 10);
  f = files(rv, 'review');
  assert.equal(f.csv.activities.filter((x) => x.check === many.id).length, many.examples_total);
  assert.equal(f.json.checks.find((x: any) => x.id === many.id).examples.length, many.examples_total);
  await call('close', { handle: k, discard: true });
});

test('lob_view: limit cuts the lists (their _totals say how many there are), the export has every location, collision and gap', async () => {
  const np = (await call('new_project', { id: 'LOBX', start: '2026-03-02' })).d;
  const TASKS = [
    { code: 'CS', name: 'Concrete skeleton', trade: 'Concrete', level: 'Floor', unit: 'm3', consumption: 9, quantity: 60, crew_size: 18 },
    { code: 'DW', name: 'Drywall', trade: 'Drywall', level: 'Floor', unit: 'm2', consumption: 0.5, quantity: 1400, crew_size: 16 },
  ];
  const c = await call('lob_create', { handle: np.handle, owner_key: np.owner_key, id: 'TOWER', start: '2026-03-02', locations: { levels: ['Floor'], grid: [8] }, tasks: TASKS, links: [{ pred: 'CS', succ: 'DW' }] });
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 300));
  const v = (await call('lob_view', { handle: np.handle, project: 'TOWER', limit: 3, export: folder() })).d;
  assert.ok(v.tasks.every((t: any) => t.locations.length === 3 && t.locations_total === 8));
  const { json, csv } = files(v, 'lob_view');
  assert.equal(csv.locations.length, 16); assert.equal(csv.trades.length, 2);
  assert.ok(json.tasks.every((t: any) => t.locations.length === 8));
  assert.equal(csv.gaps.length, v.gaps_total); assert.equal(csv.collisions.length, v.collisions_total);
  assert.equal(csv.segments.length, json.tasks.reduce((s: number, t: any) => s + t.segments.length, 0));
  // limit 0 lists everything, as max_ids 0 does elsewhere
  const all = (await call('lob_view', { handle: np.handle, project: 'TOWER', limit: 0 })).d;
  assert.ok(all.tasks.every((t: any) => t.locations.length === 8), JSON.stringify(all.tasks.map((t: any) => t.locations.length)));
  assert.equal(all.gaps.length, all.gaps_total); assert.equal(all.collisions.length, all.collisions_total);
  assert.match((await import('../mcp/server.ts')).toolsList().find((t: any) => t.name === 'lob_view')!.description, /limit \(default 200; 0 = all\)/);
});

test('optimize_schedule: the export lists every activity under CPM, P6 leveling and the reasoner, and the whole priority order', { skip: !reasonerModelPath() && 'models/reasoner.onnx is not present' }, async () => {
  const np = (await call('new_project', { id: 'OPTX', start: '2026-06-01' })).d;
  const ops: unknown[] = [{ op: 'add_resource', id: 'civil', name: 'Civil', max_units_per_hour: 2 }];
  for (let i = 0; i < 110; i++) ops.push({ op: 'add_activity', id: `B${i}`, name: `B${i}`, duration_days: 1 + (i % 4) }, { op: 'assign_resource', activity: `B${i}`, resource: 'civil', units_per_day: 16 });
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const r = (await call('optimize_schedule', { handle: np.handle, seed: 1, samples: 4, export: folder() })).d;
  assert.equal(r.priority.length, 100); assert.equal(r.priority_total, 110);
  const { json, csv } = files(r, 'optimize_schedule');
  assert.equal(csv.priority.length, 110); assert.equal(json.priority.length, 110);
  assert.deepEqual(csv.priority.slice(0, 100).map((x) => x.id), r.priority);
  assert.equal(csv.activities.length, 110);
  assert.ok(csv.activities.every((x) => x.cpm_start && x.reasoner_finish && x.finish_delta_days !== ''));
  assert.equal(csv.activities.map((x) => x.reasoner_finish).sort().at(-1), r.reasoner_finish);
  assert.equal(csv.activities.map((x) => x.cpm_finish).sort().at(-1), r.cpm_finish);
});

test('kept runs of monte_carlo and evaluate_batch live at an absolute path: with no write root and the start folder deleted they still run, keep and resume', { timeout: 120_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'p6-kept-cwd-')), tmp = mkdtempSync(join(tmpdir(), 'p6-kept-tmp-'));
  // a server started without any root, in a folder that is then removed
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, P6CLONE_COMPUTE_WORKERS: '0' } });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const k = ++id; waiting.set(k, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  const tool = async (name: string, args: Record<string, unknown>) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: !!r.result?.isError, d: r.result?.structuredContent }; };
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    rmSync(cwd, { recursive: true, force: true });
    const np = (await tool('new_project', { id: 'K', start: '2026-03-02' })).d;
    const H = { handle: np.handle, owner_key: np.owner_key };
    assert.equal((await tool('edit', { ...H, operations: [{ op: 'add_activity', id: 'A', name: 'a', duration_days: 3 }, { op: 'add_activity', id: 'B', name: 'b', duration_days: 4 }, { op: 'add_relationship', pred: 'A', succ: 'B' }] })).err, false);
    const mc = { ...H, iterations: 40, seed: 2, default_estimates: { min_pct: 90, max_pct: 125 } };
    const full = await tool('monte_carlo', mc);
    assert.equal(full.err, false, JSON.stringify(full.d).slice(0, 300));
    assert.ok(full.d.parts_removed.startsWith('/') || /^[A-Za-z]:/.test(full.d.parts_removed), `an absolute path: ${full.d.parts_removed}`);
    const b = await tool('evaluate_batch', { ...H, scenarios: [{ name: 's', overrides: [{ op: 'update_activity', id: 'A', duration_days: 1 }] }] });
    assert.equal(b.err, false, JSON.stringify(b.d).slice(0, 300));
    assert.ok(/^(\/|[A-Za-z]:)/.test(b.d.parts_removed), b.d.parts_removed);
    // a run that is cancelled at once keeps nothing, and one cancelled later keeps its iterations at an absolute path it answers
    const job = (await tool('monte_carlo', { ...mc, iterations: 20000, async: true })).d.job_id;
    for (let i = 0; i < 100 && !/[1-9]\d* of/.test((await tool('job_status', { job_id: job })).d.progress ?? ''); i++) await new Promise((r) => setTimeout(r, 50));
    await tool('cancel_job', { job_id: job });
    let part: any;
    for (let i = 0; i < 200; i++) { part = (await tool('job_status', { job_id: job, wait_seconds: 1 })).d; if (part.status !== 'running') break; }
    assert.equal(part.result.partial, true, JSON.stringify(part).slice(0, 300));
    assert.ok(/^(\/|[A-Za-z]:)/.test(part.result.resume) && existsSync(part.result.resume), part.result.resume);
    const resumed = await tool('monte_carlo', { ...mc, iterations: 20000, resume: part.result.resume, async: true });
    assert.equal(resumed.err, false, JSON.stringify(resumed.d).slice(0, 300));
    await tool('cancel_job', { job_id: resumed.d.job_id });
  } finally { p.stdin.end(); }
});
