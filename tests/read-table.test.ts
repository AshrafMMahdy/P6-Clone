// list_tables / read_table: every table, row and field a schedule file has, readable through the MCP as the file has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLES_DIR } from './helpers.ts';
import { parseXer } from '../core/xer/parse.ts';
import { parseP6Xml, parseXml, p6xmlConvertedTags, writeP6Xml, type XNode } from '../core/xml/p6xml.ts';
import { parseMspdi } from '../core/msp/mspdi.ts';
import { listTables, readTable } from '../core/query/rawtable.ts';
import type { Db } from '../core/db.ts';

const ROOT = join(import.meta.dirname, '..');
/** Every page of a table, as read_table pages it. */
function readAll(db: Db, name: string) {
  const first = readTable(db, name, null, { limit: 500 });
  const rows = [...first.rows];
  for (let next = first.next_offset; next != null;) { const p = readTable(db, name, null, { offset: next, limit: 500 }); rows.push(...p.rows); next = p.next_offset; }
  assert.equal(rows.length, first.total);
  return { columns: first.columns, rows };
}

test('every XER sample: every table, row and field read back as the file has it (to its %E, as P6 reads it)', { timeout: 900_000 }, () => {
  const files = readdirSync(SAMPLES_DIR).filter((f) => /\.xer$/i.test(f) && !/\.recovered-\d/.test(f));
  assert.ok(files.length > 20);
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, f)));
    const { db } = parseXer(bytes);
    const enc = db.header?.encoding ?? 'utf-8';
    const text = new TextDecoder(enc === 'utf-8-bom' ? 'utf-8' : enc).decode(bytes);
    const file = new Map<string, { fields: string[]; rows: string[][] }>();
    let cur: { fields: string[]; rows: string[][] } | null = null;
    for (const line of text.split(/\r?\n/)) {
      const c = line.split('\t');
      if (c[0] === '%E') break;
      if (c[0] === '%T') file.set(c[1], (cur = { fields: [], rows: [] }));
      else if (c[0] === '%F' && cur) cur.fields = c.slice(1);
      else if (c[0] === '%R' && cur) cur.rows.push(c.slice(1));
    }
    const names = new Set(listTables(db, null).map((t) => t.name));
    for (const [name, t] of file) {
      assert.ok(names.has(name), `${f}: ${name}`);
      const got = readAll(db, name);
      assert.equal(got.rows.length, t.rows.length, `${f} ${name}: rows`);
      for (const [j, fld] of t.fields.entries()) {
        const k = got.columns.indexOf(fld);
        assert.ok(k >= 0, `${f} ${name}: column ${fld}`);
        for (let i = 0; i < t.rows.length; i++) assert.equal(got.rows[i][k] ?? '', t.rows[i][j] ?? '', `${f} ${name}.${fld} row ${i}`);
      }
    }
  }
});

/** Every leaf value of every element: present in what read_table gives (a value, or the XML of a kept element), or,
 *  for P6 XML, a field the clone stores converted (converted). */
function everyLeafRead(text: string, db: Db, converted?: Set<string>): { leaves: number; missing: string[] } {
  const values = new Set<string>();
  const leavesOf = (n: XNode, put: (c: XNode) => void) => { for (const c of n.children) { if (!c.children.length) put(c); else leavesOf(c, put); } };
  const add = (x: unknown) => { if (typeof x !== 'string') return; values.add(x.trim()); if (x.includes('<')) { try { leavesOf(parseXml(x), (c) => values.add(c.text.trim())); } catch { /* a note's HTML, not an element */ } } };
  for (const t of listTables(db, null)) for (const row of readAll(db, t.name).rows) for (const v of row) { if (Array.isArray(v)) v.forEach(add); else add(v); }
  let leaves = 0; const missing: string[] = [];
  leavesOf(parseXml(text), (c) => { const v = c.text.trim(); if (!v) return; leaves++; if (!values.has(v) && !converted?.has(c.name)) missing.push(`${c.name}=${v.slice(0, 40)}`); });
  return { leaves, missing };
}

const MSPDI = ['tests/fixtures/rich-mspdi.xml', 'sample 4D/synchro/bentley-kb-training/SYNCHRO 4D Training Files/Schedule/Training Project Schedule_MSP.xml', 'sample 4D/navisworks-timeliner/schependomlaan/Uitvoering Schependomlaan 18-02-2015.xml'].map((p) => join(ROOT, p)).filter(existsSync);
test('every Microsoft Project XML sample: every element of every task, resource, assignment and calendar readable as written (msp:<Name>, and MSP:<Kind> for those that are not P6 rows)', { timeout: 300_000 }, () => {
  assert.ok(MSPDI.length >= 1);
  for (const f of MSPDI) {
    const text = readFileSync(f, 'utf8'), { db } = parseMspdi(text);
    const r = everyLeafRead(text, db);
    assert.ok(r.leaves > 100, f);
    assert.deepEqual(r.missing, [], `${f}: ${r.missing.length} of ${r.leaves} values not readable`);
    // each task's own elements, as columns of its row
    const tasks = readAll(db, 'TASK');
    assert.ok(tasks.columns.includes('msp:UID') && tasks.columns.includes('msp:Duration'));
  }
});

