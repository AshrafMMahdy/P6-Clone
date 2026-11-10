// The MCP server's contract with the platform: error shape, unsaved_changes, refusing a file P6 would reject (or
// opening it leniently), close keeping unsaved work, read/write roots, atomic saves, and the save at exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { callTool, toolResult, outsideRoute } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseXer } from '../core/xer/parse.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { SAMPLES_DIR, sampleCopy } from './helpers.ts';
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
  // import_excel: a row whose relationship type was edited replaces that link (old type removed, new one added); a
  // genuinely new row adds one; the plan's warnings come through
  const g = (await call('open_file', { path: f.good })).data.handle;
  await call('export_excel', { handle: g, path: join(dir, 'g.xlsx') });
  const sheets = await readXlsx(new Uint8Array(readFileSync(join(dir, 'g.xlsx'))));
  const tp = sheets.find((s) => s.name === 'TASKPRED')!;
  tp.rows[2][tp.rows[0].indexOf('pred_type')] = 'SS';
  writeFileSync(join(dir, 'g2.xlsx'), await writeXlsx(sheets));
  const imp = await call('import_excel', { handle: g, path: join(dir, 'g2.xlsx') });
  assert.equal(imp.data.applied, true, JSON.stringify(imp.data));
  assert.deepEqual([imp.data.summary.relationshipsUpdated, imp.data.summary.relationshipsAdded], [1, 0]);
  assert.ok(!imp.data.warnings.some((w: string) => /skipped/.test(w)), JSON.stringify(imp.data.warnings));
  assert.deepEqual((await call('get_activity', { handle: g, activity_id: 'A2' })).data.predecessors.filter((p: any) => p.id === 'A1').map((p: any) => p.type), ['SS']);
  // a new row beside it (FF) adds a link: the pair then holds SS + FF, and a re-import of that sheet changes nothing
  const tp2 = sheets.find((s) => s.name === 'TASKPRED')!;
  tp2.rows.push([...tp2.rows[2]]);
  tp2.rows[tp2.rows.length - 1][tp2.rows[0].indexOf('pred_type')] = 'FF';
  tp2.rows.push([...tp2.rows[2]]);
  tp2.rows[tp2.rows.length - 1][tp2.rows[0].indexOf('pred_type')] = 'XX';
  writeFileSync(join(dir, 'g3.xlsx'), await writeXlsx(sheets));
  const imp2 = await call('import_excel', { handle: g, path: join(dir, 'g3.xlsx') });
  assert.deepEqual([imp2.data.summary.relationshipsAdded, imp2.data.summary.relationshipsUpdated], [1, 0]);
  assert.ok(imp2.data.warnings.some((w: string) => /unknown type "XX"/.test(w)), JSON.stringify(imp2.data.warnings));
  assert.deepEqual((await call('get_activity', { handle: g, activity_id: 'A2' })).data.predecessors.filter((p: any) => p.id === 'A1').map((p: any) => p.type).sort(), ['FF', 'SS']);
  await call('export_excel', { handle: g, path: join(dir, 'g4.xlsx') });
  assert.equal((await call('import_excel', { handle: g, path: join(dir, 'g4.xlsx'), dry_run: true })).data.note, 'Nothing to change.');
});

/** A stdio server with arguments; tools and the way it ends. */
function server(args: string[], cwd: string) {
  // its own temp folder: a server adopts the recovery folders of servers that are gone, so tests must not share one
  const p = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd } });
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

