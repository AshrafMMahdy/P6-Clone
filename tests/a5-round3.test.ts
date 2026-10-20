// whiq-v0.1.15: the blended ratio sampler draws as the platform's forecast does (its sampleRatio, ported here as the
// oracle), each MCP server keeps its own recovery folder, and Microsoft Project imports from before v0.1.14 keep one
// relationship per pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOps } from '../core/project/ops.ts';
import { checkRelationship } from '../core/project/edit.ts';
import { runMonteCarlo } from '../core/risk/montecarlo.ts';
import { calendarResolver, scheduleProjects } from '../core/schedule/cpm.ts';
import { callTool, toolResult } from '../mcp/server.ts';
import { rows, type Db } from '../core/db.ts';

// ---- the oracle: shared/scheduler-engine/services/brains/forecast/slippage.ts (rng, sampleRatio) and the forward
// pass and percentile of montecarlo.ts, as the platform has them
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
interface SlippageModel { companyRatios: number[]; generalMean: number; generalStd: number; companyWeight: number }
function sampleRatio(m: SlippageModel, r: () => number): number {
  if (m.companyRatios.length >= 10 && r() < m.companyWeight) return m.companyRatios[Math.floor(r() * m.companyRatios.length)];
  const u1 = Math.max(1e-9, r());
  const u2 = r();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(4, Math.max(0.3, m.generalMean + z * m.generalStd));
}
function platformPercentile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((q / 100) * (sorted.length - 1))));
  return sorted[idx];
}
const ACTS = [{ id: 'A', d: 5, p: [] }, { id: 'B', d: 8, p: ['A'] }, { id: 'C', d: 3, p: ['A'] }, { id: 'D', d: 6, p: ['B', 'C'] }, { id: 'E', d: 4, p: ['C'] }, { id: 'F', d: 2, p: ['D', 'E'] }];
function platformForecast(slip: SlippageModel, nSims: number, seed: number): number[] {
  const r = rng(seed), out: number[] = [];
  for (let s = 0; s < nSims; s++) {
    const dur = new Map(ACTS.map((a) => [a.id, Math.max(0, a.d * sampleRatio(slip, r))]));
    const ef = new Map<string, number>();
    for (const a of ACTS) ef.set(a.id, Math.max(0, ...a.p.map((p) => ef.get(p)!)) + dur.get(a.id)!);
    out.push(Math.max(...ef.values()));
  }
  return out;
}

test('ratio_empirical draws as the platform\'s sampleRatio: the same seed gives the same finishes, so the same P10 / P50 / P90', async () => {
  const ratios = [0.95, 1, 1.05, 1.1, 1.2, 1.3, 0.9, 1.15, 1.4, 1.02, 1.6, 0.85];
  for (const [weight, list] of [[0.66, ratios], [0.66, ratios.slice(0, 5)], [0, ratios]] as const) {
    const db: Db = { tables: {} };
    assert.equal(applyOps(db, [{ op: 'add_project', id: 'F', start: '2026-03-02' }, ...ACTS.map((a) => ({ op: 'add_activity', id: a.id, name: a.id, duration_days: a.d })),
      ...ACTS.flatMap((a) => a.p.map((p) => ({ op: 'add_relationship', pred: p, succ: a.id })))]).ok, true);
    const pid = rows(db, 'PROJECT')[0].proj_id;
    assert.equal(scheduleProjects(db, [pid]).ok, true);
    const r = await runMonteCarlo(db, [pid], { iterations: 500, seed: 42, sampler: { type: 'ratio_empirical', ratios: [...list], weight, normal: { mean: 1.12, std: 0.28 } } });
    const cal = calendarResolver(db, []).fallback(rows(db, 'PROJECT')[0].clndr_id), dd = r.dataDate!;
    const clone = r.finishSamples.map((f) => cal.workBetween(dd, f) / 480);
    const oracle = platformForecast({ companyRatios: [...list], generalMean: 1.12, generalStd: 0.28, companyWeight: weight }, 500, 42);
    for (let i = 0; i < 500; i++) assert.ok(Math.abs(clone[i] - oracle[i]) < 0.01, `iteration ${i}: ${clone[i]} vs ${oracle[i]}`);
    const sc = [...clone].sort((x, y) => x - y), so = [...oracle].sort((x, y) => x - y);
    for (const q of [10, 50, 90]) assert.ok(Math.abs(platformPercentile(sc, q) - platformPercentile(so, q)) < 0.01, `P${q}`);
  }
});

function server(env: Record<string, string>, cwd: string) {
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts')], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, ...env } });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const exited = new Promise((res) => p.on('exit', res));
  const tool = (name: string, a: Record<string, unknown> = {}) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: a } }) + '\n'); }).then((r) => r.result.structuredContent);
  return { p, tool, exited };
}

