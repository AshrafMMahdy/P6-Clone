// The analysis tools' `export` option (owner 2026-11-09): export: "<folder>" writes <tool>.json, the FULL result (every list whole,
// whatever top / max_ids / limit / max_rows cut from the chat answer), and one CSV per table beside it, so an agent builds Excel
// sheets, Word reports and slides from every number. The chat answer is the same with or without export (plus exported), and every
// list it cuts says how many there are (<list>_total). Monte Carlo's iterations.csv holds the exact finishes the statistics come
// from (also after a stop and a resume): sorted, they give the reported percentiles exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';
import { testHooks } from '../core/risk/montecarlo.ts';
import { percentile } from '../core/risk/montecarlo.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { reasonerModelPath } from '../core/analysis/hrmRuntime.ts';
import { exportResult, fileNameLength } from '../mcp/export.ts';
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
    const file = f.path.split(/[\\/]/).pop()!;
    assert.ok(file.startsWith(`${tool}-`) && file.endsWith('.csv'), `${file} is named <tool>-<table>.csv`);
    csv[file.slice(tool.length + 1, -4)] = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  return { json: JSON.parse(readFileSync(json, 'utf8')), csv };
}
/** The answer as it is without export. */
// (and without the <list>_note an export adds beside a cut list: noteCuts, proved in E4)
const unnoted = (v: any): any => (Array.isArray(v) ? v.map(unnoted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !/[a-z]_note$/.test(k) || k === 'redone_note' || k === 'resumed_note').map(([k, x]) => [k, unnoted(x)])) : v);
const plain = (d: any) => { const { exported: _e, elapsed_seconds: _s, ...rest } = d; return unnoted(rest); };

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

test('check_schedule, dcma_14 and lint: the answer lists 25 per check, the files (written without being asked) hold every activity of every check', async () => {
  const h0 = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const hBig = (await call('open_file', { path: sampleCopy('Baseline Zone 2 Rev.01.xer') })).d.handle; // (lint finds more than 25 here)
  for (const [tool, found, extra] of [['check_schedule', 'failing_activities', {}], ['dcma_14', 'failing_activities', {}], ['lint', 'findings', { profile: 'platform', simulate: false }]] as const) {
    const h = tool === 'lint' ? hBig : h0;
    // no export given: the same files go to analysis/<project short name>/<tool> (R3)
    const without = (await call(tool, { handle: h, ...extra })).d;
    assert.ok(without.exported.files.length > 1, `${tool}: files written by default`);
    assert.match(without.exported.folder.replace(/\\/g, '/'), new RegExp(`/analysis/[^/]+/${tool}$`), without.exported.folder);
    const r = await call(tool, { handle: h, ...extra, export: folder() });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.deepEqual(plain(r.d), plain(without), `${tool}: the answer is the one of the default folder`);
    const { json, csv } = files(r.d, tool);
    const cut = r.d.checks.filter((c: any) => c.total_activities > 25);
    assert.ok(cut.length, `${tool}: some check found more than 25`);
    assert.ok(r.d.checks.every((c: any) => c.activities.length === Math.min(25, c.total_activities)), tool);
    // each cut check says where all of them are: the file given by export, holding every one
    assert.ok(cut.every((c: any) => c.activities_note === `25 of ${c.total_activities} shown; all ${c.total_activities} in ${r.d.exported.files.find((f: any) => f.path.endsWith(`-${found}.csv`)).path}.`), tool);
    // the json holds every activity of every check, and the CSV one row for each
    assert.ok(json.checks.every((c: any) => c.activities.length === c.total_activities), tool);
    const total = json.checks.reduce((s: number, c: any) => s + c.total_activities, 0);
    assert.equal(csv[found].length, total, `${tool}: ${found}.csv`);
    assert.equal(csv.checks.length, r.d.checks.length);
    assert.equal(csv.checks.find((c) => c.id === cut[0].id)!.total_activities, String(cut[0].total_activities));
    if (tool === 'lint') {
      assert.ok('fixes' in csv);
      const by = (id: string) => r.d.checks.find((c: any) => c.id === id);
      assert.equal(typeof by('fs_overlap').ladders_total, 'number');
      assert.equal(typeof by('connectivity').no_predecessor_total, 'number');
      assert.equal(typeof by('redundant_links').fixes_total, 'number');
      assert.ok(r.d.checks.every((c: any) => typeof c.total_activities === 'number'));
      // every list of fixes shows at most 25, says fixes_total and names the file that holds them all (the fixes table)
      for (const c of r.d.checks.filter((x: any) => x.fixes)) {
        assert.ok(c.fixes.length <= 25, c.id);
        if (c.fixes_total > 25) assert.equal(c.fixes_note, `25 of ${c.fixes_total} shown; all ${c.fixes_total} in ${r.d.exported.files.find((f: any) => f.path.endsWith('-fixes.csv')).path}.`);
      }
      assert.equal(csv.fixes.length, json.checks.reduce((s: number, c: any) => s + (c.fixes?.length ?? 0), 0));
    }
    if (tool === 'check_schedule') assert.ok(csv.checks[0].threshold_op && csv.projects.length);
  }
  // the HTML report is the answer's, as before
  const h = h0;
  const html = await call('dcma_14', { handle: h, path: join(root, 'dcma.html'), export: folder() });
  assert.ok(existsSync(html.d.saved) && html.d.exported.files.length === 3);
  // a folder outside the write root is refused
  const out = await call('dcma_14', { handle: h, export: join(tmpdir(), '..', 'elsewhere-p6-export') });
  assert.deepEqual([out.err, out.d.error.code], [true, 'path_outside_root']);
  await call('close', { handle: h, discard: true });
  await call('close', { handle: hBig, discard: true });
});