test('a file P6 would reject, or that is no schedule: the answer lists what P6 refuses and tells the agent how to carry on (owner 2026-11-10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-r-'));
  const f = files(dir);
  const second = 'the file is text (an XER is tab-separated tables: %T table, %F fields, %R rows): read it with your file-reading tool, do what the user asked from the tables directly (code or a spreadsheet), and tell the user the file is damaged, what is wrong with it, and that the analysis was done outside the P6 engine.';
  const first = 'Call open_file again with lenient: true: the clone repairs what it can and opens it, and says what it repaired; work on that, and tell the user the file as given is one P6 itself would refuse and why.';
  // a duplicate-ID XER (a made one, and the real one): every kind with its count, the first few in words, the way forward in order
  for (const path of [f.dup, sampleCopy('CCA R03 dt 24Oct11SC.xer')]) {
    const rej = await call('open_file', { path });
    assert.equal(rej.data.error.code, 'p6_would_reject');
    const e = rej.data.error, kinds = e.fatal_kinds as { code: string; count: number }[];
    assert.equal(e.fatal_total, kinds.reduce((x, k) => x + k.count, 0));
    assert.ok(kinds.some((k) => k.code === 'DUP_KEY'));
    assert.match(e.message, new RegExp(`${e.fatal_total} fatal finding`));
    for (const k of kinds) assert.ok(e.message.includes(`${k.code} x${k.count}`), `${k.code} x${k.count} in ${e.message}`);
    assert.match(e.message, /Duplicate TASK\.task_id/);
    assert.equal(e.next_step, `1. ${first} 2. If it still cannot be opened, ${second}`);
    // the lenient open says what it repaired and that the original is one P6 would refuse
    const len = await call('open_file', { path, lenient: true });
    assert.equal(len.isError, false);
    assert.equal(len.data.file_as_given.p6_would_reject, true);
    assert.deepEqual(len.data.file_as_given.fatal_kinds, kinds);
    assert.match(len.data.file_as_given.tell_the_user, /one P6 itself would refuse/);
    assert.match(len.data.note, /^The file as given is one P6 itself would refuse/);
    assert.ok(Array.isArray(len.data.diagnostics.repaired) && Array.isArray(len.data.diagnostics.not_repaired));
    await call('close', { handle: len.data.handle, discard: true });
  }
  // a clean file opened leniently: nothing to tell
  const ok = await call('open_file', { path: f.good, lenient: true });
  assert.equal(ok.data.file_as_given.p6_would_reject, false);
  assert.doesNotMatch(ok.data.note, /as given/);
  await call('close', { handle: ok.data.handle, discard: true });
  // a file that is not a schedule: nothing to repair, so no lenient route, straight to the second, with the cause
  for (const lenient of [false, true]) {
    const bad = await call('open_file', { path: f.junk, ...(lenient ? { lenient } : {}) });
    assert.equal(bad.data.error.code, 'p6_would_reject');
    assert.match(bad.data.error.message, /NO_HEADER x1, NO_PROJECT x1/);
    assert.match(bad.data.error.message, /First line is not an ERMHDR header/);
    assert.equal(bad.data.error.next_step, `The clone could not read a project from this file, so lenient: true cannot open it either. Carry on outside the clone: ${second}`);
  }
  // a binary .mpp the reader cannot take: the cause, and the way on (Project XML, else tell the user)
  const mpp = join(dir, 'broken.mpp');
  writeFileSync(mpp, Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) & 255)));
  const m = await call('open_file', { path: mpp });
  assert.equal(m.data.error.code, 'file_unreadable');
  assert.match(m.data.error.message, /^Cannot read broken\.mpp: /);
  assert.match(m.data.error.next_step, /binary file that cannot be read as text: open it in Microsoft Project and save it as Microsoft Project XML.*tell the user the file could not be read, the cause given/);
});

test('a file that is no schedule is told for what it is: an Office file, a PDF, an empty file and other binary each have their own true route; only text gets the read-the-tables route (owner 2026-11-10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-nt-'));
  const put = (name: string, bytes: number[] | string) => { const p = join(dir, name); writeFileSync(p, typeof bytes === 'string' ? bytes : Buffer.from(bytes)); return p; };
  const nextStep = async (path: string, lenient = false) => { const r = await call('open_file', { path, ...(lenient ? { lenient } : {}) }); assert.equal(r.isError, true, path); return r.data.error.next_step as string; };
  const xlsx = await nextStep(put('plan.xlsx', [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2, 3, 4]));
  assert.match(xlsx, /zip-packed Office file/); assert.match(xlsx, /import_excel tool/);
  const pdf = await nextStep(put('plan.pdf', '%PDF-1.7\n%âãÏÓ\n1 0 obj'));
  assert.match(pdf, /^.*the file is a PDF: a document, not a schedule file/); assert.match(pdf, /document reader/);
  const empty = await nextStep(put('empty.xer', ''));
  assert.match(empty, /the file is empty \(0 bytes\)/);
  const bin = await nextStep(put('thing.dat', [0, 1, 2, 3, 0, 255, 254, 0, 9, 9]));
  assert.match(bin, /the file is binary \(not text\)/);
  for (const t of [xlsx, pdf, empty, bin]) { assert.doesNotMatch(t, /tell the user the file is damaged/); assert.doesNotMatch(t, /an XER is tab-separated tables/); }
  // a lenient open of them says the same (there is no project to repair)
  assert.match(await nextStep(join(dir, 'plan.pdf'), true), /the file is a PDF/);
  // text keeps the read-the-tables route
  assert.match(await nextStep(put('junk.xer', 'this is not a schedule')), /the file is text \(an XER is tab-separated tables/);
});

