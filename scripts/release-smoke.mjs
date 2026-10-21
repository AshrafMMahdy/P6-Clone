// Release smoke for the MCP bundle, run on the EXTRACTED release archive (whiq-release.yml) or on dist-cli/:
//   node scripts/release-smoke.mjs <folder with p6clone-mcp.cjs>
// Every analysis tool is called on a small resourced project; the schedule reasoner must load from the folder's
// models/ and ort/ (server_status reasoner.loaded) and optimize_schedule must answer. Exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const folder = resolve(process.argv[2] ?? 'dist-cli');
const dir = mkdtempSync(join(tmpdir(), 'p6smoke-'));
const child = spawn(process.execPath, [join(folder, 'p6clone-mcp.cjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
child.on('exit', (code) => { console.error(`the MCP server exited (code ${code}) before the smoke finished`); process.exit(1); });
let buf = '', id = 0;
const waiting = new Map();
child.stdout.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) { if (!l.trim()) continue; const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const timer = setTimeout(() => { console.error('smoke timed out'); process.exit(1); }, 180000);
const failures = [];
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const out = r.result?.structuredContent ?? (r.result?.content?.[0]?.text ? JSON.parse(r.result.content[0].text) : undefined);
  if (r.error || r.result?.isError) failures.push(`${name}: ${JSON.stringify(r.error ?? out).slice(0, 300)}`);
  return out ?? {};
};

const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'whiq-release-smoke', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list', {})).result?.tools ?? [];
const names = tools.map((t) => t.name);
const ANALYSIS = ['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'tia'];
for (const need of ['open_file', 'new_project', 'edit', 'schedule', 'save', 'export_pdf', 'server_status', ...ANALYSIS]) if (!names.includes(need)) failures.push(`missing tool ${need}`);
if (JSON.stringify(tools.find((t) => t.name === 'windows_analysis')?._meta?.['whiq/files']?.read) !== '["updates[].path"]') failures.push('windows_analysis has no _meta["whiq/files"]');

const status = await call('server_status', {});
if (!status.reasoner?.loaded) failures.push(`the reasoner did not load: ${JSON.stringify(status.reasoner)}`);

const np = await call('new_project', { id: 'SMOKE', name: 'Release smoke', start: '2026-03-02' });
const { handle, owner_key } = np;
const ops = [{ op: 'add_resource', id: 'crew', name: 'Crew', max_units_per_hour: 1 }];
for (const [a, d] of [['A', 5], ['B', 4], ['C', 3], ['D', 6]]) ops.push({ op: 'add_activity', id: a, name: a, duration_days: d }, { op: 'assign_resource', activity: a, resource: 'crew', units_per_day: 8 });
ops.push({ op: 'add_activity', id: 'F', name: 'Finish', type: 'finish_milestone' }, { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'F' }, { op: 'add_relationship', pred: 'C', succ: 'D' }, { op: 'add_relationship', pred: 'D', succ: 'F' });
await call('edit', { handle, owner_key, operations: ops });
await call('schedule', { handle, owner_key, log: true });
await call('edit', { handle, owner_key, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] });

await call('check_schedule', { handle });
await call('dcma_14', { handle });
await call('lint', { handle });
await call('float_paths', { handle, count: 3 });
await call('progress_curves', { handle });
await call('resource_histogram', { handle });
await call('evaluate_batch', { handle, scenarios: [{ name: 'D shorter', overrides: [{ op: 'update_activity', id: 'D', duration_days: 3 }] }] });
const crash = await call('crash_schedule', { handle, target_days: 2 });
if (crash.stop !== 'SUCCESS') failures.push(`crash_schedule: ${JSON.stringify(crash).slice(0, 200)}`);
const opt = await call('optimize_schedule', { handle, seed: 1, samples: 20 });
if (!opt.reasoner_finish) failures.push(`optimize_schedule: ${JSON.stringify(opt).slice(0, 200)}`);
await call('windows_analysis', { handle, include_current: false, updates: [{ baseline: 'project' }, { data_date: '2026-03-09', progress: [{ op: 'update_activity', id: 'A', actual_start: '2026-03-02 08:00', remaining_days: 3 }] }] });
const tia = await call('tia', { handle, fragnet: [{ op: 'add_activity', id: 'X', name: 'Change', duration_days: 2 }, { op: 'add_relationship', pred: 'A', succ: 'X' }, { op: 'add_relationship', pred: 'X', succ: 'B' }] });
if (tia.delay_days == null) failures.push(`tia: ${JSON.stringify(tia).slice(0, 200)}`);
await call('compare', { handle, baseline: 'project' });
await call('save', { handle, owner_key, path: 'smoke.xer' });
if (!existsSync(join(dir, 'smoke.xer'))) failures.push('save wrote no smoke.xer');

clearTimeout(timer);
child.removeAllListeners('exit'); child.kill();
if (failures.length) { console.error(`smoke FAILED on node ${process.version} (${process.platform}):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`ok: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${names.length} tools, ${ANALYSIS.length} analysis tools answered, reasoner loaded (${status.reasoner.runtime}), saved smoke.xer on node ${process.version} (${process.platform})`);