const P6XML = ['sample 4D/synchro/bentley-kb-training/SYNCHRO 4D Training Files/Schedule/Training Project Schedule_P6.xml'].map((p) => join(ROOT, p)).filter(existsSync);
test('P6 XML (a sample, and P6 XML of real XERs): every object a row, every value read or converted into the clone\u2019s columns; what the clone has no column or table for, kept (xml:<Tag>, XML:<Element>)', { timeout: 600_000 }, () => {
  const converted = p6xmlConvertedTags();
  const texts = P6XML.map((f) => readFileSync(f, 'utf8'));
  for (const name of ['Tower-A.xer', 'CfC.xer']) if (existsSync(join(SAMPLES_DIR, name))) texts.push(writeP6Xml(parseXer(new Uint8Array(readFileSync(join(SAMPLES_DIR, name)))).db, {}));
  assert.ok(texts.length >= 1);
  for (const text of texts) {
    const { db } = parseP6Xml(text);
    const r = everyLeafRead(text, db, converted);
    assert.deepEqual(r.missing.slice(0, 20), [], `${r.missing.length} of ${r.leaves} values not readable`);
    const acts = (text.match(/<Activity>/g) ?? []).length;
    assert.equal(readAll(db, 'TASK').rows.length, acts);
  }
  // a field and an object the clone does not model: still there
  const extra = parseP6Xml('<?xml version="1.0"?><APIBusinessObjects><Location><ObjectId>7</ObjectId><Name>Site A</Name><Latitude>30.05</Latitude></Location><Project><ObjectId>1</ObjectId><Id>P</Id><Name>P</Name><WBSObjectId>100</WBSObjectId><SomeNewField>x1</SomeNewField><Activity><ObjectId>11</ObjectId><Id>A1</Id><Name>Dig</Name><ProjectObjectId>1</ProjectObjectId><WBSObjectId>100</WBSObjectId><EstimatedWeight>3.5</EstimatedWeight></Activity></Project></APIBusinessObjects>').db;
  const loc = readAll(extra, 'XML:Location');
  assert.deepEqual(loc.rows, [[...loc.columns.map((c) => ({ ObjectId: '7', Name: 'Site A', Latitude: '30.05' })[c] ?? null)]]);
  const t = readAll(extra, 'TASK');
  assert.equal(t.rows[0][t.columns.indexOf('xml:EstimatedWeight')], '3.5');
  const p = readAll(extra, 'PROJECT');
  assert.equal(p.rows[0][p.columns.indexOf('xml:SomeNewField')], 'x1');
});

test('through the MCP: list_tables, read_table paged with next_offset and no cap, a calendar\u2019s week and exceptions, a baseline\u2019s rows, refusals in words', { timeout: 300_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'CfC.xer') });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  const H = { handle: o.d.handle };
  const lt = await call('list_tables', H);
  const byName = new Map(lt.d.tables.map((t: any) => [t.name, t]));
  for (const t of ['PROJECT', 'PROJWBS', 'TASK', 'TASKPRED', 'CALENDAR']) assert.ok(byName.has(t), t);
  const task = byName.get('TASK') as any;
  assert.ok(task.columns.includes('cstr_type') && task.columns.includes('phys_complete_pct') && task.columns.includes('remain_drtn_hr_cnt'));
  // paged: every row once, whatever the page size; and no cap
  const p1 = await call('read_table', { ...H, table: 'TASK', limit: 7 });
  assert.equal(p1.d.rows.length, 7);
  assert.equal(p1.d.next_offset, 7);
  const all = await call('read_table', { ...H, table: 'TASK', limit: 1_000_000 });
  assert.equal(all.d.rows.length, task.rows);
  assert.equal(all.d.next_offset, undefined);
  const cal = await call('read_table', { ...H, table: 'CALENDAR', columns: ['clndr_name', 'work_week', 'exceptions'] });
  assert.ok(cal.d.rows.length > 0);
  const [, week, exc] = cal.d.rows[0];
  assert.equal(Object.keys(week).length, 7);
  assert.ok(Array.isArray(exc));
  assert.ok(Object.values(week).some((d: any) => d.length > 0 && /^\d\d:\d\d-\d\d:\d\d$/.test(d[0])), JSON.stringify(week));
  assert.equal((await call('read_table', { ...H, table: 'NOPE' })).d.error.code, 'bad_input');
  assert.equal((await call('read_table', { ...H, table: 'TASK', columns: ['nope'] })).d.error.code, 'bad_input');
  // a baseline's own rows
  assert.equal((await call('edit', { ...H, owner_key: o.d.owner_key, operations: [{ op: 'save_baseline', name: 'BL-T' }] })).err, false);
  const projects = (await call('read_table', { ...H, table: 'PROJECT', columns: ['proj_id', 'proj_short_name'] })).d.rows;
  const bl = projects.find((r: any) => /BL-T/.test(String(r[1])) || r[1] !== projects[0][1]);
  assert.ok(bl, JSON.stringify(projects));
  const blTasks = await call('read_table', { ...H, table: 'TASK', project: bl[1], limit: 1 });
  assert.equal(blTasks.err, false, JSON.stringify(blTasks.d).slice(0, 300));
  assert.ok(blTasks.d.total > 0);
  await call('close', { ...H, owner_key: o.d.owner_key, discard: true });
});

