// The schedule analysis tools over MCP (called in-process, as the stdio/HTTP transports do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult, toolsList } from '../mcp/server.ts';
import { setRoots } from '../mcp/runtime.ts';

// the result files every analysis writes go to a temporary write root, never into the repository; the samples are read from the repository
const writeRoot = mkdtempSync(join(tmpdir(), 'p6-analysis-'));
setRoots(join(import.meta.dirname, '..'), writeRoot);

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };

test('MCP: check_schedule and dcma_14 on a real XER, with a report file and clear errors', async () => {
  const names = toolsList().map((t: { name: string }) => t.name);
  for (const n of ['check_schedule', 'dcma_14']) assert.ok(names.includes(n), n);
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const cs = await call('check_schedule', { handle: h, max_ids: 3 });
  // max_ids is gone (a fixed 25 per list): the call ran without it and the answer says so, in words (R6)
  assert.equal(cs.d.arguments_not_used.length, 1);
  assert.match(cs.d.arguments_not_used[0], /^check_schedule has no argument "max_ids": it was not used and the call ran without it\. Its arguments are: handle, export, export_name, project, checks, targets, threshold_days, path, caller, async\.$/);
  assert.equal(cs.err, false, JSON.stringify(cs.d));
  assert.equal(cs.d.checks.length, 14);
  assert.ok(cs.d.checks.every((c: { activities: unknown[] }) => c.activities.length <= 25));
  const dc = await call('dcma_14', { handle: h, profile: 'gao' });
  assert.equal(dc.d.checks.length, 14);
  assert.equal(dc.d.profile, 'gao');
  assert.equal(dc.d.checks.find((c: { id: string }) => c.id === 'relationship_types').threshold.value, 85);
  const dir = mkdtempSync(join(writeRoot, 'p6dcma-'));
  const withFile = await call('dcma_14', { handle: h, path: join(dir, 'dcma.html') });
  assert.ok(existsSync(withFile.d.saved));
  assert.match(readFileSync(withFile.d.saved, 'utf8'), /DCMA 14-Point Assessment/);
  const bad = await call('dcma_14', { handle: h, profile: 'nope' });
  assert.equal(bad.err, true);
  assert.equal(bad.d.error.code, 'bad_input');
  assert.match(bad.d.error.next_step ?? bad.d.error.hint, /pam200/);
  const badCheck = await call('check_schedule', { handle: h, checks: ['logic', 'zzz'] });
  assert.equal(badCheck.d.error.code, 'bad_input');
});

test('MCP: lint with fixes (P6 and platform profiles), and schedule returns the full log', async () => {
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const l = await call('lint', { handle: h });
  assert.equal(l.err, false, JSON.stringify(l.d));
  assert.equal(l.d.profile, 'p6');
  assert.ok(l.d.checks.find((c: { id: string }) => c.id === 'dangling_start').total_activities > 0);
  const lp = await call('lint', { handle: h, profile: 'platform' });
  assert.ok(typeof lp.d.score === 'number' && lp.d.grade);
  assert.equal((await call('lint', { handle: h, checks: ['nope'] })).d.error.code, 'bad_input');
  // thresholds per call: named in the answer; a dangling-start allowance as large as the count passes the check
  const n = l.d.checks.find((c: { id: string }) => c.id === 'dangling_start').total_activities;
  const lt = await call('lint', { handle: h, profile: 'platform', simulate: false, thresholds: { dangling_start: { max: n }, edgesPerActivity: { pass: [0, 99], warn: [0, 99] } } });
  assert.equal(lt.err, false, JSON.stringify(lt.d).slice(0, 300));
  assert.deepEqual(lt.d.overridden, ['dangling_start.max', 'edges_per_activity.pass', 'edges_per_activity.warn']);
  assert.deepEqual([lt.d.thresholds.dangling_start.max, lt.d.thresholds.ladder.min_group_size], [n, 3]);
  assert.deepEqual(lt.d.checks.filter((c: { id: string }) => c.id === 'dangling_start' || c.id === 'edges_per_activity').map((c: { band: string }) => c.band), ['pass', 'pass']);
  const bt = await call('lint', { handle: h, thresholds: { high_float_days: 44 } });
  assert.deepEqual([bt.err, bt.d.error.code], [true, 'bad_input']);
  assert.match(bt.d.error.message, /Unknown threshold "high_float_days"/);
  const sc = await call('schedule', { handle: h });
  assert.equal(sc.err, false, JSON.stringify(sc.d).slice(0, 300));
  assert.ok(sc.d.log && Array.isArray(sc.d.log.warnings) && Array.isArray(sc.d.log.exceptions));
  assert.ok(sc.d.log.warnings.some((w: { code: string }) => w.code === 'OPEN_FINISH'), 'open ends now reach the agent');
  assert.ok(sc.d.log.exceptions.some((w: { code: string; count: number }) => w.code === 'CRITICAL' && w.count > 0));
  const quiet = await call('schedule', { handle: h, log: false });
  assert.equal(quiet.d.log, undefined);
});

