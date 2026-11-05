// WHIQ 4L-13 (2026-11-05): a job tells its client — notifications/job as its progress moves and once when it ends (status, no
// result), over stdio as the platform runs the clone. The caller no longer polls job_status to learn that a job finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('a job sends progress pulses and one end pulse (notifications/job)', { timeout: 120_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'p6-pulses-'));
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts'), '--automation-write-root', cwd], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const notes: any[] = [];
  p.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.method === 'notifications/job') notes.push(m.params); else { waiting.get(m.id)?.(m); waiting.delete(m.id); } } catch { /* not json */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;
  try {
    await rpc('initialize', {});
    const np = await call('new_project', { id: 'PULSE', start: '2026-03-02' });
    const ops: unknown[] = [];
    for (let i = 1; i <= 40; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `Activity ${i}`, duration_days: 5 + (i % 7) });
    for (let i = 1; i < 40; i++) ops.push({ op: 'add_relationship', pred: `A${i}`, succ: `A${i + 1}` });
    await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
    await call('schedule', { handle: np.handle, owner_key: np.owner_key });
    const job = await call('monte_carlo', { handle: np.handle, iterations: 400, default_estimates: { min_pct: 90, max_pct: 125 }, async: true });
    assert.ok(job.job_id, JSON.stringify(job).slice(0, 300));
    const t0 = Date.now();
    while (!notes.some((n) => n.job_id === job.job_id && n.status !== 'running') && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100));
    const end = notes.filter((n) => n.job_id === job.job_id && n.status !== 'running');
    assert.equal(end.length, 1, JSON.stringify(notes).slice(0, 500));
    assert.equal(end[0].status, 'done');
    assert.equal(end[0].tool, 'monte_carlo');
    assert.equal(end[0].result, undefined, 'the end pulse carries no result (job_status has it)');
    const done = await call('job_status', { job_id: job.job_id });
    assert.equal(done.status, 'done');
  } finally { p.kill(); }
});
