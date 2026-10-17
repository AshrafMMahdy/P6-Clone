// The shared MCP server over Streamable HTTP: many agents, one project, no dead stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SERVER = join(import.meta.dirname, '..', 'mcp', 'server.ts');
const TOKEN = 'test-token-123';

async function server(root: string, env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [SERVER, '--http', '--root', root, '--port', '0', '--token', TOKEN], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
  const url = await new Promise<string>((res, rej) => {
    let err = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c: string) => { err += c; const m = /listening on (\S+)/.exec(err); if (m) res(m[1]); });
    p.on('exit', () => rej(new Error(err)));
  });
  let id = 0;
  const post = async (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  const session = async () => {
    const r = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const sid = r.headers.get('mcp-session-id')!;
    assert.ok(sid);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const j = await (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': sid })).json();
      return { isError: j.result.isError as boolean, data: j.result.structuredContent };
    };
  };
  return { url, post, session, stop: () => p.kill() };
}

test('MCP HTTP: token, origin, sessions as callers, owner keys, root, per-caller undo, serialised calls, Monte Carlo, jobs', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6mcp-http-'));
  const s = await server(root);
  try {
    // security: no token, foreign origin
    assert.equal((await fetch(s.url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await s.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);

    const alice = await s.session(), bob = await s.session();
    const { data: np } = await alice('new_project', { id: 'H1', start: '2026-03-02' });
    const h = np.handle, key = np.owner_key;
    assert.match(h, /^h_/); assert.match(key, /^ok_/);

    // both agents edit the same project at the same time: calls run one at a time, all succeed
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? bob : alice)('edit', { handle: h, operations: [{ op: 'add_activity', id: `A${i}`, name: `Act ${i}`, duration_days: 2 + i }] })));
    assert.ok(many.every((r) => !r.isError), JSON.stringify(many.find((r) => r.isError)));
    await alice('edit', { handle: h, operations: [{ op: 'add_relationship', pred: 'A0', succ: 'A2' }] });
    await bob('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A1', name: 'Bob renamed' }] });

    // bob's undo takes back bob's rename, not alice's later work
    const u = await bob('undo', { handle: h });
    assert.equal(u.isError, false);
    assert.match(u.data.undone, /Edit/);
    const a1 = await alice('get_activity', { handle: h, activity_id: 'A1' });
    assert.equal(a1.data.name, 'Act 1');
    const rel = await alice('get_activity', { handle: h, activity_id: 'A2' });
    assert.ok(JSON.stringify(rel.data).includes('A0'), 'alice\'s relationship is still there');
    const re = await bob('redo', { handle: h });
    assert.match(re.data.redone, /Edit/);
    assert.equal((await alice('get_activity', { handle: h, activity_id: 'A1' })).data.name, 'Bob renamed');

    // owner key: needed to save, close and undo other callers' work
    const noKey = await bob('save', { handle: h, path: 'h1.xer' });
    assert.equal(noKey.data.error.code, 'owner_key_required');
    const anyNoKey = await bob('undo', { handle: h, any_caller: true });
    assert.equal(anyNoKey.data.error.code, 'owner_key_required');
    const wrong = await bob('save', { handle: h, path: 'h1.xer', owner_key: 'ok_nope' });
    assert.equal(wrong.data.error.code, 'invalid_owner_key');
    // root: paths outside are refused
    const out = await alice('save', { handle: h, path: '../escape.xer', owner_key: key });
    assert.equal(out.data.error.code, 'path_outside_root');
    assert.ok(out.data.error.hint);
    const saved = await alice('save', { handle: h, path: 'h1.xer', owner_key: key });
    assert.equal(saved.isError, false, JSON.stringify(saved.data));
    assert.ok(existsSync(join(root, 'h1.xer')));

    // every error says what to do next
    const unk = await bob('get_activity', { handle: 'h_doesnotexist', activity_id: 'A1' });
    assert.equal(unk.data.error.code, 'unknown_handle');
    assert.ok(unk.data.error.hint);

    // Monte Carlo: seeded and repeatable; the project itself is untouched
    await alice('schedule', { handle: h });
    await alice('edit', { handle: h, operations: [{ op: 'set_estimates', activity: 'A9', min_days: 8, most_likely_days: 11, max_days: 20 }] });
    const mc1 = await alice('monte_carlo', { handle: h, iterations: 300, seed: 7, default_estimates: { min_pct: 90, max_pct: 140 } });
    assert.equal(mc1.isError, false, JSON.stringify(mc1.data));
    for (const k of ['P10', 'P50', 'P80', 'P90']) assert.match(mc1.data.finish[k], /^\d{4}-\d\d-\d\d/);
    assert.equal(mc1.data.histogram.reduce((a: number, b: { count: number }) => a + b.count, 0), 300);
    assert.ok(mc1.data.criticality.length > 0 && mc1.data.sensitivity.length > 0);
    const mc2 = await bob('monte_carlo', { handle: h, iterations: 300, seed: 7, default_estimates: { min_pct: 90, max_pct: 140 } });
    assert.deepEqual(mc2.data.finish, mc1.data.finish);
    const est = await alice('list_dictionaries', { handle: h, only: 'baselines' });
    assert.equal(est.isError, false);

    // async job
    const job = await alice('monte_carlo', { handle: h, iterations: 200, seed: 1, async: true });
    assert.match(job.data.job_id, /\w/);
    const done = await alice('job_status', { job_id: job.data.job_id, wait_seconds: 20 });
    assert.equal(done.data.status, 'done', JSON.stringify(done.data));
    assert.ok(done.data.result.finish.P50);

    const st = await bob('server_status');
    assert.ok(st.data.open.length >= 1);
    const closed = await alice('close', { handle: h, owner_key: key });
    assert.equal(closed.isError, false);
  } finally { s.stop(); }
});

test('MCP HTTP: at the handle limit the idlest project is moved to a recovery file and comes back on its next call', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6mcp-evict-'));
  const s = await server(root, { P6CLONE_MAX_HANDLES: '1' });
  try {
    const a = await s.session();
    const p1 = (await a('new_project', { id: 'E1', start: '2026-03-02' })).data;
    await a('edit', { handle: p1.handle, operations: [{ op: 'add_activity', id: 'X1', name: 'Kept', duration_days: 3 }] });
    const p2 = (await a('new_project', { id: 'E2', start: '2026-03-02' })).data;
    assert.ok(p2.handle, JSON.stringify(p2));
    const lo = (await a('list_open')).data;
    assert.equal(lo.moved_out.length, 1);
    assert.ok(existsSync(lo.moved_out[0].recovery_file));
    const back = await a('get_activity', { handle: p1.handle, activity_id: 'X1' });
    assert.equal(back.data.name, 'Kept');
    assert.ok(back.data._notice, 'the caller is told the project was restored');
    const u = await a('undo', { handle: p1.handle });
    assert.equal(u.isError, false);
  } finally { s.stop(); }
});
