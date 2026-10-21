// A long job never makes the server look frozen: job_status answers within a second while a JWM Monte Carlo (11,426
// activities, each iteration a full CPM run on the main thread) is running, over stdio as the platform calls it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SAMPLES_DIR } from './helpers.ts';

const JWM = join(SAMPLES_DIR, 'Copy of JWM - Baseline Programme Rev 05A.xer');

test('job_status answers within 1 s all through a JWM Monte Carlo (the stdio front answers while the main thread is busy)', { skip: !existsSync(JWM) && 'no JWM sample', timeout: 240_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'p6-latency-'));
  const p = spawn(process.execPath, ['--max-old-space-size=2048', join(import.meta.dirname, '..', 'mcp', 'server.ts'), '--automation-read-root', SAMPLES_DIR, '--automation-write-root', cwd], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, P6CLONE_MEM_BUDGET_MB: '1536', TMPDIR: cwd, TMP: cwd, TEMP: cwd } });
  p.stderr.on('data', (d) => { if (process.env.DEBUG_LATENCY) process.stderr.write(d); });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* not ours */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;
  try {
    await rpc('initialize', {});
    let o = await call('open_file', { path: JWM, async: true });
    while (o.status === 'running' || (o.job_id && !o.handle && o.status !== 'done')) { await new Promise((r) => setTimeout(r, 300)); o = await call('job_status', { job_id: o.job_id }); }
    const h = o.result?.handle ?? o.handle;
    assert.ok(h, JSON.stringify(o).slice(0, 300));
    const job = await call('monte_carlo', { handle: h, iterations: 2000, default_estimates: { min_pct: 90, max_pct: 125 }, async: true });
    assert.ok(job.job_id, JSON.stringify(job).slice(0, 300));
    const lat: number[] = [];
    let busy = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000) {
      const t = Date.now();
      const s = await call('job_status', { job_id: job.job_id });
      lat.push(Date.now() - t);
      if (s.busy) busy++;
      assert.equal(s.status, 'running', JSON.stringify(s).slice(0, 300));
      await new Promise((r) => setTimeout(r, 200));
    }
    lat.sort((a, b) => a - b);
    assert.ok(lat[lat.length - 1] < 1000, `job_status took up to ${lat[lat.length - 1]} ms (median ${lat[lat.length >> 1]} ms, ${busy} of ${lat.length} answered by the front while busy)`);
    await call('cancel_job', { job_id: job.job_id });
  } finally { p.kill(); }
});
