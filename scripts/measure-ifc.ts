// Peak memory and wall time of the 4D work on an IFC, the way the MCP server does it (its tools called in-process),
// under the server's memory budget (P6CLONE_MEM_BUDGET_MB, default here 1536 as on the hosted VM). Each model runs in
// a fresh process; the process TREE is sampled every 50 ms (the server process plus its geometry workers and the
// headless Chromium), so a peak counts everything the work holds at once. Linux (/proc) only.
//   node scripts/measure-ifc.ts <model.ifc> [--cases open,mesh,link,exports,video] [--work <dir>] [--video-frames N]
// Prints one row per case: peak tree RSS, peak server RSS, wall time, what it answered.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = (n: number) => Math.round(n / 1048576);

// ── the child: the cases, phase by phase ─────────────────────────────────────────────────────────────────────────
if (process.argv[2] === '--one') {
  const [, , , model, work, casesArg, framesArg] = process.argv;
  const cases = new Set(casesArg.split(','));
  const { callTool, toolResult } = await import('../mcp/server.ts');
  // a call past 25 s becomes a job: waited for here
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const r = await callTool(name, args);
    let d = toolResult(r.out, r.isError).structuredContent as any;
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(d).slice(0, 600)}`);
    while (d?.job_id && d.status === 'running') {
      const j = toolResult((await callTool('job_status', { job_id: d.job_id, wait_seconds: 20 })).out, false).structuredContent as any;
      if (j.status === 'running') continue;
      if (j.status !== 'done') throw new Error(`${name}: ${JSON.stringify(j).slice(0, 600)}`);
      d = j.result;
    }
    return d;
  };
  const phase = async (name: string, fn: () => Promise<unknown>) => {
    process.stdout.write(`PHASE ${name}\n`);
    const t0 = Date.now();
    let note: unknown;
    try { note = await fn(); } catch (e) { note = { error: (e as Error).message.slice(0, 600) }; }
    process.stdout.write(`DONE ${name} ${Date.now() - t0} ${JSON.stringify(note).slice(0, 800)} ${process.memoryUsage().rss}\n`);
    return note;
  };
  const np = await call('new_project', { id: 'M', start: '2027-01-04' });
  const h = np.handle, owner_key = np.owner_key;
  let storeys: string[] = [];
  if (cases.has('open')) await phase('open', async () => { const d = await call('open_model', { handle: h, owner_key, path: model, geometry: false }); storeys = d.storeys; return { elements: d.elements, storeys: d.storeys.length, geometry: d.geometry }; });
  if (cases.has('mesh')) await phase('mesh', async () => { const d = await call('open_model', { handle: h, owner_key, path: model }); storeys = d.storeys; return { elements: d.elements, meshed: d.meshed_elements, geometry: d.geometry, note: d.geometry_note }; });
  const linked = cases.has('link') || cases.has('exports') || cases.has('video');
  if (linked) {
    await phase('link', async () => {
      if (!storeys.length) storeys = (await call('open_model', { handle: h, owner_key, path: model, geometry: cases.has('video') })).storeys;
      // one activity per storey and class, in sequence: the way a 4D planner links a tower
      const acts: { id: string; storey: string; cls: string }[] = [];
      storeys.forEach((s, i) => { for (const [k, cls] of [['C', 'IfcColumn'], ['W', 'IfcWall'], ['S', 'IfcSlab']] as const) acts.push({ id: `L${i + 1}${k}`, storey: s, cls }); });
      const ops: unknown[] = acts.map((a) => ({ op: 'add_activity', id: a.id, name: `${a.storey} ${a.cls.slice(3).toLowerCase()}s`, duration_days: 5 }));
      for (let i = 1; i < acts.length; i++) ops.push({ op: 'add_relationship', pred: acts[i - 1].id, succ: acts[i].id });
      await call('edit', { handle: h, owner_key, operations: ops });
      await call('schedule', { handle: h, owner_key });
      const r = await call('link_by_rules', { handle: h, owner_key, rules: acts.map((a) => ({ type: 'scope', activity: a.id, storey: a.storey, class: a.cls })) });
      const k = await call('set_4d_keys', { handle: h, owner_key });
      return { activities: acts.length, links: r.links ?? r.added, keys: k.set };
    });
  }
  if (cases.has('exports')) {
    for (const target of ['csv', 'navisworks', 'synchro', 'ifc4d']) {
      await phase(`export_${target}`, async () => {
        const dir = join(work, `export-${target}`);
        const d = await call('export_4d', { handle: h, owner_key, target, path: dir });
        const sizes = Object.fromEntries((d.written as string[]).map((f) => [f.split(/[\\/]/).pop(), MB(statSync(f).size)]));
        rmSync(dir, { recursive: true, force: true }); // the tagged copies are as big as the model
        return { ...sizes, elements_tagged: d.elements_tagged, element_links: d.element_links };
      });
    }
  }
  if (cases.has('video')) {
    await phase('video', async () => {
      const dir = join(work, 'video');
      const d = await call('render_4d', { handle: h, owner_key, kind: 'video', path: dir, step: Math.max(1, Math.ceil((storeys.length * 3 * 5 * 7 / 5) / Number(framesArg || 12))), width: 1280, height: 720, file_name: 'model.mp4' });
      // the MP4 decoded end to end (every frame) with the ffmpeg the server converts with
      let decoded: unknown = 'no P6CLONE_FFMPEG to decode with';
      if (d.written && process.env.P6CLONE_FFMPEG) {
        const r = spawnSync(process.env.P6CLONE_FFMPEG, ['-v', 'error', '-stats', '-i', d.written[0], '-f', 'null', '-'], { encoding: 'utf8' });
        const m = [...(r.stderr ?? '').matchAll(/frame=\s*(\d+)/g)].pop();
        decoded = { exit: r.status, frames: m ? Number(m[1]) : 0, errors: (r.stderr ?? '').split(/\r|\n/).filter((l) => l.trim() && !/^frame=/.test(l.trim())).slice(0, 3) };
      }
      return { written: d.written?.map((f: string) => f.split(/[\\/]/).pop()), frames: d.frames, mime: d.mime, bytes: d.written ? statSync(d.written[0]).size : 0, display: d.display, decoded, note: d.note };
    });
  }
  process.exit(0);
}

// ── the parent: run the child, sample its process tree ───────────────────────────────────────────────────────────
function treeRss(root: number): { total: number; root: number } {
  const kids = new Map<number, number[]>();
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try { const st = readFileSync(`/proc/${p}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(Number(p)); } catch { /* gone */ }
  }
  const rss = (pid: number) => { try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) * 1024 : 0; } catch { return 0; } };
  let total = 0;
  const stack = [root];
  while (stack.length) { const p = stack.pop()!; total += rss(p); stack.push(...(kids.get(p) ?? [])); }
  return { total, root: rss(root) };
}