test('monte_carlo: iterations.csv holds every iteration, whose sorted finishes give the reported percentiles exactly, also after a stop and a resume', async () => {
  const h = await chain('MCX', 30);
  const args = { ...h, iterations: 120, seed: 5, default_estimates: { min_pct: 80, max_pct: 150 }, deadline: '2026-07-15', events: [{ name: 'Permit', probability: 0.3, delay_days: 3 }] };
  const without = (await call('monte_carlo', args)).d;
  const r = (await call('monte_carlo', { ...args, export: folder() })).d;
  assert.deepEqual(plain(r), plain(without), 'the answer is the one of the default folder');
  // the lists cut to 25 say how many there are
  assert.equal(r.criticality.length, 25); assert.equal(r.criticality_total, 31);
  assert.equal(r.milestones.length, 1); assert.equal(r.milestones_total, 1, 'the total is given when nothing is cut too');
  assert.equal(r.sensitivity.length, Math.min(25, r.sensitivity_total));
  // the chart is always 20 equal date bars; the S-curve shows at most 25 points of cumulative_total
  assert.equal(r.histogram.length, 20);
  assert.ok(r.cumulative.length <= 25 && r.cumulative_total >= r.cumulative.length);
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
  // the file's histogram is the chart the answer shows: the same 20 bars, counting every iteration
  assert.equal(csv.histogram.length, 20);
  assert.deepEqual(csv.histogram.map((b) => [b.start, b.end, Number(b.count), Number(b.cum_pct)]), r.histogram.map((b: any) => [b.start, b.end, b.count, b.cum_pct]));
  assert.deepEqual(json.histogram, r.histogram);
  assert.equal(csv.histogram.reduce((s, b) => s + Number(b.count), 0), 120);
  assert.equal(csv.histogram.at(-1)!.cum_pct, '100');

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
  assert.equal(files(part, 'monte_carlo-partial').csv.iterations.length, 30);
  await call('close', { ...h, discard: true });
});

test('windows_analysis: each window lists 25 of each list, a cut list says how many there are and where all of them are, the files (written by default) have them all', async () => {
  const h = await chain('WINX', 60);
  await call('edit', { ...h, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] });
  const updates = [{ baseline: 'project' }, { name: 'U1', data_date: '2026-03-09', progress: [{ op: 'update_activity', id: 'A0', actual_start: '2026-03-04 08:00', remaining_days: 4 }] }];
  // no export given: the files are written to the default folder and hold every activity
  const dflt = (await call('windows_analysis', { handle: h.handle, include_current: false, updates })).d;
  const w = dflt.windows[0];
  assert.ok(dflt.exported.files.length > 1 && /windows_analysis$/.test(dflt.exported.folder.replace(/\\/g, '/')));
  assert.ok(w.driving_path_total > 25 && w.lost_time_total > 25);
  assert.deepEqual([w.driving_path.length, w.lost_time.length], [25, 25]);
  const where = (t: string) => dflt.exported.files.find((f: any) => f.path.endsWith(`-${t}.csv`)).path;
  assert.equal(w.driving_path_note, `25 of ${w.driving_path_total} shown; all ${w.driving_path_total} in ${where('driving_path')}.`);
  assert.equal(w.lost_time_note, `25 of ${w.lost_time_total} shown; all ${w.lost_time_total} in ${where('lost_time')}.`);
  const r = (await call('windows_analysis', { handle: h.handle, include_current: false, updates, max_ids: 3, export: folder() })).d;
  assert.deepEqual([r.windows[0].driving_path.length, r.windows[0].lost_time.length, r.windows[0].lost_time_total], [25, 25, w.lost_time_total]);
  assert.match(r.notes[0], /^windows_analysis has no argument "max_ids"/);
  const { json, csv } = files(r, 'windows_analysis');
  assert.equal(json.windows[0].driving_path.length, w.driving_path_total);
  assert.equal(csv.driving_path.length, w.driving_path_total);
  assert.equal(csv.lost_time.length, w.lost_time_total);
  assert.equal(csv.windows.length, 1);
  await call('close', { ...h, discard: true });
});