test('MCP: progress_curves and resource_histogram', async () => {
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'DHBL-24FEB13_VER-7.0.xer') })).d.handle;
  const c = await call('progress_curves', { handle: h, period: 'month', units: 'hours' });
  assert.equal(c.err, false, JSON.stringify(c.d).slice(0, 300));
  assert.ok(c.d.periods.length > 3 && c.d.totals.bac > 0);
  const r = await call('resource_histogram', { handle: h, period: 'month' });
  // the answer is a summary (no per-period series); the periods of every resource are in the result file
  assert.ok(r.d.resources.length > 0 && r.d.resources.every((x: any) => x.periods === undefined && x.periods_total > 0));
  assert.ok(existsSync(r.d.exported.files.find((f: any) => f.path.endsWith('-periods.csv')).path));
  assert.equal((await call('progress_curves', { handle: h, period: 'day' })).d.error.code, 'bad_input');
});

test('MCP: progress_curves on projects with different data dates is refused naming each Project ID with its data date and "Pass project"; one project answers', async () => {
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'Enppi.xer') })).d.handle;
  const r = await call('progress_curves', { handle: h, units: 'duration' });
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'bad_input');
  assert.match(r.d.error.message, /different data dates \(Master Rev\.F-N-4 2011-11-30 00:00, 4229 update 2-6-12 2012-06-02 00:00\)/);
  assert.match(r.d.error.next_step ?? r.d.error.hint, /Pass project: <ID>, one of Master Rev\.F-N-4, 4229 update 2-6-12/);
  const one = await call('progress_curves', { handle: h, units: 'duration', project: '4229 update 2-6-12' });
  assert.equal(one.err, false, JSON.stringify(one.d).slice(0, 300));
});

test('MCP: count arguments are whole numbers: a value that is not one is refused as bad_input naming the argument (never a default or "all"); 0 means all where documented; absent is the default', async () => {
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const bads: unknown[] = [-1, 2.5, Number.NaN, Infinity, '5', true, [3]];
  const refused = async (tool: string, arg: string, v: unknown, extra: Record<string, unknown> = {}) => {
    const r = await call(tool, { handle: h, ...extra, [arg]: v });
    assert.equal(r.d.error?.code, 'bad_input', `${tool} ${arg} ${String(v)}: ${JSON.stringify(r.d).slice(0, 160)}`);
    assert.match(r.d.error.message, new RegExp(`^${arg} must be a whole number of 0 or more`), r.d.error.message);
  };
  for (const v of bads) {
    await refused('float_paths', 'count', v);
    await refused('optimize_schedule', 'max_changes', v);
    await refused('optimize_schedule', 'samples', v);
    await refused('transfer_progress', 'max_changes', v, { path: 'none.xer' });
    await refused('transfer_progress', 'offset', v, { path: 'none.xer' });
  }
  // every check lists at most 25 activities, whatever max_ids says, and total_activities says how many there are
  const dflt = await call('check_schedule', { handle: h });
  assert.equal(dflt.err, false);
  assert.ok(dflt.d.checks.every((c: any) => c.activities.length <= 25 && c.activities.length === Math.min(25, c.total_activities)));
  // samples is parsed only where it is used: min_crash_cost does not sample, so a bad samples does not refuse a crash run
  for (const v of [-1, 2.5, '5']) {
    const crash = await call('optimize_schedule', { handle: h, objective: 'min_crash_cost', target_days: 5, samples: v });
    assert.equal(crash.err, false, `samples ${String(v)}: ${JSON.stringify(crash.d).slice(0, 200)}`);
    assert.equal(crash.d.objective, 'min_crash_cost'); assert.ok(crash.d.stop, JSON.stringify(crash.d).slice(0, 200));
  }
});
