// The schedule analysis tools over MCP (called in-process, as the stdio/HTTP transports do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult, toolsList } from '../mcp/server.ts';

const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };

test('MCP: check_schedule and dcma_14 on a real XER, with a report file and clear errors', async () => {
  const names = toolsList().map((t: { name: string }) => t.name);
  for (const n of ['check_schedule', 'dcma_14']) assert.ok(names.includes(n), n);
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const cs = await call('check_schedule', { handle: h, max_ids: 3 });
  assert.equal(cs.err, false, JSON.stringify(cs.d));
  assert.equal(cs.d.checks.length, 14);
  assert.ok(cs.d.checks.every((c: { activities: unknown[] }) => c.activities.length <= 3));
  const dc = await call('dcma_14', { handle: h, profile: 'gao' });
  assert.equal(dc.d.checks.length, 14);
  assert.equal(dc.d.profile, 'gao');
  assert.equal(dc.d.checks.find((c: { id: string }) => c.id === 'relationship_types').threshold.value, 85);
  const dir = mkdtempSync(join(tmpdir(), 'p6dcma-'));
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
  assert.ok(r.d.resources.length > 0 && r.d.resources[0].periods.length > 0);
  assert.equal((await call('progress_curves', { handle: h, period: 'day' })).d.error.code, 'bad_input');
});