test('evaluate_batch: the export lists every activity every scenario moved; the answer the first 25 of the best, with changed_total', async () => {
  const h = await chain('BATX', 230);
  const scenarios = [{ name: 'first longer', overrides: [{ op: 'update_activity', id: 'A0', duration_days: 9 }] }, { name: 'last longer', overrides: [{ op: 'update_activity', id: 'A229', duration_days: 9 }] }, { name: 'bad', overrides: [{ op: 'nope' }] }];
  const without = (await call('evaluate_batch', { ...h, scenarios, top: 2 })).d;
  assert.ok(without.exported.files.length > 1, 'written without being asked');
  const r = (await call('evaluate_batch', { ...h, scenarios, top: 1, export: folder() })).d;
  const withTop = (await call('evaluate_batch', { ...h, scenarios, top: 1 })).d;
  assert.deepEqual(plain(r), plain(withTop));
  const first = without.scenarios[0];
  assert.deepEqual([first.changed.length, first.changed_total], [25, 231], 'every later activity and the milestone moved');
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
  // the answer is a summary: no per-period series in it, the periods of every resource are in the file, and periods_total says how many each has
  assert.equal(rh.resources[0].periods, undefined);
  assert.equal(f.csv.periods.length, f.json.resources.reduce((n: number, x: any) => n + x.periods.length, 0)); assert.equal(f.csv.resources[0].resource, 'crew');
  assert.equal(rh.resources[0].periods_total, f.csv.periods.filter((p: any) => p.resource === 'crew').length);
  assert.equal(rh.resources_total, 1);
  assert.equal(rh.periods_note, undefined);
  assert.match(rh.notes.join(' '), new RegExp(`^Per-period figures not shown; all ${f.csv.periods.length} periods in .*resource_histogram-periods\\.csv\\.$`));
  const t = (await call('tia', { handle: h.handle, fragnet: [{ op: 'add_activity', id: 'X', name: 'Change', duration_days: 2 }, { op: 'add_relationship', pred: 'A3', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'A4' }], export: folder() })).d;
  f = files(t, 'tia');
  assert.equal(f.csv.fragnet_path.length, t.fragnet_path.length); assert.equal(f.csv.summary[0].delay_days, String(t.delay_days));
  const lv = (await call('level_resources', { handle: h.handle, dry_run: true, export: folder() })).d;
  f = files(lv, 'level_resources');
  assert.equal(f.csv.moved.length, lv.moved.length); assert.ok(lv.moved.length); assert.equal(f.csv.peaks.length, lv.peaks.length);
  // evaluate: changed cut to 25, the files (default folder or export) have every field of every activity that changed
  const hb = await chain('EVBIG', 40);
  const ev = (await call('evaluate', { handle: hb.handle, overrides: [{ op: 'update_activity', id: 'A0', duration_days: 6 }], export: folder() })).d;
  assert.deepEqual(plain(ev), plain((await call('evaluate', { handle: hb.handle, overrides: [{ op: 'update_activity', id: 'A0', duration_days: 6 }] })).d));
  assert.equal(ev.changed.length, 25); assert.ok(ev.changed_total > 25);
  await call('close', { ...hb, discard: true });
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
  // biggest_changes: the answer shows the first 25 (max_changes), the export every activity whose dates differ from CPM, largest first
  assert.ok(r.biggest_changes_total > 25, `${r.biggest_changes_total} activities changed`);
  assert.equal(r.biggest_changes.length, 25);
  assert.equal(csv.biggest_changes.length, r.biggest_changes_total); assert.equal(json.biggest_changes.length, r.biggest_changes_total);
  assert.deepEqual(csv.biggest_changes.slice(0, 25).map((x) => x.id), r.biggest_changes.map((x: any) => x.id));
  const fin = csv.biggest_changes.map((x) => Math.abs(Number(x.finish_delta_days)));
  assert.deepEqual(fin, [...fin].sort((x, y) => y - x), 'largest finish shift first');
  assert.ok(csv.biggest_changes.every((x) => x.cpm_start !== x.reasoner_start || x.cpm_finish !== x.reasoner_finish), 'only activities whose dates differ');
  const act = new Map(csv.activities.map((x) => [x.id, x]));
  assert.equal(act.get(r.biggest_changes[0].id)!.finish_delta_days, String(r.biggest_changes[0].finish_delta_days));
  const some = (await call('optimize_schedule', { handle: np.handle, seed: 1, samples: 4, max_changes: 4 })).d;
  assert.equal(some.biggest_changes.length, 4); assert.equal(some.biggest_changes_total, r.biggest_changes_total);
  const every = (await call('optimize_schedule', { handle: np.handle, seed: 1, samples: 4, max_changes: 0 })).d;
  assert.equal(every.biggest_changes.length, r.biggest_changes_total, 'max_changes 0 = all');
  assert.match((await import('../mcp/server.ts')).toolsList().find((t: any) => t.name === 'optimize_schedule')!.description, /review biggest_changes[^]*undo takes the apply back[^]*better_than_p6_leveler: false means P6/);
});

