// The MCP server's contract with the platform: error shape, unsaved_changes, refusing a file P6 would reject (or
// opening it leniently), close keeping unsaved work, read/write roots, atomic saves, and the save at exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { SAMPLES_DIR } from './helpers.ts';
import type { Db } from '../core/db.ts';

const SERVER = join(import.meta.dirname, '..', 'mcp', 'server.ts');
const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await callTool(name, args); return { isError: r.isError, data: toolResult(r.out, r.isError).structuredContent as any }; };

/** A small XER, and the same file with a duplicated TASK row (P6 refuses it: unique constraint). */
function files(dir: string) {
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'R1', start: '2026-03-02' }, { op: 'add_activity', id: 'A1', name: 'One', duration_days: 2 }, { op: 'add_activity', id: 'A2', name: 'Two', duration_days: 2 }, { op: 'add_relationship', pred: 'A1', succ: 'A2' }]).ok);
  const text = new TextDecoder().decode(writeXer(db, { version: '19.12', encoding: 'utf-8' }));
  const good = join(dir, 'good.xer'), dup = join(dir, 'dup.xer'), junk = join(dir, 'junk.xer');
  writeFileSync(good, text);
  const lines = text.split('\r\n'), i = lines.findIndex((l, n) => l.startsWith('%R') && lines.slice(0, n).reverse().find((x) => x.startsWith('%T'))!.endsWith('\tTASK'));
  lines.splice(i, 0, lines[i]);
  writeFileSync(dup, lines.join('\r\n'));
  writeFileSync(junk, 'this is not a schedule');
  return { good, dup, junk };
}

test('MCP contract: unsaved_changes, error shape, p6_would_reject / lenient, close keeps unsaved work, failed jobs, import_excel warnings', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-c-'));
  const f = files(dir);
  // a project in memory has unsaved changes; reads do not report them, changes and saves do
  const np = await call('new_project', { id: 'N1', start: '2026-03-02' });
  assert.deepEqual([np.isError, typeof np.data.handle, np.data.unsaved_changes], [false, 'string', true]);
  const h = np.data.handle;
  assert.equal((await call('save', { handle: h, path: join(dir, 'n1.xer') })).data.unsaved_changes, false);
  assert.equal((await call('edit', { handle: h, operations: [{ op: 'add_activity', id: 'X', name: 'x' }] })).data.unsaved_changes, true);
  assert.equal('unsaved_changes' in (await call('find_activities', { handle: h })).data, false);
  assert.equal((await call('undo', { handle: h })).data.unsaved_changes, true);
  // errors: the craft forks' shape, the older fields beside it
  const e = await call('get_activity', { handle: 'h_none', activity_id: 'A' });
  assert.equal(e.isError, true);
  assert.deepEqual([e.data.error.code, e.data.error.reason, e.data.error.next_step], ['unknown_handle', e.data.error.message, e.data.error.hint]);
  const op = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'NOPE' }] });
  assert.deepEqual([op.isError, op.data.error.code, op.data.error.reason], [true, 'op_failed', 'No activity "NOPE".']);
  // close keeps unsaved work
  const kept = await call('close', { handle: h });
  assert.deepEqual([kept.isError, kept.data.error.code], [true, 'unsaved_changes']);
  assert.equal((await call('close', { handle: h, discard: true })).isError, false);
  // a file P6 would reject is an error, with the fatal findings; lenient opens it to be repaired
  const rej = await call('open_file', { path: f.dup });
  assert.deepEqual([rej.isError, rej.data.error.code, rej.data.error.fatal[0].code], [true, 'p6_would_reject', 'DUP_KEY']);
  assert.match(rej.data.error.next_step, /lenient: true/);
  const len = await call('open_file', { path: f.dup, lenient: true });
  assert.deepEqual([len.isError, len.data.lenient, len.data.diagnostics.verdict, len.data.unsaved_changes, len.data.still_rejected], [false, true, 'fatal', false, true]);
  // a repeated TASK id that relationships point at cannot be told apart: left, and said so
  assert.ok(len.data.diagnostics.not_repaired.some((x: string) => /TASK: 1 row\(s\) repeat a task_id/.test(x)), JSON.stringify(len.data.diagnostics));
  const unreadable = await call('open_file', { path: f.junk, lenient: true });
  assert.deepEqual([unreadable.isError, unreadable.data.error.code], [true, 'p6_would_reject']);
  assert.equal((await call('server_status')).data.open.length, 1, 'refused opens hold no project');
  // a failed job is an error too
  const job = await call('open_file', { path: join(dir, 'missing.xer'), async: true });
  const js = await call('job_status', { job_id: job.data.job_id, wait_seconds: 10 });
  assert.deepEqual([js.isError, js.data.status, js.data.error.code, typeof js.data.error.reason], [true, 'failed', 'file_unreadable', 'string']);
  // memory in bytes (and MB, as before)
  const st = (await call('server_status')).data.memory;
  assert.ok(st.rss_bytes > 1e6 && st.rss_mb === Math.round(st.rss_bytes / 1048576));
  // import_excel: a relationship of another type on a pair is added beside the first (P6 keeps one per pair and type)
  const g = (await call('open_file', { path: f.good })).data.handle;
  await call('export_excel', { handle: g, path: join(dir, 'g.xlsx') });
  const sheets = await readXlsx(new Uint8Array(readFileSync(join(dir, 'g.xlsx'))));
  const tp = sheets.find((s) => s.name === 'TASKPRED')!;
  tp.rows[2][tp.rows[0].indexOf('pred_type')] = 'SS';
  writeFileSync(join(dir, 'g2.xlsx'), await writeXlsx(sheets));
  const imp = await call('import_excel', { handle: g, path: join(dir, 'g2.xlsx') });
  assert.equal(imp.data.applied, true, JSON.stringify(imp.data));
  assert.ok(!imp.data.warnings.some((w: string) => /skipped/.test(w)), JSON.stringify(imp.data.warnings));
  assert.deepEqual((await call('get_activity', { handle: g, activity_id: 'A2' })).data.predecessors.filter((p: any) => p.id === 'A1').map((p: any) => p.type).sort(), ['FS', 'SS']);
});

