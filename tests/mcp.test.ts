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
  // a tools/call followed at once by its notifications/cancelled (one write, so the server reads both together)
  const cancelled = (name: string, args: Record<string, unknown>) => new Promise<any>((res) => {
    const n = ++id; waiting.set(n, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: n, reason: 'test' } }) + '\n');
  }).then((r) => ({ ...r.result, data: r.result.structuredContent }));
  return { rpc, tool, cancelled, close: () => p.stdin.end() };
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

test('MCP: an agent lists, creates and runs reports (data, PDF, Excel) and reads earned value', { timeout: 60_000 }, async () => {
  const { readFileSync } = await import('node:fs');
  const c = client();
  const dir = mkdtempSync(join(tmpdir(), 'p6mcp-'));
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const names = (await c.rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    for (const n of ['list_reports', 'run_report', 'create_report', 'earned_value']) assert.ok(names.includes(n), n);
    const { data: o } = await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    const h = o.handle;
    const list = (await c.tool('list_reports', { handle: h })).data.result;
    assert.ok(list.some((e: { name: string }) => e.name === 'Earned Value by WBS'));
    const made = await c.tool('create_report', { handle: h, name: 'Critical by float', subject: 'activities', columns: ['task_code', 'task_name', 'finish', 'total_float'], filter: 'critical', group_by: 'none', sort_by: 'finish' });
    assert.equal(made.isError, false, made.content?.[0]?.text);
    const run = await c.tool('run_report', { handle: h, report: 'Critical by float' });
    assert.equal(run.data.columns[0], 'Activity ID'); assert.equal(run.data.total_rows, 46);
    const pdf = await c.tool('run_report', { handle: h, report: 'Relationship Report', path: join(dir, 'rel.pdf'), settings: { paper: 'A4' } });
    assert.ok(pdf.data.pages >= 2 && readFileSync(join(dir, 'rel.pdf')).subarray(0, 5).toString() === '%PDF-');
    const xl = await c.tool('run_report', { handle: h, definition: { name: 'Assignments', subject: 'assignments', group_by: 'resource' }, path: join(dir, 'a.xlsx') });
    assert.equal(xl.isError, false, xl.content?.[0]?.text);
    const ev = await c.tool('earned_value', { handle: h });
    assert.ok(Array.isArray(ev.data.projects) && 'totals' in ev.data.projects[0]);
  } finally { c.close(); }
});

test('MCP: compare two revisions by Activity ID, and trace an activity\'s logic', { timeout: 60_000 }, async () => {
  const c = client();
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const a = (await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') })).data.handle;
    const b = (await c.tool('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') })).data.handle;
    await c.tool('edit', { handle: b, operations: [{ op: 'update_activity', id: 'A2410', duration_days: 30 }, { op: 'add_activity', id: 'NEW1', name: 'Added' }, { op: 'delete_activity', id: 'A1320' }] });
    const cmp = await c.tool('compare', { handle: a, other_handle: b });
    assert.equal(cmp.isError, false, cmp.content?.[0]?.text);
    assert.deepEqual([cmp.data.summary.activity.added, cmp.data.summary.activity.deleted], [1, 1]);
    assert.ok(cmp.data.summary.activity.changed >= 1 && cmp.data.changes.some((x: { id: string; field?: string }) => x.id === 'A2410'));
    const same = await c.tool('compare', { handle: a, path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    assert.equal(same.data.changes.length, 0);
    const tr = await c.tool('trace_logic', { handle: a, activity_id: 'A2410', predecessors: 2, successors: 1 });
    assert.ok(tr.data.levels.some((l: { level: number }) => l.level === -1) && tr.data.links.some((x: { driving: boolean }) => x.driving));
  } finally { c.close(); }
});