// (not on Windows: a folder that is a running process's working folder cannot be deleted there (EPERM), so a server whose start folder
// is gone cannot happen on Windows; the test runs everywhere it can happen)
test('kept runs of monte_carlo and evaluate_batch live at an absolute path: with no write root and the start folder deleted they still run, keep and resume', { timeout: 120_000, skip: process.platform === 'win32' && 'Windows cannot delete a running process\u2019s working folder, so a deleted start folder cannot happen there' }, async () => {
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

test('exports of several tools share a folder; a tool\'s earlier export there is replaced whole, every table written (header only when empty)', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const dir = folder();
  const cs = (await call('check_schedule', { handle: h, export: dir })).d, dc = (await call('dcma_14', { handle: h, export: dir })).d;
  assert.ok(existsSync(join(dir, 'check_schedule-checks.csv')) && existsSync(join(dir, 'dcma_14-checks.csv')));
  assert.equal(files(cs, 'check_schedule').csv.checks.length, cs.checks.length, 'not overwritten by dcma_14');
  assert.equal(files(dc, 'dcma_14').csv.checks.length, 14);
  // a table with no rows has its header row; a re-run replaces this tool's files only (a table it no longer has is not left behind)
  const end = (await call('float_paths', { handle: h, export: dir })).d.end;
  const fp1 = (await call('float_paths', { handle: h, export: dir, between: { from: (await call('float_paths', { handle: h })).d.paths[0].activities[0].id, to: end } })).d;
  assert.ok(fp1.exported.files.some((f: any) => f.path.endsWith('float_paths-between.csv') && f.rows > 0));
  writeFileSync(join(dir, 'float_paths-old.csv'), 'stale');
  const fp2 = (await call('float_paths', { handle: h, export: dir })).d;
  const between = fp2.exported.files.find((f: any) => f.path.endsWith('float_paths-between.csv'));
  assert.equal(between.rows, 0); assert.deepEqual(readCsv(between.path), [['path', 'duration_days', 'min_float_days', 'activities']]);
  assert.equal(existsSync(join(dir, 'float_paths-old.csv')), false, 'this tool\'s stale file is gone');
  assert.ok(existsSync(join(dir, 'dcma_14-checks.csv')) && existsSync(join(dir, 'check_schedule.json')), 'other tools\' files stay');
  await call('close', { handle: h, discard: true });
});

test('an export that cannot be written: refused before any change when the folder cannot be made; after a change, said beside the result', async () => {
  const h = await chain('EXF', 4);
  const tia = { ...h, fragnet: [{ op: 'add_activity', id: 'X', name: 'Change', duration_days: 2 }, { op: 'add_relationship', pred: 'A1', succ: 'X' }], keep: true };
  const file = join(root, 'not-a-folder.txt');
  writeFileSync(file, 'x');
  const refused = await call('tia', { ...tia, export: join(file, 'sub') });
  assert.deepEqual([refused.err, refused.d.error.code], [true, 'file_unwritable']);
  const { getSession } = await import('../mcp/runtime.ts');
  const projects = () => getSession(h.handle).db.tables.PROJECT.rows.map((p) => p.proj_short_name);
  assert.deepEqual(projects(), ['EXF'], 'nothing was changed');
  // the folder is there, but its json cannot be written (a folder of that name is in the way): the kept copy stays, and the answer says so
  const dir = folder();
  mkdirSync(join(dir, 'tia.json'), { recursive: true }); writeFileSync(join(dir, 'tia.json', 'x'), 'x');
  const t = await call('tia', { ...tia, export: dir });
  assert.equal(t.err, false, JSON.stringify(t.d).slice(0, 300));
  assert.equal(t.d.kept_as, 'EXF-TIA');
  assert.match(t.d.export_error, /the change WAS made/);
  assert.deepEqual(projects(), ['EXF', 'EXF-TIA']);
  await call('close', { ...h, discard: true });
});

test('evaluate_batch: a batch started without export and resumed with it exports every activity of every scenario, as an uninterrupted one', async () => {
  const h = await chain('BRX', 60);
  const N = 120;
  const scenarios = Array.from({ length: N }, (_, i) => ({ name: `s${i}`, overrides: [{ op: 'update_activity', id: `A${i % 60}`, duration_days: 4 + (i % 3) }] }));
  const whole = (await call('evaluate_batch', { ...h, scenarios, export: folder() })).d;
  const ref = files(whole, 'evaluate_batch');
  assert.ok(ref.csv.dates_moved.length > N, String(ref.csv.dates_moved.length));
  assert.ok(whole.parts_removed && !existsSync(whole.parts_removed), 'the kept file went once the export was written');
  const job = (await call('evaluate_batch', { ...h, scenarios, async: true })).d.job_id;
  for (let k = 0; k < 4000; k++) { const v = (await call('job_status', { job_id: job })).d; const m = /scenario (\d+) of/.exec(String(v.progress ?? '')); if (v.status !== 'running' || (m && Number(m[1]) > 10)) break; await new Promise((r) => setTimeout(r, 2)); }
  await call('cancel_job', { job_id: job });
  let part: any;
  for (;;) { const v = (await call('job_status', { job_id: job, wait_seconds: 2 })).d; if (v.status !== 'running') { part = v.result ?? v; break; } }
  assert.equal(part.partial, true, JSON.stringify(part).slice(0, 300));
  const resumed = (await call('evaluate_batch', { ...h, scenarios, resume: part.resume, export: folder() })).d;
  assert.equal(resumed.resumed_scenarios, part.scenarios_done);
  const got = files(resumed, 'evaluate_batch');
  assert.deepEqual(got.csv.dates_moved, ref.csv.dates_moved);
  assert.deepEqual(got.csv.scenarios, ref.csv.scenarios);
  assert.deepEqual(got.json.scenarios, ref.json.scenarios);
  assert.equal(existsSync(part.resume), false);
  await call('close', { ...h, discard: true });
});

test('CSV cells: text Excel would run as a formula starts with \', a lone CR is quoted; review lists activities by ID and name, saved dates apart', async () => {
  const np = (await call('new_project', { id: 'CSVX', start: '2026-03-02' })).d;
  const H = { handle: np.handle, owner_key: np.owner_key };
  await call('edit', { ...H, operations: [{ op: 'add_activity', id: 'A1', name: '=HYPERLINK("x")', duration_days: 2 }, { op: 'add_activity', id: 'A2', name: '+1 crew', duration_days: 2 }, { op: 'add_activity', id: 'A3', name: 'one\rtwo', duration_days: 2 }, { op: 'add_activity', id: 'A4', name: '@home', duration_days: 2 }] });
  await call('schedule', H);
  const rv = (await call('review', { ...H, export: folder() })).d;
  const { csv } = files(rv, 'review');
  const logic = csv.activities.filter((x) => x.check === 'logic');
  assert.deepEqual(logic.map((x) => [x.id, x.name]), [['A1', '\'=HYPERLINK("x")'], ['A2', '\'+1 crew'], ['A3', 'one\rtwo'], ['A4', '\'@home']]);
  assert.equal(rv.checks.find((c: any) => c.id === 'logic').examples_total, 4);
  assert.ok('saved_dates' in csv);
  assert.ok(csv.checks.every((c) => !('examples' in c)));
  await call('close', { ...H, discard: true });
});

test('earned_value exports every activity and figure (the answer lists the worst few, with totals); windows_analysis names the last state current_name', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const ev = await call('earned_value', { handle: h, worst: 2, export: folder() });
  assert.equal(ev.err, false, JSON.stringify(ev.d).slice(0, 300));
  assert.ok(ev.d.worst_cost_performance.length <= 2 && ev.d.worst_schedule_performance.length <= 2);
  const { json, csv } = files(ev.d, 'earned_value');
  assert.equal(csv.worst_schedule_performance.length, ev.d.worst_schedule_performance_total);
  assert.equal(csv.worst_cost_performance.length, ev.d.worst_cost_performance_total);
  assert.ok(csv.activities.length >= csv.worst_schedule_performance.length && csv.activities.length > 2, String(csv.activities.length));
  assert.equal(csv.totals.length, json.projects.length);
  assert.equal(csv.by_wbs.length, json.projects.reduce((n: number, p: any) => n + p.by_wbs.length, 0));
  assert.deepEqual(plain(ev.d), plain((await call('earned_value', { handle: h, worst: 2 })).d));
  await call('close', { handle: h, discard: true });
  // windows_analysis: the handle's state named as the platform names it
  const w = await chain('WNAME', 4);
  await call('edit', { ...w, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] });
  const r = (await call('windows_analysis', { handle: w.handle, updates: [{ baseline: 'project' }], current_name: 'Update 3 (2026-03-09)', export: folder() })).d;
  assert.equal(r.updates.at(-1).name, 'Update 3 (2026-03-09)');
  assert.equal(r.windows.at(-1).to, 'Update 3 (2026-03-09)');
  assert.equal(files(r, 'windows_analysis').csv.windows.at(-1)!.to, 'Update 3 (2026-03-09)');
  assert.equal((await call('windows_analysis', { handle: w.handle, updates: [{ baseline: 'project' }] })).d.updates.at(-1).name, 'current');
  await call('close', { ...w, discard: true });
});

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const names = (dir: string) => readdirSync(dir).sort();

