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