test('MCP: Microsoft Project task UIDs (source_uid, uid:), one data date per project, one project per Microsoft Project file', { timeout: 60_000 }, async () => {
  const c = client();
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const h = (await c.tool('new_project', { id: 'P1', start: '2026-03-02' })).data.handle;
    assert.equal((await c.tool('edit', { handle: h, operations: [
      { op: 'add_activity', id: 'A1', name: 'One', duration_days: 5 }, { op: 'add_activity', id: 'A2', name: 'Two', duration_days: 3 }, { op: 'add_relationship', pred: 'A1', succ: 'A2' },
      { op: 'add_project', id: 'P2', start: '2026-03-02' }, { op: 'add_activity', project: 'P2', id: 'B1', name: 'Other', duration_days: 5 },
    ] })).isError, false);
    // a Microsoft Project file holds one project: refused without "project", written with it
    const dir = mkdtempSync(join(tmpdir(), 'p6mcp-'));
    for (const format of ['mspdi', 'mpx']) {
      const no = await c.tool('save', { handle: h, path: join(dir, `two.${format}`), format });
      assert.equal(no.data.error.code, 'bad_input');
      assert.match(no.data.error.message, /holds 2: P1, P2/);
      assert.ok(!existsSync(join(dir, `two.${format}`)));
    }
    const one = await c.tool('save', { handle: h, path: join(dir, 'p1.xml'), format: 'mspdi', project: 'P1' });
    assert.deepEqual([one.isError, one.data.project], [false, 'P1']);
    // reopened: every activity carries its task UID, and edits and lookups take uid:<UID>
    const m = (await c.tool('open_file', { path: join(dir, 'p1.xml') })).data.handle;
    const acts = (await c.tool('find_activities', { handle: m })).data.activities as { id: string; name: string; source_uid: string }[];
    assert.ok(acts.length === 2 && acts.every((a) => /^\d+$/.test(a.source_uid)));
    const two = acts.find((a) => a.name === 'Two')!;
    assert.equal((await c.tool('get_activity', { handle: m, activity_id: `uid:${two.source_uid}` })).data.name, 'Two');
    const ed = await c.tool('edit', { handle: m, operations: [{ op: 'update_activity', id: `uid:${two.source_uid}`, name: 'Two b' }, { op: 'add_relationship', pred: acts.find((a) => a.name === 'One')!.id, succ: `uid:${two.source_uid}`, type: 'SS' }] });
    assert.equal(ed.isError, false);
    assert.match(ed.data.warnings[0], /skipped: .* already has a FS relationship/);
    // schedule: data_date on one project only, or (as before) on every project
    const dates = async () => Object.fromEntries((await c.tool('list_projects', { handle: h })).data.projects.map((p: { id: string; data_date: string }) => [p.id, p.data_date]));
    const sc = await c.tool('schedule', { handle: h, data_date: '2026-04-01', project: 'P2' });
    assert.deepEqual([sc.data.project, sc.data.data_date], ['P2', '2026-04-01 00:00']);
    assert.deepEqual(await dates(), { P1: '2026-03-02 00:00', P2: '2026-04-01 00:00' });
    assert.equal((await c.tool('get_activity', { handle: h, activity_id: 'B1' })).data.start, '2026-04-01 08:00');
    assert.equal((await c.tool('get_activity', { handle: h, activity_id: 'A1' })).data.start, '2026-03-02 08:00');
    assert.equal((await c.tool('schedule', { handle: h, data_date: '2026-03-02', project: 'NOPE' })).data.error.code, 'bad_input');
    await c.tool('schedule', { handle: h, data_date: '2026-05-04' });
    assert.deepEqual(await dates(), { P1: '2026-05-04 00:00', P2: '2026-05-04 00:00' });
  } finally { c.close(); }
});

test('MCP: notifications/cancelled and cancel_job stop open_file, save and schedule, keeping and writing nothing', { timeout: 120_000 }, async () => {
  const c = client();
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const st = async () => (await c.tool('server_status')).data;
    const o = await c.cancelled('open_file', { path: join(SAMPLES_DIR, 'cairo festival city.xer') });
    assert.equal(o.data.error.code, 'cancelled');
    assert.deepEqual([(await st()).open.length, (await st()).memory.projects_mb], [0, 0]);

    const h = (await c.tool('new_project', { id: 'P1', start: '2026-03-02' })).data.handle;
    await c.tool('edit', { handle: h, operations: [{ op: 'add_activity', id: 'A1', name: 'One', duration_days: 5 }, { op: 'add_activity', id: 'A2', name: 'Two', duration_days: 3 }, { op: 'add_relationship', pred: 'A1', succ: 'A2' }] });
    const before = (await c.tool('get_activity', { handle: h, activity_id: 'A2' })).data;
    const sc = await c.cancelled('schedule', { handle: h, data_date: '2026-04-01' });
    assert.equal(sc.data.error.code, 'cancelled');
    assert.deepEqual((await c.tool('get_activity', { handle: h, activity_id: 'A2' })).data, before);
    assert.equal((await c.tool('list_open')).data.open[0].changes, 1);

    const out = join(mkdtempSync(join(tmpdir(), 'p6mcp-')), 'p1.xer');
    assert.equal((await c.cancelled('save', { handle: h, path: out })).data.error.code, 'cancelled');
    assert.ok(!existsSync(out));
    assert.equal((await c.tool('save', { handle: h, path: out })).isError, false);

    // a job: cancel_job stops a big open_file between its phases and frees its memory
    const job = await c.tool('open_file', { path: join(SAMPLES_DIR, 'CCA R03 dt 24Oct11SC.xer'), async: true });
    await c.tool('cancel_job', { job_id: job.data.job_id });
    const done = await c.tool('job_status', { job_id: job.data.job_id, wait_seconds: 20 });
    assert.deepEqual([done.data.status, done.data.error?.code], ['cancelled', 'cancelled']);
    assert.deepEqual((await st()).open.map((x: { handle: string }) => x.handle), [h]);
  } finally { c.close(); }
});

test('MCP: a cancellation reaches only the request it names, in the caller\'s own HTTP session', { timeout: 60_000 }, async () => {
  const { handleMessage } = await import('../mcp/stdio.ts');
  const call = (id: number, sid: string) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'open_file', arguments: { path: join(SAMPLES_DIR, 'cairo festival city.xer') } } }, sid) as Promise<any>;
  const cancel = (id: number, sid: string) => handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }, sid);
  const a = call(1, 'alice'), b = call(1, 'bob');
  assert.equal(await cancel(1, 'alice'), undefined);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.result.structuredContent.error.code, 'cancelled');
  assert.equal(rb.result.isError, false);
  assert.match(rb.result.structuredContent.handle, /^h_/);
});