test('E1: a partial result is written as <tool>-partial and never replaces a complete run\'s files; a later complete run removes both', async () => {
  const h = await chain('E1', 12);
  const args = { ...h, iterations: 60, seed: 4, default_estimates: { min_pct: 80, max_pct: 150 } };
  const dir = folder();
  const full = (await call('monte_carlo', { ...args, export: dir })).d;
  assert.ok(full.exported && full.partial === undefined);
  const complete = names(dir), json = join(dir, 'monte_carlo.json'), before = sha(json), csvBefore = sha(join(dir, 'monte_carlo-iterations.csv'));
  assert.ok(complete.includes('monte_carlo.json') && complete.includes('monte_carlo-iterations.csv') && !complete.some((f) => f.includes('partial')));
  // a run that stopped after 25 iterations (an iteration failed), exported to the same folder
  testHooks.failAt = 25;
  let part;
  try { part = (await call('monte_carlo', { ...args, iterations: 100, export: dir })).d; } finally { testHooks.failAt = null; }
  assert.equal(part.partial, true); assert.equal(part.iterations_done, 25);
  assert.equal(part.exported.replaced, undefined, 'nothing of an earlier partial to replace');
  assert.ok(part.exported.files.every((f: any) => /monte_carlo-partial(\.json|-[a-z_]+\.csv)$/.test(f.path)), JSON.stringify(part.exported.files.map((f: any) => f.path)));
  assert.equal(part.exported.files[0].path, join(dir, 'monte_carlo-partial.json'));
  assert.equal(sha(json), before, 'the complete run\'s json is untouched');
  assert.equal(sha(join(dir, 'monte_carlo-iterations.csv')), csvBefore, 'and its csv');
  for (const f of complete) assert.ok(existsSync(join(dir, f)), `${f} is still there`);
  assert.equal(JSON.parse(readFileSync(join(dir, 'monte_carlo-partial.json'), 'utf8')).iterations, 25);
  assert.equal(readCsv(join(dir, 'monte_carlo-partial-iterations.csv')).length, 26, 'the 25 iterations done and the header');
  // another partial replaces only the earlier partial's files
  testHooks.failAt = 10;
  let part2;
  try { part2 = (await call('monte_carlo', { ...args, iterations: 100, export: dir })).d; } finally { testHooks.failAt = null; }
  assert.equal(part2.exported.replaced.files, part.exported.files.length, 'the earlier partial\'s files');
  assert.equal(readCsv(join(dir, 'monte_carlo-partial-iterations.csv')).length, 11);
  assert.equal(sha(json), before, 'the complete run\'s json is still untouched');
  // a complete run removes the old complete files and the partial ones
  const again = (await call('monte_carlo', { ...args, seed: 9, export: dir })).d;
  assert.equal(again.exported.replaced.files, complete.length + part2.exported.files.length, 'complete and partial files both');
  assert.deepEqual(names(dir), complete, 'only the new complete run\'s files are left');
  assert.notEqual(sha(json), before, 'a new run (another seed)');
  // the other direction: a partial exported first, then a complete one removes it
  const dir2 = folder();
  testHooks.failAt = 10;
  try { await call('monte_carlo', { ...args, iterations: 100, export: dir2 }); } finally { testHooks.failAt = null; }
  assert.ok(existsSync(join(dir2, 'monte_carlo-partial.json')));
  await call('monte_carlo', { ...args, export: dir2 });
  assert.deepEqual(names(dir2), complete);
});

test('E2 and E3: exported.replaced says how many files an export removed and when the earlier json was written; every file says its bytes', async () => {
  const h = await chain('E2', 8);
  const dir = folder();
  const first = (await call('crash_schedule', { ...h, target_days: 3, export: dir })).d;
  assert.equal(first.exported.replaced, undefined, 'nothing was replaced');
  for (const f of first.exported.files) assert.equal(f.bytes, statSync(f.path).size, f.path);
  assert.ok(first.exported.files.every((f: any) => f.bytes > 0));
  const written = statSync(join(dir, 'crash_schedule.json')).mtime.toISOString();
  const second = (await call('crash_schedule', { ...h, target_days: 3, export: dir })).d;
  assert.deepEqual(second.exported.replaced, { files: first.exported.files.length, written });
  for (const f of second.exported.files) assert.equal(f.bytes, statSync(f.path).size);
  // other tools' files are not counted
  const other = (await call('crash_schedule', { ...h, target_days: 3, export: dir })).d;
  assert.equal(other.exported.replaced.files, first.exported.files.length);
});

