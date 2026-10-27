// Open a (big) model through the MCP server under a memory budget and report what it took: the server's peak memory,
// the Navisworks reader's (its own process), every process of the run together, the time, and what the model answered.
// Usage: P6CLONE_MEM_BUDGET_MB=2048 node scripts/measure-federation.mjs <model>
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [model] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'p6c-measure-'));
const server = process.env.P6CLONE_SERVER || 'mcp/server.ts';
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TEMP: work, TMP: work, TMPDIR: work, P6CLONE_MODEL_CACHE: process.env.P6CLONE_MODEL_CACHE || join(work, 'cache') } }); // its own temp folder: no other server's recovery copies
let buf = '', id = 0;
const waiting = new Map();
child.stdout.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const out = r.result?.structuredContent ?? (r.result?.content?.[0]?.text ? JSON.parse(r.result.content[0].text) : r.error);
  if (out?.job_id && out.status === 'running') for (;;) { const j = await call('job_status', { job_id: out.job_id, wait_seconds: 20 }); if (j.status !== 'running') return j.result ?? j; }
  return out;
};
/** the server's peak memory (MB): Windows' peak working set, Linux's VmHWM */
const peak = () => {
  try {
    if (process.platform === 'win32') return Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).PeakWorkingSet64`], { encoding: 'utf8' }).trim()) / 1048576);
    return Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))[1]) / 1024);
  } catch { return null; }
};
// every process of the run (the server, the Navisworks reader, the tiler, web-ifc's workers), sampled every 2 s: the
// most they took together
let together = 0;
const sample = () => {
  try {
    const rows = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.WorkingSetSize) $($_.ProcessId) $($_.CommandLine)" }`], { encoding: 'utf8' }).split('\n')
      : execFileSync('ps', ['-eo', 'rss=,pid=,args='], { encoding: 'utf8' }).split('\n').map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? `${Number(m[1]) * 1024} ${m[2]} ${m[3]}` : ''; });
    let sum = 0;
    // this run's server and its children (their files are in its temp folder)
    for (const r of rows) { const [ws, pid] = r.trim().split(' '); if (Number(pid) === child.pid || r.includes(work)) sum += Number(ws) || 0; }
    together = Math.max(together, Math.round(sum / 1048576));
  } catch { /* the next sample */ }
};
const sampler = setInterval(sample, 2000);
await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'measure', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const t0 = Date.now();
const o = await call('open_model', { path: model });
const open = { seconds: Math.round((Date.now() - t0) / 1000), server_peak_mb: peak() };
const report = { model, budget_mb: Number(process.env.P6CLONE_MEM_BUDGET_MB) || null, open, answer: o?.error ? o : { elements: o.elements, geometry: o.geometry, meshed: o.meshed_elements, display: o.display, reader_peak_mb: o.source?.peak_memory_mb, files: o.source?.files?.length, warnings: o.source?.warnings?.length } };
if (o?.handle) {
  const t1 = Date.now();
  const q = await call('quantities', { handle: o.handle, group_by: 'class' });
  report.quantities = { seconds: Math.round((Date.now() - t1) / 1000), groups: q?.groups?.length ?? q };
  report.server_peak_mb = peak();
}
clearInterval(sampler);
report.all_processes_peak_mb = together;
console.log(JSON.stringify(report, null, 1));
child.kill();
rmSync(work, { recursive: true, force: true });
