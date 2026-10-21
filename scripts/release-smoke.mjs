// Release smoke for the MCP bundle, run on the EXTRACTED release archive (whiq-release.yml) or on dist-cli/:
//   node scripts/release-smoke.mjs <folder with p6clone-mcp.cjs>
// Every analysis tool is called on a small resourced project; the schedule reasoner must load from the folder's
// models/ and ort/ (server_status reasoner.loaded) and optimize_schedule must answer. Exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const folder = resolve(process.argv[2] ?? 'dist-cli');
// a small IFC4 model (buildingSMART, CC BY 4.0) for the 4D tools: next to this script's repository
const ifcFixture = resolve(process.argv[3] ?? join(import.meta.dirname, '..', 'tests', 'fixtures', '4d', 'construction-scheduling-task.ifc'));
const dir = mkdtempSync(join(tmpdir(), 'p6smoke-'));
const child = spawn(process.execPath, [join(folder, 'p6clone-mcp.cjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
child.on('exit', (code) => { console.error(`the MCP server exited (code ${code}) before the smoke finished`); process.exit(1); });
let buf = '', id = 0;
const waiting = new Map();
child.stdout.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) { if (!l.trim()) continue; const m = JSON.parse(l); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const timer = setTimeout(() => { console.error('smoke timed out'); process.exit(1); }, 600000);
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
const FOURD = ['open_model', 'list_elements', 'element_info', 'quantities', 'link_elements', 'link_by_rules', 'link_status', 'set_4d_keys', 'export_4d', 'import_4d', 'simulate_4d', 'compare_4d', 'set_element_status', 'render_4d', 'relink_model', 'synchro_cloud'];
const ANALYSIS = ['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'tia'];
for (const need of ['open_file', 'new_project', 'edit', 'schedule', 'save', 'export_pdf', 'server_status', ...ANALYSIS, ...FOURD]) if (!names.includes(need)) failures.push(`missing tool ${need}`);
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

// 4D: the IFC engine (ifc/ beside the bundle: web-ifc and the geometry worker in its own process)
for (const f of ['geomWorker.mjs', 'geomChunk.mjs', 'web-ifc/web-ifc-node.wasm']) if (!existsSync(join(folder, 'ifc', f))) failures.push(`the archive has no ifc/${f}`);
if (!existsSync(ifcFixture)) failures.push(`no IFC fixture at ${ifcFixture}`);
else {
  const m4 = await call('new_project', { id: 'S4D', start: '2026-03-02' });
  const ops4 = ['Slab #1', 'Wall #1', 'Wall #2', 'Wall #3', 'Wall #4'].map((n) => ({ op: 'add_activity', id: n.replace(/\W/g, ''), name: n, duration_days: 2 }));
  await call('edit', { handle: m4.handle, owner_key: m4.owner_key, operations: ops4 });
  await call('schedule', { handle: m4.handle, owner_key: m4.owner_key });
  const om = await call('open_model', { handle: m4.handle, owner_key: m4.owner_key, path: ifcFixture });
  if (om.geometry !== 'ok') failures.push(`open_model geometry: ${JSON.stringify(om).slice(0, 200)}`);
  const H = { handle: m4.handle, owner_key: m4.owner_key };
  const els = await call('list_elements', { handle: m4.handle });
  if (els.total !== 5) failures.push(`list_elements: ${JSON.stringify(els).slice(0, 200)}`);
  const g0 = els.elements?.[0]?.guid;
  const info = await call('element_info', { handle: m4.handle, guids: [g0] });
  if (!info.elements?.length) failures.push(`element_info: ${JSON.stringify(info).slice(0, 200)}`);
  const imp4 = await call('import_4d', { ...H, path: ifcFixture });
  if (imp4.added !== 5) failures.push(`import_4d (IFC4 4D): ${JSON.stringify(imp4).slice(0, 200)}`);
  const le = await call('link_elements', { ...H, links: [{ activity: 'Slab1', guids: [g0], role: 'temporary' }] });
  if (le.added == null) failures.push(`link_elements: ${JSON.stringify(le).slice(0, 200)}`);
  const rules = await call('link_by_rules', { ...H, dry_run: true, rules: [{ type: 'scope', activity: 'Wall1', class: 'IfcWall' }] });
  if (!rules.rules?.length && !rules.preview?.length) failures.push(`link_by_rules: ${JSON.stringify(rules).slice(0, 200)}`);
  await call('link_status', { handle: m4.handle });
  await call('quantities', { handle: m4.handle, group_by: 'activity' });
  const keys = await call('set_4d_keys', { ...H, from: 'activity_id' });
  if (!keys.set) failures.push(`set_4d_keys: ${JSON.stringify(keys).slice(0, 200)}`);
  const st4 = await call('set_element_status', { ...H, guids: [g0], status: 'installed', date: '2026-03-03' });
  if (st4.recorded !== 1) failures.push(`set_element_status: ${JSON.stringify(st4).slice(0, 200)}`);
  // every export, and the clone's own packages read back
  const ex = {};
  for (const target of ['navisworks', 'synchro', 'ifc4d', 'csv']) {
    ex[target] = await call('export_4d', { handle: m4.handle, target, path: join(dir, `4d-${target}`) });
    if (!ex[target].written?.length) failures.push(`export_4d ${target}: ${JSON.stringify(ex[target]).slice(0, 200)}`);
  }
  if (ex.ifc4d.tasks !== 5) failures.push(`export_4d ifc4d tasks: ${JSON.stringify(ex.ifc4d).slice(0, 200)}`);
  const sets = ex.navisworks.written?.find((f) => f.endsWith('-sets.xml')), tl = ex.navisworks.written?.find((f) => f.endsWith('timeliner.csv'));
  const is = await call('import_4d', { ...H, path: sets, link: false });
  if (is.source !== 'search_sets' || is.sets?.length !== 5) failures.push(`import_4d (search sets): ${JSON.stringify(is).slice(0, 200)}`);
  const it = await call('import_4d', { ...H, path: tl, link: false });
  if (it.source !== 'timeliner_csv' || it.matched_activities !== 5) failures.push(`import_4d (TimeLiner CSV): ${JSON.stringify(it).slice(0, 200)}`);
  const i4 = await call('import_4d', { ...H, path: ex.ifc4d.written?.[0], link: false });
  if (i4.source !== 'ifc4d') failures.push(`import_4d (the clone's IFC4 4D): ${JSON.stringify(i4).slice(0, 200)}`);
  const sim4 = await call('simulate_4d', { handle: m4.handle });
  if (!sim4.frames?.length) failures.push(`simulate_4d: ${JSON.stringify(sim4).slice(0, 200)}`);
  const cmp4 = await call('compare_4d', { handle: m4.handle, against: 'planned' });
  if (!cmp4.totals) failures.push(`compare_4d: ${JSON.stringify(cmp4).slice(0, 200)}`);
  const view4 = await call('render_4d', { handle: m4.handle, kind: 'viewer', path: join(dir, '4d-viewer') });
  if (!view4.written?.some((f) => f.endsWith('viewer4d.js'))) failures.push(`render_4d viewer: ${JSON.stringify(view4).slice(0, 200)}`);
  // video where the runner has a Chromium (P6CLONE_CHROMIUM); MP4 through ffmpeg where it has one (P6CLONE_FFMPEG,
  // with P6CLONE_RECORD_WEBM=1 so the page records WebM as Chromium for Testing does)
  const vid = await call('render_4d', { handle: m4.handle, kind: 'video', step: 30, width: 320, height: 180, path: join(dir, '4d-video') });
  if (process.env.P6CLONE_CHROMIUM) {
    if (vid.rendered !== true || !vid.frames) failures.push(`render_4d video: ${JSON.stringify(vid).slice(0, 300)}`);
    if (process.env.P6CLONE_FFMPEG && vid.mime !== 'video/mp4') failures.push(`render_4d video as MP4 through ffmpeg: ${JSON.stringify(vid).slice(0, 300)}`);
  } else if (vid.rendered !== false || !vid.client_render) failures.push(`render_4d video without Chromium: ${JSON.stringify(vid).slice(0, 200)}`);
  const rel4 = await call('relink_model', { handle: m4.handle, path: ifcFixture, dry_run: true });
  if (rel4.lost !== 0) failures.push(`relink_model: ${JSON.stringify(rel4).slice(0, 200)}`);
  const sc4 = await call('synchro_cloud', { ...H });
  if (sc4.optional !== true) failures.push(`synchro_cloud: ${JSON.stringify(sc4).slice(0, 200)}`);
}
await call('save', { handle, owner_key, path: 'smoke.xer' });
if (!existsSync(join(dir, 'smoke.xer'))) failures.push('save wrote no smoke.xer');

clearTimeout(timer);
child.removeAllListeners('exit'); child.kill();
if (failures.length) { console.error(`smoke FAILED on node ${process.version} (${process.platform}):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log(`ok: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${names.length} tools, ${ANALYSIS.length} analysis tools and ${FOURD.length} 4D tools answered (video: ${process.env.P6CLONE_CHROMIUM ? (process.env.P6CLONE_FFMPEG ? 'MP4 through ffmpeg' : 'rendered') : 'client render request'}), reasoner loaded (${status.reasoner.runtime}), saved smoke.xer on node ${process.version} (${process.platform})`);