test('E4: every list the answer cut says where all of it is, when an export was written (the total of float_paths between printed as the string it is)', async () => {
  const h = await chain('E4', 30);
  const dir = folder();
  const args = { ...h, iterations: 40, seed: 2, default_estimates: { min_pct: 80, max_pct: 150 } };
  const r = (await call('monte_carlo', { ...args, export: dir })).d;
  // 31 activities all critical in every run, 25 shown: the platform's note (more ever-critical than shown, every one critical in every run)
  assert.equal(r.criticality_note, `25 of 31 shown; all 31 in ${join(dir, 'monte_carlo-criticality.csv')}.`);
  assert.equal(r.sensitivity_note, `25 of ${r.sensitivity_total} shown; all ${r.sensitivity_total} in ${join(dir, 'monte_carlo-sensitivity.csv')}.`);
  assert.equal(r.milestones_note, undefined, 'nothing cut: no note');
  // without export the notes name the file of the default folder
  const bare = (await call('monte_carlo', args)).d;
  assert.equal(bare.sensitivity_note, `25 of ${r.sensitivity_total} shown; all ${r.sensitivity_total} in ${bare.exported.files.find((f: any) => f.path.endsWith('-sensitivity.csv')).path}.`);
  // lint: a check's activities cut to 25, its total_activities
  const c = (await call('open_file', { path: sampleCopy('Baseline Zone 2 Rev.01.xer') })).d.handle;
  const lint = (await call('lint', { handle: c, simulate: false, export: folder() })).d;
  const cut = lint.checks.filter((x: any) => x.total_activities > 25);
  assert.ok(cut.length > 0);
  for (const x of cut) assert.equal(x.activities_note, `25 of ${x.total_activities} shown; all ${x.total_activities} in ${lint.exported.files.find((f: any) => f.path.endsWith('lint-findings.csv')).path}.`, x.id);
  assert.ok(lint.checks.filter((x: any) => x.total_activities <= 25).every((x: any) => x.activities_note === undefined));
  await call('close', { handle: c, discard: true });
  // float_paths between on 80 diamonds: 2^80 paths, a decimal string, exactly
  const np = (await call('new_project', { id: 'E4L', start: '2026-03-02' })).d;
  const ops: unknown[] = [{ op: 'add_activity', id: 'S', name: 'S', duration_days: 1 }];
  let prev = 'S';
  for (let i = 1; i <= 80; i++) { ops.push({ op: 'add_activity', id: `a${i}`, name: 'a', duration_days: 1 }, { op: 'add_activity', id: `b${i}`, name: 'b', duration_days: 2 }, { op: 'add_activity', id: `J${i}`, name: 'J', duration_days: 1 }, { op: 'add_relationship', pred: prev, succ: `a${i}` }, { op: 'add_relationship', pred: prev, succ: `b${i}` }, { op: 'add_relationship', pred: `a${i}`, succ: `J${i}` }, { op: 'add_relationship', pred: `b${i}`, succ: `J${i}` }); prev = `J${i}`; }
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const fdir = folder();
  const fp = (await call('float_paths', { handle: np.handle, between: { from: 'S', to: prev, max: 5 }, export: fdir })).d;
  assert.equal(fp.between.paths_total, '1208925819614629174706176');
  assert.equal(fp.between.paths_note, `5 of 1208925819614629174706176 shown (the most asked for); the export holds the same 5 in ${join(fdir, 'float_paths-between.csv')}, ask for more to have more`);
  assert.equal(fp.paths_note, undefined, 'the top-level paths are not cut lists');
  const dflt = (await call('float_paths', { handle: np.handle, between: { from: 'S', to: prev, max: 5 } })).d;
  assert.equal(dflt.between.paths_note, `5 of 1208925819614629174706176 shown (the most asked for); the export holds the same 5 in ${join(dflt.exported.folder, 'float_paths-between.csv')}, ask for more to have more`);
});

test('E5: optimize_schedule with objective min_crash_cost exports under its own name, so one tool\'s files in a folder are replaced together', async () => {
  const h = await chain('E5', 8);
  const dir = folder();
  mkdirSync(dir, { recursive: true });
  // what a makespan run leaves in the folder
  writeFileSync(join(dir, 'optimize_schedule-activities.csv'), 'stale'); writeFileSync(join(dir, 'optimize_schedule.json'), '{}'); writeFileSync(join(dir, 'crash_schedule-old.csv'), 'a crash_schedule export of its own');
  const r = (await call('optimize_schedule', { ...h, objective: 'min_crash_cost', target_days: 3, export: dir })).d;
  assert.equal(r.err, undefined, JSON.stringify(r).slice(0, 300));
  assert.ok(r.exported, JSON.stringify(r).slice(0, 300));
  assert.ok(r.exported.files.every((f: any) => /optimize_schedule(\.json|-[a-z_]+\.csv)$/.test(f.path)), JSON.stringify(r.exported.files.map((f: any) => f.path)));
  assert.ok(!names(dir).some((f) => f.startsWith('crash_schedule') && f !== 'crash_schedule-old.csv'), 'no crash_schedule files of this call');
  assert.equal(existsSync(join(dir, 'optimize_schedule-activities.csv')), false, 'the stale makespan table is gone');
  assert.equal(r.exported.replaced.files, 2);
  assert.ok(existsSync(join(dir, 'crash_schedule-old.csv')), 'the crash_schedule tool\'s own files stay');
  assert.ok(existsSync(join(dir, 'optimize_schedule-steps.csv')));
});

test('export_name: an experiment keeps its own files in the folder; the same name replaces only its own; no name replaces only the unnamed set (owner 2026-11-10)', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const dir = folder(), ls = () => readdirSync(dir).sort();
  const run = async (name?: string) => (await call('dcma_14', { handle: h, export: dir, ...(name != null ? { export_name: name } : {}) })).d;
  const names = (d: any) => d.exported.files.map((f: any) => f.path.split(/[\\/]/).pop() as string);
  const a = await run('option-a');
  assert.deepEqual(names(a).slice(0, 2), ['dcma_14-option-a.json', 'dcma_14-option-a-checks.csv'], 'exported lists the real paths');
  for (const f of a.exported.files) assert.ok(existsSync(f.path));
  const b = await run('option-b'), none = await run(), opt = await run('option');
  const set = { a: names(a), b: names(b), none: names(none), opt: names(opt) };
  assert.equal(new Set(Object.values(set).flat()).size, set.a.length * 4, 'four sets of files side by side');
  const all = ls();
  assert.equal(all.length, set.a.length * 4);
  // "option" and "option-a" are told apart: a re-run of "option" leaves option-a's files alone (and a stale table of its own goes)
  const stamp = (f: string) => statSync(join(dir, f)).mtimeMs;
  const keep = [...set.a, ...set.b, ...set.none], before = keep.map(stamp);
  writeFileSync(join(dir, 'dcma_14-option-old.csv'), 'stale');
  await new Promise((r) => setTimeout(r, 20));
  const again = await run('option');
  assert.equal(again.exported.replaced.files, set.opt.length + 1, 'its own files and its stale one');
  assert.deepEqual(keep.map(stamp), before, 'every other name and the unnamed set untouched');
  assert.equal(existsSync(join(dir, 'dcma_14-option-old.csv')), false);
  // no name: the unnamed set is replaced and every named one stays
  await new Promise((r) => setTimeout(r, 20));
  const unnamed = await run();
  assert.equal(unnamed.exported.replaced.files, set.none.length);
  const namedKeep = [...set.a, ...set.b, ...set.opt];
  assert.ok(set.none.every((f: string) => stamp(f) > Math.max(...before)), 'the unnamed files are new');
  assert.deepEqual(namedKeep.map(stamp), [...before.slice(0, set.a.length + set.b.length), ...set.opt.map(stamp)]);
  assert.equal(readdirSync(dir).length, all.length);
  // another tool's named files are its own: check_schedule with the same name beside them
  const cs = (await call('check_schedule', { handle: h, export: dir, export_name: 'option-a' })).d;
  assert.ok(existsSync(join(dir, 'check_schedule-option-a.json')) && existsSync(join(dir, 'dcma_14-option-a.json')));
  assert.ok(cs.exported.files.length >= 2);
  // the name is made file-safe: letters (also non-Latin), digits, marks and . _ - stay, anything else becomes -
  const odd = await run(' Option A/1:\u00e9\u0645 ');
  assert.ok(odd.exported.files[0].path.endsWith('dcma_14-Option-A-1-\u00e9\u0645.json'), odd.exported.files[0].path);
  await call('close', { handle: h, discard: true });
});

