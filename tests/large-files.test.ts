// Big schedules (audit of file-size limits, P6-clone rows): writers that go to the file as they make it, every list
// reachable page by page, an oversized answer written whole to a file, and every call's working set counted in the
// memory budget before it starts, refused in words when it cannot fit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { config, setRoots } from '../mcp/runtime.ts';
import { readRaw, detectFormat } from '../renderer/io.ts';
import { parseP6Xml, writeP6Xml, writeP6XmlTo } from '../core/xml/p6xml.ts';
import { writeMspdi, writeMspdiTo } from '../core/msp/mspdi.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'seed-aurora.xer');
const call = async (name: string, a: Record<string, unknown>) => { const r = await callTool(name, a); return { err: r.isError, d: toolResult(r.out, r.isError, name).structuredContent as any }; };
const open = async () => { const o = await call('open_file', { path: FIX }); assert.equal(o.err, false, JSON.stringify(o.d)); return o.d as { handle: string; owner_key: string }; };

test('P6 XML and MSPDI are written piece by piece, and the pieces are the same file', () => {
  const bytes = new Uint8Array(readFileSync(FIX));
  const db = readRaw(bytes, detectFormat(FIX, bytes)).db;
  const parts: string[] = [];
  writeP6XmlTo(db, { version: '19.12' }, (p) => parts.push(p));
  assert.ok(parts.length > 100, 'many pieces, never one string');
  assert.equal(parts.join(''), writeP6Xml(db, { version: '19.12' }));
  const mp: string[] = [];
  writeMspdiTo(db, {}, (p) => mp.push(p));
  assert.ok(mp.length > 50);
  const whole = mp.join('');
  assert.equal(whole, writeMspdi(db, {}));
  assert.ok(!whole.includes('\u0001'), 'no section marker is left in the file');
  assert.match(whole, /<Tasks><Task>/);
});

test('a P6 XML is read element by element: the same rows, also when a project names its ObjectId after its activities', () => {
  const bytes = new Uint8Array(readFileSync(FIX));
  const db = readRaw(bytes, detectFormat(FIX, bytes)).db;
  const text = writeP6Xml(db, { version: '19.12' });
  const a = parseP6Xml(text);
  assert.deepEqual(a.findings.filter((f) => f.severity === 'fatal'), []);
  for (const t of ['TASK', 'TASKPRED', 'PROJWBS', 'TASKRSRC', 'UDFVALUE', 'CALENDAR']) assert.equal(a.db.tables[t]?.rows.length ?? 0, db.tables[t]?.rows.length ?? 0, t);
  // the project's ObjectId and WBSObjectId moved to its end, and the activities' own project and WBS taken away
  const m = /<Project><ObjectId>(\d+)<\/ObjectId>/.exec(text)!;
  const moved = text.replace(m[0], '<Project>').replace(/<WBSObjectId>(\d+)<\/WBSObjectId>\n/, '\n').replace('</Project>', `<ObjectId>${m[1]}</ObjectId></Project>`)
    .replace(/<ProjectObjectId>\d+<\/ProjectObjectId>/g, '');
  const b = parseP6Xml(moved);
  assert.equal(b.db.tables.TASK.rows.length, a.db.tables.TASK.rows.length);
  assert.ok(b.db.tables.TASK.rows.every((t) => t.proj_id === m[1]), 'every activity in its project');
  const root = b.db.tables.PROJWBS.rows.find((w) => w.proj_node_flag === 'Y')!;
  assert.equal(root.wbs_id, `${m[1]}00000`);
});

