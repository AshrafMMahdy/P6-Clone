import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SAMPLES_DIR } from './helpers.ts';

const SERVER = join(import.meta.dirname, '..', 'mcp', 'server.ts');

function client() {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name: string, args: Record<string, unknown> = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { ...r.result, data: r.result.structuredContent }; };
  return { rpc, tool, close: () => p.stdin.end() };
}

test('MCP: an agent builds, schedules, reviews, undoes, saves and reopens a project', { timeout: 60_000 }, async () => {
  const c = client();
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'p6-clone');
    const names = (await c.rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    for (const n of ['open_file', 'new_project', 'edit', 'schedule', 'review', 'find_activities', 'get_activity', 'undo', 'save']) assert.ok(names.includes(n), n);

    const { data: np } = await c.tool('new_project', { id: 'MCP1', name: 'Agent project', start: '2026-03-02' });
    const h = np.handle;
    const ed = await c.tool('edit', { handle: h, operations: [
      { op: 'add_activity', id: 'A1', name: 'Design', duration_days: 5 },
      { op: 'add_activity', id: 'A2', name: 'Build', duration_days: 10 },
      { op: 'add_relationship', pred: 'A1', succ: 'A2' },
    ] });
    assert.equal(ed.isError, false);
    assert.equal(ed.data.applied, 3);
    const bad = await c.tool('edit', { handle: h, operations: [{ op: 'add_relationship', pred: 'A2', succ: 'A1' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.data.error.message, /loop/);

    const sc = await c.tool('schedule', { handle: h });
    assert.equal(sc.data.finish, '2026-03-20 17:00');
    const a2 = await c.tool('get_activity', { handle: h, activity_id: 'A2' });
    assert.equal(a2.data.start, '2026-03-09 08:00');
    const rv = await c.tool('review', { handle: h });
    assert.ok(['pass', 'warn', 'fail'].includes(rv.data.grade));

    await c.tool('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A2', duration_days: 20 }] });
    const un = await c.tool('undo', { handle: h });
    assert.match(un.data.undone, /^Edit/);
    assert.equal((await c.tool('get_activity', { handle: h, activity_id: 'A2' })).data.orig_days, 10);

    const out = join(mkdtempSync(join(tmpdir(), 'p6mcp-')), 'agent.xer');
    assert.equal((await c.tool('save', { handle: h, path: out })).isError, false);
    assert.ok(existsSync(out));
    const re = await c.tool('open_file', { path: out });
    assert.equal(re.data.diagnostics.verdict === 'fatal', false);
    assert.equal(re.data.summary.activities, 2);
    assert.equal((await c.tool('close', { handle: re.data.handle })).isError, false);

    const real = await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    const f = await c.tool('find_activities', { handle: real.data.handle, text: 'water', limit: 3 });
    assert.ok(f.data.total_matches > 0);
    assert.equal((await c.tool('get_activity', { handle: 'nope', activity_id: 'x' })).isError, true);
  } finally { c.close(); }
});