const MPP_DIR = join(ROOT, 'Sample MPPs');
const MPPS = existsSync(MPP_DIR) ? ['Schedule 1 Gemma 1B Instruct.mpp', 'Granite Schedule 1.mpp', 'مصنع البرج للصناعات الغذائية ver9.mpp', 'Bel-Egypt Schedule Rev.1.mpp'].map((f) => join(MPP_DIR, f)).filter(existsSync) : [];
test('.mpp through the MCP (MPXJ): opened without Microsoft Project, every element of every task, resource, assignment and calendar readable', { timeout: 600_000 }, async (t) => {
  const { mppReadable, mppToMspdi } = await import('../core/msp/mpp.ts');
  if (!mppReadable() || !MPPS.length) return t.skip('no MPXJ here (node scripts/build-cli.mjs fetches it)');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  for (const f of MPPS) {
    const r = await callTool('open_file', { path: f });
    const d = toolResult(r.out, r.isError).structuredContent as any;
    if (r.isError && d.error?.code === 'mpp_reader_missing') return t.skip('no Java here');
    assert.equal(r.isError, false, `${f}: ${JSON.stringify(d).slice(0, 300)}`);
    assert.equal(d.format, 'mpp');
    const tasks = (toolResult((await callTool('read_table', { handle: d.handle, table: 'TASK', limit: 1 })).out, false).structuredContent as any);
    assert.ok(tasks.total > 0, f);
    await callTool('close', { handle: d.handle, owner_key: d.owner_key, discard: true });
    const text = await mppToMspdi(f), { db } = parseMspdi(text);
    const leaf = everyLeafRead(text, db);
    assert.deepEqual(leaf.missing, [], `${f}: ${leaf.missing.length} of ${leaf.leaves} values not readable`);
  }
});

test('the clone’s own data is readable too (clone:<field>, CLONE:<TABLE>); get_activity and trace_logic take many activities in one call; lookups have no page cap', { timeout: 300_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  // an answer too large for one reply is written whole to a JSON file the reply names: read from there
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); const d = toolResult(r.out, r.isError).structuredContent as any; return { err: r.isError, d: d.saved ? JSON.parse(readFileSync(d.saved, 'utf8')) : d }; };
  const o = await call('open_file', { path: join(SAMPLES_DIR, 'CfC.xer') });
  const H = { handle: o.d.handle };
  assert.equal((await call('edit', { ...H, owner_key: o.d.owner_key, operations: [{ op: 'save_baseline', name: 'BL-C' }] })).err, false);
  const p = (await call('read_table', { ...H, table: 'PROJECT' })).d;
  assert.ok(p.columns.includes('clone:baseline_of'), p.columns.join());
  assert.ok(p.rows.some((r: unknown[]) => r[p.columns.indexOf('clone:baseline_of')]));
  // many activities in one call, each in full
  const all = (await call('read_table', { ...H, table: 'TASK', columns: ['task_code'] })).d.rows.map((r: string[]) => r[0]);
  assert.ok(all.length > 150);
  const many = (await call('get_activity', { ...H, activity_ids: [...all, 'NOPE-1'] })).d;
  assert.equal(many.activities.length, all.length);
  assert.deepEqual(many.not_found, ['NOPE-1']);
  const one = (await call('get_activity', { ...H, activity_id: all[5] })).d;
  assert.deepEqual(many.activities[5].predecessors, one.predecessors);
  const tr = (await call('trace_logic', { ...H, activity_ids: all.slice(0, 20), max_per_level: 0 })).d;
  assert.equal(tr.traces.length, 20);
  const found = (await call('find_activities', { ...H, limit: 100000 })).d;
  assert.equal(found.activities.length, found.total_matches);
  assert.equal(found.next_offset, null);
  await call('close', { ...H, owner_key: o.d.owner_key, discard: true });
});