test('two servers without a storage root: each has its own recovery folder; one exiting never saves or touches the other\'s moved-out projects', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'p6rec-'));
  const env = { TMPDIR: base, TMP: base, TEMP: base, P6CLONE_MAX_HANDLES: '1' };
  const cwdA = join(base, 'a'), cwdB = join(base, 'b');
  mkdirSync(cwdA); mkdirSync(cwdB);
  // an older server's shared index, and its file: left alone
  mkdirSync(join(base, '.p6clone-recovery'));
  writeFileSync(join(base, '.p6clone-recovery', 'index.json'), JSON.stringify({ h_old: { file: join(base, '.p6clone-recovery', 'h_old.p6db.jsonl'), ownerKey: 'k', path: null, format: 'xer', hpd: 8, at: 0, reason: 'memory', dirty: true } }));
  writeFileSync(join(base, '.p6clone-recovery', 'h_old.p6db.jsonl'), '');
  const A = server(env, cwdA), B = server(env, cwdB);
  const x = await A.tool('new_project', { id: 'XA', start: '2026-03-02' });
  await A.tool('edit', { handle: x.handle, operations: [{ op: 'add_activity', id: 'A1', name: 'unsaved in A', duration_days: 1 }] });
  await A.tool('new_project', { id: 'YA', start: '2026-03-02' }); // XA moves out (one slot)
  const moved = (await A.tool('list_open')).moved_out;
  assert.equal(moved.length, 1);
  const fileA = moved[0].recovery_file as string;
  assert.ok(existsSync(fileA) && !fileA.endsWith(join('.p6clone-recovery', `${x.handle}.p6db.jsonl`)), fileA);
  // B has its own unsaved project, and exits
  const z = await B.tool('new_project', { id: 'ZB', start: '2026-03-02' });
  await B.tool('edit', { handle: z.handle, operations: [{ op: 'add_activity', id: 'B1', name: 'unsaved in B', duration_days: 1 }] });
  assert.equal((await B.tool('list_open')).moved_out.length, 0, 'B does not see A\'s moved-out project');
  B.p.stdin.end();
  await B.exited;
  assert.deepEqual(readdirSync(cwdB).map((n) => n.replace(/\d{8}-\d{6}/, 'T')), ['ZB.recovered-T.xer'], 'B saved only its own work');
  assert.ok(existsSync(fileA), 'A\'s moved-out project is untouched');
  assert.ok(existsSync(join(base, '.p6clone-recovery', 'index.json')) && existsSync(join(base, '.p6clone-recovery', 'h_old.p6db.jsonl')), 'an older server\'s files are left alone');
  // A brings its project back
  const back = await A.tool('get_activity', { handle: x.handle, activity_id: 'A1' });
  assert.equal(back.name, 'unsaved in A');
  A.p.stdin.end();
  await A.exited;
  assert.deepEqual(readdirSync(cwdA).map((n) => n.replace(/\d{8}-\d{6}/, 'T')).sort(), ['XA.recovered-T.xer', 'YA.recovered-T.xer'], 'A saved its own two');
});

test('a Microsoft Project import from before v0.1.14 (task UIDs, no source mark) keeps one relationship per pair; so does a handle opened from an .mpx file', async () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'M', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A' }, { op: 'add_activity', id: 'B', name: 'B' }, { op: 'add_relationship', pred: 'A', succ: 'B' }]).ok, true);
  const t = rows(db, 'TASK');
  assert.equal(checkRelationship(db, t[0].task_id, t[1].task_id, 'PR_SS'), undefined, 'a P6 project: per type');
  for (const [i, x] of t.entries()) x._msp_uid = String(i + 1); // as an MPX read before v0.1.14 left it
  assert.match(checkRelationship(db, t[0].task_id, t[1].task_id, 'PR_SS')!, /one relationship per pair/);
  assert.match(applyOps(db, [{ op: 'add_relationship', pred: 'A', succ: 'B', type: 'SS' }]).warnings![0], /Microsoft Project keeps one per pair/);
  // MCP: an .mpx file opened now
  const { writeMpx } = await import('../core/msp/mpx.ts');
  const clean: Db = { tables: {} };
  applyOps(clean, [{ op: 'add_project', id: 'M2', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 1 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 1 }, { op: 'add_relationship', pred: 'A', succ: 'B' }]);
  const path = join(mkdtempSync(join(tmpdir(), 'p6mpx-')), 'm.mpx');
  writeFileSync(path, writeMpx(clean));
  const call = async (name: string, a: Record<string, unknown>) => toolResult((await callTool(name, a)).out, false).structuredContent as any;
  const o = await call('open_file', { path });
  const ids = (await call('find_activities', { handle: o.handle })).activities.map((x: any) => x.id);
  const r = await call('edit', { handle: o.handle, operations: [{ op: 'add_relationship', pred: ids[0], succ: ids[1], type: 'SS' }] });
  assert.match(r.warnings[0], /Microsoft Project keeps one per pair/);
  await call('close', { handle: o.handle, discard: true });
});