/** A stdio server with arguments; tools and the way it ends. */
function server(args: string[], cwd: string) {
  const p = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
  let buf = '', err = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stderr.on('data', (c: string) => { err += c; });
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const exited = new Promise<number | null>((res) => p.on('exit', (code) => res(code)));
  const tool = (name: string, a: Record<string, unknown> = {}) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: a } }) + '\n'); }).then((r) => ({ isError: r.result.isError, data: r.result.structuredContent }));
  return { p, tool, exited, stderr: () => err };
}

test('MCP contract: read and write roots, atomic saves into new folders, unsaved work saved at stdin EOF and SIGTERM', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'p6mcp-roots-'));
  const inn = join(base, 'in'), out = join(base, 'out'), other = join(base, 'other');
  for (const d of [inn, other]) mkdirSync(d);
  copyFileSync(join(SAMPLES_DIR, 'cairo festival city.xer'), join(inn, 'cfc.xer'));
  copyFileSync(join(SAMPLES_DIR, 'cairo festival city.xer'), join(other, 'cfc.xer'));
  const s = server(['--automation-read-root', inn, '--automation-write-root', out], base);
  const o = await s.tool('open_file', { path: 'cfc.xer' }); // relative: found in the read root
  assert.equal(o.isError, false, JSON.stringify(o.data));
  const h = o.data.handle;
  const outside = await s.tool('open_file', { path: join(other, 'cfc.xer') });
  assert.deepEqual([outside.data.error.code, outside.data.error.write_root], ['path_outside_root', out]);
  assert.equal((await s.tool('save', { handle: h, path: join(inn, 'back.xer') })).data.error.code, 'path_outside_root');
  // a save makes missing folders inside the write root, writes through a temporary file and leaves none behind
  const sv = await s.tool('save', { handle: h, path: 'deliver/rev1/cfc.xer' });
  assert.deepEqual([sv.isError, sv.data.saved, sv.data.unsaved_changes], [false, join(out, 'deliver/rev1/cfc.xer'), false]);
  assert.deepEqual(readdirSync(join(out, 'deliver/rev1')), ['cfc.xer']);
  assert.equal(parseXer(new Uint8Array(readFileSync(join(out, 'deliver/rev1/cfc.xer')))).db.tables.TASK.rows.length, 93);
  // a failed write leaves the old file whole and no temporary file
  mkdirSync(join(out, 'adir'));
  assert.equal((await s.tool('save', { handle: h, path: 'adir' })).data.error.code, 'file_unwritable');
  assert.deepEqual(readdirSync(out).sort(), ['adir', 'deliver']);
  // unsaved work is saved into the write root when stdin closes
  await s.tool('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A2410', name: 'Changed before exit' }] });
  s.p.stdin.end();
  assert.equal(await s.exited, 0);
  const rec = readdirSync(out).filter((n) => /^cfc\.recovered-\d{8}-\d{6}\.xer$/.test(n));
  assert.equal(rec.length, 1, s.stderr());
  assert.match(s.stderr(), new RegExp(`saved to ${join(out, rec[0]).replace(/[.\\\\]/g, '\\$&')}`));
  const back = parseXer(new Uint8Array(readFileSync(join(out, rec[0])))).db;
  assert.equal(back.tables.TASK.rows.find((t) => t.task_code === 'A2410')!.task_name, 'Changed before exit');
  // and on SIGTERM; a project without changes is not saved (Windows has no SIGTERM: kill() terminates the process at
  // once, so only the stdin-close path above can save there)
  if (process.platform === 'win32') return;
  const t = server(['--automation-read-root', inn, '--automation-write-root', join(base, 'out2')], base);
  const n = await t.tool('new_project', { id: 'Fresh Plan', start: '2026-03-02' });
  await t.tool('open_file', { path: 'cfc.xer' });
  assert.equal(n.data.unsaved_changes, true);
  t.p.kill('SIGTERM');
  await t.exited;
  assert.deepEqual(readdirSync(join(base, 'out2')).map((x) => x.replace(/\d{8}-\d{6}/, 'STAMP')), ['Fresh Plan.recovered-STAMP.xer']);
  assert.ok(existsSync(join(inn, 'cfc.xer')));
});