test('export_name: a name that is empty, one with no folder, one that clashes with a stopped run\'s files, and a non-text one are refused as bad_input before anything is written', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const dir = folder();
  for (const bad of ['', '   ', 'partial', 'x-partial']) {
    const r = await call('dcma_14', { handle: h, export: dir, export_name: bad });
    assert.equal(r.d.error.code, 'bad_input', `"${bad}": ${JSON.stringify(r.d)}`);
  }
  assert.equal((await call('dcma_14', { handle: h, export: dir, export_name: 7 })).d.error.code, 'bad_input');
  // (an analysis tool writes to its default folder, so export_name needs no export there; a tool with an export of its own still needs the folder)
  const named = await call('dcma_14', { handle: h, export_name: 'option-a' });
  assert.ok(named.d.exported.files[0].path.endsWith('dcma_14-option-a.json'), named.d.exported.files[0].path);
  const nofolder = await call('level_resources', { handle: h, dry_run: true, export_name: 'option-a' });
  assert.equal(nofolder.d.error.code, 'bad_input');
  assert.match(nofolder.d.error.message, /no export folder/);
  assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0, 'nothing written');
  await call('close', { handle: h, discard: true });
});

test('export_name: a stopped run keeps its -partial rule within the name and replaces only that name\'s partial files', () => {
  const dir = folder(); mkdirSync(dir, { recursive: true });
  const write = (p: string, make: (put: (s: string) => void) => void) => { let t = ''; make((x) => { t += x; }); writeFileSync(p, t); };
  const tables = [{ name: 'steps', columns: ['a'], rows: [{ a: 1 }] }];
  const put = (o: { partial?: boolean; name?: string }) => exportResult('crash_schedule', dir, { ok: 1 }, tables, write as never, o).files.map((f) => f.path.split(/[\\/]/).pop());
  assert.deepEqual(put({ name: 'x' }), ['crash_schedule-x.json', 'crash_schedule-x-steps.csv']);
  assert.deepEqual(put({ name: 'x', partial: true }), ['crash_schedule-x-partial.json', 'crash_schedule-x-partial-steps.csv']);
  put({ partial: true });
  assert.equal(readdirSync(dir).length, 6, 'a partial run replaces no complete run');
  put({ name: 'x' });
  assert.deepEqual(readdirSync(dir).sort(), ['crash_schedule-partial-steps.csv', 'crash_schedule-partial.json', 'crash_schedule-x-steps.csv', 'crash_schedule-x.json'], 'a complete run of the name replaces its partial too, no other');
});

test('export_name: the same name in another case is the same experiment (Windows does not tell them apart): its files are replaced and replaced says so; a name changed by cleaning says what it became', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const dir = folder();
  const run = async (name: string) => (await call('dcma_14', { handle: h, export: dir, export_name: name })).d;
  const first = await run('Option-A'), count = first.exported.files.length;
  assert.equal(first.exported.export_name_used, undefined, 'a name that needed no change says nothing');
  const second = await run('option-a');
  assert.equal(second.exported.replaced.files, count, 'the files of "Option-A" were replaced by those of "option-a"');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('dcma_14-Option-A')), [], 'not left beside them');
  assert.equal(readdirSync(dir).length, count);
  // names that become the same after cleaning replace one another, and each answer says what the name became
  const a = await run('a b');
  assert.deepEqual([a.exported.export_name_used.given, a.exported.export_name_used.used], ['a b', 'a-b']);
  assert.match(a.exported.export_name_used.note, /anything else became -/);
  const b = await run('a/b');
  assert.equal(b.exported.replaced.files, count, 'a/b is a-b: it replaced the files of "a b"');
  assert.deepEqual([b.exported.export_name_used.given, b.exported.export_name_used.used], ['a/b', 'a-b']);
  assert.equal((await run('a-b')).exported.export_name_used, undefined);
  await call('close', { handle: h, discard: true });
});