const args = process.argv.slice(2);
const model = args[0];
if (!model || !existsSync(model)) { console.error('usage: node scripts/measure-ifc.ts <model.ifc> [--cases open,mesh,link,exports,video] [--work <dir>]'); process.exit(2); }
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cases = opt('--cases', 'open,mesh,link,exports');
const work = opt('--work', '') || mkdtempSync(join(tmpdir(), 'p6-measure-'));
mkdirSync(work, { recursive: true });
const env = { ...process.env, P6CLONE_MEM_BUDGET_MB: process.env.P6CLONE_MEM_BUDGET_MB ?? '1536', P6CLONE_MODEL_CACHE: process.env.P6CLONE_MODEL_CACHE ?? join(work, 'cache') };
const child = spawn(process.execPath, [`--max-old-space-size=${process.env.MEASURE_HEAP_MB ?? 4096}`, import.meta.filename, '--one', model, work, cases, opt('--video-frames', '12')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
type Row = { phase: string; peak: number; peakRoot: number; ms?: number; note?: string };
const rows: Row[] = [];
let cur: Row | null = null;
const timer = setInterval(() => { if (!cur) return; const s = treeRss(child.pid!); cur.peak = Math.max(cur.peak, s.total); cur.peakRoot = Math.max(cur.peakRoot, s.root); }, 50);
let rest = '';
child.stdout.on('data', (d) => {
  const lines = (rest + String(d)).split('\n'); rest = lines.pop()!;
  for (const l of lines) {
    const p = /^PHASE (\S+)/.exec(l), q = /^DONE (\S+) (\d+) (.*) (\d+)$/.exec(l);
    if (p) { cur = { phase: p[1], peak: 0, peakRoot: 0 }; rows.push(cur); }
    else if (q && cur) { cur.ms = Number(q[2]); cur.note = q[3]; cur = null; }
    else if (l.trim()) console.error(l);
  }
});
await new Promise((r) => child.on('close', r));
clearInterval(timer);
const size = statSync(model).size;
console.log(`model ${model.split(/[\\/]/).pop()} ${MB(size)} MB, budget ${env.P6CLONE_MEM_BUDGET_MB} MB`);
console.log('case              peak tree MB  peak server MB    wall s  answer');
for (const r of rows) console.log(`${r.phase.padEnd(18)}${String(MB(r.peak)).padStart(12)}${String(MB(r.peakRoot)).padStart(16)}${((r.ms ?? 0) / 1000).toFixed(1).padStart(10)}  ${r.note ?? '(did not finish)'}`);
console.log(`JSON ${JSON.stringify({ model, bytes: size, rows: rows.map((r) => ({ ...r, peakMb: MB(r.peak), peakServerMb: MB(r.peakRoot) })) })}`);
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