test('MCP contract: a lenient open repairs a misspelled key column (the platform\'s old XER writer), so the saved file is one P6 imports', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-fix-'));
  for (const [file, rels] of [['Polaris_DC1_Baseline_Schedule.xer', 106], ['Aurora_Tower_Baseline_Schedule.xer', 258]] as const) {
    const path = join(import.meta.dirname, 'fixtures', file);
    const plain = await call('open_file', { path });
    assert.deepEqual([plain.data.error.code, plain.data.error.fatal[0].code], ['p6_would_reject', 'MISSING_KEY_FIELD']);
    const o = await call('open_file', { path, lenient: true });
    assert.deepEqual([o.isError, o.data.still_rejected, o.data.unsaved_changes, o.data.summary.relationships], [false, false, true, rels], file);
    assert.deepEqual(o.data.diagnostics.repaired, [`TASKPRED: column "taskpred_id" renamed task_pred_id (its ${rels} values are unique ids).`]);
    assert.equal(o.data.diagnostics.before_repairs.verdict, 'fatal');
    const out = join(dir, file);
    assert.equal((await call('save', { handle: o.data.handle, path: out })).isError, false);
    const again = await call('open_file', { path: out });
    assert.equal(again.isError, false, JSON.stringify(again.data));
    assert.notEqual(again.data.diagnostics.verdict, 'fatal');
    assert.deepEqual([again.data.diagnostics.findings.filter((x: { code: string }) => x.code === 'EMPTY_KEY').length, again.data.summary.relationships], [0, rels]);
    const ids = parseXer(new Uint8Array(readFileSync(out))).db.tables.TASKPRED.rows.map((r) => r.task_pred_id);
    assert.ok(ids.every(Boolean) && new Set(ids).size === rels);
  }
  // fresh ids where nothing points at the rows; a missing key that other rows point at is reported, not invented
  const { repairKeys } = await import('../core/xer/repair.ts');
  const db = parseXer(new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'Polaris_DC1_Baseline_Schedule.xer')))).db;
  db.tables.TASKPRED.rows.forEach((r, i) => { r.task_pred_id = i < 3 ? '' : r.taskpred_id; delete r.taskpred_id; });
  db.tables.TASKPRED.fields = db.tables.TASKPRED.fields.map((f) => (f === 'taskpred_id' ? 'task_pred_id' : f));
  db.tables.TASK.fields = db.tables.TASK.fields.filter((f) => f !== 'task_id');
  const fix = repairKeys(db);
  assert.deepEqual(fix.repaired, ['TASKPRED: 3 row(s) with an empty, missing or repeated task_pred_id given fresh ids.']);
  assert.match(fix.not_repaired[0], /^TASK has no task_id column.*other tables point at its rows/);
  const ids = db.tables.TASKPRED.rows.map((r) => r.task_pred_id);
  assert.equal(new Set(ids).size, ids.length);
});