test('save writes P6 XML and MSPDI that open again; lists page with offset / next_offset', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-large-'));
  setRoots(null, null);
  const { handle, owner_key } = await open();
  for (const [file, format] of [['a.xml', undefined], ['b.xml', 'mspdi']] as const) {
    const s = await call('save', { handle, owner_key, path: join(dir, file), ...(format ? { format } : {}) });
    assert.equal(s.err, false, JSON.stringify(s.d));
    const b = new Uint8Array(readFileSync(join(dir, file)));
    assert.ok(readRaw(b, detectFormat(join(dir, file), b)).db.tables.TASK.rows.length > 10);
  }
  // find_activities: every activity reachable page by page, none twice
  const seen = new Set<string>();
  let offset: number | null = 0, total = 0;
  while (offset != null) {
    const r = await call('find_activities', { handle, limit: 100, offset });
    total = r.d.total_matches;
    for (const a of r.d.activities) { assert.ok(!seen.has(a.id), `${a.id} twice`); seen.add(a.id); }
    offset = r.d.next_offset;
  }
  assert.equal(seen.size, total);
  assert.ok(total > 100, 'the fixture needs more than one page');
  // critical_path and list_wbs page the same way
  const c1 = await call('critical_path', { handle, limit: 5 });
  if (c1.d.total > 5) { assert.equal(c1.d.next_offset, 5); const c2 = await call('critical_path', { handle, limit: 5, offset: 5 }); assert.notEqual(c2.d.activities[0].id, c1.d.activities[0].id); }
  const w = await call('list_wbs', { handle, depth: 6 });
  assert.equal(w.d.total >= w.d.wbs.length, true);
  // compare pages its changes
  const cmp = await call('compare', { handle, path: FIX, max_changes: 1 });
  assert.equal(cmp.err, false, JSON.stringify(cmp.d));
  await call('close', { handle, owner_key, discard: true });
});

test('an answer too large to return is written whole to a JSON file whose path the answer gives', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-spill-'));
  setRoots(join(import.meta.dirname, 'fixtures'), dir);
  const was = config.maxResponseChars;
  try {
    const { handle, owner_key } = await open();
    config.maxResponseChars = 2000;
    const r = await call('find_activities', { handle, limit: 100 });
    assert.equal(r.d.truncated, true);
    assert.ok(r.d.saved && existsSync(r.d.saved), JSON.stringify(r.d).slice(0, 300));
    assert.deepEqual(r.d.written, [r.d.saved]);
    const whole = JSON.parse(readFileSync(r.d.saved, 'utf8'));
    assert.equal(whole.activities.length, 100);
    assert.match(r.d.note, /all of it is in/);
    config.maxResponseChars = was;
    await call('close', { handle, owner_key, discard: true });
  } finally { config.maxResponseChars = was; setRoots(null, null); }
});

test('a call whose working set does not fit is refused up front, in words, with what would fit; nothing running: no retry', { timeout: 60_000 }, async () => {
  setRoots(null, null);
  const was = config.budgetBytes;
  const { handle, owner_key } = await open();
  try {
    const st = (await call('server_status', {})).d;
    // room for the project and a little more: Monte Carlo of 20,000 iterations is far more
    config.budgetBytes = (st.memory?.projects_mb ?? st.projects_mb ?? 10) * 1048576 + 40 * 1048576;
    const r = await call('monte_carlo', { handle, iterations: 20000, default_estimates: { min_pct: 90, max_pct: 125 } });
    assert.equal(r.err, true);
    assert.equal(r.d.error.code, 'memory_budget');
    assert.match(r.d.error.reason, /Monte Carlo of [\d,]+ activities × 20,000 iterations needs about \d+ MB of memory/);
    assert.match(r.d.error.reason, /budget \(P6CLONE_MEM_BUDGET_MB\) is free/);
    assert.match(r.d.error.next_step, /at most [\d,]+ iterations/);
    assert.equal(r.d.error.retry_after_ms, undefined, 'nothing else is running: retrying would not help');
    // what fits runs
    const fit = Number(/at most ([\d,]+) iterations/.exec(r.d.error.next_step)![1].replace(/,/g, ''));
    const ok = await call('monte_carlo', { handle, iterations: Math.min(fit, 60), default_estimates: { min_pct: 90, max_pct: 125 } });
    assert.equal(ok.err, false, JSON.stringify(ok.d).slice(0, 300));
  } finally {
    config.budgetBytes = was;
    await call('close', { handle, owner_key, discard: true });
  }
});