test('export_name: file names are at most 250 characters, a longer name is cut off automatically at a character with a short code of the whole name, before any work; two long names stay apart (owner rule)', async () => {
  const h = (await call('open_file', { path: sampleCopy('cairo festival city.xer') })).d.handle;
  const dir = folder();
  const run = async (name: string, tool = 'dcma_14') => (await call(tool, { handle: h, export: dir, export_name: name })).d;
  for (const [label, name] of [['Latin', 'x'.repeat(300)], ['Arabic', 'م'.repeat(300)], ['CJK pairs and Latin', '\u{20BB7}a'.repeat(150)]] as const) {
    const r = await run(name);
    assert.ok(!r.error, `${label}: ${JSON.stringify(r).slice(0, 300)}`);
    for (const f of r.exported.files) {
      const file = f.path.split(/[\\/]/).pop() as string;
      assert.ok(fileNameLength(file) <= 250, `${label}: ${file.length} characters`);
      assert.ok(existsSync(f.path), `${label}: written`);
    }
    const u = r.exported.export_name_used;
    assert.equal(u.given, name);
    assert.match(u.note, /file names are at most 250 characters, so the name was cut/);
    assert.match(u.used, /-[0-9a-f]{8}$/);
    assert.ok(name.startsWith(u.used.slice(0, -9)), 'the start of the name, at a character boundary (no half of a pair)');
    assert.equal([...u.used].includes('�'), false);
    // the same long name again, in any case, is the same experiment: replaced
    assert.equal((await run(name.toUpperCase())).exported.replaced?.files, r.exported.files.length, label);
    assert.equal(readdirSync(dir).length, r.exported.files.length, label);
    for (const f of readdirSync(dir)) rmSyncQuiet(join(dir, f));
  }
  // two long names that are the same up to the cut stay apart; a stopped run's -partial files of the name fit too
  const x = 'y'.repeat(299), a = await run(`${x}a`), b = await run(`${x}b`);
  assert.notEqual(a.exported.export_name_used.used, b.exported.export_name_used.used);
  assert.equal(b.exported.replaced, undefined, 'the second long name did not replace the first');
  assert.equal(readdirSync(dir).length, a.exported.files.length * 2);
  const written: string[] = [];
  const sink = (p: string, make: (put: (s: string) => void) => void) => { let t = ''; make((s) => { t += s; }); writeFileSync(p, t); written.push(p.split(/[\\/]/).pop() as string); };
  exportResult('optimize_schedule', folder(), {}, [{ name: 'worst_schedule_performance', columns: ['a'], rows: [] }], sink as never, { partial: true, name: 'z'.repeat(400) });
  assert.ok(written.length === 2 && written.every((f) => fileNameLength(f) <= 250 && f.length > 200), written.map((f) => f.length).join());
  await call('close', { handle: h, discard: true });
});
function rmSyncQuiet(p: string) { try { rmSync(p); } catch { /* gone */ } }

test('export_name room: no table declared in the code has a name longer than the room the cut reserves (EXPORT_TABLE_NAME_MAX)', async () => {
  const { EXPORT_TABLE_NAME_MAX } = await import('../mcp/export.ts');
  const { readdirSync, readFileSync } = await import('node:fs');
  const names = new Set<string>();
  for (const dir of ['../mcp', '../core']) {
    const base = join(import.meta.dirname, dir);
    for (const f of readdirSync(base, { recursive: true }) as string[]) {
      if (!/\.ts$/.test(f)) continue;
      for (const m of readFileSync(join(base, f), 'utf8').matchAll(/\{ name: '([A-Za-z0-9_]+)', columns:/g)) names.add(m[1]);
    }
  }
  assert.ok(names.size > 30, `${names.size} table declarations found`);
  const longest = [...names].sort((a, b) => b.length - a.length)[0];
  assert.ok(longest.length <= EXPORT_TABLE_NAME_MAX, `${longest} (${longest.length}) is longer than ${EXPORT_TABLE_NAME_MAX}: raise EXPORT_TABLE_NAME_MAX`);
  // a table written under a name made dynamically (the cut lists' `found` table) is a plain word
  assert.ok(['findings', 'failing_activities'].every((n) => n.length <= EXPORT_TABLE_NAME_MAX));
});

test('A-L3: the cut name’s code is of the cleaned, lower-cased name: two long names that clean to the same name are one experiment, and different long names stay apart', async () => {
  const { exportNameParts } = await import('../mcp/export.ts');
  const long = 'x'.repeat(400);
  const a = exportNameParts(`my option ${long}`, true, 'monte_carlo')!, b = exportNameParts(`my-option-${long}`, true, 'monte_carlo')!, c = exportNameParts(`MY OPTION ${long}`, true, 'monte_carlo')!;
  assert.equal(a.cut && b.cut && c.cut, true);
  assert.equal(a.name, b.name, 'only characters that became - differ: the same name');
  assert.equal(a.name.toLowerCase(), c.name.toLowerCase(), 'only case differs: the same name (file names are compared without case)');
  assert.notEqual(a.name, exportNameParts(`my option ${long}y`, true, 'monte_carlo')!.name, 'a different long name stays apart');
  // short names: the same cleaned name is the same files
  assert.equal(exportNameParts('a b', true, 'lint')!.name, exportNameParts('a-b', true, 'lint')!.name);
});

test('A-L4: every export passes the table-name check: a table named longer than the room reserved is an internal error naming the table, before any file is touched', async () => {
  const { exportResult, EXPORT_TABLE_NAME_MAX } = await import('../mcp/export.ts');
  const folder = mkdtempSync(join(tmpdir(), 'p6mcp-tn-'));
  const written: string[] = [];
  const sink = (p: string, make: (put: (s: string) => void) => void) => { make(() => {}); written.push(p); };
  const tooLong = 'a_table_name_that_is_far_too_long_for_the_room';
  assert.ok(tooLong.length > EXPORT_TABLE_NAME_MAX);
  assert.throws(() => exportResult('lint', folder, {}, [{ name: 'ok_table', columns: ['a'], rows: [] }, { name: tooLong, columns: ['a'], rows: [] }], sink as never), (e: Error) => /^internal: the export table "a_table_name_that_is_far_too_long_for_the_room" of lint/.test(e.message) && e.message.includes(String(EXPORT_TABLE_NAME_MAX)));
  assert.deepEqual(written, [], 'nothing was written');
  assert.doesNotThrow(() => exportResult('lint', folder, {}, [{ name: 'x'.repeat(EXPORT_TABLE_NAME_MAX), columns: ['a'], rows: [] }], sink as never), 'a name of exactly the room is fine');
});
