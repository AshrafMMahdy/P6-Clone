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
import { dbLines } from '../core/db-file.ts';
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
// milestones (zero length) draw a ratio too, as the platform's forecast does: the sequences stay in step
const ACTS: { id: string; d: number; p: string[]; type?: string }[] = [{ id: 'S', d: 0, p: [], type: 'start_milestone' }, { id: 'A', d: 5, p: ['S'] }, { id: 'B', d: 8, p: ['A'] }, { id: 'C', d: 3, p: ['A'] }, { id: 'M', d: 0, p: ['C'], type: 'finish_milestone' },
  { id: 'D', d: 6, p: ['B', 'M'] }, { id: 'E', d: 4, p: ['C'] }, { id: 'F', d: 2, p: ['D', 'E'] }, { id: 'Z', d: 0, p: ['F'], type: 'finish_milestone' }];
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

test('ratio_empirical draws as the platform\'s sampleRatio, milestones included: the same seed gives the same finishes, so the same P10 / P50 / P90', async () => {
  const ratios = [0.95, 1, 1.05, 1.1, 1.2, 1.3, 0.9, 1.15, 1.4, 1.02, 1.6, 0.85];
  for (const [weight, list] of [[0.66, ratios], [0.66, ratios.slice(0, 5)], [0, ratios]] as const) {
    const db: Db = { tables: {} };
    assert.equal(applyOps(db, [{ op: 'add_project', id: 'F', start: '2026-03-02' }, ...ACTS.map((a) => ({ op: 'add_activity', id: a.id, name: a.id, ...(a.type ? { type: a.type } : { duration_days: a.d }) })),
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
  let buf = '', id = 0, err = '';
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stderr.on('data', (c: string) => { err += c; });
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const exited = new Promise((res) => p.on('exit', res));
  const tool = (name: string, a: Record<string, unknown> = {}) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: a } }) + '\n'); }).then((r) => r.result.structuredContent);
  return { p, tool, exited, stderr: () => err };
}
/** A private temp folder (the servers' recovery folders live in it) and a working folder per server. */
function place(...names: string[]) {
  const base = mkdtempSync(join(tmpdir(), 'p6rec-'));
  for (const n of names) mkdirSync(join(base, n));
  return { base, rec: join(base, '.p6clone-recovery'), env: (more: Record<string, string> = {}) => ({ TMPDIR: base, TMP: base, TEMP: base, P6CLONE_CHECKPOINT_MS: '100', ...more }), at: (n: string) => join(base, n) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A pid that is surely not running: a process that has already exited. */
async function deadPid(): Promise<number> { const c = spawn(process.execPath, ['-e', '0']); await new Promise((r) => c.on('exit', r)); return c.pid!; }
/** A recovery folder as a server that is gone left it: owner lock, index, and one moved-out project with an edit. */
function leftover(dir: string, pid: number, handle: string, legacy = false) {
  const db: Db = { tables: {} };
  applyOps(db, [{ op: 'add_project', id: 'LEFT', start: '2026-03-02' }, { op: 'add_activity', id: 'L1', name: 'left behind', duration_days: 1 }]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${handle}.p6db.jsonl`);
  writeFileSync(file, [...dbLines(db, null)].join('\n') + '\n');
  const e = { file, ownerKey: 'ok_left', path: null, format: 'xer', hpd: 8, at: Date.now(), reason: 'memory', dirty: true };
  if (legacy) writeFileSync(join(dir, 'index.json'), JSON.stringify({ [handle]: e }));
  else { writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, token: 'x', started: null })); writeFileSync(join(dir, 'index.json'), JSON.stringify({ evicted: { [handle]: e }, checkpoints: {} })); }
  return file;
}
const files = (d: string) => (existsSync(d) ? readdirSync(d) : []);

test('a restart brings every handle back with its unsaved edits, under its old owner key', { timeout: 60_000 }, async () => {
  const w = place('a');
  const s1 = server(w.env(), w.at('a'));
  const x = await s1.tool('new_project', { id: 'RS', start: '2026-03-02' });
  await s1.tool('edit', { handle: x.handle, operations: [{ op: 'add_activity', id: 'A1', name: 'before the restart', duration_days: 1 }] });
  s1.p.stdin.end(); await s1.exited;
  const s2 = server(w.env(), w.at('a'));
  const g = await s2.tool('get_activity', { handle: x.handle, activity_id: 'A1' });
  assert.equal(g.name, 'before the restart');
  assert.match(g._notice, /restarted/);
  assert.equal((await s2.tool('list_open')).open[0].unsaved_changes, true);
  const sv = await s2.tool('save', { handle: x.handle, owner_key: x.owner_key, path: join(w.at('a'), 'rs.xer') });
  assert.equal(sv.saved, join(w.at('a'), 'rs.xer'));
  s2.p.stdin.end(); await s2.exited;
});

test('after a crash (SIGKILL) a new server brings the handles back from the dead one\'s folder; nothing is deleted', { timeout: 60_000 }, async () => {
  const w = place('a');
  const s1 = server(w.env(), w.at('a'));
  const x = await s1.tool('new_project', { id: 'CR', start: '2026-03-02' });
  await s1.tool('edit', { handle: x.handle, operations: [{ op: 'add_activity', id: 'C1', name: 'before the crash', duration_days: 1 }] });
  await sleep(1000); // the checkpoint (100 ms after the change)
  s1.p.kill('SIGKILL'); await s1.exited;
  const dead = files(w.rec).filter((n) => n !== 'adopted');
  assert.equal(dead.length, 1);
  const s2 = server(w.env(), w.at('a'));
  assert.equal((await s2.tool('get_activity', { handle: x.handle, activity_id: 'C1' })).name, 'before the crash');
  assert.match(s2.stderr(), /1 project\(s\) from a server that is no longer running/);
  // the dead folder was moved aside, whole
  const aside = files(join(w.rec, 'adopted'));
  assert.equal(aside.length, 1);
  assert.ok(aside[0].startsWith(dead[0]));
  assert.ok(files(join(w.rec, 'adopted', aside[0])).includes(`${x.handle}.p6db.jsonl`));
  s2.p.kill('SIGKILL'); await s2.exited;
});

test('two live servers without a storage root stay isolated: one exiting never saves or touches the other\'s moved-out projects', { timeout: 60_000 }, async () => {
  const w = place('a', 'b');
  const env = w.env({ P6CLONE_MAX_HANDLES: '1' });
  const A = server(env, w.at('a')), B = server(env, w.at('b'));
  const x = await A.tool('new_project', { id: 'XA', start: '2026-03-02' });
  await A.tool('edit', { handle: x.handle, operations: [{ op: 'add_activity', id: 'A1', name: 'unsaved in A', duration_days: 1 }] });
  await A.tool('new_project', { id: 'YA', start: '2026-03-02' }); // XA moves out (one slot)
  const moved = (await A.tool('list_open')).moved_out;
  assert.equal(moved.length, 1);
  const fileA = moved[0].recovery_file as string;
  const z = await B.tool('new_project', { id: 'ZB', start: '2026-03-02' });
  await B.tool('edit', { handle: z.handle, operations: [{ op: 'add_activity', id: 'B1', name: 'unsaved in B', duration_days: 1 }] });
  assert.equal((await B.tool('list_open')).moved_out.length, 0, 'B does not see A\'s moved-out project');
  B.p.stdin.end(); await B.exited;
  assert.deepEqual(files(w.at('b')).map((n) => n.replace(/\d{8}-\d{6}/, 'T')), ['ZB.recovered-T.xer'], 'B saved only its own work');
  assert.ok(existsSync(fileA), 'A\'s moved-out project is untouched');
  // a third server starting now adopts B's folder (B is gone), not A's (A is alive)
  const C = server(env, w.at('b'));
  assert.equal((await C.tool('get_activity', { handle: z.handle, activity_id: 'B1' })).name, 'unsaved in B');
  assert.equal((await C.tool('get_activity', { handle: x.handle, activity_id: 'A1' })).error.code, 'unknown_handle');
  assert.equal((await A.tool('get_activity', { handle: x.handle, activity_id: 'A1' })).name, 'unsaved in A');
  A.p.kill('SIGKILL'); C.p.kill('SIGKILL'); await A.exited; await C.exited;
});

test('a dead owner\'s folder, and the shared index of servers before v0.1.15, are adopted by exactly one of two servers starting at once', { timeout: 60_000 }, async () => {
  const w = place('a', 'b');
  const pid = await deadPid();
  const f1 = leftover(join(w.rec, `${pid}-0123456789ab`), pid, 'h_dead');
  const f2 = leftover(w.rec, 0, 'h_legacy', true); // the old shared index.json and its file, in the folder itself
  const A = server(w.env(), w.at('a')), B = server(w.env(), w.at('b'));
  const got = async (s: ReturnType<typeof server>, h: string) => !(await s.tool('get_activity', { handle: h, activity_id: 'L1' })).error;
  for (const h of ['h_dead', 'h_legacy']) {
    const wins = [await got(A, h), await got(B, h)];
    assert.equal(wins.filter(Boolean).length, 1, `${h}: ${wins}`);
  }
  assert.ok(existsSync(f2), 'the legacy file stays where it was');
  assert.ok(!existsSync(f1) && files(join(w.rec, 'adopted')).some((n) => n.startsWith(`${pid}-0123456789ab-by-`)), 'the dead folder moved aside');
  assert.ok(files(join(w.rec, 'adopted')).some((n) => n.startsWith('index-before-v0.1.15-by-')));
  A.p.kill('SIGKILL'); B.p.kill('SIGKILL'); await A.exited; await B.exited;
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

test('copy_project of a project from Microsoft Project is a P6 project: its mark says so, so one relationship per pair and type, whatever its UIDs', () => {
  const db: Db = { tables: {} };
  assert.equal(applyOps(db, [{ op: 'add_project', id: 'MS', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A' }, { op: 'add_activity', id: 'B', name: 'B' }, { op: 'add_relationship', pred: 'A', succ: 'B' }]).ok, true);
  rows(db, 'PROJECT')[0]._msp_source = 'Y';
  for (const [i, t] of rows(db, 'TASK').entries()) t._msp_uid = String(i + 1);
  assert.equal(applyOps(db, [{ op: 'copy_project', from: 'MS', id: 'P6COPY' }]).ok, true);
  const copy = rows(db, 'PROJECT').find((p) => p.proj_short_name === 'P6COPY')!;
  assert.equal(copy._msp_source, 'N');
  // the mark decides, even if Project task UIDs were on its activities
  for (const t of rows(db, 'TASK').filter((x) => x.proj_id === copy.proj_id)) t._msp_uid = 'u' + t.task_id;
  const r = applyOps(db, [{ op: 'add_relationship', project: 'P6COPY', pred: 'A', succ: 'B', type: 'SS' }, { op: 'add_relationship', project: 'MS', pred: 'A', succ: 'B', type: 'SS' }]);
  assert.deepEqual(r.results, [{ relationship: 'A SS B' }, { skipped: 'A SS B', existing: 'A FS B' }]);
  assert.match(r.warnings![0], /Microsoft Project keeps one per pair/);
});
