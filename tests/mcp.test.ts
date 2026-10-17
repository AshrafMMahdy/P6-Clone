import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SAMPLES_DIR } from './helpers.ts';

const SERVER = join(import.meta.dirname, '..', 'mcp', 'server.ts');

function client() {
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name: string, args: Record<string, unknown> = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { ...r.result, data: r.result.structuredContent }; };
  return { rpc, tool, close: () => p.stdin.end() };
}

test('MCP: an agent builds, schedules, reviews, undoes, saves and reopens a project', { timeout: 60_000 }, async () => {
  const c = client();
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'p6-clone');
    const names = (await c.rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    for (const n of ['open_file', 'new_project', 'edit', 'schedule', 'review', 'find_activities', 'get_activity', 'undo', 'save']) assert.ok(names.includes(n), n);

    const { data: np } = await c.tool('new_project', { id: 'MCP1', name: 'Agent project', start: '2026-03-02' });
    const h = np.handle;
    const ed = await c.tool('edit', { handle: h, operations: [
      { op: 'add_activity', id: 'A1', name: 'Design', duration_days: 5 },
      { op: 'add_activity', id: 'A2', name: 'Build', duration_days: 10 },
      { op: 'add_relationship', pred: 'A1', succ: 'A2' },
    ] });
    assert.equal(ed.isError, false);
    assert.equal(ed.data.applied, 3);
    const bad = await c.tool('edit', { handle: h, operations: [{ op: 'add_relationship', pred: 'A2', succ: 'A1' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.data.error.message, /loop/);

    const sc = await c.tool('schedule', { handle: h });
    assert.equal(sc.data.finish, '2026-03-20 17:00');
    const a2 = await c.tool('get_activity', { handle: h, activity_id: 'A2' });
    assert.equal(a2.data.start, '2026-03-09 08:00');
    const rv = await c.tool('review', { handle: h });
    assert.ok(['pass', 'warn', 'fail'].includes(rv.data.grade));

    await c.tool('edit', { handle: h, operations: [{ op: 'update_activity', id: 'A2', duration_days: 20 }] });
    const un = await c.tool('undo', { handle: h });
    assert.match(un.data.undone, /^Edit/);
    assert.equal((await c.tool('get_activity', { handle: h, activity_id: 'A2' })).data.orig_days, 10);

    const out = join(mkdtempSync(join(tmpdir(), 'p6mcp-')), 'agent.xer');
    assert.equal((await c.tool('save', { handle: h, path: out })).isError, false);
    assert.ok(existsSync(out));
    const re = await c.tool('open_file', { path: out });
    assert.equal(re.data.diagnostics.verdict === 'fatal', false);
    assert.equal(re.data.summary.activities, 2);
    assert.equal((await c.tool('close', { handle: re.data.handle })).isError, false);

    const real = await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    const f = await c.tool('find_activities', { handle: real.data.handle, text: 'water', limit: 3 });
    assert.ok(f.data.total_matches > 0);
    assert.equal((await c.tool('get_activity', { handle: 'nope', activity_id: 'x' })).isError, true);
  } finally { c.close(); }
});

test('MCP: open_file reads P6 XML', { timeout: 60_000 }, async () => {
  const c = client();
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const xer = await c.tool('open_file', { path: join(SAMPLES_DIR, 'CfC.xer') });
    const xml = join(mkdtempSync(join(tmpdir(), 'p6mcp-')), 'cfc.xml');
    assert.equal((await c.tool('save', { handle: xer.data.handle, path: xml })).isError, false);
    const o = await c.tool('open_file', { path: xml });
    assert.equal(o.isError, false);
    assert.equal(o.data.format, 'xml');
    assert.ok(xer.data.summary.activities > 0);
    assert.equal(o.data.summary.activities, xer.data.summary.activities);
    // validate keeps the opened file's format: no XER field-list (MISSING_FIELD) notices for P6 XML
    const v = await c.tool('validate', { handle: o.data.handle });
    assert.equal(v.isError, false);
    assert.deepEqual(v.data.counts, o.data.diagnostics.counts);
  } finally { c.close(); }
});

test('MCP: an agent exports a PDF printout and an Excel workbook, edits the workbook and imports it back', { timeout: 60_000 }, async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { readXlsx, writeXlsx } = await import('../core/excel/xlsx.ts');
  const c = client();
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-'));
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const names = (await c.rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    for (const n of ['export_pdf', 'export_excel', 'import_excel']) assert.ok(names.includes(n), n);
    const { data: o } = await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    const h = o.handle;
    const pdf = await c.tool('export_pdf', { handle: h, path: join(dir, 's.pdf'), settings: { paper: 'A4', landscape: false, content: 'table', columns: ['task_code', 'task_name', 'finish'], header: { center: 'Agent printout' } } });
    assert.equal(pdf.isError, false, pdf.content?.[0]?.text);
    const bytes = readFileSync(join(dir, 's.pdf'));
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, pdf.data.pages);
    assert.ok(pdf.data.pages >= 2 && pdf.data.activities === 93);
    const both = await c.tool('export_pdf', { handle: h, path: join(dir, 's2.pdf'), settings: { content: 'both', show_links: true, columns: ['nope'] } });
    assert.deepEqual(both.data.unknown_columns, ['nope']); assert.ok(both.data.printable_columns.includes('task_code'));
    const xl = await c.tool('export_excel', { handle: h, path: join(dir, 's.xlsx') });
    assert.equal(xl.isError, false);
    // the agent edits a duration in the workbook and imports it
    const sheets = await readXlsx(new Uint8Array(readFileSync(join(dir, 's.xlsx'))));
    const t = sheets[0], ci = t.rows[0].indexOf('target_drtn_hr_cnt'), id = t.rows[0].indexOf('task_code');
    t.rows.find((r) => r[id] === 'A2410')![ci] = 31;
    writeFileSync(join(dir, 'edited.xlsx'), await writeXlsx(sheets));
    const dry = await c.tool('import_excel', { handle: h, path: join(dir, 'edited.xlsx'), dry_run: true });
    assert.equal(dry.data.applied, false); assert.equal(dry.data.summary.activitiesUpdated, 1);
    const imp = await c.tool('import_excel', { handle: h, path: join(dir, 'edited.xlsx') });
    assert.equal(imp.data.applied, true, JSON.stringify(imp.data));
    const a = await c.tool('get_activity', { handle: h, activity_id: 'A2410' });
    assert.equal(a.data.orig_days, 31);
    assert.equal((await c.tool('undo', { handle: h })).data.undone.startsWith('Edit'), true);
  } finally { c.close(); }
});