test('import_file and transfer_progress say what P6 would refuse in the file they read (file_as_given, as the lenient open does); the import goes on as before; open_file lists every fatal finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-ga-'));
  const f = files(dir);
  const np = (await call('new_project', { id: 'IMP', start: '2026-03-02' })).data;
  const dry = await call('import_file', { handle: np.handle, owner_key: np.owner_key, path: f.dup, action: 'new', dry_run: true });
  assert.equal(dry.isError, false, JSON.stringify(dry.data).slice(0, 300));
  assert.equal(dry.data.file_as_given.p6_would_reject, true);
  assert.ok(dry.data.file_as_given.fatal_kinds.some((k: { code: string; count: number }) => k.code === 'DUP_KEY' && k.count >= 1));
  assert.equal(dry.data.file_as_given.fatal_total, dry.data.file_as_given.fatal_kinds.reduce((x: number, k: { count: number }) => x + k.count, 0));
  assert.match(dry.data.file_as_given.tell_the_user, /one P6 itself would refuse/);
  const done = await call('import_file', { handle: np.handle, owner_key: np.owner_key, path: f.dup, action: 'new' });
  assert.equal(done.isError, false); assert.equal(done.data.file_as_given.p6_would_reject, true);
  assert.ok(done.data.projects?.length >= 1, 'the import went on');
  // a clean file: said too, as not refused
  const clean = await call('import_file', { handle: np.handle, owner_key: np.owner_key, path: f.good, action: 'new', dry_run: true });
  assert.deepEqual(clean.data.file_as_given, { p6_would_reject: false });
  const tp = await call('transfer_progress', { handle: np.handle, owner_key: np.owner_key, path: f.dup, dry_run: true, from_project: 'R1', project: 'IMP' });
  if (!tp.isError) assert.equal(tp.data.file_as_given.p6_would_reject, true);
  // 60 duplicate IDs: the validator keeps 5 findings and a line for the rest, and the counts are the real ones
  const db: Db = { tables: {} };
  assert.ok(applyOps(db, [{ op: 'add_project', id: 'BIG', start: '2026-03-02' }, ...Array.from({ length: 60 }, (_, i) => ({ op: 'add_activity', id: `A${i}`, name: `N${i}`, duration_days: 2 }))], { calendarDays: true }).ok);
  const lines = new TextDecoder().decode(writeXer(db, { version: '19.12', encoding: 'utf-8' })).split('\r\n');
  const out: string[] = [];
  let inTask = false;
  for (const l of lines) { if (l.startsWith('%T')) inTask = l.endsWith('\tTASK'); out.push(l); if (inTask && l.startsWith('%R')) out.push(l); } // every TASK row twice
  const big = join(dir, 'big.xer'); writeFileSync(big, out.join('\r\n'));
  const rej = await call('open_file', { path: big });
  const e = rej.data.error;
  assert.equal(e.code, 'p6_would_reject');
  assert.deepEqual(e.fatal_kinds, [{ code: 'DUP_KEY', count: 60 }]);
  assert.equal(e.fatal_total, 60);
  assert.match(e.message, /60 fatal findings \(DUP_KEY x60\)/);
  assert.equal(e.fatal_listed, 5, 'the findings in words: 5 of the 60');
  assert.match(e.message, /data\.fatal lists 5 of the 60 in words/);
  const len = await call('open_file', { path: big, lenient: true });
  assert.deepEqual([len.data.file_as_given.fatal_total, len.data.file_as_given.fatal_listed, len.data.file_as_given.fatal_kinds[0].count], [60, 5, 60]);
  assert.equal(len.data.diagnostics.counts.fatal ?? len.data.diagnostics.before_repairs?.counts.fatal, 60, 'the counts of the diagnostics are real too');
});

test('a real .mpp that was read but refused, or holds no project, keeps the "save as Project XML" route; only a file that is not an .mpp is told it is binary (A-M1)', () => {
  const dir = join(process.cwd(), 'Sample MPPs'), name = readdirSync(dir).find((f) => /\.mpp$/i.test(f))!;
  const head = new Uint8Array(readFileSync(join(dir, name))).subarray(0, 4000);
  assert.deepEqual([...head.subarray(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const r = outsideRoute('mpp', head);
  assert.match(r, /save it as Microsoft Project XML/);
  assert.doesNotMatch(r, /not one of the schedule formats/);
  // a file only named .mpp whose bytes are a PDF is still told for what it is
  assert.match(outsideRoute('mpp', new TextEncoder().encode('%PDF-1.7 ...')), /the file is a PDF/);
  assert.match(outsideRoute('mpp', undefined), /save it as Microsoft Project XML/);
});

test('read failures say why in data.cause (and data.os_code): a missing path is not_found/ENOENT, a folder is_a_folder, a file that is not a schedule is damaged; the messages are as they were', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-cause-'));
  const missing = await call('open_file', { path: join(dir, 'nope.xer') });
  assert.equal(missing.data.error.code, 'file_unreadable');
  assert.match(missing.data.error.message, /^Cannot read .*nope\.xer: no such file\.$/);
  assert.deepEqual([missing.data.error.cause, missing.data.error.os_code], ['not_found', 'ENOENT']);
  const folder = await call('open_file', { path: dir });
  assert.equal(folder.data.error.code, 'file_unreadable');
  assert.deepEqual([folder.data.error.cause, folder.data.error.os_code], ['is_a_folder', 'EISDIR']);
  const junk = join(dir, 'junk.xer'); writeFileSync(junk, 'this is not a schedule');
  const bad = await call('open_file', { path: junk });
  assert.equal(bad.data.error.code, 'p6_would_reject'); assert.equal(bad.data.error.cause, 'damaged');
  const { readCause } = await import('../mcp/runtime.ts');
  assert.deepEqual(readCause(Object.assign(new Error('x'), { code: 'EACCES' })), { cause: 'no_permission', os_code: 'EACCES' });
  assert.deepEqual(readCause(Object.assign(new Error('x'), { code: 'EMFILE' })), { cause: 'system', os_code: 'EMFILE' });
  assert.deepEqual(readCause(new Error('bad bytes')), { cause: 'damaged' });
});
